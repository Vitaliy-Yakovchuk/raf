import test from 'node:test';
import assert from 'node:assert/strict';
import { runTestRun, reconcileTestRunGroup } from '../src/test-runs.ts';
import type { TestRunRequest } from '../src/test-runs.ts';
import { RunHarness, policy, flushMicrotasks } from './helpers/test-run-fixture.ts';
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
  h.events = [{ kind: 'setup-failed', test: id }, { kind: 'complete', expected: [id] }];
  assert.deepEqual((await run(h)).unknown, [id]);
  h.events = [];
  const truncated = await run(h);
  assert.equal(truncated.outcome, 'setup-failed');
  assert.deepEqual(truncated.unknown, [id]);
  h.events = [{ kind: 'passed', test: id }, { kind: 'complete', expected: [id] }];
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
    async control() { return { ancestors: [caller], sessions: [{ process: caller, state: 'running', assignment }], workspaces: [{ project: 'raf', workspace: h.context.workspace, branch: 'develop', actualBranch: 'develop' }], activeChanges: ['add-raf-test-run', 'foreign-change'], groups: [groupKey(h)], config: h.config }; },
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

test('integration broker: foreign integration is refused before obtaining test state', async () => {
  const b = broker();
  Object.assign(b.assignment, { changes: ['foreign-change'] });
  const reply = await runSandboxTestCommand(b.command, b.ports);
  assert.equal(reply.code, 1);
  assert.match(reply.stderr, /CALLER_UNAUTHORIZED/);
  assert.equal(b.contexts(), 0);
  assert.equal(b.h.state.transactionCount, 0);
});
