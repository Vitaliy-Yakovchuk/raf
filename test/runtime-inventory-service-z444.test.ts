import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, timeoutMs } from './hotfix-fixture.ts';

test('Z.444 service starts from a generation with a changed library consumer', async t => {
  const f = await fixture(t);
  appendFileSync(join(f.main, 'src/test-run-etchly-integration.ts'), '\nexport const z444NewLibraryConsumer = true;\n');
  const started = spawnSync(process.execPath, ['--import', f.osHomePreload, join(f.main, 'bin/raf.ts'), 'service', 'start'], {
    cwd: f.main, env: f.environment, encoding: 'utf8', timeout: timeoutMs,
  });
  assert.ifError(started.error);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const status = JSON.parse(started.stdout);
  assert.equal(status.state, 'ready');
  assert.ok(status.pid > 0);
  assert.match(status.mainPath, /\/raf-hotfix\/generations\/[^/]+\/raf-main$/);
  assert.match(readFileSync(join(status.mainPath, 'src/test-run-etchly-integration.ts'), 'utf8'), /z444NewLibraryConsumer/);
  assert.match(started.stderr, /Runtime inventory warning: unproved library API boundary src\/test-run-etchly-integration\.ts/);
  const activeMain = realpathSync(f.main);
  const commonPointer = readFileSync(join(activeMain, '.git'), 'utf8').trim().replace(/^gitdir: /, '');
  t.diagnostic(JSON.stringify({ state: status.state, pid: status.pid, activeMain, commonPointer }));
  const observed = f.cli(f.main, ['service', 'status']);
  assert.equal(observed.code, 0, observed.stderr);
  assert.equal(JSON.parse(observed.stdout).pid, status.pid);
  const stopped = f.cli(f.main, ['service', 'stop']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).state, 'stopped');
});
