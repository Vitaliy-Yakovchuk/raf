import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTestRun, validateTestRunConfig } from '../src/test-runs.ts';
import type { ParsedTestRunArgs, TestRunConfig, TestRunContext, TestRunEnvironment, TestRunProfile } from '../src/test-runs.ts';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { profileFiles, profileTestKind } from '../src/test-run-integration-profiles.ts';

const confRoot = new URL('../../conf/', import.meta.url);
const readConf = (name: string) => JSON.parse(readFileSync(new URL(name, confRoot), 'utf8'));
const flow = readConf('flow.json');
const phases: string[] = readConf('raf-constants.json').agentPhases.map((phase: { id: string }) => phase.id);
const reporter = fileURLToPath(new URL('../src/test-run-vitest-reporter.ts', import.meta.url));
const toolsFile = 'app/tools/live-stack/live-stack.test.ts';
const pageChecksFile = 'app/tools/screens/page-checks.test.ts';

function fixture(t: TestContext, request: ParsedTestRunArgs) {
  const root = mkdtempSync(join(tmpdir(), 'profile-resolution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, data: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), data); };
  write('conf/projects.json', JSON.stringify({ version: 1, projects: {
    raf: { path: 'raf-main', branchPaths: { main: 'raf-main' }, profile: 'raf' },
    etchly: { path: 'etchly-main', branchPaths: { main: 'etchly-main' }, profile: 'raf' },
  }, profiles: { raf: { production: 'main', environments: { runtime: 'main' } } } }));
  write('conf/raf.json', JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
  write('raf-main/src/state-store.ts', '');
  write('etchly-main/app/vitest.config.ts', 'export default {};');
  const home = join(root, 'qa-home');
  mkdirSync(home);
  const inherited = { HOME: home, RAF_QA_HOME: home, PATH: process.env.PATH };
  const state = resolveStateContext({ orchestratorRoot: root, modulePath: join(root, 'raf-main/src/state-store.ts'), homeDirectory: home, operatingSystemHome: join(root, 'working-home'), environment: inherited, entryPoint: 'cli' });
  const workspace = join(root, 'etchly-main');
  const config = validateTestRunConfig(readConf('test-runs.json'), phases, flow.unitTests, flow.integrationTests);
  const profiles = config.projects.etchly.profiles;
  const unitFiles = [...new Set(Object.values(profiles).filter(profile => profileTestKind(profile) === 'unit').flatMap(profileFiles))];
  const environment: TestRunEnvironment = { canonicalWorkspace: workspace, canonicalCwd: workspace,
    runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true, resultAdapterAvailable: true,
    artifactsWritable: true, treeControlSupported: true, isolatedHome: true, stateOriginAllowed: true,
    stateAliasesOperational: false, tmpAliasesOperational: false, inheritedOperationalChannel: false,
    unitFiles, files: Object.fromEntries(unitFiles.map(file => [file, { kind: 'file' as const, realpath: resolve(workspace, file), unit: true, testKind: 'unit' as const }])) };
  const context: TestRunContext = { cwd: workspace, workspace, projectWorkspaces: { etchly: [workspace] }, agentPhases: phases, activeChanges: ['fix-raf-test-profile-resolution'], agentId: 'fixture', sha: 'fixture', home, statePath: state.statePath, tmpPath: state.tmpRoot, operationalHome: join(root, 'working-home'), integrationTests: flow.integrationTests };
  const ports = createTestRunPorts(config, state, () => { throw new Error('state store is unused'); }, inherited,
    { flow: readFileSync(new URL('flow.json', confRoot)), testRuns: readFileSync(new URL('test-runs.json', confRoot)), projects: readFileSync(join(root, 'conf/projects.json')) }, request);
  return { workspace, config, environment, context, ports };
}

function expectedArgv(profile: TestRunProfile, cwdFile: string): string[] {
  const run = profile.argv.indexOf('run');
  return [...profile.argv.slice(0, run + 1), cwdFile, ...profile.argv.slice(run + 1), '--testTimeout', String(flow.unitTests.timeoutMs), '--hookTimeout', String(flow.unitTests.timeoutMs), '--reporter', reporter];
}

async function spawnedBatches(t: TestContext, request: ParsedTestRunArgs) {
  const f = fixture(t, request);
  const plan = planTestRun(request, f.config, f.context, f.environment);
  const spawns: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: process.pid, stdout, stderr });
  const mocked = t.mock.method(childProcess, 'spawn', ((_executable: string, argv: string[], settings: { env: Record<string, string | undefined> }) => {
    spawns.push({ argv, env: settings.env });
    queueMicrotask(() => { child.emit('spawn'); setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); }); });
    return child;
  }) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const managed = await f.ports.spawn(plan.command, () => {}, { project: plan.request.project, profileId: plan.profileId });
  await managed.wait();
  assert.equal(spawns.length, 1);
  const batches = JSON.parse(spawns[0].env.RAF_TEST_RUN_VITEST_BATCHES ?? '[]') as { argv: string[]; cwd: string }[];
  return { plan, batches, profiles: f.config.projects.etchly.profiles, workspace: f.workspace };
}

test('an unregistered etchly tools group with --files runs exactly the argv of its own profile', async t => {
  const request = { project: 'etchly', phase: 'red', group: 'fix-raf-test-profile-resolution/smoke-tools-unregistered', files: [toolsFile] };
  const { plan, batches, profiles, workspace } = await spawnedBatches(t, request);
  assert.equal(plan.profileId, 'vitest-app-tools');
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].argv, expectedArgv(profiles['vitest-app-tools'], relative(join(workspace, 'app'), resolve(workspace, toolsFile))));
  assert.ok(!batches[0].argv.includes('--config'));
  assert.deepEqual(plan.command.environment.vitestBatches?.map(batch => batch.argv), [batches[0].argv]);
});

test('a registered etchly tools group runs exactly the argv of its own profile', async t => {
  const request = { project: 'etchly', phase: 'hotfix', group: 'route-registration-to-regional-shards/smoke-identities-3-6' };
  const { plan, batches, profiles, workspace } = await spawnedBatches(t, request);
  assert.equal(plan.profileId, 'vitest-app-tools');
  assert.deepEqual(batches.map(batch => batch.argv), [expectedArgv(profiles['vitest-app-tools'], relative(join(workspace, 'app'), resolve(workspace, toolsFile)))]);
});

test('an unregistered page-checks selection keeps the --config argv of its own profile', async t => {
  const request = { project: 'etchly', phase: 'red', group: 'fix-raf-test-profile-resolution/page-checks-unregistered', files: [pageChecksFile] };
  const { plan, batches, profiles, workspace } = await spawnedBatches(t, request);
  assert.equal(plan.profileId, 'vitest-page-checks-unit');
  assert.deepEqual(batches.map(batch => batch.argv), [expectedArgv(profiles['vitest-page-checks-unit'], relative(join(workspace, 'app'), resolve(workspace, pageChecksFile)))]);
});
