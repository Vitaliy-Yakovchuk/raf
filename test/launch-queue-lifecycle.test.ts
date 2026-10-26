import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { closeSessionInTransaction, createSessionState, type SessionRecord } from '../src/session-state.ts';
import { createProductionAgentQueue } from '../src/production-agent-queue.ts';
import { runProductionModelHandoffs } from '../src/production-model-handoff.ts';
import { observeProcessSnapshot } from '../src/os-runtime.ts';
import { resultAddressee } from '../src/launcher-notice.ts';
import { prepareAgentClose } from '../src/agent-close-preparation.ts';
import { AgentControlService, type AgentControlDependencies } from '../src/agent-control.ts';
import type { RuntimeServices, RuntimeReservationInput, RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';

const start = '2026-10-26T02:57:59.000Z';
const end = '2026-10-26T03:00:00.000Z';
const launcher = { addressId: 'main', runId: 'main-run' };
const identity = { pid: 903789, startedAt: start, runner: 'claude', runnerSessionId: 'native', tmuxSession: 'worker', evidence: { command: 'claude', runId: 'first-run' } };
const assignment = { root: '/fixture', changes: [], baselineArchives: [] };
const activity = { type: 'implement', project: 'raf', features: ['fix-raf-load-admission'], phase: 'implement', cwd: '/fixture' };
const queueRecord = { queueId: 'queue', requestId: 'request', agentId: 'worker', owner: { runId: 'first-run', fence: 'fence' }, clientIdentity: { pid: 1, startedAt: start, machineId: 'machine', bootId: 'boot' }, coordinator: null, eventHandle: null };
function session(): SessionRecord {
  return { runId: 'first-run', addressId: 'worker', state: 'reserved', revision: 0, activity, launchedBy: launcher,
    launchContext: { assignment, selection: { runner: 'claude', model: 'fixture', effort: 'high', reason: 'fixture' }, briefPath: '/fixture/brief', reportPath: '/fixture/report', agentQueue: queueRecord,
      modelRouting: { parameters: { id: 'worker', type: 'implement', project: 'raf', features: [], phase: 'implement', complexity: 'decision', tasks: [] } } } };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-queue-lifecycle-'));
  const path = join(directory, 'state.sqlite');
  const store = openStateStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const current = () => store.sessionRepository.transaction(tx => tx.getSession('first-run'), 'read');
  return { directory, path, store, current };
}

for (const outcome of ['refused', 'succeeded'] as const) {
  test(`10.1 terminal queued ${outcome} does not schedule another launch`, t => {
    const f = fixture(t);
    const row = session();
    if (outcome === 'refused') row.abortReason = 'Runner readiness timeout';
    else row.result = { status: 'succeeded', response: 'done', proof: null };
    f.store.sessionRepository.transaction(tx => { tx.putSession(row); closeSessionInTransaction(tx, row, end); });
    assert.equal(f.current()?.state, 'finished');
    assert.equal(f.current()?.modelHandoff, undefined);
    assert.equal(f.current()?.successorRunId, undefined);
    assert.deepEqual(resultAddressee(f.current()!), launcher);
  });
}

test('10.1 deliberate quota handoff retains the request author after closure', t => {
  const f = fixture(t);
  const row = session();
  row.launchContext!.modelRouting!.cause = { status: 'limited', reason: 'confirmed quota exhausted' };
  f.store.sessionRepository.transaction(tx => { tx.putSession(row); closeSessionInTransaction(tx, row, end); });
  assert.ok(f.current()?.modelHandoff);
  assert.deepEqual(f.current()?.launchedBy, launcher);
});

test('10.1 legacy refused startup handoff cannot be replayed by another command', async t => {
  const f = fixture(t);
  const row = session();
  row.state = 'finished';
  row.finishedAt = end;
  row.abortReason = 'Runner readiness timeout';
  row.modelHandoff = { activity, launchContext: row.launchContext! };
  f.store.sessionRepository.transaction(tx => tx.putSession(row));
  let launchPreparation = 0;
  const result = await runProductionModelHandoffs({ store: f.store, context: {} as RuntimeContext,
    loadConfiguration: async () => { launchPreparation++; throw new Error('unrelated command must not prepare a launch'); },
    createServices: async () => { throw new Error('must not launch'); }, inspect: async () => { throw new Error('must not inspect'); }, assignmentPorts: {} as never });
  assert.equal(launchPreparation, 0);
  assert.equal(result.some(row => row.status === 'started'), false);
  assert.equal(f.current()?.modelHandoff, undefined);
});

test('10.1 queue rechecks retain the original launcher after caller changes', async t => {
  const f = fixture(t);
  f.store.sessionRepository.transaction(tx => tx.putSession({ runId: launcher.runId, addressId: launcher.addressId, revision: 0, state: 'running' }));
  let caller = launcher.runId;
  const claims: unknown[] = [];
  const input = { runId: 'new-run', addressId: 'worker', tmuxSession: 'worker', activity, assignment,
    selection: { status: 'selected', runner: 'claude', model: 'fixture', effort: 'high', reason: 'fixture', quota: 'unknown' },
    statePath: f.path, tmpRoot: f.directory, reportPath: '/fixture/report', requested: { ramBytes: 0, diskBytes: {} }, requiredFileSystemIds: [] } as RuntimeReservationInput;
  const queue = await createProductionAgentQueue(input, { store: f.store,
    context: { statePath: f.path } as RuntimeContext, api: { reserve: async value => { claims.push(value.queueClaim!.record); return { admitted: false, waiting: true, admission: { level: 'NO_RESOURCES' } }; } } as RuntimeServices,
    configuration: {} as RuntimeConfiguration, current: runId => f.store.sessionRepository.transaction(tx => tx.getSession(runId), 'read'), caller: async () => caller,
    observe: async () => { throw new Error('no active worker'); }, reconcile: async () => {}, cleanReport: async () => {} });
  caller = 'unrelated-hotfix-run';
  const validation = { assignment, fingerprint: 'fixture', requested: input.requested, requiredFileSystemIds: [] };
  const first = await queue.ports.claimAndAdmit({ request: queue.request, validation, tier: 'normal' });
  assert.notEqual(first.kind, 'refused');
  await queue.ports.recheckAndReserve({ record: (first as any).record, validation, tier: 'normal', permit: { requestId: 'permit', serviceEpoch: 'epoch', grantedAt: 1 } });
  assert.equal(claims.length, 2);
  for (const claim of claims) assert.deepEqual((claim as any).launcher, launcher);
});

test('10.1 an older process snapshot cannot pronounce a newly started native process dead', async () => {
  const snapshot = await observeProcessSnapshot({ now: () => '2026-10-26T02:57:30.000Z', execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  assert.equal(snapshot([identity])[0].state, 'unknown');
});

test('10.1 stale exit observation cannot finish a session or publish agent.failed', t => {
  const f = fixture(t);
  const row = { ...session(), state: 'running' as const, process: identity };
  f.store.sessionRepository.transaction(tx => tx.putSession(row));
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => false });
  assert.equal(state.commitObservation(row.runId, row.revision, { state: 'exited', observedAt: '2026-10-26T02:57:30.000Z', exitCode: null, evidence: 'old scan' },
    { pending: [{ id: 'failure', runId: row.runId, event: 'agent.failed', payload: {} }], domain: [] }), false);
  assert.equal(f.current()?.state, 'running');
  assert.deepEqual(state.listPending(), []);
});

test('10.1 force close of falsely exited session stops its verified live native process before finalization', async t => {
  const f = fixture(t);
  let live = true;
  const events: string[] = [];
  const row = { ...session(), state: 'exited' as const, process: identity };
  f.store.sessionRepository.transaction(tx => tx.putSession(row));
  const put = (row: SessionRecord) => { f.store.sessionRepository.transaction(tx => tx.putSession(row)); return row; };
  const control = new AgentControlService({ repository: f.store.sessionRepository,
    scanner: { inspect: async () => live ? { state: 'alive', observedAt: end, identity } : { state: 'exited', observedAt: end, exitCode: null, evidence: 'stopped' } },
    coordinator: { acceptPendingReport: async row => row, prepareClose: async (row, options) => { assert.equal(options.force, true); events.push('prepare'); return row; },
      finalize: async row => { assert.equal(live, false, 'live runner must be stopped before waiting for worker finalization'); events.push('finalize'); return put({ ...row, state: 'finished', finishedAt: end }); },
      observe: async row => row, publish: async () => {}, updateActivity: async row => row },
    authority: { resolve: async () => ({ kind: 'system' }) },
    transport: { close: async actual => { assert.deepEqual(actual, identity); events.push('stop'); live = false; }, deliver: async () => ({ accepted: true, receiptId: 'fixture' }), interrupt: async () => {} },
    reminders: { sessionEnded: () => ({ allowed: true, unfinished: [] }) }, projects: ['raf'], agentTypes: ['implement'] } as AgentControlDependencies);
  const result = await control.close('worker', { force: true, reason: 'recover stale exit' });
  assert.equal(result.closed, true);
  assert.deepEqual(events, ['prepare', 'stop', 'finalize']);
});

test('10.1 forced close preparation accepts the selected exited identity and records the owner reason', async t => {
  const f = fixture(t);
  const row = { ...session(), state: 'exited' as const, process: identity };
  f.store.sessionRepository.transaction(tx => tx.putSession(row));
  const prepared = await prepareAgentClose({ repository: f.store.sessionRepository, acceptPendingReport: async row => row,
    acceptedReport: () => null, eventForStatus: () => 'agent.failed' }, row, { force: true, reason: 'recover stale exit' });
  assert.equal(prepared.state, 'exited');
  assert.deepEqual(prepared.result?.forcedClose, { reason: 'recover stale exit' });
});
