import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentControlService, type AgentControlDependencies } from '../src/agent-control.ts';
import { prepareAgentClose, type AgentCloseOptions } from '../src/agent-close-preparation.ts';
import { loadFlowPolicy } from '../src/flow-policy.ts';
import { openStateStore } from '../src/state-store.ts';
import { createSessionState, type SessionRecord, type SessionRepository, type TransitionEffects } from '../src/session-state.ts';
import { configureForcedCloseStand } from '../scripts/qa-forced-close-config.mjs';
import {
  forcedCloseMetricsPeriod, readForcedCloseMetrics,
  recordForcedCloseFinalizationInTransaction, recordForcedCloseRefusalInTransaction,
  type ForcedCloseMetricsSnapshot,
} from '../src/forced-close-metrics.ts';

const epoch = Date.UTC(2026, 9, 24, 12);
const at = (ms: number) => new Date(epoch + ms).toISOString();
const empty: TransitionEffects = { pending: [], domain: [] };
const forced = { force: true, reason: 'PRIVATE_REASON_FOR_THIS_RUN' };

test('forced-close live stand preserves required production cost policy for startup', () => {
  const original = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const synthetic = { runnerProtocols: [{ runner: 'codex', version: '0.0.1', timeouts: {} }], commandTiming: { emaAlpha: 0.1 } };
  const configured = configureForcedCloseStand(synthetic, original);
  assert.deepEqual(configured.costProfile, original.costProfile);
  assert.deepEqual(configured.commandTiming, original.commandTiming);
  assert.deepEqual(configured.runnerProtocols[0].timeouts, original.runnerProtocols.find(row => row.runner === 'codex').timeouts);
  assert.equal(configured.runnerProtocols[0].version, '0.0.1');
});

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-forced-close-unit-'));
  const path = join(directory, 'state.sqlite');
  let store = openStateStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const repository: SessionRepository = {
    transaction: (operation, mode) => store.sessionRepository.transaction(operation, mode),
  };
  const state = createSessionState({ repository, verifyMainAuthority: () => false, verifyWorkResult: () => true });
  const read = (runId = 'run-a') => repository.transaction(tx => tx.getSession(runId), 'read');
  const seed = (runId = 'run-a', succeeded = false) => {
    const session: SessionRecord = {
      runId, addressId: 'worker', revision: 1, state: 'running',
      process: { pid: 123, startedAt: at(0), runner: 'codex', runnerSessionId: runId, tmuxSession: runId, evidence: { runId } },
      ...(succeeded ? {
        result: { status: 'succeeded', response: 'Accepted answer', proof: { accepted: runId } },
        reportAcceptance: { runId, status: 'succeeded', event: 'agent.succeeded' },
      } : {}),
    };
    repository.transaction(tx => {
      tx.putSession(session);
      tx.putReservation({ runId, resource: 'unit-fixture', amount: 1 });
    });
    return session;
  };
  const prepare = (runId = 'run-a', options: AgentCloseOptions = forced) => prepareAgentClose({
    repository,
    acceptPendingReport: async session => session,
    acceptedReport: (_tx, session) => session.reportAcceptance ? {
      runId: session.runId, status: 'succeeded', eventRecorded: true,
    } : null,
    eventForStatus: status => `agent.${status}`,
  }, read(runId)!, options);
  const exit = (runId = 'run-a') => {
    const session = read(runId)!;
    assert.equal(state.commitObservation(runId, session.revision, {
      state: 'exited', observedAt: at(100), exitCode: 0, evidence: 'isolated scanner confirmed exit',
    }, empty), true);
    return read(runId)!;
  };
  const finalize = (runId = 'run-a', effects = empty) => state.finalizeSession(runId, read(runId)!.revision, at(200), effects);
  const metrics = (readAt = at(1000)) => readForcedCloseMetrics(store.startupContextDatabase, readAt);
  const count = () => {
    const snapshot = metrics();
    assert.equal(snapshot.unavailableReason, null);
    assert.ok(snapshot.since && Number.isFinite(Date.parse(snapshot.since)));
    return snapshot.completed;
  };
  const reopen = () => { store.close(); store = openStateStore(path); };
  return { directory, repository, state, read, seed, prepare, exit, finalize, metrics, count, reopen, database: () => store.startupContextDatabase };
}

for (const succeeded of [false, true]) {
  test(`forced-close metrics: finalized force ${succeeded ? 'after accepted succeeded preserves success' : 'before report preserves failed'} contributes once`, async t => {
    const f = fixture(t);
    const initial = f.seed('run-a', succeeded);
    await f.prepare();
    f.exit();
    assert.equal(f.finalize(), true);
    assert.equal(f.count(), 1);
    assert.equal(f.read()!.result!.status, succeeded ? 'succeeded' : 'failed');
    assert.deepEqual(f.read()!.result!.forcedClose, { reason: forced.reason });
    if (succeeded) {
      assert.equal(f.repository.transaction(tx => tx.listPending()).filter(row => row.event === 'agent.failed').length, 0);
      assert.equal(initial.result!.status, 'succeeded');
    }
    f.reopen();
    assert.equal(f.count(), 1);
    assert.equal(JSON.stringify(f.metrics()).includes(forced.reason), false);
    assert.equal(JSON.stringify(f.metrics()).includes('run-a'), false);
  });
}

test('forced-close metrics: durable reason, pending exit and unknown observation are not completed force', async t => {
  const f = fixture(t);
  f.seed();
  await f.prepare();
  await f.prepare('run-a', { force: true, reason: 'Later reason must not replace the first' });
  assert.equal(f.read()!.state, 'running');
  assert.deepEqual(f.read()!.result!.forcedClose, { reason: forced.reason });
  assert.equal(f.count(), 0);
  const current = f.read()!;
  f.state.commitObservation('run-a', current.revision, { state: 'unknown', observedAt: at(50), error: 'exit not confirmed' }, empty);
  assert.equal(f.finalize(), false);
  assert.equal(f.count(), 0);
  f.exit();
  assert.equal(f.count(), 0);
  assert.equal(f.finalize(), true);
  assert.equal(f.count(), 1);
});

test('forced-close metrics: two independent reconciliation candidates and later retry add one contribution', async t => {
  const f = fixture(t);
  f.seed();
  await f.prepare();
  const selected = f.exit();
  const peer = createSessionState({ repository: f.repository, verifyMainAuthority: () => false, verifyWorkResult: () => true });
  const results = await Promise.all([
    Promise.resolve().then(() => f.state.finalizeSession('run-a', selected.revision, at(200), empty)),
    Promise.resolve().then(() => peer.finalizeSession('run-a', selected.revision, at(300), empty)),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(f.count(), 1);
  const finished = f.read()!;
  assert.equal(peer.finalizeSession('run-a', selected.revision, at(900), empty), false);
  assert.deepEqual(f.read(), finished);
  assert.equal(f.count(), 1);
});

test('forced-close metrics: transaction rollback removes session finalization, aggregate and pending event together', async t => {
  const f = fixture(t);
  f.seed();
  await f.prepare();
  f.exit();
  const before = f.read();
  const failing: SessionRepository = {
    transaction: (operation, mode) => f.repository.transaction(tx => operation({
      ...tx,
      putPending: intent => { tx.putPending(intent); throw new Error('Injected failure after finalization writes'); },
    }), mode),
  };
  const state = createSessionState({ repository: failing, verifyMainAuthority: () => false, verifyWorkResult: () => true });
  assert.throws(() => state.finalizeSession('run-a', before!.revision, at(200), {
    pending: [{ id: 'closed-a', runId: 'run-a', event: 'agent.closed', payload: {} }], domain: [],
  }), /Injected failure/);
  assert.deepEqual(f.read(), before);
  assert.equal(f.repository.transaction(tx => tx.listReservations()).length, 1);
  assert.equal(f.repository.transaction(tx => tx.listPending()).some(row => row.id === 'closed-a'), false);
  assert.equal(f.count(), 0);
  assert.equal(f.finalize(), true);
  assert.equal(f.count(), 1);
});

test('forced-close metrics: deletion of retained sessions and reopening preserve aggregate without run history', async t => {
  const f = fixture(t);
  f.seed();
  await f.prepare();
  f.exit();
  f.finalize();
  const before = f.metrics();
  const retention = loadFlowPolicy().retention.finishedSessionsMs;
  assert.equal(f.state.cleanupCompleted(at(200 + retention)), 1);
  assert.equal(f.read(), undefined);
  f.reopen();
  assert.deepEqual(f.metrics(), before);
  assert.equal(f.count(), 1);
  f.seed('run-b');
  await f.prepare('run-b');
  f.exit('run-b');
  f.finalize('run-b');
  assert.equal(f.count(), 2);
  assert.equal(f.metrics().since, before.since);
});

for (const kind of ['normal-close', 'crash'] as const) {
  test(`forced-close metrics: ${kind} does not increment completed`, t => {
    const f = fixture(t);
    f.seed('run-a', kind === 'normal-close');
    f.exit();
    f.finalize();
    assert.equal(f.count(), 0);
    assert.equal(f.read()!.result?.forcedClose, undefined);
  });
}

for (const gate of ['main', 'missing-reason', 'blank-reason', 'reason-without-force', 'reminders', 'identity'] as const) {
  test(`forced-close metrics: ${gate} gate cannot create a completed force`, async t => {
    const f = fixture(t);
    const initial = f.seed();
    let stops = 0;
    const dependencies: AgentControlDependencies = {
      repository: f.repository,
      coordinator: {
        acceptPendingReport: async session => session,
        prepareClose: (session, options) => f.prepare(session.runId, options),
        observe: async session => session,
        finalize: async session => { throw new Error(`Unexpected finalization ${session.runId}`); },
        updateActivity: async session => session,
        publish: async () => {},
      },
      scanner: { inspect: async identity => gate === 'identity'
        ? { state: 'alive', observedAt: at(10), identity: { ...identity, pid: identity.pid + 1 } }
        : { state: 'alive', observedAt: at(10), identity } },
      authority: { resolve: async () => ({ kind: 'system' }) },
      transport: {
        close: async () => { stops++; }, interrupt: async () => {},
        deliver: async () => ({ accepted: true, receiptId: 'reminder-receipt' }),
      },
      reminders: { sessionEnded: () => ({ allowed: false, unfinished: [] }) },
      projects: ['raf'], agentTypes: ['implement'],
    };
    const service = new AgentControlService(dependencies);
    const options = gate === 'missing-reason' ? { force: true }
      : gate === 'blank-reason' ? { force: true, reason: '  ' }
      : gate === 'reason-without-force' ? { reason: forced.reason } : forced;
    if (gate === 'reminders') {
      assert.equal((await service.close('worker', options)).closed, false);
    } else {
      await assert.rejects(() => service.close(gate === 'main' ? 'main' : 'worker', options),
        gate === 'main' ? /Main cannot be closed/ : gate === 'identity' ? /not confirmed alive/ : /Force requires/);
    }
    assert.equal(stops, 0);
    assert.deepEqual(f.read(), initial);
    assert.equal(f.count(), 0);
  });
}

test('forced-close metrics: refused authorization is separate, grouped by original code without reason text', t => {
  const f = fixture(t);
  f.seed();
  for (const code of ['CALLER_UNAUTHORIZED', 'CALLER_UNAUTHORIZED', 'SESSION_UNAVAILABLE']) {
    f.repository.transaction(() => recordForcedCloseRefusalInTransaction(f.database(), code, at(10)));
  }
  const snapshot = f.metrics();
  assert.equal(snapshot.completed, 0);
  assert.deepEqual(snapshot.refusalsByCode, { CALLER_UNAUTHORIZED: 2, SESSION_UNAVAILABLE: 1 });
  assert.equal(f.read()!.state, 'running');
  assert.equal(f.read()!.result, undefined);
  f.reopen();
  assert.deepEqual(f.metrics(), snapshot);
});

test('forced-close metrics: a refusal transaction rolls back independently of successful completions', t => {
  const f = fixture(t);
  assert.throws(() => f.repository.transaction(() => {
    recordForcedCloseRefusalInTransaction(f.database(), 'CALLER_UNAUTHORIZED', at(10));
    throw new Error('Rollback refusal');
  }), /Rollback refusal/);
  assert.deepEqual(f.metrics().refusalsByCode, {});
  assert.equal(f.count(), 0);
});

test('forced-close metrics: finalization storage hook requires the existing SQLite transaction', t => {
  const f = fixture(t);
  assert.throws(() => recordForcedCloseFinalizationInTransaction(f.database(), {
    runId: 'run-a', previousState: 'exited', forced: true, finishedAt: at(200),
  }), /transaction/i);
  assert.equal(f.count(), 0);
});

for (const input of [
  { previousState: 'running' as const, forced: true },
  { previousState: 'finished' as const, forced: true },
  { previousState: 'exited' as const, forced: false },
]) {
  test(`forced-close metrics: storage ignores ${input.previousState} with forced=${input.forced}`, t => {
    const f = fixture(t);
    f.repository.transaction(() => recordForcedCloseFinalizationInTransaction(f.database(), {
      runId: 'run-a', ...input, finishedAt: at(200),
    }));
    assert.equal(f.count(), 0);
  });
}

test('forced-close metrics: a database without historical accounting reports unavailable instead of zero', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const result = readForcedCloseMetrics(database, at(100));
  assert.equal(result.completed, null);
  assert.equal(result.since, null);
  assert.equal(result.readAt, at(100));
  assert.ok(result.unavailableReason);
});

function snapshot(completed: number, readAt: string): ForcedCloseMetricsSnapshot {
  return { completed, readAt, since: at(0), refusalsByCode: {}, unavailableReason: null };
}

test('forced-close metrics: adjacent summaries contain only new completed force with accounting start', () => {
  const first = snapshot(4, at(100));
  const second = snapshot(6, at(200));
  const third = snapshot(6, at(300));
  assert.deepEqual(forcedCloseMetricsPeriod(first, second), {
    startedAt: at(100), completedAt: at(200), since: at(0), completed: 2, unavailableReason: null,
  });
  assert.equal(forcedCloseMetricsPeriod(second, third).completed, 0);
  assert.deepEqual(forcedCloseMetricsPeriod(null, first), {
    startedAt: at(0), completedAt: at(100), since: at(0), completed: 4, unavailableReason: null,
  });
});

for (const variant of ['missing-history', 'new-accounting-start', 'counter-regressed', 'time-regressed'] as const) {
  test(`forced-close metrics: ${variant} is explicitly unavailable, never a fabricated zero`, () => {
    const previous = snapshot(5, at(100));
    const current = snapshot(6, at(200));
    if (variant === 'missing-history') {
      current.since = null;
      current.completed = null;
      current.unavailableReason = 'No historical accounting';
    }
    if (variant === 'new-accounting-start') current.since = at(150);
    if (variant === 'counter-regressed') current.completed = 3;
    if (variant === 'time-regressed') current.readAt = at(50);
    const period = forcedCloseMetricsPeriod(previous, current);
    assert.equal(period.completed, null);
    assert.ok(period.unavailableReason);
    assert.equal(period.completedAt, current.readAt);
  });
}
