import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import type { TestRunCommand } from '../src/test-runs.ts';
import { fixtureConfig } from './helpers/test-run-fixture.ts';

const workspace = resolve(import.meta.dirname, '..');
const profileId = 'vitest-worker-d1-integration';
const testFile = 'worker/src/d1-private-tmpdir.test.ts';

function fakeChild(t: TestContext, spawned: { env?: NodeJS.ProcessEnv }): void {
  t.mock.method(childProcess, 'spawn', (_executable: string, _argv: string[], options: { env: NodeJS.ProcessEnv }) => {
    spawned.env = options.env;
    const child = Object.assign(new EventEmitter(), { pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function privateDirectory(path: string, mode = 0o700): string {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
  return realpathSync(path);
}

function d1Fixture(t: TestContext, runRootName: string, runRootMode = 0o700) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'd1-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const orchestrator = privateDirectory(join(base, 'orchestrator'));
  mkdirSync(join(orchestrator, 'conf'));
  const product = join(base, 'product');
  writeFileSync(join(orchestrator, 'conf/projects.json'), JSON.stringify({ version: 1, profiles: { local: { production: 'main', environments: { runtime: 'main' } } }, projects: {
    raf: { profile: 'local', path: product, environments: { runtime: 'main' }, branchPaths: { main: product, hotfix: workspace } },
  } }));
  writeFileSync(join(orchestrator, 'conf/raf.json'), JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
  const qaHome = privateDirectory(join(base, 'qa'));
  const runRoot = privateDirectory(join(base, runRootName), runRootMode);
  const cwd = join(base, 'ws/worker');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'vitest.config.ts'), 'export default {};\n');
  const stateContext = resolveStateContext({ orchestratorRoot: orchestrator, modulePath: join(workspace, 'src/test-run-runtime.ts'),
    homeDirectory: qaHome, operatingSystemHome: join(base, 'operational'), environment: { HOME: qaHome, RAF_QA_HOME: qaHome }, entryPoint: 'cli' });
  const config = fixtureConfig();
  config.projects.etchly = { profiles: { [profileId]: {
    testKind: 'integration', cwd: 'worker', executable: process.execPath,
    argv: ['vitest.mjs', 'run', '--configLoader', 'runner', '--project', 'worker-d1-integration'],
    exactIds: 'vitest-test-name', resultAdapter: 'vitest-events', integrationFiles: [testFile],
    environment: { isolatedHome: true, stateOrigin: true }, checks: [],
  } as never }, groups: {} };
  const flow = readFileSync(new URL('../../conf/flow.json', import.meta.url));
  const ports = createTestRunPorts(config, stateContext, () => { throw new Error('D1 spawn test must not open state'); }, {},
    { flow, testRuns: Buffer.alloc(0), projects: Buffer.alloc(0) });
  const command = (environment: TestRunCommand['environment']): TestRunCommand => ({
    executable: process.execPath, argv: ['vitest.mjs', 'run', 'src/d1-private-tmpdir.test.ts', '--configLoader', 'runner'],
    cwd, shell: false, environment: { HOME: qaHome, ...environment },
  });
  return { ports, command, runRoot, qaHome, planned: { project: 'etchly', profileId } as never };
}

test('2.10 local D1 accepts a suitable private TMPDIR longer than 50 bytes', async t => {
  const spawned: { env?: NodeJS.ProcessEnv } = {};
  fakeChild(t, spawned);
  const fixture = d1Fixture(t, 'private-run-root-with-a-name-longer-than-fifty-bytes');
  assert.ok(Buffer.byteLength(resolve(fixture.runRoot, 'tmp')) > 50);

  await fixture.ports.spawn(fixture.command({ TMPDIR: fixture.runRoot }), () => {}, fixture.planned);

  assert.equal(spawned.env?.TMPDIR, join(fixture.runRoot, 'tmp'));
  assert.equal(spawned.env?.HOME, fixture.qaHome);
  assert.ok(existsSync(join(fixture.runRoot, 'tmp')));
});

test('2.10 local D1 still refuses a TMPDIR that is not private', async t => {
  const spawned: { env?: NodeJS.ProcessEnv } = {};
  fakeChild(t, spawned);
  const fixture = d1Fixture(t, 'shared-run-root-with-a-name-longer-than-fifty-bytes', 0o755);

  await assert.rejects(fixture.ports.spawn(fixture.command({ TMPDIR: fixture.runRoot }), () => {}, fixture.planned), { code: 'ENVIRONMENT_INVALID' });
  assert.equal(spawned.env, undefined);
});

test('2.10 local D1 still reports setup failure without a reserved run TMPDIR', async t => {
  const spawned: { env?: NodeJS.ProcessEnv } = {};
  fakeChild(t, spawned);
  const fixture = d1Fixture(t, 'run-root');

  await assert.rejects(fixture.ports.spawn(fixture.command({}), () => {}, fixture.planned), { code: 'ENVIRONMENT_INVALID' });
  assert.equal(spawned.env, undefined);
});
