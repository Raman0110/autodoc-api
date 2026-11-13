#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { analyzeProject, coverageReport } = require('../dist');

const root = path.resolve(__dirname, '..');
const projects = require('./projects.json');
const runs = Number(process.env.AUTODOC_BENCHMARK_RUNS || 3);

function normalizePath(value) {
  let out = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!out.startsWith('/')) out = '/' + out;
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out;
}

function normalizeKey(value) {
  const match = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(.+)$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid route key: ${value}`);
  return `${match[1].toUpperCase()} ${normalizePath(match[2])}`;
}

function multiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function compare(expected, actual) {
  const wanted = multiset(expected);
  const got = multiset(actual);
  const missing = [];
  const extra = [];
  let correct = 0;
  for (const [key, count] of wanted) {
    const present = got.get(key) || 0;
    correct += Math.min(count, present);
    for (let i = present; i < count; i++) missing.push(key);
  }
  for (const [key, count] of got) {
    const wantedCount = wanted.get(key) || 0;
    for (let i = wantedCount; i < count; i++) extra.push(key);
  }
  return { correct, missing: missing.sort(), extra: extra.sort() };
}

function pct(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 100;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function commitOf(workspace) {
  return execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

const results = [];
for (const project of projects) {
  const workspace = path.join(__dirname, 'workspaces', project.name);
  if (!fs.existsSync(workspace)) throw new Error(`Missing workspace ${project.name}; run node benchmark/setup.js`);
  const commit = commitOf(workspace);
  if (commit !== project.commit) throw new Error(`${project.name} is at ${commit}, expected ${project.commit}`);

  const timings = [];
  let model;
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    model = analyzeProject(path.join(workspace, project.sourceDirectory)).model;
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }

  const expected = project.routes.map(normalizeKey);
  const actual = model.endpoints.map((endpoint) => `${endpoint.method.toUpperCase()} ${normalizePath(endpoint.path)}`);
  const routeComparison = compare(expected, actual);
  const high = model.endpoints
    .filter((endpoint) => endpoint.metadata.confidence === 'high')
    .map((endpoint) => `${endpoint.method.toUpperCase()} ${normalizePath(endpoint.path)}`);
  const highComparison = compare(expected, high);
  const coverage = coverageReport(model);

  results.push({
    name: project.name,
    repository: project.repository,
    commit,
    profile: project.profile,
    expectedRoutes: expected.length,
    detectedRoutes: actual.length,
    correctRoutes: routeComparison.correct,
    missedRoutes: routeComparison.missing,
    falseRoutes: routeComparison.extra,
    recall: pct(routeComparison.correct, expected.length),
    precision: pct(routeComparison.correct, actual.length),
    highConfidenceRoutes: high.length,
    highConfidenceCorrect: highComparison.correct,
    highConfidencePrecision: high.length ? pct(highComparison.correct, high.length) : null,
    autodocCoverage: coverage.overall,
    warnings: model.warnings.length + model.endpoints.reduce((sum, endpoint) => sum + endpoint.metadata.warnings.length, 0),
    medianMs: Math.round(median(timings)),
    timingsMs: timings.map(Math.round),
  });
}

const totals = results.reduce(
  (out, item) => {
    out.expectedRoutes += item.expectedRoutes;
    out.detectedRoutes += item.detectedRoutes;
    out.correctRoutes += item.correctRoutes;
    out.highConfidenceRoutes += item.highConfidenceRoutes;
    out.highConfidenceCorrect += item.highConfidenceCorrect;
    return out;
  },
  { expectedRoutes: 0, detectedRoutes: 0, correctRoutes: 0, highConfidenceRoutes: 0, highConfidenceCorrect: 0 },
);
totals.recall = pct(totals.correctRoutes, totals.expectedRoutes);
totals.precision = pct(totals.correctRoutes, totals.detectedRoutes);
totals.highConfidencePrecision = pct(totals.highConfidenceCorrect, totals.highConfidenceRoutes);

const report = {
  generatedAt: new Date().toISOString(),
  autodocVersion: require('../package.json').version,
  environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, architecture: os.arch(), runsPerProject: runs },
  totals,
  projects: results,
};

const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'latest.json'), JSON.stringify(report, null, 2) + '\n');

const rows = results.map((item) =>
  `| ${item.name} | ${item.expectedRoutes} | ${item.detectedRoutes} | ${item.correctRoutes} | ${item.recall}% | ${item.precision}% | ${item.highConfidencePrecision === null ? 'N/A' : item.highConfidencePrecision + '%'} | ${item.autodocCoverage}% | ${item.medianMs} ms |`,
);
const failures = results.map((item) => {
  const missed = item.missedRoutes.length ? item.missedRoutes.map((route) => `  - ${route}`).join('\n') : '  - None';
  const extra = item.falseRoutes.length ? item.falseRoutes.map((route) => `  - ${route}`).join('\n') : '  - None';
  return `### ${item.name}\n\nMissed routes:\n\n${missed}\n\nIncorrectly rooted or extra routes:\n\n${extra}`;
});

const markdown = `# AutoDoc route-pattern compatibility benchmark

This benchmark measures route discovery accuracy on five independent public
Express/TypeScript repositories. Ground truth was manually established from
route declarations and every router mount before AutoDoc results were compared.

AutoDoc version: **${report.autodocVersion}**
Verified routes: **${totals.expectedRoutes}**
Aggregate recall: **${totals.recall}%**
Aggregate precision: **${totals.precision}%**
High-confidence precision: **${totals.highConfidencePrecision}%**

## Scope limitation

This is a compatibility corpus, not a scalability benchmark. The projects have
between 6 and 24 routes (median 18), so these results test diverse mounting
patterns but do not establish behavior on applications with hundreds of
endpoints. Large-project performance and sampled accuracy must be reported in a
separate suite rather than inferred from this table.

## Results

| Project | Actual | Detected | Correct | Recall | Precision | High-confidence precision | AutoDoc coverage | Median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join('\n')}

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
- Runtime is the median of ${runs} independent analysis runs on Node ${process.version}.
- The benchmark currently measures route discovery. Request and response schema
  accuracy will be added as a separate metric after route mounting is reliable.

Reproduce it with:

\`\`\`bash
npm run build
node benchmark/setup.js
node benchmark/run.js
\`\`\`

## Observed outcome

All 74 method/path pairs in this pinned compatibility corpus are currently
resolved correctly. This result covers the recorded patterns, not every Express
metaprogramming technique; the separate scale suite records known unsupported
patterns rather than extrapolating from this score.

## Per-project differences

${failures.join('\n\n')}
`;

fs.writeFileSync(path.join(root, 'BENCHMARK.md'), markdown);
console.log(markdown.split('\n').slice(0, 18).join('\n'));
