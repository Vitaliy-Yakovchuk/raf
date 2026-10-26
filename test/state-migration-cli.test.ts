import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveStateContext, stateContextEnvironment } from '../src/state-migration-guard.ts';
import { STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { command, copyMain7, files, fixture, logical, nodeProcess, seedMain7, seedVersion } from './state-migration-fixture.ts';

test('an explicit empty QA HOME works and a separate child CLI stays on the QA state and tmux socket', async t => {
  const f = fixture(t);
  seedMain7(f);
  const before = files(f.statePath);
  const context = resolveStateContext(f.request());
  const env = stateContextEnvironment(context, f.env);
  const first = command(f, ['runner', 'list'], { env });
  assert.equal(first.error, undefined);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(existsSync(f.qaStatePath), true);
  const program = `import { resolveStateContext } from ${JSON.stringify(new URL('../src/state-migration-guard.ts', import.meta.url).href)};
import { openStateStore } from ${JSON.stringify(new URL('../src/state-store.ts', import.meta.url).href)};
import os from 'node:os';
const context = resolveStateContext({ orchestratorRoot: process.argv[1], modulePath: process.argv[2], homeDirectory: os.homedir(), operatingSystemHome: os.userInfo().homedir, environment: process.env, entryPoint: 'worker' });
openStateStore(context.statePath, { context }).close();
console.log(JSON.stringify(context));`;
  const child = await nodeProcess(f, program, [f.root, join(f.developTree, 'src', 'production-runtime.ts')], env);
  assert.equal(child.code, 0, child.stderr);
  const selected = JSON.parse(child.stdout.trim());
  assert.equal(selected.homeDirectory, f.qaHome);
  assert.equal(selected.statePath, f.qaStatePath);
  assert.equal(selected.tmpRoot, context.tmpRoot);
  assert.equal(selected.tmuxSocketPath, context.tmuxSocketPath);
  assert.deepEqual(files(f.statePath), before);
});

for (const argv of [['agent', 'ps'], ['runner', 'list'], ['runner', 'limits', '--runners', 'codex']]) {
  test(`allowed QA ${argv.join(' ')} on older state requires explicit transfer even with a global environment flag`, t => {
    const f = fixture(t);
    seedMain7(f, f.qaStatePath);
    const before = files(f.qaStatePath);
    const result = command(f, argv, { env: { HOME: f.qaHome, RAF_QA_HOME: f.qaHome, ALLOW_MIGRATIONS: '1' } });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /STATE_MIGRATION_REQUIRED/);
    assert.match(output, /7/);
    assert.ok(output.includes(`explicit migration to ${STATE_SCHEMA_VERSION} required`));
    assert.deepEqual(files(f.qaStatePath), before);
    assert.equal(existsSync(f.statePath), false);
  });
}

test('maintenance CLI is explicit, path-bound and does not grant migration to subsequent ordinary commands', async t => {
  const f = fixture(t);
  seedMain7(f);
  await copyMain7(f);
  const source = files(f.statePath);
  const before = logical(f.qaStatePath);
  const backupPath = join(f.root, 'maintenance-backup.sqlite');
  const program = (clients: 'unknown' | 'quiescent') => `import assert from 'node:assert/strict';
import { runStateMigration } from ${JSON.stringify(pathToFileURL(join(f.developTree, 'src', 'state-migration.ts')).href)};
let inspections = 0;
process.exitCode = await runStateMigration(process.argv.slice(1), {
  async inspectClients(path) {
    assert.equal(path, ${JSON.stringify(f.qaStatePath)});
    inspections++;
    return ${JSON.stringify(clients)};
  }
});
assert.equal(inspections, ${clients === 'unknown' ? 1 : 2});`;
  const env = { HOME: f.qaHome, RAF_QA_HOME: f.qaHome };
  const args = ['--state', f.qaStatePath, '--from', '7', '--to', String(STATE_SCHEMA_VERSION), '--backup', backupPath];
  const unverified = await nodeProcess(f, program('unknown'), ['--', ...args], env);
  assert.equal(unverified.code, 1, unverified.stderr);
  assert.equal(JSON.parse(unverified.stderr.trim()).code, 'STATE_MIGRATION_CONFLICT');
  assert.match(unverified.stderr, /unknown client/);
  assert.equal(existsSync(backupPath), false);
  assert.deepEqual(logical(f.qaStatePath), before);
  assert.deepEqual(files(f.statePath), source);
  const result = await nodeProcess(f, program('quiescent'), ['--', ...args], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(logical(backupPath), before);
  assert.equal(logical(f.qaStatePath).version, STATE_SCHEMA_VERSION);
  assert.deepEqual(logical(f.qaStatePath).rows, before.rows);
  assert.ok(result.stdout.includes(f.qaStatePath));
  assert.match(result.stdout, /7/);
  assert.equal(JSON.parse(result.stdout).toVersion, STATE_SCHEMA_VERSION);
  assert.ok(!result.stdout.includes('preserve-fixture-payload'));
  const next = command(f, ['runner', 'list'], { env });
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.deepEqual(files(f.statePath), source);
});

for (const version of [0, STATE_SCHEMA_VERSION + 1, STATE_SCHEMA_VERSION + 1000]) {
  test(`public QA CLI refuses nonempty unknown schema ${version} without downgrade`, t => {
    const f = fixture(t);
    seedVersion(f, version, f.qaStatePath);
    const before = files(f.qaStatePath);
    const result = command(f, ['runner', 'list'], { env: { HOME: f.qaHome, RAF_QA_HOME: f.qaHome } });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /STATE_SCHEMA_UNSUPPORTED/);
    assert.deepEqual(files(f.qaStatePath), before);
  });
}
