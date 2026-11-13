# Real-world benchmark

The benchmark compares AutoDoc against manually audited route ground truth from
five independent Express/TypeScript repositories.

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
