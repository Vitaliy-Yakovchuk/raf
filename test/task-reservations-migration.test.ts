import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { listTaskReservations, type TaskReservationSet } from '../src/task-reservations.ts';

const schema15Commit = '30a2277317f90f53e50e1e9c5e54d13fba276c14';
const repository = fileURLToPath(new URL('../', import.meta.url));

function reservation(runId: string, stage: TaskReservationSet['stage'], tasks: readonly [string, string][]): TaskReservationSet {
  const process = (role: string, pid: number) => ({
    pid, startedAt: '2026-10-24T00:00:00.000Z', runner: 'fixture',
    runnerSessionId: `${runId}:${role}`, tmuxSession: `fixture-${runId}`,
    evidence: { runId, machineId: 'migration-machine', bootId: 'migration-boot', command: `fixture-${role}`, role },
  });
  return {
    lease: { owner: { addressId: `agent-${runId}`, runId, fence: `fence-${runId}` }, revision: stage === 'running' ? 9 : 4 },
    tasks: tasks.map(([changeId, taskId]) => ({
      key: { project: 'raf', changeId, taskId }, changeInstance: 'shared-instance', fingerprint: `${changeId}:${taskId}:original`,
    })),
    boot: { machineId: 'migration-machine', bootId: 'migration-boot' }, stage,
    starter: process('starter', 51001),
    ...(stage !== 'starting' ? { wrapper: process('wrapper', 51002) } : {}),
    ...(stage === 'running' ? { agent: process('agent', 51003) } : {}),
  };
}

function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const tables = schema.filter(row => row.type === 'table').map(row => String(row.name));
    const rows = Object.fromEntries(tables.map(name => [name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort(),
    ]));
    return {
      version: Number(db.prepare('PRAGMA user_version').get()!.user_version), schema, rows,
      integrity: db.prepare('PRAGMA integrity_check').get()!.integrity_check,
      primaryKey: db.prepare('PRAGMA table_info(task_reservations)').all()
        .filter(row => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(row => String(row.name)),
    };
  } finally { db.close(); }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-task-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const historical = join(directory, 'schema-15-client');
  const home = join(directory, 'home');
  const temporary = join(directory, 'tmp');
  for (const path of [historical, home, temporary]) mkdirSync(path);
  const env = { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', HOME: home, RAF_QA_HOME: home, TMPDIR: temporary };
  const run = (executable: string, argv: string[]) => {
    const result = spawnSync(executable, argv, { cwd: directory, env, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  };
  const archive = join(directory, 'schema-15.tar');
  run('git', ['-C', repository, 'archive', '--format=tar', '--output', archive, schema15Commit, 'src', 'package.json']);
  run('tar', ['-xf', archive, '-C', historical]);
  rmSync(archive);
  const path = join(directory, 'state.sqlite');
  const sets = [
    reservation('starting-run', 'starting', [['change-a', 'R.1'], ['change-b', 'R.2']]),
    reservation('handoff-run', 'handoff', [['change-a', 'R.3']]),
    reservation('running-run', 'running', [['change-b', 'R.4'], ['change-c', 'R.5']]),
  ];
  const input = join(directory, 'reservations.json');
  writeFileSync(input, JSON.stringify(sets));
  const program = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStateStore, STATE_SCHEMA_VERSION } from ${JSON.stringify(pathToFileURL(join(historical, 'src/state-store.ts')).href)};
assert.equal(STATE_SCHEMA_VERSION, 15);
const store = openStateStore(process.argv[1]);
try {
  const sets = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  store.taskReservationRepository.transaction(tx => {
    for (const set of sets) {
      tx.putSession({ runId: set.lease.owner.runId, addressId: set.lease.owner.addressId, revision: 3, state: 'reserved', activity: { type: 'test-scaffold', project: 'raf', features: ['migration-fixture'], phase: 'test-scaffold', cwd: process.cwd() } });
      tx.putReservation({ runId: set.lease.owner.runId, resource: 'fixture-admission', amount: 1 });
      tx.putTaskReservation(set);
    }
  });
} finally { store.close(); }`;
  run(process.execPath, ['--input-type=module', '-e', program, path, input]);
  assert.equal(snapshot(path).version, 15, 'the fixture must be generated by the pinned v15 client, never by relabelling the current schema');
  return { path, sets, transfer: { statePath: path, fromVersion: 15, toVersion: 16 } };
}

function sortedSets(sets: readonly TaskReservationSet[]) {
  return sets.map(set => ({ ...set, tasks: [...set.tasks].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
    .sort((a, b) => a.lease.owner.runId.localeCompare(b.lease.owner.runId));
}

function databaseFiles(path: string) {
  return ['', '-wal', '-shm'].map(suffix => existsSync(path + suffix) ? readFileSync(path + suffix) : null);
}

test('v15 ordinary open requires explicit migration and leaves schema, rows and leases unchanged', t => {
  const f = fixture(t);
  const before = snapshot(f.path);
  const beforeFiles = databaseFiles(f.path);
  assert.throws(() => openStateStore(f.path), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'STATE_MIGRATION_REQUIRED');
    return true;
  });
  assert.deepEqual(databaseFiles(f.path), beforeFiles, 'refusal must not change DB/WAL/SHM');
  assert.deepEqual(snapshot(f.path), before);
});

test('v15 to v16 preserves every reservation row, complete process identity, lease and admission', t => {
  const f = fixture(t);
  const before = snapshot(f.path);
  const steps: number[] = [];
  const store = openStateStore(f.path, { transfer: f.transfer, afterMigrationStep: version => steps.push(version) });
  try {
    assert.deepEqual(sortedSets(listTaskReservations(store)), sortedSets(f.sets));
  } finally { store.close(); }
  const after = snapshot(f.path);
  assert.equal(STATE_SCHEMA_VERSION, 16);
  assert.equal(after.version, 16);
  assert.equal(after.integrity, 'ok');
  assert.deepEqual(steps, [16]);
  assert.deepEqual(after.rows, before.rows, 'migration must preserve all persisted rows, including sessions and admission');
  assert.deepEqual(after.primaryKey.map(name => name.replaceAll('_', '').toLowerCase()).sort(), ['changeid', 'changeinstance', 'project', 'taskid']);
});

test('v16 keys include changeId: identical project, instance and task ID coexist and deleting one run preserves the other', t => {
  const f = fixture(t);
  const store = openStateStore(f.path, { transfer: f.transfer });
  const independent = reservation('independent-run', 'starting', [['independent-change', 'R.1']]);
  try {
    store.taskReservationRepository.transaction(tx => {
      tx.putSession({
        runId: independent.lease.owner.runId, addressId: independent.lease.owner.addressId, revision: 0, state: 'reserved',
        activity: { type: 'test-scaffold', project: 'raf', features: ['migration-fixture'], phase: 'test-scaffold', cwd: repository },
      });
      tx.putTaskReservation(independent);
    });
    const persisted = listTaskReservations(store);
    assert.equal(persisted.length, f.sets.length + 1);
    assert.deepEqual(sortedSets(persisted), sortedSets([...f.sets, independent]));
    store.taskReservationRepository.transaction(tx => tx.deleteTaskReservation(independent.lease.owner.runId));
    assert.deepEqual(sortedSets(listTaskReservations(store)), sortedSets(f.sets));
  } finally { store.close(); }
  const reopened = openStateStore(f.path);
  try { assert.deepEqual(sortedSets(listTaskReservations(reopened)), sortedSets(f.sets)); }
  finally { reopened.close(); }
});

test('a failure after v16 DDL rolls back the key, all rows and lease revisions; a fresh explicit retry succeeds', t => {
  const f = fixture(t);
  const before = snapshot(f.path);
  let reached = false;
  assert.throws(() => openStateStore(f.path, {
    transfer: f.transfer,
    afterMigrationStep(version) {
      assert.equal(version, 16);
      reached = true;
      throw new Error('injected-v16-before-commit');
    },
  }), /injected-v16-before-commit/);
  assert.equal(reached, true);
  assert.deepEqual(snapshot(f.path), before);
  const retried = openStateStore(f.path, { transfer: f.transfer });
  try { assert.deepEqual(sortedSets(listTaskReservations(retried)), sortedSets(f.sets)); }
  finally { retried.close(); }
  assert.equal(snapshot(f.path).version, 16);
  assert.deepEqual(snapshot(f.path).rows, before.rows);
});

test('ordinary v16 reopen and repeated explicit transfer never replay DDL or change the leases', t => {
  const f = fixture(t);
  openStateStore(f.path, { transfer: f.transfer }).close();
  const before = snapshot(f.path);
  for (const transfer of [undefined, f.transfer]) {
    const store = openStateStore(f.path, { transfer, afterMigrationStep: () => assert.fail('migration replayed') });
    try { assert.deepEqual(sortedSets(listTaskReservations(store)), sortedSets(f.sets)); }
    finally { store.close(); }
    assert.deepEqual(snapshot(f.path), before);
  }
});
