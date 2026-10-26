import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTestRunArgs, planTestRun, validateTestRunConfig } from '../src/test-runs.ts';
import type { TestRunConfig, TestRunEnvironment, TestRunFailureKind, TestRunResult } from '../src/test-runs.ts';
import { runTestRunCli } from '../src/test-run-cli.ts';
import { bootstrapFixture } from './helpers/test-run-bootstrap-fixture.ts';
import { alpha, files, fixtureConfig, fixtureContext, fixtureEnvironment, fixtureRequest, policy, RunHarness } from './helpers/test-run-fixture.ts';

const base = ['--project', 'raf', '--phase', 'red', '--group', 'add-raf-test-run/unit'];

for (const failure of ['read-only', 'reader-race', 'state-open', 'state-result'] as const) {
  test(`public test run bootstrap ${failure} returns a complete refusal without retrying or opening state`, async t => {
    const f = await bootstrapFixture(t, failure);
    const result = await f.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.trim(), `Bootstrap failure must return TestRunResult: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.outcome, 'refused');
    assert.equal(output.project, 'raf');
    assert.equal(output.phase, 'hotfix');
    assert.equal(output.group, 'add-raf-test-run/bootstrap-refusal');
    assert.deepEqual(output.selection, { files: ['test/test-run-cli.test.ts'], testIds: [] });
    assert.equal(typeof output.runId, 'string');
    assert.ok(output.runId.length);
    assert.equal(output.exitCode, null);
    assert.equal(output.command, null);
    assert.equal(output.timedOut, false);
    assert.deepEqual(output.cleanup, { complete: true, remainingPids: [] });
    assert.deepEqual(output.knownRed, []);
    assert.deepEqual(output.unexecuted, []);
    assert.deepEqual(output.unknown, []);
    assert.equal(output.groupSnapshot, 'unavailable');
    assert.equal(output.groupState, null);
    assert.equal(output.timeoutCount, null);
    assert.equal(output.nextAction, 'reconcile');
    assert.ok(output.hints.some((hint: string) => /channel/i.test(hint)));
    assert.equal(f.calls.retain, failure === 'read-only' ? 0 : 1);
    assert.equal(f.calls.runtime, failure.startsWith('state-') ? 1 : 0);
    assert.equal(f.calls.release, failure.startsWith('state-') ? 1 : 0);
    if (failure === 'read-only') assert.deepEqual(f.calls.access, [f.control]);
  });
}

test('public test run writable production entry retains its generation and returns the original execution once', async t => {
  const f = await bootstrapFixture(t, 'healthy');
  const result = await f.run();
  assert.deepEqual(result, f.execution);
  assert.equal(f.calls.retain, 1);
  assert.equal(f.calls.runtime, 1);
  assert.equal(f.calls.release, 1);
});

for (const phase of ['red', 'implement', 'qa', 'hotfix']) {
  test(`parser preserves explicit phase ${phase} and exact files`, () => {
    const argv = [...base];
    argv[3] = phase;
    assert.deepEqual(parseTestRunArgs([...argv, '--files', files[0], files[1]]), {
      project: 'raf', phase, group: 'add-raf-test-run/unit', files: files.slice(0, 2),
    });
  });
}

test('parser accepts a preset without implicitly discovering files', () => {
  assert.deepEqual(parseTestRunArgs(base), { project: 'raf', phase: 'red', group: 'add-raf-test-run/unit' });
});

test('parser preserves an opaque exact test-id containing metacharacters', () => {
  assert.deepEqual(parseTestRunArgs([...base, '--only', JSON.stringify(alpha)]).only, [JSON.stringify(alpha)]);
});

for (const [name, argv] of [
  ['missing project', ['--phase', 'red', '--group', 'add-raf-test-run/unit']],
  ['missing group', ['--project', 'raf', '--phase', 'red']],
  ['empty files', [...base, '--files']],
  ['empty only', [...base, '--only']],
  ['files and only', [...base, '--files', files[0], '--only', JSON.stringify(alpha)]],
  ['arbitrary command', [...base, '--command', 'touch /tmp/forbidden']],
  ['shell', [...base, '--shell', 'sh']],
  ['raw tail', [...base, '--', '--test', files[0]]],
  ['disabled timeout', [...base, '--timeout', '0']],
  ['runner option', [...base, '--test-name-pattern', '.*']],
  ['reset', [...base, '--reset']],
  ['duplicate phase', [...base, '--phase', 'qa']],
  ['positional executable', [...base, 'sh']],
] as const) {
  test(`parser rejects ${name}`, () => {
    assert.throws(() => parseTestRunArgs(argv), error => error instanceof Error && error.message !== 'NotImplemented');
  });
}

test('valid configuration returns configured profile, phases and hints', () => {
  const config = fixtureConfig();
  assert.deepEqual(validateTestRunConfig(config, fixtureContext().agentPhases, policy), config);
});

const invalidConfigurations: [string, (config: TestRunConfig) => void][] = [
  ['missing phase', config => { delete config.phases.qa; }],
  ['unknown phase', config => { config.phases.invented = config.phases.qa; }],
  ['dangling hint', config => { delete config.hints['red-timeout']; }],
  ['missing failure mapping', config => { delete (config.phases.red.hints as Partial<typeof config.phases.red.hints>).setup; }],
  ['missing hint text', config => { config.hints['qa-setup'] = ''; }],
  ['dangling preset profile', config => { config.projects.raf.groups['add-raf-test-run/unit'].profileId = 'missing'; }],
  ['empty inventory', config => { config.projects.raf.profiles.node.unitFiles = []; }],
  ['unsupported adapter', config => { (config.projects.raf.profiles.node as unknown as Record<string, unknown>).resultAdapter = 'stderr-grep'; }],
  ['unsupported id adapter', config => { (config.projects.raf.profiles.node as unknown as Record<string, unknown>).exactIds = 'unsafe-pattern'; }],
  ['shell command profile', config => { (config.projects.raf.profiles.node as unknown as Record<string, unknown>).command = 'node --test'; }],
  ['numeric policy in profile', config => { (config.projects.raf.profiles.node as unknown as Record<string, unknown>).timeoutMs = policy.timeoutMs; }],
  ['missing executable', config => { config.projects.raf.profiles.node.executable = ''; }],
  ['missing environment', config => { delete (config.projects.raf.profiles.node as Partial<typeof config.projects.raf.profiles.node>).environment; }],
  ['glob inventory', config => { config.projects.raf.profiles.node.unitFiles = ['test/*.test.ts']; }],
  ['preset outside inventory', config => { config.projects.raf.groups['add-raf-test-run/unit'].files = ['test/absent.test.ts']; }],
];
for (const [name, mutate] of invalidConfigurations) {
  test(`configuration fails closed: ${name}`, () => {
    const config = fixtureConfig();
    mutate(config);
    assert.throws(() => validateTestRunConfig(config, fixtureContext().agentPhases, policy), /CONFIGURATION_INVALID/);
  });
}

for (const invalidPolicy of [
  { ...policy, timeoutMs: 0 },
  { ...policy, optimizeAfterTimeouts: policy.maxGroupTimeouts },
  { ...policy, maxGroupTimeouts: Number.NaN },
]) {
  test(`invalid unit policy is rejected: ${JSON.stringify(invalidPolicy)}`, () => {
    assert.throws(() => validateTestRunConfig(fixtureConfig(), fixtureContext().agentPhases, invalidPolicy), /CONFIGURATION_INVALID/);
  });
}

test('plan uses configured executable and argv without shell; exact files remain exact', () => {
  const plan = planTestRun(fixtureRequest(), fixtureConfig(), fixtureContext(), fixtureEnvironment());
  assert.equal(plan.profileId, 'node');
  assert.deepEqual(plan.selection, { files: files.slice(0, 2), testIds: [] });
  assert.equal(plan.command.executable, '/local/node');
  assert.deepEqual(plan.command.argv, ['--test', files[0], files[1]]);
  assert.equal(plan.command.cwd, '/work/raf-develop');
  assert.equal(plan.command.shell, false);
  assert.deepEqual(plan.command.environment, { HOME: '/qa/home', statePath: '/qa/home/.raf/state.sqlite', tmpPath: '/qa/home/.raf/tmp' });
});

test('preset resolves its explicit files and does not broaden the selection', () => {
  const plan = planTestRun(fixtureRequest({ files: undefined }), fixtureConfig(), fixtureContext(), fixtureEnvironment());
  assert.deepEqual(plan.selection.files, files.slice(0, 2));
});

for (const selected of [
  [], ['test'], ['test/'], ['test/*.test.ts'], ['/tmp/alpha.test.ts'], ['../test/alpha.test.ts'],
  ['test/../../outside.test.ts'], ['--test-name-pattern=.*'], ['-x'], ['src/test-runs.ts'],
  ['test/absent.test.ts'],
]) {
  test(`unsafe, unlisted or full selection refuses before spawn: ${JSON.stringify(selected)}`, async () => {
    const harness = new RunHarness();
    const stdout: string[] = [];
    const code = await runTestRunCli([...base, '--files', ...selected], {
      config: harness.config, policy, context: harness.context, runtime: harness.ports,
      stdout: line => stdout.push(line), stderr: () => {},
    });
    assert.notEqual(code, 0);
    assert.equal(harness.spawns.length, 0);
    assert.equal(harness.state.transactionCount, 0);
    assert.notEqual((JSON.parse(stdout.join('')) as TestRunResult).outcome, 'passed');
  });
}

for (const [name, mutate] of [
  ['symlink escape', (environment: TestRunEnvironment) => { environment.files[files[0]].realpath = '/outside/alpha.test.ts'; }],
  ['directory', (environment: TestRunEnvironment) => { environment.files[files[0]].kind = 'directory'; }],
  ['non-unit file', (environment: TestRunEnvironment) => { environment.files[files[0]].unit = false; }],
  ['missing file', (environment: TestRunEnvironment) => { delete environment.files[files[0]]; }],
  ['incomplete inventory', (environment: TestRunEnvironment) => { environment.unitFiles.push('test/new.test.ts'); }],
] as const) {
  test(`plan rejects ${name}`, () => {
    const environment = fixtureEnvironment();
    mutate(environment);
    assert.throws(() => planTestRun(fixtureRequest(), fixtureConfig(), fixtureContext(), environment), error => error instanceof Error && error.message !== 'NotImplemented');
  });
}

test('unknown preset and inactive change never trigger discovery', () => {
  for (const group of ['add-raf-test-run/missing', 'closed-change/unit', 'unit']) {
    assert.throws(() => planTestRun(fixtureRequest({ group, files: undefined }), fixtureConfig(), fixtureContext(), fixtureEnvironment()), error => error instanceof Error && error.message !== 'NotImplemented');
  }
});

test('ambiguous profiles and mixed runners refuse rather than pick a fallback', () => {
  const config = fixtureConfig();
  config.projects.raf.profiles.second = structuredClone(config.projects.raf.profiles.node);
  assert.throws(() => planTestRun(fixtureRequest(), config, fixtureContext(), fixtureEnvironment()), error => error instanceof Error && error.message !== 'NotImplemented');
  config.projects.raf.profiles.node.unitFiles = [files[0], files[2]];
  config.projects.raf.profiles.second.unitFiles = [files[1], files[3]];
  assert.throws(() => planTestRun(fixtureRequest(), config, fixtureContext(), fixtureEnvironment()), error => error instanceof Error && error.message !== 'NotImplemented');
});

for (const invalid of ['project', 'workspace', 'cwd'] as const) {
  test(`verified route refuses mismatched ${invalid}`, () => {
    const context = fixtureContext();
    const environment = fixtureEnvironment();
    const request = fixtureRequest();
    if (invalid === 'project') request.project = 'missing';
    if (invalid === 'workspace') context.workspace = '/work/unregistered';
    if (invalid === 'cwd') { context.cwd = '/work/raf-main'; environment.canonicalCwd = context.cwd; }
    assert.throws(() => planTestRun(request, fixtureConfig(), context, environment), error => error instanceof Error && error.message !== 'NotImplemented');
  });
}

test('CLI emits a single reproducible JSON result and preserves child exit separately', async () => {
  const harness = new RunHarness();
  harness.events = [{ kind: 'assertion-failed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  harness.exit.exitCode = 23;
  const stdout: string[] = [];
  const code = await runTestRunCli([...base, '--files', files[0], files[1]], {
    config: harness.config, policy, context: harness.context, runtime: harness.ports,
    stdout: line => stdout.push(line), stderr: () => {},
  });
  const result = JSON.parse(stdout.join('')) as TestRunResult;
  assert.notEqual(code, 0);
  assert.equal(result.exitCode, 23);
  assert.equal(result.outcome, 'assertions-failed');
  assert.deepEqual(result.command, harness.spawns[0]);
  assert.equal(result.project, 'raf');
  assert.equal(result.phase, 'red');
  assert.equal(result.group, 'add-raf-test-run/unit');
  assert.equal(result.workspace, harness.context.workspace);
  assert.ok(result.runId);
  assert.ok(Number.isFinite(Date.parse(result.startedAt)));
  assert.ok(result.durationMs >= 0);
  assert.equal(result.timedOut, false);
});

for (const phase of ['red', 'implement', 'qa', 'hotfix']) {
  for (const kind of ['setup', 'assertions', 'timeout', 'interruption', 'refusal'] as TestRunFailureKind[]) {
    test(`hints are selected from conf for ${phase}/${kind}`, async () => {
      const harness = new RunHarness();
      const id = `${phase}-${kind}`;
      harness.config.hints[id] = `updated text for ${id}`;
      const requestArgs = [...base];
      requestArgs[3] = phase;
      if (kind === 'setup') harness.environment.dependenciesAvailable = false;
      if (kind === 'assertions') {
        harness.events = [{ kind: 'assertion-failed', test: alpha }, { kind: 'complete', expected: [alpha] }];
        harness.exit.exitCode = 1;
      }
      if (kind === 'timeout' || kind === 'interruption') harness.finishImmediately = false;
      if (kind === 'refusal') requestArgs.push('--files', '../escape.test.ts');
      else requestArgs.push('--files', files[0], files[1]);
      const output: string[] = [];
      const pending = runTestRunCli(requestArgs, {
        config: harness.config, policy, context: harness.context, runtime: harness.ports,
        stdout: line => output.push(line), stderr: () => {},
      });
      const { flushMicrotasks } = await import('./helpers/test-run-fixture.ts');
      await flushMicrotasks();
      if (kind === 'timeout') harness.clock.advance(policy.timeoutMs);
      if (kind === 'interruption') harness.interrupt?.('SIGINT');
      assert.notEqual(await pending, 0);
      const result = JSON.parse(output.join('')) as TestRunResult;
      const effectiveId = phase === 'test-scaffold' ? 'test-scaffold-refusal' : id;
      assert.ok(result.hintIds.includes(effectiveId));
      assert.ok(result.hints.includes(harness.config.hints[effectiveId]));
    });
  }
}

test('configuration failure is JSON, without state access or fallback spawn', async () => {
  const harness = new RunHarness();
  delete harness.config.hints['red-setup'];
  const output: string[] = [];
  const code = await runTestRunCli([...base, '--files', files[0]], {
    config: harness.config, policy, context: harness.context, runtime: harness.ports,
    stdout: text => output.push(text), stderr: () => {},
  });
  const result = JSON.parse(output.join('')) as TestRunResult;
  assert.equal(result.errorCode, 'CONFIGURATION_INVALID');
  assert.notEqual(code, 0);
  assert.equal(result.exitCode, null);
  assert.equal(harness.spawns.length, 0);
  assert.equal(harness.state.transactionCount, 0);
});

test('CLI passed is the only zero status and does not touch tasks or run Git', async () => {
  const harness = new RunHarness();
  const output: string[] = [];
  const code = await runTestRunCli([...base, '--files', files[0], files[1]], {
    config: harness.config, policy, context: harness.context, runtime: harness.ports,
    stdout: text => output.push(text), stderr: () => {},
  });
  assert.equal(code, 0);
  assert.equal((JSON.parse(output.join('')) as TestRunResult).outcome, 'passed');
  assert.equal(harness.spawns.length, 1);
  assert.equal(harness.spawns[0].executable, '/local/node');
});

test('full-suite comparison uses the union of every runner inventory', async () => {
  const harness = new RunHarness();
  harness.config.projects.raf.profiles.second = structuredClone(harness.config.projects.raf.profiles.node);
  harness.config.projects.raf.profiles.node.unitFiles = [files[0], files[2]];
  harness.config.projects.raf.profiles.second.unitFiles = [files[1], files[3]];
  const output: string[] = [];
  const code = await runTestRunCli([...base, '--files', ...files], {
    config: harness.config, policy, context: harness.context, runtime: harness.ports,
    stdout: text => output.push(text), stderr: () => {},
  });
  assert.notEqual(code, 0);
  assert.equal((JSON.parse(output.join('')) as TestRunResult).outcome, 'refused');
  assert.equal(harness.spawns.length, 0);
});

test('canonical path with a common textual workspace prefix still cannot escape', () => {
  const environment = fixtureEnvironment();
  environment.files[files[0]].realpath = '/work/raf-develop-evil/test/alpha.test.ts';
  assert.throws(() => planTestRun(fixtureRequest(), fixtureConfig(), fixtureContext(), environment), error => error instanceof Error && error.message !== 'NotImplemented');
});

test('cleanup observes process exit before judging pending SIGKILL as a survivor', async () => {
  const runtime = await import('../src/test-run-processes.ts');
  assert.equal(typeof runtime.cleanupTestProcessGroup, 'function');
  let running = true;
  const signals: number[] = [];
  const result = await runtime.cleanupTestProcessGroup(41, {
    tree: () => running ? [{ pid: 41, start: 'birth' }, { pid: 42, start: 'child' }] : [],
    start: pid => running ? pid === 41 ? 'birth' : 'child' : null,
    kill: pid => { signals.push(pid); },
    settle: async () => { running = false; },
  });
  assert.deepEqual(result, { complete: true, remainingPids: [] });
  assert.deepEqual(signals, [42, 41, -41]);
});

test('recovery does not infer a timeout after processes disappear without a recorded finish time', async () => {
  const runtime = await import('../src/test-run-processes.ts');
  assert.equal(typeof runtime.reconcileTestRunProcess, 'function');
  const observation = await runtime.reconcileTestRunProcess(JSON.stringify({ pid: 41, start: 'birth', boot: 'boot' }), 90, {
    now: () => 100, boot: () => 'boot', start: () => null, tree: () => [],
    cleanup: async () => ({ complete: true, remainingPids: [] }),
  });
  assert.equal(observation.deadlineReached, false, 'delta «Завершення до дедлайну й пізня звірка», S06: late now is not timeout evidence');
  assert.equal(observation.alive, false);
});

test('recovery preserves an unprovable reservation without a published process identity', async () => {
  const runtime = await import('../src/test-run-processes.ts');
  assert.equal(typeof runtime.reconcileTestRunProcess, 'function');
  const observation = await runtime.reconcileTestRunProcess(null, 90, {
    now: () => 100, boot: () => 'boot', start: () => null, tree: () => [],
    cleanup: async () => ({ complete: true, remainingPids: [] }),
  });
  assert.deepEqual(observation, { alive: true, deadlineReached: true, cleanup: { complete: false, remainingPids: [] } });
});

test('recovery never signals a replacement process with a reused PID', async () => {
  const runtime = await import('../src/test-run-processes.ts');
  assert.equal(typeof runtime.reconcileTestRunProcess, 'function');
  let cleaned = false;
  const observation = await runtime.reconcileTestRunProcess(JSON.stringify({ pid: 41, start: 'old', boot: 'boot' }), 90, {
    now: () => 100, boot: () => 'boot', start: () => 'new', tree: () => [{ pid: 41, start: 'new' }],
    cleanup: async () => { cleaned = true; return { complete: true, remainingPids: [] }; },
  });
  assert.equal(cleaned, false);
  assert.equal(observation.alive, true, 'delta «Невідома identity або повторна звірка», S05: PID reuse retains the unverified fence');
  assert.deepEqual(observation.cleanup, { complete: false, remainingPids: [] });
});

test('discovered test identities remain unexecuted when the runner times out', async () => {
  const { classifyRunnerResult } = await import('../src/test-runs.ts');
  const result = classifyRunnerResult([{ kind: 'discovered', test: alpha } as any], { exitCode: null, signal: 'SIGKILL', stderr: '' });
  assert.deepEqual(result.unexecuted, [alpha]);
  assert.deepEqual(result.unknown, []);
});

test('reporter streams a declared test identity before any outcome arrives', async () => {
  const { default: report } = await import('../src/test-run-reporter.ts');
  const data = { name: 'pending', file: `${process.cwd()}/test/alpha.test.ts`, entryFile: `${process.cwd()}/test/alpha.test.ts`, testId: 1, parentId: 0, nesting: 0, type: 'test' };
  async function* source() { yield { type: 'test:enqueue', data }; }
  const lines = [];
  for await (const line of report(source())) lines.push(JSON.parse(line));
  assert.deepEqual(lines[0], { kind: 'discovered', test: { file: 'test/alpha.test.ts', name: 'pending' } });
});

test('cleanup waits for every signalled descendant identity after the root exits', async () => {
  const runtime = await import('../src/test-run-processes.ts');
  let descendants = [{ pid: 41, start: 'birth' }, { pid: 42, start: 'detached' }];
  const result = await runtime.cleanupTestProcessGroup(41, {
    tree: () => descendants,
    start: pid => descendants.find(row => row.pid === pid)?.start ?? null,
    kill: () => {},
    settle: async (_root: boolean, signalled?: { pid: number; start: string }[]) => {
      assert.deepEqual(signalled, [{ pid: 42, start: 'detached' }, { pid: 41, start: 'birth' }]);
      descendants = [];
    },
  });
  assert.equal(result.complete, true);
});
