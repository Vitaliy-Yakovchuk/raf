import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';

export function forcedCloseStandPrefix(environment = process.env) {
  return join(environment.TMPDIR || '/srv/dev', 'mrh54-');
}

export function prepareForcedCloseMain(root, projects) {
  const route = projects.projects.raf.branchPaths.main;
  assert.equal(projects.projects.raf.path, route);
  const main = resolve(root, route);
  assert.ok(main.startsWith(resolve(root) + sep));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete env[key];
  const git = args => {
    const result = spawnSync('git', args, { env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '--initial-branch=main', main]);
  for (const [key, value] of Object.entries({ 'user.name': 'Isolated forced-close QA', 'user.email': 'qa@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null' })) git(['-C', main, 'config', key, value]);
  return main;
}

export function configureForcedCloseStand(raf, originalRaf) {
  raf.costProfile = originalRaf.costProfile;
  raf.commandTiming = originalRaf.commandTiming;
  raf.runnerProtocols[0].timeouts = originalRaf.runnerProtocols.find(row => row.runner === 'codex').timeouts;
  return raf;
}
