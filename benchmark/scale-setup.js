#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const projects = require('./scale-projects.json');

const workspaces = path.join(__dirname, 'workspaces');
fs.mkdirSync(workspaces, { recursive: true });

function run(args, cwd) {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed with exit ${result.status}`);
}

for (const project of projects) {
  const workspace = path.join(workspaces, project.name);
  if (!fs.existsSync(path.join(workspace, '.git'))) {
    run(['clone', '--filter=blob:none', '--no-checkout', project.repository, workspace], __dirname);
  }
  run(['fetch', '--depth', '1', 'origin', project.commit], workspace);
  run(['sparse-checkout', 'init', '--cone'], workspace);
  run(['sparse-checkout', 'set', ...project.sparsePaths], workspace);
  run(['checkout', '--detach', project.commit], workspace);
}
