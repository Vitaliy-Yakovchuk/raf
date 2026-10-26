import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { resolveStateContext, stateContextEnvironment } from '../src/state-migration-guard.ts';
import type { StateContext, StateEntryPoint } from '../src/state-migration-guard.ts';
import { migrateState } from '../src/state-migration.ts';
import { compatibleMainCanOpen, directoryFiles, files, fixture, logical, nodeProcess, quietWal, seedMain7, seedMain10, seedVersion } from './state-migration-fixture.ts';

function errorCode(code: string): (error: unknown) => boolean {
  return error => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

function qaContext(f: ReturnType<typeof fixture>): StateContext {
  return resolveStateContext(f.request());
}

test('develop CLI on the working account HOME warns and resolves working state without filesystem initialization', t => {
  const f = fixture(t);
  const before = directoryFiles(f.workingHome);
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => { written.push(String(chunk)); return true; });
  const context = resolveStateContext(f.request({ entryPoint: 'cli', homeDirectory: f.workingHome, environment: { HOME: f.workingHome } }));
  t.mock.restoreAll();
  assert.equal(context.mode, 'production');
  assert.equal(context.statePath, f.statePath);
  assert.match(written.join(''), /STATE_CONTEXT_WARNING/);
  assert.deepEqual(directoryFiles(f.workingHome), before);
  assert.equal(existsSync(f.statePath), false);
});

test('explicit QA HOME selects separate stand state', t => {
  const f = fixture(t);
  const context = qaContext(f);
  assert.equal(context.mode, 'qa');
  assert.equal(context.codeRoot, f.developTree);
  assert.equal(context.homeDirectory, f.qaHome);
  assert.equal(context.statePath, f.qaStatePath);
  assert.ok(context.tmpRoot.startsWith(f.qaHome + '/'));
  assert.ok(context.tmuxSocketPath.startsWith(context.tmpRoot + '/'));
  assert.equal(existsSync(f.statePath), false);
});

test('QA child environment replaces foreign HOME/selector/tmux socket without carrying a transfer permission', t => {
  const f = fixture(t);
  const context = qaContext(f);
  const inherited = { HOME: f.workingHome, RAF_QA_HOME: f.workingHome, TMUX: '/foreign/server.sock,123,0', TMUX_PANE: '%99', ALLOW_MIGRATIONS: '1', PATH: '/fixture/bin' };
  const env = stateContextEnvironment(context, inherited);
  assert.equal(env.HOME, f.qaHome);
  assert.equal(env.RAF_QA_HOME, f.qaHome);
  assert.equal(env.PATH, inherited.PATH);
  assert.ok(!env.TMUX || env.TMUX.startsWith(context.tmuxSocketPath + ','));
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.ALLOW_MIGRATIONS, undefined);
  assert.equal(inherited.HOME, f.workingHome);
});

for (const pathKind of ['missing', 'empty-version-zero'] as const) {
  test(`allowed QA initializes ${pathKind} locally and opening the current schema repeats no DDL`, t => {
    const f = fixture(t);
    const context = qaContext(f);
    if (pathKind === 'empty-version-zero') {
      mkdirSync(join(f.qaHome, '.raf'), { recursive: true });
      new DatabaseSync(f.qaStatePath).close();
    }
    openStateStore(f.qaStatePath, { context }).close();
    const db = new DatabaseSync(f.qaStatePath, { readOnly: true });
    const before = db.prepare('PRAGMA schema_version').get()!.schema_version;
    assert.equal(Number(db.prepare('PRAGMA user_version').get()!.user_version), STATE_SCHEMA_VERSION);
    db.close();
    openStateStore(f.qaStatePath, { context }).close();
    const after = new DatabaseSync(f.qaStatePath, { readOnly: true });
    assert.equal(after.prepare('PRAGMA schema_version').get()!.schema_version, before);
    after.close();
    assert.equal(existsSync(f.statePath), false);
  });
}

for (const version of [0, STATE_SCHEMA_VERSION + 1, 777]) {
  test(`nonempty schema ${version} is unsupported with and without an explicit transfer`, t => {
    const f = fixture(t);
    seedVersion(f, version, f.qaStatePath);
    const context = qaContext(f);
    const before = files(f.qaStatePath);
    for (const transfer of [undefined, { statePath: f.qaStatePath, fromVersion: version, toVersion: STATE_SCHEMA_VERSION }]) {
      assert.throws(() => openStateStore(f.qaStatePath, { context, transfer }), errorCode('STATE_SCHEMA_UNSUPPORTED'));
      assert.deepEqual(files(f.qaStatePath), before);
    }
  });
}

for (const fromVersion of [7, 10] as const) {
  const seed = fromVersion === 7 ? seedMain7 : seedMain10;
  const expectedSteps = Array.from({ length: STATE_SCHEMA_VERSION - fromVersion }, (_, index) => fromVersion + index + 1);

  for (const mode of ['production', 'qa'] as const) {
    test(`${mode} ordinary open refuses schema ${fromVersion} before changing DB/WAL/SHM`, t => {
      const f = fixture(t);
      const path = mode === 'qa' ? f.qaStatePath : f.statePath;
      seed(f, path);
      quietWal(t, path);
      const context = mode === 'qa' ? qaContext(f) : resolveStateContext(f.request({
        modulePath: join(f.mainTree, 'bin', 'raf.ts'), homeDirectory: f.workingHome, environment: { HOME: f.workingHome },
      }));
      const before = files(path);
      assert.throws(() => openStateStore(path, { context }), errorCode('STATE_MIGRATION_REQUIRED'));
      assert.deepEqual(files(path), before);
      if (mode === 'production' && fromVersion === 7) compatibleMainCanOpen(f);
    });
  }

  test(`the existing openStateStore(path) port refuses schema ${fromVersion} without any new options`, t => {
    const f = fixture(t);
    seed(f, f.qaStatePath);
    const before = files(f.qaStatePath);
    assert.throws(() => openStateStore(f.qaStatePath), errorCode('STATE_MIGRATION_REQUIRED'));
    assert.deepEqual(files(f.qaStatePath), before);
  });

  test(`explicit path-bound ${fromVersion}→${STATE_SCHEMA_VERSION} applies each SQL migration once and ordinary reopen does not replay it`, t => {
    const f = fixture(t);
    seed(f, f.qaStatePath);
    const context = qaContext(f);
    const before = logical(f.qaStatePath);
    assert.equal(before.schema.some(row => row.type === 'table' && row.name === 'test_run_groups'), false);
    const steps: number[] = [];
    const transfer = { statePath: f.qaStatePath, fromVersion, toVersion: STATE_SCHEMA_VERSION };
    openStateStore(f.qaStatePath, { context, transfer, afterMigrationStep: version => steps.push(version) }).close();
    assert.deepEqual(steps, expectedSteps);
    assert.deepEqual(logical(f.qaStatePath).rows, before.rows);
    assert.equal(logical(f.qaStatePath).version, STATE_SCHEMA_VERSION);
    assert.equal(logical(f.qaStatePath).integrity, 'ok');
    const migrated = logical(f.qaStatePath);
    assert.equal(migrated.schema.filter(row => row.type === 'table' && row.name === 'test_run_groups').length, 1);
    openStateStore(f.qaStatePath, { context, transfer, afterMigrationStep: () => assert.fail('repeated DDL') }).close();
    openStateStore(f.qaStatePath, { context, afterMigrationStep: () => assert.fail('ordinary reopen DDL') }).close();
    assert.deepEqual(logical(f.qaStatePath), migrated);
    assert.deepEqual(steps, expectedSteps);
  });

  test(`schema ${fromVersion}: transfer validates source, target and exact state path before any write`, t => {
    const f = fixture(t);
    seed(f, f.qaStatePath);
    const context = qaContext(f);
    const before = files(f.qaStatePath);
    for (const [transfer, code] of [
      [{ statePath: f.statePath, fromVersion, toVersion: STATE_SCHEMA_VERSION }, 'STATE_MIGRATION_CONFLICT'],
      [{ statePath: f.qaStatePath, fromVersion: fromVersion - 1, toVersion: STATE_SCHEMA_VERSION }, 'STATE_MIGRATION_CONFLICT'],
      [{ statePath: f.qaStatePath, fromVersion, toVersion: fromVersion }, 'STATE_SCHEMA_UNSUPPORTED'],
      [{ statePath: f.qaStatePath, fromVersion, toVersion: 10 }, 'STATE_SCHEMA_UNSUPPORTED'],
      [{ statePath: f.qaStatePath, fromVersion, toVersion: 999 }, 'STATE_SCHEMA_UNSUPPORTED'],
    ] as const) {
      assert.throws(() => openStateStore(f.qaStatePath, { context, transfer }), errorCode(code));
      assert.deepEqual(files(f.qaStatePath), before);
    }
    const db = new DatabaseSync(f.qaStatePath);
    db.exec('PRAGMA user_version = 9');
    db.close();
    const conflict = files(f.qaStatePath);
    assert.throws(() => openStateStore(f.qaStatePath, { context, transfer: { statePath: f.qaStatePath, fromVersion, toVersion: STATE_SCHEMA_VERSION } }), errorCode('STATE_MIGRATION_CONFLICT'));
    assert.deepEqual(files(f.qaStatePath), conflict);
  });

  test(`schema ${fromVersion}: a fault after the first DDL step rolls back schema, version and rows; a fresh attempt succeeds`, t => {
    const f = fixture(t);
    seed(f, f.qaStatePath);
    const context = qaContext(f);
    const before = logical(f.qaStatePath);
    const transfer = { statePath: f.qaStatePath, fromVersion, toVersion: STATE_SCHEMA_VERSION };
    let reachedStep = false;
    assert.throws(() => openStateStore(f.qaStatePath, {
      context, transfer,
      afterMigrationStep(version) { reachedStep = true; assert.equal(version, fromVersion + 1); throw new Error('injected-after-DDL-before-commit'); },
    }), /injected-after-DDL-before-commit/);
    assert.equal(reachedStep, true);
    assert.deepEqual(logical(f.qaStatePath), before);
    openStateStore(f.qaStatePath, { context, transfer }).close();
    assert.equal(logical(f.qaStatePath).version, STATE_SCHEMA_VERSION);
    assert.deepEqual(logical(f.qaStatePath).rows, before.rows);
  });

  test(`schema ${fromVersion}: two explicitly permitted processes recheck under the write lock and apply SQL only once`, async t => {
    const f = fixture(t);
    seed(f, f.qaStatePath);
    const context = qaContext(f);
    const stepsPath = join(f.root, 'migration-steps.txt');
    writeFileSync(stepsPath, '');
    const barrier = join(f.root, 'ready');
    mkdirSync(barrier);
    const program = `import { openStateStore } from ${JSON.stringify(new URL('../src/state-store.ts', import.meta.url).href)};
  import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
  import { setImmediate } from 'node:timers/promises';
  writeFileSync(process.argv[1] + '/' + process.pid, 'ready');
  while (readdirSync(process.argv[1]).length < 2) await setImmediate();
  const context = JSON.parse(process.argv[2]);
  openStateStore(context.statePath, { context, transfer: { statePath: context.statePath, fromVersion: ${fromVersion}, toVersion: ${STATE_SCHEMA_VERSION} }, afterMigrationStep: version => appendFileSync(process.argv[3], version + '\\n') }).close();`;
    const results = await Promise.all([nodeProcess(f, program, [barrier, JSON.stringify(context), stepsPath]), nodeProcess(f, program, [barrier, JSON.stringify(context), stepsPath])]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readFileSync(stepsPath, 'utf8').trim().split('\n').map(Number).sort((a, b) => a - b), expectedSteps);
    assert.equal(logical(f.qaStatePath).version, STATE_SCHEMA_VERSION);
    assert.equal(logical(f.qaStatePath).integrity, 'ok');
  });

  test(`schema ${fromVersion}: maintenance backs up committed WAL through SQLite and preserves both source and immutable backup on repeat`, async t => {
    const f = fixture(t);
    seed(f);
    mkdirSync(join(f.qaHome, '.raf'), { recursive: true });
    const original = new DatabaseSync(f.statePath);
    try {
      await backup(original, f.qaStatePath);
    } finally {
      original.close();
    }
    assert.equal(logical(f.qaStatePath).version, fromVersion);
    quietWal(t, f.qaStatePath);
    const source = files(f.statePath);
    const before = logical(f.qaStatePath);
    const backupPath = join(f.root, 'before-transfer.sqlite');
    const request = { context: qaContext(f), statePath: f.qaStatePath, fromVersion, toVersion: STATE_SCHEMA_VERSION, backupPath };
    const result = await migrateState(request, { async inspectClients() { return 'quiescent'; } });
    assert.equal(result.applied, true);
    assert.equal(result.fromVersion, fromVersion);
    assert.equal(result.toVersion, STATE_SCHEMA_VERSION);
    assert.equal(result.backupPath, backupPath);
    assert.deepEqual(logical(backupPath), before);
    assert.equal(logical(backupPath).rows.length, 2, 'backup includes the committed WAL row');
    assert.equal(logical(f.qaStatePath).version, STATE_SCHEMA_VERSION);
    assert.equal(logical(f.qaStatePath).integrity, 'ok');
    const migrated = logical(f.qaStatePath);
    const backupBytes = files(backupPath);
    const second = await migrateState({ ...request, backupPath: join(f.root, 'repeat.sqlite') }, { async inspectClients() { return 'quiescent'; } });
    assert.equal(second.applied, false);
    assert.equal(existsSync(join(f.root, 'repeat.sqlite')), false);
    assert.deepEqual(logical(f.qaStatePath), migrated);
    assert.deepEqual(files(backupPath), backupBytes);
    assert.deepEqual(files(f.statePath), source);
    assert.deepEqual(logical(f.qaStatePath).rows, before.rows);
  });

  for (const clients of ['incompatible', 'unknown'] as const) {
    test(`schema ${fromVersion}: maintenance refuses ${clients} clients before backup or migration`, async t => {
      const f = fixture(t);
      seed(f, f.qaStatePath);
      const backupPath = join(f.root, 'forbidden-backup.sqlite');
      const before = files(f.qaStatePath);
      await assert.rejects(migrateState({ context: qaContext(f), statePath: f.qaStatePath, fromVersion, toVersion: STATE_SCHEMA_VERSION, backupPath }, { async inspectClients(path) { assert.equal(path, f.qaStatePath); return clients; } }), /client|клієнт/i);
      assert.deepEqual(files(f.qaStatePath), before);
      assert.equal(existsSync(backupPath), false);
    });
  }

  test(`schema ${fromVersion}: maintenance refuses an existing backup and a failed backup destination without touching the database`, async t => {
    const f = fixture(t);
    seed(f, f.qaStatePath);
    const context = qaContext(f);
    const before = files(f.qaStatePath);
    const occupied = join(f.root, 'keep-backup.sqlite');
    writeFileSync(occupied, 'existing-backup-sentinel');
    for (const backupPath of [occupied, join(occupied, 'not-a-directory.sqlite')]) {
      await assert.rejects(migrateState({ context, statePath: f.qaStatePath, fromVersion, toVersion: STATE_SCHEMA_VERSION, backupPath }, { async inspectClients() { return 'quiescent'; } }), /backup|копі|резерв/i);
      assert.deepEqual(files(f.qaStatePath), before);
      assert.equal(readFileSync(occupied, 'utf8'), 'existing-backup-sentinel');
    }
  });
}
