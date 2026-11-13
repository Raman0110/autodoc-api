#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const projects = require('./scale-projects.json');
const pkg = require('../package.json');

const runs = Math.max(1, Number(process.env.AUTODOC_SCALE_RUNS || 1));
const root = path.resolve(__dirname, '..');
const worker = path.join(__dirname, 'scale-worker.js');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const results = [];
for (const project of projects) {
  const source = path.join(__dirname, 'workspaces', project.name, project.sourceDirectory);
  if (!fs.existsSync(source)) throw new Error(`Missing ${source}. Run npm run benchmark:scale:setup first.`);
  const measurements = [];
  for (let run = 0; run < runs; run += 1) {
    const child = spawnSync(process.execPath, [worker, source], {
      cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(child.stderr || `${project.name} worker failed`);
    measurements.push(JSON.parse(child.stdout));
  }
  const representative = measurements[0];
  const detected = new Set(representative.routes);
  const sampleCorrect = project.sampleRoutes.filter((route) => detected.has(route));
  results.push({
    name: project.name,
    repository: project.repository,
    commit: project.commit,
    profile: project.profile,
    declarationPolicy: project.declarationPolicy,
    sourceFiles: representative.sourceFiles,
    knownRouteDeclarations: project.knownRouteDeclarations,
    detectedRoutes: representative.detectedRoutes,
    sampleSize: project.sampleRoutes.length,
    sampleCorrect: sampleCorrect.length,
    sampleMisses: project.sampleRoutes.filter((route) => !detected.has(route)),
    warnings: representative.warnings,
    medianMs: median(measurements.map((item) => item.elapsedMs)),
    peakRssMb: Math.max(...measurements.map((item) => item.peakRssMb)),
    timingsMs: measurements.map((item) => item.elapsedMs),
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  autodocVersion: pkg.version,
  environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, architecture: os.arch(), runsPerProject: runs },
  policy: 'Performance uses complete source trees. Accuracy is claimed only for manually recorded samples.',
  projects: results,
};

const rows = results.map((item) =>
  `| ${item.name} | ${item.sourceFiles} | ${item.knownRouteDeclarations ?? 'dynamic'} | ${item.detectedRoutes} | ${item.sampleSize ? `${item.sampleCorrect}/${item.sampleSize}` : 'not claimed'} | ${item.medianMs} | ${item.peakRssMb} |`,
);
const markdown = `# AutoDoc large-project scale benchmark

This suite measures complete source trees from pinned public repositories. It is
separate from the route-pattern compatibility benchmark: source size and runtime
do not prove route accuracy, and detected routes are not treated as ground truth.

AutoDoc version: **${pkg.version}**
Node: **${process.version}**
Runs per project: **${runs}**

| Project | Source files | Known declarations | Detected routes | Audited recall sample | Median ms | Peak RSS MB |
|---|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

## Interpretation

- Directus is the large conventional-Express accuracy case. Its sample was
  manually source-verified and recorded in \`scale-projects.json\`. The sample
  measures recall only; it does not establish whole-project precision.
- Unleash deliberately remains in the report even when detection is poor. Its
  custom \`this.route({...})\` abstraction is an unsupported pattern, not a result
  to hide.
- Etherpad is included for scanner scale only because much of its API is
  registered dynamically; no accuracy percentage is claimed.
- Times are cold, isolated Node.js processes. Peak RSS includes TypeScript.
`;

fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'scale-latest.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'SCALE_BENCHMARK.md'), markdown);
process.stdout.write(markdown);
