#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const projects = require('./projects.json');

const workspaces = path.join(__dirname, 'workspaces');
fs.mkdirSync(workspaces, { recursive: true });

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
}

for (const project of projects) {
  const workspace = path.join(workspaces, project.name);
  if (!fs.existsSync(path.join(workspace, '.git'))) {
    run('git', ['clone', project.repository, workspace], __dirname);
  }
  run('git', ['fetch', '--depth', '1', 'origin', project.commit], workspace);
  run('git', ['checkout', '--detach', project.commit], workspace);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, project.install, workspace);
}
