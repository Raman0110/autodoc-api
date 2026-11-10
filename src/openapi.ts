import { computeCoverage } from './coverage';
import type { ApiEndpoint, ApiModel, ApiSchema } from './model';
import type { AutoDocConfig } from './project';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type OpenApiDocument = Record<string, any>;

export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)(?:\([^)]*\))?\??/g, '{$1}');
}

function operation(e: ApiEndpoint): Record<string, any> {
  const op: Record<string, any> = {};
  if (e.tags.length) op.tags = e.tags;
  if (e.summary) op.summary = e.summary;
  if (e.description) op.description = e.description;
  op.operationId = e.operationId;
  if (e.deprecated) op.deprecated = true;

  const params = e.parameters.map((p) => {
    const out: Record<string, any> = { name: p.name, in: p.in, required: p.in === 'path' ? true : p.required, schema: p.schema };
    if (p.description) out.description = p.description;
    return out;
  });
  // every {param} in the path must be declared
  for (const m of toOpenApiPath(e.path).matchAll(/\{([^}]+)\}/g)) {
    if (!params.some((p) => p.in === 'path' && p.name === m[1])) {
      params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
    }
  }
  if (params.length) op.parameters = params;

  if (e.requestBody) {
    op.requestBody = {
      required: e.requestBody.required,
      content: { [e.requestBody.contentType]: { schema: e.requestBody.schema } },
    };
  }

  const responses: Record<string, any> = {};
  for (const r of e.responses) {
    const res: Record<string, any> = { description: r.description ?? 'Response' };
    if (!r.noContent && r.schema) {
      res.content = { [r.contentType ?? 'application/json']: { schema: r.schema } };
    }
    responses[String(r.status)] = res;
  }
  op.responses = responses;

  if (e.security.length) op.security = e.security.map((s) => ({ [s.scheme]: s.scopes }));
  op['x-autodoc'] = {
    confidence: e.metadata.confidence,
    coverage: computeCoverage(e).score,
    source: `${e.metadata.file.replace(/\\/g, '/').split('/').slice(-2).join('/')}:${e.metadata.line}`,
  };
  return op;
}

export function generateOpenApi(model: ApiModel, config: AutoDocConfig = {}, pkg: { name?: string; version?: string; description?: string } = {}): OpenApiDocument {
  const paths: Record<string, Record<string, any>> = {};
  for (const e of model.endpoints) {
    const key = toOpenApiPath(e.path);
    (paths[key] ??= {})[e.method] = operation(e);
  }
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: config.title ?? pkg.name ?? 'API',
      version: config.version ?? pkg.version ?? '1.0.0',
      ...(config.description ?? pkg.description ? { description: config.description ?? pkg.description } : {}),
    },
    paths,
  };
  if (config.servers?.length) doc.servers = config.servers.map((url) => ({ url }));
  const components: Record<string, any> = {};
  if (Object.keys(model.schemas).length) components.schemas = model.schemas;
  if (Object.keys(model.securitySchemes).length) components.securitySchemes = model.securitySchemes;
  if (Object.keys(components).length) doc.components = components;
  return doc;
}

/** Structural validation of the generated document (not a full JSON-Schema validation). */
export function validateOpenApi(doc: OpenApiDocument): string[] {
  const errors: string[] = [];
  if (doc.openapi !== '3.1.0') errors.push('openapi must be "3.1.0"');
  if (!doc.info?.title) errors.push('info.title is required');
  if (!doc.info?.version) errors.push('info.version is required');
  const schemas: Record<string, ApiSchema> = doc.components?.schemas ?? {};
  const schemes = doc.components?.securitySchemes ?? {};
  const ids = new Set<string>();

  const checkRefs = (node: unknown, where: string): void => {
    if (Array.isArray(node)) return node.forEach((n) => checkRefs(n, where));
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') {
          const m = /^#\/components\/schemas\/(.+)$/.exec(v);
          if (!m || !(m[1] in schemas)) errors.push(`${where}: unresolved $ref ${v}`);
        } else checkRefs(v, where);
      }
    }
  };

  for (const [p, item] of Object.entries<Record<string, any>>(doc.paths ?? {})) {
    if (!p.startsWith('/')) errors.push(`path "${p}" must start with "/"`);
    const templ = Array.from(p.matchAll(/\{([^}]+)\}/g), (m) => m[1]);
    for (const [method, op] of Object.entries<Record<string, any>>(item)) {
      const where = `${method.toUpperCase()} ${p}`;
      if (op.operationId) {
        if (ids.has(op.operationId)) errors.push(`${where}: duplicate operationId ${op.operationId}`);
        ids.add(op.operationId);
      }
      if (!op.responses || Object.keys(op.responses).length === 0) errors.push(`${where}: no responses`);
      for (const [code, r] of Object.entries<Record<string, any>>(op.responses ?? {})) {
        if (!r.description) errors.push(`${where}: response ${code} has no description`);
      }
      const declared = (op.parameters ?? []).filter((x: any) => x.in === 'path').map((x: any) => x.name);
      for (const t of templ) if (!declared.includes(t)) errors.push(`${where}: path parameter {${t}} not declared`);
      for (const prm of op.parameters ?? []) {
        if (prm.in === 'path' && prm.required !== true) errors.push(`${where}: path parameter ${prm.name} must be required`);
      }
      for (const sec of op.security ?? []) {
        for (const name of Object.keys(sec)) if (!(name in schemes)) errors.push(`${where}: unknown security scheme ${name}`);
      }
      checkRefs(op, where);
    }
  }
  checkRefs(schemas, 'components.schemas');
  return errors;
}
