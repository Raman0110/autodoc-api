import * as fs from 'fs';
import * as path from 'path';
import { analyzeProject } from './analyze';
import { coverageReport } from './coverage';
import { generateOpenApi, type OpenApiDocument } from './openapi';
import type { AutoDocConfig } from './project';
import { docsHtml, type DocsProvider } from './ui';

/** Minimal request/response shapes so this works with Express, Connect and plain http. */
interface Req {
  method?: string;
  url?: string;
  path?: string;
  baseUrl?: string;
}
interface Res {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}
type Next = (err?: unknown) => void;

export interface DocsMiddlewareOptions {
  /** Source folder to analyze (default "./src", relative to process.cwd()). */
  dir?: string;
  /** Serve this ready-made OpenAPI document instead of analyzing the source. */
  spec?: OpenApiDocument;
  /** Serve an openapi.json generated earlier (use in production where src/ is not deployed). */
  specFile?: string;
  /**
   * URL path the docs live at when the middleware is mounted without a path,
   * i.e. `app.use(autodocMiddleware())` (default "/docs"). Ignored if you mount it
   * at a path yourself: `app.use('/api/docs', autodocMiddleware())`.
   */
  path?: string;
  /** UI served at the docs path itself (default "scalar"). */
  provider?: DocsProvider;
  title?: string;
  tsconfig?: string;
  config?: AutoDocConfig;
  /** Set false to turn the docs off, e.g. `enabled: process.env.NODE_ENV !== "production"`. */
  enabled?: boolean;
  /** Re-analyze on every request (development). Default false: analyze once, on first request. */
  live?: boolean;
}

const PAGES: Record<string, DocsProvider> = { '/scalar': 'scalar', '/swagger': 'swagger', '/redoc': 'redoc' };

/**
 * Express middleware that serves interactive API docs generated from your source.
 *
 *   app.use(autodocMiddleware());                  // docs at <your app>/docs
 *   app.use('/api/docs', autodocMiddleware());     // or at any path you mount it
 *   // /docs               Scalar (or `provider`)
 *   // /docs/swagger       Swagger UI     /docs/redoc   ReDoc
 *   // /docs/openapi.json  the OpenAPI document
 */
export function autodocMiddleware(options: DocsMiddlewareOptions = {}) {
  let cache: { doc: OpenApiDocument; coverage?: number } | undefined;

  const load = (): { doc: OpenApiDocument; coverage?: number } => {
    if (cache && !options.live) return cache;
    if (options.spec) return (cache = { doc: options.spec });
    if (options.specFile) {
      const doc = JSON.parse(fs.readFileSync(path.resolve(options.specFile), 'utf8')) as OpenApiDocument;
      return (cache = { doc });
    }
    const { model, project } = analyzeProject(options.dir ?? './src', {
      tsconfig: options.tsconfig,
      config: options.config,
    });
    const doc = generateOpenApi(model, project.config, project.packageJson);
    return (cache = { doc, coverage: coverageReport(model).overall });
  };

  return function autodocDocs(req: Req, res: Res, next: Next): void {
    if (options.enabled === false) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Mounted at a path (app.use('/docs', mw)): Express gives us baseUrl + path.
    // Mounted at the root (app.use(mw)): serve under options.path, default "/docs".
    const rawPath = (req.path ?? (req.url ?? '/').split('?')[0]) as string;
    let base = (req.baseUrl ?? '').replace(/\/+$/, '');
    let rest = rawPath;
    if (!base) {
      base = ('/' + (options.path ?? '/docs').replace(/^\/+|\/+$/g, '')).replace(/\/+$/, '');
      if (base === '') return next(); // path "/" would shadow the whole app
      if (rawPath !== base && !rawPath.startsWith(base + '/')) return next();
      rest = rawPath.slice(base.length);
    }
    const sub = (rest.replace(/\/+$/, '') || '/') as string;
    const known = sub === '/' || sub === '/openapi.json' || sub === '/coverage.json' || sub in PAGES;
    if (!known) return next();

    const send = (status: number, type: string, body: string): void => {
      res.statusCode = status;
      res.setHeader('content-type', type);
      res.setHeader('cache-control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    try {
      const { doc, coverage } = load();
      if (sub === '/openapi.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(doc));
      if (sub === '/coverage.json') {
        return coverage === undefined
          ? send(404, 'text/plain', 'Coverage is only available when the source is analyzed')
          : send(200, 'application/json', JSON.stringify({ overall: coverage }));
      }
      const provider = PAGES[sub] ?? options.provider ?? 'scalar';
      const title = options.title ?? `${String(doc.info?.title ?? 'API')} docs`;
      return send(200, 'text/html; charset=utf-8', docsHtml(provider, `${base}/openapi.json`, title));
    } catch (e) {
      send(500, 'text/plain', `AutoDoc failed to build the documentation: ${(e as Error).message}`);
    }
  };
}
