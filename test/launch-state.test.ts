import assert from 'node:assert/strict';
import test from 'node:test';
import { createLaunchState } from '../src/launch-state.ts';
import type { LaunchMeasurement, ReserveLaunchRequest } from '../src/launch-state.ts';
import type { ResourceAdmission, ResourceAdmissionInput } from '../src/resource-admission.ts';
import type { AdmissionReservation, PendingIntent, ProcessIdentity, SessionRecord, SessionRepository, SessionTransaction } from '../src/session-state.ts';

const identity: ProcessIdentity = { pid: 41, startedAt: '2026-10-22T09:00:00Z', runner: 'fixture', runnerSessionId: 'internal-1', tmuxSession: 'tmux-1', evidence: { startTicks: '123' } };
const snapshot: LaunchMeasurement = {
  measurement: { machineId: 'host-1', loadAverage1m: 0.1, availableCores: 8, totalRamBytes: 1000, availableRamBytes: 100, memoryPressure: 'normal', fileSystems: [{ id: 'volume-1', totalBytes: 1000, availableBytes: 100 }] },
  observedProcesses: [],
};
const request: ReserveLaunchRequest = {
  runId: 'run-1', addressId: 'worker', activity: { type: 'implement', project: 'raf', features: ['sessions'], phase: 'implementation', cwd: '/fixture/raf' },
  launchContext: { assignment: { root: '/fixture', changes: [{ id: 'change-1', items: [{ id: '1.1', description: 'Persist launch context' }] }], baselineArchives: [] }, selection: { runner: 'fixture', model: 'model-1', effort: 'high', reason: 'selected by routing' }, briefPath: '/tmp/fixture/brief.md', reportPath: '/tmp/fixture/worker.json' },
  resource: 'fixture-pool', amount: 1, requested: { ramBytes: 60, diskBytes: { 'volume-1': 20 } }, requiredFileSystemIds: ['volume-1'], mode: 'normal',
};

function fixture() {
  let data = { sessions: new Map<string, SessionRecord>(), reservations: new Map<string, AdmissionReservation>(), pending: new Map<string, PendingIntent>() };
  let active = false;
  let transactions = 0;
  let fail: 'reservation' | 'pending' | undefined;
  let measurement = structuredClone(snapshot);
  let evaluator: ((input: ResourceAdmissionInput) => ResourceAdmission) | undefined;
  const evaluations: ResourceAdmissionInput[] = [];
  const repository: SessionRepository = {
    transaction<T>(operation: (tx: SessionTransaction) => T): T {
      assert.equal(active, false);
      active = true;
      transactions++;
      const draft = structuredClone(data);
      const tx: SessionTransaction = {
        getSession: id => structuredClone(draft.sessions.get(id)),
        listSessions: () => structuredClone([...draft.sessions.values()]),
        putSession: value => { draft.sessions.set(value.runId, structuredClone(value)); },
        deleteSession: id => { draft.sessions.delete(id); },
        listReservations: () => structuredClone([...draft.reservations.values()]),
        putReservation: value => {
          if (fail === 'reservation') throw new Error('reservation storage failure');
          draft.reservations.set(value.runId, structuredClone(value));
        },
        deleteReservation: id => { draft.reservations.delete(id); },
        putPending: value => {
          if (fail === 'pending') throw new Error('pending storage failure');
          draft.pending.set(value.id, structuredClone(value));
        },
        deletePending: id => { draft.pending.delete(id); },
        listPending: () => structuredClone([...draft.pending.values()]),
        applyEffects: effects => { assert.deepEqual(effects, []); },
      };
      try {
        const result = operation(tx);
        data = draft;
        return result;
      } finally {
        active = false;
      }
    },
  };
  const dependencies = {
    repository,
    measure: async (_request: ReserveLaunchRequest) => {
      assert.equal(active, false, 'OS sampling must not hold the transaction');
      return structuredClone(measurement);
    },
    evaluateAdmission: (input: ResourceAdmissionInput): ResourceAdmission => {
      assert.equal(active, true, 'admission decision must share the reservation transaction');
      evaluations.push(structuredClone(input));
      if (evaluator) return evaluator(input);
      const remaining = input.measurement.availableRamBytes - input.requested.ramBytes - input.unusedReservations.reduce((total, reservation) => total + reservation.ramBytes, 0);
      return { level: remaining >= 0 ? 'ANY_RUN' : 'NO_RESOURCES', allowed: { normal: remaining >= 0, hotfix: remaining >= 0 }, reasons: [], measurement: input.measurement, remaining: { ramBytes: remaining, diskBytes: {}, normalizedLoad: 0 } };
    },
  };
  return {
    store: createLaunchState(dependencies),
    peer: () => createLaunchState(dependencies),
    data: () => structuredClone(data),
    seed: (session: SessionRecord, reservation?: AdmissionReservation) => {
      data.sessions.set(session.runId, structuredClone(session));
      if (reservation) data.reservations.set(reservation.runId, structuredClone(reservation));
    },
    sample: (value: LaunchMeasurement) => { measurement = value; },
    evaluator: (value: typeof evaluator) => { evaluator = value; },
    fail: (value: typeof fail) => { fail = value; },
    transactions: () => transactions,
    evaluations,
  };
}

function existing(state: 'reserved' | 'running' = 'reserved'): SessionRecord {
  return { runId: 'old-run', addressId: 'old-worker', revision: 1, state, ...(state === 'running' ? { process: identity } : {}) };
}

function reserved(): AdmissionReservation {
  return { runId: 'old-run', resource: 'fixture-pool', amount: 1, resourceBundle: { machineId: 'host-1', resources: { ramBytes: 60, diskBytes: { 'volume-1': 20 } } } };
}

test('sampling is outside the one transaction that decides and persists identity, capacity and launch context', async () => {
  const f = fixture();
  const result = await f.store.reserveLaunch(structuredClone(request));
  assert.equal(result.reserved, true);
  assert.equal(f.transactions(), 1);
  assert.equal(f.evaluations.length, 1);
  assert.deepEqual(f.evaluations[0].requested, request.requested);
  assert.deepEqual(f.evaluations[0].requiredFileSystemIds, request.requiredFileSystemIds);
  const state = f.data();
  assert.deepEqual(state.sessions.get('run-1')?.launchContext, request.launchContext);
  assert.deepEqual(state.reservations.get('run-1')?.resourceBundle, { machineId: 'host-1', resources: request.requested });
});

test('two sampled launches see previously committed unused capacity within their transaction', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.store.reserveLaunch(structuredClone(request)),
    f.peer().reserveLaunch({ ...structuredClone(request), runId: 'run-2', addressId: 'worker-2' }),
  ]);
  assert.equal(results.filter(result => result.reserved).length, 1);
  assert.equal(f.data().sessions.size, 1);
  assert.equal(f.data().reservations.size, 1);
  assert.equal(f.evaluations[1].unusedReservations.length, 1);
});

test('running state alone does not prove that a reservation is reflected in the measurement', async () => {
  const f = fixture();
  f.seed(existing('running'), reserved());
  const result = await f.store.reserveLaunch(structuredClone(request));
  assert.equal(result.reserved, false);
  assert.deepEqual(f.evaluations[0].unusedReservations, [reserved().resourceBundle!.resources]);
  assert.equal(f.data().sessions.has('run-1'), false);
});

test('matching observed process identity avoids double counting already measured capacity', async () => {
  const f = fixture();
  f.seed(existing('running'), reserved());
  f.sample({ ...structuredClone(snapshot), observedProcesses: [{ runId: 'old-run', identity }] });
  const result = await f.store.reserveLaunch(structuredClone(request));
  assert.equal(result.reserved, true);
  assert.deepEqual(f.evaluations[0].unusedReservations, []);
  assert.equal(f.data().reservations.has('old-run'), true);
});

test('a reused PID with different start evidence cannot consume the old reservation twice', async () => {
  const f = fixture();
  f.seed(existing('running'), reserved());
  f.sample({ ...structuredClone(snapshot), observedProcesses: [{ runId: 'old-run', identity: { ...identity, startedAt: '2026-10-22T10:00:00Z', evidence: { startTicks: '456' } } }] });
  assert.equal((await f.store.reserveLaunch(structuredClone(request))).reserved, false);
  assert.deepEqual(f.evaluations[0].unusedReservations, [reserved().resourceBundle!.resources]);
});

test('reservation write failure rolls back session identity and context', async () => {
  const f = fixture();
  f.fail('reservation');
  await assert.rejects(f.store.reserveLaunch(structuredClone(request)), /reservation storage failure/);
  assert.equal(f.data().sessions.size, 0);
  assert.equal(f.data().reservations.size, 0);
});

test('an occupied address fails before any new reserve and retains the existing launch', async () => {
  const f = fixture();
  f.seed({ ...existing(), addressId: 'worker' }, reserved());
  const before = f.data();
  await assert.rejects(f.store.reserveLaunch(structuredClone(request)));
  assert.deepEqual(f.data(), before);
});

test('mode selects the existing evaluator permission without turning HOTFIX_ONLY into a normal allowance', async () => {
  const f = fixture();
  f.evaluator(input => ({ level: 'HOTFIX_ONLY', allowed: { normal: false, hotfix: true }, reasons: ['fixture pressure'], measurement: input.measurement, remaining: null }));
  assert.equal((await f.store.reserveLaunch(structuredClone(request))).reserved, false);
  assert.equal((await f.store.reserveLaunch({ ...structuredClone(request), mode: 'hotfix' })).reserved, true);
});

test('activity and intents commit atomically while immutable launch context, type and cwd survive', async () => {
  const f = fixture();
  await f.store.reserveLaunch(structuredClone(request));
  const before = f.data().sessions.get('run-1')!;
  const intents: PendingIntent[] = [{ id: 'activity-1', runId: 'run-1', event: 'fixture.activity', payload: { project: 'other' } }];
  assert.equal(f.store.updateActivity('run-1', before.revision, { project: 'other', features: ['updated'], phase: 'review' }, intents), true);
  const after = f.data().sessions.get('run-1')!;
  assert.deepEqual(after.launchContext, before.launchContext);
  assert.equal(after.activity?.type, before.activity?.type);
  assert.equal(after.activity?.cwd, before.activity?.cwd);
  assert.equal(after.activity?.project, 'other');
  assert.equal(after.revision, before.revision + 1);
  assert.equal(f.data().pending.size, 1);
  assert.equal(f.peer().updateActivity('run-1', before.revision, { project: 'stale' }, intents), false);
  assert.deepEqual(f.data().sessions.get('run-1'), after);
});

test('notification persistence failure rolls back the activity change and preserves assignment/report context', async () => {
  const f = fixture();
  await f.store.reserveLaunch(structuredClone(request));
  const before = f.data();
  f.fail('pending');
  assert.throws(() => f.store.updateActivity('run-1', before.sessions.get('run-1')!.revision, { phase: 'review' }, [{ id: 'activity-1', runId: 'run-1', event: 'fixture.activity', payload: {} }]), /pending storage failure/);
  assert.deepEqual(f.data(), before);
});
