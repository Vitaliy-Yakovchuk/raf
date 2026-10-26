import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRunnerResult, cleanupClosedTestRunGroups, reconcileTestRunGroup, runTestRun,
} from '../src/test-runs.ts';
import type { RunnerEvent, TestRunEnvironment, TestRunResult } from '../src/test-runs.ts';
import { runTestRunCli } from '../src/test-run-cli.ts';
import {
  alpha, beta, gamma, files, fixtureGroup, fixtureRequest, flushMicrotasks, key, policy, RunHarness,
} from './helpers/test-run-fixture.ts';

const successExit = { exitCode: 0, signal: null, stderr: 'FAIL is ordinary diagnostic text, not an assertion' };

test('recovery after incomplete timeout cleanup counts the reserved run only once', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  harness.cleanupResult = { complete: false, remainingPids: [103] };
  const pending = runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  harness.clock.advance(policy.timeoutMs);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutCount, 1);
  assert.ok(harness.state.get()?.inFlight);
  harness.recovered = { alive: false, deadlineReached: true, cleanup: { complete: true, remainingPids: [] } };
  const recovered = await reconcileTestRunGroup(key, policy, harness.context, harness.ports);
  assert.equal(recovered?.timeoutCount, 1);
  assert.equal(recovered?.inFlight, null);
  assert.equal((await reconcileTestRunGroup(key, policy, harness.context, harness.ports))?.timeoutCount, 1);
});

test('discovery retains a pending parent after a child completes', () => {
  const parent = { file: files[0], name: 'parent' };
  const child = { file: files[0], name: 'parent child' };
  const result = classifyRunnerResult([
    { kind: 'discovered', test: parent },
    { kind: 'discovered', test: child, parent },
    { kind: 'passed', test: child },
  ], { exitCode: null, signal: 'SIGKILL', stderr: '' });
  assert.deepEqual(result.unexecuted, [parent]);
});

test('recovery of incomplete interrupted cleanup does not turn it into a timeout', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  harness.cleanupResult = { complete: false, remainingPids: [103] };
  const pending = runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  harness.interrupt?.('SIGINT');
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(result.timeoutCount, 0);
  harness.clock.advance(policy.timeoutMs);
  harness.recovered = { alive: false, deadlineReached: true, cleanup: { complete: true, remainingPids: [] } };
  const recovered = await reconcileTestRunGroup(key, policy, harness.context, harness.ports);
  assert.equal(recovered?.timeoutCount, 0);
  assert.equal(recovered?.lastResult?.timedOut, false);
  assert.equal(recovered?.lastResult?.outcome, result.outcome);
  assert.equal(recovered?.inFlight, null);
});

test('structured pass ignores FAIL in stderr and records stable IDs', () => {
  const result = classifyRunnerResult([
    { kind: 'passed', test: alpha }, { kind: 'passed', test: beta }, { kind: 'complete', expected: [alpha, beta] },
  ], successExit);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.passed, [alpha, beta]);
  assert.deepEqual(result.knownRed, []);
  assert.deepEqual(result.failureKinds, []);
});

test('assertion and setup in separate files both survive classification', () => {
  const result = classifyRunnerResult([
    { kind: 'assertion-failed', test: alpha }, { kind: 'setup-failed', test: beta, diagnostic: 'import failed' },
    { kind: 'complete', expected: [alpha, beta, gamma] },
  ], { ...successExit, exitCode: 1 });
  assert.equal(result.outcome, 'setup-failed');
  assert.ok(result.failureKinds.includes('setup'));
  assert.ok(result.failureKinds.includes('assertions'));
  assert.deepEqual(result.knownRed, [alpha]);
  assert.deepEqual(result.unexecuted, [gamma]);
});

for (const [name, events, exit] of [
  ['missing output', [], successExit],
  ['truncated output', [{ kind: 'passed', test: alpha }], successExit],
  ['invalid protocol', [{ kind: 'protocol-error', diagnostic: 'invalid reporter stream' }], successExit],
  ['nonzero exit without assertion', [{ kind: 'complete', expected: [alpha] }], { ...successExit, exitCode: 7 }],
  ['signal without complete', [], { ...successExit, exitCode: null, signal: 'SIGTERM' }],
  ['expected test without outcome', [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha, beta] }], successExit],
] as [string, RunnerEvent[], typeof successExit | { exitCode: null; signal: string; stderr: string }][]) {
  test(`incomplete evidence cannot pass: ${name}`, () => {
    const result = classifyRunnerResult(events, exit);
    assert.notEqual(result.outcome, 'passed');
    if (name === 'expected test without outcome') assert.deepEqual(result.unexecuted, [beta]);
  });
}

test('an import or broken fixture is setup rather than a confirmed assertion red', () => {
  const result = classifyRunnerResult([
    { kind: 'setup-failed', test: alpha, diagnostic: 'fixture constructor threw' }, { kind: 'complete', expected: [alpha] },
  ], { ...successExit, exitCode: 1 });
  assert.equal(result.outcome, 'setup-failed');
  assert.deepEqual(result.knownRed, []);
});

test('test names in different files remain distinct IDs', () => {
  const sameName = { ...alpha, file: beta.file };
  const result = classifyRunnerResult([
    { kind: 'passed', test: alpha }, { kind: 'assertion-failed', test: sameName }, { kind: 'complete', expected: [alpha, sameName] },
  ], { ...successExit, exitCode: 1 });
  assert.deepEqual(result.passed, [alpha]);
  assert.deepEqual(result.knownRed, [sameName]);
});

const environmentFailures: [keyof TestRunEnvironment, boolean][] = [
  ['runtimeAvailable', false], ['localRunnerAvailable', false], ['dependenciesAvailable', false],
  ['resultAdapterAvailable', false], ['artifactsWritable', false], ['treeControlSupported', false],
  ['isolatedHome', false], ['stateOriginAllowed', false], ['stateAliasesOperational', true],
  ['tmpAliasesOperational', true], ['inheritedOperationalChannel', true],
];
for (const [field, value] of environmentFailures) {
  test(`environment failure ${field} stops before state access and spawn`, async () => {
    const harness = new RunHarness();
    Object.assign(harness.environment, { [field]: value });
    const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
    assert.equal(result.outcome, 'setup-failed');
    assert.equal(result.nextAction, 'fix-setup');
    assert.equal(result.exitCode, null);
    assert.equal(result.groupSnapshot, 'unavailable', 'state-open-recovery-spec.md S02/S03: group has not been read');
    assert.equal(result.groupState, null, 'delta «Адресна відмова відкриття стану»: unavailable has no confirmed state');
    assert.equal(result.timeoutCount, null, 'state-open-recovery-spec.md S02/S03: unavailable must not invent a zero budget');
    assert.equal(harness.state.transactionCount, 0);
    assert.equal(harness.spawns.length, 0);
  });
}

test('changing HOME alone cannot bypass an operational state or inherited channel alias', async () => {
  const harness = new RunHarness();
  harness.context.home = '/qa/another-home';
  harness.environment.stateAliasesOperational = true;
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'setup-failed');
  assert.equal(harness.state.transactionCount, 0);
  assert.equal(harness.spawns.length, 0);
});

test('preflight failure is setup and never opens state or installs dependencies', async () => {
  const harness = new RunHarness();
  harness.preflightError = new Error('runtime context unavailable');
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'setup-failed');
  assert.equal(harness.state.transactionCount, 0);
  assert.equal(harness.spawns.length, 0);
});

test('spawn ENOENT is setup and releases the reservation without a unit timeout', async () => {
  const harness = new RunHarness();
  harness.spawnError = Object.assign(new Error('missing local runner'), { code: 'ENOENT' });
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'setup-failed');
  assert.equal(result.timeoutCount, 0);
  assert.equal(result.exitCode, null);
  assert.equal(harness.state.get()?.inFlight, null);
});

test('reservation transaction ends before spawn, and normal completion cleans descendants', async () => {
  const harness = new RunHarness();
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'passed');
  assert.equal(harness.spawnInsideTransaction, false);
  assert.equal(harness.preflightCalls, 1);
  assert.equal(harness.spawns.length, 1);
  assert.equal(result.cleanup.complete, true);
  assert.deepEqual(harness.remainingPids, []);
  assert.equal(harness.state.get()?.inFlight, null);
  assert.equal(harness.clock.jobs.size, 0);
  assert.equal(harness.interrupt, null);
});

test('deadline kills the whole process tree within the original budget and records timeout', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [{ kind: 'assertion-failed', test: alpha }];
  const started = harness.clock.now();
  const pending = runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  assert.equal(harness.spawns.length, 1);
  harness.clock.advance(policy.timeoutMs - 1);
  await flushMicrotasks();
  assert.equal(harness.cleanupCalls.length, 0);
  harness.clock.advance(1);
  const result = await pending;
  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutCount, 1);
  assert.equal(result.durationMs, policy.timeoutMs);
  assert.ok(result.failureKinds.includes('assertions'));
  assert.ok(result.failureKinds.includes('timeout'));
  assert.deepEqual(result.knownRed, [alpha]);
  assert.equal(result.cleanup.complete, true);
  assert.deepEqual(harness.remainingPids, []);
  assert.equal(harness.cleanupCalls[0].deadline, started + policy.timeoutMs);
  assert.equal(harness.cleanupCalls[0].reason, 'timeout');
});

test('interruption cleans children and grandchildren without incrementing timeout count', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  const pending = runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  assert.equal(harness.spawns.length, 1);
  harness.interrupt?.('SIGINT');
  const result = await pending;
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.nextAction, 'retry');
  assert.equal(result.timedOut, false);
  assert.equal(result.timeoutCount, 0);
  assert.ok(result.failureKinds.includes('interruption'));
  assert.deepEqual(harness.remainingPids, []);
  assert.equal(harness.cleanupCalls[0].reason, 'interruption');
});

test('cleanup that leaves a grandchild prevents success even when runner passed', async () => {
  const harness = new RunHarness();
  harness.cleanupResult = { complete: false, remainingPids: [103] };
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.notEqual(result.outcome, 'passed');
  assert.equal(result.cleanup.complete, false);
  assert.deepEqual(result.cleanup.remainingPids, [103]);
  assert.equal(result.exitCode, 0);
});

test('changed conf budget and executable take effect without new code or per-phase budget', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  harness.config.projects.raf.profiles.node.executable = '/changed/node';
  const changedPolicy = { ...policy, timeoutMs: policy.timeoutMs + 17 };
  const started = harness.clock.now();
  const pending = runTestRun(fixtureRequest({ phase: 'implement' }), harness.config, changedPolicy, harness.context, harness.ports);
  await flushMicrotasks();
  assert.equal(harness.spawns[0].executable, '/changed/node');
  harness.clock.advance(policy.timeoutMs);
  await flushMicrotasks();
  assert.equal(harness.cleanupCalls.length, 0);
  harness.clock.advance(17);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(harness.cleanupCalls[0].deadline, started + changedPolicy.timeoutMs);
});

for (const phase of ['red', 'implement', 'qa', 'hotfix']) {
  test(`phase, agent, SHA and optimized files preserve the group counter: ${phase}`, async () => {
    const harness = new RunHarness();
    harness.state.seed(fixtureGroup({ timeoutCount: policy.optimizeAfterTimeouts, state: 'optimize' }));
    harness.context.agentId = 'different-agent';
    harness.context.sha = 'different-sha';
    harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
    const result = await runTestRun(fixtureRequest({ phase, files: [files[0]] }), harness.config, policy, harness.context, harness.ports);
    assert.equal(result.timeoutCount, policy.optimizeAfterTimeouts);
    assert.equal(harness.state.records.size, 1);
    assert.equal(harness.state.get()?.timeoutCount, policy.optimizeAfterTimeouts);
    assert.deepEqual(harness.state.get()?.key, key);
  });
}

test('the optimization threshold requests optimization and keeps the same group identity', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  harness.state.seed(fixtureGroup({ timeoutCount: policy.optimizeAfterTimeouts - 1 }));
  const pending = runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  assert.equal(harness.spawns.length, 1);
  harness.clock.advance(policy.timeoutMs);
  const result = await pending;
  assert.equal(result.timeoutCount, policy.optimizeAfterTimeouts);
  assert.equal(result.nextAction, 'optimize');
  assert.equal(result.groupState, 'optimize');
  assert.equal(result.group, key.group);
});

test('at the timeout limit the group still runs and keeps its timeout count', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ timeoutCount: policy.maxGroupTimeouts, state: 'confirm-known-red', knownRed: [alpha] }));
  const result = await runTestRun(fixtureRequest({ files: files.slice(0, 2) }), harness.config, policy, harness.context, harness.ports);
  assert.notEqual(result.outcome, 'refused');
  assert.equal(harness.spawns.length, 1);
  assert.equal(result.timeoutCount, policy.maxGroupTimeouts);
});

test('--only confirms exact known IDs with metacharacters rather than matching neighbors', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ timeoutCount: policy.maxGroupTimeouts, state: 'confirm-known-red', knownRed: [alpha] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  const result = await runTestRun(fixtureRequest({ files: undefined, only: [alpha] }), harness.config, policy, harness.context, harness.ports);
  assert.deepEqual(result.selection.testIds, [alpha]);
  assert.deepEqual(result.selection.files, [alpha.file]);
  assert.equal(harness.spawns.length, 1);
  const argv = harness.spawns[0].argv;
  const index = argv.findIndex(arg => arg.startsWith('--test-name-pattern'));
  assert.ok(index >= 0);
  const pattern = argv[index].includes('=') ? argv[index].slice(argv[index].indexOf('=') + 1) : argv[index + 1];
  const matcher = new RegExp(pattern);
  assert.equal(matcher.test(alpha.name), true);
  for (const neighbor of [alpha.name + ' extra', 'prefix ' + alpha.name, 'literal axxx x one', 'two']) assert.equal(matcher.test(neighbor), false);
  assert.equal(result.timeoutCount, policy.maxGroupTimeouts);
  assert.deepEqual(result.knownRed, []);
});

test('CLI --only resolves stable file/name IDs rather than accepting a test-name regex', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ timeoutCount: policy.maxGroupTimeouts, state: 'confirm-known-red', knownRed: [alpha] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  const output: string[] = [];
  await runTestRunCli(['--project', 'raf', '--phase', 'implement', '--group', key.group, '--only', JSON.stringify(alpha)], {
    config: harness.config, policy, context: harness.context, runtime: harness.ports,
    stdout: line => output.push(line), stderr: () => {},
  });
  assert.deepEqual((JSON.parse(output.join('')) as TestRunResult).selection.testIds, [alpha]);
  assert.equal(harness.spawns.length, 1);
});

for (const reason of ['unsupported exact selection', 'files and only']) {
  test(`confirmation refuses ${reason} without falling back to the whole file`, async () => {
    const harness = new RunHarness();
    harness.state.seed(fixtureGroup({ timeoutCount: policy.maxGroupTimeouts, state: 'confirm-known-red', knownRed: [alpha] }));
    if (reason === 'unsupported exact selection') harness.config.projects.raf.profiles.node.exactIds = null;
    const result = await runTestRun(fixtureRequest({
      files: reason === 'files and only' ? [alpha.file] : undefined,
      only: [alpha],
    }), harness.config, policy, harness.context, harness.ports);
    assert.equal(result.outcome, 'refused');
    assert.equal(harness.spawns.length, 0);
    assert.deepEqual(harness.state.get()?.knownRed, [alpha]);
  });
}

test('confirmation timeout retains all unconfirmed known reds and uses the original deadline', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  harness.state.seed(fixtureGroup({ timeoutCount: policy.maxGroupTimeouts, state: 'confirm-known-red', knownRed: [alpha, beta] }));
  const started = harness.clock.now();
  const pending = runTestRun(fixtureRequest({ files: undefined, only: [alpha, beta] }), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  assert.equal(harness.spawns.length, 1);
  harness.clock.advance(policy.timeoutMs);
  const result = await pending;
  assert.equal(result.outcome, 'timed-out');
  assert.deepEqual(result.knownRed, [alpha, beta]);
  assert.deepEqual(harness.state.get()?.knownRed, [alpha, beta]);
  assert.equal(result.nextAction, 'confirm-known-red');
  assert.equal(harness.cleanupCalls[0].deadline, started + policy.timeoutMs);
});

test('truncated output and setup errors cannot erase prior known reds', async () => {
  for (const events of [[], [{ kind: 'setup-failed', test: beta }]] as RunnerEvent[][]) {
    const harness = new RunHarness();
    harness.state.seed(fixtureGroup({ knownRed: [alpha] }));
    harness.events = events;
    harness.exit.exitCode = 1;
    const result = await runTestRun(fixtureRequest({ phase: 'implement' }), harness.config, policy, harness.context, harness.ports);
    assert.deepEqual(result.knownRed, [alpha]);
    assert.deepEqual(harness.state.get()?.knownRed, [alpha]);
    assert.equal(result.timeoutCount, 0);
    assert.notEqual(result.outcome, 'passed');
  }
});

test('two agents racing the same group reserve at most one process', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  const first = runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  const second = runTestRun(fixtureRequest({ phase: 'implement' }), harness.config, policy, { ...harness.context, agentId: 'second-agent' }, harness.ports);
  await flushMicrotasks();
  assert.equal(harness.spawns.length, 1);
  harness.resolveExit?.(harness.exit);
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(result => result.outcome === 'refused').length, 1);
  assert.equal(results.filter(result => result.outcome === 'passed').length, 1);
});

test('unreconciled in-flight state blocks a repeat without resetting the counter', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({
    timeoutCount: policy.optimizeAfterTimeouts, state: 'running',
    inFlight: { runId: 'lost-wrapper', deadlineMs: harness.clock.now() + policy.timeoutMs, processIdentity: 'old-process' },
  }));
  harness.recovered.alive = true;
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.notEqual(result.outcome, 'passed');
  assert.equal(harness.spawns.length, 0);
  assert.equal(harness.state.get()?.timeoutCount, policy.optimizeAfterTimeouts);
});

for (const deadlineReached of [false, true]) {
  test(`recovery is idempotent and counts only a confirmed deadline: ${deadlineReached}`, async () => {
    const harness = new RunHarness();
    harness.state.seed(fixtureGroup({
      state: 'running', knownRed: [alpha],
      inFlight: { runId: 'lost-wrapper', deadlineMs: harness.clock.now() - 1, processIdentity: 'old-process' },
    }));
    harness.recovered.deadlineReached = deadlineReached;
    const first = await reconcileTestRunGroup(key, policy, harness.context, harness.ports);
    const second = await reconcileTestRunGroup(key, policy, harness.context, harness.ports);
    assert.equal(first?.timeoutCount, deadlineReached ? 1 : 0);
    assert.equal(second?.timeoutCount, first?.timeoutCount);
    assert.deepEqual(second?.knownRed, [alpha]);
    assert.notEqual(second?.lastResult?.outcome, 'passed');
    assert.equal(harness.spawns.length, 0);
  });
}

test('recovery cannot release the reservation while a process remains alive', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ state: 'running', inFlight: { runId: 'lost-wrapper', deadlineMs: harness.clock.now() + policy.timeoutMs, processIdentity: 'old-process' } }));
  harness.recovered = { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [103] } };
  const recovered = await reconcileTestRunGroup(key, policy, harness.context, harness.ports);
  assert.ok(recovered?.inFlight);
  assert.equal(recovered?.timeoutCount, 0);
  assert.equal(harness.spawns.length, 0);
});

test('closing a change removes only its inactive aggregates without creating run history', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup());
  const otherKey = { ...key, group: 'still-active/unit' };
  harness.state.seed(fixtureGroup({ key: otherKey }));
  await cleanupClosedTestRunGroups(['still-active'], harness.context, harness.ports);
  assert.equal(harness.state.get(), undefined);
  assert.ok(harness.state.get(otherKey));
  assert.equal(harness.state.records.size, 1);
  assert.equal(harness.spawns.length, 0);
});

test('successful confirmation removes only executed known reds and keeps the untouched remainder', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ timeoutCount: policy.maxGroupTimeouts, state: 'confirm-known-red', knownRed: [alpha, beta], unexecuted: [gamma] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  const result = await runTestRun(fixtureRequest({ files: undefined, only: [alpha] }), harness.config, policy, harness.context, harness.ports);
  assert.deepEqual(result.knownRed, [beta]);
  assert.deepEqual(result.unexecuted, [gamma]);
  assert.equal(result.nextAction, 'confirm-known-red');
  assert.equal(harness.spawns.length, 1);
  assert.deepEqual(result.selection.files, [alpha.file]);
});

test('setup errors on an existing aggregate preserve its previous timeout count', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ timeoutCount: policy.optimizeAfterTimeouts, state: 'optimize' }));
  harness.events = [{ kind: 'setup-failed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  harness.exit.exitCode = 1;
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'setup-failed');
  assert.equal(result.timeoutCount, policy.optimizeAfterTimeouts);
  assert.equal(harness.state.get()?.timeoutCount, policy.optimizeAfterTimeouts);
});

test('a late duplicate deadline notification cannot apply one run twice', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  const pending = runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  const callback = [...harness.clock.jobs.values()].find(job => job.deadline === harness.clock.now() + policy.timeoutMs)?.callback;
  assert.ok(callback);
  harness.clock.advance(policy.timeoutMs);
  const result = await pending;
  callback();
  await flushMicrotasks();
  assert.equal(result.timeoutCount, 1);
  assert.equal(harness.state.get()?.timeoutCount, 1);
});

test('state-port failure cannot silently fall back to a separate project or session database', async () => {
  const harness = new RunHarness();
  harness.ports.state = { transaction: async () => { throw new Error('SQLITE_CANTOPEN'); } };
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'setup-failed');
  assert.equal(harness.spawns.length, 0);
  assert.equal(result.exitCode, null);
});

test('a mixed setup/assertion red cannot authorize implementation', async () => {
  const harness = new RunHarness();
  harness.events = [
    { kind: 'assertion-failed', test: alpha }, { kind: 'setup-failed', test: beta },
    { kind: 'complete', expected: [alpha, beta] },
  ];
  harness.exit.exitCode = 1;
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.nextAction, 'fix-setup');
  assert.equal(result.outcome, 'setup-failed');
  assert.deepEqual(result.knownRed, [alpha]);
  assert.equal(result.timeoutCount, 0);
});

for (const phase of ['red', 'implement', 'hotfix']) {
  test(`assertion failure selects the phase action: ${phase}`, async () => {
    const harness = new RunHarness();
    harness.events = [{ kind: 'assertion-failed', test: alpha }, { kind: 'complete', expected: [alpha] }];
    harness.exit.exitCode = 1;
    const result = await runTestRun(fixtureRequest({ phase }), harness.config, policy, harness.context, harness.ports);
    assert.equal(result.outcome, 'assertions-failed');
    assert.equal(result.nextAction, phase === 'red' ? 'implement' : 'fix-implementation');
  });
}
