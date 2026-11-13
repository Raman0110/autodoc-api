#!/usr/bin/env node
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { analyzeProject, type AnalysisResult } from './analyze';
import { coverageReport, type CoverageReport } from './coverage';
import { generateOpenApi, serializeOpenApi, validateOpenApi } from './openapi';
import { docsHtml, type DocsProvider } from './ui';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => c(32, s);
const yellow = (s: string) => c(33, s);
const red = (s: string) => c(31, s);
const dim = (s: string) => c(2, s);
const bold = (s: string) => c(1, s);

const HELP = `
${bold('AutoDoc')}: zero-annotation OpenAPI docs for Node.js / TypeScript / Express

Usage
  autodoc [dir]                 Analyze <dir> (default ./src) and write openapi.json
  autodoc scan [dir]            Analyze and print the report, write nothing
  autodoc generate [dir]        Same as the default command
  autodoc serve [dir]           Serve interactive docs at http://localhost:4000/docs
  autodoc check [dir]           CI gate: exit 1 on low coverage or an invalid spec

Options
  --out <file>                  Output file (default ./openapi.json)
  --format <name>               json | yaml (also inferred from --out extension)
  --port <n>                    Port for "serve" (default 4000)
  --provider <name>             scalar | swagger | redoc (default scalar)
  --tsconfig <file>             Use a specific tsconfig.json
  --min-coverage <n>            Threshold for "check" (default 80)
  --verbose                     Show the per-endpoint checklist for every endpoint
  --no-watch                    "serve": do not re-analyze when files change
  -h, --help                    Show this help
`;

interface Args {
  command: string;
  dir: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const commands = new Set(['scan', 'generate', 'serve', 'check', 'help']);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const valueFlags = new Set(['out', 'format', 'port', 'provider', 'tsconfig', 'min-coverage']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') flags.help = true;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) flags[k] = inline;
      else if (valueFlags.has(k)) flags[k] = argv[++i] ?? '';
      else flags[k] = true;
    } else positional.push(a);
  }
  let command = 'generate';
  if (positional[0] && commands.has(positional[0])) command = positional.shift()!;
  if (flags.help) command = 'help';
  return { command, dir: positional[0] ?? './src', flags };
}

function rel(file: string): string {
  return path.relative(process.cwd(), file).replace(/\\/g, '/');
}

function printAnalysis(res: AnalysisResult): void {
  const { model, project } = res;
  console.log(`\n${bold('AutoDoc')}\n`);
  console.log('Scanning application...\n');
  if (model.framework.name === 'express') {
    console.log(green('✓') + ` Express detected${model.framework.version ? ` (v${model.framework.version})` : ''}`);
  } else {
    console.log(yellow('⚠') + ' No Express routes detected');
  }
  console.log(
    project.tsconfigPath
      ? green('✓') + ` TypeScript configuration detected ${dim(rel(project.tsconfigPath))}`
      : yellow('⚠') + ' No tsconfig.json found, using defaults',
  );
  console.log(green('✓') + ` ${model.stats.filesScanned} source files scanned, ${model.stats.routeFiles} with routes\n`);

  console.log('Analyzing routes...\n');
  for (const e of model.endpoints) console.log(`${e.method.toUpperCase().padEnd(8)} ${e.path}`);
  console.log(`\n${model.endpoints.length} endpoints detected\n`);

  const vcount = Object.entries(model.stats.validators);
  if (vcount.length) {
    console.log('Analyzing validators...\n');
    for (const [name, n] of vcount) console.log(green('✓') + ` ${n} ${name} schema${n === 1 ? '' : 's'}`);
    console.log('');
  }
  console.log('Analyzing controllers...\n');
  console.log(green('✓') + ` ${model.stats.responseTypesResolved} response types resolved`);
  console.log(green('✓') + ` ${model.stats.statusCodesDetected} status codes detected`);
  console.log(green('✓') + ` ${model.stats.authReferences} authentication middleware references detected\n`);
}

function printCoverage(report: CoverageReport, verbose: boolean): void {
  console.log('API Documentation Coverage');
  console.log('─'.repeat(60));
  const width = Math.max(0, ...report.endpoints.map((c) => c.endpoint.method.length + 1 + c.endpoint.path.length));
  for (const c of report.endpoints) {
    const label = `${c.endpoint.method.toUpperCase()} ${c.endpoint.path}`.padEnd(width + 2);
    const pct = `${c.score}%`.padStart(4);
    console.log(`${label} ${c.score >= 90 ? green(pct) : c.score >= 70 ? yellow(pct) : red(pct)}`);
  }
  console.log(`\nOverall coverage: ${bold(report.overall + '%')}\n`);

  for (const c of report.endpoints) {
    if (!verbose && c.score === 100) continue;
    if (!verbose && !c.checks.some((k) => k.status === 'warn' || k.status === 'miss')) continue;
    console.log(bold(`${c.endpoint.method.toUpperCase()} ${c.endpoint.path}`) + dim(`  ${rel(c.endpoint.metadata.file)}:${c.endpoint.metadata.line}`));
    for (const k of c.checks) {
      const mark = k.status === 'ok' ? green('✓') : k.status === 'warn' ? yellow('⚠') : red('✗');
      console.log(`  ${mark} ${k.label}`);
    }
    for (const w of c.endpoint.metadata.warnings) console.log(`  ${yellow('⚠')} ${w}`);
    console.log('');
  }
}

function printWarnings(res: AnalysisResult): void {
  if (!res.model.warnings.length) return;
  console.log(bold('Analysis warnings'));
  for (const w of res.model.warnings) console.log(`  ${yellow('⚠')} ${w.replace(/\\/g, '/').replace(process.cwd().replace(/\\/g, '/') + '/', '')}`);
  console.log('');
}

function build(args: Args) {
  const res = analyzeProject(args.dir, { tsconfig: args.flags.tsconfig as string | undefined });
  const pkg = res.project.packageJson ?? {};
  const doc = generateOpenApi(res.model, res.project.config, pkg);
  const errors = validateOpenApi(doc);
  return { res, doc, errors, report: coverageReport(res.model) };
}

function tryBuild(args: Args): ReturnType<typeof build> {
  try {
    return build(args);
  } catch (e) {
    console.error(red('autodoc: ') + (e as Error).message);
    return process.exit(2);
  }
}

function outputOptions(args: Args): { file: string; format: 'json' | 'yaml' } {
  const requested = args.flags.format as string | undefined;
  if (requested && requested !== 'json' && requested !== 'yaml' && requested !== 'yml') {
    throw new Error(`Unknown output format "${requested}" (use json or yaml)`);
  }
  const named = args.flags.out as string | undefined;
  const extension = named ? path.extname(named).toLowerCase() : '';
  const format: 'json' | 'yaml' = requested
    ? requested === 'json' ? 'json' : 'yaml'
    : extension === '.yaml' || extension === '.yml' ? 'yaml' : 'json';
  return { file: path.resolve(named || `openapi.${format === 'yaml' ? 'yaml' : 'json'}`), format };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log(HELP);
    return;
  }

  const built = tryBuild(args);
  const { res, doc, errors, report } = built;
  const verbose = !!args.flags.verbose;

  printAnalysis(res);
  printCoverage(report, verbose);
  printWarnings(res);

  if (errors.length) {
    console.log(red('Generated OpenAPI document has problems:'));
    for (const e of errors) console.log('  ' + red('✗') + ' ' + e);
    console.log('');
  } else if (res.model.endpoints.length) {
    console.log(green('✓') + ' OpenAPI 3.1 document is valid\n');
  }

  let output: ReturnType<typeof outputOptions>;
  try {
    output = outputOptions(args);
  } catch (e) {
    console.error(red('autodoc: ') + (e as Error).message);
    process.exit(2);
    return;
  }
  switch (args.command) {
    case 'scan':
      return;
    case 'check': {
      const min = Number(args.flags['min-coverage'] ?? res.project.config.minCoverage ?? 80);
      const failed = report.overall < min || errors.length > 0 || res.model.endpoints.length === 0;
      if (report.overall < min) console.log(red(`✗ Documentation coverage ${report.overall}% is below the required ${min}%`));
      if (res.model.endpoints.length === 0) console.log(red('✗ No endpoints detected'));
      console.log(failed ? red('Build failed.') : green('✓ AutoDoc check passed.'));
      process.exit(failed ? 1 : 0);
      break;
    }
    case 'serve':
      serve(args);
      return;
    default:
      fs.writeFileSync(output.file, serializeOpenApi(doc, output.format));
      console.log(`Generated:\n\n  ${rel(output.file)}\n`);
      console.log(`Start documentation:\n\n  npx autodoc serve ${args.dir}\n`);
  }
}

function serve(args: Args): void {
  const port = Number(args.flags.port ?? 4000);
  const provider = ((args.flags.provider as string) || undefined) as DocsProvider | undefined;
  let state = build(args);
  const providerOf = () => provider ?? state.res.project.config.docs?.provider ?? 'scalar';

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(serializeOpenApi(state.doc, 'json'));
    } else if (url === '/openapi.yaml') {
      res.writeHead(200, { 'content-type': 'application/yaml; charset=utf-8', 'cache-control': 'no-store' });
      res.end(serializeOpenApi(state.doc, 'yaml'));
    } else if (url === '/docs' || url === '/docs/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(docsHtml(providerOf(), '/openapi.json', String(state.doc.info?.title ?? 'API') + ' docs'));
    } else if (url === '/coverage.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ overall: state.report.overall, endpoints: state.report.endpoints.map((e) => ({ method: e.endpoint.method, path: e.endpoint.path, score: e.score })) }));
    } else if (url === '/') {
      res.writeHead(302, { location: '/docs' });
      res.end();
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(red('autodoc: ') + (e.code === 'EADDRINUSE' ? `port ${port} is already in use (use --port)` : e.message));
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`Documentation:  ${bold(`http://localhost:${port}/docs`)}  ${dim(`(${providerOf()})`)}`);
    console.log(`OpenAPI spec:   http://localhost:${port}/openapi.json\n`);
  });

  if (!args.flags['no-watch']) {
    let timer: NodeJS.Timeout | undefined;
    try {
      fs.watch(path.resolve(args.dir), { recursive: true }, (_e: string, file: string | null) => {
        if (!file || !/\.[cm]?[jt]sx?$/.test(file) || /node_modules/.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            state = build(args);
            console.log(dim(`Re-analyzed after change: ${state.res.model.endpoints.length} endpoints, ${state.report.overall}% coverage`));
          } catch (e) {
            console.error(red('autodoc: ') + (e as Error).message);
          }
        }, 300);
      });
    } catch {
      /* watching is best-effort */
    }
  }
}

main();
