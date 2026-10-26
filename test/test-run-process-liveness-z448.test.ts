import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileTestRunProcess } from '../src/test-run-processes.ts';
import { acknowledgeTestRunDelivery, recoverTestRun } from '../src/test-run-state-recovery.ts';
import { runTestRun } from '../src/test-runs.ts';
import { fixture, group, result, key, originalRunId, otherRunId, processIdentity, unitEntryFixture } from './helpers/state-recovery-fixture.ts';

const input = { key, authorized: true, nowMs: 20000 };

function incompleteGroup() {
  const saved = result({
    outcome: 'setup-failed', failureKinds: ['setup'], errorCode: 'CLEANUP_INCOMPLETE',
    exitCode: 0, passed: [{ file: 'test/fixture.test.ts', name: 'green' }],
    knownRed: [], unexecuted: [], unknown: [],
    cleanup: { complete: false, remainingPids: [] }, groupState: 'reconcile', nextAction: 'reconcile',
  });
  return group({ state: 'reconcile', lastResult: saved, knownRed: [], unexecuted: [], unknown: [],
    delivery: { runId: originalRunId, pending: false, receiptId: null, returned: true, forwardedToMain: false } });
}

test('Z.448 absent root and descendants completes recorded cleanup without changing the original failure', async () => {
  const initial = incompleteGroup();
  const f = fixture(initial);
  f.ports.cleanup = async flight => {
    const observed = await reconcileTestRunProcess(flight.processIdentity, flight.deadlineMs, {
      now: () => input.nowMs, boot: () => 'qa-boot', start: () => null, tree: () => [],
      cleanup: async () => { assert.fail('no signal is needed for an absent process tree'); },
    });
    assert.equal(observed.alive, false);
    assert.equal(observed.deadlineReached, false);
    return observed.cleanup;
  };
  f.ports.returnResult = async () => ({ returned: true });
  const reply = await recoverTestRun(input, f.ports);
  assert.deepEqual(reply.result!.cleanup, { complete: true, remainingPids: [] });
  assert.equal(reply.result!.groupState, 'idle');
  assert.equal(reply.result!.nextAction, 'retry');
  assert.equal(reply.result!.outcome, 'setup-failed');
  assert.equal(reply.result!.errorCode, 'CLEANUP_INCOMPLETE');
  assert.notEqual(reply.cliCode, 0);
  for (const field of ['runId', 'passed', 'knownRed', 'unexecuted', 'unknown', 'exitCode', 'timedOut', 'timeoutCount', 'selection', 'command', 'diagnostics'] as const) {
    assert.deepEqual(reply.result![field], initial.lastResult![field]);
  }
  assert.equal(f.stored!.inFlight, null);
  assert.equal(f.stored!.state, 'idle');
  assert.deepEqual(f.stored!.lastResult, reply.result);
  assert.deepEqual(f.calls.release, [originalRunId]);
  assert.equal((await recoverTestRun(input, f.ports)).result, null);
});

test('Z.448 recovered cleanup is delivered once and a later invocation starts a fresh run', async () => {
  const e = unitEntryFixture(incompleteGroup());
  e.ports.recoverGroup = async groupKey => (await recoverTestRun({ ...input, key: groupKey }, e.f.ports)).result;
  const recovered = await runTestRun(e.request, e.config, e.policy, e.context, e.ports);
  assert.equal(recovered.runId, originalRunId);
  assert.equal(recovered.cleanup.complete, true);
  assert.equal(e.spawns, 0);
  await acknowledgeTestRunDelivery(recovered, e.ports.state);
  const fresh = await runTestRun(e.request, e.config, e.policy, e.context, e.ports);
  assert.equal(fresh.runId, otherRunId);
  assert.equal(fresh.outcome, 'passed');
  assert.equal(fresh.cleanup.complete, true);
  assert.equal(fresh.groupState, 'complete');
  assert.equal(fresh.timeoutCount, 1);
  assert.equal(e.spawns, 1);
});

for (const blocked of ['tree-unknown', 'tree-alive', 'pid-reused', 'cleanup-incomplete', 'release-failed'] as const) {
  test(`Z.448 ${blocked} retains the original reconcile until cleanup and release are verified`, async () => {
    const initial = incompleteGroup();
    const f = fixture(initial);
    if (blocked === 'tree-unknown') f.observation.tree = 'unknown';
    if (blocked === 'tree-alive') f.observation.tree = 'alive';
    if (blocked === 'pid-reused') { f.observation.tree = 'pid-reused'; f.observation.identity = 'reused'; }
    if (blocked === 'cleanup-incomplete') f.ports.cleanup = async () => ({ complete: false, remainingPids: [42002] });
    if (blocked === 'release-failed') f.ports.release = async () => false;
    const reply = await recoverTestRun({ ...input, nowMs: blocked === 'tree-alive' ? 6000 : 20000 }, f.ports);
    assert.ok(f.stored!.inFlight);
    assert.equal(f.stored!.inFlight!.processIdentity, processIdentity);
    assert.equal(f.stored!.state, 'reconcile');
    assert.equal(f.stored!.lastResult!.cleanup.complete, false);
    assert.equal(f.stored!.timeoutCount, 1);
    assert.notEqual(reply.cliCode, 0);
  });
}
