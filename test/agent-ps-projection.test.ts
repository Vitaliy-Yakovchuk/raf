import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentControlService } from '../src/agent-control.ts';
import { failureContext } from '../src/cli-contract.ts';
import type { SessionRecord } from '../src/session-state.ts';
import { assertNoSource, expectedOwnContext, fullLaunchContext, projectionFixture, sourceForms, syntheticSource } from './agent-ps-projection-fixture.ts';

for (const role of ['test-scaffold', 'main', 'implement']) {
  test(`Z398.S01 exact own leaf allowlist for verified ${role}`, async t => {
    const f = await projectionFixture(t);
    const own = f.seed('own', 'own-run', role);
    f.caller(own);
    const rows = await f.ps();
    assert.deepEqual(rows.find(row => row.runId === own.runId)?.launchContext, expectedOwnContext);
    assertNoSource(JSON.stringify(rows));
  });
}

for (const role of ['test-scaffold', 'main']) {
  test(`Z398.S02 foreign contexts omitted with addresses and state retained for ${role}`, async t => {
    const f = await projectionFixture(t);
    const own = f.seed('own', 'own-run', role);
    const foreign = f.seed('foreign');
    f.caller(own);
    const rows = await f.ps();
    assert.deepEqual(rows.map(row => [row.addressId, row.runId, row.state]), [
      [own.addressId, own.runId, own.state], [foreign.addressId, foreign.runId, foreign.state],
    ]);
    assert.deepEqual(rows[1].activity, foreign.activity);
    assert.equal(Object.hasOwn(rows[1], 'launchContext'), false, 'Foreign launchContext must be absent, including an empty object');
    assert.equal(rows[1].observation?.state, 'alive');
  });
}

test('Z398.S03 reused address does not grant the previous run context', async t => {
  const f = await projectionFixture(t);
  const previous = f.seed('reused-address', 'previous-run');
  previous.state = 'finished';
  previous.finishedAt = '2026-10-25T00:00:01.000Z';
  f.put(previous);
  const current = f.seed('reused-address', 'current-run');
  current.launchContext!.selection.model = 'current-model';
  f.put(current);
  f.caller(current);
  const rows = await f.ps();
  assert.deepEqual(rows.map(row => row.runId), ['current-run']);
  assert.deepEqual(rows[0].launchContext, { ...expectedOwnContext,
    selection: { ...expectedOwnContext.selection, model: 'current-model' } });
  assert.deepEqual(f.get(previous).launchContext, previous.launchContext);
});

for (const claim of [undefined, { runId: 'own-run', addressId: 'own', session_name: 'own', verified: true }, { kind: 'agent', runId: 'own-run' }]) {
  test(`Z398.S03 unverified caller claim ${claim === undefined ? 'absent' : Object.hasOwn(claim, 'kind') ? 'sender' : 'environment'} grants no context`, async t => {
    const f = await projectionFixture(t);
    f.seed('own'); f.seed('foreign');
    f.caller(undefined, claim);
    const rows = await f.ps();
    assert.equal(rows.length, 2, 'Unverified caller can retain addressability');
    assert.ok(rows.every(row => !Object.hasOwn(row, 'launchContext')));
    assertNoSource(JSON.stringify(rows));
  });
}

test('Z398.S03 verified caller outranks a claimed foreign run ID', async t => {
  const f = await projectionFixture(t);
  const own = f.seed('own'); const foreign = f.seed('foreign');
  f.caller(own, { runId: foreign.runId, addressId: foreign.addressId });
  const rows = await f.ps();
  assert.deepEqual(rows.find(row => row.runId === own.runId)?.launchContext, expectedOwnContext);
  assert.equal(Object.hasOwn(rows.find(row => row.runId === foreign.runId)!, 'launchContext'), false);
});

test('Z398.S04 raw escaped and encoded synthetic runtime hook never survives serialization', async t => {
  const f = await projectionFixture(t);
  const own = f.seed('own');
  f.caller(own);
  assertNoSource(JSON.stringify(await f.ps()));
});

for (const channel of ['modelHandoff', 'result.proof', 'process.evidence.command', 'observation', 'futureContainer']) {
  test(`Z398.S05 source cannot escape through ${channel}`, async t => {
    const f = await projectionFixture(t);
    const own = f.seed('own');
    f.caller(own);
    own.launchContext = {
      selection: { ...expectedOwnContext.selection, reason: 'fixture selection' },
      assignment: { root: f.directory, baselineArchives: [], changes: [] },
      briefPath: `${f.directory}/brief.md`, reportPath: `${f.directory}/absent.json`,
    };
    if (channel === 'modelHandoff') own.modelHandoff = { activity: own.activity!, launchContext: fullLaunchContext(f.directory), reason: syntheticSource };
    if (channel === 'result.proof') own.result = { status: 'succeeded', response: syntheticSource, proof: { nested: sourceForms } };
    if (channel === 'process.evidence.command') {
      const command = `node -e ${JSON.stringify(syntheticSource)}`;
      own.process!.evidence = { ...own.process!.evidence, command, futureEvidence: sourceForms.join(' ') };
      f.processes.get(own.process!.pid)!.command = command;
    }
    if (channel === 'observation') Object.assign(own.process!, { futureObservationEvidence: sourceForms });
    if (channel === 'futureContainer') Object.assign(own, { futureContainer: { nested: sourceForms } });
    f.put(own);
    const before = structuredClone(f.get(own));
    const rows = await f.ps();
    assertNoSource(JSON.stringify(rows));
    assert.deepEqual(f.get(own).launchContext, before.launchContext, 'Projection preserves durable source context');
    if (own.result) assert.deepEqual(f.get(own).result, own.result);
    if (own.modelHandoff) assert.deepEqual(f.get(own).modelHandoff, own.modelHandoff);
    if (channel === 'futureContainer') assert.equal(Object.hasOwn(rows[0], 'futureContainer'), false);
  });
}

test('Z398.S05 reconciliation error never includes raw source or fallback record', async t => {
  const f = await projectionFixture(t);
  f.seed('own'); f.scanError();
  try { assertNoSource(JSON.stringify(await f.ps())); }
  catch (error) {
    if ((error as Error).name === 'AssertionError') throw error;
    const failure = failureContext(error);
    assert.ok(failure?.code, 'A reconciliation refusal retains its safe error code');
    assertNoSource(JSON.stringify(failure), String(error));
  }
});

for (const [index, encoded] of sourceForms.entries()) {
  test(`Z398.S05 encoded-only proof form ${index} is omitted without a plaintext copy`, async t => {
    const f = await projectionFixture(t);
    const own = f.seed('encoded');
    delete own.launchContext;
    own.result = { status: 'succeeded', response: 'fixture response', proof: { encoded } };
    f.put(own); f.caller(own);
    const rows = await f.ps();
    assertNoSource(JSON.stringify(rows));
    assert.deepEqual(f.get(own).result, own.result);
  });
}

test('Z398.S06 old records omit missing allowed leaves without reconstructing sources', async t => {
  const f = await projectionFixture(t);
  const own = f.seed('old');
  own.launchContext = { selection: { model: 'old-model', future: syntheticSource }, assignment: { changes: [
    { id: 'old-change', items: [{ id: 'old-item', description: syntheticSource }] },
  ], root: syntheticSource }, future: sourceForms } as unknown as SessionRecord['launchContext'];
  f.put(own); f.caller(own);
  assert.deepEqual((await f.ps())[0].launchContext, {
    selection: { model: 'old-model' }, assignment: { changes: [{ id: 'old-change', items: [{ id: 'old-item' }] }] },
  });
});

test('Z398.S06 a session without launch metadata stays absent and addressable', async t => {
  const f = await projectionFixture(t);
  const own = f.seed('legacy'); delete own.launchContext;
  f.put(own); f.caller(own);
  const rows = await f.ps();
  assert.equal(rows[0].runId, own.runId);
  assert.equal(Object.hasOwn(rows[0], 'launchContext'), false);
  assert.equal(Object.hasOwn(f.get(own), 'launchContext'), false);
});

test('Z398.S07 repeated public ps retains internal report identity reservation and context', async t => {
  const f = await projectionFixture(t);
  const own = f.seed('own');
  own.result = { status: 'succeeded', response: syntheticSource, proof: { report: sourceForms } };
  own.reportAcceptance = { runId: own.runId, status: 'succeeded', event: 'agent.succeeded' };
  f.put(own); f.caller(own);
  const original = structuredClone(f.get(own));
  const reservations = f.store.sessionRepository.transaction(tx => tx.listReservations());
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await f.ps();
    const current = f.get(own);
    assert.deepEqual(current.launchContext, original.launchContext);
    assert.deepEqual(current.process, original.process);
    assert.deepEqual(current.result, original.result);
    assert.deepEqual(current.reportAcceptance, original.reportAcceptance);
    assert.equal(current.observation?.state, 'alive', 'Reconciliation still commits observation');
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), reservations);
    assertNoSource(JSON.stringify(rows));
  }
});

test('Z398.S07 WORKER_RESULT_PENDING remains retryable without losing full internal context', async t => {
  const f = await projectionFixture(t);
  const own = f.seed('own');
  const wrapper = f.seed('wrapper');
  own.launchContext!.wrapper = wrapper.process;
  f.put(own); f.caller(wrapper);
  f.processes.delete(own.process!.pid);
  const before = structuredClone(f.get(own));
  const reservations = f.store.sessionRepository.transaction(tx => tx.listReservations());
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await f.ps();
    const pending = rows.find(row => row.runId === own.runId) as SessionRecord & { reconciliation?: { code: string } };
    assert.equal(pending?.reconciliation?.code, 'WORKER_RESULT_PENDING');
    assert.equal(pending.addressId, own.addressId);
    assert.deepEqual(f.get(own), before);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), reservations);
    assertNoSource(JSON.stringify(rows));
  }
});

test('Z398.S07 internal reconciliation accepts a report with full context before public projection', async t => {
  const f = await projectionFixture(t);
  const own = f.seed('own'); f.caller(own);
  const original = structuredClone(own.launchContext);
  let acceptCalls = 0;
  const result = { status: 'succeeded', response: syntheticSource, proof: { source: syntheticSource } };
  const unused = async (): Promise<never> => { throw new Error('Unexpected lifecycle operation in report fixture'); };
  const control = new AgentControlService({
    repository: f.store.sessionRepository,
    scanner: { inspect: async identity => ({ state: 'alive', observedAt: identity.startedAt, identity }) },
    authority: { resolve: async () => ({ kind: 'agent', runId: own.runId }) },
    transport: { deliver: unused, close: unused, interrupt: unused },
    reminders: { sessionEnded: () => ({ allowed: true, unfinished: [] }) }, projects: ['raf'], agentTypes: ['test-scaffold'],
    coordinator: {
      prepareClose: unused, updateActivity: unused, finalize: unused, publish: unused,
      async acceptPendingReport(row) {
        acceptCalls++;
        assert.deepEqual(row.launchContext, original, 'Report processing receives unprojected launch data');
        const accepted = { ...row, result, reportAcceptance: { runId: row.runId, status: 'succeeded', event: 'agent.succeeded' } };
        f.put(accepted); return accepted;
      },
      async observe(row, observation) {
        assert.deepEqual(row.launchContext, original);
        const updated = { ...row, observation }; f.put(updated); return updated;
      },
    },
  });
  const internal = await control.ps();
  assert.equal(acceptCalls, 1);
  assert.deepEqual(internal[0].launchContext, original, 'Internal ps consumers keep the full record');
  assert.deepEqual(f.get(own).result, result);
  assert.deepEqual(f.get(own).launchContext, original);
  assertNoSource(JSON.stringify(await f.ps()));
  assert.equal(acceptCalls, 1, 'Public repeat does not reaccept an already accepted report');
  assert.deepEqual(f.get(own).launchContext, original);
});
