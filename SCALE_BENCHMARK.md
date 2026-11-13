# AutoDoc large-project scale benchmark

This suite measures complete source trees from pinned public repositories. It is
separate from the route-pattern compatibility benchmark: source size and runtime
do not prove route accuracy, and detected routes are not treated as ground truth.

AutoDoc version: **0.3.1**
Node: **v22.12.0**
Runs per project: **1**

| Project | Source files | Known declarations | Detected routes | Audited recall sample | Median ms | Peak RSS MB |
|---|---:|---:|---:|---:|---:|---:|
| directus | 844 | 264 | 272 | 30/30 | 3252 | 424 |
| unleash | 1414 | 223 | 0 | not claimed | 2899 | 371 |
| etherpad | 410 | dynamic | 29 | not claimed | 4068 | 561 |

## Interpretation

- Directus is the large conventional-Express accuracy case. Its sample was
  manually source-verified and recorded in `scale-projects.json`. The sample
  measures recall only; it does not establish whole-project precision.
- Unleash deliberately remains in the report even when detection is poor. Its
  custom `this.route({...})` abstraction is an unsupported pattern, not a result
  to hide.
- Etherpad is included for scanner scale only because much of its API is
  registered dynamically; no accuracy percentage is claimed.
- Times are cold, isolated Node.js processes. Peak RSS includes TypeScript.
