#!/usr/bin/env node
const { performance } = require('node:perf_hooks');
const { analyzeProject } = require('../dist');

const source = process.argv[2];
if (!source) throw new Error('Usage: node scale-worker.js <source-directory>');

const started = performance.now();
const { model, project } = analyzeProject(source);
process.stdout.write(JSON.stringify({
  sourceFiles: project.sourceFiles.length,
  detectedRoutes: model.endpoints.length,
  routes: model.endpoints.map((endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`),
  warnings: model.warnings.length,
  elapsedMs: Math.round(performance.now() - started),
  peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
}));
