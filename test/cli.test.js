const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'dist', 'cli.js');
const example = path.join(root, 'example', 'src');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

const get = (port, p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });

test('check passes above the threshold and fails below it', () => {
  assert.equal(run('check', example, '--min-coverage', '80').status, 0);
  const fail = run('check', example, '--min-coverage', '100');
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /below the required 100%/);
});

test('scan writes nothing, generate writes the spec', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-')), 'openapi.json');
  const scan = run('scan', example, '--out', out);
  assert.equal(scan.status, 0);
  assert.ok(!fs.existsSync(out));
  const gen = run(example, '--out', out);
  assert.equal(gen.status, 0);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(Object.keys(doc.paths).length, 3);
});

test('missing directory is a clear error', () => {
  const r = run('./does-not-exist');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Directory not found/);
});

test('serve exposes /docs and /openapi.json', async () => {
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [cli, 'serve', example, '--port', String(port), '--no-watch'], { cwd: root });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 20000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('/docs')) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on('exit', (c) => reject(new Error('server exited ' + c)));
    });
    const docs = await get(port, '/docs');
    assert.equal(docs.status, 200);
    assert.match(docs.body, /@scalar\/api-reference/);
    const spec = await get(port, '/openapi.json');
    assert.equal(JSON.parse(spec.body).openapi, '3.1.0');
    assert.equal((await get(port, '/')).status, 302);
  } finally {
    child.removeAllListeners('exit');
    child.kill();
  }
});
