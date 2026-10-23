import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import { resolveStateContext, stateContextEnvironment, verifyStateContext } from '../src/state-migration-guard.ts';
import type { StateContext, StateEntryPoint } from '../src/state-migration-guard.ts';
import { migrateState } from '../src/state-migration.ts';
import { compatibleMainCanOpen, copyMain7, directoryFiles, files, fixture, logical, nodeProcess, quietWal, seedMain7, seedVersion } from './state-migration-fixture.ts';

function errorCode(code: string): (error: unknown) => boolean {
  return error => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

function qaContext(f: ReturnType<typeof fixture>): StateContext {
  return resolveStateContext(f.request());
}

for (const entryPoint of ['cli', 'runner-limits', 'worker', 'service-store', 'notice', 'hook'] as StateEntryPoint[]) {
  test(`${entryPoint}: develop refuses working account HOME before any filesystem initialization`, t => {
    const f = fixture(t);
    const before = directoryFiles(f.workingHome);
    assert.throws(() => resolveStateContext(f.request({
      entryPoint, homeDirectory: f.workingHome, environment: { HOME: f.workingHome, branch: 'main' },
    })), errorCode('STATE_CONTEXT_REFUSED'));
    assert.deepEqual(directoryFiles(f.workingHome), before);
    assert.equal(existsSync(f.statePath), false);
  });
}

test('resolver reads registered main path/profile and fails closed on missing, conflicting or unregistered configuration', t => {
  const f = fixture(t);
  const configPath = join(f.root, 'conf', 'projects.json');
  const original = readFileSync(configPath, 'utf8');
  const valid = JSON.parse(original);
  const mutations = [
    () => rmSync(configPath),
    () => writeFileSync(configPath, '{broken'),
    () => { const c = structuredClone(valid); c.projects.raf.path = 'unregistered'; writeFileSync(configPath, JSON.stringify(c)); },
    () => { const c = structuredClone(valid); c.projects.raf.profile = 'unregistered'; writeFileSync(configPath, JSON.stringify(c)); },
    () => { const c = structuredClone(valid); delete c.projects.raf.branchPaths.main; writeFileSync(configPath, JSON.stringify(c)); },
  ];
  for (const mutate of mutations) {
    writeFileSync(configPath, original);
    mutate();
    assert.throws(() => resolveStateContext(f.request()), errorCode('STATE_CONTEXT_REFUSED'));
    assert.equal(existsSync(f.qaStatePath), false);
    assert.equal(existsSync(f.statePath), false);
  }
});

test('loaded module provenance wins over an executable alias and arbitrary main declaration', t => {
  const f = fixture(t);
  const alias = join(f.mainTree, 'bin', 'develop-alias.ts');
  symlinkSync(join(f.developTree, 'bin', 'raf.ts'), alias);
  assert.throws(() => resolveStateContext(f.request({
    modulePath: alias, homeDirectory: f.workingHome,
    environment: { HOME: f.workingHome, branch: 'main', RAF_BRANCH: 'main' },
  })), errorCode('STATE_CONTEXT_REFUSED'));
  const hardAlias = join(f.mainTree, 'bin', 'develop-hardlink.ts');
  linkSync(join(f.developTree, 'bin', 'raf.ts'), hardAlias);
  assert.throws(() => resolveStateContext(f.request({ modulePath: hardAlias, homeDirectory: f.workingHome, environment: { HOME: f.workingHome } })), errorCode('STATE_CONTEXT_REFUSED'));
  assert.equal(existsSync(f.statePath), false);
});

test('explicit QA requires absolute matching HOME and a separate canonical account HOME', t => {
  const f = fixture(t);
  for (const environment of [
    { HOME: f.qaHome },
    { HOME: f.qaHome, RAF_QA_HOME: 'qa-home' },
    { HOME: f.qaHome, RAF_QA_HOME: f.workingHome },
    { HOME: f.workingHome, RAF_QA_HOME: f.workingHome },
  ]) {
    assert.throws(() => resolveStateContext(f.request({ environment, homeDirectory: environment.HOME })), errorCode('STATE_CONTEXT_REFUSED'));
  }
  const context = qaContext(f);
  assert.equal(context.mode, 'qa');
  assert.equal(context.codeRoot, f.developTree);
  assert.equal(context.homeDirectory, f.qaHome);
  assert.equal(context.statePath, f.qaStatePath);
  assert.ok(context.tmpRoot.startsWith(f.qaHome + '/'));
  assert.ok(context.tmuxSocketPath.startsWith(context.tmpRoot + '/'));
  assert.equal(existsSync(f.statePath), false);
});

for (const aliasKind of ['home', 'state-directory', 'database', 'wal', 'shm', 'tmp', 'ancestor'] as const) {
  test(`QA refuses canonical ${aliasKind} alias before changing working state`, t => {
    const f = fixture(t);
    seedMain7(f);
    const keeper = quietWal(t, f.statePath);
    const before = files(f.statePath);
    let request = f.request();
    if (aliasKind === 'home') {
      const alias = join(f.root, 'home-alias');
      symlinkSync(f.workingHome, alias);
      request = f.request({ homeDirectory: alias, environment: { HOME: alias, RAF_QA_HOME: alias } });
    } else if (aliasKind === 'state-directory') {
      symlinkSync(join(f.workingHome, '.raf'), join(f.qaHome, '.raf'));
    } else if (aliasKind === 'ancestor') {
      const alias = join(f.root, 'ancestor-alias');
      symlinkSync(f.workingHome, alias);
      const home = join(alias, '.raf', 'not-created');
      request = f.request({ homeDirectory: home, environment: { HOME: home, RAF_QA_HOME: home } });
    } else {
      mkdirSync(join(f.qaHome, '.raf'));
      const suffix = aliasKind === 'wal' ? '-wal' : aliasKind === 'shm' ? '-shm' : '';
      symlinkSync(aliasKind === 'tmp' ? join(f.workingHome, '.raf') : f.statePath + suffix,
        aliasKind === 'tmp' ? join(f.qaHome, '.raf', 'tmp') : f.qaStatePath + suffix);
    }
    assert.throws(() => resolveStateContext(request), errorCode('STATE_CONTEXT_REFUSED'));
    assert.deepEqual(files(f.statePath), before);
    assert.equal(Number(keeper.prepare('PRAGMA user_version').get()!.user_version), 7);
  });
}

for (const suffix of ['', '-wal', '-shm']) {
  test(`QA rejects hardlinked SQLite${suffix || ' database'} by file identity`, t => {
    const f = fixture(t);
    seedMain7(f);
    quietWal(t, f.statePath);
    mkdirSync(join(f.qaHome, '.raf'));
    linkSync(f.statePath + suffix, f.qaStatePath + suffix);
    const before = files(f.statePath);
    assert.throws(() => resolveStateContext(f.request()), errorCode('STATE_CONTEXT_REFUSED'));
    assert.deepEqual(files(f.statePath), before);
  });
}

test('path revalidation and actual state-store open reject alias replacement after preflight', t => {
  const f = fixture(t);
  seedMain7(f);
  const context = qaContext(f);
  mkdirSync(join(f.qaHome, '.raf'), { recursive: true });
  const before = files(f.statePath);
  symlinkSync(f.statePath, f.qaStatePath);
  assert.throws(() => verifyStateContext(context), errorCode('STATE_CONTEXT_REFUSED'));
  assert.throws(() => openStateStore(f.qaStatePath, { context }), errorCode('STATE_CONTEXT_REFUSED'));
  assert.deepEqual(files(f.statePath), before);
});

test('a state path different from the validated context cannot reuse that context', t => {
  const f = fixture(t);
  seedMain7(f);
  const context = qaContext(f);
  const before = files(f.statePath);
  assert.throws(() => openStateStore(f.statePath, { context }), errorCode('STATE_CONTEXT_REFUSED'));
  assert.deepEqual(files(f.statePath), before);
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
    assert.equal(Number(db.prepare('PRAGMA user_version').get()!.user_version), 10);
    db.close();
    openStateStore(f.qaStatePath, { context }).close();
    const after = new DatabaseSync(f.qaStatePath, { readOnly: true });
    assert.equal(after.prepare('PRAGMA schema_version').get()!.schema_version, before);
    after.close();
    assert.equal(existsSync(f.statePath), false);
  });
}

for (const mode of ['production', 'qa'] as const) {
  test(`${mode} ordinary open refuses schema 7 before changing DB/WAL/SHM`, t => {
    const f = fixture(t);
    const path = mode === 'qa' ? f.qaStatePath : f.statePath;
    seedMain7(f, path);
    quietWal(t, path);
    const context = mode === 'qa' ? qaContext(f) : resolveStateContext(f.request({
      modulePath: join(f.mainTree, 'bin', 'raf.ts'), homeDirectory: f.workingHome, environment: { HOME: f.workingHome },
    }));
    const before = files(path);
    assert.throws(() => openStateStore(path, { context }), errorCode('STATE_MIGRATION_REQUIRED'));
    assert.deepEqual(files(path), before);
    if (mode === 'production') compatibleMainCanOpen(f);
  });
}

test('the existing openStateStore(path) port also refuses an older schema without any new options', t => {
  const f = fixture(t);
  seedMain7(f, f.qaStatePath);
  const before = files(f.qaStatePath);
  assert.throws(() => openStateStore(f.qaStatePath), errorCode('STATE_MIGRATION_REQUIRED'));
  assert.deepEqual(files(f.qaStatePath), before);
});

for (const version of [0, 11, 777]) {
  test(`nonempty schema ${version} is unsupported with and without an explicit transfer`, t => {
    const f = fixture(t);
    seedVersion(f, version, f.qaStatePath);
    const context = qaContext(f);
    const before = files(f.qaStatePath);
    for (const transfer of [undefined, { statePath: f.qaStatePath, fromVersion: version, toVersion: 10 }]) {
      assert.throws(() => openStateStore(f.qaStatePath, { context, transfer }), errorCode('STATE_SCHEMA_UNSUPPORTED'));
      assert.deepEqual(files(f.qaStatePath), before);
    }
  });
}

test('explicit path-bound 7→10 applies each SQL migration once and ordinary reopen does not replay it', t => {
  const f = fixture(t);
  seedMain7(f, f.qaStatePath);
  const context = qaContext(f);
  const before = logical(f.qaStatePath);
  const steps: number[] = [];
  const transfer = { statePath: f.qaStatePath, fromVersion: 7, toVersion: 10 };
  openStateStore(f.qaStatePath, { context, transfer, afterMigrationStep: version => steps.push(version) }).close();
  assert.deepEqual(steps, [8, 9, 10]);
  assert.deepEqual(logical(f.qaStatePath).rows, before.rows);
  assert.equal(logical(f.qaStatePath).version, 10);
  assert.equal(logical(f.qaStatePath).integrity, 'ok');
  openStateStore(f.qaStatePath, { context, transfer, afterMigrationStep: () => assert.fail('repeated DDL') }).close();
  openStateStore(f.qaStatePath, { context }).close();
  assert.deepEqual(steps, [8, 9, 10]);
});

test('transfer validates source, target and exact state path before any write', t => {
  const f = fixture(t);
  seedMain7(f, f.qaStatePath);
  const context = qaContext(f);
  const before = files(f.qaStatePath);
  for (const [transfer, code] of [
    [{ statePath: f.statePath, fromVersion: 7, toVersion: 10 }, 'STATE_MIGRATION_CONFLICT'],
    [{ statePath: f.qaStatePath, fromVersion: 6, toVersion: 10 }, 'STATE_MIGRATION_CONFLICT'],
    [{ statePath: f.qaStatePath, fromVersion: 7, toVersion: 7 }, 'STATE_SCHEMA_UNSUPPORTED'],
    [{ statePath: f.qaStatePath, fromVersion: 7, toVersion: 999 }, 'STATE_SCHEMA_UNSUPPORTED'],
  ] as const) {
    assert.throws(() => openStateStore(f.qaStatePath, { context, transfer }), errorCode(code));
    assert.deepEqual(files(f.qaStatePath), before);
  }
  const db = new DatabaseSync(f.qaStatePath);
  db.exec('PRAGMA user_version = 9');
  db.close();
  const conflict = files(f.qaStatePath);
  assert.throws(() => openStateStore(f.qaStatePath, { context, transfer: { statePath: f.qaStatePath, fromVersion: 7, toVersion: 10 } }), errorCode('STATE_MIGRATION_CONFLICT'));
  assert.deepEqual(files(f.qaStatePath), conflict);
});

test('a fault after the first DDL step rolls back schema, version and rows; a fresh attempt succeeds', t => {
  const f = fixture(t);
  seedMain7(f, f.qaStatePath);
  const context = qaContext(f);
  const before = logical(f.qaStatePath);
  const transfer = { statePath: f.qaStatePath, fromVersion: 7, toVersion: 10 };
  let reachedStep = false;
  assert.throws(() => openStateStore(f.qaStatePath, {
    context, transfer,
    afterMigrationStep(version) { reachedStep = true; assert.equal(version, 8); throw new Error('injected-after-DDL-before-commit'); },
  }), /injected-after-DDL-before-commit/);
  assert.equal(reachedStep, true);
  assert.deepEqual(logical(f.qaStatePath), before);
  openStateStore(f.qaStatePath, { context, transfer }).close();
  assert.equal(logical(f.qaStatePath).version, 10);
  assert.deepEqual(logical(f.qaStatePath).rows, before.rows);
});

test('two explicitly permitted processes recheck under the write lock and apply SQL only once', async t => {
  const f = fixture(t);
  seedMain7(f, f.qaStatePath);
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
openStateStore(context.statePath, { context, transfer: { statePath: context.statePath, fromVersion: 7, toVersion: 10 }, afterMigrationStep: version => appendFileSync(process.argv[3], version + '\\n') }).close();`;
  const results = await Promise.all([nodeProcess(f, program, [barrier, JSON.stringify(context), stepsPath]), nodeProcess(f, program, [barrier, JSON.stringify(context), stepsPath])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readFileSync(stepsPath, 'utf8').trim().split('\n').map(Number).sort((a, b) => a - b), [8, 9, 10]);
  assert.equal(logical(f.qaStatePath).version, 10);
  assert.equal(logical(f.qaStatePath).integrity, 'ok');
});

test('maintenance backs up committed WAL through SQLite and preserves both source and immutable backup on repeat', async t => {
  const f = fixture(t);
  seedMain7(f);
  await copyMain7(f);
  quietWal(t, f.qaStatePath);
  const source = files(f.statePath);
  const before = logical(f.qaStatePath);
  const backupPath = join(f.root, 'before-transfer.sqlite');
  const request = { context: qaContext(f), statePath: f.qaStatePath, fromVersion: 7, toVersion: 10, backupPath };
  const result = await migrateState(request, { async inspectClients() { return 'quiescent'; } });
  assert.equal(result.applied, true);
  assert.equal(result.fromVersion, 7);
  assert.equal(result.toVersion, 10);
  assert.equal(result.backupPath, backupPath);
  assert.deepEqual(logical(backupPath), before);
  assert.equal(logical(backupPath).rows.length, 2, 'backup includes the committed WAL row');
  const backupBytes = files(backupPath);
  const second = await migrateState({ ...request, backupPath: join(f.root, 'repeat.sqlite') }, { async inspectClients() { return 'quiescent'; } });
  assert.equal(second.applied, false);
  assert.deepEqual(files(backupPath), backupBytes);
  assert.deepEqual(files(f.statePath), source);
  assert.deepEqual(logical(f.qaStatePath).rows, before.rows);
});

for (const clients of ['incompatible', 'unknown'] as const) {
  test(`maintenance refuses ${clients} clients before backup or migration`, async t => {
    const f = fixture(t);
    seedMain7(f, f.qaStatePath);
    const backupPath = join(f.root, 'forbidden-backup.sqlite');
    const before = files(f.qaStatePath);
    await assert.rejects(migrateState({ context: qaContext(f), statePath: f.qaStatePath, fromVersion: 7, toVersion: 10, backupPath }, { async inspectClients(path) { assert.equal(path, f.qaStatePath); return clients; } }), /client|клієнт/i);
    assert.deepEqual(files(f.qaStatePath), before);
    assert.equal(existsSync(backupPath), false);
  });
}

test('maintenance refuses an existing backup and a failed backup destination without touching the database', async t => {
  const f = fixture(t);
  seedMain7(f, f.qaStatePath);
  const context = qaContext(f);
  const before = files(f.qaStatePath);
  const occupied = join(f.root, 'keep-backup.sqlite');
  writeFileSync(occupied, 'existing-backup-sentinel');
  for (const backupPath of [occupied, join(occupied, 'not-a-directory.sqlite')]) {
    await assert.rejects(migrateState({ context, statePath: f.qaStatePath, fromVersion: 7, toVersion: 10, backupPath }, { async inspectClients() { return 'quiescent'; } }), /backup|копі|резерв/i);
    assert.deepEqual(files(f.qaStatePath), before);
    assert.equal(readFileSync(occupied, 'utf8'), 'existing-backup-sentinel');
  }
});
