import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdmissionSnapshot, type AdmissionMeasurement } from '../src/admission-snapshot.ts';
import { loadFlowPolicy } from '../src/flow-policy.ts';
import { fixture, context, policy, estimate, oldRed, expectWaiting } from './helpers/test-run-reservations-fixture.ts';

test('test-queue shortage waits without resource claims or aggregate mutation then runs once', async () => {
  const f = fixture();
  const before = f.seed();
  f.shared.setRefusal('unavailable');
  const running = f.run();
  try {
    await expectWaiting(f, running);
    assert.equal(f.shared.claims.size, 0);
    assert.equal(f.group()?.timeoutCount, before.timeoutCount);
    assert.deepEqual(f.group()?.knownRed, before.knownRed);
    assert.deepEqual(f.group()?.selection, before.selection);
    assert.equal(f.testQueue.waits[0].input.level, 'normal');
    assert.equal(f.testQueue.waits[0].input.workload, 'test');
    f.shared.setRefusal(null);
    f.testQueue.grant();
    const result = await running;
    assert.equal(result.outcome, 'passed');
    assert.equal(f.spawned.length, 1);
    assert.equal(f.shared.claims.size, 0);
    assert.deepEqual(result.queue, { queueId: f.testQueue.records[0].queueId, waited: true });
    assert.ok(f.shared.calls.filter(call => call.operation === 'prepare').every(call => call.request?.testRunId === result.runId));
    assert.equal(f.testQueue.starts.length, 1);
    assert.equal(f.testQueue.starts[0].identity, `tree-${result.runId}`);
  } finally {
    f.shared.setRefusal(null);
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

test('test-queue pending mixed queue prevents an otherwise admissible test from bypassing it', async () => {
  const f = fixture(); f.testQueue.setPending(true);
  const running = f.run();
  try {
    await expectWaiting(f, running);
    assert.equal(f.shared.claims.size, 0);
    f.testQueue.setPending(false); f.testQueue.grant();
    assert.equal((await running).outcome, 'passed');
    assert.equal(f.spawned.length, 1);
  } finally {
    f.testQueue.setPending(false);
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

test('test-queue waiting longer than unit budget preserves it until admission', async () => {
  const f = fixture(); f.shared.setRefusal('unavailable');
  const running = f.run();
  try {
    await expectWaiting(f, running);
    f.advance(policy.timeoutMs * 3);
    assert.equal(f.deadlines.length, 0, 'execution timer starts with both accepted claims');
    const admittedAt = f.now();
    f.shared.setRefusal(null); f.testQueue.grant();
    const result = await running;
    assert.equal(result.outcome, 'passed'); assert.equal(result.timedOut, false);
    assert.equal(result.timeoutCount, 0);
    assert.ok(f.deadlines.length > 0);
    assert.ok(f.deadlines.every(deadline => deadline === admittedAt + policy.timeoutMs));
    assert.ok(f.cleanupCalls.every(call => call.deadline === admittedAt + policy.timeoutMs));
  } finally {
    f.shared.setRefusal(null);
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

test('test-queue pending group refuses a duplicate without a second waiter or spawn', async () => {
  const f = fixture(); f.shared.setRefusal('unavailable');
  const running = f.run();
  try {
    await expectWaiting(f, running);
    const duplicate = await f.run();
    assert.equal(duplicate.errorCode, 'GROUP_IN_FLIGHT');
    assert.equal(f.testQueue.records.length, 1); assert.equal(f.spawned.length, 0);
    f.shared.setRefusal(null); f.testQueue.grant();
    assert.equal((await running).outcome, 'passed');
  } finally {
    f.shared.setRefusal(null);
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

test('test-queue resource loss after permit keeps testRunId and queue fence and waits again', async () => {
  const f = fixture(); f.shared.setRefusal('unavailable');
  const running = f.run();
  try {
    await expectWaiting(f, running);
    let secondWait!: () => void;
    const reentered = new Promise<void>(resolve => { secondWait = resolve; });
    const wait = f.testQueue.port.waitForResources;
    f.testQueue.port.waitForResources = input => { const result = wait(input); secondWait(); return result; };
    f.testQueue.grant();
    assert.equal(await Promise.race([reentered.then(() => 'waiting'), running.then(() => 'completed')]), 'waiting');
    assert.equal(f.spawned.length, 0); assert.equal(f.shared.claims.size, 0);
    assert.equal(f.testQueue.records.length, 1);
    assert.deepEqual(f.testQueue.waits[1].input.record, f.testQueue.waits[0].input.record);
    f.shared.setRefusal(null); f.testQueue.grant(1);
    assert.equal((await running).outcome, 'passed'); assert.equal(f.spawned.length, 1);
  } finally {
    f.shared.setRefusal(null);
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

test('test-queue UNKNOWN after permit terminates without spawning or recording unit red', async () => {
  const f = fixture(); const before = f.seed(); f.shared.setRefusal('unavailable');
  const running = f.run();
  try {
    await expectWaiting(f, running);
    f.shared.setRefusal('unknown'); f.shared.setSnapshot({ level: 'UNKNOWN', requestedTier: 'normal' });
    f.testQueue.grant();
    const result = await running;
    assert.equal(result.outcome, 'refused'); assert.equal(result.errorCode, 'RESOURCE_UNAVAILABLE');
    assert.equal(result.nextAction, 'fix-setup'); assert.equal(result.exitCode, null);
    assert.equal(result.timeoutCount, before.timeoutCount); assert.deepEqual(result.knownRed, [oldRed]);
    assert.equal(f.spawned.length, 0); assert.equal(f.testQueue.waits.length, 1);
    assert.deepEqual(result.admission, { level: 'UNKNOWN', requestedTier: 'normal' });
  } finally {
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

test('test-queue lost permit delivery terminates without automatic reconnect or spawn', async () => {
  const f = fixture(); f.shared.setRefusal('unavailable');
  const running = f.run();
  try {
    await expectWaiting(f, running); f.testQueue.fail();
    const result = await running;
    assert.notEqual(result.outcome, 'passed'); assert.equal(result.exitCode, null);
    assert.equal(f.testQueue.waits.length, 1); assert.equal(f.spawned.length, 0);
    assert.equal(result.timeoutCount, 0); assert.equal(result.timedOut, false);
  } finally {
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

test('test-queue waiting stderr carries stable identifiers and admission without poll duplicates', async () => {
  const f = fixture(); f.shared.setRefusal('unavailable');
  f.shared.setSnapshot({ level: 'NO_RESOURCES', requestedTier: 'normal' });
  const running = f.run();
  try {
    await expectWaiting(f, running);
    assert.equal(f.testQueue.stderr.length, 1);
    const line = JSON.parse(f.testQueue.stderr[0]);
    const record = f.testQueue.records[0];
    assert.equal(line.kind, 'launch-queue.waiting');
    assert.equal(line.queueId, record.queueId); assert.equal(line.requestId, record.requestId);
    assert.equal(line.testRunId, record.testRunId);
    assert.deepEqual(line.admission, { level: 'NO_RESOURCES', requestedTier: 'normal' });
    f.advance(policy.timeoutMs * 2);
    assert.equal(f.testQueue.stderr.length, 1);
    f.shared.setRefusal(null); f.testQueue.grant();
    assert.equal((await running).outcome, 'passed');
  } finally {
    f.shared.setRefusal(null);
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

test('test-queue signal during waiting cancels only its fence without spending the unit budget', async () => {
  const f = fixture(); const before = f.seed();
  const snapshot = { level: 'NO_RESOURCES', requestedTier: 'normal' };
  f.shared.setSnapshot(snapshot); f.shared.setRefusal('unavailable');
  const running = f.run();
  try {
    await expectWaiting(f, running);
    f.signal();
    const result = await running;
    assert.notEqual(result.outcome, 'passed'); assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false); assert.equal(result.timeoutCount, before.timeoutCount);
    assert.deepEqual(result.knownRed, before.knownRed); assert.deepEqual(result.admission, snapshot);
    assert.equal(result.failureKinds.includes('assertions'), false);
    assert.equal(f.spawned.length, 0); assert.equal(f.shared.claims.size, 0);
    assert.equal(f.group()?.inFlight ?? null, null);
    assert.equal(f.testQueue.records.length, 1); assert.equal(f.testQueue.finishes.length, 1);
    assert.deepEqual(f.testQueue.finishes[0].record, f.testQueue.records[0]);
    assert.equal(f.testQueue.finishes[0].outcome, 'cancelled');
  } finally {
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
    await running;
  }
});

for (const phase of ['red', 'qa', 'hotfix']) {
  test(`test-queue trusted hotfix workspace uses hotfix thresholds for ${phase}`, async () => {
    const f = fixture(undefined, { ...context, cwd: '/qa/hotfix', workspace: '/qa/hotfix', projectWorkspaces: { raf: ['/qa/hotfix'] } });
    f.ports.resourceRoute = { branchPaths: { develop: '/qa/develop', hotfix: '/qa/hotfix' } };
    const result = await f.run({ phase });
    const preparation = f.shared.calls.find(call => call.operation === 'prepare')!.request!;
    assert.equal(preparation.requestedTier, 'hotfix');
    assert.deepEqual(preparation.estimate, estimate);
    assert.equal(result.outcome, 'passed');
  });
}

test('test-queue phase hotfix cannot elevate a trusted develop workspace', async () => {
  const f = fixture();
  const result = await f.run({ phase: 'hotfix' });
  const preparation = f.shared.calls.find(call => call.operation === 'prepare')?.request;
  if (preparation) assert.equal(preparation.requestedTier, 'normal');
  else { assert.equal(f.spawned.length, 0); assert.notEqual(result.outcome, 'passed'); }
});

test('test-queue a workspace absent from trusted branch paths is refused before resources', async () => {
  const f = fixture();
  f.ports.resourceRoute = { branchPaths: { develop: '/qa/other-develop', hotfix: '/qa/hotfix' } };
  const result = await f.run();
  assert.notEqual(result.outcome, 'passed');
  assert.equal(f.shared.calls.length, 0); assert.equal(f.testQueue.records.length, 0);
  assert.equal(f.spawned.length, 0); assert.equal(result.admission, null);
});

test('test-queue repeats preflight after permit and fails changed prerequisites without spawn', async () => {
  const f = fixture(); f.shared.setRefusal('unavailable');
  const running = f.run();
  try {
    await expectWaiting(f, running);
    f.environment.runtimeAvailable = false; f.shared.setRefusal(null); f.testQueue.grant();
    const result = await running;
    assert.notEqual(result.outcome, 'passed'); assert.equal(f.spawned.length, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.timeoutCount, missing === 'UNKNOWN' ? 0 : null);
    if (missing !== 'UNKNOWN') {
      assert.equal(result.groupSnapshot, 'unavailable'); assert.equal(result.groupState, null);
    }
    assert.equal(f.shared.claims.size, 0); assert.equal(f.testQueue.waits.length, 1);
    assert.ok(f.timeline.filter(entry => entry === 'preflight').length >= 2);
  } finally {
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i)); await running;
  }
});

test('test-queue permit is not test success and actual assertion result retains queue and admission', async () => {
  const f = fixture(); f.shared.setRefusal('unavailable');
  const snapshot = { level: 'ANY_RUN', requestedTier: 'normal', allowed: true };
  const spawn = f.ports.spawn;
  f.ports.spawn = async (command, onEvent) => {
    const child = await spawn(command, event => onEvent(event.kind === 'passed' ? { kind: 'assertion-failed', test: event.test } : event));
    return { ...child, wait: async () => ({ exitCode: 1, signal: null, stderr: '' }) };
  };
  const running = f.run();
  try {
    await expectWaiting(f, running);
    f.shared.setRefusal(null); f.shared.setSnapshot(snapshot); f.testQueue.grant();
    const result = await running;
    assert.equal(result.outcome, 'assertions-failed'); assert.equal(result.exitCode, 1);
    assert.deepEqual(result.admission, snapshot);
    assert.deepEqual(result.queue, { queueId: f.testQueue.records[0].queueId, waited: true });
    assert.equal(result.knownRed.length, 1); assert.equal(f.spawned.length, 1);
  } finally {
    f.shared.setRefusal(null);
    f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i)); await running;
  }
});

for (const missing of ['UNKNOWN', 'phase', 'preflight'] as const) {
  test(`test-queue ${missing} fails before queue and spawn`, async () => {
    const f = fixture();
    if (missing === 'UNKNOWN') f.shared.setRefusal('unknown');
    if (missing === 'preflight') f.environment.runtimeAvailable = false;
    const result = await f.run(missing === 'phase' ? { phase: 'test-scaffold' } : {});
    assert.notEqual(result.outcome, 'passed'); assert.equal(f.spawned.length, 0);
    assert.equal(f.testQueue.records.length, 0); assert.equal(f.testQueue.waits.length, 0);
    assert.equal(result.timedOut, false); assert.equal(result.timeoutCount, 0);
  });
}

const flow = loadFlowPolicy();
for (const branch of ['develop', 'hotfix'] as const) {
  for (const pressure of ['hotfix-only', 'critical', 'ram', 'disk'] as const) {
    test(`test-queue ${branch} applies central profile admission at ${pressure}`, async () => {
      const workspace = `/qa/${branch}`;
      const f = fixture(undefined, { ...context, cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] } });
      f.ports.resourceRoute = { branchPaths: { develop: '/qa/develop', hotfix: '/qa/hotfix' } };
      const totalRam = flow.resources.normal.minRamBytes * 20;
      const totalDisk = flow.resources.normal.minDiskBytes * 20;
      const measurement: AdmissionMeasurement = {
        machineId: 'machine', loadAverage1m: (flow.resources.normal.maxNormalizedLoad + flow.resources.hotfix.maxNormalizedLoad) / 2,
        availableCores: 1, totalRamBytes: totalRam, availableRamBytes: totalRam,
        memoryPressure: pressure === 'critical' ? 'critical' : 'normal',
        fileSystems: [{ id: 'volume', totalBytes: totalDisk, availableBytes: totalDisk }],
      };
      if (pressure === 'ram') measurement.availableRamBytes = estimate.reservation!.ramBytes;
      if (pressure === 'disk') measurement.fileSystems[0].availableBytes = estimate.reservation!.diskBytes.volume;
      const prepare = f.ports.resources.prepare;
      let allowed = false;
      f.ports.resources.prepare = async input => {
        const admission = buildAdmissionSnapshot({ requestedTier: input.requestedTier, policy: flow, queueId: 'queue', input: {
          measurement, requested: input.estimate.reservation!, unusedReservations: [], requiredFileSystemIds: ['volume'], estimate: input.estimate,
        } });
        if (!admission.allowed) return { status: 'refused', claim: null, admission, nextAction: admission.level === 'UNKNOWN' ? 'fix-setup' : 'retry' };
        allowed = true;
        const result = await prepare(input);
        return { ...result, admission };
      };
      const running = f.run();
      if (branch === 'hotfix' && pressure === 'hotfix-only') {
        const result = await running;
        assert.equal(result.outcome, 'passed'); assert.equal(allowed, true);
        assert.equal((result.admission as any).requestedTier, 'hotfix');
        assert.deepEqual((result.admission as any).thresholds, flow.resources);
        assert.deepEqual((result.admission as any).reservation.requested, estimate.reservation);
      } else {
        try {
          await expectWaiting(f, running); assert.equal(allowed, false);
          measurement.loadAverage1m = 0; measurement.memoryPressure = 'normal';
          measurement.availableRamBytes = totalRam; measurement.fileSystems[0].availableBytes = totalDisk;
          f.testQueue.grant(); assert.equal((await running).outcome, 'passed');
        } finally {
          measurement.loadAverage1m = 0; measurement.memoryPressure = 'normal';
          measurement.availableRamBytes = totalRam; measurement.fileSystems[0].availableBytes = totalDisk;
          f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
          await running;
        }
      }
    });
  }
}
