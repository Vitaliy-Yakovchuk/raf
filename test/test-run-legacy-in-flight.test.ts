import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRun } from '../src/test-runs.ts';
import { runTestRunCli } from '../src/test-run-cli.ts';
import {
  recoverTestRun, type RecoveryGroup, type StateRecoveryResult,
} from '../src/test-run-state-recovery.ts';
import {
  fixture, group, key, originalRunId, otherRunId, processIdentity,
  red, remainder, unknown, unitEntryFixture,
} from './helpers/state-recovery-fixture.ts';

const deadlineMs = 11000;
const expired = { key, authorized: true, nowMs: deadlineMs + 1 };

function legacyGroup(): RecoveryGroup {
  return JSON.parse(JSON.stringify({
    ...group(),
    inFlight: { runId: originalRunId, deadlineMs, processIdentity },
  }));
}

function legacyFixture() {
  const f = fixture(legacyGroup());
  f.observation.owner = 'unknown';
  f.observation.finishedAtMs = null;
  f.observation.deadlineObservedAtMs = null;
  return f;
}

function preserved(result: StateRecoveryResult) {
  assert.equal(result.runId, originalRunId);
  assert.equal(result.timeoutCount, 1);
  assert.deepEqual(result.knownRed, red);
  assert.deepEqual(result.unexecuted, remainder);
  assert.deepEqual(result.unknown, unknown);
  assert.equal(result.outcome, 'setup-failed');
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.nextAction, 'reconcile');
  assert.equal(result.groupSnapshot, 'loaded');
  assert.equal(result.groupState, 'reconcile');
  assert.ok(result.diagnostics.some(d => Boolean(d.unavailableReason)));
}

test('Z410 persisted legacy fixture has only runId/deadlineMs/processIdentity in inFlight', () => {
  assert.deepEqual(Object.keys(legacyGroup().inFlight!).sort(), ['deadlineMs', 'processIdentity', 'runId']);
});

for (const nowMs of [deadlineMs, deadlineMs + 1, deadlineMs * 10]) {
  test(`Z410 legacy verified dead tree at now=${nowMs} recovers the original result without a new timeout`, async () => {
    const f = legacyFixture();
    const reply = await recoverTestRun({ ...expired, nowMs }, f.ports);
    assert.ok(reply.result, 'a missing legacy owner must not block a verified dead tree after its saved deadline');
    preserved(reply.result);
    assert.equal(reply.result.phase, 'recovery');
    assert.deepEqual(reply.result.selection, legacyGroup().selection);
    assert.notEqual(reply.cliCode, 0);
    assert.equal(f.stored!.inFlight, null);
    assert.equal(f.stored!.timeoutCount, 1);
    assert.deepEqual(f.stored!.knownRed, red);
    assert.deepEqual(f.stored!.unexecuted, remainder);
    assert.deepEqual(f.stored!.lastResult, reply.result);
    assert.deepEqual(f.calls.release, [originalRunId]);
    assert.equal(f.stored!.delivery!.runId, originalRunId);
    assert.equal(f.stored!.delivery!.pending, true);
  });
}

test('Z410 concurrent and repeated legacy recovery commits/releases once and returns the same pending result', async () => {
  const f = legacyFixture();
  const releases: string[] = [];
  f.ports.release = async (runId, identity) => {
    assert.equal(identity, processIdentity);
    assert.equal(f.stored!.lastResult!.runId, originalRunId, 'persist recovery before releasing its resource fence');
    releases.push(runId);
    return true;
  };
  const replies = await Promise.all([
    recoverTestRun(expired, f.ports),
    recoverTestRun(expired, f.ports),
  ]);
  assert.ok(replies[0].result, 'legacy recovery must produce a durable result');
  preserved(replies[0].result);
  assert.deepEqual(replies[1].result, replies[0].result);
  const again = await recoverTestRun({ ...expired, nowMs: deadlineMs * 10 }, f.ports);
  assert.deepEqual(again.result, replies[0].result);
  assert.equal(f.calls.cleanup.length, 1);
  assert.deepEqual(releases, [originalRunId]);
  assert.equal(f.stored!.timeoutCount, 1);
  assert.equal(f.stored!.inFlight, null);
});

for (const scenario of [
  { name: 'dead before deadline', tree: 'dead', nowMs: deadlineMs - 1, identity: processIdentity },
  { name: 'alive before deadline', tree: 'alive', nowMs: deadlineMs - 1, identity: processIdentity },
  { name: 'alive after deadline', tree: 'alive', nowMs: deadlineMs + 1, identity: processIdentity },
  { name: 'unobservable after deadline', tree: 'unknown', nowMs: deadlineMs + 1, identity: processIdentity },
  { name: 'reused PID after deadline', tree: 'pid-reused', nowMs: deadlineMs + 1, identity: processIdentity },
  { name: 'mismatched identity after deadline', tree: 'dead', nowMs: deadlineMs + 1, identity: 'different-start' },
  { name: 'unverified identity after deadline', tree: 'dead', nowMs: deadlineMs + 1, identity: null },
] as const) {
  test(`Z410 legacy ${scenario.name} keeps the reservation and budget without cleanup/release`, async () => {
    const f = legacyFixture();
    f.observation.tree = scenario.tree;
    f.observation.identity = scenario.identity;
    const before = f.stored;
    const reply = await recoverTestRun({ ...expired, nowMs: scenario.nowMs }, f.ports);
    assert.equal(reply.result, null);
    assert.equal(reply.recovery.needsMain, true);
    assert.equal(reply.recovery.runId, originalRunId);
    assert.equal(reply.recovery.deadlineMs, deadlineMs);
    assert.notEqual(reply.cliCode, 0);
    assert.deepEqual(f.stored, before);
    assert.deepEqual(f.calls.cleanup, []);
    assert.deepEqual(f.calls.release, []);
    assert.equal(f.calls.messages.length, 1);
    assert.equal(f.calls.messages[0].recovery.runId, originalRunId);
  });
}

for (const owner of ['unknown', 'alive'] as const) {
  for (const field of ['ownerIdentity', 'wrapperIdentity'] as const) {
    test(`Z410 explicit ${field} with ${owner} observation cannot use the legacy missing-owner exception`, async () => {
      const initial = legacyGroup();
      initial.inFlight![field] = 'saved-owner-identity';
      const f = fixture(initial);
      f.observation.owner = owner;
      f.observation.finishedAtMs = null;
      const before = f.stored;
      const reply = await recoverTestRun(expired, f.ports);
      assert.equal(reply.result, null);
      assert.equal(reply.recovery.needsMain, true);
      assert.deepEqual(f.stored, before);
      assert.deepEqual(f.calls.cleanup, []);
      assert.deepEqual(f.calls.release, []);
    });
  }
}

test('Z410 failed legacy resource release retains inFlight and the saved recovery result', async () => {
  const f = legacyFixture();
  f.ports.release = async () => false;
  const reply = await recoverTestRun(expired, f.ports);
  assert.ok(reply.result);
  preserved(reply.result);
  assert.equal(reply.recovery.needsMain, true);
  assert.equal(f.stored!.inFlight!.runId, originalRunId);
  assert.equal(f.stored!.timeoutCount, 1);
  assert.deepEqual(f.stored!.lastResult, reply.result);
});

test('Z410 incomplete legacy tree cleanup cannot free the group or release resources', async () => {
  const f = legacyFixture();
  f.ports.cleanup = async () => ({ complete: false, remainingPids: [42001] });
  const reply = await recoverTestRun(expired, f.ports);
  assert.ok(reply.result);
  preserved(reply.result);
  assert.equal(reply.result.cleanup.complete, false);
  assert.equal(reply.recovery.needsMain, true);
  assert.equal(f.stored!.inFlight!.runId, originalRunId);
  assert.deepEqual(f.calls.release, []);
});

test('Z410 changed reservation during legacy tree observation cannot be recovered or released', async () => {
  const f = legacyFixture();
  const replacement = legacyGroup();
  replacement.inFlight!.runId = otherRunId;
  f.ports.observe = async () => {
    f.replace(replacement);
    return structuredClone(f.observation);
  };
  const reply = await recoverTestRun(expired, f.ports);
  assert.equal(reply.result, null);
  assert.deepEqual(f.stored, replacement);
  assert.deepEqual(f.calls.cleanup, []);
  assert.deepEqual(f.calls.release, []);
});

test('Z410 next authorized run preserves pending legacy recovery without delivering it to a different phase', async () => {
  const e = unitEntryFixture(legacyGroup());
  e.f.observation.owner = 'unknown';
  e.f.observation.finishedAtMs = null;
  e.ports.clock.now = () => expired.nowMs;
  e.ports.recoverGroup = async groupKey => (await recoverTestRun({ ...expired, key: groupKey }, e.f.ports)).result;
  const first = await runTestRun(e.request, e.config, e.policy, e.context, e.ports);
  assert.equal(first.outcome, 'refused');
  assert.equal(first.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(first.runId, otherRunId);
  assert.equal(first.phase, e.request.phase);
  assert.deepEqual(first.selection, e.f.stored!.selection);
  assert.equal(first.nextAction, 'reconcile');
  assert.equal(e.spawns, 0);
  const recovered = e.f.stored!.lastResult!;
  preserved(recovered);
  assert.equal(recovered.phase, 'recovery');
  assert.notEqual(recovered.phase, e.request.phase);
  assert.equal(e.f.stored!.delivery!.runId, originalRunId);
  assert.equal(e.f.stored!.delivery!.pending, true);
  assert.equal(e.f.stored!.inFlight, null);
  assert.deepEqual(e.f.calls.release, [originalRunId]);

  const beforeRetry = e.f.stored;
  e.ports.recoverGroup = async () => null;
  let stdout = '';
  const cliCode = await runTestRunCli(['--project', e.request.project, '--phase', e.request.phase,
    '--group', e.request.group, '--files', ...e.request.files], {
    config: e.config, policy: e.policy, context: e.context, runtime: e.ports,
    stdout: text => { stdout += text; }, stderr: () => {},
  });
  const second = JSON.parse(stdout);
  assert.equal(cliCode, 1);
  assert.equal(second.outcome, 'refused');
  assert.equal(second.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(second.runId, otherRunId);
  assert.equal(second.phase, e.request.phase);
  assert.deepEqual(second.selection, first.selection);
  assert.equal(e.spawns, 0);
  assert.deepEqual(e.f.stored, beforeRetry);
  assert.deepEqual(e.f.calls.release, [originalRunId]);
});

for (const tree of ['alive', 'unknown', 'pid-reused'] as const) {
  test(`Z410 GROUP_IN_FLIGHT for legacy ${tree} tree names its original inFlight.runId in JSON`, async () => {
    const e = unitEntryFixture(legacyGroup());
    e.f.observation.owner = 'unknown';
    e.f.observation.tree = tree;
    e.ports.observeGroupProcess = () => tree === 'alive' ? 'alive' : 'unknown';
    e.f.observation.finishedAtMs = null;
    e.config.diagnostics.maxMessageBytes = 512;
    e.ports.clock.now = () => expired.nowMs;
    e.ports.recoverGroup = async groupKey => (await recoverTestRun({ ...expired, key: groupKey }, e.f.ports)).result;
    const before = e.f.stored;
    const refused = await runTestRun(e.request, e.config, e.policy, e.context, e.ports);
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.errorCode, 'GROUP_IN_FLIGHT');
    assert.equal(refused.nextAction, 'reconcile');
    const expectedState = tree === 'alive' ? 'alive' : 'unknown';
    assert.equal(refused.inFlight?.processState, expectedState);
    assert.equal(refused.inFlight?.agentId, null);
    assert.equal(refused.inFlight?.startedAt, null);
    assert.equal(refused.inFlight?.deadlineMs, deadlineMs);
    assert.ok(refused.diagnostics.some(d => d.message.includes(originalRunId) &&
      d.message.includes(tree === 'alive' ? 'occupied by live run' : 'could not verify the process on the host')));
    const external = JSON.parse(JSON.stringify(refused));
    assert.equal(external.inFlight?.runId, originalRunId, 'main needs the occupied runId, not only the new refusal runId');
    assert.notEqual(refused.runId, originalRunId);
    assert.equal(refused.timeoutCount, 1);
    assert.deepEqual(refused.knownRed, red);
    assert.equal(e.spawns, 0);
    assert.deepEqual(e.f.stored, before);
    assert.deepEqual(e.f.calls.cleanup, []);
    assert.deepEqual(e.f.calls.release, []);
  });
}
