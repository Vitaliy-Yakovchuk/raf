import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSandboxTestRunEvidence,
  runSandboxTestCommand,
  sandboxRafCommandAccess,
} from '../src/sandbox-test-run.ts';
import type {
  SandboxCommandReply,
  SandboxProcessIdentity,
  SandboxTestAssignment,
  SandboxTestControlSnapshot,
  SandboxTestRunPorts,
} from '../src/sandbox-test-run.ts';
import { runTestRunCli } from '../src/test-run-cli.ts';
import type {
  ChildExit,
  RunnerEvent,
  TestId,
  TestRunCommand,
  TestRunConfig,
  TestRunContext,
  TestRunEnvironment,
  TestRunGroup,
  TestRunGroupKey,
  TestRunPorts,
  TestRunResult,
  UnitTestPolicy,
} from '../src/test-runs.ts';

const workspace = '/fixture/orchestrator/raf-develop';
const group = 'complete-raf-flow-contracts/z350';
const file = 'test/sandbox-test-run.test.ts';
const other = 'test/unrelated-unit.test.ts';
const entrypoint = ['/trusted/node', '/trusted/raf/bin/raf.ts'];
const caller: SandboxProcessIdentity = { pid: 300, startedAt: '2026-10-23T10:00:00Z' };
const testId: TestId = { file, name: 'sandbox contract' };
const pendingId: TestId = { file, name: 'pending sandbox contract' };
const assignment = (phase = 'implement', agentId = 'worker-a'): SandboxTestAssignment => ({
  runId: `run-${agentId}`,
  agentId,
  type: phase === 'hotfix' ? 'hotfix' : 'agent',
  phase,
  project: 'raf',
  workspace,
  branch: 'develop',
  changes: ['complete-raf-flow-contracts'],
});

function configuration(): TestRunConfig {
  const hints = Object.fromEntries(['refusal', 'setup', 'assertions', 'timeout', 'interruption'].map(id => [id, `fixture:${id}`]));
  return {
    phases: Object.fromEntries(['implement', 'qa', 'hotfix', 'red', 'test-scaffold', 'spec', 'design', 'coordinator', 'main'].map(phase => [phase, {
      allowed: ['implement', 'qa', 'hotfix', 'red'].includes(phase),
      purpose: phase === 'red' ? 'initial-red' : ['implement', 'qa', 'hotfix'].includes(phase) ? 'verification' : 'none',
      hints: { refusal: 'refusal', setup: 'setup', assertions: 'assertions', timeout: 'timeout', interruption: 'interruption' },
    }])),
    hints,
    diagnostics: {
      maxEntries: 64, maxMessageBytes: 4096, maxStackFrames: 16, maxStackBytes: 8192,
      maxTotalBytes: 65536, maxProtocolLineBytes: 65536, maxStderrBytes: 8192, redactionPatterns: [],
    },
    temporaryArtifacts: { root: '/tmp', minimumNestedSocketPathBytes: 80 },
    projects: {
      raf: {
        profiles: {
          local: {
            cwd: '.', executable: '/fixture/local-node', argv: ['fixture-unit-runner'],
            unitFiles: [file, other], exactIds: 'node-test-name', resultAdapter: 'node-test-events',
            environment: { isolatedHome: true, stateOrigin: true }, checks: [],
          },
        },
        groups: { [group]: { profileId: 'local', files: [file] } },
      },
    },
  };
}

type ProcessScript = 'pass' | 'assertion' | 'import' | 'protocol' | 'timeout' | 'hold' | 'mixed';

function fixture(phase = 'implement') {
  let now = 100;
  let serial = 0;
  let transactions = 0;
  const tasks = new Map<number, () => void>();
  const interruptions = new Set<(signal: string) => void>();
  const groups = new Map<string, TestRunGroup>();
  const spawns: TestRunCommand[] = [];
  const deadlines: number[] = [];
  const cleanupReasons: string[] = [];
  const keys: TestRunGroupKey[] = [];
  const messages: { argv: readonly string[]; caller: SandboxTestAssignment }[] = [];
  const scripts: ProcessScript[] = [];
  const pending: (() => void)[] = [];
  const hostProcess = { pid: 200, startedAt: '2026-10-23T09:59:00Z' };
  const snapshot: SandboxTestControlSnapshot = {
    ancestors: [caller, hostProcess],
    sessions: [{ process: hostProcess, state: 'running', assignment: assignment(phase) }],
    workspaces: [{ project: 'raf', workspace, branch: 'develop', actualBranch: 'develop' }],
    activeChanges: ['complete-raf-flow-contracts'],
    groups: [{ project: 'raf', workspace, group }],
  };
  const context: TestRunContext = {
    cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] },
    agentPhases: ['implement', 'qa', 'hotfix', 'red', 'test-scaffold', 'spec', 'design', 'coordinator', 'main'],
    activeChanges: ['complete-raf-flow-contracts'], agentId: 'worker-a', sha: 'a'.repeat(40),
    home: '/fixture/qa/z350', statePath: '/fixture/qa/z350/.raf/state.sqlite', tmpPath: '/fixture/qa/z350/.raf/tmp',
    operationalHome: '/fixture/operational',
  };
  const environment: TestRunEnvironment = {
    canonicalWorkspace: workspace, canonicalCwd: workspace, gitIdentityMatches: true,
    runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true,
    resultAdapterAvailable: true, artifactsWritable: true, treeControlSupported: true,
    isolatedHome: true, stateOriginAllowed: true, stateAliasesOperational: false,
    tmpAliasesOperational: false, inheritedOperationalChannel: false,
    unitFiles: [file, other],
    files: Object.fromEntries([file, other].map(name => [name, { kind: 'file', realpath: `${workspace}/${name}`, unit: true }])),
  };
  const policy: UnitTestPolicy = { timeoutMs: 900, optimizeAfterTimeouts: 2, maxGroupTimeouts: 3 };
  const config = configuration();
  let cleanupComplete = true;
  let childStderr = '';
  let controlFailure: string | null = null;
  let unitFailure: string | null = null;
  const keyOf = (key: TestRunGroupKey) => JSON.stringify([key.project, key.workspace, key.group]);
  const runtime: TestRunPorts = {
    preflight: async () => structuredClone(environment),
    state: {
      transaction: async operation => {
        transactions++;
        return operation({
          get: key => structuredClone(groups.get(keyOf(key)) ?? null),
          list: (project, path) => structuredClone([...groups.values()].filter(value => value.key.project === project && value.key.workspace === path)),
          put: value => { groups.set(keyOf(value.key), structuredClone(value)); },
          delete: key => { groups.delete(keyOf(key)); },
        });
      },
    },
    clock: {
      now: () => now,
      schedule: (deadline, callback) => {
        const id = ++serial;
        tasks.set(id, () => { if (now >= deadline) { tasks.delete(id); callback(); } });
        return () => { tasks.delete(id); };
      },
    },
    newRunId: () => `unit-run-${++serial}`,
    subscribeInterruption: callback => { interruptions.add(callback); return () => { interruptions.delete(callback); }; },
    reconcile: async () => ({ alive: false, deadlineReached: true, cleanup: { complete: cleanupComplete, remainingPids: cleanupComplete ? [] : [707] } }),
    spawn: async (command, onEvent) => {
      spawns.push(structuredClone(command));
      const script = scripts.shift() ?? 'pass';
      let resolveExit!: (exit: ChildExit) => void;
      const exit = new Promise<ChildExit>(resolve => { resolveExit = resolve; });
      const complete = () => {
        onEvent({ kind: 'discovered', test: testId });
        if (script === 'timeout' || script === 'hold') return;
        if (script === 'protocol') onEvent({ kind: 'protocol-error', diagnostic: 'truncated runner output' });
        else if (script === 'mixed') {
          onEvent({ kind: 'assertion-failed', test: testId });
          onEvent({ kind: 'setup-failed', test: pendingId, diagnostic: 'fixture import failure' });
          onEvent({ kind: 'complete', expected: [testId, pendingId] });
        } else {
          const kind: RunnerEvent['kind'] = script === 'assertion' ? 'assertion-failed' : script === 'import' ? 'setup-failed' : 'passed';
          onEvent({ kind, test: testId } as RunnerEvent);
          onEvent({ kind: 'complete', expected: [testId] });
        }
        resolveExit({ exitCode: script === 'pass' ? 0 : 17, signal: null, stderr: childStderr });
      };
      pending.push(() => {
        onEvent({ kind: 'passed', test: testId });
        onEvent({ kind: 'complete', expected: [testId] });
        resolveExit({ exitCode: 0, signal: null, stderr: childStderr });
      });
      queueMicrotask(complete);
      return {
        identity: `fixture-process-${spawns.length}`,
        wait: () => exit,
        cleanup: async (deadline, reason) => {
          deadlines.push(deadline); cleanupReasons.push(reason);
          resolveExit({ exitCode: null, signal: reason === 'interruption' ? 'SIGTERM' : 'SIGKILL', stderr: childStderr });
          return { complete: cleanupComplete, remainingPids: cleanupComplete ? [] : [707] };
        },
      };
    },
  };
  const ports: SandboxTestRunPorts = {
    caller, entrypoint,
    control: async identity => {
      assert.deepEqual(identity, caller);
      if (controlFailure) throw new Error(controlFailure);
      return structuredClone(snapshot);
    },
    unitContext: async key => {
      keys.push(structuredClone(key));
      if (unitFailure) throw new Error(unitFailure);
      return { config, policy, context: structuredClone(context), runtime };
    },
    communicate: async (argv, actor) => {
      messages.push({ argv: [...argv], caller: actor });
      return { code: 0, stdout: JSON.stringify({ accepted: true, runId: actor.runId }), stderr: '' };
    },
  };
  const command = (args = `--files ${file}`, requestedPhase = phase) => `${entrypoint.join(' ')} test run --project raf --phase ${requestedPhase} --group ${group}${args ? ` ${args}` : ''}`;
  const run = (text = command(), cwd = workspace) => runSandboxTestCommand({ command: text, cwd }, ports);
  const advance = (delta: number) => { now += delta; for (const action of [...tasks.values()]) action(); };
  const seed = (overrides: Partial<TestRunGroup> = {}) => {
    const key = { project: 'raf', workspace, group };
    groups.set(keyOf(key), {
      key, timeoutCount: 0, state: 'idle', selection: { files: [file], testIds: [] },
      knownRed: [], unexecuted: [], inFlight: null, lastResult: null, ...overrides,
    });
  };
  return {
    snapshot, context, environment, policy, config, runtime, ports, run, command, advance, seed,
    spawns, deadlines, cleanupReasons, keys, messages, scripts, pending, groups,
    get transactions() { return transactions; },
    set cleanupComplete(value: boolean) { cleanupComplete = value; },
    set childStderr(value: string) { childStderr = value; },
    set controlFailure(value: string | null) { controlFailure = value; },
    set unitFailure(value: string | null) { unitFailure = value; },
    interrupt: () => { for (const callback of [...interruptions]) callback('SIGTERM'); },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('fixture operation did not reach the expected boundary');
}

async function directWrapper(f: ReturnType<typeof fixture>): Promise<SandboxCommandReply> {
  let stdout = '';
  let stderr = '';
  const actor = f.snapshot.sessions[0].assignment;
  const code = await runTestRunCli(['--project', 'raf', '--phase', actor.phase, '--group', group, '--files', file], {
    config: f.config, policy: f.policy,
    context: { ...f.context, agentId: actor.agentId, callerPhase: actor.phase }, runtime: f.runtime,
    stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
  });
  return { code, stdout, stderr };
}

function result(reply: SandboxCommandReply): TestRunResult {
  assert.ok(reply.stdout.trim(), 'complete TestRunResult must be present');
  return JSON.parse(reply.stdout) as TestRunResult;
}

async function refused(f: ReturnType<typeof fixture>, command = f.command(), cwd = workspace): Promise<SandboxCommandReply> {
  const before = structuredClone([...f.groups]);
  const transactionCount = f.transactions;
  const reply = await f.run(command, cwd);
  assert.notEqual(reply.code, 0);
  assert.ok(reply.stderr.trim() || reply.stdout.trim(), 'refusal must give a reason');
  assert.equal(f.spawns.length, 0);
  assert.deepEqual([...f.groups], before, 'refusal must not consume another group budget');
  assert.equal(f.transactions, transactionCount, 'authorization refusal must precede test-state access');
  return reply;
}

for (const phase of ['implement', 'qa', 'hotfix']) {
  for (const selection of [`--files ${file}`, '']) {
    test(`T01 ${phase} ${selection ? 'files' : 'preset'} dispatches the profile once in its assigned phase`, async () => {
      const f = fixture(phase);
      const reply = await f.run(f.command(selection));
      assert.equal(reply.code, 0);
      const value = result(reply);
      assert.equal(value.phase, phase);
      assert.equal(value.outcome, 'passed');
      assert.deepEqual(value.selection.files, [file]);
      assert.equal(f.spawns.length, 1);
      assert.equal(f.spawns[0].executable, '/fixture/local-node');
      assert.equal(f.spawns[0].shell, false);
      assert.equal(f.spawns[0].cwd, workspace);
      assert.deepEqual(f.keys, [{ project: 'raf', workspace, group }]);
    });
  }
}

for (const phase of ['test-scaffold', 'spec', 'design']) {
  for (const requestedPhase of [...(phase === 'test-scaffold' ? [] : ['red']), 'implement', 'qa', 'hotfix', phase]) {
    test(`T02 ${phase} cannot obtain ${requestedPhase} rights from command or edited brief`, async () => {
      const f = fixture(phase);
      await refused(f, f.command(`--files ${file}`, requestedPhase));
      assert.equal(f.keys.length, 0);
    });
  }
}

for (const mode of ['unknown', 'finished', 'reused-pid', 'unobservable']) {
  test(`T02 ${mode} caller cannot open test state or spawn`, async () => {
    const f = fixture();
    if (mode === 'unknown') (f.snapshot.sessions as unknown[]).length = 0;
    if (mode === 'finished') Object.assign(f.snapshot.sessions[0], { state: 'finished' });
    if (mode === 'reused-pid') Object.assign(f.snapshot.sessions[0], {
      process: { ...f.snapshot.sessions[0].process, startedAt: '2026-10-23T09:58:00Z' },
    });
    if (mode === 'unobservable') f.controlFailure = 'process identity unavailable';
    await refused(f);
    assert.equal(f.keys.length, 0);
  });
}

for (const [label, mutate] of [
  ['phase', (f: ReturnType<typeof fixture>) => f.command().replace('--phase implement', '--phase red')],
  ['project', (f: ReturnType<typeof fixture>) => f.command().replace('--project raf', '--project other')],
  ['change', (f: ReturnType<typeof fixture>) => f.command().replace(group, 'foreign-change/z350')],
  ['group', (f: ReturnType<typeof fixture>) => f.command().replace(group, `${group}-renamed`)],
] as const) {
  test(`T03 ${label} substitution is refused before unit context`, async () => {
    const f = fixture();
    await refused(f, mutate(f));
    assert.equal(f.keys.length, 0);
  });
}

for (const mode of ['cwd', 'unregistered', 'wrong-branch', 'closed-change', 'nearest-denied']) {
  test(`T03 ${mode} cannot borrow a different live ancestor's assignment`, async () => {
    const f = fixture();
    if (mode === 'unregistered') (f.snapshot.workspaces as unknown[]).length = 0;
    if (mode === 'wrong-branch') Object.assign(f.snapshot.workspaces[0], { actualBranch: 'main' });
    if (mode === 'closed-change') (f.snapshot.activeChanges as string[]).length = 0;
    if (mode === 'nearest-denied') {
      (f.snapshot.sessions as unknown[]).push({ process: caller, state: 'running', assignment: assignment('test-scaffold') });
    }
    await refused(f, f.command(), mode === 'cwd' ? '/fixture/unregistered' : workspace);
    assert.equal(f.keys.length, 0);
  });
}

for (const mutate of [
  (s: string) => `HOME=/fixture/attacker ${s}`,
  (s: string) => `cd ${workspace} && ${s}`,
  (s: string) => `${s} | cat`,
  (s: string) => `${s}; touch /fixture/pwned`,
  (s: string) => `${s} && true`,
  (s: string) => `${s} > /fixture/output`,
  (s: string) => `${s} $(touch /fixture/pwned)`,
  (s: string) => `${s} \`touch /fixture/pwned\``,
  (s: string) => `${s}\ntrue`,
  (s: string) => s.replace(entrypoint[1], `${workspace}/editable-control.ts`),
  (s: string) => s.replace(entrypoint[0], '/fixture/another-node'),
]) {
  test(`T04 compound or substituted command is not a host exception: ${mutate('raf')}`, async () => {
    const f = fixture();
    await refused(f, mutate(f.command()));
    assert.equal(f.keys.length, 0);
    assert.equal(f.messages.length, 0);
  });
}

test('T04 quoted exact words are data and use the same trusted entrypoint', async () => {
  const f = fixture();
  const command = f.command().replace(entrypoint[1], `'${entrypoint[1]}'`).replace(file, `'${file}'`);
  assert.equal((await f.run(command)).code, 0);
  assert.equal(f.spawns.length, 1);
});

for (const [label, args] of [
  ['empty files', '--files'], ['directory', '--files test'], ['glob', '--files test/*.test.ts'],
  ['whole inventory', `--files ${file} ${other}`], ['non-unit', '--files integration/host.ts'],
  ['traversal', '--files ../outside.test.ts'], ['absolute', `--files ${workspace}/${file}`],
  ['option injection', '--files --eval'], ['arbitrary command', '--command rm'],
  ['runner tail', `--files ${file} -- --inspect`], ['mixed selectors', `--files ${file} --only '${file}::sandbox contract'`],
  ['unknown red', `--only '${file}::not previously red'`],
] as const) {
  test(`T05 refuses ${label} without runner spawn`, async () => {
    const f = fixture();
    const reply = await f.run(f.command(args));
    assert.notEqual(reply.code, 0);
    assert.equal(f.spawns.length, 0);
  });
}

test('T05 missing preset does not discover the unit inventory', async () => {
  const f = fixture();
  delete f.config.projects.raf.groups[group];
  assert.notEqual((await f.run(f.command(''))).code, 0);
  assert.equal(f.spawns.length, 0);
});

test('T05 canonical file escape is rejected by the composed wrapper', async () => {
  const f = fixture();
  f.environment.files[file].realpath = '/fixture/outside/symlink-target.test.ts';
  assert.notEqual((await f.run()).code, 0);
  assert.equal(f.spawns.length, 0);
});

test('T06 next invocation takes executable, arguments, phase and hints from fixture conf', async () => {
  const f = fixture('qa');
  f.config.projects.raf.profiles.local.executable = '/fixture/replaced-local-node';
  f.config.projects.raf.profiles.local.argv = ['replacement-unit-runner'];
  f.config.phases.qa.hints.assertions = 'custom-qa';
  f.config.hints['custom-qa'] = 'changed in conf';
  f.scripts.push('assertion');
  const value = result(await f.run());
  assert.equal(f.spawns[0].executable, '/fixture/replaced-local-node');
  assert.ok(f.spawns[0].argv.includes('replacement-unit-runner'));
  assert.deepEqual(value.hintIds, ['custom-qa']);
  assert.deepEqual(value.hints, ['changed in conf']);
});

for (const mode of ['phase-disabled', 'bad-timeout', 'bad-hint', 'missing-inventory', 'missing-runner', 'missing-dependency']) {
  test(`T06 ${mode} has explicit failure without discovery, install or spawn`, async () => {
    const f = fixture();
    if (mode === 'phase-disabled') f.config.phases.implement.allowed = false;
    if (mode === 'bad-timeout') f.policy.timeoutMs = 0;
    if (mode === 'bad-hint') f.config.phases.implement.hints.timeout = 'absent-hint';
    if (mode === 'missing-inventory') f.config.projects.raf.profiles.local.unitFiles = [other];
    if (mode === 'missing-runner') f.environment.localRunnerAvailable = false;
    if (mode === 'missing-dependency') f.environment.dependenciesAvailable = false;
    const reply = await f.run();
    assert.notEqual(reply.code, 0);
    assert.equal(f.spawns.length, 0);
    assert.equal(result(reply).knownRed.length, 0);
  });
}

test('T07 profile process and nested CLI context use the host-selected isolated HOME/state/tmp', async () => {
  const f = fixture();
  assert.equal((await f.run()).code, 0);
  const env = f.spawns[0].environment;
  assert.equal(env.HOME, f.context.home);
  assert.equal(env.statePath, f.context.statePath);
  assert.equal(env.tmpPath, f.context.tmpPath);
  assert.ok(!JSON.stringify(env).includes(f.context.operationalHome));
});

for (const fact of ['stateAliasesOperational', 'tmpAliasesOperational', 'inheritedOperationalChannel', 'isolatedHome', 'stateOriginAllowed'] as const) {
  test(`T07 unsafe preflight fact ${fact} refuses before test-state transaction`, async () => {
    const f = fixture();
    f.environment[fact] = !['isolatedHome', 'stateOriginAllowed'].includes(fact);
    assert.notEqual((await f.run()).code, 0);
    assert.equal(f.transactions, 0);
    assert.equal(f.spawns.length, 0);
  });
}

test('T08 group context key and aggregate survive agent, phase and SHA changes', async () => {
  const f = fixture();
  f.seed({ timeoutCount: 1, knownRed: [testId] });
  const first = result(await f.run());
  Object.assign(f.snapshot.sessions[0], { assignment: assignment('qa', 'worker-b') });
  f.context.agentId = 'worker-b';
  f.context.sha = 'b'.repeat(40);
  const second = result(await f.run(f.command(`--files ${file}`, 'qa')));
  assert.equal(first.timeoutCount, 1);
  assert.equal(second.timeoutCount, 1);
  assert.deepEqual(f.keys[0], f.keys[1]);
  assert.equal(f.spawns[0].environment.HOME, f.spawns[1].environment.HOME);
});

test('T08 concurrent requests for one group spawn a single tree', async () => {
  const f = fixture();
  f.scripts.push('hold');
  const first = f.run();
  await until(() => f.spawns.length === 1);
  const competing = await f.run();
  assert.notEqual(competing.code, 0);
  assert.equal(f.spawns.length, 1);
  f.pending[0]();
  assert.equal((await first).code, 0);
});

test('T08 unresolved in-flight recovery does not start a second tree or erase budget', async () => {
  const f = fixture();
  f.seed({ timeoutCount: 1, state: 'running', inFlight: { runId: 'lost-unit-run', deadlineMs: 99, processIdentity: 'lost-process' } });
  f.runtime.reconcile = async () => ({ alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [707] } });
  const reply = await f.run();
  assert.notEqual(reply.code, 0);
  assert.equal(f.spawns.length, 0);
  assert.ok(result(reply).timeoutCount >= 1);
});

test('T09 unit deadline exceeds adapter transition and cleanup receives no fresh budget', async () => {
  const f = fixture();
  f.scripts.push('timeout');
  const running = f.run();
  await until(() => f.spawns.length === 1);
  f.advance(f.policy.timeoutMs - 1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.cleanupReasons.length, 0);
  f.advance(1);
  const reply = await running;
  const value = result(reply);
  assert.notEqual(reply.code, 0);
  assert.equal(value.outcome, 'timed-out');
  assert.equal(value.timedOut, true);
  assert.deepEqual(f.deadlines, [100 + f.policy.timeoutMs]);
  assert.equal(value.timeoutCount, 1);
});

test('T09 external interruption cleans the same tree without counting a timeout', async () => {
  const f = fixture();
  f.scripts.push('hold');
  const running = f.run();
  await until(() => f.spawns.length === 1);
  f.interrupt();
  const value = result(await running);
  assert.equal(value.outcome, 'interrupted');
  assert.equal(value.timeoutCount, 0);
  assert.equal(value.timedOut, false);
  assert.ok(f.cleanupReasons.includes('interruption'));
});

test('T09 surviving descendant cannot become passed even if the runner exits zero', async () => {
  const f = fixture();
  f.cleanupComplete = false;
  const reply = await f.run();
  assert.notEqual(reply.code, 0);
  assert.notEqual(result(reply).outcome, 'passed');
  assert.equal(result(reply).cleanup.complete, false);
  assert.deepEqual(result(reply).cleanup.remainingPids, [707]);
});

test('T10 configured optimization threshold preserves the shared timeout count', async () => {
  const f = fixture();
  f.policy.optimizeAfterTimeouts = 1;
  f.scripts.push('timeout');
  const running = f.run();
  await until(() => f.spawns.length === 1);
  f.advance(f.policy.timeoutMs);
  const value = result(await running);
  assert.equal(value.timeoutCount, 1);
  assert.equal(value.nextAction, 'optimize');
  assert.ok(value.hints.includes(f.config.hints.timeout));
});

test('T10 exhausted group leaves a nonzero unverified remainder without running it', async () => {
  const f = fixture();
  f.seed({ timeoutCount: f.policy.maxGroupTimeouts, state: 'unverified-remainder', unexecuted: [pendingId] });
  const reply = await f.run();
  assert.notEqual(reply.code, 0);
  const value = result(reply);
  assert.equal(value.outcome, 'unverified-remainder');
  assert.equal(value.timeoutCount, f.policy.maxGroupTimeouts);
  assert.deepEqual(value.unexecuted, [pendingId]);
  assert.equal(f.spawns.length, 0);
});

test('T10 only exact known red IDs may run after the limit', async () => {
  const f = fixture();
  f.seed({ timeoutCount: f.policy.maxGroupTimeouts, state: 'confirm-known-red', knownRed: [testId], unexecuted: [pendingId] });
  const reply = await f.run(f.command(`--only '${file}::${testId.name}'`));
  const value = result(reply);
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(value.selection.testIds, [testId]);
  assert.equal(value.timeoutCount, f.policy.maxGroupTimeouts);
  assert.deepEqual(value.unexecuted, [pendingId]);
  assert.notEqual(reply.code, 0, 'unexecuted remainder must not become a whole-group pass');
});

test('T10 confirmation timeout keeps known red and does not reset the group', async () => {
  const f = fixture();
  f.seed({ timeoutCount: f.policy.maxGroupTimeouts, state: 'confirm-known-red', knownRed: [testId], unexecuted: [pendingId] });
  f.scripts.push('timeout');
  const running = f.run(f.command(`--only '${file}::${testId.name}'`));
  await until(() => f.spawns.length === 1);
  f.advance(f.policy.timeoutMs);
  const value = result(await running);
  assert.deepEqual(value.knownRed, [testId]);
  assert.ok(value.timeoutCount >= f.policy.maxGroupTimeouts);
  assert.notEqual(value.outcome, 'passed');
});

for (const [script, expected, code] of [
  ['pass', 'passed', 0], ['assertion', 'assertions-failed', 17], ['import', 'setup-failed', 17], ['protocol', 'setup-failed', 17],
] as const) {
  test(`T11 ${script} preserves structured facts and separates CLI rc from child rc`, async () => {
    const f = fixture();
    if (script === 'protocol') f.config.diagnostics.maxStackFrames = 3;
    f.scripts.push(script);
    const reply = await f.run();
    const value = result(reply);
    assert.equal(value.outcome, expected);
    assert.equal(value.exitCode, code);
    assert.equal(reply.code === 0, script === 'pass');
    assert.equal(value.timeoutCount, 0);
    assert.equal(value.timedOut, false);
    assert.equal(value.cleanup.complete, true);
    assert.equal(value.project, 'raf');
    assert.equal(value.workspace, workspace);
    assert.equal(value.group, group);
    assert.equal(value.callerPhase, f.snapshot.sessions[0].assignment.phase);
    assert.equal(typeof value.runId, 'string');
    if (script === 'assertion') assert.deepEqual(value.knownRed, [testId]);
    if (script === 'import') assert.deepEqual(value.knownRed, []);
    if (script === 'protocol') {
      const diagnostic = value.diagnostics.find(entry => entry.kind === 'protocol');
      assert.ok(diagnostic);
      assert.equal(diagnostic.stack.length, f.config.diagnostics.maxStackFrames);
      assert.equal(diagnostic.truncated, true);
    }
    const reference = fixture();
    if (script === 'protocol') reference.config.diagnostics.maxStackFrames = f.config.diagnostics.maxStackFrames;
    reference.scripts.push(script);
    const direct = await directWrapper(reference);
    assert.deepEqual(reply, direct, 'host channel must preserve every wrapper field and stream byte');
  });
}

test('T11 mixed setup and assertion failures retain both causes', async () => {
  const f = fixture();
  f.scripts.push('mixed');
  const reply = await f.run();
  const value = result(reply);
  assert.notEqual(reply.code, 0);
  assert.ok(value.failureKinds.includes('setup'));
  assert.ok(value.failureKinds.includes('assertions'));
  assert.deepEqual(value.knownRed, [testId]);
});

test('T12 simultaneous large outputs preserve JSON bytes and literal shell metacharacters', async () => {
  const a = fixture();
  const b = fixture('qa');
  const payload = 'Україна $() `touch /fixture/pwned` \" ; | &\n'.repeat(8192) + 'END\n\n';
  a.config.hints.assertions = `A:${payload}`;
  b.config.hints.assertions = `B:${payload}`;
  a.childStderr = `stderr-A:${payload}`;
  b.childStderr = `stderr-B:${payload}`;
  a.scripts.push('assertion'); b.scripts.push('assertion');
  const [left, right] = await Promise.all([a.run(), b.run()]);
  assert.equal(result(left).hints[0], `A:${payload}`);
  assert.equal(result(right).hints[0], `B:${payload}`);
  assert.ok(Buffer.byteLength(left.stdout) > 128 * 1024);
  assert.ok(Buffer.byteLength(right.stdout) > 128 * 1024);
  assert.equal(a.spawns.length, 1);
  assert.equal(b.spawns.length, 1);
  assert.ok(!JSON.stringify(a.spawns[0].argv).includes(payload));
  assert.ok(!JSON.stringify(a.spawns[0].environment).includes(payload));
  const reference = fixture();
  reference.config.hints.assertions = `A:${payload}`;
  reference.childStderr = `stderr-A:${payload}`;
  reference.scripts.push('assertion');
  assert.deepEqual(left, await directWrapper(reference));
});

test('T12 unavailable transport is a failure without blind retry or fabricated pass', async () => {
  const f = fixture();
  f.unitFailure = 'QA channel unavailable';
  const reply = await f.run();
  assert.notEqual(reply.code, 0);
  assert.equal(f.keys.length, 1);
  assert.equal(f.spawns.length, 0);
  assert.match(reply.stderr + reply.stdout, /QA channel unavailable/);
});

test('T12 unit context refusal names the underlying cause for diagnosis', async () => {
  const f = fixture();
  f.unitFailure = 'Unit HOME root is not private or has aliases';
  const reply = await f.run();
  assert.notEqual(reply.code, 0);
  assert.equal(f.spawns.length, 0);
  assert.match(reply.stderr + reply.stdout, /QA channel unavailable: unit context could not be verified/);
  assert.match(reply.stderr + reply.stdout, /Unit HOME root is not private or has aliases/);
});

for (const runner of ['codex', 'claude'] as const) {
  for (const phase of ['implement', 'qa', 'hotfix', 'test-scaffold', 'spec', 'design']) {
    test(`T13 ${runner}/${phase} brief and actual host allowlist agree`, () => {
      const access = sandboxRafCommandAccess(assignment(phase), runner, entrypoint, configuration().phases);
      const allowed = ['implement', 'qa', 'hotfix', 'test-scaffold'].includes(phase);
      assert.equal(access.raf_subcommands.includes('test run'), allowed);
      assert.equal(access.hostCommands.includes(`${access.raf_command} test run`), allowed);
      assert.ok(access.raf_subcommands.includes('agent message'));
      assert.ok(access.raf_subcommands.includes('agent ps'));
      assert.ok(!access.raf_subcommands.includes('agent run'));
      assert.ok(!access.raf_subcommands.includes('agent close'));
      assert.ok(access.raf_command.includes(entrypoint[1]));
    });
  }
}

test('T13 fixture conf can disable test access without changing communication', () => {
  const conf = configuration();
  conf.phases.implement.allowed = false;
  const access = sandboxRafCommandAccess(assignment(), 'codex', entrypoint, conf.phases);
  assert.ok(!access.raf_subcommands.includes('test run'));
  assert.ok(access.raf_subcommands.includes('agent message'));
});

test('T14 evidence identifies actual command, SHA, dirty paths, artifact and runner result', async () => {
  const f = fixture('qa');
  f.scripts.push('assertion');
  const reply = await f.run();
  const value = result(reply);
  const text = formatSandboxTestRunEvidence({
    command: f.command(), workspace, sha: f.context.sha, dirtyPaths: ['src/changed.ts'],
    artifact: '/fixture/artifacts/full-result.json', reply,
  });
  for (const token of [f.command(), workspace, f.context.sha, 'src/changed.ts', '/fixture/artifacts/full-result.json', value.runId, value.outcome, group, 'qa', testId.name, '17']) {
    assert.ok(text.includes(token), `evidence must name ${token}`);
  }
  for (const field of ['cleanup', 'timedOut', 'knownRed', 'unexecuted', 'unknown', 'timeoutCount', 'nextAction']) assert.ok(text.includes(field));
  assert.equal(f.messages.length, 0, 'unit result does not automatically submit or accept an assignment');
});

for (const mode of ['missing', 'truncated', 'transport-failed']) {
  test(`T14 ${mode} result yields an explicit escalation with exact command`, () => {
    const f = fixture();
    const text = formatSandboxTestRunEvidence({
      command: f.command(), workspace, sha: f.context.sha, dirtyPaths: [], artifact: '/fixture/artifacts/broken-result.json',
      reply: mode === 'missing' ? null : { code: mode === 'transport-failed' ? 1 : 0, stdout: '{"outcome":"passed"', stderr: 'channel interrupted' },
      transportError: mode === 'transport-failed' ? 'transport interrupted' : undefined,
    });
    assert.ok(text.includes(f.command()));
    assert.match(text, /agent message/);
    assert.doesNotMatch(text, /"status"\s*:\s*"succeeded"/);
  });
}

for (const verb of ['agent ps', 'agent message --to main --text \'literal $() `text`\'']) {
  test(`T15 existing communication delegates exactly once: ${verb}`, async () => {
    const f = fixture('test-scaffold');
    const reply = await f.run(`${entrypoint.join(' ')} ${verb}`);
    assert.equal(reply.code, 0);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].caller.agentId, 'worker-a');
    if (verb.startsWith('agent message')) assert.equal(f.messages[0].argv.at(-1), 'literal $() `text`');
    assert.equal(f.keys.length, 0);
    assert.equal(f.transactions, 0);
  });
}

for (const delegated of [false, true]) {
  test(`T15 coordinator initial red requires explicit main delegation: ${delegated}`, async () => {
    const f = fixture('coordinator');
    Object.assign(f.snapshot.sessions[0], { assignment: { ...assignment('coordinator'), type: 'coordinator', delegatedByMain: delegated } });
    const reply = await f.run(f.command(`--files ${file}`, 'red'));
    assert.equal(reply.code === 0, delegated);
    assert.equal(f.spawns.length, delegated ? 1 : 0);
  });
}

for (const command of ['agent run --id other', 'agent close --id main', 'secrets list', 'main attach', 'service start', 'git switch main', 'cat /fixture/operational/.raf/state.sqlite']) {
  test(`T15 channel grants no new host operation: ${command}`, async () => {
    const f = fixture();
    await refused(f, `${entrypoint.join(' ')} ${command}`);
    assert.equal(f.messages.length, 0);
    assert.equal(f.keys.length, 0);
    assert.equal(f.transactions, 0);
  });
}
