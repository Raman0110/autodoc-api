export type DocsProvider = 'scalar' | 'swagger' | 'redoc';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** HTML page that renders an OpenAPI document with the chosen documentation UI (loaded from a CDN). */
export function docsHtml(provider: DocsProvider, specUrl: string, title = 'API Documentation'): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`;
  switch (provider) {
    case 'swagger':
      return `${head}<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"></head><body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: '#ui', deepLinking: true });</script></body></html>`;
    case 'redoc':
      return `${head}<style>body{margin:0}</style></head><body><redoc spec-url="${esc(specUrl)}"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script></body></html>`;
    case 'scalar':
    default:
      return `${head}<style>body{margin:0}</style></head><body><script id="api-reference" data-url="${esc(specUrl)}"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.78.1"></script></body></html>`;
  }
}
