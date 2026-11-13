const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { autodocMiddleware } = require('../dist');

const example = path.resolve(__dirname, '..', 'example', 'src');
const get = (port, p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

function start(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

test('middleware serves docs UIs and the spec under the mount path', async () => {
  const app = express();
  app.get('/ping', (_req, res) => res.send('pong'));
  app.use('/api/docs', autodocMiddleware({ dir: example }));
  const { server, port } = await start(app);
  try {
    const main = await get(port, '/api/docs');
    assert.equal(main.status, 200);
    assert.match(main.body, /@scalar\/api-reference/);
    assert.match(main.body, /data-url="\/api\/docs\/openapi\.json"/);
    assert.match((await get(port, '/api/docs/swagger')).body, /swagger-ui/);
    assert.match((await get(port, '/api/docs/redoc/')).body, /redoc/);
    const spec = JSON.parse((await get(port, '/api/docs/openapi.json')).body);
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/api/users']);
    assert.match((await get(port, '/api/docs/openapi.yaml')).body, /^openapi: 3\.1\.0/m);
    assert.equal(JSON.parse((await get(port, '/api/docs/coverage.json')).body).overall > 50, true);
    assert.equal((await get(port, '/ping')).body, 'pong'); // other routes untouched
    assert.equal((await get(port, '/api/docs/nope')).status, 404);
  } finally {
    server.close();
  }
});

test('middleware: provider option, enabled:false and specFile', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-')), 'openapi.json');
  fs.writeFileSync(file, JSON.stringify({ openapi: '3.1.0', info: { title: 'Prebuilt', version: '1' }, paths: {} }));

  const app = express();
  app.use('/docs', autodocMiddleware({ specFile: file, provider: 'swagger' }));
  app.use('/off', autodocMiddleware({ specFile: file, enabled: false }));
  const { server, port } = await start(app);
  try {
    const page = await get(port, '/docs');
    assert.match(page.body, /swagger-ui/);
    assert.match(page.body, /Prebuilt docs/);
    assert.equal(JSON.parse((await get(port, '/docs/openapi.json')).body).info.title, 'Prebuilt');
    assert.equal((await get(port, '/off')).status, 404);
  } finally {
    server.close();
  }
});

test('middleware mounted without a path serves /docs by default and honours options.path', async () => {
  const app = express();
  app.get('/ping', (_req, res) => res.send('pong'));
  app.use(autodocMiddleware({ dir: example }));
  app.use(autodocMiddleware({ dir: example, path: 'internal/api-docs', provider: 'redoc' }));
  const { server, port } = await start(app);
  try {
    const main = await get(port, '/docs');
    assert.equal(main.status, 200);
    assert.match(main.body, /data-url="\/docs\/openapi\.json"/);
    assert.match((await get(port, '/docs/swagger')).body, /swagger-ui/);
    assert.equal(JSON.parse((await get(port, '/docs/openapi.json')).body).openapi, '3.1.0');
    const custom = await get(port, '/internal/api-docs');
    assert.match(custom.body, /redoc/);
    assert.match(custom.body, /\/internal\/api-docs\/openapi\.json/);
    assert.equal((await get(port, '/ping')).body, 'pong');
    assert.equal((await get(port, '/documents')).status, 404); // '/docs' must not prefix-match '/documents'
  } finally {
    server.close();
  }
});
