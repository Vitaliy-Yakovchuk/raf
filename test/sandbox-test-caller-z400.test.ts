import assert from 'node:assert/strict';
import test from 'node:test';
import { runSandboxTestCommand } from '../src/sandbox-test-run.ts';
import type { SandboxCommandReply, SandboxTestAssignment, SandboxTestRunPorts, SandboxUnitContext } from '../src/sandbox-test-run.ts';
import { resolveSandboxTestCaller } from '../src/sandbox-test-caller.ts';
import type { SandboxCallerClaim, SandboxCallerControlSnapshot, SandboxCallerProcess, SandboxCallerSnapshot } from '../src/sandbox-test-caller.ts';
import type { TestRunConfig, TestRunGroupKey, TestRunRequest } from '../src/test-runs.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Evidence = Mutable<Omit<SandboxCallerSnapshot, 'ancestors' | 'claims'>> & {
  ancestors: Mutable<SandboxCallerProcess>[];
  claims: Mutable<SandboxCallerClaim>[];
};

const workspace = '/fixture/raf-develop';
const ownGroup = 'complete-raf-flow-contracts/z350';
const foreignGroup = 'add-raf-test-run/unit';
const ownFile = 'test/caller-fixture.test.ts';
const foreignFile = 'test/wrapper-fixture.test.ts';
const entrypoint = ['node', '/trusted/raf-main/bin/raf.ts'];
const stamp = (pid: number) => `2026-10-24T00:00:${String(pid % 60).padStart(2, '0')}.000Z`;
const identity = (pid: number) => ({ pid, startedAt: stamp(pid) });

function assignment(phase = 'implement', runId = 'live-run'): SandboxTestAssignment {
  return { runId, agentId: 'fixture-worker', type: phase, phase, project: 'raf', workspace, branch: 'develop', changes: ['complete-raf-flow-contracts'] };
}

function command(phase = 'implement', group = ownGroup, tail = ''): string {
  return `${entrypoint.join(' ')} test run --project raf --phase ${phase} --group ${group}${tail}`;
}

function fixture(phase = 'implement') {
  const worker = assignment(phase);
  const main = { ...assignment('main', 'main-run'), agentId: 'main', type: 'main' };
  const evidence: Evidence = {
    caller: identity(440), machineId: 'machine-a', bootId: 'boot-a',
    ancestors: [440, 430, 420, 410, 100].map((pid, index, pids) => ({
      ...identity(pid), parentPid: pids[index + 1] ?? null,
      machineId: 'machine-a', bootId: 'boot-a', originVerified: true,
    })),
    claims: [worker, main].map((value, index) => ({
      process: { ...identity(index === 0 ? 410 : 100), machineId: 'machine-a', bootId: 'boot-a' },
      state: 'running', runId: value.runId, assignment: value,
    })),
  };
  const config = {
    diagnostics: { maxEntries: 7, maxMessageBytes: 512, maxStackFrames: 3, maxStackBytes: 1024, maxTotalBytes: 4096, maxStderrBytes: 1024, redactionPatterns: [] },
    temporaryArtifacts: { root: '/fixture/tmp', minimumNestedSocketPathBytes: 20 },
    phases: Object.fromEntries(['implement', 'qa', 'hotfix', 'red', 'integration'].map(value => [value, {
      allowed: true, purpose: value === 'red' ? 'initial-red' : 'verification',
      hints: { refusal: 'refusal', setup: 'setup', assertions: 'assertions', timeout: 'timeout', interruption: 'interruption' },
    }])),
    hints: { refusal: 'Correct the authorized request.', setup: 'Repair setup.', assertions: 'Implement behavior.', timeout: 'Use the existing group budget.', interruption: 'Verify cleanup.' },
    projects: { raf: {
      profiles: { node: { cwd: '.', executable: 'node', argv: ['./fixture-runner.ts'], unitFiles: [ownFile, foreignFile, 'test/unselected.test.ts'], exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [] } },
      groups: { [ownGroup]: { profileId: 'node', files: [ownFile] }, [foreignGroup]: { profileId: 'node', files: [foreignFile] } },
    } },
  };
  const snapshot: Mutable<SandboxCallerControlSnapshot> = {
    ancestors: evidence.ancestors.map(({ pid, startedAt }) => ({ pid, startedAt })),
    sessions: evidence.claims.map(claim => ({ process: claim.process, state: claim.state, assignment: claim.assignment! })),
    workspaces: [{ project: 'raf', workspace, branch: 'develop', actualBranch: 'develop' }],
    activeChanges: ['complete-raf-flow-contracts', 'add-raf-test-run'],
    groups: [ownGroup, foreignGroup].map(group => ({ project: 'raf', workspace, group })),
    config: config as SandboxCallerControlSnapshot['config'],
    callerEvidence: evidence,
  };
  const calls = { control: 0, unitContext: [] as TestRunGroupKey[], wrapper: [] as { request: TestRunRequest; context: SandboxUnitContext }[], state: 0, recovery: 0, spawn: 0, communicate: 0 };
  const aggregate = {
    selection: { files: [ownFile], testIds: [] }, timeoutCount: 2,
    knownRed: [{ file: ownFile, name: 'existing red' }], unexecuted: [{ file: ownFile, name: 'pending' }],
    removed: [{ file: ownFile, name: 'removed' }], lastResult: { runId: 'previous-run', outcome: 'timed-out' },
    inFlight: { runId: 'other-owned-run', deadlineMs: 997, processIdentity: 'other-process' },
    kind: 'unit', profileId: 'node',
  };
  const before = structuredClone(aggregate);
  const key: TestRunGroupKey = { project: 'raf', workspace, group: ownGroup };
  const context: SandboxUnitContext = {
    config, policy: { timeoutMs: 1234, optimizeAfterTimeouts: 3, maxGroupTimeouts: 5 },
    context: { cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] }, agentPhases: ['implement', 'qa', 'hotfix', 'main', 'coordinator', 'red', 'integration'], activeChanges: snapshot.activeChanges.slice(), agentId: worker.agentId, sha: 'a'.repeat(40), home: '/fixture/qa-home', statePath: '/fixture/qa-home/state.sqlite', tmpPath: '/fixture/qa-tmp', operationalHome: '/fixture/control-home' },
    runtime: {
      async preflight() { throw new Error('External wrapper is mocked; preflight must not run.'); },
      state: { async transaction() { calls.state++; throw new Error('Broker must not open test state.'); } },
      clock: { now: () => 19, schedule: () => () => {} },
      newRunId: () => 'wrapper-run',
      async spawn() { calls.spawn++; throw new Error('Broker must not spawn a runner directly.'); },
      subscribeInterruption: () => () => {},
      async reconcile() { calls.recovery++; throw new Error('Broker must not recover test state.'); },
    },
  };
  const expectedReply: SandboxCommandReply = {
    code: 0, stderr: 'fixture stderr\n', stdout: JSON.stringify({
      runId: 'wrapper-run', project: 'raf', workspace, phase, callerPhase: phase, group: ownGroup,
      testKind: 'unit', timeoutPolicy: { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: context.policy.timeoutMs },
      outcome: 'passed', failureKinds: [], profileId: 'node', selection: { files: [ownFile], testIds: [] },
      command: { executable: 'node', argv: ['./fixture-runner.ts', ownFile], cwd: workspace, shell: false, environment: { HOME: context.context.home, statePath: context.context.statePath, tmpPath: context.context.tmpPath } },
      startedAt: '2026-10-24T00:00:00.000Z', durationMs: 7, exitCode: 0, signal: null,
      timedOut: false, cleanup: { complete: true, remainingPids: [] }, passed: [{ file: ownFile, name: 'fixture success' }],
      knownRed: [], unexecuted: [], unknown: [], removed: [], timeoutCount: 2,
      groupState: 'complete', nextAction: 'complete', hintIds: [], hints: [], evidence: [], diagnostics: [],
      diagnosticSummary: { totalEntries: 0, retainedEntries: 0, omittedEntries: 0, truncated: false, redacted: false },
      environmentSummary: { privateRunTmp: true },
    }) + '\n',
  };
  const ports: SandboxTestRunPorts = {
    caller: evidence.caller, entrypoint,
    async control(caller) { calls.control++; assert.deepEqual(caller, evidence.caller); return snapshot; },
    async unitContext(requestedKey) { calls.unitContext.push(structuredClone(requestedKey)); return structuredCloneContext(requestedKey); },
    async wrapper(request, suppliedContext) {
      calls.wrapper.push({ request, context: suppliedContext });
      const output = JSON.parse(expectedReply.stdout);
      output.group = request.group;
      output.phase = request.phase;
      output.callerPhase = suppliedContext.context.callerPhase;
      output.selection.files = (config as TestRunConfig).projects.raf.groups[request.group].files.slice();
      output.profileId = (config as TestRunConfig).projects.raf.groups[request.group].profileId;
      output.command.environment.HOME = suppliedContext.context.home;
      output.command.environment.statePath = suppliedContext.context.statePath;
      output.command.environment.tmpPath = suppliedContext.context.tmpPath;
      output.command.argv = ['./fixture-runner.ts', ...output.selection.files];
      output.passed = [{ file: output.selection.files[0], name: 'fixture success' }];
      if (request.phase === 'integration') {
        output.testKind = 'integration';
        output.timeoutPolicy = { source: 'conf/flow.json#/integrationTests/timeoutMs', timeoutMs: suppliedContext.context.integrationTests?.timeoutMs };
      }
      return { ...expectedReply, stdout: JSON.stringify(output) + '\n' };
    },
    async communicate() { calls.communicate++; throw new Error('A test run must not become a message or implicit delegation.'); },
  };
  function structuredCloneContext(requestedKey: TestRunGroupKey): SandboxUnitContext {
    const home = requestedKey.group === foreignGroup ? '/fixture/qa-foreign-home' : context.context.home;
    return { ...context, context: { ...context.context, home, statePath: `${home}/state.sqlite` } };
  }
  async function invoke(source = command(phase)): Promise<SandboxCommandReply> {
    return runSandboxTestCommand({ command: source, cwd: workspace }, ports);
  }
  return { evidence, snapshot, worker, main, ports, calls, aggregate, before, key, context, expectedReply, invoke };
}

type Fixture = ReturnType<typeof fixture>;

function assertDenied(f: Fixture, reply: SandboxCommandReply, reason: RegExp, action: RegExp): void {
  assert.notEqual(reply.code, 0, 'authorization refusal must have a nonzero CLI code');
  const text = `${reply.stdout}\n${reply.stderr}`;
  assert.match(text, /CALLER_UNAUTHORIZED/);
  assert.match(text, reason, 'reason must distinguish the actual caller failure');
  assert.match(text, action, 'remediation must be possible within existing phase rights');
  assert.doesNotMatch(text, /run (?:the )?(?:exact|same) command (?:as|by|through) main|main (?:must|should|can) (?:execute|run|repeat) .*--phase (?:implement|qa|hotfix)/i);
  assert.deepEqual(f.calls.unitContext, [], 'authorization must precede QA context selection');
  assert.deepEqual(f.calls.wrapper, []);
  assert.equal(f.calls.state, 0);
  assert.equal(f.calls.recovery, 0);
  assert.equal(f.calls.spawn, 0);
  assert.equal(f.calls.communicate, 0);
  assert.deepEqual(f.aggregate, f.before, 'denial must preserve selection, budget, knownRed, lastResult and other inFlight');
}

const restore = /(?:restor|repair|re.?establish|віднов).*(?:channel|ancestry|identity|канал|зв[’']яз)|(?:channel|канал).*(?:restor|repair|віднов)/is;
const relaunch = /(?:new|fresh|нов).*(?:assignment|launch|run|дорученн|запуск)/is;

for (const phase of ['implement', 'qa', 'hotfix']) {
  for (const selector of ['preset', 'files']) {
    test(`Z400.C01 broker ${phase} CLI-helper-shell-session ${selector}`, async () => {
      const f = fixture(phase);
      const reply = await f.invoke(command(phase, ownGroup, selector === 'files' ? ` --files ${ownFile}` : ''));
      assert.deepEqual(reply, f.expectedReply, 'broker must preserve complete wrapper stdout/stderr/CLI code');
      assert.equal(f.calls.control, 1);
      assert.deepEqual(f.calls.unitContext, [f.key]);
      assert.equal(f.calls.wrapper.length, 1);
      assert.equal(f.calls.wrapper[0].request.phase, phase);
      assert.equal(f.calls.wrapper[0].request.group, ownGroup);
      assert.equal(f.calls.wrapper[0].context.context.callerPhase, phase);
      assert.equal(f.calls.wrapper[0].context.context.home, '/fixture/qa-home');
      assert.equal(f.calls.wrapper[0].context.context.statePath, '/fixture/qa-home/state.sqlite');
      assert.notEqual(f.calls.wrapper[0].context.context.home, f.context.context.operationalHome);
      assert.equal(f.calls.communicate, 0);
    });
  }
}

const deniedEvidence: { id: string; mutate: (f: Fixture) => void; reason: RegExp; action: RegExp }[] = [
  { id: 'no-registered-claim', mutate(f) { f.evidence.claims = []; }, reason: /unknown|unregistered|caller|невідом|виклик/i, action: restore },
  { id: 'unknown-ancestry', mutate(f) { f.evidence.ancestors = f.evidence.ancestors.slice(0, 3); f.evidence.ancestors[2].parentPid = null; }, reason: /unknown|ancestry|unregistered|невідом|походжен/i, action: restore },
  { id: 'detached-reparented-helper', mutate(f) { f.evidence.ancestors[1].parentPid = 1; }, reason: /ancestry|parent|link|detached|походжен|зв[’']яз/i, action: restore },
  { id: 'closed-nearest-live-main-farther', mutate(f) { f.evidence.claims[0].state = 'finished'; }, reason: /closed|finished|закрит|заверш/i, action: relaunch },
  { id: 'reused-pid', mutate(f) { f.evidence.claims[0].process = { ...f.evidence.claims[0].process, startedAt: '2020-01-01T00:00:00.000Z' }; }, reason: /identity|reus|start|ідентич|повтор/i, action: restore },
  { id: 'boot-mismatch-claim', mutate(f) { f.evidence.claims[0].process = { ...f.evidence.claims[0].process, bootId: 'old-boot' }; }, reason: /boot|identity|завантаж|ідентич/i, action: restore },
  { id: 'machine-mismatch-claim', mutate(f) { f.evidence.claims[0].process = { ...f.evidence.claims[0].process, machineId: 'other-machine' }; }, reason: /machine|identity|машин|ідентич/i, action: restore },
  { id: 'machine-mismatch-os-observation', mutate(f) { f.evidence.ancestors[3].machineId = 'other-machine'; }, reason: /machine|identity|машин|ідентич/i, action: restore },
  { id: 'boot-mismatch-os-observation', mutate(f) { f.evidence.ancestors[3].bootId = 'other-boot'; }, reason: /boot|identity|завантаж|ідентич/i, action: restore },
  { id: 'origin-not-verified', mutate(f) { f.evidence.ancestors[3].originVerified = false; }, reason: /origin|identity|unverified|походжен|ідентич|підтвердж/i, action: restore },
  { id: 'missing-immutable-assignment', mutate(f) { f.evidence.claims[0].assignment = null; }, reason: /assignment|дорученн/i, action: relaunch },
  { id: 'runId-mismatch', mutate(f) { f.evidence.claims[0].runId = 'different-run'; }, reason: /run.?id|identity|запуск|ідентич/i, action: relaunch },
  { id: 'caller-startedAt-mismatch', mutate(f) { f.evidence.ancestors[0].startedAt = '2020-01-01T00:00:00.000Z'; }, reason: /identity|start|ідентич/i, action: restore },
];

for (const scenario of deniedEvidence) {
  test(`Z400.C02 broker ${scenario.id} cannot fall back to main`, async () => {
    const f = fixture();
    scenario.mutate(f);
    assertDenied(f, await f.invoke(), scenario.reason, scenario.action);
  });
  test(`Z400.C02 resolver ${scenario.id}`, () => {
    const f = fixture();
    scenario.mutate(f);
    assert.throws(() => resolveSandboxTestCaller(f.evidence), scenario.reason);
  });
}

for (const order of ['historical-first', 'historical-last']) {
  test(`Z400.C03 broker historical claim cannot replace unique live run ${order}`, async () => {
    const f = fixture();
    const old: Mutable<SandboxCallerClaim> = { ...f.evidence.claims[0], state: 'finished', runId: 'old-run', assignment: assignment('spec', 'old-run') };
    f.evidence.claims.splice(order === 'historical-first' ? 0 : 1, 0, old);
    const oldSession = { process: old.process, state: old.state, assignment: old.assignment! };
    f.snapshot.sessions = order === 'historical-first' ? [oldSession, ...f.snapshot.sessions] : [...f.snapshot.sessions, oldSession];
    assert.deepEqual(await f.invoke(), f.expectedReply);
    assert.equal(f.calls.wrapper[0].context.context.callerPhase, 'implement');
  });
  test(`Z400.C03 resolver historical claim cannot replace unique live run ${order}`, () => {
    const f = fixture();
    const old: Mutable<SandboxCallerClaim> = { ...f.evidence.claims[0], state: 'finished', runId: 'old-run', assignment: assignment('spec', 'old-run') };
    f.evidence.claims.splice(order === 'historical-first' ? 0 : 1, 0, old);
    assert.deepEqual(resolveSandboxTestCaller(f.evidence), f.worker);
  });
  test(`Z400.C03 broker contradictory live claims refuse ${order}`, async () => {
    const f = fixture();
    const conflict = { ...f.evidence.claims[0], runId: 'conflicting-live-run', assignment: assignment('qa', 'conflicting-live-run') };
    f.evidence.claims.splice(order === 'historical-first' ? 0 : 1, 0, conflict);
    const conflictingSession = { process: conflict.process, state: conflict.state, assignment: conflict.assignment! };
    f.snapshot.sessions = order === 'historical-first' ? [conflictingSession, ...f.snapshot.sessions] : [...f.snapshot.sessions, conflictingSession];
    assertDenied(f, await f.invoke(), /ambigu|conflict|multiple|неоднознач|супереч/i, restore);
  });
  test(`Z400.C03 resolver contradictory live claims refuse ${order}`, () => {
    const f = fixture();
    const conflict = { ...f.evidence.claims[0], runId: 'conflicting-live-run', assignment: assignment('qa', 'conflicting-live-run') };
    f.evidence.claims.splice(order === 'historical-first' ? 0 : 1, 0, conflict);
    assert.throws(() => resolveSandboxTestCaller(f.evidence), /ambigu|conflict|multiple|неоднознач|супереч/i);
  });
}

test('Z400.C04 broker denied reason is sanitized and does not dump ancestry commands or secrets', async () => {
  const f = fixture();
  f.evidence.claims[0].assignment = null;
  Object.assign(f.evidence.ancestors[3], { commandLine: 'runner --token SECRET_Z400_COMMAND' });
  Object.assign(f.evidence.claims[0], { rawEnvironment: { API_TOKEN: 'SECRET_Z400_ENV' }, rawBrief: 'SECRET_Z400_BRIEF' });
  const reply = await f.invoke();
  assertDenied(f, reply, /assignment|дорученн/i, relaunch);
  assert.doesNotMatch(reply.stdout + reply.stderr, /SECRET_Z400_|rawEnvironment|commandLine|rawBrief/);
});

for (const order of ['first', 'last']) {
  test(`Z400.C03 broker same runId conflicting assignments refuse ${order}`, async () => {
    const f = fixture();
    const conflictingAssignment = { ...f.worker, agentId: 'conflicting-agent' };
    const claim = { ...f.evidence.claims[0], assignment: conflictingAssignment };
    f.evidence.claims.splice(order === 'first' ? 0 : 1, 0, claim);
    const session = { process: claim.process, state: claim.state, assignment: conflictingAssignment };
    f.snapshot.sessions = order === 'first' ? [session, ...f.snapshot.sessions] : [...f.snapshot.sessions, session];
    assertDenied(f, await f.invoke(), /ambigu|conflict|multiple|неоднознач|супереч/i, restore);
  });
}

test('Z400.C05 broker repaired channel repeats exact command with same group HOME and policy', async () => {
  const f = fixture();
  const source = command();
  f.evidence.ancestors[1].parentPid = 1;
  assertDenied(f, await f.invoke(source), /ancestry|parent|link|походжен|зв[’']яз/i, restore);
  f.evidence.ancestors[1].parentPid = 420;
  assert.deepEqual(await f.invoke(source), f.expectedReply);
  assert.deepEqual(f.calls.unitContext, [f.key]);
  assert.equal(f.calls.wrapper[0].request.phase, 'implement');
  assert.equal(f.calls.wrapper[0].context.context.home, f.context.context.home);
  assert.deepEqual(f.calls.wrapper[0].context.policy, f.context.policy);
  assert.deepEqual(f.aggregate, f.before);
});

test('Z400.C05 broker stale ps running is not authority after lifecycle closes', async () => {
  const f = fixture();
  assert.equal(f.snapshot.sessions[0].state, 'running');
  f.evidence.claims[0].state = 'finished';
  assertDenied(f, await f.invoke(), /closed|finished|закрит|заверш/i, relaunch);
});

test('Z400.C01 resolver returns the nearest session immutable assignment through unregistered helpers', () => {
  const f = fixture();
  assert.deepEqual(resolveSandboxTestCaller(f.evidence), f.worker);
});

for (const role of ['main', 'implement', 'qa', 'hotfix']) {
  test(`Z400.C05 broker ${role} retains its existing own integration permission`, async () => {
    const f = fixture(role);
    if (role === 'main') {
      f.evidence.claims = f.evidence.claims.slice(1);
      f.snapshot.sessions = f.snapshot.sessions.slice(1);
    }
    const group = 'complete-raf-flow-contracts/integration-fixture';
    const file = 'test/integration-fixture.test.ts';
    const config = f.context.config as TestRunConfig;
    config.projects.raf.profiles['node-integration'] = {
      cwd: '.', executable: 'node', argv: ['./fixture-runner.ts'], testKind: 'integration', integrationFiles: [file],
      exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [],
    };
    config.projects.raf.groups[group] = { profileId: 'node-integration', files: [file] };
    f.snapshot.groups = [...f.snapshot.groups, { ...f.key, group }];
    f.context.context.integrationTests = { timeoutMs: 4321 };
    const reply = await f.invoke(command('integration', group));
    assert.equal(reply.code, 0);
    assert.equal(f.calls.wrapper.length, 1);
    assert.equal(f.calls.wrapper[0].request.phase, 'integration');
    assert.equal(f.calls.wrapper[0].context.context.callerPhase, role);
    assert.equal(JSON.parse(reply.stdout).testKind, 'integration');
    assert.equal(JSON.parse(reply.stdout).timeoutPolicy.source, 'conf/flow.json#/integrationTests/timeoutMs');
  });
}
