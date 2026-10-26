import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import nodeFs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { confirmReportedTasks, runtimeExecution } from '../src/production-runtime.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { createAssignmentIdentityAdapter } from '../src/assignment-identity.ts';
import { fixture } from './production-fixture.ts';
import type { AgentReport, AgentReportRequest } from '../src/agent-report.ts';
import { createAgentReportWatcher } from '../src/agent-report.ts';
import { createHook } from 'node:async_hooks';
import { reportConfirmationInputs, onConfirmationInputChange } from '../src/report-confirmation-inputs.ts';
import { mkdtemp, rm } from 'node:fs/promises';

test('idle worker confirmation observes replacement reports while a writer remains busy', async t => {
  const root = await mkdtemp('/tmp/raf-idle-report-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const request: AgentReportRequest = { tmpRoot: root, runId: 'run', address: 'worker', assignment: { root, changes: [] } };
  await mkdir(join(root, 'run'));
  const path = join(root, 'run/worker.json');
  await writeFile(path, 'first report');
  const inputs = reportConfirmationInputs(request);
  const before = await inputs.snapshot();
  await writeFile(path, 'replaced report');
  assert.notEqual(await inputs.snapshot(), before, 'a replacement report must wake a blocked confirmation');
  const blocked = await inputs.snapshot();
  let stop = () => {};
  t.after(() => stop());
  let wake!: () => void;
  const notified = new Promise<void>(resolve => { wake = resolve; });
  stop = await onConfirmationInputChange(inputs, blocked, error => { assert.ifError(error); wake(); });
  await writeFile(path, 'third report');
  await notified;
});

test('idle worker report confirmation waits for a changed input without poll timers and resumes delivery', async t => {
  let busy = true;
  let version = 0;
  let attempts = 0;
  let reads = 0;
  let listener = () => {};
  let subscribed!: () => void;
  const armed = new Promise<void>(resolve => { subscribed = resolve; });
  const timers: string[] = [];
  const results: string[] = [];
  const hook = createHook({ init(_id, type) { if (type === 'Timeout') timers.push(type); } });
  const request: AgentReportRequest = { tmpRoot: '/unit/idle-worker', runId: 'idle-report', address: 'worker',
    assignment: { root: '/unit/idle-worker-source', changes: [{ id: 'idle', items: [{ id: '5.1', description: 'Complete work' }] }] } };
  const report = JSON.stringify({ status: 'succeeded', answer: 'Done', changes: [{ id: 'idle', items: [{ id: '5.1', status: 'succeeded' }] }] });
  hook.enable();
  const pending = createAgentReportWatcher(request, {
    fs: { mkdir: async () => {}, readText: async () => { reads++; return report; }, removeTree: async () => {} },
    watch: () => () => {}, process: { onExit: () => () => {} },
    confirmationRetry: { runner: 'codex', protocol: async () => ({ timeouts: { transitionMs: 1000, pollMs: 10 } }),
      inputs: { snapshot: async () => String(version), subscribe: async callback => { listener = callback; subscribed(); return () => { listener = () => {}; }; } } },
    confirmTaskCheckboxes: async () => { attempts++; return { ok: !busy, issues: [], commits: [], ...(busy ? { transient: 'writer-busy' as const } : {}) }; },
    verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }),
    now: () => new Date().toISOString(), result: async value => { results.push(value.status); }, diagnostic: async () => {},
  });
  t.after(async () => { hook.disable(); busy = false; version++; listener(); await (await pending).dispose(); });
  await armed;
  await new Promise<void>(resolve => setImmediate(resolve));
  hook.disable();
  assert.equal(attempts, 1);
  const idleReads = reads;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, idleReads, 'unchanged input must not cause report or state rereads');
  assert.deepEqual(timers, [], 'waiting worker must not arm a poll timer');
  busy = false;
  version++;
  listener();
  const watcher = await pending;
  assert.equal(attempts, 2);
  assert.deepEqual(results, ['succeeded']);
  await watcher.dispose();
});

test('worker report confirmation reuses its verified environment across checkbox Git operations and repeated reports', async t => {
  const f = await fixture(t, { tasks: 2 });
  const git = (...args: string[]) => {
    const result = childProcess.spawnSync('git', ['-c', 'user.name=Worker fixture', '-c', 'user.email=worker@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.name', 'Worker fixture'); git('config', 'user.email', 'worker@example.invalid'); git('add', 'openspec'); git('commit', '-qm', 'Launch baseline');
  const projectsPath = join(f.confRoot, 'projects.json');
  await writeFile(projectsPath, JSON.stringify({ version: 1, projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' } } }, profiles: { raf: { production: 'main', environments: { runtime: 'main' } } } }));
  await mkdir(join(f.root, 'raf-main', 'src'), { recursive: true });
  await mkdir(join(f.cwd, 'src'), { recursive: true });
  const modulePath = join(f.cwd, 'src', 'worker.ts');
  await writeFile(modulePath, '');
  const raf = JSON.parse(await readFile(join(f.confRoot, 'raf.json'), 'utf8'));
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify({ ...raf, state: { fileName: 'isolated.sqlite' } }));
  const stateContext = resolveStateContext({ orchestratorRoot: f.root, modulePath, homeDirectory: f.home, operatingSystemHome: join(f.root, 'account-home'), environment: { HOME: f.home, RAF_QA_HOME: f.home }, entryPoint: 'worker' });
  const context = { ...f.context, stateContext };
  const runId = 'idle-cost';
  const tasks = await createAssignmentIdentityAdapter({ raf: f.root }, { execute: f.execute }).capture('raf', f.assignment);
  const boot = { machineId: 'fixture', bootId: 'fixture' };
  const starter = { pid: process.pid, startedAt: new Date().toISOString(), runner: 'codex', runnerSessionId: 'fixture', tmuxSession: 'fixture', evidence: { ...boot, runId } };
  f.store.sessionRepository.transaction(tx => tx.putSession({ runId, addressId: 'idle-cost', revision: 0, state: 'running', activity: { type: 'hotfix', project: 'raf', features: ['fixture-launch'], phase: 'hotfix', cwd: f.cwd } }));
  f.store.taskReservationRepository.transaction(tx => tx.putTaskReservation({ lease: { owner: { runId, addressId: 'idle-cost', fence: 'fixture' }, revision: 0 }, tasks, boot, stage: 'running', starter }));
  const request: AgentReportRequest = { tmpRoot: f.tmpRoot, runId, address: 'idle-cost', assignment: f.assignment };
  const report: AgentReport = { status: 'succeeded', answer: 'Completed', changes: [{ id: 'fixture-launch', items: [{ id: '2.1', status: 'succeeded' }] }] };
  const configured = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex').timeouts;
  let validations = 0;
  const readFileSync = nodeFs.readFileSync;
  t.mock.method(nodeFs, 'readFileSync', (...args) => {
    if (args[0] === projectsPath) validations++;
    return Reflect.apply(readFileSync, nodeFs, args);
  });
  const spawn = childProcess.spawn;
  const commands: { args: readonly string[]; index?: string; home?: string }[] = [];
  t.mock.method(childProcess, 'spawn', (...args) => {
    if (args[0] === 'git') commands.push({ args: args[1] as string[], index: args[2]?.env?.GIT_INDEX_FILE, home: args[2]?.env?.HOME });
    return Reflect.apply(spawn, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const execute = runtimeExecution(context, undefined, true);
  let identityGitCommands = 0;
  const identityExecute: typeof execute = command => {
    if (command.executable === 'git') identityGitCommands++;
    return f.execute(command);
  };
  const first = await confirmReportedTasks(f.store, context, execute, request, report, configured, identityExecute);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.commits.length, 1);
  assert.ok(commands.some(command => command.index), 'checkbox commit must use its isolated Git index');
  assert.ok(commands.filter(command => command.index).every(command => command.home === f.home));
  const firstGitCommands = commands.length;
  commands.length = 0;
  const repeated = await confirmReportedTasks(f.store, context, execute, request, report, configured, identityExecute);
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.deepEqual(repeated.commits, first.commits, 'rechecking a report preserves checkbox provenance');
  assert.ok(commands.length > 0, 'fresh Git verification remains enabled');
  t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', test: { file: 'test/worker-idle-cost.test.ts', name: t.name }, message: JSON.stringify({ firstGitCommands, repeatedGitCommands: commands.length, originRevalidations: validations, identityGitCommands }), location: null, stack: [], redacted: false, truncated: false }] }));
  assert.ok(identityGitCommands >= firstGitCommands + commands.length, 'checkbox Git operations must honor the identity executor');
  assert.equal(validations, 0, 'waiting worker must not revalidate its origin inventory per checkbox Git operation');
  assert.match(await readFile(f.tasksPath, 'utf8'), /\[x\] 2\.1/);
  assert.match(await readFile(f.tasksPath, 'utf8'), /\[ \] 2\.2/);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fixtureConfig } from './helpers/test-run-fixture.ts';

for (const change of ['archived', 'removed-during-wait']) test(`production preflight runs configured ${change} regression group`, async t => {
  const root = mkdtempSync('/tmp/raf-archived-group-');
  const conf = join(root, 'conf');
  mkdirSync(conf);
  const config = fixtureConfig();
  config.projects.raf.profiles.node.executable = process.execPath;
  config.projects.raf.profiles.node.checks = [];
  config.projects.raf.profiles.node.unitFiles = ['test/worker-idle-cost.test.ts'];
  const group = 'fix-raf-load-admission/worker-idle';
  config.projects.raf.groups = { [group]: { profileId: 'node', files: ['test/worker-idle-cost.test.ts'] } };
  for (const [name, value] of Object.entries({
    'test-runs.json': config,
    'projects.json': { projects: { raf: { branchPaths: { hotfix: process.cwd() } } } },
    'raf.json': {},
  })) writeFileSync(join(conf, name), JSON.stringify(value));
  for (const name of ['raf-constants.json', 'flow.json']) writeFileSync(join(conf, name), readFileSync(new URL(`../../conf/${name}`, import.meta.url)));
  const caller = { pid: process.pid, startedAt: 'fixture' };
  const assignment = { runId: 'fixture', agentId: 'fixture', type: 'hotfix', phase: 'hotfix', project: 'raf', workspace: process.cwd(), branch: 'hotfix', changes: ['profile-raf-performance'] };
  let snapshots = 0;
  let preflights = 0;
  let unitHome: string | undefined;
  const key = `archivedGroup.${change}`;
  const globals = globalThis as Record<string, unknown>;
  globals[key] = {
    snapshot: async () => ({ ancestors: [caller], callerEvidence: {}, activeChanges: change === 'removed-during-wait' && snapshots++ === 0 ? ['fix-raf-load-admission'] : [] }),
    assignment,
    stateContext: (_root: string, _module: string, home: string) => {
      if (home !== root) unitHome = home;
      return { mode: 'qa', homeDirectory: home, statePath: join(home, '.raf/state.sqlite'), tmpRoot: join(home, '.raf/tmp') };
    },
    run: async (_request: unknown, ports: any) => {
      const unit = await ports.unitContext({ project: 'raf', workspace: process.cwd(), group }, assignment);
      for (let index = 0; index < 2; index++) {
        const environment = await unit.runtime.preflight(unit.context);
        assert.equal(environment.runtimeAvailable, true);
        assert.equal(environment.isolatedHome, true);
        preflights++;
      }
      return { code: 0, stdout: JSON.stringify({ groupSnapshot: 'unavailable', outcome: 'passed' }), stderr: '' };
    },
  };
  const url = new URL(`../src/test-run-runtime.ts?archived-group=${change}`, import.meta.url).href;
  const bridge = `const f = globalThis[${JSON.stringify(key)}];`;
  const doubles: Record<string, string> = {
    './production-runtime.ts': `${bridge} export const sandboxTestControlSnapshot = f.snapshot;`,
    './sandbox-test-caller.ts': `${bridge} export const resolveSandboxTestCaller = () => f.assignment;`,
    './sandbox-test-run.ts': `${bridge} export const runSandboxTestCommand = f.run;`,
    './state-migration-guard.ts': `${bridge} export const productionStateContext = f.stateContext; export const stateContextEnvironment = (_context, env) => env; export const canonicalStatePath = path => path;`,
    './state-store.ts': 'export const openStateStore = () => ({ close() {}, sessionRepository: { transaction: () => null } });',
    './test-run-unit-state.ts': 'export const prepareUnitTestState = async () => {};',
    './test-run-resource-runtime.ts': 'export const createTestRunResourcePort = () => ({});',
    './test-run-queue-runtime.ts': 'export const createTestRunQueuePort = () => ({});',
    './test-run-reservations.ts': 'export const reconcileTestRunResources = async () => {};',
  };
  const names = Object.keys(doubles);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === url && Object.hasOwn(doubles, specifier)) return { url: `archived-group:${key}:${names.indexOf(specifier)}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(specifier, context, next) {
      const prefix = `archived-group:${key}:`;
      if (specifier.startsWith(prefix)) return { format: 'module', source: doubles[names[Number(specifier.slice(prefix.length))]], shortCircuit: true };
      return next(specifier, context);
    },
  });
  t.after(() => { hooks.deregister(); delete globals[key]; rmSync(root, { recursive: true, force: true }); if (unitHome) rmSync(unitHome, { recursive: true, force: true }); });
  const { runConfiguredTestRun } = await import(url);
  const result = await runConfiguredTestRun(['--project', 'raf', '--phase', 'hotfix', '--group', group], { orchestratorRoot: root, homeDirectory: root, commandTimingOwner: 'production' });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(preflights, 2, 'both initial and post-wait preflight must inspect the execution environment');
});
