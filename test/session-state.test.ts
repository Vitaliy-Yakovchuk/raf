import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionState } from '../src/session-state.ts';
import type { AdmissionReservation, DomainEffect, PendingIntent, ProcessIdentity, SessionActivity, SessionRecord, SessionRepository, SessionTransaction, TransitionEffects } from '../src/session-state.ts';

const activity: SessionActivity = { type: 'implement', project: 'raf', features: ['sessions'], phase: 'implementation', cwd: '/workspace/raf' };
const identity: ProcessIdentity = { pid: 401, startedAt: '2026-10-21T09:00:00Z', runner: 'fixture-runner', runnerSessionId: 'internal-1', tmuxSession: 'tmux-1', evidence: { startTicks: '123456', executable: '/fixture/agent' } };
const finishedAt = '2026-10-21T10:00:00.000Z';
const empty: TransitionEffects = { pending: [], domain: [] };
const authority = Object.freeze({ token: 'trusted-existing-session' });
const proof = Object.freeze({ token: 'verified-report' });

function fixture() {
  let data = { sessions: new Map<string, SessionRecord>(), reservations: new Map<string, AdmissionReservation>(), pending: new Map<string, PendingIntent>(), effects: new Map<string, DomainEffect>() };
  let fail: 'reservation' | 'pending' | 'effect' | undefined;
  let active = false;
  const repository: SessionRepository = {
    transaction<T>(operation: (transaction: SessionTransaction) => T): T {
      assert.equal(active, false);
      active = true;
      const draft = structuredClone(data);
      const transaction: SessionTransaction = {
        getSession: id => structuredClone(draft.sessions.get(id)),
        listSessions: () => structuredClone([...draft.sessions.values()]),
        putSession: session => { draft.sessions.set(session.runId, structuredClone(session)); },
        deleteSession: id => { draft.sessions.delete(id); },
        putReservation: reservation => {
          if (fail === 'reservation') throw new Error('reservation write failed');
          draft.reservations.set(reservation.runId, structuredClone(reservation));
        },
        deleteReservation: id => { draft.reservations.delete(id); },
        putPending: intent => {
          if (fail === 'pending') throw new Error('pending write failed');
          draft.pending.set(intent.id, structuredClone(intent));
        },
        deletePending: id => { draft.pending.delete(id); },
        listPending: () => structuredClone([...draft.pending.values()]),
        applyEffects: effects => {
          for (const effect of effects) {
            draft.effects.set(effect.id, structuredClone(effect));
            if (fail === 'effect') throw new Error('domain write failed');
          }
        },
      };
      try {
        const result = operation(transaction);
        data = draft;
        return result;
      } finally {
        active = false;
      }
    },
  };
  const dependencies = { repository, verifyMainAuthority: (value: unknown) => value === authority, verifyWorkResult: (_runId: string, result: { proof: unknown }) => result.proof === proof };
  const store = createSessionState(dependencies);
  return {
    store,
    peer: () => createSessionState(dependencies),
    snapshot: () => structuredClone(data),
    fail: (value: typeof fail) => { fail = value; },
    active: () => active,
    reserve: (runId = 'run-1', addressId = 'worker') => store.reserveLaunch(addressId, runId, activity, { resource: 'pool-1', amount: 1 }),
    start: (runId = 'run-1') => store.commitStarted(runId, identity),
  };
}

function exited() {
  return { state: 'exited' as const, observedAt: finishedAt, exitCode: 1, evidence: 'registered process absent' };
}

function effects(runId = 'run-1'): TransitionEffects {
  return { pending: [{ id: `${runId}:exit`, runId, event: 'fixture.exit', payload: { addressId: 'worker' } }], domain: [{ id: `${runId}:reminders`, domain: 'reminders', payload: { transition: 'caller-supplied' } }] };
}

test('reservation and session commit together; a second client cannot reserve the same unclosed address', () => {
  const f = fixture();
  f.reserve();
  assert.throws(() => f.peer().reserveLaunch('worker', 'run-2', activity, { resource: 'pool-1', amount: 1 }));
  assert.equal(f.snapshot().sessions.size, 1);
  assert.deepEqual([...f.snapshot().reservations.values()], [{ runId: 'run-1', resource: 'pool-1', amount: 1 }]);
});

test('reservation failure rolls back the session and permits retry', () => {
  const f = fixture();
  f.fail('reservation');
  assert.throws(() => f.reserve(), /reservation write failed/);
  assert.equal(f.snapshot().sessions.size, 0);
  assert.equal(f.snapshot().reservations.size, 0);
  f.fail(undefined);
  assert.equal(f.reserve().runId, 'run-1');
});

test('starting uses CAS and retains complete process identity without overwriting on retry', () => {
  const f = fixture();
  f.reserve();
  assert.equal(f.start(), true);
  assert.equal(f.store.commitStarted('run-1', { ...identity, pid: 402 }), false);
  assert.deepEqual(f.snapshot().sessions.get('run-1')?.process, identity);
  assert.equal(f.snapshot().sessions.get('run-1')?.state, 'running');
});

test('abort releases only its reservation, retains stable closure, and allows a new run at the address', () => {
  const f = fixture();
  f.reserve();
  assert.equal(f.store.abortLaunch('run-1', 'spawn failed', finishedAt), true);
  f.reserve('run-2');
  assert.equal(f.store.abortLaunch('run-1', 'late retry', '2026-10-22T10:00:00Z'), false);
  assert.deepEqual([...f.snapshot().reservations.keys()], ['run-2']);
  assert.equal(f.snapshot().sessions.get('run-1')?.finishedAt, finishedAt);
  assert.equal(f.snapshot().sessions.size, 2);
});

test('existing main requires verified authority, uses the literal address, and remains unique', () => {
  const f = fixture();
  assert.throws(() => f.store.registerExistingMain('main-1', identity, { type: 'main' }, activity));
  assert.equal(f.snapshot().sessions.size, 0);
  const registered = f.store.registerExistingMain('main-1', identity, authority, activity);
  assert.equal(registered.addressId, 'main');
  assert.deepEqual(registered.process, identity);
  assert.equal(registered.state, 'running');
  assert.throws(() => f.peer().registerExistingMain('main-2', { ...identity, pid: 402 }, authority, activity));
  assert.equal(f.snapshot().sessions.size, 1);
});

test('normal launch cannot create main through an address or activity type', () => {
  const f = fixture();
  assert.throws(() => f.reserve('main-1', 'main'));
  assert.throws(() => f.store.reserveLaunch('worker', 'main-2', { ...activity, type: 'main' }, { resource: 'pool-1', amount: 1 }));
  assert.equal(f.snapshot().sessions.size, 0);
});

test('reconciliation returns detached identity snapshots and releases the transaction before caller probes', () => {
  const f = fixture();
  f.reserve();
  f.start();
  const candidates = f.store.listReconciliationCandidates();
  assert.equal(f.active(), false);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].process, identity);
  candidates[0].process!.pid = 999;
  assert.equal(f.store.listReconciliationCandidates()[0].process?.pid, identity.pid);
});

test('unknown process evidence cannot finalize or release the active reservation', () => {
  const f = fixture();
  f.reserve();
  f.start();
  const before = f.store.listReconciliationCandidates()[0];
  f.store.commitObservation('run-1', before.revision, { state: 'unknown', observedAt: finishedAt, error: 'OS probe denied' }, empty);
  const after = f.snapshot().sessions.get('run-1')!;
  assert.equal(after.state, 'running');
  assert.equal(after.finishedAt, undefined);
  assert.equal(f.snapshot().reservations.has('run-1'), true);
  assert.equal(f.snapshot().pending.size, 0);
});

test('two observations with the same revision commit one transition and one set of effects', () => {
  const f = fixture();
  f.reserve();
  f.start();
  const revision = f.store.listReconciliationCandidates()[0].revision;
  assert.equal(f.store.commitObservation('run-1', revision, exited(), effects()), true);
  assert.equal(f.peer().commitObservation('run-1', revision, exited(), effects()), false);
  assert.equal(f.snapshot().sessions.get('run-1')?.state, 'exited');
  assert.equal(f.snapshot().pending.size, 1);
  assert.equal(f.snapshot().effects.size, 1);
  assert.equal(f.snapshot().sessions.get('run-1')?.finishedAt, undefined);
});

for (const failure of ['pending', 'effect'] as const) {
  test(`observation and all effects roll back together on ${failure} failure`, () => {
    const f = fixture();
    f.reserve();
    f.start();
    const before = f.snapshot();
    const revision = before.sessions.get('run-1')!.revision;
    f.fail(failure);
    assert.throws(() => f.store.commitObservation('run-1', revision, exited(), effects()));
    assert.deepEqual(f.snapshot(), before);
    f.fail(undefined);
    assert.equal(f.store.commitObservation('run-1', revision, exited(), effects()), true);
  });
}

test('only verified current-run results are accepted once and succeeded survives a later process failure', () => {
  const f = fixture();
  f.reserve();
  f.start();
  assert.equal(f.store.acceptWorkResult('missing', { status: 'succeeded', response: 'done', proof }, empty), false);
  assert.equal(f.store.acceptWorkResult('run-1', { status: 'succeeded', response: 'done', proof: {} }, empty), false);
  const result = { status: 'succeeded', response: 'done', proof };
  assert.equal(f.store.acceptWorkResult('run-1', result, effects()), true);
  assert.equal(f.store.acceptWorkResult('run-1', result, effects()), false);
  const revision = f.snapshot().sessions.get('run-1')!.revision;
  f.store.commitObservation('run-1', revision, exited(), empty);
  assert.equal(f.snapshot().sessions.get('run-1')?.result?.status, 'succeeded');
  assert.equal(f.snapshot().pending.size, 1);
});

test('finalization waits for atomic reminder effects, releases admission, and fixes finishedAt once', () => {
  const f = fixture();
  f.reserve();
  f.start();
  let revision = f.snapshot().sessions.get('run-1')!.revision;
  f.store.commitObservation('run-1', revision, exited(), empty);
  revision = f.snapshot().sessions.get('run-1')!.revision;
  const before = f.snapshot();
  f.fail('effect');
  assert.throws(() => f.store.finalizeSession('run-1', revision, finishedAt, effects()));
  assert.deepEqual(f.snapshot(), before);
  f.fail(undefined);
  assert.equal(f.store.finalizeSession('run-1', revision, finishedAt, effects()), true);
  assert.equal(f.store.finalizeSession('run-1', revision, '2026-10-22T10:00:00Z', effects()), false);
  assert.equal(f.snapshot().sessions.get('run-1')?.finishedAt, finishedAt);
  assert.equal(f.snapshot().sessions.get('run-1')?.state, 'finished');
  assert.equal(f.snapshot().reservations.size, 0);
  assert.equal(f.snapshot().effects.size, 1);
  assert.equal(f.store.listReconciliationCandidates().length, 0);
});

test('pending delivery survives a new client and completion removes the intent without a receipt history', () => {
  const f = fixture();
  f.reserve();
  f.start();
  const revision = f.snapshot().sessions.get('run-1')!.revision;
  f.store.commitObservation('run-1', revision, exited(), effects());
  const peer = f.peer();
  assert.deepEqual(peer.listPending(), effects().pending);
  peer.completePending('run-1:exit');
  peer.completePending('run-1:exit');
  assert.deepEqual(f.store.listPending(), []);
  assert.equal(f.snapshot().pending.size, 0);
});

test('cleanup preserves the full 24 hours, active runs, and independent reminder effects', () => {
  const f = fixture();
  f.reserve();
  f.start();
  let revision = f.snapshot().sessions.get('run-1')!.revision;
  f.store.commitObservation('run-1', revision, exited(), empty);
  revision = f.snapshot().sessions.get('run-1')!.revision;
  f.store.finalizeSession('run-1', revision, finishedAt, effects());
  f.reserve('run-2');
  const reminderState = f.snapshot().effects;
  assert.equal(f.store.cleanupCompleted('2026-10-22T09:59:59.999Z'), 0);
  assert.equal(f.snapshot().sessions.size, 2);
  assert.equal(f.store.cleanupCompleted('2026-10-22T10:00:00.001Z'), 1);
  assert.equal(f.snapshot().sessions.has('run-1'), false);
  assert.equal(f.snapshot().sessions.has('run-2'), true);
  assert.deepEqual(f.snapshot().effects, reminderState);
});

test('a failed result event rolls back acceptance so a verified result can be retried', () => {
  const f = fixture();
  f.reserve();
  f.start();
  const before = f.snapshot();
  const result = { status: 'succeeded', response: 'done', proof };
  f.fail('pending');
  assert.throws(() => f.store.acceptWorkResult('run-1', result, effects()), /pending write failed/);
  assert.deepEqual(f.snapshot(), before);
  f.fail(undefined);
  assert.equal(f.store.acceptWorkResult('run-1', result, effects()), true);
});

test('an old completed run cannot accept a report for a reused address or alter the new run', () => {
  const f = fixture();
  f.reserve();
  f.store.abortLaunch('run-1', 'spawn failed', finishedAt);
  f.reserve('run-2');
  f.start('run-2');
  const before = f.snapshot();
  assert.equal(f.store.acceptWorkResult('run-1', { status: 'succeeded', response: 'stale', proof }, effects()), false);
  assert.deepEqual(f.snapshot(), before);
});

test('main can be registered again after finalization while its earlier run remains in retention', () => {
  const f = fixture();
  const registered = f.store.registerExistingMain('main-1', identity, authority, activity);
  assert.equal(f.store.commitObservation('main-1', registered.revision, exited(), empty), true);
  const revision = f.snapshot().sessions.get('main-1')!.revision;
  assert.equal(f.store.finalizeSession('main-1', revision, finishedAt, empty), true);
  const next = f.store.registerExistingMain('main-2', { ...identity, pid: 402, runnerSessionId: 'internal-2' }, authority, activity);
  assert.equal(next.addressId, 'main');
  assert.equal(f.snapshot().sessions.size, 2);
  assert.equal(f.snapshot().sessions.get('main-1')?.finishedAt, finishedAt);
});
