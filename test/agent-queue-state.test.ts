import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { createAgentQueueState, type StoredAgentQueueEntry } from '../src/agent-queue-state.ts';
import type { AgentQueueRecord, AgentQueueValidation } from '../src/agent-run-queue.ts';
import type { TaskReservationSet, ReservedTaskSnapshot } from '../src/task-reservations.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-agent-queue-state-'));
  const path = join(directory, 'state.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path;
}

function legacyFixture(path: string) {
  const store = openStateStore(path);
  store.initializeRunners([{ id: 'legacy-runner', initialEnabled: true }]);
  store.startupContextDatabase.exec('DROP TABLE agent_launch_queue_entries; DROP TABLE agent_launch_queues; PRAGMA user_version=12');
  store.close();
}

const version = (database: DatabaseSync) => Number(database.prepare('PRAGMA user_version').get()!.user_version);
const task: ReservedTaskSnapshot = { key: { project: 'raf', changeId: 'queue-change', taskId: '4.2' }, changeInstance: 'instance', fingerprint: 'content' };
const validation: AgentQueueValidation = { assignment: { root: '/fixture', changes: [], baselineArchives: [] }, fingerprint: 'assignment', requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [] };
function record(queueId: string, runId = 'child'): AgentQueueRecord {
  return { queueId, requestId: `request-${runId}`, agentId: `agent-${runId}`, owner: { runId, fence: `fence-${runId}` },
    clientIdentity: { pid: 41, startedAt: 'start', machineId: 'machine', bootId: 'boot' }, coordinator: null, eventHandle: null };
}
function entry(queueId: string, runId = 'child'): StoredAgentQueueEntry {
  return { record: record(queueId, runId), phase: 'waiting', tasks: [task], fingerprint: validation.fingerprint };
}
function reservation(runId: string, tasks: readonly ReservedTaskSnapshot[]): TaskReservationSet {
  return { lease: { owner: { addressId: `agent-${runId}`, runId, fence: `fence-${runId}` }, revision: 0 }, tasks,
    boot: { machineId: 'machine', bootId: 'boot' }, stage: 'running', starter: { pid: 42, startedAt: '2026-10-23T00:00:00Z',
      runner: 'fixture', runnerSessionId: runId, tmuxSession: runId, evidence: { runId, machineId: 'machine', bootId: 'boot' } } };
}

test('agent-queue schema 12 ordinary readers write existing state without implicit DDL', t => {
  const path = fixture(t);
  legacyFixture(path);
  const historical = new DatabaseSync(path);
  try {
    const schema = historical.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const runners = historical.prepare('SELECT * FROM runners ORDER BY id').all();
    assert.equal(version(historical), 12);
    assert.throws(() => openStateStore(path), { code: 'STATE_MIGRATION_REQUIRED' });
    assert.equal(version(historical), 12);
    assert.deepEqual(historical.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), schema);
    assert.deepEqual(historical.prepare('SELECT * FROM runners ORDER BY id').all(), runners);
    assert.equal(historical.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_launch_queues'").get(), undefined);
    assert.equal(historical.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_launch_queue_entries'").get(), undefined);
    historical.prepare('UPDATE runners SET enabled=0 WHERE id=?').run('legacy-runner');
    assert.equal(historical.prepare('SELECT enabled FROM runners WHERE id=?').get('legacy-runner')!.enabled, 0);
  } finally { historical.close(); }
});

test('agent-queue explicit additive migration preserves old data and shared writers', t => {
  const path = fixture(t);
  legacyFixture(path);
  const historical = new DatabaseSync(path);
  let migrated: ReturnType<typeof openStateStore> | undefined;
  let reopened: ReturnType<typeof openStateStore> | undefined;
  try {
    const original = historical.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.equal(version(historical), 12);
    migrated = openStateStore(path, { transfer: { statePath: path, fromVersion: 12, toVersion: STATE_SCHEMA_VERSION } });
    reopened = openStateStore(path);
    const names = new Set(['agent_launch_queues', 'agent_launch_queue_entries']);
    assert.deepEqual(migrated.startupContextDatabase.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().filter(row => !names.has(row.name as string)), original);
    assert.equal(version(historical), STATE_SCHEMA_VERSION);
    assert.equal(migrated.getRunnerEnabled('legacy-runner'), true);
    historical.prepare('UPDATE runners SET enabled=0 WHERE id=?').run('legacy-runner');
    assert.equal(migrated.getRunnerEnabled('legacy-runner'), false);
    migrated.setRunnerEnabled('legacy-runner', true);
    assert.equal(historical.prepare('SELECT enabled FROM runners WHERE id=?').get('legacy-runner')!.enabled, 1);
    const first = createAgentQueueState(reopened).queueId(path, 'machine');
    assert.equal(createAgentQueueState(migrated).queueId(path, 'machine'), first);
    assert.notEqual(createAgentQueueState(migrated).queueId(path, 'other-machine'), first);
    assert.equal(migrated.startupContextDatabase.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { reopened?.close(); migrated?.close(); historical.close(); }
});

test('agent-queue migration failure rolls back tables version and existing records', t => {
  const path = fixture(t);
  legacyFixture(path);
  const historical = new DatabaseSync(path);
  try {
    const schema = historical.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const runners = historical.prepare('SELECT * FROM runners ORDER BY id').all();
    assert.throws(() => openStateStore(path, { transfer: { statePath: path, fromVersion: 12, toVersion: STATE_SCHEMA_VERSION }, afterMigrationStep: () => { throw new Error('injected-before-commit'); } }), /injected-before-commit/);
    assert.equal(version(historical), 12);
    assert.equal(historical.prepare('SELECT enabled FROM runners WHERE id=?').get('legacy-runner')!.enabled, 1);
    assert.deepEqual(historical.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), schema);
    assert.deepEqual(historical.prepare('SELECT * FROM runners ORDER BY id').all(), runners);
    assert.equal(historical.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_launch_queues'").get(), undefined);
    assert.equal(historical.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_launch_queue_entries'").get(), undefined);
    assert.equal(historical.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.throws(() => openStateStore(path), { code: 'STATE_MIGRATION_REQUIRED' });
  } finally { historical.close(); }
});

test('agent-queue claims reject whole overlapping task sets and stale fences preserve owner', t => {
  const path = fixture(t);
  const store = openStateStore(path);
  try {
    const queue = createAgentQueueState(store);
    const first = entry(queue.queueId(path, 'machine'));
    queue.transaction(tx => { queue.assertClaim(tx, first, validation); queue.save(first); });
    const next = entry(first.record.queueId, 'next');
    assert.throws(() => queue.transaction(tx => { queue.assertClaim(tx, next, validation); queue.save(next); }), /TASK_RESERVED/);
    assert.equal(queue.list().length, 1);
    assert.equal(queue.transaction(() => queue.remove({ ...first.record, owner: { ...first.record.owner, fence: 'stale' } })), false);
    assert.deepEqual(queue.get(first.record), first);
  } finally { store.close(); }
});

test('agent-queue coordinator retains tasks until fenced readiness and transfers atomically', t => {
  const path = fixture(t);
  const store = openStateStore(path);
  try {
    const queue = createAgentQueueState(store);
    const owned = entry(queue.queueId(path, 'machine'));
    owned.record.coordinator = { runId: 'parent', fence: 'fence-parent' };
    queue.transaction(tx => {
      tx.putSession({ runId: 'parent', addressId: 'agent-parent', state: 'running', revision: 0, activity: { type: 'coordinator', project: 'raf', phase: 'coordinator', features: [], cwd: '/fixture' } });
      tx.putTaskReservation(reservation('parent', [task]));
      queue.assertClaim(tx, owned, validation);
      queue.save({ ...owned, phase: 'starting' });
      tx.putSession({ runId: 'child', addressId: 'agent-child', state: 'reserved', revision: 0 });
      tx.putTaskReservation(reservation('child', []));
      assert.equal(queue.confirmReady(tx, owned.record), false);
      assert.deepEqual(tx.listTaskReservations().find(set => set.lease.owner.runId === 'parent')!.tasks, [task]);
      tx.putSession({ runId: 'child', addressId: 'agent-child', state: 'running', revision: 1 });
      assert.equal(queue.confirmReady(tx, owned.record), true);
      assert.deepEqual(tx.listTaskReservations().find(set => set.lease.owner.runId === 'parent')!.tasks, []);
      assert.deepEqual(tx.listTaskReservations().find(set => set.lease.owner.runId === 'child')!.tasks, [task]);
      assert.equal(queue.get(owned.record)!.ready, true);
      assert.equal(queue.confirmReady(tx, owned.record), true);
    });
  } finally { store.close(); }
});

test('agent-queue coordinator losing a selected item rolls back readiness without transfer', t => {
  const path = fixture(t);
  const store = openStateStore(path);
  try {
    const queue = createAgentQueueState(store);
    const owned = entry(queue.queueId(path, 'machine'));
    owned.record.coordinator = { runId: 'parent', fence: 'fence-parent' };
    queue.transaction(tx => {
      tx.putSession({ runId: 'parent', addressId: 'agent-parent', state: 'running', revision: 0, activity: { type: 'coordinator', project: 'raf', phase: 'coordinator', features: [], cwd: '/fixture' } });
      tx.putTaskReservation(reservation('parent', [task]));
      queue.assertClaim(tx, owned, validation);
      queue.save({ ...owned, phase: 'starting' });
      tx.putSession({ runId: 'child', addressId: 'agent-child', state: 'running', revision: 0 });
      tx.putTaskReservation(reservation('child', []));
      tx.putTaskReservation(reservation('parent', []));
    });
    assert.throws(() => queue.transaction(tx => queue.confirmReady(tx, owned.record)), /COORDINATOR_ASSIGNMENT_CHANGED/);
    assert.equal(queue.get(owned.record)!.ready, undefined);
    assert.deepEqual(store.taskReservationRepository.transaction(tx => tx.listTaskReservations().find(set => set.lease.owner.runId === 'child')!.tasks), []);
  } finally { store.close(); }
});


test('agent-queue recheck refuses a recreated change with identical assignment text', t => {
  const path = fixture(t);
  const store = openStateStore(path);
  try {
    const queue = createAgentQueueState(store);
    const original = entry(queue.queueId(path, 'machine'));
    queue.transaction(tx => { queue.assertClaim(tx, original, validation); queue.save(original); });
    const replaced = { ...original, tasks: [{ ...task, changeInstance: 'recreated-instance' }] };
    assert.throws(() => queue.transaction(tx => { queue.assertClaim(tx, replaced, validation); queue.save(replaced); }), /QUEUE_ASSIGNMENT_CHANGED/);
    assert.deepEqual(queue.get(original.record)!.tasks, [task]);
  } finally { store.close(); }
});
