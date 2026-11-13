# AutoDoc route-pattern compatibility benchmark

This benchmark measures route discovery accuracy on five independent public
Express/TypeScript repositories. Ground truth was manually established from
route declarations and every router mount before AutoDoc results were compared.

AutoDoc version: **0.3.1**  
Verified routes: **74**  
Aggregate recall: **25.7%**  
Aggregate precision: **25.7%**  
High-confidence precision: **0%**

## Scope limitation

This is a compatibility corpus, not a scalability benchmark. The projects have
between 6 and 24 routes (median 18), so these results test diverse mounting
patterns but do not establish behavior on applications with hundreds of
endpoints. Large-project performance and sampled accuracy must be reported in a
separate suite rather than inferred from this table.

## Results

| Project | Actual | Detected | Correct | Recall | Precision | High-confidence precision | AutoDoc coverage | Median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dahkenangnon-mongoose | 24 | 24 | 0 | 0% | 0% | 0% | 81% | 1033 ms |
| diego-express | 7 | 7 | 0 | 0% | 0% | — | 50% | 507 ms |
| samved-prisma | 6 | 6 | 0 | 0% | 0% | — | 87% | 670 ms |
| thailoc-express | 19 | 19 | 19 | 100% | 100% | — | 61% | 1017 ms |
| vincent-prisma | 18 | 18 | 0 | 0% | 0% | 0% | 67% | 547 ms |

AutoDoc coverage is shown only for comparison. It is an internal completeness
score and is not used as an accuracy metric.

## Methodology

- Every repository is pinned to the commit recorded in
  [benchmark/projects.json](benchmark/projects.json).
- Dependencies are installed with lifecycle scripts disabled.
- A route is correct only when both its HTTP method and fully mounted path match.
- Paths are normalized for duplicate and trailing slashes.
- Counts use multiset comparison so lost prefixes cannot collapse distinct
  routes into one apparent match.
- Runtime is the median of 3 independent analysis runs on Node v22.12.0.
- The benchmark currently measures route discovery. Request and response schema
  accuracy will be added as a separate metric after route mounting is reliable.

Reproduce it with:

```bash
npm run build
node benchmark/setup.js
node benchmark/run.js
```

## Observed failure pattern

Literal nested mounts work well, but class-based, named-export, path-alias and
configuration-driven router mounts often lose their prefixes. AutoDoc may find
the underlying route call while reporting an incorrect root-level path. This is
why the benchmark's external accuracy can be much lower than AutoDoc's internal
coverage score.

## Per-project differences

### dahkenangnon-mongoose

Missed routes:

  - DELETE /v1/messages/:id
  - DELETE /v1/messages/many
  - DELETE /v1/users/:id
  - DELETE /v1/users/many
  - GET /v1/messages
  - GET /v1/messages/:id
  - GET /v1/users
  - GET /v1/users/:id
  - PATCH /v1/messages/:id
  - PATCH /v1/messages/many
  - PATCH /v1/users/:id
  - PATCH /v1/users/many
  - POST /v1/auth/blacklist-token
  - POST /v1/auth/forgot-password
  - POST /v1/auth/login
  - POST /v1/auth/logout
  - POST /v1/auth/refresh-tokens
  - POST /v1/auth/register
  - POST /v1/auth/reset-password
  - POST /v1/auth/verify-email
  - POST /v1/messages
  - POST /v1/messages/many
  - POST /v1/users
  - POST /v1/users/many

Incorrectly rooted or extra routes:

  - DELETE /:id
  - DELETE /:id
  - DELETE /many
  - DELETE /many
  - GET /
  - GET /
  - GET /:id
  - GET /:id
  - PATCH /:id
  - PATCH /:id
  - PATCH /many
  - PATCH /many
  - POST /
  - POST /
  - POST /blacklist-token
  - POST /forgot-password
  - POST /login
  - POST /logout
  - POST /many
  - POST /many
  - POST /refresh-tokens
  - POST /register
  - POST /reset-password
  - POST /verify-email

### diego-express

Missed routes:

  - DELETE /api/v1/notes/:id
  - GET /api/v1/health/live
  - GET /api/v1/health/ready
  - GET /api/v1/notes
  - GET /api/v1/notes/:id
  - POST /api/v1/notes
  - PUT /api/v1/notes/:id

Incorrectly rooted or extra routes:

  - DELETE /:id
  - GET /
  - GET /:id
  - GET /live
  - GET /ready
  - POST /
  - PUT /:id

### samved-prisma

Missed routes:

  - GET /users/all
  - GET /users/test
  - POST /auth/login
  - POST /auth/logout
  - POST /auth/refresh
  - POST /auth/register

Incorrectly rooted or extra routes:

  - GET /all
  - GET /test
  - POST /login
  - POST /logout
  - POST /refresh
  - POST /register

### thailoc-express

Missed routes:

  - None

Incorrectly rooted or extra routes:

  - None

### vincent-prisma

Missed routes:

  - DELETE /api/client/user/me
  - GET /api
  - GET /api/admin/users
  - GET /api/client/auth/logout
  - GET /api/client/auth/register/confirmation
  - GET /api/client/user/me
  - GET /api/docs
  - GET /api/info
  - GET /api/logs
  - GET /api/templates/email/email-verify
  - GET /api/templates/email/password-request
  - GET /api/templates/email/password-reseted
  - GET /api/templates/email/welcome-user
  - PATCH /api/client/user/me
  - POST /api/client/auth/forgotpassword/request
  - POST /api/client/auth/forgotpassword/reset
  - POST /api/client/auth/login
  - POST /api/client/auth/register

Incorrectly rooted or extra routes:

  - DELETE /
  - GET /
  - GET /
  - GET /
  - GET /
  - GET /
  - GET /
  - GET /email-verify
  - GET /logout
  - GET /password-request
  - GET /password-reseted
  - GET /register/confirmation
  - GET /welcome-user
  - PATCH /
  - POST /forgotpassword/request
  - POST /forgotpassword/reset
  - POST /login
  - POST /register
