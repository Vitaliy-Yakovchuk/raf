import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runSandboxTestCommand } from '../src/sandbox-test-run.ts';
import type { SandboxCommandReply, SandboxTestAssignment, SandboxTestControlSnapshot, SandboxTestRunPorts, SandboxUnitContext } from '../src/sandbox-test-run.ts';
import { acknowledgeTestRunDelivery } from '../src/test-run-state-recovery.ts';
import type { TestRunConfig, TestRunGroupKey, TestRunRequest } from '../src/test-runs.ts';
import { cleanupClosedTestRunGroups, runTestRun } from '../src/test-runs.ts';
import type {
  TestRunContext, TestRunGroup, TestRunPorts, TestRunResult, TestRunTransaction, UnitTestPolicy,
} from '../src/test-runs.ts';

const source = 'add-raf-test-run';
const target = 'fix-raf-load-admission';
const group = `${target}/estimates-legacy`;
const secondGroup = `${target}/estimates`;
const workspace = '/workspace/raf-develop';
const files = ['test/task-context.test.ts', 'test/production-runtime.test.ts'];
const otherFile = 'test/resource-estimates.test.ts';
const ownFile = 'test/sandbox-test-regression-groups.test.ts';
const entrypoint = ['node', '/trusted/raf/bin/raf.ts'];

function configuration(): Pick<TestRunConfig, 'projects' | 'phases'> {
  const phases: TestRunConfig['phases'] = {};
  for (const phase of ['implement', 'qa', 'hotfix', 'red', 'main', 'coordinator', 'spec', 'design', 'test-scaffold']) {
    phases[phase] = {
      allowed: ['implement', 'qa', 'hotfix', 'red'].includes(phase),
      purpose: phase === 'red' ? 'initial-red' : 'verification',
      hints: { refusal: 'refusal', setup: 'setup', assertions: 'assertions', timeout: 'timeout', interruption: 'interruption' },
    };
  }
  return {
    phases,
    projects: {
      raf: {
        profiles: {
          node: {
            cwd: '.', executable: 'node', argv: ['./scripts/test-run-node.ts'],
            unitFiles: [...files, otherFile, ownFile, 'test/unrelated.test.ts'],
            exactIds: 'node-test-name', resultAdapter: 'node-test-events',
            environment: { isolatedHome: true, stateOrigin: true }, checks: [],
          },
        },
        groups: {
          [group]: { profileId: 'node', files: [...files] },
          [secondGroup]: { profileId: 'node', files: [otherFile] },
          [`${target}/sibling`]: { profileId: 'node', files: [ownFile] },
          [`${source}/foreign-regressions`]: { profileId: 'node', files: [ownFile] },
        },
      },
    },
  };
}

function assignment(overrides: Partial<SandboxTestAssignment> = {}): SandboxTestAssignment {
  return {
    runId: 'source-run', agentId: 'source-agent', type: 'implement', phase: 'implement',
    project: 'raf', workspace, branch: 'develop', changes: [source],
    ...overrides,
  };
}

function control(a = assignment()): SandboxTestControlSnapshot {
  return {
    ancestors: [{ pid: 501, startedAt: 'caller-start' }, { pid: 500, startedAt: 'parent-start' }],
    sessions: [{ process: { pid: 500, startedAt: 'parent-start' }, state: 'running', assignment: a }],
    workspaces: [{ project: 'raf', workspace, branch: 'develop', actualBranch: 'develop' }],
    activeChanges: [source, target], groups: [], config: configuration(),
  };
}

function request(overrides: Partial<TestRunRequest> = {}): TestRunRequest {
  return { project: 'raf', phase: 'implement', group, ...overrides };
}

function harness(a = assignment()) {
  const c = control(a);
  const calls: string[] = [];
  const keys: TestRunGroupKey[] = [];
  const forwarded: TestRunRequest[] = [];
  const context = Object.freeze({ marker: 'stable isolated target QA context' }) as unknown as SandboxUnitContext;
  let reply: SandboxCommandReply = { code: 0, stdout: '{"outcome":"passed"}\n', stderr: '' };
  const ports: SandboxTestRunPorts = {
    caller: { pid: 501, startedAt: 'caller-start' }, entrypoint,
    async control(caller) { assert.deepEqual(caller, ports.caller); calls.push('control'); return c; },
    async unitContext(key) { calls.push('unitContext'); keys.push(structuredClone(key)); return context; },
    async communicate() { calls.push('communicate'); return { code: 0, stdout: 'communication reply', stderr: '' }; },
    async wrapper(r, unit) {
      calls.push('wrapper'); assert.equal(unit, context); forwarded.push(structuredClone(r)); return reply;
    },
  };
  function command(tail = `test run --project raf --phase ${a.phase} --group ${group}`) {
    return { command: `${entrypoint.join(' ')} ${tail}`, cwd: workspace };
  }
  return { c, calls, keys, forwarded, context, ports, command, setReply(value: SandboxCommandReply) { reply = value; } };
}


test('R05 unknown ID inside the preset is left to the authorized wrapper, with UNKNOWN_RED_TEST intact', async () => {
  const h = harness();
  const only = { file: files[0], name: 'unknown literal target test' };
  const reply = { code: 1, stdout: '{"outcome":"refused","errorCode":"UNKNOWN_RED_TEST"}\n', stderr: 'unknown target knownRed' };
  h.setReply(reply);
  assert.deepEqual(await runSandboxTestCommand(h.command(`test run --project raf --phase implement --group ${group} --only '${JSON.stringify(only)}'`), h.ports), reply);
  assert.deepEqual(h.forwarded, [request({ only: [only] })]);
  assert.deepEqual(h.keys, [{ project: 'raf', workspace, group }]);
  assert.deepEqual(h.calls, ['control', 'unitContext', 'wrapper']);
});

test('R05 foreign preset and explicit subset forward exact ordinary wrapper requests without a declaration', async () => {
  const h = harness();
  await runSandboxTestCommand(h.command(), h.ports);
  await runSandboxTestCommand(h.command(`test run --project raf --phase implement --group ${group} --files ${files[1]}`), h.ports);
  await runSandboxTestCommand(h.command(`test run --project raf --phase implement --group ${secondGroup}`), h.ports);
  assert.deepEqual(h.forwarded, [request(), request({ files: [files[1]] }), request({ group: secondGroup })]);
  assert.deepEqual(h.keys, [
    { project: 'raf', workspace, group }, { project: 'raf', workspace, group },
    { project: 'raf', workspace, group: secondGroup },
  ]);
});

test('R04 phase, project and workspace mismatch only add warnings to the forwarded run', async () => {
  const h = harness();
  const reply = await runSandboxTestCommand(h.command(`test run --project raf --phase qa --group ${group}`), h.ports);
  assert.equal(reply.code, 0);
  assert.match(reply.stderr, /Warning: phase qa differs from assignment phase implement/);
  assert.deepEqual(h.forwarded, [request({ phase: 'qa' })]);
  const other = harness(assignment({ workspace: '/workspace/other' }));
  const moved = await runSandboxTestCommand(other.command(), other.ports);
  assert.equal(moved.code, 0);
  assert.match(moved.stderr, /Warning: workspace \/workspace\/raf-develop differs from assignment workspace \/workspace\/other/);
  assert.deepEqual(other.keys, [{ project: 'raf', workspace, group }]);
});

test('R06 own and foreign callers across agent, phase, SHA and source-item use the same target aggregate key', async () => {
  const variants = [
    assignment({ changes: [target], agentId: 'target-owner' }),
    assignment(),
    assignment({ type: 'qa', phase: 'qa', agentId: 'another-agent', runId: 'new-run' }),
    assignment({ type: 'hotfix', phase: 'hotfix' }),
  ];
  const keys: TestRunGroupKey[] = [];
  for (const a of variants) {
    const h = harness(a);
    Object.assign(h.ports, { sha: `sha-${a.runId}`, sourceChange: source, sourceItem: 'caller-cannot-key-state' });
    await runSandboxTestCommand(h.command(), h.ports);
    assert.equal(h.forwarded.length, 1);
    keys.push(...h.keys);
    assert.deepEqual(h.forwarded[0], request({ phase: a.phase }));
  }
  assert.deepEqual(keys, variants.map(() => ({ project: 'raf', workspace, group })));
});

for (const outcome of [
  { outcome: 'timed-out', timeoutCount: 7, nextAction: 'confirm-known-red', timedOut: true, cleanup: { complete: false, remainingPids: [99] } },
  { outcome: 'unverified-remainder', timeoutCount: 7, nextAction: 'review-remainder', timedOut: false, cleanup: { complete: true, remainingPids: [] } },
  { outcome: 'refused', errorCode: 'GROUP_IN_FLIGHT', timeoutCount: 1, nextAction: 'reconcile' },
  { outcome: 'refused', errorCode: 'GROUP_TIMEOUT_LIMIT', timeoutCount: 7, nextAction: 'confirm-known-red' },
  { outcome: 'interrupted', timeoutCount: 1, nextAction: 'reconcile', timedOut: false },
  { outcome: 'assertions-failed', timeoutCount: 1, nextAction: 'fix-implementation' },
  { outcome: 'setup-failed', errorCode: 'INVENTORY_INCOMPLETE', timeoutCount: 1, nextAction: 'fix-setup' },
]) {
  test(`R06/R07 wrapper owns limits/recovery/remainder; broker preserves ${outcome.outcome}/${outcome.nextAction} without retry or reset`, async () => {
    const h = harness();
    const result = {
      ...outcome, runId: 'target-run', project: 'raf', workspace, group, phase: 'implement',
      knownRed: [{ file: files[0], name: 'target-red' }],
      removed: [{ file: files[1], name: 'removed target test' }],
      unexecuted: [{ file: files[1], name: 'unverified target test' }], unknown: [],
      diagnostics: [{ message: 'bounded target diagnostic' }], evidence: ['existing wrapper evidence'],
      exitCode: 42,
    };
    const reply = { code: 1, stdout: `${JSON.stringify(result)}\n`, stderr: 'literal stderr $(not-executed)\n' };
    h.setReply(reply);
    assert.deepEqual(await runSandboxTestCommand(h.command(), h.ports), reply);
    assert.deepEqual(h.calls, ['control', 'unitContext', 'wrapper']);
    assert.deepEqual(h.keys, [{ project: 'raf', workspace, group }]);
  });
}

test('R07 concurrent own and regression execution delegates both to the identical reservation context', async () => {
  const h = harness();
  const owner = assignment({ changes: [target] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const contexts: SandboxUnitContext[] = [];
  h.ports.wrapper = async (_request, context) => {
    contexts.push(context);
    if (contexts.length === 1) { await gate; return { code: 0, stdout: 'owner complete', stderr: '' }; }
    return { code: 1, stdout: '{"outcome":"refused","errorCode":"GROUP_IN_FLIGHT"}', stderr: '' };
  };
  const foreign = runSandboxTestCommand(h.command(), h.ports);
  void foreign.catch(() => {});
  const ownerPorts: SandboxTestRunPorts = { ...h.ports, async control() { return control(owner); } };
  const own = runSandboxTestCommand(h.command(), ownerPorts);
  try {
    assert.equal((await own).code, 1);
    assert.deepEqual(contexts, [h.context, h.context]);
    assert.deepEqual(h.keys, [{ project: 'raf', workspace, group }, { project: 'raf', workspace, group }]);
  } finally { release(); await foreign.catch(() => {}); }
  assert.equal((await foreign).code, 0);
});

test('R07 transport failure is not retried and never reported as pass', async () => {
  const h = harness();
  let attempts = 0;
  h.ports.wrapper = async () => { attempts++; throw new Error('wrapper transport unavailable'); };
  await assert.rejects(runSandboxTestCommand(h.command(), h.ports), /transport unavailable/);
  assert.equal(attempts, 1);
});

test('R09 foreign regression neither extends own changes/report items/file boundaries nor cleans target state', async () => {
  const a = Object.assign(assignment(), {
    reportItems: [{ change: source, item: '5.8.3' }], writeBoundaries: ['/workspace/raf-develop/test'],
  });
  const h = harness(a);
  const before = structuredClone(a);
  await runSandboxTestCommand(h.command(), h.ports);
  assert.deepEqual(a, before);
  assert.deepEqual(a.changes, [source]);
  assert.deepEqual(a.reportItems, [{ change: source, item: '5.8.3' }]);
  assert.deepEqual(a.writeBoundaries, ['/workspace/raf-develop/test']);
  assert.deepEqual(h.keys, [{ project: 'raf', workspace, group }]);
  assert.ok(h.calls.every(call => ['control', 'unitContext', 'wrapper'].includes(call)));
});

for (const a of [
  assignment({ type: 'main', phase: 'main' }),
  assignment({ type: 'coordinator', phase: 'main', delegatedByMain: true }),
]) {
  test(`R09 existing ${a.type} red authority remains scoped to its own assignment`, async () => {
    const h = harness(a);
    const ownGroup = `${source}/foreign-regressions`;
    const reply = await runSandboxTestCommand(h.command(`test run --project raf --phase red --group ${ownGroup} --files ${ownFile}`), h.ports);
    assert.equal(reply.code, 0);
    assert.deepEqual(h.forwarded, [request({ phase: 'red', group: ownGroup, files: [ownFile] })]);
  });
}

for (const subcommand of ['agent ps', 'agent message --to main --text literal']) {
  test(`R09 regression hook preserves the communication port for ${subcommand}`, async () => {
    const h = harness();
    const result = await runSandboxTestCommand(h.command(subcommand), h.ports);
    assert.deepEqual(result, { code: 0, stdout: 'communication reply', stderr: '' });
    assert.ok(h.calls.includes('communicate'));
    assert.deepEqual(h.keys, []);
    assert.deepEqual(h.forwarded, []);
  });
}

function sharedWrapper() {
  const configured = JSON.parse(readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8')) as TestRunConfig;
  const policy = (JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8')) as { unitTests: UnitTestPolicy }).unitTests;
  const config: TestRunConfig = { ...configured, ...configuration(), phases: configured.phases };
  const groups = new Map<string, TestRunGroup>();
  const keyOf = (key: TestRunGroupKey) => JSON.stringify([key.project, key.workspace, key.group]);
  const context: TestRunContext = {
    cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] },
    agentPhases: Object.keys(config.phases), activeChanges: [source, target],
    agentId: 'initial-owner', sha: 'initial-sha', home: '/qa/stable-target',
    statePath: '/qa/stable-target/state.sqlite', tmpPath: '/qa/stable-target/tmp',
    operationalHome: '/operational/home',
  };
  const facts = config.projects.raf.profiles.node.unitFiles;
  let now = 0;
  let sequence = 0;
  let spawned = 0;
  let recoveries = 0;
  let deadline: { at: number; callback: () => void } | null = null;
  let mode: 'timeout' | 'pass' = 'timeout';
  const ports: TestRunPorts = {
    state: {
      async transaction<T>(operation: (transaction: TestRunTransaction) => T): Promise<T> {
        return operation({
          get(key) { return structuredClone(groups.get(keyOf(key)) ?? null); },
          list(project, selectedWorkspace) {
            return structuredClone([...groups.values()].filter(g => g.key.project === project && g.key.workspace === selectedWorkspace));
          },
          put(g) { groups.set(keyOf(g.key), structuredClone(g)); },
          delete(key) { groups.delete(keyOf(key)); },
        });
      },
    },
    clock: {
      now() { return now; },
      schedule(at, callback) {
        const scheduled = { at, callback };
        deadline = scheduled;
        return () => { if (deadline === scheduled) deadline = null; };
      },
    },
    newRunId() { sequence++; return `wrapper-run-${sequence}`; },
    async preflight() {
      return {
        canonicalWorkspace: workspace, canonicalCwd: workspace, gitIdentityMatches: true,
        runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true,
        resultAdapterAvailable: true, artifactsWritable: true, treeControlSupported: true,
        isolatedHome: true, stateOriginAllowed: true, stateAliasesOperational: false,
        tmpAliasesOperational: false, inheritedOperationalChannel: false,
        unitFiles: [...facts],
        files: Object.fromEntries(facts.map(file => [file, { kind: 'file' as const, realpath: `${workspace}/${file}`, unit: true }])),
      };
    },
    async spawn(command, onEvent) {
      spawned++;
      const red = { file: files[0], name: 'target red' };
      const pending = { file: files[1], name: 'target pending' };
      onEvent({ kind: 'discovered', test: red });
      onEvent({ kind: 'discovered', test: pending });
      if (mode === 'timeout') {
        onEvent({ kind: 'assertion-failed', test: red, diagnostic: 'assertion from target group' });
        let resolveWait!: (result: { exitCode: number; signal: string | null; stderr: string }) => void;
        const waitResult = new Promise<{ exitCode: number; signal: string | null; stderr: string }>(resolve => {
          resolveWait = resolve;
        });
        return {
          identity: `fake-tree-${spawned}`,
          wait() {
            queueMicrotask(() => {
              assert.ok(deadline, 'the existing wrapper must install its configured deadline');
              const active = deadline;
              now = active.at;
              active.callback();
            });
            return waitResult;
          },
          async cleanup() {
            resolveWait({ exitCode: 1, signal: null, stderr: '' });
            return { complete: true, remainingPids: [] };
          },
        };
      }
      const selected = command.environment.testIds ?? [red, pending];
      for (const id of selected) onEvent({ kind: 'passed', test: id });
      onEvent({ kind: 'complete', expected: selected });
      return {
        identity: `fake-tree-${spawned}`,
        async wait() { return { exitCode: 0, signal: null, stderr: '' }; },
        async cleanup() { return { complete: true, remainingPids: [] }; },
      };
    },
    subscribeInterruption() { return () => {}; },
    async reconcile() { recoveries++; return { alive: false, deadlineReached: true, cleanup: { complete: true, remainingPids: [] } }; },
  };
  function connect(h: ReturnType<typeof harness>) {
    h.ports.wrapper = async (r, unit) => {
      assert.equal(unit, h.context);
      const result = await runTestRun(r, config, policy, context, ports);
      return { code: result.outcome === 'passed' ? 0 : 1, stdout: JSON.stringify(result), stderr: '' };
    };
    return async (command = h.command()): Promise<SandboxCommandReply> => {
      const reply = await runSandboxTestCommand(command, h.ports);
      const result = JSON.parse(reply.stdout) as TestRunResult;
      if (result.groupSnapshot === 'loaded') await acknowledgeTestRunDelivery(result, ports.state);
      return reply;
    };
  }
  return {
    policy, context, ports, groups, keyOf, connect,
    counts() { return { spawned, recoveries }; },
    pass() { mode = 'pass'; },
  };
}

test('R06 real injected wrapper accumulates owner and foreign timeouts without resetting group or QA HOME', async () => {
  const shared = sharedWrapper();
  const key = { project: 'raf', workspace, group };
  for (let count = 1; count <= shared.policy.maxGroupTimeouts; count++) {
    const owner = count === 1;
    const a = owner ? assignment({ changes: [target] }) : assignment({
      agentId: `regression-agent-${count}`, runId: `source-run-${count}`, type: 'qa', phase: 'qa',
    });
    const h = harness(a);
    const execute = shared.connect(h);
    shared.context.agentId = a.agentId;
    shared.context.sha = `changed-sha-${count}`;
    const result = JSON.parse((await execute()).stdout) as TestRunResult;
    assert.equal(result.outcome, 'timed-out');
    assert.equal(result.timeoutCount, count);
    assert.deepEqual(result.knownRed, [{ file: files[0], name: 'target red' }]);
    assert.ok(result.unexecuted.some(id => id.file === files[1] && id.name === 'target pending'));
    assert.equal(shared.groups.size, 1);
    assert.deepEqual(h.keys, [key]);
    assert.equal(shared.context.home, '/qa/stable-target');
  }
  const foreign = harness();
  const execute = shared.connect(foreign);
  const before = shared.counts().spawned;
  const blocked = await execute();
  assert.notEqual(blocked.code, 0);
  assert.equal(shared.counts().spawned, before);
  assert.equal(shared.groups.get(shared.keyOf(key))!.timeoutCount, shared.policy.maxGroupTimeouts);
  shared.pass();
  const red = { file: files[0], name: 'target red' };
  const confirmed = JSON.parse((await execute(foreign.command(`test run --project raf --phase implement --group ${group} --only '${JSON.stringify(red)}'`))).stdout) as TestRunResult;
  assert.equal(confirmed.knownRed.length, 0);
  assert.equal(confirmed.timeoutCount, shared.policy.maxGroupTimeouts);
  assert.ok(confirmed.unexecuted.some(id => id.name === 'target pending'));
  assert.equal(shared.counts().spawned, before + 1);
});

test('R07 real wrapper recovers the existing target reservation once and source closure cannot clean its aggregate', async () => {
  const shared = sharedWrapper();
  const h = harness();
  const execute = shared.connect(h);
  const key = { project: 'raf', workspace, group };
  const first = JSON.parse((await execute()).stdout) as TestRunResult;
  const stored = shared.groups.get(shared.keyOf(key))!;
  const initialTimeouts = stored.timeoutCount;
  stored.inFlight = { runId: first.runId, deadlineMs: 0, processIdentity: 'already-accounted-dead-tree' };
  stored.state = 'reconcile';
  shared.groups.set(shared.keyOf(key), stored);
  shared.pass();
  const red = { file: files[0], name: 'target red' };
  await execute(h.command(`test run --project raf --phase implement --group ${group} --only '${JSON.stringify(red)}'`));
  assert.equal(shared.counts().recoveries, 1);
  assert.equal(shared.groups.get(shared.keyOf(key))!.timeoutCount, initialTimeouts);
  const before = structuredClone(shared.groups.get(shared.keyOf(key)));
  await cleanupClosedTestRunGroups([target], shared.context, shared.ports);
  assert.deepEqual(shared.groups.get(shared.keyOf(key)), before);
  await cleanupClosedTestRunGroups([], shared.context, shared.ports);
  assert.equal(shared.groups.size, 0);
});
