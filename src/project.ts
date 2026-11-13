import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export interface AutoDocConfig {
  title?: string;
  version?: string;
  description?: string;
  servers?: string[];
  /** Extra middleware names that should be treated as bearer authentication. */
  authMiddleware?: string[];
  docs?: { provider?: 'scalar' | 'swagger' | 'redoc' };
  minCoverage?: number;
  /** Extra folder / file name fragments to ignore while scanning. */
  exclude?: string[];
}

export interface Project {
  root: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Source files inside the scanned directory (no node_modules / d.ts / tests). */
  sourceFiles: ts.SourceFile[];
  tsconfigPath?: string;
  config: AutoDocConfig;
  packageJson?: { name?: string; version?: string; description?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  warnings: string[];
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', 'out']);
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

function walk(dir: string, exclude: string[], out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || exclude.some((x) => e.name === x)) continue;
      walk(full, exclude, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (!EXTS.has(ext)) continue;
      if (e.name.endsWith('.d.ts')) continue;
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) continue;
      if (exclude.some((x) => full.includes(x))) continue;
      out.push(full);
    }
  }
}

function findUp(start: string, names: string[], stopAtPackage = false): string | undefined {
  let dir = start;
  for (;;) {
    for (const n of names) {
      const candidate = path.join(dir, n);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (stopAtPackage && fs.existsSync(path.join(dir, 'package.json'))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readJson<T>(file: string | undefined): T | undefined {
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function loadConfig(root: string): AutoDocConfig {
  const file = findUp(root, ['autodoc.config.json']) ?? findUp(process.cwd(), ['autodoc.config.json']);
  return readJson<AutoDocConfig>(file) ?? {};
}

export function createProject(
  dir: string,
  opts: { tsconfig?: string; config?: AutoDocConfig } = {},
): Project {
  const root = path.resolve(dir);
  const warnings: string[] = [];
  if (!fs.existsSync(root)) throw new Error(`Directory not found: ${root}`);
  const config = { ...loadConfig(root), ...(opts.config ?? {}) };

  const files: string[] = [];
  if (fs.statSync(root).isFile()) files.push(root);
  else walk(root, config.exclude ?? [], files);
  if (files.length === 0) throw new Error(`No source files found under ${root}`);

  let tsconfigPath = opts.tsconfig
    ? path.resolve(opts.tsconfig)
    : findUp(fs.statSync(root).isFile() ? path.dirname(root) : root, ['tsconfig.json'], true);

  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    esModuleInterop: true,
    strict: true,
  };
  let rootNames = files;
  if (tsconfigPath) {
    let effectiveConfigPath = tsconfigPath;
    let cfg = ts.readConfigFile(effectiveConfigPath, ts.sys.readFile);
    // A solution-style config often contains only `references`. Pick the
    // referenced project that owns the scanned source files so path aliases
    // and module resolution work exactly as they do in the application.
    if (!cfg.error && Array.isArray(cfg.config.references) && cfg.config.references.length) {
      const wantedFiles = new Set(files.map((f) => path.normalize(f).toLowerCase()));
      let best: { path: string; parsed: ts.ParsedCommandLine; overlap: number } | undefined;
      for (const reference of cfg.config.references as Array<{ path?: string }>) {
        if (!reference.path) continue;
        let referencePath = path.resolve(path.dirname(tsconfigPath), reference.path);
        if (fs.existsSync(referencePath) && fs.statSync(referencePath).isDirectory()) {
          referencePath = path.join(referencePath, 'tsconfig.json');
        } else if (!path.extname(referencePath)) {
          referencePath += '.json';
        }
        const referenceConfig = ts.readConfigFile(referencePath, ts.sys.readFile);
        if (referenceConfig.error) continue;
        const parsed = ts.parseJsonConfigFileContent(referenceConfig.config, ts.sys, path.dirname(referencePath));
        const overlap = parsed.fileNames.reduce(
          (count, file) => count + (wantedFiles.has(path.normalize(file).toLowerCase()) ? 1 : 0),
          0,
        );
        if (overlap > (best?.overlap ?? 0)) best = { path: referencePath, parsed, overlap };
      }
      if (best) {
        effectiveConfigPath = best.path;
        cfg = ts.readConfigFile(effectiveConfigPath, ts.sys.readFile);
      }
    }
    if (cfg.error) {
      warnings.push(`Could not read ${effectiveConfigPath}: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n')}`);
    } else {
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(effectiveConfigPath));
      options = parsed.options;
      rootNames = Array.from(new Set([...files, ...parsed.fileNames]));
      tsconfigPath = effectiveConfigPath;
    }
  }
  options = {
    ...options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    tsBuildInfoFile: undefined,
  };

  const program = ts.createProgram({ rootNames, options });
  const checker = program.getTypeChecker();
  const wanted = new Set(files.map((f) => path.normalize(f).toLowerCase()));
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => wanted.has(path.normalize(sf.fileName).toLowerCase()));

  const pkgFile = findUp(fs.statSync(root).isFile() ? path.dirname(root) : root, ['package.json']);
  const packageJson = readJson<NonNullable<Project['packageJson']>>(pkgFile);

  return { root, program, checker, sourceFiles, tsconfigPath, config, packageJson, warnings };
}

export function dependencyVersion(project: Project, name: string): string | undefined {
  const p = project.packageJson;
  const declared = p?.dependencies?.[name] ?? p?.devDependencies?.[name];
  const pkgFile = findUp(project.root, [path.join('node_modules', name, 'package.json')]);
  const installed = readJson<{ version?: string }>(pkgFile)?.version;
  return installed ?? declared?.replace(/^[^\d]*/, '');
}
