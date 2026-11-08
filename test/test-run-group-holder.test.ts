import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runTestRunCli } from '../src/test-run-cli.ts';
import { createTestRunQueuePort } from '../src/test-run-queue-runtime.ts';
import { testWrapperIdentity } from '../src/test-run-resource-process.ts';
import type { StateStore } from '../src/state-store.ts';
import type { LaunchQueueState } from '../src/launch-queue-events.ts';
import { fixture, context, config, policy, request, key, copy, expectWaiting } from './helpers/test-run-reservations-fixture.ts';

const childIdentity = JSON.stringify({ pid: 42001, start: 'host-start', boot: 'host-boot' });
const wrapperIdentity = JSON.stringify({ pid: 42000, start: 'wrapper-start', boot: 'host-boot' });
const startedAt = new Date(100).toISOString();
const holder = { runId: 'occupied-run', agentId: 'holder-agent', processIdentity: childIdentity,
  ownerIdentity: wrapperIdentity, startedAt, deadlineMs: 1100 };

for (const processState of ['alive', 'gone', 'unknown'] as const) {
  test(`GROUP_IN_FLIGHT serializes the ${processState} host owner without asking the sandbox to inspect its PID`, async () => {
    const f = fixture();
    const before = f.seed('running', 1);
    before.inFlight = copy(holder);
    f.groups.set(key(before.key), copy(before));
    const observed: (string | null)[] = [];
    Object.assign(f.ports, { observeGroupProcess(identity: string | null) { observed.push(identity); return processState; } });
    let stdout = '';
    const exitCode = await runTestRunCli(['--project', request.project, '--phase', 'hotfix', '--group', request.group], {
      config, policy, context, runtime: f.ports, stdout: text => { stdout += text; }, stderr: () => {},
    });
    const result = JSON.parse(stdout);
    assert.equal(exitCode, 1);
    assert.equal(result.errorCode, 'GROUP_IN_FLIGHT');
    assert.equal(result.outcome, 'refused');
    assert.deepEqual(result.inFlight, { ...holder, processState });
    assert.deepEqual(observed, [childIdentity]);
    const message = result.diagnostics.map((d: { message: string }) => d.message).join('\n');
    if (processState === 'alive') assert.match(message, /live run occupied-run.*holder-agent.*wait.*same command/i);
    if (processState === 'gone') assert.match(message, /process is gone.*retry.*raf will recover/i);
    if (processState === 'unknown') assert.match(message, /could not verify.*host/i);
    assert.equal(f.spawned.length, 0);
    assert.equal(f.shared.claims.size, 0);
    assert.deepEqual(f.group(), before);
  });
}

for (const stage of ['waiting', 'running'] as const) {
  test(`GROUP_IN_FLIGHT includes owner identity when the duplicate is refused during ${stage} preflight`, async () => {
    const f = fixture();
    f.ports.wrapperIdentity = wrapperIdentity;
    Object.assign(f.ports, { observeGroupProcess: () => 'alive' });
    const before = f.seed();
    if (stage === 'waiting') f.shared.setRefusal('unavailable');
    else f.hold();
    const running = f.run();
    try {
      if (stage === 'waiting') await expectWaiting(f, running);
      else await Promise.race([f.started, running]);
      const duplicate = JSON.parse(JSON.stringify(await f.run()));
      assert.equal(duplicate.errorCode, 'GROUP_IN_FLIGHT');
      assert.ok(duplicate.inFlight, 'early pending refusal must retain the occupied owner');
      assert.equal(duplicate.inFlight.runId, 'fixture-1');
      assert.equal(duplicate.inFlight.agentId, context.agentId);
      assert.equal(duplicate.inFlight.ownerIdentity, wrapperIdentity);
      assert.equal(duplicate.inFlight.processState, 'alive');
      assert.equal(duplicate.inFlight.startedAt, startedAt);
      assert.equal(duplicate.inFlight.deadlineMs, 1100);
      assert.notEqual(duplicate.runId, duplicate.inFlight.runId);
      assert.ok(duplicate.diagnostics.some((d: { message: string }) => /live run fixture-1.*fixture.*wait/i.test(d.message)));
      assert.equal(f.group()?.timeoutCount, before.timeoutCount);
      assert.deepEqual(f.group()?.knownRed, before.knownRed);
      assert.equal(f.testQueue.records.length, stage === 'waiting' ? 1 : 0);
      assert.equal(f.spawned.length, stage === 'waiting' ? 0 : 1);
    } finally {
      f.shared.setRefusal(null);
      f.testQueue.waits.forEach((_, i) => f.testQueue.grant(i));
      f.finish();
      await running;
    }
  });
}

test('cross-client queue refusal carries its saved holder into TestRunResult before group persistence', async () => {
  let queueState = { entries: [], pendingTests: [], started: 0, cancelled: 0, failed: 0 } as unknown as LaunchQueueState;
  const store = {
    startupContextDatabase: { prepare: (sql: string) => ({
      all: () => sql === 'PRAGMA database_list' ? [{ name: 'main', file: fileURLToPath(import.meta.url) }] : [],
    }) },
    eventRepository: { transaction: (operation: Function) => operation({
      listPending: () => [], loadQueue: () => copy(queueState), saveQueue: (_: unknown, state: LaunchQueueState) => { queueState = copy(state); },
    }) },
    sessionRepository: { transaction: (operation: Function) => operation({ listReservations: () => [] }) },
    startupContext: { stateDomain: 'fixture' },
  } as unknown as StateStore;
  const options = { root: '/qa/root', workspace: context.workspace, home: context.home, machineId: 'fixture-machine', settle: async () => {} };
  const first = createTestRunQueuePort(store, options);
  const second = createTestRunQueuePort(store, options);
  const groupKey = { project: request.project, workspace: context.workspace, group: request.group };
  const queuedHolder = { ...holder, processIdentity: null, ownerIdentity: testWrapperIdentity() };
  await first.claimGroup!('occupied-run', groupKey, queuedHolder);
  const f = fixture();
  f.ports.queue = second;
  const result = await f.run();
  assert.equal(result.errorCode, 'GROUP_IN_FLIGHT');
  assert.deepEqual(JSON.parse(JSON.stringify(result)).inFlight, { ...queuedHolder, processState: 'alive' });
  assert.ok(result.diagnostics.some(d => /live run occupied-run.*holder-agent.*wait/i.test(d.message)));
  assert.equal(queueState.pendingTests?.length, 1);
  assert.equal(f.spawned.length, 0);
  assert.equal(f.shared.claims.size, 0);
});

test('a pending result for another request retains its original run identity in the refusal', async () => {
  const f = fixture();
  const completed = await f.run();
  const before = copy(f.group());
  const refused = await f.run({ phase: 'hotfix' });
  assert.equal(refused.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(refused.inFlight?.runId, completed.runId);
  assert.equal(refused.inFlight?.startedAt, completed.startedAt);
  assert.equal(refused.inFlight?.processState, 'unknown');
  assert.ok(refused.diagnostics.some(d => /pending result.*reconcile its delivery/i.test(d.message)));
  assert.deepEqual(f.group(), before);
  assert.equal(f.spawned.length, 1);
});
