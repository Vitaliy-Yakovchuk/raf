import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { runResourceReservedTestRun } from '../src/test-run-reservations.ts';
import { acknowledgeTestRunDelivery } from '../src/test-run-state-recovery.ts';
import { machine } from './helpers/test-run-reservations-fixture.ts';
import { RunHarness, fixtureGroup, policy } from './helpers/test-run-fixture.ts';
import type { RunnerEvent, TestRunCommand, TestRunConfig, TestRunContext } from '../src/test-runs.ts';

const confRoot = new URL('../../conf/', import.meta.url);
const readConfig = (name: string) => JSON.parse(readFileSync(new URL(name, confRoot), 'utf8'));

function fixture(t: TestContext, cwd = 'bugs-api', spawnFailed?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'hotfix-637-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, data: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), data);
  };
  write('conf/projects.json', JSON.stringify({ version: 1, projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main' }, profile: 'raf' } }, profiles: { raf: { production: 'main', environments: { runtime: 'main' } } } }));
  write('conf/raf.json', JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
  write('raf-main/src/state-store.ts', '');
  write('shared-libs/bugs-api/src/pull.test.ts', '');
  write('shared-libs/bugs-api/vitest.config.ts', 'export default {};');
  write('shared-libs/vitest.config.ts', 'export default {};');
  write('shared-libs/node_modules/vitest/vitest.mjs', '');
  const home = join(root, 'qa-home');
  mkdirSync(home);
  const inherited = { HOME: home, RAF_QA_HOME: home, PATH: process.env.PATH };
  const state = resolveStateContext({ orchestratorRoot: root, modulePath: join(root, 'raf-main/src/state-store.ts'), homeDirectory: home, operatingSystemHome: join(root, 'working-home'), environment: inherited, entryPoint: 'cli' });
  const workspace = join(root, 'shared-libs');
  const file = 'bugs-api/src/pull.test.ts';
  const profile = {
    cwd, executable: process.execPath,
    argv: [cwd === '.' ? 'node_modules/vitest/vitest.mjs' : '../node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner'],
    unitFiles: [file], exactIds: 'vitest-test-name' as const, resultAdapter: 'vitest-events' as const,
    environment: { isolatedHome: true, stateOrigin: true },
    checks: ['node_modules/vitest/vitest.mjs', 'bugs-api/vitest.config.ts'],
  };
  const config: TestRunConfig = { ...readConfig('test-runs.json'), projects: { 'shared-libs': { profiles: { vitest: profile }, groups: { 'add-raf-test-run/unit': { profileId: 'vitest', files: [file] } } } } };
  const ports = createTestRunPorts(config, state, () => { throw new Error('state store is unused'); }, inherited,
    { flow: readFileSync(new URL('flow.json', confRoot)), testRuns: Buffer.from(JSON.stringify(config)), projects: readFileSync(join(root, 'conf/projects.json')) },
    { project: 'shared-libs', phase: 'hotfix', group: 'add-raf-test-run/unit' }, undefined, spawnFailed);
  const context: TestRunContext = { cwd: workspace, workspace, projectWorkspaces: { 'shared-libs': [workspace] }, agentPhases: ['hotfix'], activeChanges: ['add-raf-test-run'], agentId: 'fixture', sha: 'fixture', home, statePath: state.statePath, tmpPath: state.tmpRoot, operationalHome: join(root, 'working-home') };
  return { root, workspace, file, ports, context, write, profile, config };
}

test('6.7 Vitest setup ENOENT before OS spawn releases the group and preserves its retry budget', async t => {
  let spawning = false, failedSpawns = 0, osSpawns = 0;
  const f = fixture(t, 'bugs-api', () => { spawning = false; failedSpawns++; });
  const unrelated = 'bugs-api/src/unrelated.test.ts';
  f.profile.unitFiles.push(unrelated);
  f.context.agentPhases = Object.keys(f.config.phases);
  rmSync(join(f.workspace, 'bugs-api/vitest.config.ts'));
  const h = new RunHarness();
  const shared = machine();
  const request = { project: 'shared-libs', phase: 'red', group: 'add-raf-test-run/unit', files: [f.file] };
  const key = { project: request.project, workspace: f.workspace, group: request.group };
  const red = { file: f.file, name: 'previous failure' };
  const pending = { file: f.file, name: 'not executed' };
  h.state.seed(fixtureGroup({ key, timeoutCount: policy.optimizeAfterTimeouts, state: 'optimize',
    selection: { files: [f.file], testIds: [] }, knownRed: [red], unexecuted: [pending] }));
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: process.pid, stdout, stderr });
  const mocked = t.mock.method(childProcess, 'spawn', () => {
    osSpawns++;
    queueMicrotask(() => {
      child.emit('spawn');
      setImmediate(() => {
        for (const id of [red, pending]) stdout.write(JSON.stringify({ kind: 'passed', test: id }) + '\n');
        stdout.write(JSON.stringify({ kind: 'complete', expected: [red, pending], adapter: 'vitest-events' }) + '\n');
        child.emit('exit', 0, null); child.emit('close', 0, null);
      });
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const resources = { ...shared.resources,
    markSpawning: async () => { spawning = true; },
    observeTree: async () => ({ state: spawning ? 'unknown' as const : 'dead' as const, processIdentity: null, consumed: null }),
  };
  const ports = { ...h.ports, machineId: 'machine', resources,
    resourceRoute: { branchPaths: { hotfix: f.workspace } },
    preflight: async () => ({ ...h.environment, canonicalWorkspace: f.workspace, canonicalCwd: f.workspace,
      unitFiles: [f.file, unrelated], files: Object.fromEntries([f.file, unrelated].map(file => [file, { kind: 'file' as const, realpath: join(f.workspace, file), unit: true }])) }),
    spawn: async (...args: Parameters<typeof f.ports.spawn>) => {
      const managed = await f.ports.spawn(...args);
      spawning = false;
      return { ...managed, cleanup: async () => ({ complete: true, remainingPids: [] }) };
    },
  };
  const failed = await runResourceReservedTestRun(request, f.config, policy, f.context, ports);
  assert.equal(failed.outcome, 'setup-failed');
  assert.equal(failed.errorCode, 'ENOENT');
  assert.equal(failed.exitCode, null);
  assert.equal(failed.timedOut, false);
  assert.equal(osSpawns, 0);
  assert.equal(failed.cleanup.complete, true);
  assert.equal(failed.nextAction, 'fix-setup');
  assert.equal(failedSpawns, 1);
  assert.equal(h.state.get(key)?.inFlight, null);
  assert.equal(shared.claims.size, 0);
  assert.equal(h.state.get(key)?.timeoutCount, policy.optimizeAfterTimeouts);
  assert.deepEqual(h.state.get(key)?.knownRed, [red]);
  assert.deepEqual(h.state.get(key)?.unexecuted, [pending]);
  await acknowledgeTestRunDelivery(failed, h.state);
  f.write('shared-libs/bugs-api/vitest.config.ts', 'export default {};');
  const retried = await runResourceReservedTestRun({ ...request, phase: 'hotfix' }, f.config, policy, { ...f.context, agentId: 'next-agent', sha: 'next-sha' }, ports);
  assert.equal(retried.outcome, 'passed');
  assert.notEqual(retried.runId, failed.runId);
  assert.equal(osSpawns, 1);
  assert.equal(retried.timeoutCount, policy.optimizeAfterTimeouts);
  assert.equal(retried.cleanup.complete, true);
  assert.equal(h.state.get(key)?.inFlight, null);
  assert.equal(shared.claims.size, 0);
});

for (const [cwd, preload] of [['bugs-api', false], ['.', false], ['bugs-api', true]] as const) test(`6.3.7 non-etchly Vitest profile at ${cwd}${preload ? ' with preload' : ''} uses the structured adapter`, async t => {
  const f = fixture(t, cwd);
  if (preload) f.profile.argv.unshift('--import', '../tools/raf-test-runtime.mjs');
  const run = f.profile.argv.indexOf('run');
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: process.pid, stdout, stderr });
  let invocation: { executable: string; argv: string[]; options: any } | undefined;
  const mocked = t.mock.method(childProcess, 'spawn', (executable: string, argv: string[], options: any) => {
    invocation = { executable, argv, options };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const command: TestRunCommand = { executable: process.execPath, cwd: join(f.workspace, cwd), shell: false,
    argv: [...f.profile.argv.slice(0, run + 1), cwd === '.' ? f.file : 'src/pull.test.ts', ...f.profile.argv.slice(run + 1)],
    environment: { HOME: f.context.home, statePath: f.context.statePath, tmpPath: f.context.tmpPath, TMPDIR: f.context.home } };
  const events: RunnerEvent[] = [];
  const managed = await f.ports.spawn(command, event => events.push(event));
  stdout.write(JSON.stringify({ kind: 'complete', expected: [{ file: f.file, name: 'pull' }], adapter: 'vitest-events' }) + '\n');
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal((await managed.wait()).exitCode, 0);
  assert.equal(command.environment.vitestBatches?.length, 1, 'non-etchly profile must use the Vitest protocol wrapper');
  assert.equal(invocation?.argv[0], fileURLToPath(new URL('../scripts/test-run-vitest.ts', import.meta.url)));
  assert.equal(invocation?.options.env.RAF_TEST_RUN_WORKSPACE, f.workspace);
  assert.deepEqual(JSON.parse(invocation!.options.env.RAF_TEST_RUN_VITEST_BATCHES), command.environment.vitestBatches);
  if (preload) assert.deepEqual(command.environment.vitestBatches![0].argv.slice(0, 2), ['--import', '../tools/raf-test-runtime.mjs']);
  assert.ok(events.some(event => event.kind === 'complete'));
});

test('6.3.7 dependency checks resolve from workspace for a non-etchly nested profile', async t => {
  const f = fixture(t);
  assert.equal((await f.ports.preflight(f.context)).dependenciesAvailable, true);
});

test('6.3.7 cwd-local lookalike cannot satisfy a missing workspace dependency', async t => {
  const f = fixture(t);
  rmSync(join(f.workspace, 'node_modules/vitest/vitest.mjs'));
  f.write('shared-libs/bugs-api/node_modules/vitest/vitest.mjs', '');
  f.write('shared-libs/bugs-api/bugs-api/vitest.config.ts', '');
  assert.equal((await f.ports.preflight(f.context)).dependenciesAvailable, false);
});

const constants = readConfig('raf-constants.json');
const models = readConfig('models.json');
const commandConstants = { ...constants, commands: constants.commands.filter((command: { path: string[] }) => command.path.join(' ') === 'agent run') };
const catalog = compileCatalog(commandConstants, models, ['agent run'], readConfig('projects.json'));

for (const order of ['type-first', 'phase-first']) test(`6.3.8 test-scaffold/red is rejected before the launch handler (${order})`, async () => {
  let launches = 0;
  const result = await execute(['agent', 'run', '--id', 'red-refusal', ...(order === 'type-first' ? ['--type', 'test-scaffold', '--phase', 'red'] : ['--phase', 'red', '--type', 'test-scaffold']),
    '--project', 'raf', '--features', 'add-raf-test-run', '--complexity', 'ordinary', '--tasks', 'add-raf-test-run:6.3.8'], catalog,
    { 'agent run': () => { launches++; return { runId: 'must-not-be-created', tmuxSession: 'must-not-start' }; } });
  assert.equal(result.exitCode, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.code, 'INVALID_VALUE');
  assert.equal(failure.details.stage, 'arguments');
  assert.equal(failure.details.parameter, '--phase');
  assert.equal(failure.details.received, 'red');
  assert.equal(result.stdout, '');
  assert.equal(launches, 0, 'run identity and tmux can only be allocated by the launch handler');
  assert.equal(JSON.stringify(failure).includes('runId'), false);
});

for (const [type, phase] of [['test-scaffold', 'test-scaffold'], ['hotfix', 'implement'], ['spec', 'context-review']]) test(`6.3.8 valid launch ${type}/${phase} still reaches the handler`, async () => {
  let launches = 0;
  const result = await execute(['agent', 'run', '--id', 'valid-launch', '--type', type, '--phase', phase, '--project', 'raf', '--features', 'add-raf-test-run', '--complexity', 'ordinary', '--tasks', 'add-raf-test-run:6.3.8'], catalog,
    { 'agent run': () => { launches++; return { accepted: true }; } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(launches, 1);
});
