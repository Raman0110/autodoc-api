const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { analyzeProject, generateOpenApi, validateOpenApi, coverageReport } = require('../dist');

const root = path.resolve(__dirname, '..');
function run(dir) {
  const { model, project } = analyzeProject(dir);
  const doc = generateOpenApi(model, project.config, project.packageJson);
  return { model, doc, report: coverageReport(model) };
}
const op = (doc, p, m) => doc.paths[p][m];
const schemaOf = (o, status) => o.responses[status].content['application/json'].schema;
const example = () => run(path.join(root, 'example/src'));
const edge = () => run(path.join(root, 'test/fixtures/edge'));

test('example app: routes, mounts and path params', () => {
  const { model, doc } = example();
  const keys = model.endpoints.map((e) => `${e.method} ${e.path}`);
  assert.deepEqual(keys, [
    'get /api/health', 'get /api/users', 'post /api/users',
    'get /api/users/:id', 'patch /api/users/:id', 'delete /api/users/:id',
  ]);
  const get = op(doc, '/api/users/{id}', 'get');
  assert.deepEqual(get.parameters.map((p) => [p.name, p.in, p.required, p.schema.type]), [['id', 'path', true, 'string']]);
  assert.deepEqual(validateOpenApi(doc), []);
  assert.equal(doc.openapi, '3.1.0');
});

test('example app: zod body, TS response types, error responses', () => {
  const { doc } = example();
  const post = op(doc, '/api/users', 'post');
  assert.equal(post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CreateUserSchema');
  const s = doc.components.schemas.CreateUserSchema;
  assert.deepEqual(s.required, ['name', 'email']);
  assert.equal(s.properties.name.minLength, 2);
  assert.equal(s.properties.email.format, 'email');
  assert.equal(s.properties.age.minimum, 18);
  assert.equal(schemaOf(post, '201').$ref, '#/components/schemas/UserDto');

  const get = op(doc, '/api/users/{id}', 'get');
  assert.equal(schemaOf(get, '200').$ref, '#/components/schemas/UserDto');
  assert.deepEqual(schemaOf(get, '404'), { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] });
  assert.deepEqual(get.security, [{ bearerAuth: [] }]);
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.ok(op(doc, '/api/users/{id}', 'delete').responses['204']);
  assert.equal(op(doc, '/api/users/{id}', 'delete').responses['204'].content, undefined);
});

test('example app: TS types become schemas (optional, nullable, enum, Date, generics)', () => {
  const { doc } = example();
  const u = doc.components.schemas.UserDto;
  assert.ok(!u.required.includes('age'));
  assert.deepEqual(u.properties.nickname.type, ['string', 'null']);
  assert.deepEqual(u.properties.createdAt, { type: 'string', format: 'date-time' });
  assert.equal(u.properties.plan.$ref, '#/components/schemas/Plan');
  assert.deepEqual(u.properties.role.enum, ['admin', 'member']);
  const list = op(doc, '/api/users', 'get');
  assert.equal(schemaOf(list, '200').$ref, '#/components/schemas/Paginated_UserDto');
  assert.equal(doc.components.schemas.Paginated_UserDto.properties.items.items.$ref, '#/components/schemas/UserDto');
});

test('example app: query params from zod validator, JSDoc and docs() metadata', () => {
  const { doc } = example();
  const list = op(doc, '/api/users', 'get');
  const page = list.parameters.find((p) => p.name === 'page');
  assert.equal(page.in, 'query');
  assert.equal(page.schema.type, 'integer');
  assert.equal(page.schema.minimum, 1);
  assert.equal(list.summary, 'List users');
  assert.match(list.description, /page of users/);
  const patch = op(doc, '/api/users/{id}', 'patch');
  assert.equal(patch.summary, 'Update a user');
  assert.equal(patch.responses['404'].description, 'No user exists with that id');
});

test('example app: unused schemas are pruned; coverage is reported', () => {
  const { doc, report } = example();
  assert.ok(!('ListUsersQuery' in doc.components.schemas));
  assert.ok(report.overall >= 80 && report.overall <= 100);
  const patch = report.endpoints.find((e) => e.endpoint.method === 'patch');
  assert.ok(patch.checks.some((c) => c.status === 'warn'));
});

test('edge fixture: factory routers, router.use auth, wrappers, class controllers', () => {
  const { model, doc } = edge();
  assert.deepEqual(validateOpenApi(doc), []);
  const keys = model.endpoints.map((e) => `${e.method} ${e.path}`);
  for (const k of ['post /v1/orders', 'post /v1/orders/admin', 'get /v1/orders/:orderId', 'delete /v1/orders/:orderId', 'get /legacy/search', 'post /legacy/items']) {
    assert.ok(keys.includes(k), `missing ${k}; got ${keys}`);
  }
  const create = op(doc, '/v1/orders', 'post');
  assert.deepEqual(create.security, [{ bearerAuth: [] }]); // router.use(requireAuth)
  assert.equal(create.requestBody.content['application/json'].schema.$ref, '#/components/schemas/OrderSchema');
  assert.deepEqual(schemaOf(create, '201').properties.status, { type: 'string' });
  const order = doc.components.schemas.OrderSchema;
  assert.deepEqual(order.required, ['items', 'kind']);
  assert.equal(order.properties.items.minItems, 1);
  assert.equal(order.properties.items.items.$ref, '#/components/schemas/Item');
  assert.equal(doc.components.schemas.Item.properties.productId.format, 'uuid');
  assert.equal(doc.components.schemas.Item.properties.quantity.exclusiveMinimum, 0);
  assert.deepEqual(order.properties.kind.enum, ['pickup', 'delivery']);
  assert.deepEqual(order.properties.note.type, ['string', 'null']);
  assert.equal(order.properties.address.properties.zip.pattern, '^\\d{5}$');
  const admin = doc.components.schemas.AdminOrderSchema;
  assert.ok(admin.properties.internalId && admin.properties.items);
  assert.deepEqual([...admin.required].sort(), ['internalId', 'items', 'kind']);
  const get = op(doc, '/v1/orders/{orderId}', 'get');
  assert.equal(schemaOf(get, '200').$ref, '#/components/schemas/OrderDto');
  assert.deepEqual(doc.components.schemas.OrderDto.properties.status.enum, ['created', 'shipped']);
  assert.ok(op(doc, '/v1/orders/{orderId}', 'delete').responses['204']);
});

test('edge fixture: untyped handlers infer query, header and body fields with lower confidence', () => {
  const { doc, model } = edge();
  const s = op(doc, '/legacy/search', 'get');
  const byName = Object.fromEntries(s.parameters.map((p) => [p.name, p]));
  assert.equal(byName.q.schema.type, 'string');
  assert.equal(byName.page.schema.default, 1);
  assert.equal(byName.limit.schema.type, 'integer');
  assert.equal(byName['x-trace-id'].in, 'header');
  const items = model.endpoints.find((e) => e.path === '/legacy/items');
  assert.equal(items.requestBody.confidence, 'low');
  assert.deepEqual(Object.keys(items.requestBody.schema.properties), ['title', 'price']);
  const ping = op(doc, '/legacy/ping', 'get');
  assert.ok(ping.responses['200'].content['text/plain']);
  assert.ok(op(doc, '/legacy/old', 'get').responses['302']);
});

test('validateOpenApi catches broken documents', () => {
  const errs = validateOpenApi({
    openapi: '3.1.0', info: { title: 'x', version: '1' },
    paths: { '/a/{id}': { get: { operationId: 'a', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } } } } } } },
  });
  assert.equal(errs.length, 2);
});

test('service fixture: body typed through the service call, cookie().json() chains', () => {
  const { doc, model } = run(path.join(root, 'test/fixtures/service'));
  const reg = op(doc, '/users/register', 'post');
  assert.equal(reg.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CreateUserPayload');
  assert.deepEqual(doc.components.schemas.CreateUserPayload.required, ['name', 'email', 'password']);
  assert.equal(schemaOf(reg, '201').properties.user.properties.id.type, 'string');
  assert.ok(reg.responses['500']);
  const login = op(doc, '/users/login', 'post');
  assert.equal(login.requestBody.content['application/json'].schema.$ref, '#/components/schemas/LoginPayload');
  assert.deepEqual(Object.keys(login.responses), ['200']);
  assert.equal(model.endpoints.find((e) => e.path === '/users/login').requestBody.source, 'typescript-call-argument');
});

test('inline fixture: schema.parse(req.body) inside the controller defines the body', () => {
  const { doc } = run(path.join(root, 'test/fixtures/inline-parse'));
  const create = op(doc, '/requests', 'post');
  assert.equal(create.requestBody.content['application/json'].schema.$ref, '#/components/schemas/createRequestSchema');
  const s = doc.components.schemas.createRequestSchema;
  assert.deepEqual(s.required, ['title']);
  assert.equal(s.properties.title.maxLength, 150);
  assert.equal(s.properties.slug.default, '');
  assert.equal(s.properties.slug.pattern, '^[a-z0-9-]*$');
  assert.deepEqual(s.properties.expiresAt, { type: 'string', format: 'date-time' });
  assert.ok(create.responses['201'] && create.responses['400']);
  const pw = op(doc, '/requests/password', 'post');
  assert.equal(pw.requestBody.content['application/json'].schema.$ref, '#/components/schemas/passwordSchema');
  assert.deepEqual(doc.components.schemas.passwordSchema.required, ['slug', 'password']);
  const del = op(doc, '/requests/{slug}', 'delete');
  assert.ok(del.responses['204'] && del.responses['401']);
});
