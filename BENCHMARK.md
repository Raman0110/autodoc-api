# AutoDoc route-pattern compatibility benchmark

This benchmark measures route discovery accuracy on five independent public
Express/TypeScript repositories. Ground truth was manually established from
route declarations and every router mount before AutoDoc results were compared.

AutoDoc version: **0.3.1**
Verified routes: **74**
Aggregate recall: **100%**
Aggregate precision: **100%**
High-confidence precision: **100%**

## Scope limitation

This is a compatibility corpus, not a scalability benchmark. The projects have
between 6 and 24 routes (median 18), so these results test diverse mounting
patterns but do not establish behavior on applications with hundreds of
endpoints. Large-project performance and sampled accuracy must be reported in a
separate suite rather than inferred from this table.

## Results

| Project | Actual | Detected | Correct | Recall | Precision | High-confidence precision | AutoDoc coverage | Median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dahkenangnon-mongoose | 24 | 24 | 24 | 100% | 100% | 100% | 81% | 1049 ms |
| diego-express | 7 | 7 | 7 | 100% | 100% | N/A | 100% | 496 ms |
| samved-prisma | 6 | 6 | 6 | 100% | 100% | N/A | 92% | 647 ms |
| thailoc-express | 19 | 19 | 19 | 100% | 100% | N/A | 61% | 1001 ms |
| vincent-prisma | 18 | 18 | 18 | 100% | 100% | 100% | 67% | 515 ms |

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

## Observed outcome

All 74 method/path pairs in this pinned compatibility corpus are currently
resolved correctly. This result covers the recorded patterns, not every Express
metaprogramming technique; the separate scale suite records known unsupported
patterns rather than extrapolating from this score.

## Per-project differences

### dahkenangnon-mongoose

Missed routes:

  - None

Incorrectly rooted or extra routes:

  - None

### diego-express

Missed routes:

  - None

Incorrectly rooted or extra routes:

  - None

### samved-prisma

Missed routes:

  - None

Incorrectly rooted or extra routes:

  - None

### thailoc-express

Missed routes:

  - None

Incorrectly rooted or extra routes:

  - None

### vincent-prisma

Missed routes:

  - None

Incorrectly rooted or extra routes:

  - None
