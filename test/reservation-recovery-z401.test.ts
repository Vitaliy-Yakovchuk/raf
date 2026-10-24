import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import {
  claimTaskReservations, listTaskReservations, reconcileTaskReservations,
  releaseTaskReservations, handoffTaskReservations, startTaskReservations,
  type ReservedTaskSnapshot, type TaskReservationDependencies,
  type TaskReservationLease, type TaskReservationSet, type ReservationProcessIdentity,
} from '../src/task-reservations.ts';
import {
  prepareAgentClose, type AcceptedCloseReport, type AgentClosePreparationDependencies,
} from '../src/agent-close-preparation.ts';
import { AgentControlService, type AgentControlDependencies } from '../src/agent-control.ts';
import { closeSessionInTransaction, type ProcessObservation, type SessionRecord } from '../src/session-state.ts';
import type { CompiledCatalog } from '../src/catalog.ts';

const at = '2026-10-24T02:00:00.000Z';
const boot = { machineId: 'z401-machine', bootId: 'z401-boot' };
const oldRun = 'z401-old-run';
const reason = 'Main reviewed the commit; the original task was changed, so this run is cancelled.';

type Source = 'changed' | 'deleted' | 'renumbered' | 'unavailable' | 'open' | 'completed';

function task(id: string, overrides: Partial<ReservedTaskSnapshot> = {}): ReservedTaskSnapshot {
  return {
    key: { project: 'raf', changeId: 'z401-fixture', taskId: id },
    changeInstance: 'z401-change-instance', fingerprint: `original-${id}`, ...overrides,
  };
}

function identity(runId: string, overrides: Partial<ReservationProcessIdentity> = {}): ReservationProcessIdentity {
  return {
    pid: 40000 + [...runId].reduce((total, char) => total + char.charCodeAt(0), 0), startedAt: '2020-01-01T00:00:00.000Z', runner: 'codex',
    runnerSessionId: `runner-${runId}`, tmuxSession: `tmux-${runId}`,
    evidence: { ...boot, runId, command: `z401-fixture-${runId}` }, ...overrides,
  };
}

function wrapperIdentity(runId: string): ReservationProcessIdentity {
  const process = identity(runId);
  return {
    ...process, pid: process.pid + 100000,
    runnerSessionId: `wrapper-${runId}`, tmuxSession: `wrapper-${runId}`,
    evidence: { ...process.evidence, command: `z401-wrapper-${runId}` },
  };
}

function catalog(options: readonly string[]): CompiledCatalog {
  return {
    commands: [{
      path: ['agent', 'close'], handlerName: 'agent close', valueSources: {}, metadata: {},
      parameters: options.map(option => ({ name: option.slice(2), option })),
    }],
    reportStatuses: [
      { id: 'succeeded', event: 'agent.succeeded' }, { id: 'failed', event: 'agent.failed' },
    ],
  };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? `${error.message} ${JSON.stringify(error)}` : String(error);
}

async function failure(action: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try { await action(); } catch (error) {
    assert.ok(error instanceof Error, 'A refusal must retain an Error diagnostic');
    return error;
  }
  assert.fail('Expected a refusal; no side effects are authorized');
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-z401-'));
  const store = openStateStore(join(directory, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let fence = 0;
  const source = new Map<string, Source>([['A', 'changed']]);
  const observations = new Map<string, ProcessObservation>();
  const protectedRuns = new Set<string>();
  const effects = { reserveLaunch: 0, acceptedClaims: 0 };
  let currentBoot = boot;
  const dependencies: TaskReservationDependencies = {
    store,
    currentBoot: async () => currentBoot,
    newFence: () => `z401-fence-${++fence}`,
    observe: async process => observations.get(process.evidence.runId) ?? {
      state: 'alive', observedAt: at, identity: process,
    },
    retainPendingConfirmation: async runId => protectedRuns.has(runId),
    resolveTasks: async tasks => tasks.map(snapshot => {
      const mode = source.get(snapshot.key.taskId) ?? 'open';
      if (mode === 'unavailable') return {
        state: 'unknown' as const, requested: snapshot, reason: 'OpenSpec source read unavailable',
      };
      if (mode === 'changed' && snapshot.fingerprint === 'current-A') return { state: 'open' as const, task: snapshot, location: 'active' as const };
      if (mode === 'changed' || mode === 'deleted' || mode === 'renumbered') return {
        state: 'mismatch' as const, requested: snapshot,
        reason: `z401-fixture:${snapshot.key.taskId}: ${mode}; original fingerprint no longer matches`,
      };
      return { state: mode, task: snapshot, location: 'active' as const };
    }),
  };
  const readSession = (runId = oldRun): SessionRecord => {
    const session = store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
    assert.ok(session, `Expected session ${runId}`);
    return session;
  };
  const session = (runId: string, addressId = 'old-agent'): SessionRecord => ({
    runId, addressId, revision: 1, state: 'running', process: identity(runId),
    activity: { type: 'implement', project: 'raf', features: ['z401-fixture'], phase: 'implement', cwd: directory },
  });
  function seed(runId = oldRun, tasks: readonly ReservedTaskSnapshot[] = [task('A')], addressId = 'old-agent'): TaskReservationLease {
    const lease = { owner: { addressId, runId, fence: `seed-${runId}` }, revision: 1 };
    const value: TaskReservationSet = {
      lease, tasks, boot, stage: 'running', starter: identity(runId),
      wrapper: wrapperIdentity(runId), agent: identity(runId),
    };
    store.taskReservationRepository.transaction(tx => {
      tx.putSession(session(runId, addressId));
      tx.putTaskReservation(value);
      tx.putReservation({ runId, resource: 'unit-fixture', amount: 1 });
    });
    return lease;
  }
  async function claim(runId: string, tasks: readonly ReservedTaskSnapshot[], delegator?: string) {
    const result = await claimTaskReservations(dependencies, {
      addressId: `agent-${runId}`, runId, tasks, starter: identity(runId),
      ...(delegator ? { resolveDelegator: async () => delegator } : {}),
      reserveLaunch: tx => {
        effects.reserveLaunch++;
        const value = { ...session(runId, `agent-${runId}`), state: 'reserved' as const };
        tx.putSession(value);
        tx.putReservation({ runId, resource: 'unit-fixture', amount: 1 });
        return value;
      },
    });
    if (result.reserved) effects.acceptedClaims++;
    return result;
  }
  function snapshot() {
    return structuredClone({
      tasks: listTaskReservations(store),
      ...store.sessionRepository.transaction(tx => ({
        sessions: tx.listSessions(), admission: tx.listReservations(), pending: tx.listPending(),
      }), 'read'),
    });
  }
  const exited = (runId = oldRun) => observations.set(runId, {
    state: 'exited', observedAt: at, exitCode: 0, evidence: 'unit process probe confirms exit',
  });
  return { store, dependencies, source, observations, protectedRuns, effects, readSession, session, seed, claim, snapshot, exited, setBoot: (value: typeof boot) => { currentBoot = value; } };
}

type Fixture = ReturnType<typeof fixture>;

function closeFixture(t: TestContext, f = fixture(t)) {
  const lease = f.seed();
  let accepted: AcceptedCloseReport | null = null;
  let reportMismatch = false;
  const calls = { report: 0, transport: 0, finalize: 0, publish: 0, reminders: 0 };
  const preparation: AgentClosePreparationDependencies = {
    repository: f.store.sessionRepository,
    compiledCatalog: catalog(['--id', '--force', '--reason']),
    acceptPendingReport: async session => {
      calls.report++;
      if (reportMismatch) throw Object.assign(new Error('z401-fixture:A: task description/fingerprint changed'), { code: 'TASK_IDENTITY_MISMATCH' });
      return session;
    },
    acceptedReport: () => accepted,
    eventForStatus: status => `agent.${status}`,
  };
  let transportFailure = false;
  let finalizeFailure = false;
  let remindersAllowed = true;
  let exitAfterClose = true;
  let preparationError: Error | undefined;
  const control: AgentControlDependencies = {
    repository: f.store.sessionRepository,
    coordinator: {
      prepareClose: async (session, options) => {
        if (preparationError) throw preparationError;
        return prepareAgentClose(preparation, session, options);
      },
      acceptPendingReport: preparation.acceptPendingReport,
      observe: async (session, observation) => {
        const updated = { ...session, observation, state: observation.state === 'exited' ? 'exited' as const : session.state, revision: session.revision + 1 };
        f.store.sessionRepository.transaction(tx => tx.putSession(updated));
        return updated;
      },
      finalize: async session => {
        if (finalizeFailure) throw new Error('unit finalize unavailable');
        calls.finalize++;
        await releaseTaskReservations(f.dependencies, {
          lease, reason: 'failed', closeLaunch: tx => closeSessionInTransaction(tx, session, at),
        });
        return f.readSession();
      },
      updateActivity: async session => session,
      publish: async () => { calls.publish++; },
    },
    scanner: { inspect: async process => f.observations.get(process.evidence.runId) ?? { state: 'alive', observedAt: at, identity: process } },
    authority: { resolve: async () => ({ kind: 'system' }) },
    transport: {
      close: async () => {
        calls.transport++;
        if (transportFailure) throw new Error('unit transport unavailable');
        if (exitAfterClose) f.exited();
      },
      interrupt: async () => undefined,
      deliver: async () => ({ accepted: true, receiptId: 'z401-unit-receipt' }),
    },
    reminders: { sessionEnded: () => {
      calls.reminders++;
      return {
        allowed: remindersAllowed,
        unfinished: remindersAllowed ? [] : [{ id: 'z401-reminder', createdFor: 'old-agent', assignedTo: 'old-agent', text: 'Review pending', at, binding: null, state: 'active', closedAt: null, closeReason: null }],
      };
    } },
    projects: ['raf'], agentTypes: ['main', 'implement'], agentPhases: ['main', 'implement'],
  };
  const service = new AgentControlService(control);
  return {
    f, lease, calls, preparation, service,
    accept: (value: AcceptedCloseReport | null) => { accepted = value; },
    mismatch: () => { reportMismatch = true; },
    transportFailure: (value: boolean) => { transportFailure = value; },
    finalizeFailure: (value: boolean) => { finalizeFailure = value; },
    remindersAllowed: (value: boolean) => { remindersAllowed = value; },
    exitAfterClose: (value: boolean) => { exitAfterClose = value; },
    denyPreparation: (error: Error) => { preparationError = error; },
  };
}

for (const mode of ['changed', 'deleted', 'renumbered'] as const) {
  test(`R01 ${mode} foreign A does not block B/C or change A ownership`, async t => {
    const f = fixture(t);
    f.source.set('A', mode);
    f.seed();
    const before = f.snapshot();
    const result = await f.claim('independent', [task('B'), task('C')]);
    assert.equal(result.reserved, true);
    assert.deepEqual(listTaskReservations(f.store).find(value => value.lease.owner.runId === oldRun), before.tasks[0]);
    assert.deepEqual(f.readSession(), before.sessions[0]);
    const selected = listTaskReservations(f.store).find(value => value.lease.owner.runId === 'independent');
    assert.deepEqual(selected?.tasks, [task('B'), task('C')]);
    assert.equal(f.effects.reserveLaunch, 1);
    assert.equal(f.effects.acceptedClaims, 1);
    assert.equal(f.snapshot().admission.length, 2);
  });
}

for (const keyField of ['project', 'changeId'] as const) {
  test(`R01 reservation identity includes ${keyField}`, async t => {
    const f = fixture(t);
    f.source.set('A', 'open');
    f.seed();
    const other = task('A');
    const result = await f.claim(`other-${keyField}`, [{ ...other, key: { ...other.key, [keyField]: 'other' } }]);
    assert.equal(result.reserved, true);
    assert.equal(listTaskReservations(f.store).length, 2);
  });
}

for (const guard of ['open-source-unknown', 'liveness-unknown'] as const) {
  test(`R01 independent B/C retain their own ${guard} refusal`, async t => {
    const f = fixture(t);
    f.seed();
    if (guard === 'open-source-unknown') f.source.set('B', 'unavailable');
    else f.observations.set(oldRun, { state: 'unknown', observedAt: at, error: 'unit probe permission denied' });
    const before = f.snapshot();
    const error = await failure(() => f.claim('refused', [task('B'), task('C')]));
    assert.equal(error.code, guard === 'open-source-unknown' ? 'TASK_SOURCE_UNKNOWN' : 'TASK_LIVENESS_UNKNOWN');
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.effects, { reserveLaunch: 0, acceptedClaims: 0 });
  });
}

test('R02 overlapping changed A+B refuses atomically and identifies the original owner', async t => {
  const f = fixture(t);
  f.seed();
  const before = f.snapshot();
  const changed = task('A', { fingerprint: 'current-A' });
  const error = await failure(() => f.claim('overlap', [changed, task('B')]));
  assert.equal(error.code, 'TASK_IDENTITY_MISMATCH');
  for (const text of ['z401-fixture', 'A', 'old-agent', oldRun]) assert.ok(diagnostic(error).includes(text), `Missing diagnostic identity ${text}`);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.effects, { reserveLaunch: 0, acceptedClaims: 0 });
});

test('R02 concurrent A+B requests cannot partially claim free B', async t => {
  const f = fixture(t);
  f.seed();
  const before = f.snapshot();
  const results = await Promise.allSettled([
    f.claim('overlap-1', [task('A', { fingerprint: 'current-A' }), task('B')]),
    f.claim('overlap-2', [task('A', { fingerprint: 'current-A' }), task('B')]),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.code, 'TASK_IDENTITY_MISMATCH');
  }
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.effects, { reserveLaunch: 0, acceptedClaims: 0 });
});

test('R02 concurrent independent B/C requests admit exactly one whole set', async t => {
  const f = fixture(t);
  f.seed();
  const results = await Promise.all([
    f.claim('winner-1', [task('B'), task('C')]), f.claim('winner-2', [task('B'), task('C')]),
  ]);
  assert.equal(results.filter(result => result.reserved).length, 1);
  assert.equal(f.effects.reserveLaunch, 1);
  assert.equal(f.effects.acceptedClaims, 1);
  const claims = listTaskReservations(f.store);
  assert.equal(claims.length, 2);
  assert.equal(claims.filter(value => value.tasks.some(item => item.key.taskId === 'B')).length, 1);
  assert.equal(claims.filter(value => value.tasks.some(item => item.key.taskId === 'C')).length, 1);
});

for (const mode of ['changed', 'deleted', 'unavailable'] as const) {
  test(`R03 dead owner releases without resolving ${mode} original source`, async t => {
    const f = fixture(t);
    f.seed();
    f.source.set('A', mode);
    f.exited();
    const result = await reconcileTaskReservations(f.dependencies);
    assert.ok(result.released.some(owner => owner.runId === oldRun));
    assert.deepEqual(listTaskReservations(f.store), []);
    assert.equal(f.snapshot().admission.length, 0);
    assert.notEqual(f.readSession().result?.status, 'succeeded');
    assert.equal(f.readSession().reportAcceptance, undefined);
  });
}

test('R03 live old guard keeps its lease regardless of age or changed source', async t => {
  const f = fixture(t);
  const lease = f.seed();
  const before = f.snapshot();
  const result = await reconcileTaskReservations(f.dependencies);
  assert.deepEqual(result.released, []);
  assert.ok(result.retained.some(value => value.owner.runId === lease.owner.runId));
  assert.deepEqual(f.snapshot(), before);
});

test('R03 unknown process probe refuses without release or fake occupancy', async t => {
  const f = fixture(t);
  f.seed();
  f.observations.set(oldRun, { state: 'unknown', observedAt: at, error: 'unit process probe unavailable' });
  const before = f.snapshot();
  const error = await failure(() => reconcileTaskReservations(f.dependencies));
  assert.equal(error.code, 'TASK_LIVENESS_UNKNOWN');
  assert.match(diagnostic(error), /probe|unavailable|unknown/i);
  assert.deepEqual(f.snapshot(), before);
});

for (const mismatch of ['boot', 'pid-reuse'] as const) {
  test(`R03 ${mismatch} cannot keep a dead original owner reserved`, async t => {
    const f = fixture(t);
    f.seed();
    if (mismatch === 'boot') f.setBoot({ ...boot, bootId: 'new-boot' });
    else f.observations.set(oldRun, { state: 'alive', observedAt: at, identity: identity('reused-run', { startedAt: at }) });
    await reconcileTaskReservations(f.dependencies);
    assert.deepEqual(listTaskReservations(f.store), []);
    assert.notEqual(f.readSession().result?.status, 'succeeded');
  });
}

for (const stale of ['fence', 'revision', 'runId'] as const) {
  test(`R03 stale ${stale} cannot release the current reservation or close its session`, async t => {
    const f = fixture(t);
    const lease = f.seed('current-run');
    f.exited('current-run');
    const outdated: TaskReservationLease = stale === 'revision'
      ? { ...lease, revision: lease.revision + 1 }
      : { ...lease, owner: { ...lease.owner, [stale]: `old-${stale}` } };
    const before = f.snapshot();
    let closes = 0;
    assert.equal(await releaseTaskReservations(f.dependencies, { lease: outdated, reason: 'failed', closeLaunch: () => { closes++; } }), false);
    assert.equal(closes, 0);
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const accepted of [null, { runId: 'other-run', status: 'succeeded' as const, eventRecorded: true }, { runId: oldRun, status: 'succeeded' as const, eventRecorded: false }]) {
  test(`R04 ordinary close needs accepted current run report plus event: ${JSON.stringify(accepted)}`, async t => {
    const c = closeFixture(t);
    c.accept(accepted);
    const before = c.f.snapshot();
    const error = await failure(() => c.service.close('old-agent'));
    assert.equal(error.code, 'AGENT_RESULT_PENDING');
    assert.deepEqual(c.f.snapshot(), before);
    assert.equal(c.calls.transport, 0);
    assert.equal(c.calls.finalize, 0);
  });
}

test('R04 manual commit and checkbox are not report acceptance', async t => {
  const c = closeFixture(t);
  c.f.source.set('A', 'completed');
  c.f.store.sessionRepository.transaction(tx => {
    tx.putSession({ ...c.f.readSession(), result: { status: 'succeeded', response: 'main reviewed commit', proof: { manualCommit: 'a'.repeat(40), checkbox: true } } });
  });
  const before = c.f.snapshot();
  const error = await failure(() => c.service.close('old-agent'));
  assert.equal(error.code, 'AGENT_RESULT_PENDING');
  assert.deepEqual(c.f.snapshot(), before);
  assert.equal(c.calls.transport, 0);
});

test('R04 supported force bypasses impossible mismatch acceptance, records failed and retains lease before exit', async t => {
  const c = closeFixture(t);
  c.mismatch();
  const prepared = await prepareAgentClose(c.preparation, c.f.readSession(), { force: true, reason });
  assert.equal(prepared.result?.status, 'failed');
  assert.equal(prepared.result?.forcedClose?.reason, reason);
  assert.equal(prepared.reportAcceptance, undefined);
  assert.equal(c.f.readSession().result?.forcedClose?.reason, reason);
  assert.equal(listTaskReservations(c.f.store).length, 1);
  assert.equal(c.calls.transport, 0);
  const event = c.f.snapshot().pending.filter(value => value.runId === oldRun && value.event === 'agent.failed');
  assert.equal(event.length, 1);
  await prepareAgentClose(c.preparation, c.f.readSession(), { force: true, reason: 'later competing reason' });
  assert.equal(c.f.readSession().result?.forcedClose?.reason, reason);
  assert.equal(c.f.snapshot().pending.filter(value => value.runId === oldRun && value.event === 'agent.failed').length, 1);
});

test('R04 force close with mismatch releases only after confirmed exit and finalization', async t => {
  const c = closeFixture(t);
  c.mismatch();
  const result = await c.service.close('old-agent', { force: true, reason });
  assert.equal(result.closed, true);
  assert.equal(c.calls.transport, 1);
  assert.equal(c.calls.finalize, 1);
  assert.deepEqual(listTaskReservations(c.f.store), []);
  assert.equal(c.f.readSession().result?.status, 'failed');
  assert.equal(c.f.readSession().result?.forcedClose?.reason, reason);
  assert.equal(c.f.readSession().reportAcceptance, undefined);
});

for (const options of [{ force: true }, { force: true, reason: ' \t ' }, { reason }]) {
  test(`R04 invalid force/reason is rejected before mutation: ${JSON.stringify(options)}`, async t => {
    const c = closeFixture(t);
    const before = c.f.snapshot();
    await failure(() => c.service.close('old-agent', options));
    assert.deepEqual(c.f.snapshot(), before);
    assert.equal(c.calls.transport, 0);
  });
}

test('R04 force preserves an accepted succeeded and never adds agent.failed', async t => {
  const c = closeFixture(t);
  c.accept({ runId: oldRun, status: 'succeeded', eventRecorded: true });
  c.f.store.sessionRepository.transaction(tx => tx.putSession({
    ...c.f.readSession(), result: { status: 'succeeded', response: 'accepted', proof: {} },
    reportAcceptance: { runId: oldRun, status: 'succeeded', event: 'agent.succeeded' },
  }));
  const result = await prepareAgentClose(c.preparation, c.f.readSession(), { force: true, reason });
  assert.equal(result.result?.status, 'succeeded');
  assert.equal(result.result?.forcedClose?.reason, reason);
  assert.equal(c.f.snapshot().pending.filter(value => value.event === 'agent.failed').length, 0);
});

test('R05 force cannot bypass unfinished reminders', async t => {
  const c = closeFixture(t);
  c.remindersAllowed(false);
  const before = c.f.snapshot();
  const result = await c.service.close('old-agent', { force: true, reason });
  assert.equal(result.closed, false);
  assert.equal(result.unfinished.length, 1);
  assert.equal(c.calls.transport, 0);
  assert.equal(c.calls.finalize, 0);
  assert.deepEqual(c.f.snapshot(), before);
});

test('R05 unknown process identity cannot be forced or release the lease', async t => {
  const c = closeFixture(t);
  c.f.observations.set(oldRun, { state: 'unknown', observedAt: at, error: 'unit process identity unavailable' });
  const before = c.f.snapshot();
  await failure(() => c.service.close('old-agent', { force: true, reason }));
  assert.deepEqual(c.f.snapshot(), before);
  assert.equal(c.calls.transport, 0);
  assert.equal(c.calls.finalize, 0);
});

test('R05 force cannot close main', async t => {
  const c = closeFixture(t);
  c.f.store.sessionRepository.transaction(tx => tx.putSession({
    ...c.f.session('main-run', 'main'), activity: { type: 'main', project: 'raf', features: [], phase: 'main', cwd: '/unit' },
  }));
  const before = c.f.snapshot();
  await failure(() => c.service.close('main', { force: true, reason }));
  assert.deepEqual(c.f.snapshot(), before);
  assert.equal(c.calls.transport, 0);
});

test('R05 a denied authority/preparation port cannot be bypassed by force', async t => {
  const c = closeFixture(t);
  c.denyPreparation(Object.assign(new Error('Main authority denied'), { code: 'AUTHORITY_DENIED' }));
  const before = c.f.snapshot();
  const error = await failure(() => c.service.close('old-agent', { force: true, reason }));
  assert.equal(error.code, 'AUTHORITY_DENIED');
  assert.deepEqual(c.f.snapshot(), before);
  assert.equal(c.calls.transport, 0);
});

for (const stage of ['transport', 'finalize'] as const) {
  test(`R05 ${stage} failure retains lease and durable reason for a safe retry`, async t => {
    const c = closeFixture(t);
    c.transportFailure(stage === 'transport');
    c.finalizeFailure(stage === 'finalize');
    await failure(() => c.service.close('old-agent', { force: true, reason }));
    assert.equal(listTaskReservations(c.f.store).length, 1);
    assert.equal(c.f.readSession().result?.forcedClose?.reason, reason);
    assert.equal(c.f.readSession().reportAcceptance, undefined);
    assert.equal(c.f.snapshot().pending.filter(value => value.event === 'agent.failed').length, 1);
  });
}

test('R05 concurrent force close emits one result and never closes a replacement run', async t => {
  const c = closeFixture(t);
  const results = await Promise.allSettled([
    c.service.close('old-agent', { force: true, reason }),
    c.service.close('old-agent', { force: true, reason }),
  ]);
  assert.equal(c.f.snapshot().pending.filter(value => value.runId === oldRun && value.event === 'agent.failed').length, 1);
  assert.ok(results.some(value => value.status === 'fulfilled' && value.value.closed), 'One close must finish successfully');
  assert.equal(c.calls.finalize, 1);
  c.f.source.set('A', 'open');
  const newLease = c.f.seed('replacement-run', [task('A', { fingerprint: 'current-A' })]);
  const before = c.f.snapshot();
  assert.equal(await releaseTaskReservations(c.f.dependencies, {
    lease: c.lease, reason: 'failed', closeLaunch: tx => tx.deleteSession(newLease.owner.runId),
  }), false);
  assert.deepEqual(c.f.snapshot(), before);
});

for (const options of [['--id'], ['--id', '--force'], ['--id', '--reason']] as const) {
  test(`R06 compiled artifact ${options.join(',')} cannot advertise unavailable force syntax`, async t => {
    const c = closeFixture(t);
    c.preparation.compiledCatalog = catalog(options);
    const before = c.f.snapshot();
    const error = await failure(() => prepareAgentClose(c.preparation, c.f.readSession()));
    assert.equal(error.code, 'AGENT_RESULT_PENDING');
    const text = diagnostic(error);
    assert.doesNotMatch(text, /agent close[^\n]*--force/);
    assert.match(text, /help agent close|agent close --help/);
    assert.match(text, /generation|artifact|поколін|артефакт/i);
    assert.match(text, /activat|updat|актив|онов/i);
    assert.deepEqual(c.f.snapshot(), before);
  });
}

test('R06 aligned artifact offers exact supported close and help without invented reset/reconcile', async t => {
  const c = closeFixture(t);
  const error = await failure(() => prepareAgentClose(c.preparation, c.f.readSession()));
  const text = diagnostic(error);
  assert.match(text, /agent close --id ["']?old-agent["']? --force --reason/);
  assert.match(text, /help agent close|agent close --help/);
  assert.doesNotMatch(text, /agent (reset|reconcile)|UPDATE\s+.*sessions|DELETE\s+FROM/i);
  assert.equal(listTaskReservations(c.f.store).length, 1);
});

test('R07 current assignment can be claimed after confirmed dead owner release', async t => {
  const f = fixture(t);
  f.seed();
  f.exited();
  await reconcileTaskReservations(f.dependencies);
  f.source.set('A', 'open');
  const current = task('A', { fingerprint: 'current-A' });
  const result = await f.claim('new-assignment', [current]);
  assert.equal(result.reserved, true);
  assert.deepEqual(listTaskReservations(f.store).map(value => value.tasks), [[current]]);
});

test('R07 dead runner with protected report confirmation keeps the original lease', async t => {
  const f = fixture(t);
  const lease = f.seed();
  f.exited();
  f.protectedRuns.add(oldRun);
  const before = f.snapshot();
  const result = await reconcileTaskReservations(f.dependencies);
  assert.deepEqual(result.released, []);
  assert.ok(result.retained.some(value => value.owner.runId === lease.owner.runId));
  assert.deepEqual(f.snapshot(), before);
});

test('R07 pending confirmation is not mistaken for an abandoned reservation during claim', async t => {
  const f = fixture(t);
  f.source.set('A', 'open');
  f.seed();
  f.exited();
  f.protectedRuns.add(oldRun);
  const before = f.snapshot();
  const result = await f.claim('second-worker', [task('A')]);
  assert.equal(result.reserved, false);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.effects, { reserveLaunch: 0, acceptedClaims: 0 });
});

for (const parentAlive of [true, false]) {
  test(`R07 child remainder returns only to the same live coordinator: ${parentAlive}`, async t => {
    const f = fixture(t);
    f.source.set('A', 'open');
    const parentLease = f.seed('parent-run', [task('A'), task('B')], 'coordinator');
    f.store.sessionRepository.transaction(tx => {
      const parent = f.readSession('parent-run');
      tx.putSession({ ...parent, activity: { ...parent.activity!, type: 'coordinator' } });
    });
    const child = await f.claim('child-run', [task('A')], 'parent-run');
    assert.equal(child.reserved, true);
    if (!child.reserved) return;
    const handed = await handoffTaskReservations(f.dependencies, { lease: child.lease, wrapper: wrapperIdentity('child-run') });
    assert.ok(handed);
    const started = await startTaskReservations(f.dependencies, { lease: handed, agent: identity('child-run') });
    assert.ok(started);
    f.exited('child-run');
    if (!parentAlive) f.exited('parent-run');
    assert.equal(await releaseTaskReservations(f.dependencies, {
      lease: started, reason: 'failed', closeLaunch: tx => closeSessionInTransaction(tx, f.readSession('child-run'), at),
    }), true);
    await reconcileTaskReservations(f.dependencies);
    const remaining = listTaskReservations(f.store);
    if (parentAlive) {
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].lease.owner.runId, parentLease.owner.runId);
      assert.equal(remaining[0].lease.owner.addressId, 'coordinator');
      assert.deepEqual(remaining[0].tasks.map(value => value.key.taskId).sort(), ['A', 'B']);
      const outsider = await f.claim('outsider', [task('A')]);
      assert.equal(outsider.reserved, false);
    } else assert.deepEqual(remaining, []);
  });
}
