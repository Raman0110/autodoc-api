# Contributing to AutoDoc

Thank you for helping make generated API contracts more accurate.

## Development setup

Requires Node.js 18 or later.

```bash
git clone https://github.com/Raman0110/autodoc-api.git
cd autodoc-api
npm install
npm test
```

To exercise the CLI against the included application:

```bash
npm run example
npm run serve:example
```

## Reporting analysis problems

The most useful bug report contains a small, runnable fixture showing:

- the route registration;
- relevant controller and middleware code;
- TypeScript types or validation schemas;
- the generated operation; and
- the expected operation.

Remove secrets and proprietary application code before sharing a fixture.

## Pull requests

1. Add or update a fixture under `test/fixtures`.
2. Add a focused regression test.
3. Run `npm test`.
4. Keep changes scoped and document user-visible behavior in `CHANGELOG.md`.

New framework and validator integrations should preserve the normalized API
model rather than adding provider-specific data to the OpenAPI generator.

By contributing, you agree that your contribution is licensed under the MIT
license used by this project.
