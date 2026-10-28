import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTestRun, reconcileTestRunGroup } from '../src/test-runs.ts';
import { acknowledgeTestRunDelivery } from '../src/test-run-state-recovery.ts';
import type { TestRunRequest } from '../src/test-runs.ts';
import { RunHarness, policy, flushMicrotasks, fixtureGroup } from './helpers/test-run-fixture.ts';
import { reconcileTestRunResources, type ResourceReservedTestRunPorts, type TestRunResourceClaim } from '../src/test-run-reservations.ts';
import { runSandboxTestCommand } from '../src/sandbox-test-run.ts';
import type { SandboxTestAssignment, SandboxTestRunPorts } from '../src/sandbox-test-run.ts';

const file = 'test/service-integration.test.ts';
const id = { file, name: 'stops the isolated service' };
const group = 'add-raf-test-run/local-integration';
const request: TestRunRequest = { project: 'raf', phase: 'integration', group };
const budget = 211;
function harness() {
  const h = new RunHarness();
  h.context.integrationTests = { timeoutMs: budget };
  h.context.callerPhase = 'implement';
  h.context.agentPhases.push('integration');
  h.config.phases.integration = structuredClone(h.config.phases.implement);
  for (const kind of ['refusal', 'setup', 'assertions', 'timeout', 'interruption'] as const) {
    h.config.phases.integration.hints[kind] = `integration-${kind}`;
    h.config.hints[`integration-${kind}`] = `Complete the integration scenario after ${kind}`;
  }
  const { unitFiles, ...base } = h.config.projects.raf.profiles.node;
  h.config.projects.raf.profiles.integration = { ...base, testKind: 'integration', integrationFiles: [file] };
  h.config.projects.raf.groups[group] = { profileId: 'integration', files: [file] };
  h.environment.files[file] = { kind: 'file', realpath: `${h.context.workspace}/${file}`, unit: false, testKind: 'integration' };
  h.events = [{ kind: 'passed', test: id }, { kind: 'complete', expected: [id] }];
  return h;
}
const groupKey = (h: RunHarness) => ({ project: 'raf', workspace: h.context.workspace, group });
const run = (h: RunHarness) => runTestRun(request, h.config, policy, h.context, h.ports);
const runAndAcknowledge = async (h: RunHarness) => {
  const result = await run(h);
  await acknowledgeTestRunDelivery(result, h.ports.state);
  return result;
};

function staleHarness(t: TestContext) {
  const h = harness();
  const workspace = mkdtempSync(join(tmpdir(), 'raf-integration-removed-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, 'test'));
  const excluded = 'test/excluded-integration.test.ts';
  writeFileSync(join(workspace, excluded), '');
  h.context.workspace = workspace;
  h.context.cwd = workspace;
  h.context.projectWorkspaces.raf.push(workspace);
  h.environment.canonicalWorkspace = workspace;
  h.environment.canonicalCwd = workspace;
  for (const [path, fact] of Object.entries(h.environment.files)) fact.realpath = join(workspace, path);
  h.environment.files[excluded] = { kind: 'file', realpath: join(workspace, excluded), unit: false, testKind: 'integration' };
  h.config.projects.raf.profiles.integration.integrationFiles!.push(excluded);
  const staleFiles = ['test/deleted-integration.test.ts', excluded, file];
  const knownRed = staleFiles.map(file => ({ file, name: 'removed assertion' }));
  const unexecuted = staleFiles.map(file => ({ file, name: 'removed pending test' }));
  h.state.seed(fixtureGroup({ key: groupKey(h), testKind: 'integration', profileId: 'integration', knownRed, unexecuted }));
  return { h, knownRed, unexecuted, excluded };
}

test('integration runtime: complete collection removes deleted, excluded and uncollected selected IDs from the aggregate', async t => {
  const { h, knownRed, unexecuted } = staleHarness(t);
  const result = await run(h);
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.removed, [...knownRed, ...unexecuted]);
  assert.deepEqual(result.passed, [id]);
  assert.deepEqual(result.knownRed, []);
  assert.deepEqual(result.unexecuted, []);
  assert.deepEqual(result.unknown, []);
  assert.equal(result.groupState, 'complete');
  assert.equal(result.nextAction, 'complete');
  const saved = h.state.get(groupKey(h))!;
  assert.deepEqual(saved.knownRed, []);
  assert.deepEqual(saved.unexecuted, []);
  assert.deepEqual(saved.lastResult?.removed, result.removed);
  await acknowledgeTestRunDelivery(result, h.ports.state);
  assert.deepEqual((await run(h)).removed, []);
});

test('integration runtime: removed IDs do not hide a current assertion failure', async t => {
  const { h, knownRed, unexecuted } = staleHarness(t);
  h.events = [{ kind: 'assertion-failed', test: id }, { kind: 'complete', expected: [id] }];
  h.exit.exitCode = 1;
  const result = await run(h);
  assert.equal(result.outcome, 'assertions-failed');
  assert.deepEqual(result.removed, [...knownRed, ...unexecuted]);
  assert.deepEqual(result.knownRed, [id]);
  assert.deepEqual(result.unexecuted, []);
  assert.equal(result.groupState, 'incomplete');
  assert.equal(result.nextAction, 'complete-integration');
});

test('integration runtime: a narrowed selection preserves IDs still configured in the group', async t => {
  const { h, knownRed, unexecuted, excluded } = staleHarness(t);
  h.config.projects.raf.groups[group].files.push(excluded);
  const result = await runTestRun({ ...request, files: [file] }, h.config, policy, h.context, h.ports);
  assert.equal(result.outcome, 'assertions-failed');
  assert.deepEqual(result.knownRed, [knownRed[1]]);
  assert.deepEqual(result.unexecuted, [unexecuted[1]]);
  assert.deepEqual(result.removed, [knownRed[0], knownRed[2], unexecuted[0], unexecuted[2]]);
});

for (const incomplete of ['missing-complete', 'protocol-error', 'cleanup', 'timeout'] as const) {
  test(`integration runtime: ${incomplete} preserves stale IDs without authoritative collection`, async t => {
    const { h, knownRed, unexecuted } = staleHarness(t);
    if (incomplete === 'missing-complete') h.events = [{ kind: 'passed', test: id }];
    if (incomplete === 'protocol-error') h.events.push({ kind: 'protocol-error', diagnostic: 'incomplete collection' });
    if (incomplete === 'cleanup') h.cleanupResult = { complete: false, remainingPids: [103] };
    if (incomplete === 'timeout') h.finishImmediately = false;
    const pending = run(h);
    if (incomplete === 'timeout') {
      await flushMicrotasks();
      h.clock.advance(budget);
    }
    const result = await pending;
    assert.notEqual(result.outcome, 'passed');
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.knownRed, knownRed);
    assert.deepEqual(result.unexecuted, unexecuted);
  });
}

test('integration runtime: actual wrapper uses exact singleton, separate policy and trusted caller phase', async () => {
  const h = harness();
  const result = await run(h);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.testKind, 'integration');
  assert.equal(result.callerPhase, 'implement');
  assert.deepEqual(result.timeoutPolicy, { source: 'conf/flow.json#/integrationTests/timeoutMs', timeoutMs: budget });
  assert.deepEqual(result.selection.files, [file]);
  assert.deepEqual(h.spawns[0].argv, ['--test', file]);
  assert.equal(result.groupState, 'complete');
  assert.equal(h.state.get(groupKey(h))?.profileId, 'integration');
  assert.equal(h.cleanupCalls[0].deadline, h.clock.time + budget);
});

test('integration runtime: repeated full timeouts across callers exceed unit cap and preserve aggregate', async () => {
  const h = harness();
  const run = runAndAcknowledge;
  h.finishImmediately = false;
  h.events = [{ kind: 'assertion-failed', test: id }];
  for (let index = 0; index <= policy.maxGroupTimeouts; index++) {
    h.context.agentId = `executor-${index}`;
    h.context.sha = `sha-${index}`;
    const pending = run(h);
    await flushMicrotasks();
    h.clock.advance(budget);
    const result = await pending;
    assert.equal(result.outcome, 'timed-out');
    assert.equal(result.timeoutCount, index + 1);
    assert.equal(result.groupState, 'incomplete');
    assert.equal(result.nextAction, 'complete-integration');
    assert.deepEqual(result.knownRed, [id]);
    assert.deepEqual(new Set(result.hintIds), new Set(['integration-timeout', 'integration-assertions']));
  }
  h.finishImmediately = true;
  h.events = [{ kind: 'passed', test: id }, { kind: 'complete', expected: [id] }];
  assert.equal((await run(h)).outcome, 'passed');
  assert.equal(h.spawns.length, policy.maxGroupTimeouts + 2);
});

test('integration runtime: unknown and pending facts cannot be erased by truncated or timed-out confirmation', async () => {
  const h = harness();
  const run = runAndAcknowledge;
  h.events = [{ kind: 'setup-failed', test: id }, { kind: 'complete', expected: [id] }];
  assert.deepEqual((await run(h)).unknown, [id]);
  h.events = [];
  const truncated = await run(h);
  assert.equal(truncated.outcome, 'setup-failed');
  assert.deepEqual(truncated.unknown, [id]);
  h.events = [{ kind: 'passed', test: id }, { kind: 'complete', expected: [id] }];
  h.finishImmediately = false;
  const pending = run(h);
  await flushMicrotasks();
  h.clock.advance(budget);
  assert.deepEqual((await pending).unknown, [id]);
  h.finishImmediately = true;
  const complete = await run(h);
  assert.equal(complete.outcome, 'passed');
  assert.deepEqual(complete.unknown, []);
});

test('integration runtime: cleanup failure retains reservation, original budget and idempotent recovery', async () => {
  const h = harness();
  h.finishImmediately = false;
  h.cleanupResult = { complete: false, remainingPids: [103] };
  h.events = [{ kind: 'assertion-failed', test: id }];
  const pending = run(h);
  await flushMicrotasks();
  h.clock.advance(budget);
  const result = await pending;
  assert.equal(result.outcome, 'setup-failed');
  assert.equal(result.timeoutCount, 1);
  const flight = h.state.get(groupKey(h))!.inFlight!;
  assert.equal(flight.timeoutPolicy?.timeoutMs, budget);
  h.context.integrationTests = { timeoutMs: budget * 10 };
  h.recovered = { alive: false, deadlineReached: true, cleanup: { complete: true, remainingPids: [] } };
  const recovered = await reconcileTestRunGroup(groupKey(h), policy, h.context, h.ports);
  assert.equal(recovered?.timeoutCount, 1);
  assert.equal(recovered?.lastResult?.timeoutPolicy?.timeoutMs, budget);
  assert.equal(recovered?.inFlight, null);
  await reconcileTestRunGroup(groupKey(h), policy, h.context, h.ports);
  assert.equal(h.reconcileCalls, 1);
  assert.equal(h.spawns.length, 1);
});

test('integration runtime: resource recovery terminates an expired crashed tree with its saved budget exactly once', async () => {
  const h = harness();
  const startedAtMs = h.clock.now();
  const deadlineMs = startedAtMs + budget;
  const processIdentity = 'verified-crashed-tree';
  const claim: TestRunResourceClaim = {
    machineId: 'machine', testRunId: 'crashed-run', fence: 'original-fence',
    groupKey: groupKey(h), deadlineMs, processIdentity,
  };
  h.state.seed(fixtureGroup({
    key: groupKey(h), testKind: 'integration', profileId: 'integration', state: 'running',
    selection: { files: [file], testIds: [] },
    inFlight: { runId: claim.testRunId, startedAtMs, deadlineMs, processIdentity,
      timeoutPolicy: { source: 'conf/flow.json#/integrationTests/timeoutMs', timeoutMs: budget }, callerPhase: 'qa' },
  }));
  h.context.integrationTests = { timeoutMs: budget * 10 };
  let alive = true;
  let released = false;
  let recoveries = 0;
  const unexpected = async () => assert.fail('recovery must not reserve or spawn a new run');
  const ports: ResourceReservedTestRunPorts = {
    ...h.ports, machineId: claim.machineId,
    async reconcile(identity, deadline) {
      recoveries++;
      assert.equal(identity, processIdentity);
      assert.equal(deadline, deadlineMs);
      alive = false;
      return { alive: false, deadlineReached: true, cleanup: { complete: true, remainingPids: [] } };
    },
    resources: {
      estimateProfile: unexpected, prepare: unexpected, commit: unexpected, current: unexpected, bindProcess: unexpected,
      async list() { return released ? [] : [claim]; },
      async observeTree() { return { state: alive ? 'alive' : 'dead', processIdentity, consumed: null }; },
      accountUsage: unexpected,
      async release() { assert.equal(alive, false, 'capacity is released only after verified termination'); released = true; return true; },
    },
  };
  assert.deepEqual((await reconcileTestRunResources(h.context, policy, ports)).retained, [claim]);
  assert.equal(recoveries, 0, 'a live tree before its saved deadline stays reserved');
  h.clock.advance(budget);
  const recovered = await reconcileTestRunResources(h.context, policy, ports);
  assert.equal(recoveries, 1, 'expired verified trees must reach process reconciliation');
  assert.deepEqual(recovered, { released: [claim], retained: [] });
  const aggregate = h.state.get(groupKey(h))!;
  assert.equal(aggregate.inFlight, null);
  assert.equal(aggregate.timeoutCount, 1);
  assert.equal(aggregate.lastResult?.runId, claim.testRunId);
  assert.equal(aggregate.lastResult?.timeoutPolicy?.timeoutMs, budget);
  assert.equal(aggregate.lastResult?.callerPhase, 'qa');
  assert.equal(aggregate.lastResult?.nextAction, 'complete-integration');
  assert.equal(aggregate.lastResult?.cleanup.complete, true);
  await reconcileTestRunResources(h.context, policy, ports);
  assert.equal(h.state.get(groupKey(h))!.timeoutCount, 1);
  assert.equal(recoveries, 1);
  assert.equal(h.spawns.length, 0);
});

test('integration runtime: group kind/profile are pinned across reclassification', async () => {
  const h = harness();
  await run(h);
  const aggregate = h.state.get(groupKey(h))!;
  aggregate.testKind = 'unit';
  h.state.seed(aggregate);
  const refused = await run(h);
  assert.equal(refused.errorCode, 'GROUP_PROFILE_MISMATCH');
  assert.equal(h.spawns.length, 1);
});

test('integration runtime: missing separate budget refuses before preflight/state and does not use unit budget', async () => {
  const h = harness();
  delete h.context.integrationTests;
  const refused = await run(h);
  assert.equal(refused.errorCode, 'CONFIGURATION_INVALID');
  assert.equal(h.preflightCalls, 0);
  assert.equal(h.state.transactionCount, 0);
  assert.match(JSON.stringify(refused.diagnostics), /integrationTests\/timeoutMs/);
});

function broker(h = harness()) {
  const assignment: SandboxTestAssignment = { runId: 'run', agentId: 'trusted-executor', type: 'implement', phase: 'implement', project: 'raf', workspace: h.context.workspace, branch: 'develop', changes: ['add-raf-test-run'] };
  const caller = { pid: 501, startedAt: 'caller-start' };
  let contexts = 0;
  const ports: SandboxTestRunPorts = {
    caller, entrypoint: ['node', '/trusted/raf.ts'],
    async control() { return { ancestors: [caller], sessions: [{ process: caller, state: 'running', assignment }], workspaces: [{ project: 'raf', workspace: h.context.workspace, branch: 'develop' }], activeChanges: ['add-raf-test-run', 'foreign-change'], groups: [groupKey(h)], config: h.config }; },
    async unitContext() { contexts++; return { config: h.config, policy, context: h.context, runtime: h.ports }; },
    async communicate() { throw new Error('unexpected communication'); },
  };
  return { h, assignment, ports, contexts: () => contexts, command: { cwd: h.context.workspace, command: `node /trusted/raf.ts test run --project raf --phase integration --group ${group}` } };
}

test('integration broker: own implement preset reaches actual CLI with immutable caller phase', async () => {
  const b = broker();
  b.h.context.callerPhase = 'forged';
  const reply = await runSandboxTestCommand(b.command, b.ports);
  assert.equal(reply.code, 0, reply.stderr + reply.stdout);
  const result = JSON.parse(reply.stdout);
  assert.equal(result.callerPhase, 'implement');
  assert.equal(result.phase, 'integration');
  assert.equal(b.contexts(), 1);
});
