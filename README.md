# AutoDoc (`autodoc-api`)

Zero-annotation OpenAPI 3.1 documentation for existing Node.js / TypeScript / Express APIs.

AutoDoc reads the application you already have (routes, controllers, TypeScript types, Zod schemas, middleware) and generates `openapi.json` plus interactive docs. No decorators, no Swagger comments, no duplicate schemas.

```bash
npm install -D autodoc-api
npx autodoc ./src            # (the command is `autodoc`) writes openapi.json, prints a coverage report
npx autodoc serve ./src      # http://localhost:4000/docs  (Scalar by default)
npx autodoc check ./src      # CI gate (exit 1 below --min-coverage or on an invalid spec)
```

## What it understands

| Source | What AutoDoc extracts |
| --- | --- |
| Express routers | `get/post/put/patch/delete/options/head`, `router.route().get().post()`, mounted routers (`app.use('/api', r)`), routers returned from factory functions, `export default router` across files |
| Paths | `:id` → `{id}` path parameters |
| Controllers | identifiers, inline functions, `obj.method`, class-property handlers, wrappers like `asyncHandler(fn)` |
| `Request<P, ResBody, ReqBody, ReqQuery>` | typed path params, query params and body (works for subtypes of `Request` too) |
| `Response<T>` | the success response contract; `res.status(n).json/send/end`, `sendStatus`, `redirect`, `sendFile` |
| Response expressions | `res.status(404).json({ message: "…" })` → `{ message: string }` via the type checker, with narrowing |
| TypeScript types | interfaces, aliases, enums, unions, nullable/optional, arrays, tuples, `Promise<T>`, `Record`, `Date`, utility types, generics (`Paginated<UserDto>` → `Paginated_UserDto`) |
| Zod | `validate(schema)`, `validate({ body, query, params })`, `validateQuery(...)`, named schemas as `$ref`, `extend/merge/pick/omit/partial`, constraints (`min/max/email/uuid/regex/int/...`), `optional/nullable/default`, enums, unions, discriminated unions |
| Query / header inference | `req.query.page`, `const { q } = req.query`, `Number(req.query.x)`, `req.get('x-header')` (lower confidence) |
| Auth | middleware names such as `authenticate`, `requireAuth`, `protect` (and `router.use(...)`) → `bearerAuth`, flagged *uncertain*; add exact names via config for *high* confidence |


## Confidence and coverage

Every inferred fact carries `confidence` (`high | medium | low`) and a `source`. Nothing is silently guessed: unresolved response bodies become `{}` with a warning, and each endpoint gets a coverage score and checklist:

```
API Documentation Coverage
────────────────────────────────────────────────────────────
GET /api/users/:id       94%
PATCH /api/users/:id     85%

PATCH /api/users/:id
  ✓ route detected
  ✓ request schema detected
  ⚠ response type could not be resolved
  ⚠ authentication method uncertain (inferred from middleware name)
```

The generated spec also carries `x-autodoc` (coverage, confidence, source location) on each operation.

## Optional: add what cannot be inferred

```ts
import { docs } from 'autodoc-api';

router.post('/users', validate(CreateUserSchema),
  docs(createUser, {
    summary: 'Create a new user',
    description: 'Creates an account and sends a verification email.',
    responses: { 409: 'Email already registered' },
  }));
```

`docs()` returns the handler untouched and is read statically. A JSDoc comment on the controller also works (first paragraph → summary, rest → description).

## Configuration (`autodoc.config.json`, optional)

```json
{
  "title": "Acme API",
  "version": "2.1.0",
  "servers": ["https://api.acme.com"],
  "authMiddleware": ["checkSession"],
  "docs": { "provider": "scalar" },
  "minCoverage": 85,
  "exclude": ["legacy"]
}
```

`docs.provider` is `scalar`, `swagger` or `redoc` (UI scripts load from a CDN).

## Serve the docs from your own app (`/api/docs`)

```ts
import express from 'express';
import { autodocMiddleware } from 'autodoc-api';

const app = express();
app.use(autodocMiddleware());     // docs at <your app>/docs  (analyzes ./src)
// ...your routes
```

Want a different URL? `autodocMiddleware({ path: '/api/docs' })`, or mount it yourself: `app.use('/api/docs', autodocMiddleware())`.

| URL | |
| --- | --- |
| `/docs` | Scalar (or the `provider` option) |
| `/docs/swagger` | Swagger UI |
| `/docs/redoc` | ReDoc |
| `/docs/openapi.json` | the OpenAPI document |

Options: `path` (default `/docs`), `dir` (default `./src`), `provider` (`scalar` \| `swagger` \| `redoc`), `title`, `enabled`, `live` (re-analyze on every request), `spec`, `specFile`, `tsconfig`, `config`.

- The source is analyzed once, on the first request to the docs. This needs your `src/` TypeScript files at runtime.
- **Production:** generate the spec at build time (`autodoc ./src --out openapi.json`) and use `autodocMiddleware({ specFile: './openapi.json' })`, or turn the docs off with `enabled: process.env.NODE_ENV !== 'production'`.
- It only answers its own URLs (`/docs`, `/docs/swagger`, ...); every other request passes through to your routes.
- If you use `helmet`, allow the CDN the UI loads from (`cdn.jsdelivr.net`) in your Content-Security-Policy for these routes.

## Programmatic use

```ts
import { analyzeProject, generateOpenApi, validateOpenApi, coverageReport } from 'autodoc-api';

const { model, project } = analyzeProject('./src');
const spec = generateOpenApi(model, project.config, project.packageJson);
console.log(validateOpenApi(spec), coverageReport(model).overall);
```

## Architecture

```
src/
  project.ts        scanner: tsconfig, files, program, config
  express/routes.ts route discovery + router mounting  → DiscoveredRoute[]
  express/controller.ts  middleware / controller analysis → ApiEndpoint
  typeSchema.ts     TypeScript type → JSON schema (compiler API)
  validators/       ValidatorAdapter interface + ZodAdapter
  model.ts          normalized API model (independent of Express and OpenAPI)
  openapi.ts        ApiModel → OpenAPI 3.1 (+ structural validation)
  coverage.ts       coverage scoring
  ui.ts, cli.ts     docs UI + CLI (scan | generate | serve | check)
```

New validators implement `ValidatorAdapter` (`matches` + `toSchema`); pass them with `analyzeProject(dir, { adapters })`.

## Known limits

- Static analysis only: handlers that build responses dynamically (`res.json(await build())` typed `any`) yield unknown bodies, reported as warnings.
- Only Zod is implemented from the validator list. Joi, Valibot, Yup, TypeBox and express-validator are the next adapters (the interface is in place).
- `z.lazy`, `z.custom` and `.transform()` output types are not modeled (input shape is documented).
- Route paths must be statically evaluable; regex paths and fully dynamic paths are skipped with a warning.
- The OpenAPI validator checks structure and `$ref` integrity, not the full OpenAPI JSON-Schema.
- Not yet built: runtime recording, test-based learning, `diff` / breaking-change detection, SDK generation, Fastify / Koa / Hono.

## Develop

```bash
npm install
npm test            # builds, then runs unit + CLI tests
npm run example     # analyze ./example → example/openapi.json
npm run serve:example
```
