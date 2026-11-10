import * as ts from 'typescript';
import { analyzeEndpoint, type AnalysisContext } from './express/controller';
import { discoverRoutes } from './express/routes';
import type { ApiEndpoint, ApiModel, ApiSchema, DocsMeta } from './model';
import { createProject, dependencyVersion, type AutoDocConfig, type Project } from './project';
import { TypeSchemaBuilder } from './typeSchema';
import type { ValidatorAdapter } from './validators/adapter';
import { ZodAdapter } from './validators/zod';
import { calleeName, functionFromExpression, locate, unwrap } from './util';

export interface AnalyzeOptions {
  tsconfig?: string;
  config?: AutoDocConfig;
  adapters?: ValidatorAdapter[];
}

export interface AnalysisResult {
  model: ApiModel;
  project: Project;
}

function literalDocs(checker: ts.TypeChecker, e: ts.Expression): DocsMeta | undefined {
  e = unwrap(e);
  if (!ts.isObjectLiteralExpression(e)) return undefined;
  const meta: DocsMeta = {};
  const str = (x: ts.Expression): string | undefined =>
    ts.isStringLiteralLike(unwrap(x)) ? (unwrap(x) as ts.StringLiteralLike).text : undefined;
  for (const p of e.properties) {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
    const k = p.name.text;
    const v = unwrap(p.initializer);
    if (k === 'summary' || k === 'description' || k === 'operationId') meta[k] = str(v);
    else if (k === 'deprecated') meta.deprecated = v.kind === ts.SyntaxKind.TrueKeyword;
    else if (k === 'tags' && ts.isArrayLiteralExpression(v)) {
      meta.tags = v.elements.map((x) => str(x)).filter((x): x is string => !!x);
    } else if (k === 'responses' && ts.isObjectLiteralExpression(v)) {
      meta.responses = {};
      for (const rp of v.properties) {
        if (!ts.isPropertyAssignment(rp)) continue;
        const code = ts.isIdentifier(rp.name) || ts.isStringLiteral(rp.name) || ts.isNumericLiteral(rp.name) ? rp.name.text : undefined;
        if (!code) continue;
        const iv = unwrap(rp.initializer);
        const s = str(iv);
        if (s !== undefined) meta.responses[code] = s;
        else if (ts.isObjectLiteralExpression(iv)) {
          const d = iv.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && ts.isIdentifier(q.name) && q.name.text === 'description');
          meta.responses[code] = { description: d ? str(d.initializer) : undefined };
        }
      }
    }
  }
  void checker;
  return meta;
}

/** Find `docs(handler, { ... })` calls across the project. */
function collectDocs(project: Project): Map<ts.Node, DocsMeta> {
  const out = new Map<ts.Node, DocsMeta>();
  for (const sf of project.sourceFiles) {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && calleeName(n) === 'docs' && n.arguments.length >= 2) {
        const fn = functionFromExpression(project.checker, n.arguments[0]);
        const meta = literalDocs(project.checker, n.arguments[1]);
        if (fn && meta) out.set(fn, meta);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

function uniqueOperationIds(endpoints: ApiEndpoint[]): void {
  const seen = new Map<string, number>();
  for (const e of endpoints) {
    const n = seen.get(e.operationId) ?? 0;
    seen.set(e.operationId, n + 1);
    if (n > 0) e.operationId = `${e.operationId}${n + 1}`;
  }
}

export function analyzeProject(dir: string, options: AnalyzeOptions = {}): AnalysisResult {
  const project = createProject(dir, { tsconfig: options.tsconfig, config: options.config });
  const warnings: string[] = [...project.warnings];
  const components: Record<string, ApiSchema> = {};
  const anchor = project.sourceFiles[0];
  const types = new TypeSchemaBuilder(project.checker, components, anchor);
  const stats = { validators: {} as Record<string, number>, authReferences: 0 };

  const ctx: AnalysisContext = {
    checker: project.checker,
    types,
    adapters: options.adapters ?? [new ZodAdapter()],
    config: project.config,
    docsMeta: collectDocs(project),
    components,
    stats,
    warn: (message, node) => {
      if (node) {
        const l = locate(node);
        warnings.push(`${l.file}:${l.line} ${message}`);
      } else warnings.push(message);
    },
  };

  const discovery = discoverRoutes(project);
  warnings.push(...discovery.warnings);

  const endpoints = discovery.routes.map((r) => analyzeEndpoint(r, ctx));
  endpoints.sort((a, b) => (a.path === b.path ? methodOrder(a.method) - methodOrder(b.method) : a.path.localeCompare(b.path)));
  uniqueOperationIds(endpoints);

  const securitySchemes: ApiModel['securitySchemes'] = {};
  if (endpoints.some((e) => e.security.some((s) => s.scheme === 'bearerAuth'))) {
    securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
  }

  const expressVersion = dependencyVersion(project, 'express');
  const usesExpress = discovery.routes.length > 0;
  const model: ApiModel = {
    framework: { name: usesExpress ? 'express' : 'unknown', version: expressVersion },
    endpoints,
    schemas: sortKeys(pruneUnused(components, endpoints)),
    securitySchemes,
    warnings: Array.from(new Set(warnings)),
    stats: {
      filesScanned: project.sourceFiles.length,
      routeFiles: discovery.routeFiles.size,
      validators: stats.validators,
      responseTypesResolved: endpoints.filter((e) =>
        e.responses.some((r) => r.schema && Object.keys(r.schema).length > 0 && r.status < 400),
      ).length,
      statusCodesDetected: endpoints.reduce((n, e) => n + e.responses.filter((r) => r.source !== 'default').length, 0),
      authReferences: stats.authReferences,
    },
  };
  return { model, project };
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
function methodOrder(m: string): number {
  return METHOD_ORDER.indexOf(m);
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/** Keep only component schemas reachable from some endpoint. */
function pruneUnused(components: Record<string, ApiSchema>, endpoints: ApiEndpoint[]): Record<string, ApiSchema> {
  const used = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const name = v.split('/').pop()!;
        if (!used.has(name) && components[name]) {
          used.add(name);
          visit(components[name]);
        }
      } else visit(v);
    }
  };
  for (const e of endpoints) visit([e.parameters, e.requestBody, e.responses]);
  return Object.fromEntries(Object.entries(components).filter(([k]) => used.has(k)));
}
