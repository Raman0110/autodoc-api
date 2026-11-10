import { STATUS_CODES } from 'http';
import * as ts from 'typescript';
import type {
  ApiEndpoint,
  ApiParameter,
  ApiRequestBody,
  ApiResponse,
  ApiSchema,
  Confidence,
  DocsMeta,
  SecurityRequirement,
} from '../model';
import type { AutoDocConfig } from '../project';
import type { TypeSchemaBuilder } from '../typeSchema';
import type { ValidatorAdapter, ValidatorContext } from '../validators/adapter';
import {
  calleeName,
  declarationOf,
  evalNumber,
  expressionName,
  functionFromExpression,
  jsDocSummary,
  symbolOf,
  unwrap,
  type FnNode,
} from '../util';
import type { DiscoveredRoute } from './routes';

export interface AnalysisContext {
  checker: ts.TypeChecker;
  types: TypeSchemaBuilder;
  adapters: ValidatorAdapter[];
  config: AutoDocConfig;
  docsMeta: Map<ts.Node, DocsMeta>;
  components: Record<string, ApiSchema>;
  stats: { validators: Record<string, number>; authReferences: number };
  warn(message: string, node?: ts.Node): void;
}

const AUTH_NAME =
  /^(auth|authenticate|authenticated|authenticateJwt|authorize|authorise|requireAuth|requireAuthentication|requireLogin|requireUser|requireRole|requireAdmin|isAuthenticated|isAuth|isLoggedIn|ensureAuth|ensureAuthenticated|ensureLoggedIn|protect|verifyToken|verifyJwt|verifyJWT|checkJwt|checkAuth|jwtAuth|passportAuth|withAuth)$/i;

type Target = 'body' | 'query' | 'params' | 'header';
interface FoundValidator {
  target: Target;
  schema: ApiSchema;
  adapter: string;
}

const SOURCE_PRIORITY: Record<string, number> = {
  'path-template': 0,
  'static-inference': 1,
  'typescript-request-type': 2,
  'typescript-call-argument': 2,
};
const priorityOf = (source: string): number => SOURCE_PRIORITY[source] ?? (source.endsWith('-validator') ? 3 : 1);

function targetFromName(name: string | undefined): Target {
  if (!name) return 'body';
  if (/quer/i.test(name)) return 'query';
  if (/param/i.test(name)) return 'params';
  if (/header/i.test(name)) return 'header';
  return 'body';
}

export function pathParamNames(path: string): string[] {
  return Array.from(path.matchAll(/:([A-Za-z0-9_]+)(?:\([^)]*\))?\??/g), (m) => m[1]);
}

function pascal(s: string): string {
  return s
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (c) => c.toUpperCase());
}

export function analyzeEndpoint(route: DiscoveredRoute, ctx: AnalysisContext): ApiEndpoint {
  const { checker } = ctx;
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const vctx: ValidatorContext = {
    checker,
    types: ctx.types,
    components: ctx.components,
    warn: (m, n) => ctx.warn(m, n),
  };

  // ------------------------------------------------- classify the handler chain
  const handlers = route.handlers;
  const controllerExpr = handlers[handlers.length - 1];
  const middleware = [...route.inheritedMiddleware, ...handlers.slice(0, -1)];

  const validators: FoundValidator[] = [];
  const security: SecurityRequirement[] = [];
  const addSecurity = (name: string | undefined) => {
    if (!name) return;
    const configured = ctx.config.authMiddleware?.includes(name);
    if (configured || AUTH_NAME.test(name)) {
      if (!security.some((s) => s.scheme === 'bearerAuth')) {
        security.push({
          scheme: 'bearerAuth',
          scopes: [],
          confidence: configured ? 'high' : 'medium',
          source: configured ? 'config' : 'middleware-name',
        });
        ctx.stats.authReferences++;
      }
    }
  };

  const findValidator = (expr: ts.Expression): { adapter: ValidatorAdapter } | undefined => {
    const adapter = ctx.adapters.find((a) => a.matches(expr, vctx));
    return adapter ? { adapter } : undefined;
  };

  const analyzeMiddleware = (expr: ts.Expression, depth = 0): void => {
    expr = unwrap(expr);
    const name = expressionName(expr);
    if (ts.isCallExpression(expr)) {
      const cname = calleeName(expr);
      let found = false;
      for (const arg of expr.arguments) {
        const a = unwrap(arg);
        const direct = findValidator(a);
        if (direct) {
          const schema = direct.adapter.toSchema(a, vctx);
          if (schema) {
            validators.push({ target: targetFromName(cname), schema, adapter: direct.adapter.name });
            found = true;
          }
        } else if (ts.isObjectLiteralExpression(a)) {
          // validate({ body: schema, query: schema, params: schema })
          for (const p of a.properties) {
            if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)) continue;
            const v = findValidator(p.initializer);
            if (!v) continue;
            const schema = v.adapter.toSchema(p.initializer, vctx);
            if (schema) {
              validators.push({ target: targetFromName(p.name.text), schema, adapter: v.adapter.name });
              found = true;
            }
          }
        }
      }
      if (found) return;
      addSecurity(cname);
      return;
    }
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
      // const validateCreate = validate(schema);  router.post('/', validateCreate, ...)
      const decl = declarationOf(symbolOf(checker, expr));
      if (depth < 2 && decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = unwrap(decl.initializer);
        if (ts.isCallExpression(init)) {
          const before = validators.length;
          analyzeMiddleware(init, depth + 1);
          if (validators.length > before) return;
        }
      }
    }
    addSecurity(name);
  };
  for (const m of middleware) analyzeMiddleware(m);

  // ------------------------------------------------------- resolve controller
  let controller: FnNode | undefined;
  if (controllerExpr) {
    const unwrapped = unwrap(controllerExpr);
    const isValidatorCall = ts.isCallExpression(unwrapped) && !!findValidator(unwrapped.arguments[0] ?? unwrapped);
    controller = isValidatorCall ? undefined : functionFromExpression(checker, controllerExpr);
    // docs(handler, {...}) wrapper: unwrap the function argument
    if (!controller && ts.isCallExpression(unwrapped) && calleeName(unwrapped) === 'docs' && unwrapped.arguments[0]) {
      controller = functionFromExpression(checker, unwrapped.arguments[0]);
    }
  }
  if (!controller) warn('route handler could not be resolved to a function');

  const handlerName = controller ? functionName(controller) : undefined;

  // ------------------------------------------------------------ parameters
  const params = new Map<string, ApiParameter & { prio: number }>();
  const upsert = (p: ApiParameter) => {
    const key = `${p.in}:${p.name}`;
    const prio = priorityOf(p.source);
    const existing = params.get(key);
    if (!existing || prio >= existing.prio) params.set(key, { ...p, prio });
  };

  for (const name of pathParamNames(route.path)) {
    upsert({ name, in: 'path', required: true, schema: { type: 'string' }, confidence: 'medium', source: 'path-template' });
  }

  let body: ApiRequestBody | undefined;
  const setBody = (b: ApiRequestBody) => {
    if (!body || priorityOf(b.source) >= priorityOf(body.source)) body = b;
  };

  const responses: ApiResponse[] = [];

  if (controller) analyzeController(controller, ctx, { upsert, setBody, responses, warn });

  // validators override everything inferred from code
  const inlineObject = (s: ApiSchema): ApiSchema => {
    if (s.$ref) return ctx.components[s.$ref.split('/').pop()!] ?? s;
    if (s.allOf) {
      const props: Record<string, ApiSchema> = {};
      const req: string[] = [];
      for (const part of s.allOf) {
        const i = inlineObject(part);
        Object.assign(props, i.properties ?? {});
        req.push(...(i.required ?? []));
      }
      return { type: 'object', properties: props, required: req };
    }
    return s;
  };
  for (const v of validators) {
    ctx.stats.validators[v.adapter] = (ctx.stats.validators[v.adapter] ?? 0) + 1;
    const source = `${v.adapter}-validator`;
    if (v.target === 'body') {
      setBody({ contentType: 'application/json', required: true, schema: v.schema, confidence: 'high', source });
    } else {
      const obj = inlineObject(v.schema);
      const req = new Set(obj.required ?? []);
      if (!obj.properties) {
        warn(`${v.adapter} ${v.target} schema is not an object; parameters not derived`);
        continue;
      }
      for (const [name, schema] of Object.entries(obj.properties)) {
        const where = v.target === 'params' ? 'path' : v.target === 'header' ? 'header' : 'query';
        if (where === 'path' && !pathParamNames(route.path).includes(name)) continue;
        upsert({
          name,
          in: where,
          required: where === 'path' ? true : req.has(name),
          schema,
          description: typeof schema.description === 'string' ? schema.description : undefined,
          confidence: 'high',
          source,
        });
      }
    }
  }

  // --------------------------------------------------------- docs metadata
  let meta: DocsMeta = {};
  const metaKey = controller;
  if (metaKey && ctx.docsMeta.has(metaKey)) meta = ctx.docsMeta.get(metaKey)!;
  const jsdoc = controller ? jsDocSummary(controller) : {};

  const mergedResponses = mergeResponses(responses, meta);
  if (mergedResponses.length === 0) {
    mergedResponses.push({
      status: 200,
      description: STATUS_CODES[200],
      confidence: 'low',
      source: 'default',
    });
    warn('no response detected; defaulted to 200 with unknown body');
  }

  const parameters = [...params.values()]
    .map(({ prio: _p, ...rest }) => rest)
    .sort((a, b) => order(a.in) - order(b.in));

  const confidence: Confidence = minConfidence([
    ...mergedResponses.map((r) => r.confidence),
    ...(controller ? [] : ['low' as Confidence]),
  ]);

  return {
    method: route.method,
    path: route.path,
    operationId: meta.operationId ?? handlerName ?? route.method + pascal(route.path),
    parameters,
    requestBody: body,
    responses: mergedResponses.sort((a, b) => a.status - b.status),
    security,
    tags: meta.tags ?? defaultTags(route.path),
    summary: meta.summary ?? jsdoc.summary,
    description: meta.description ?? jsdoc.description,
    deprecated: meta.deprecated,
    metadata: {
      file: route.file,
      line: route.line,
      handlerName,
      warnings,
      confidence,
      source: 'express-route',
    },
  };
}

/** `body?: T` makes the parameter `T | undefined`; the contract is T. */
function withoutUndefined(t: ts.Type): ts.Type {
  if (!t.isUnion()) return t;
  const rest = t.types.filter((m) => !(m.flags & ts.TypeFlags.Undefined));
  return rest.length === 1 ? rest[0] : t;
}

function order(where: string): number {
  return where === 'path' ? 0 : where === 'query' ? 1 : 2;
}

function minConfidence(list: Confidence[]): Confidence {
  if (list.includes('low')) return 'low';
  if (list.includes('medium')) return 'medium';
  return 'high';
}

function defaultTags(path: string): string[] {
  const seg = path
    .split('/')
    .filter(Boolean)
    .find((s) => !s.startsWith(':') && !/^(api|v\d+)$/i.test(s));
  return seg ? [seg] : [];
}

function functionName(fn: FnNode): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isCallExpression(p)) {
    const pp = p.parent;
    if (pp && ts.isVariableDeclaration(pp) && ts.isIdentifier(pp.name)) return pp.name.text;
  }
  return undefined;
}

function mergeResponses(list: ApiResponse[], meta: DocsMeta): ApiResponse[] {
  const byStatus = new Map<number, ApiResponse[]>();
  for (const r of list) {
    const arr = byStatus.get(r.status) ?? [];
    arr.push(r);
    byStatus.set(r.status, arr);
  }
  const out: ApiResponse[] = [];
  for (const [status, rs] of byStatus) {
    // prefer responses that have a resolved schema
    const withSchema = rs.filter((r) => r.schema && Object.keys(r.schema).length > 0);
    const pool = withSchema.length ? withSchema : rs;
    const distinct: ApiResponse[] = [];
    const seen = new Set<string>();
    for (const r of pool) {
      const k = JSON.stringify([r.schema, r.noContent]);
      if (!seen.has(k)) {
        seen.add(k);
        distinct.push(r);
      }
    }
    const first = distinct[0];
    const merged: ApiResponse =
      distinct.length > 1 && distinct.every((d) => d.schema)
        ? {
            ...first,
            schema: { anyOf: distinct.map((d) => d.schema!) },
            confidence: minConfidence(distinct.map((d) => d.confidence)),
          }
        : first;
    out.push({ ...merged, description: merged.description ?? STATUS_CODES[status] ?? 'Response' });
  }
  // descriptions / extra statuses from docs()
  for (const [code, v] of Object.entries(meta.responses ?? {})) {
    const status = Number(code);
    if (!Number.isFinite(status)) continue;
    const description = typeof v === 'string' ? v : v.description;
    const existing = out.find((r) => r.status === status);
    if (existing) {
      if (description) existing.description = description;
    } else {
      out.push({ status, description: description ?? STATUS_CODES[status] ?? 'Response', confidence: 'high', source: 'docs-annotation', noContent: true });
    }
  }
  return out;
}

// =================================================================== controller

interface Sink {
  upsert(p: ApiParameter): void;
  setBody(b: ApiRequestBody): void;
  responses: ApiResponse[];
  warn(m: string): void;
}

const CHAIN_PASSTHROUGH = new Set(['cookie', 'clearCookie', 'set', 'header', 'setHeader', 'type', 'contentType', 'append', 'location', 'links', 'vary', 'attachment', 'format']);
const NO_BODY_STATUS = new Set([204, 205, 304]);

function analyzeController(fn: FnNode, ctx: AnalysisContext, sink: Sink): void {
  const { checker, types } = ctx;
  const [reqParam, resParam] = fn.parameters;
  const reqName = reqParam && ts.isIdentifier(reqParam.name) ? reqParam.name.text : undefined;
  const resName = resParam && ts.isIdentifier(resParam.name) ? resParam.name.text : undefined;

  // ------------------------------------------- typed request (Request<P,_,B,Q>)
  let declaredResBody: ts.Type | undefined;
  if (reqParam && reqName) {
    const reqType = checker.getTypeAtLocation(reqParam.name);

    const prop = (t: ts.Type, name: string): ts.Type | undefined => {
      const s = checker.getPropertyOfType(t, name);
      return s ? checker.getTypeOfSymbolAtLocation(s, reqParam) : undefined;
    };
    const objectProps = (t: ts.Type | undefined): ts.Symbol[] =>
      t && !types.isOpaque(t) && t.flags & ts.TypeFlags.Object ? checker.getPropertiesOfType(t) : [];

    const paramsT = prop(reqType, 'params');
    for (const s of objectProps(paramsT)) {
      const pt = checker.getTypeOfSymbolAtLocation(s, reqParam);
      sink.upsert({
        name: s.name,
        in: 'path',
        required: true,
        schema: types.schemaOf(pt),
        confidence: 'high',
        source: 'typescript-request-type',
      });
    }
    const queryT = prop(reqType, 'query');
    for (const s of objectProps(queryT)) {
      const pt = checker.getTypeOfSymbolAtLocation(s, reqParam);
      sink.upsert({
        name: s.name,
        in: 'query',
        required: !(s.flags & ts.SymbolFlags.Optional),
        schema: types.schemaOf(pt),
        confidence: 'high',
        source: 'typescript-request-type',
      });
    }
    const bodyT = prop(reqType, 'body');
    if (bodyT && !types.isOpaque(bodyT)) {
      sink.setBody({
        contentType: 'application/json',
        required: true,
        schema: types.schemaOf(bodyT),
        confidence: 'high',
        source: 'typescript-request-type',
      });
    }
  }

  // ------------------------------------------------ typed response (Response<T>)
  if (resParam && resName) {
    const resType = checker.getTypeAtLocation(resParam.name);
    const json = checker.getPropertyOfType(resType, 'json');
    if (json) {
      const jt = checker.getTypeOfSymbolAtLocation(json, resParam);
      const sig = jt.getCallSignatures()[0];
      const p0 = sig?.getParameters()[0];
      if (p0) {
        const t = checker.getTypeOfSymbolAtLocation(p0, resParam);
        if (!types.isOpaque(t)) declaredResBody = withoutUndefined(t);
      }
    }
  }

  const body = fn.body;
  if (!body) return;

  // --------------------------------------------------------------- code walk
  const fields = new Map<string, ApiSchema>(); // inferred body fields
  const queryNames = new Set<string>();

  const scalarKind = (node: ts.Node): ApiSchema => {
    // climb through `req.query.x as string`, `(req.query.x)!` ...
    while (
      node.parent &&
      (ts.isAsExpression(node.parent) || ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent))
    ) {
      node = node.parent;
    }
    const p = node.parent;
    if (p && ts.isCallExpression(p) && p.arguments[0] === node && ts.isIdentifier(p.expression)) {
      switch (p.expression.text) {
        case 'Number':
        case 'parseFloat':
          return { type: 'number' };
        case 'parseInt':
          return { type: 'integer' };
        case 'Boolean':
          return { type: 'boolean' };
      }
    }
    if (p && ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.PlusToken) return { type: 'number' };
    return { type: 'string' };
  };

  const bindingDefault = (el: ts.BindingElement): ApiSchema | undefined => {
    if (!el.initializer) return undefined;
    const i = unwrap(el.initializer);
    if (ts.isNumericLiteral(i)) return { type: 'number', default: Number(i.text) };
    if (ts.isStringLiteral(i)) return { type: 'string', default: i.text };
    if (i.kind === ts.SyntaxKind.TrueKeyword || i.kind === ts.SyntaxKind.FalseKeyword) {
      return { type: 'boolean', default: i.kind === ts.SyntaxKind.TrueKeyword };
    }
    return undefined;
  };

  const addQuery = (name: string, schema: ApiSchema, required = false) => {
    queryNames.add(name);
    sink.upsert({ name, in: 'query', required, schema, confidence: 'medium', source: 'static-inference' });
  };

  const isReqMember = (n: ts.Node, member: string): n is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(n) &&
    n.name.text === member &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === reqName;

  const memberKey = (parent: ts.Node, node: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return parent.name.text;
    if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteralLike(parent.argumentExpression)) {
      return parent.argumentExpression.text;
    }
    return undefined;
  };

  const resultOf = (status: number | undefined, call: ts.CallExpression, kind: string): void => {
    const arg = call.arguments[0];
    const s = status ?? 200;
    const description = STATUS_CODES[s] ?? 'Response';
    if (kind === 'sendStatus') {
      sink.responses.push({ status: s, description, confidence: 'high', source: 'static-inference', noContent: true });
      return;
    }
    if (kind === 'redirect') {
      sink.responses.push({ status: status ?? 302, description: STATUS_CODES[status ?? 302], confidence: 'high', source: 'static-inference', noContent: true });
      return;
    }
    if (!arg || NO_BODY_STATUS.has(s)) {
      sink.responses.push({ status: s, description, confidence: 'high', source: 'static-inference', noContent: true });
      return;
    }
    let exprType: ts.Type | undefined;
    try {
      exprType = checker.getTypeAtLocation(arg);
    } catch {
      /* ignore */
    }
    const isSuccess = s < 400;
    const declaredIsUnion = declaredResBody?.isUnion() && !(declaredResBody.flags & ts.TypeFlags.Boolean);
    const contentType = kind === 'send' && exprType && exprType.flags & (ts.TypeFlags.StringLike) ? 'text/plain' : 'application/json';

    if (isSuccess && declaredResBody && !declaredIsUnion) {
      sink.responses.push({
        status: s,
        description,
        contentType,
        schema: types.schemaOf(declaredResBody),
        confidence: 'high',
        source: 'typescript-response-type',
      });
      return;
    }
    if (exprType && !types.isOpaque(exprType)) {
      const schema = types.schemaOf(exprType, { widen: true });
      sink.responses.push({
        status: s,
        description,
        contentType,
        schema,
        confidence: schema.$ref ? 'high' : 'medium',
        source: 'typescript-expression-type',
      });
      return;
    }
    if (isSuccess && declaredResBody) {
      sink.responses.push({ status: s, description, contentType, schema: types.schemaOf(declaredResBody), confidence: 'medium', source: 'typescript-response-type' });
      return;
    }
    sink.responses.push({ status: s, description, contentType, schema: {}, confidence: 'low', source: 'static-inference' });
  };

  const visit = (node: ts.Node): void => {
    if (reqName) {
      // req.query.*
      if (isReqMember(node, 'query') && node.parent) {
        const key = memberKey(node.parent, node);
        if (key) addQuery(key, scalarKind(node.parent));
        else if (ts.isVariableDeclaration(node.parent) && ts.isObjectBindingPattern(node.parent.name)) {
          for (const el of node.parent.name.elements) {
            const n = (el.propertyName ?? el.name) as ts.Node;
            if (ts.isIdentifier(n)) addQuery(n.text, bindingDefault(el) ?? { type: 'string' });
          }
        }
      }
      // req.params.* : types come from the path template or Request<P>
      // req.body
      if (isReqMember(node, 'body') && node.parent) {
        const p = node.parent;
        const key = memberKey(p, node);
        if (key) fields.set(key, fields.get(key) ?? {});
        else if (ts.isVariableDeclaration(p)) {
          if (p.type) {
            sink.setBody({ contentType: 'application/json', required: true, schema: types.schemaOf(checker.getTypeFromTypeNode(p.type)), confidence: 'high', source: 'typescript-request-type' });
          } else if (ts.isObjectBindingPattern(p.name)) {
            for (const el of p.name.elements) {
              const n = (el.propertyName ?? el.name) as ts.Node;
              if (ts.isIdentifier(n)) fields.set(n.text, bindingDefault(el) ?? {});
            }
          }
        }
      }
      if (ts.isAsExpression(node) && isReqMember(unwrap(node.expression), 'body')) {
        const t = checker.getTypeFromTypeNode(node.type);
        if (!types.isOpaque(t)) {
          sink.setBody({ contentType: 'application/json', required: true, schema: types.schemaOf(t), confidence: 'high', source: 'typescript-request-type' });
        }
      }
      // req.headers.x / req.get('x') / req.header('x')
      if (ts.isPropertyAccessExpression(node) && isReqMember(node.expression, 'headers')) {
        addHeader(node.name.text);
      }
      if (ts.isElementAccessExpression(node) && isReqMember(node.expression, 'headers') && ts.isStringLiteralLike(node.argumentExpression)) {
        addHeader(node.argumentExpression.text);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['get', 'header'].includes(node.expression.name.text) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === reqName &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        addHeader(node.arguments[0].text);
      }
    }

    // res.<status>.<send>
    if (resName && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (['json', 'jsonp', 'send', 'end', 'sendStatus', 'redirect', 'sendFile', 'download'].includes(method)) {
        // walk the chain down to `res`, collecting .status(n) and skipping header/cookie helpers
        let recv: ts.Expression = unwrap(node.expression.expression);
        let status: number | undefined;
        let ok = false;
        for (let guard = 0; guard < 10; guard++) {
          if (ts.isIdentifier(recv)) {
            ok = recv.text === resName;
            break;
          }
          if (ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression)) {
            const m = recv.expression.name.text;
            if (m === 'status') {
              status = evalNumber(checker, recv.arguments[0]);
              if (status === undefined) sink.warn('response status code is not a constant; assumed 200');
            } else if (!CHAIN_PASSTHROUGH.has(m)) break;
            recv = unwrap(recv.expression.expression);
            continue;
          }
          break;
        }
        if (ok) {
          if (method === 'sendStatus') status = evalNumber(checker, node.arguments[0]) ?? 200;
          if (method === 'sendFile' || method === 'download') {
            sink.responses.push({ status: status ?? 200, description: STATUS_CODES[status ?? 200], contentType: 'application/octet-stream', schema: { type: 'string', format: 'binary' }, confidence: 'medium', source: 'static-inference' });
          } else {
            resultOf(status, node, method);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  const addHeader = (raw: string) => {
    const name = raw.toLowerCase();
    if (['authorization', 'content-type', 'accept', 'user-agent', 'host', 'cookie'].includes(name)) return;
    sink.upsert({ name, in: 'header', required: false, schema: { type: 'string' }, confidence: 'medium', source: 'static-inference' });
  };

  // `const payload = req.body;` : follow the variable into the calls that consume it
  const bodyAliases = new Set<ts.Symbol>();
  const isBodyExpr = (e: ts.Expression): boolean => {
    e = unwrap(e);
    if (reqName && isReqMember(e, 'body')) return true;
    if (ts.isIdentifier(e)) {
      const sym = checker.getSymbolAtLocation(e);
      return !!sym && bodyAliases.has(sym);
    }
    return false;
  };
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !node.type && node.initializer && isBodyExpr(node.initializer)) {
      const sym = checker.getSymbolAtLocation(node.name);
      if (sym) bodyAliases.add(sym);
    }
    ts.forEachChild(node, collectAliases);
  };
  const followBody = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      node.arguments.forEach((arg, i) => {
        if (!isBodyExpr(arg)) return;
        let sig: ts.Signature | undefined;
        try {
          sig = checker.getResolvedSignature(node);
        } catch {
          return;
        }
        const param = sig?.getParameters()[i];
        if (!param) return;
        const t = withoutUndefined(checker.getTypeOfSymbolAtLocation(param, node));
        if (types.isOpaque(t)) return;
        sink.setBody({
          contentType: 'application/json',
          required: true,
          schema: types.schemaOf(t),
          confidence: 'medium',
          source: 'typescript-call-argument',
        });
      });
    }
    // payload.email -> field (low confidence, used only if nothing better is found)
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const sym = checker.getSymbolAtLocation(node.expression);
      if (sym && bodyAliases.has(sym)) fields.set(node.name.text, fields.get(node.name.text) ?? {});
    }
    ts.forEachChild(node, followBody);
  };

  visit(body);
  if (reqName) {
    collectAliases(body);
    followBody(body);
  }

  if (fields.size > 0) {
    const props: Record<string, ApiSchema> = {};
    for (const [k, v] of fields) props[k] = v;
    sink.setBody({
      contentType: 'application/json',
      required: true,
      schema: { type: 'object', properties: props },
      confidence: 'low',
      source: 'static-inference',
    });
  }
}
