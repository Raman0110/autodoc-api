# Route-pattern compatibility benchmark

The benchmark compares AutoDoc against manually audited route ground truth from
five independent Express/TypeScript repositories.

The corpus intentionally makes complete manual ground truth practical, but its
projects contain only 6–24 routes. It measures compatibility, not large-project
scalability. A separate scale suite is required for applications with hundreds
of endpoints.

## Reproduce

```bash
npm run build
node benchmark/setup.js
node benchmark/run.js
```

`setup.js` checks out the exact recorded commits and installs dependencies with
package lifecycle scripts disabled. The external repositories live under the
ignored `benchmark/workspaces` directory and are never included in AutoDoc's npm
package.

Set `AUTODOC_BENCHMARK_RUNS=1` for a quick run. The published result uses three
runs per project and reports the median.

## Ground-truth policy

- Audit route declarations and all mount sites before viewing generated output.
- Record complete method/path pairs in `projects.json`.
- Treat configured default paths as ground truth and record the relevant source
  files in `groundTruthFiles`.
- Count documentation and operational endpoints when they are explicit Express
  routes; do not count generic middleware or static-file mounts.
- Pin every repository commit.
- Never change expected routes merely to improve AutoDoc's score.

The current benchmark measures route discovery. Schema accuracy requires a
separate property/status ground-truth dataset and must not be inferred from
AutoDoc's own coverage score.

## Large-project scale suite

The compatibility projects are intentionally small enough to audit completely.
For scanner behavior on substantially larger applications, run:

```bash
npm run benchmark:scale:setup
npm run benchmark:scale
```

This separate suite pins Directus, Unleash, and Etherpad commits and reports
cold-process runtime, peak memory, and detected routes. It only makes accuracy
claims for routes manually recorded in `scale-projects.json`; a detected count
is never treated as ground truth.
