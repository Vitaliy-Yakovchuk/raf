import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileTestRunResources, type TestRunResourceClaim } from '../src/test-run-reservations.ts';
import { file, policy, estimate, context, selected, oldRed, request, key, copy, machine, fixture, expectWaiting } from './helpers/test-run-reservations-fixture.ts';

for (const phase of ['red', 'implement', 'qa', 'hotfix']) {
  test(`test-reservations maps ${phase} to the configured admission tier`, async () => {
    const f = fixture();
    const result = await f.run({ phase });
    const prepare = f.shared.calls.find(call => call.operation === 'prepare')!.request!;
    assert.equal(prepare.requestedTier, 'normal');
    assert.deepEqual(prepare.estimate, estimate);
    assert.deepEqual(f.shared.calls.find(call => call.operation === 'estimate')!.value, ['raf', 'node']);
    assert.equal(result.outcome, 'passed');
    assert.equal(f.spawned.length, 1);
  });
}

for (const refusal of ['unknown'] as const) {
  for (const existing of [false, true]) {
    test(`test-reservations ${refusal} before spawn preserves ${existing ? 'existing' : 'new'} aggregate`, async () => {
      const f = fixture();
      const before = existing ? f.seed() : null;
      const snapshot = Object.freeze({ opaque: refusal, nested: { token: 'same-decision' } });
      f.shared.setSnapshot(snapshot); f.shared.setRefusal(refusal);
      const result = await f.run();
      assert.equal(result.outcome, 'refused');
      assert.deepEqual(result.failureKinds, ['refusal']);
      assert.equal(result.errorCode, 'RESOURCE_UNAVAILABLE');
      assert.deepEqual(result.admission, snapshot);
      assert.equal(result.exitCode, null); assert.equal(result.timedOut, false);
      assert.equal(result.nextAction, 'fix-setup');
      assert.equal(result.timeoutCount, before?.timeoutCount ?? 0);
      assert.deepEqual(result.knownRed, before?.knownRed ?? []);
      assert.equal(result.groupState, before?.state ?? 'idle');
      assert.deepEqual(result.selection.files, [file]);
      assert.ok(result.unexecuted.some(id => id.file === file));
      assert.deepEqual(result.passed, []);
      assert.deepEqual(f.group() ?? null, before);
      assert.equal(f.spawned.length, 0); assert.equal(f.shared.claims.size, 0);
      assert.equal(f.shared.calls.filter(call => call.operation === 'prepare').length, 1, 'UNKNOWN must not enter the resource queue');
    });
  }
}

test('test-reservations successful result preserves the central admission snapshot', async () => {
  const f = fixture();
  const snapshot = Object.freeze({ opaque: { decision: 'allowed', version: 'sentinel' } });
  f.shared.setSnapshot(snapshot);
  const result = await f.run();
  assert.deepEqual(result.admission, snapshot);
  assert.equal(result.outcome, 'passed');
  assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight, null);
});

for (const failure of ['preflight'] as const) {
  test(`test-reservations ${failure} refusal does not reserve or fabricate admission`, async () => {
    const f = fixture();
    if (failure === 'preflight') f.environment.runtimeAvailable = false;
    const result = await f.run({});
    assert.equal(result.admission, null);
    assert.notEqual(result.outcome, 'passed');
    assert.equal(f.spawned.length, 0); assert.equal(f.shared.calls.length, 0);
  });
}

test('test-reservations GROUP_IN_FLIGHT remains separate from machine admission', async () => {
  const f = fixture(); const before = f.seed('running', 0);
  before.inFlight = { runId: 'other-run', deadlineMs: 1100, processIdentity: 'other-tree' };
  f.groups.set(key(before.key), copy(before));
  const result = await f.run();
  assert.equal(result.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(result.admission, null); assert.equal(f.spawned.length, 0);
  assert.equal(f.shared.claims.size, 0); assert.deepEqual(f.group(), before);
});

test('test-reservations different groups contend atomically for the same last slot', async () => {
  const shared = machine();
  const a = fixture(shared); a.hold();
  const b = fixture(shared, { ...context, agentId: 'group-b' });
  const first = a.run(); await Promise.race([a.started, first]);
  const second = b.run({ group: 'fix-raf-load-admission/another-group' });
  try {
    await expectWaiting(b, second);
    assert.equal(a.spawned.length, 1); assert.equal(shared.claims.size, 1);
    a.finish(); await first; b.testQueue.grant();
    assert.equal((await second).outcome, 'passed');
    assert.equal(b.spawned.length, 1); assert.equal(shared.claims.size, 0);
  } finally {
    a.finish(); await first;
    b.testQueue.waits.forEach((_, i) => b.testQueue.grant(i)); await second;
  }
});

test('test-reservations agent reservation blocks a test and is never released by it', async () => {
  const f = fixture(); f.shared.setAgent(true);
  const running = f.run();
  try {
    await expectWaiting(f, running);
    assert.equal(f.shared.calls.filter(call => call.operation === 'release').length, 0);
    assert.equal(f.shared.acquireAgent(), false);
    f.shared.setAgent(false); f.testQueue.grant();
    assert.equal((await running).outcome, 'passed');
    assert.equal(f.spawned.length, 1);
  } finally {
    f.shared.setAgent(false);
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i)); await running;
  }
});

test('test-reservations test reservation blocks an agent until the tree is dead', async () => {
  const f = fixture(); f.hold();
  const running = f.run(); await Promise.race([f.started, running]);
  assert.equal(f.shared.acquireAgent(), false);
  f.finish(); await running;
  assert.equal(f.shared.acquireAgent(), true);
});

for (const failure of ['prepare', 'group', 'commit', 'stale-commit', 'expired-commit'] as const) {
  test(`test-reservations ${failure} failure cannot spawn with only one valid claim`, async () => {
    const f = fixture(); const before = f.seed();
    if (failure === 'prepare') f.shared.failPrepare();
    if (failure === 'group') f.failGroup();
    if (failure === 'commit') f.shared.failCommit();
    if (failure === 'stale-commit') f.shared.staleCommit();
    if (failure === 'expired-commit') f.shared.expireCommit();
    const result = await f.run();
    assert.equal(f.spawned.length, 0); assert.notEqual(result.outcome, 'passed');
    assert.equal(f.shared.claims.size, 0, 'compensate only the unstarted own claim');
    assert.equal(f.group()?.inFlight ?? null, null);
    assert.equal(f.group()?.timeoutCount, before.timeoutCount);
    assert.deepEqual(f.group()?.knownRed, before.knownRed);
    for (const release of f.shared.calls.filter(call => call.operation === 'release')) {
      assert.equal(release.claim!.testRunId, result.runId);
    }
  });
}

test('test-reservations spawn failure releases both claims without assertions red or timeout', async () => {
  const f = fixture(); const before = f.seed(); f.failSpawn();
  const result = await f.run();
  assert.equal(result.outcome, 'setup-failed'); assert.ok(result.failureKinds.includes('setup'));
  assert.equal(result.failureKinds.includes('assertions'), false);
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, null);
  assert.equal(result.timeoutCount, before.timeoutCount); assert.deepEqual(result.knownRed, before.knownRed);
  assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight, null);
});

for (const ending of ['signal', 'deadline'] as const) {
  test(`test-reservations ${ending} cleans the tree within the original deadline`, async () => {
    const f = fixture(); f.hold();
    f.shared.onPrepare(() => f.advance(200));
    const running = f.run(); await Promise.race([f.started, running]);
    const expectedDeadline = f.now() + policy.timeoutMs;
    if (ending === 'signal') f.signal(); else f.deadline();
    const result = await running;
    assert.equal(result.outcome, ending === 'signal' ? 'interrupted' : 'timed-out');
    assert.equal(result.timedOut, ending === 'deadline');
    assert.equal(result.timeoutCount, ending === 'deadline' ? 1 : 0);
    assert.ok(f.deadlines.length > 0);
    assert.ok(f.deadlines.every(deadline => deadline === expectedDeadline));
    assert.ok(f.cleanupCalls.length > 0);
    assert.ok(f.cleanupCalls.every(call => call.deadline === expectedDeadline));
    assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight, null);
  });
}

test('test-reservations admission before acceptance does not consume the execution budget', async () => {
  const f = fixture();
  let admittedAt = 0;
  f.shared.onPrepare(() => { f.advance(policy.timeoutMs); admittedAt = f.now(); });
  const result = await f.run();
  assert.equal(f.spawned.length, 1); assert.equal(result.timedOut, false);
  assert.equal(result.outcome, 'passed'); assert.equal(result.timeoutCount, 0);
  assert.ok(f.deadlines.every(deadline => deadline === admittedAt + policy.timeoutMs));
  assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight ?? null, null);
});

for (const state of ['alive', 'unknown'] as const) {
  test(`test-reservations ${state} descendant retains capacity until verified reconciliation`, async () => {
    const f = fixture();
    f.setCleanup({ complete: false, remainingPids: [77] });
    f.shared.onPrepare(() => {
      f.shared.observations.set('fixture-1', { state, processIdentity: 'tree-fixture-1', consumed: null });
    });
    const result = await f.run();
    assert.notEqual(result.outcome, 'passed'); assert.equal(result.nextAction, 'reconcile');
    assert.equal(f.shared.claims.size, 1); assert.ok(f.group()?.inFlight);
    assert.equal(f.shared.acquireAgent(), false);
    const retained = await reconcileTestRunResources(context, policy, f.ports);
    assert.equal(retained.retained.length, 1); assert.equal(retained.released.length, 0);
    assert.equal(f.shared.claims.size, 1);
    f.shared.observations.set(result.runId, { state: 'dead', processIdentity: 'tree-fixture-1', consumed: null });
    f.setCleanup({ complete: true, remainingPids: [] });
    const reconciled = await reconcileTestRunResources(context, policy, f.ports);
    assert.equal(reconciled.released.length, 1); assert.equal(reconciled.retained.length, 0);
    assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight, null);
    assert.equal(f.shared.acquireAgent(), true);
  });
}

function orphan(f: ReturnType<typeof fixture>, changes: Partial<TestRunResourceClaim> = {}): TestRunResourceClaim {
  const claim: TestRunResourceClaim = {
    machineId: 'machine', testRunId: 'abandoned', fence: 'old-fence',
    groupKey: { project: 'raf', workspace: context.workspace, group: request.group },
    deadlineMs: 1100, processIdentity: null, ...changes,
  };
  f.shared.claims.set(claim.testRunId, copy(claim));
  return claim;
}

test('test-reservations reconciliation compensates abandoned prepared resource claim', async () => {
  const f = fixture(); const claim = orphan(f);
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(result.released, [claim]); assert.equal(f.shared.claims.size, 0);
  assert.equal(f.spawned.length, 0);
});

test('test-reservations reconciliation compensates abandoned group-only claim', async () => {
  const f = fixture(); const group = f.seed('running', 0);
  group.inFlight = { runId: 'abandoned', deadlineMs: 1100, processIdentity: null };
  f.groups.set(key(group.key), group);
  await reconcileTestRunResources(context, policy, f.ports);
  assert.equal(f.group()?.inFlight, null); assert.equal(f.group()?.timeoutCount, 0);
  assert.deepEqual(f.group()?.knownRed, [oldRed]); assert.equal(f.spawned.length, 0);
});

test('test-reservations reconciliation cannot clear a newer group owner', async () => {
  const f = fixture(); const claim = orphan(f);
  const group = f.seed('running', 0);
  group.inFlight = { runId: 'new-owner', deadlineMs: 2100, processIdentity: 'new-tree' };
  f.groups.set(key(group.key), copy(group));
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(result.released, [claim]); assert.deepEqual(f.group(), group);
  const releases = f.shared.calls.filter(call => call.operation === 'release');
  assert.ok(releases.every(call => call.claim?.fence === 'old-fence'));
});

test('test-reservations unverified tree identity cannot release a recycled PID', async () => {
  const f = fixture(); const claim = orphan(f, { processIdentity: 'pid-77-start-old' });
  f.shared.observations.set(claim.testRunId, { state: 'unknown', processIdentity: 'pid-77-start-new', consumed: null });
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(result.retained, [claim]); assert.equal(result.released.length, 0);
  assert.equal(f.shared.claims.size, 1);
});

test('test-reservations live-tree observation reports consumption to the central manager', async () => {
  const f = fixture(); const claim = orphan(f, { processIdentity: 'live-tree' });
  const consumed = { ramBytes: 60, diskBytes: { volume: 70 } };
  f.shared.observations.set(claim.testRunId, { state: 'alive', processIdentity: 'live-tree', consumed });
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(result.retained, [claim]);
  assert.deepEqual(f.shared.calls.filter(call => call.operation === 'usage').map(call => call.value), [consumed]);
  assert.equal(f.shared.calls.some(call => call.operation === 'release'), false);
});

test('test-reservations QA homes share machine capacity while runner environment stays isolated', async () => {
  const shared = machine();
  const a = fixture(shared); a.hold();
  const qaB = { ...context, agentId: 'fixture-b', home: '/qa/home-b', statePath: '/qa/home-b/state.sqlite', tmpPath: '/qa/home-b/tmp' };
  const b = fixture(shared, qaB);
  const first = a.run(); await Promise.race([a.started, first]);
  const second = b.run({ group: 'fix-raf-load-admission/qa-b' });
  try {
    await expectWaiting(b, second);
    assert.equal(shared.claims.size, 1);
    const command = a.spawned[0];
    assert.equal(command.environment.HOME, context.home);
    assert.equal(command.environment.statePath, context.statePath);
    assert.equal(command.environment.tmpPath, context.tmpPath);
    assert.equal(JSON.stringify(command).includes(context.operationalHome), false);
    assert.ok(Object.keys(command.environment).every(name => ['HOME', 'statePath', 'tmpPath', 'testIds', 'TMPDIR'].includes(name)));
    a.finish(); await first; b.testQueue.grant();
    assert.equal((await second).outcome, 'passed');
    assert.equal(b.spawned[0].environment.HOME, qaB.home);
    assert.equal(shared.claims.size, 0);
  } finally {
    a.finish(); await first;
    b.testQueue.waits.forEach((_, i) => b.testQueue.grant(i)); await second;
  }
});

test('test-reservations simultaneous groups cannot both spawn against one machine slot', async () => {
  const shared = machine();
  const a = fixture(shared); a.hold();
  const b = fixture(shared, { ...context, agentId: 'concurrent-b' }); b.hold();
  const first = a.run();
  const second = b.run({ group: 'fix-raf-load-admission/concurrent-b' });
  try {
    const waiting = await Promise.race([
      a.testQueue.entered.then(() => a), b.testQueue.entered.then(() => b),
      Promise.race([first, second]).then(() => null),
    ]);
    assert.ok(waiting, 'one invocation must wait instead of being refused');
    const active = waiting === a ? b : a;
    const activeRun = waiting === a ? second : first;
    const waitingRun = waiting === a ? first : second;
    await Promise.race([active.started, activeRun]);
    assert.equal(shared.claims.size, 1); assert.equal(a.spawned.length + b.spawned.length, 1);
    active.finish(); await activeRun;
    waiting.testQueue.grant();
    await Promise.race([waiting.started, waitingRun]);
    waiting.finish();
    assert.equal((await waitingRun).outcome, 'passed'); assert.equal(shared.claims.size, 0);
  } finally {
    a.finish(); b.finish();
    a.testQueue.waits.forEach((_, i) => a.testQueue.grant(i));
    b.testQueue.waits.forEach((_, i) => b.testQueue.grant(i));
    await Promise.all([first, second]);
  }
});

test('test-reservations reconciliation release is fenced against a replacement resource owner', async () => {
  const f = fixture(); const abandoned = orphan(f);
  const replacement = { ...abandoned, fence: 'replacement-fence', processIdentity: 'replacement-tree' };
  const observe = f.ports.resources.observeTree;
  f.ports.resources.observeTree = async claim => {
    const observation = await observe(claim);
    f.shared.claims.set(claim.testRunId, copy(replacement));
    return observation;
  };
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(f.shared.claims.get(abandoned.testRunId), replacement);
  assert.equal(result.released.length, 0, 'a failed fenced release is not reported as successful cleanup');
  assert.ok(f.shared.calls.filter(call => call.operation === 'release').every(call => call.claim?.fence === abandoned.fence));
});
