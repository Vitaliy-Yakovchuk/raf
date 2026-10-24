import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmAgySessionStart } from '../src/agy-session-start.ts';
import type { NativeIdentity, SessionStartBindingPorts, SessionStartOrigin } from '../src/agy-session-start.ts';
import type { ProcessIdentity, SessionRecord, SessionRepository } from '../src/session-state.ts';
import { openSessionRepository } from '../src/session-repository.ts';
import { createSessionState } from '../src/session-state.ts';
import { bindingRequest, nativeId, otherNativeId, now, pending, processIdentity, runId, sessionRecord } from './fixtures/agy-session-start.ts';

function fixture(t: TestContext, initial = sessionRecord()) {
  const directory = mkdtempSync(join(tmpdir(), 'q411-state-'));
  const path = join(directory, 'sessions.sqlite');
  let handle = openSessionRepository(path);
  t.after(() => { handle.close(); rmSync(directory, { recursive: true, force: true }); });
  handle.repository.transaction(tx => {
    tx.putSession(initial);
    tx.putReservation({ runId, resource: 'q411-claim', amount: 1 });
  });
  const request = bindingRequest();
  const diagnostics: string[] = [];
  const origin: SessionStartOrigin = {
    runId: request.runId, workspace: request.workspace, process: structuredClone(request.process),
    writerGeneration: request.writerGeneration,
  };
  const repository: SessionRepository = { transaction: (action, mode) => handle.repository.transaction(action, mode) };
  const ports: SessionStartBindingPorts = {
    repository, verifyOrigin: async () => structuredClone(origin),
    inspectProcess: async identity => ({ state: 'alive', observedAt: now, identity: structuredClone(identity) }),
    now: () => now, diagnostic: reason => { diagnostics.push(reason); },
  };
  return {
    request, ports, origin, diagnostics, repository,
    read: () => repository.transaction(tx => structuredClone(tx.getSession(runId)!)),
    reopen: () => { handle.close(); handle = openSessionRepository(path); },
  };
}

function native(identity: ProcessIdentity | undefined): NativeIdentity | undefined {
  return (identity as unknown as { nativeIdentity?: NativeIdentity } | undefined)?.nativeIdentity;
}

function assertConfirmed(record: SessionRecord) {
  assert.equal(record.process!.runnerSessionId, nativeId);
  assert.deepEqual(native(record.process), { state: 'confirmed', id: nativeId, source: 'session_start', observedAt: now });
  if (record.observation?.state === 'alive') {
    assert.equal(record.observation.identity.runnerSessionId, nativeId);
    assert.deepEqual(native(record.observation.identity), native(record.process));
  }
}

test('I1 durable state: pending is explicitly null and survives reopening without synthesizing an ID', t => {
  const f = fixture(t);
  f.reopen();
  assert.equal(f.read().process!.runnerSessionId, null);
  assert.deepEqual(native(f.read().process), pending);
  assert.notEqual(f.read().process!.runnerSessionId, runId);
});

test('I4 trusted confirmation atomically persists both identity fields and preserves launch claims', async t => {
  const f = fixture(t);
  const before = f.read();
  const reservations = f.repository.transaction(tx => structuredClone(tx.listReservations()));
  const writes: SessionRecord[] = [];
  const realRepository = f.ports.repository;
  f.ports.repository = {
    transaction: (action, mode) => realRepository.transaction(tx => action(new Proxy(tx, {
      get(target, key) {
        if (key === 'putSession') return (record: SessionRecord) => { writes.push(structuredClone(record)); target.putSession(record); };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })), mode),
  };
  assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'confirmed');
  assert.equal(writes.length, 1);
  assertConfirmed(writes[0]);
  f.reopen();
  const after = f.read();
  assertConfirmed(after);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.launchContext, before.launchContext);
  assert.deepEqual(after.activity, before.activity);
  assert.equal(after.addressId, before.addressId);
  assert.equal(after.runId, before.runId);
  assert.equal(after.state, before.state);
  assert.deepEqual({ ...after.process, runnerSessionId: null, nativeIdentity: pending }, before.process);
  assert.deepEqual(f.repository.transaction(tx => tx.listReservations()), reservations);
});

test('I5 duplicate native ID is idempotent across a reopened repository', async t => {
  const f = fixture(t, sessionRecord(nativeId));
  const before = f.read();
  f.reopen();
  assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'duplicate');
  assert.deepEqual(f.read(), before);
});

test('I5 a conflicting native UUID never overwrites confirmed identity', async t => {
  const f = fixture(t, sessionRecord(nativeId));
  f.request.payload = { hook_event_name: 'SessionStart', conversationId: otherNativeId };
  const before = f.read();
  const result = await confirmAgySessionStart(f.request, f.ports);
  assert.equal(result.status, 'rejected');
  assert.deepEqual(f.read(), before);
  assert.ok(f.diagnostics.some(reason => reason.trim()));
});

for (const payload of [null, [], {}, { conversationId: '' }, { conversationId: '   ' },
  { conversationId: 'not-a-uuid' }, { conversationId: 123 }, { conversationId: runId + '-extra' }]) {
  test(`I5 malformed native payload ${JSON.stringify(payload)} is diagnosed without mutation`, async t => {
    const f = fixture(t);
    f.request.payload = payload;
    const before = f.read();
    assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'rejected');
    assert.deepEqual(f.read(), before);
    assert.ok(f.diagnostics.some(reason => reason.trim()));
  });
}

const foreign: [string, (origin: SessionStartOrigin) => void][] = [
  ['run', origin => { origin.runId = 'foreign-run'; }],
  ['workspace', origin => { origin.workspace += '-other'; }],
  ['PID', origin => { origin.process.pid++; }],
  ['process start', origin => { origin.process.startedAt = '2026-10-24T07:59:00.000Z'; }],
  ['machine', origin => { origin.process.evidence = { ...origin.process.evidence, machineId: 'foreign' }; }],
  ['boot', origin => { origin.process.evidence = { ...origin.process.evidence, bootId: 'foreign' }; }],
  ['argv', origin => { origin.process.evidence = { ...origin.process.evidence, command: 'foreign executable' }; }],
  ['executable', origin => { origin.process.evidence = { ...origin.process.evidence, executable: '/foreign/agy' }; }],
  ['tmux socket', origin => { origin.process.evidence = { ...origin.process.evidence, tmuxSocket: '/foreign/socket' }; }],
  ['tmux session', origin => { origin.process.tmuxSession += '-foreign'; }],
  ['tmux pane', origin => { origin.process.evidence = { ...origin.process.evidence, tmuxPane: '%99' }; }],
  ['stale writer generation', origin => { origin.writerGeneration += '-stale'; }],
];
for (const [label, mutate] of foreign) {
  test(`I5 foreign ${label} cannot bind even with matching JSON runId and workspace`, async t => {
    const f = fixture(t);
    f.request.payload = { hook_event_name: 'SessionStart', conversationId: nativeId, runId, workspace: f.request.workspace };
    mutate(f.origin);
    const before = f.read();
    assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'rejected');
    assert.deepEqual(f.read(), before);
    assert.ok(f.diagnostics.some(reason => reason.trim()));
  });
}

test('I5 JSON fields, transcript path, timestamp and UUID do not authenticate an untrusted writer', async t => {
  const f = fixture(t);
  f.request.payload = { conversationId: nativeId, runId, workspacePaths: [f.request.workspace], transcriptPath: '/newest/transcript', timestamp: now };
  f.ports.verifyOrigin = async () => null;
  const before = f.read();
  assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'rejected');
  assert.deepEqual(f.read(), before);
  assert.ok(f.diagnostics.length);
});

for (const state of ['exited', 'finished'] as const) {
  test(`I5 SessionStart after ${state} never revives the record`, async t => {
    const record = sessionRecord();
    record.state = state;
    const f = fixture(t, record);
    const before = f.read();
    assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'rejected');
    assert.deepEqual(f.read(), before);
  });
}

for (const status of ['unknown', 'exited', 'reused-pid'] as const) {
  test(`I5 OS ownership ${status} prevents binding a plausible native event`, async t => {
    const f = fixture(t);
    f.ports.inspectProcess = async () => status === 'unknown'
      ? { state: 'unknown', observedAt: now, error: 'owner unavailable' }
      : status === 'exited' ? { state: 'exited', observedAt: now, exitCode: 0, evidence: 'owned process exited' }
      : { state: 'alive', observedAt: now, identity: { ...processIdentity(), startedAt: '2026-10-24T08:02:00.000Z' } };
    const before = f.read();
    assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'rejected');
    assert.deepEqual(f.read(), before);
  });
}

test('I4 stale expected revision cannot overwrite a concurrent report or cleanup', async t => {
  const f = fixture(t);
  f.repository.transaction(tx => tx.putSession({ ...tx.getSession(runId)!, revision: 6, state: 'exited' }));
  const before = f.read();
  assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'rejected');
  assert.deepEqual(f.read(), before);
});

test('I4 cleanup between origin verification and atomic update wins over native confirmation', async t => {
  const f = fixture(t);
  f.ports.inspectProcess = async identity => {
    f.repository.transaction(tx => {
      const current = tx.getSession(runId)!;
      tx.putSession({ ...current, revision: current.revision + 1, state: 'exited' });
    });
    return { state: 'alive', observedAt: now, identity };
  };
  assert.equal((await confirmAgySessionStart(f.request, f.ports)).status, 'rejected');
  assert.equal(f.read().state, 'exited');
  assert.equal(f.read().process!.runnerSessionId, null);
});

test('I4 simultaneous different native events cannot publish torn or conflicting state', async t => {
  const f = fixture(t);
  const other = { ...f.request, payload: { conversationId: otherNativeId } };
  const results = await Promise.all([
    confirmAgySessionStart(f.request, f.ports), confirmAgySessionStart(other, f.ports),
  ]);
  assert.equal(results.filter(result => result.status === 'confirmed').length, 1);
  const record = f.read();
  const identity = native(record.process)!;
  assert.equal(identity.state, 'confirmed');
  assert.equal(identity.id, record.process!.runnerSessionId);
  assert.ok([nativeId, otherNativeId].includes(identity.id!));
  assert.equal(record.revision, 6);
});

for (const runner of ['codex', 'claude', 'grok'] as const) {
  test(`I3 durable compatibility: existing ${runner} native ID needs no SessionStart metadata`, t => {
    const record = sessionRecord(nativeId);
    record.process!.runner = runner;
    delete (record.process as unknown as { nativeIdentity?: unknown }).nativeIdentity;
    const f = fixture(t, record);
    f.reopen();
    assert.equal(f.read().process!.runnerSessionId, nativeId);
    assert.equal(native(f.read().process), undefined);
  });
}

test('I1 session lifecycle commits the pending process into the current durable running record', t => {
  const f = fixture(t);
  f.repository.transaction(tx => { tx.deleteSession(runId); tx.deleteReservation(runId); });
  const state = createSessionState({ repository: f.repository, verifyMainAuthority: () => false, verifyWorkResult: () => true });
  state.reserveLaunch('q411-agent', runId, sessionRecord().activity!, { resource: 'q411-claim', amount: 1 });
  assert.equal(state.commitStarted(runId, processIdentity()), true);
  f.reopen();
  assert.equal(f.read().state, 'running');
  assert.equal(f.read().process!.runnerSessionId, null);
  assert.deepEqual(native(f.read().process), pending);
  assert.ok(state.listReconciliationCandidates().some(record => record.runId === runId));
});

test('I6 a separately verified succeeded result is accepted while native identity stays pending', t => {
  const f = fixture(t);
  const state = createSessionState({ repository: f.repository, verifyMainAuthority: () => false, verifyWorkResult: () => true });
  assert.equal(state.acceptWorkResult(runId, { status: 'succeeded', response: 'Verified independent report', proof: { verified: true } }, {
    pending: [], domain: [], reportAccepted: true,
  }), true);
  f.reopen();
  assert.equal(f.read().result!.status, 'succeeded');
  assert.equal(f.read().process!.runnerSessionId, null);
  assert.deepEqual(native(f.read().process), pending);
});
