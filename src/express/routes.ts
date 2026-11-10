import * as ts from 'typescript';
import type { HttpMethod } from '../model';
import type { Project } from '../project';
import {
  declarationOf,
  evalString,
  functionFromExpression,
  joinPaths,
  locate,
  symbolOf,
  unwrap,
} from '../util';

const HTTP_METHODS = new Set<string>(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const ROUTER_TYPE_NAMES = new Set(['Router', 'Express', 'Application', 'IRouter']);

export interface DiscoveredRoute {
  method: HttpMethod;
  /** Full Express-style path including mount prefixes. */
  path: string;
  /** Path as written at the route definition. */
  rawPath: string;
  /** Middleware inherited from router.use(...) and mount points, outermost first. */
  inheritedMiddleware: ts.Expression[];
  /** Handler arguments as written (middleware..., controller). */
  handlers: ts.Expression[];
  node: ts.CallExpression;
  file: string;
  line: number;
}

interface RawRoute {
  method: HttpMethod;
  path: string;
  handlers: ts.Expression[];
  node: ts.CallExpression;
}
interface Mount {
  child: ts.Symbol;
  prefix: string;
  middleware: ts.Expression[];
}
interface UseEntry {
  prefix: string;
  middleware: ts.Expression[];
  node: ts.CallExpression;
}
interface RouterInfo {
  key: ts.Symbol;
  routes: RawRoute[];
  mounts: Mount[];
  uses: UseEntry[];
}

export interface RouteDiscovery {
  routes: DiscoveredRoute[];
  routeFiles: Set<string>;
  warnings: string[];
}

export function discoverRoutes(project: Project): RouteDiscovery {
  const { checker } = project;
  const warnings: string[] = [];
  const routers = new Map<ts.Symbol, RouterInfo>();
  const childKeys = new Set<ts.Symbol>();
  const keyCache = new Map<ts.Node, ts.Symbol | null>();

  const info = (key: ts.Symbol): RouterInfo => {
    let i = routers.get(key);
    if (!i) routers.set(key, (i = { key, routes: [], mounts: [], uses: [] }));
    return i;
  };

  // ------------------------------------------------------- router detection

  const isRouterInit = (init: ts.Expression | undefined): boolean => {
    if (!init) return false;
    const e = unwrap(init);
    if (!ts.isCallExpression(e)) return false;
    const c = e.expression;
    if (ts.isIdentifier(c)) return c.text === 'Router' || c.text === 'express';
    if (ts.isPropertyAccessExpression(c)) return c.name.text === 'Router';
    return false;
  };

  const isRouterType = (expr: ts.Expression): boolean => {
    try {
      const t = checker.getTypeAtLocation(expr);
      const n = t.aliasSymbol?.name ?? t.getSymbol()?.name;
      if (n && ROUTER_TYPE_NAMES.has(n)) return true;
      return ['use', 'get', 'post', 'route', 'param'].every((p) => !!checker.getPropertyOfType(t, p));
    } catch {
      return false;
    }
  };

  const resolveRouterKey = (expr: ts.Expression, depth = 0): ts.Symbol | undefined => {
    if (depth > 6) return undefined;
    expr = unwrap(expr);
    const cached = keyCache.get(expr);
    if (cached !== undefined) return cached ?? undefined;
    let result: ts.Symbol | undefined;

    if (ts.isCallExpression(expr) && !isRouterInit(expr)) {
      // factory: app.use('/users', createUserRouter())
      const fn = functionFromExpression(checker, expr.expression);
      if (fn?.body) {
        const returns: ts.Expression[] = [];
        const visit = (n: ts.Node): void => {
          if (n !== fn && (ts.isFunctionLike(n) && n !== fn)) return;
          if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
          ts.forEachChild(n, visit);
        };
        visit(fn.body);
        if (ts.isExpression(fn.body)) returns.push(fn.body);
        for (const r of returns) {
          result = resolveRouterKey(r, depth + 1);
          if (result) break;
        }
      }
    } else if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
      let sym = symbolOf(checker, expr);
      for (let i = 0; sym && i < 6; i++) {
        const decl = declarationOf(sym);
        if (decl && ts.isExportAssignment(decl)) {
          const inner = unwrap(decl.expression);
          if (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner)) {
            sym = symbolOf(checker, inner);
            continue;
          }
          if (isRouterInit(inner)) {
            result = sym;
            break;
          }
        }
        const init =
          decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertyAssignment(decl))
            ? decl.initializer
            : undefined;
        if (isRouterInit(init) || isRouterType(expr)) result = sym;
        break;
      }
    } else if (isRouterInit(expr)) {
      // inline `app.use('/x', Router())` with no binding: not addressable
      result = undefined;
    }
    keyCache.set(expr, result ?? null);
    return result;
  };

  type Receiver = { key: ts.Symbol; basePath?: string };
  const receiverOf = (expr: ts.Expression): Receiver | undefined => {
    expr = unwrap(expr);
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
      const name = expr.expression.name.text;
      if (name === 'route') {
        const inner = receiverOf(expr.expression.expression);
        if (inner && inner.basePath === undefined) {
          return { key: inner.key, basePath: evalString(checker, expr.arguments[0]) ?? '' };
        }
        return undefined;
      }
      if (HTTP_METHODS.has(name) || name === 'use' || name === 'param' || name === 'all') {
        return receiverOf(expr.expression.expression);
      }
    }
    const key = resolveRouterKey(expr);
    return key ? { key } : undefined;
  };

  // -------------------------------------------------------------- collection

  const flattenArgs = (args: readonly ts.Expression[]): ts.Expression[] => {
    const out: ts.Expression[] = [];
    for (const a of args) {
      const e = unwrap(a);
      if (ts.isArrayLiteralExpression(e)) out.push(...flattenArgs(e.elements));
      else if (ts.isSpreadElement(e)) out.push(...flattenArgs([e.expression]));
      else out.push(e);
    }
    return out;
  };

  const handleCall = (call: ts.CallExpression): void => {
    if (!ts.isPropertyAccessExpression(call.expression)) return;
    const name = call.expression.name.text;
    const isMethod = HTTP_METHODS.has(name);
    if (!isMethod && name !== 'use') return;
    const recv = receiverOf(call.expression.expression);
    if (!recv) return;
    const r = info(recv.key);

    if (isMethod) {
      let path: string | undefined;
      let handlers: readonly ts.Expression[];
      if (recv.basePath !== undefined) {
        path = recv.basePath;
        handlers = call.arguments;
      } else {
        if (call.arguments.length < 2) return; // app.get('setting')
        path = evalString(checker, call.arguments[0]);
        handlers = call.arguments.slice(1);
        if (path === undefined) {
          const loc = locate(call);
          warnings.push(`${loc.file}:${loc.line} route path is not a static string; skipped`);
          return;
        }
      }
      r.routes.push({ method: name as HttpMethod, path, handlers: flattenArgs(handlers), node: call });
      return;
    }

    // .use(...)
    let args = [...call.arguments];
    let prefix = '';
    const first = args[0] ? evalString(checker, args[0]) : undefined;
    if (first !== undefined) {
      prefix = first;
      args = args.slice(1);
    }
    const flat = flattenArgs(args);
    const middleware: ts.Expression[] = [];
    for (const a of flat) {
      const child = resolveRouterKey(a);
      if (child && child !== recv.key) {
        r.mounts.push({ child, prefix, middleware: [...middleware] });
        childKeys.add(child);
        info(child);
      } else {
        middleware.push(a);
      }
    }
    // Middleware that was not followed by a router applies to later routes on this router
    if (middleware.length && !flat.some((a) => resolveRouterKey(a))) {
      r.uses.push({ prefix, middleware, node: call });
    }
  };

  const routeFiles = new Set<string>();
  for (const sf of project.sourceFiles) {
    const before = routers.size;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const beforeRoutes = totalRoutes();
        handleCall(n);
        if (totalRoutes() > beforeRoutes) found = true;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
    if (found || routers.size > before) routeFiles.add(sf.fileName);
  }
  function totalRoutes(): number {
    let n = 0;
    for (const r of routers.values()) n += r.routes.length;
    return n;
  }

  // ---------------------------------------------------------------- assembly

  const out: DiscoveredRoute[] = [];
  const matches = (usePrefix: string, routePath: string): boolean => {
    if (!usePrefix || usePrefix === '/') return true;
    const a = joinPaths(usePrefix);
    const b = joinPaths(routePath);
    return b === a || b.startsWith(a + '/');
  };

  const emit = (key: ts.Symbol, prefix: string, inherited: ts.Expression[], stack: Set<ts.Symbol>): void => {
    if (stack.has(key)) return;
    stack.add(key);
    const r = routers.get(key);
    if (r) {
      for (const route of r.routes) {
        const uses = r.uses
          .filter((u) => {
            if (!matches(u.prefix, route.path)) return false;
            const sameFile = u.node.getSourceFile() === route.node.getSourceFile();
            return !sameFile || u.node.pos < route.node.pos;
          })
          .flatMap((u) => u.middleware);
        const loc = locate(route.node);
        out.push({
          method: route.method,
          path: joinPaths(prefix, route.path),
          rawPath: route.path,
          inheritedMiddleware: [...inherited, ...uses],
          handlers: route.handlers,
          node: route.node,
          file: loc.file,
          line: loc.line,
        });
      }
      for (const m of r.mounts) {
        const mountUses = r.uses.filter((u) => matches(u.prefix, m.prefix)).flatMap((u) => u.middleware);
        emit(m.child, joinPaths(prefix, m.prefix), [...inherited, ...mountUses, ...m.middleware], stack);
      }
    }
    stack.delete(key);
  };

  let roots = [...routers.keys()].filter((k) => !childKeys.has(k));
  if (roots.length === 0) roots = [...routers.keys()];
  for (const root of roots) emit(root, '', [], new Set());

  // de-duplicate (a router mounted twice at the same place, etc.)
  const seen = new Set<string>();
  const routes = out.filter((r) => {
    const k = `${r.method} ${r.path} ${r.file}:${r.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { routes, routeFiles, warnings };
}
