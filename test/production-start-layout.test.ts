import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MainLayoutStartOptions } from '../src/main-layout.ts';
import type { ProductionStoreOptions } from '../src/main-production-store.ts';
import type { ProductionStartLayoutOptions } from '../src/production-start-layout.ts';
import type { BackgroundRuntimeDependencies } from '../src/background-runtime.ts';
import { prepareLegacyLiveProjects, prepareLiveProjects, prepareLiveMainInvocation, prepareLiveMainAvailability, prepareFailedNativeClose, prepareLiveReleaseCandidate, copyLiveReleaseArtifacts, archiveFailedLiveReport, describeFailedLiveAttempt, liveControlLabel } from '../scripts/qa-main-symlink-fixture.ts';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import { CatalogGenerator } from '../src/catalog-generator.ts';
import { productionBindings } from '../src/production-bindings.ts';

const root = '/unit/production-start/orchestrator';
const home = '/unit/production-start/home';
const generation = `${root}/.git/modules/raf/raf-hotfix/generations/pinned/raf-main`;
const fixtureKey = Symbol.for('raf.production-start-layout.unit');
const prepareUrl = new URL('../src/production-start-layout.ts?start-unit', import.meta.url).href;
const serviceUrl = new URL('../src/service-entry.ts?start-layout-unit', import.meta.url).href;
const qaFixtureUrl = new URL('./production-qa-fixture.ts?start-layout-unit', import.meta.url).href;
const bridge = 'const f = () => globalThis[Symbol.for("raf.production-start-layout.unit")];';
const doubles: Record<string, string> = {
  'qa-fs': `${bridge}
    export const readFileSync = path => String(path).endsWith('/conf/projects.json') ? JSON.stringify({projects:f().projects}) : '';
    export const cpSync = () => {}; export const mkdirSync = () => {};
    export const mkdtempSync = prefix => prefix + 'unit'; export const renameSync = () => {};
    export const rmSync = () => {}; export const existsSync = () => false; export const appendFileSync = () => {};`,
  'qa-process': `export const spawnSync = () => ({status:0,stdout:'/unit/production-start/exclude',stderr:''});`,
  'qa-entry': 'export const runProductionCli = async () => 0;',
  fs: `${bridge} export * from 'node:fs'; import { promises as real } from 'node:fs';
    export const promises = { ...real, readFile: (...args) => f().readFile(...args) };`,
  promises: `${bridge} export * from 'node:fs/promises'; export const readFile = (...args) => f().readFile(...args);`,
  'main-production-store.ts': `${bridge} export const ensureProductionMainStore = options => f().ensureStore(options);`,
  'main-layout.ts': `${bridge} export const ensureMainLayoutForStart = options => f().ensureLayout(options);`,
  'production-start-layout.ts': `${bridge} export const prepareMainLayoutForProductionStart = options => f().prepareStart(options);`,
  'background-runtime.ts': `${bridge} export const createBackgroundRuntime = (options, deps) => f().background(options, deps); export const runServiceHost = () => { throw new Error('Unexpected service host'); };`,
  'state-migration-guard.ts': `export const productionStateContext = () => ({mode:'production'});
    export const stateContextEnvironment = (_context, env) => env;
    export const stateFailure = (_code, reason) => new Error(reason); export const verifyStateModule = () => {};`,
  'workspace-routing.ts': `${bridge} export const resolveWorkspaceRoute = (...args) => f().route(...args);`,
  'os-runtime.ts': 'export const createWorkspacePorts = () => ({});',
  'hotfix-activation.ts': `${bridge} export const acquireHotfixReader = (...args) => f().reader(...args);`,
  'hotfix-origin.ts': 'export const hotfixModuleOrigin = () => null;',
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === qaFixtureUrl) {
      if (specifier === '../src/production-start-layout.ts') return { url: prepareUrl, shortCircuit: true };
      const key = specifier === 'node:fs' ? 'qa-fs' : specifier === 'node:child_process' ? 'qa-process'
        : specifier === '../src/main-production-store.ts' ? 'main-production-store.ts'
        : specifier === new URL(`${root}/raf-develop/src/production-entry.ts`, 'file:').href ? 'qa-entry' : undefined;
      if (key) return { url: `start-layout-unit:${key}`, shortCircuit: true };
    }
    if (context.parentURL === prepareUrl || context.parentURL === serviceUrl) {
      const key = specifier === 'node:fs' ? 'fs' : specifier === 'node:fs/promises' ? 'promises' : specifier.replace(/^\.\//, '');
      if (doubles[key]) return { url: `start-layout-unit:${key}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('start-layout-unit:')) return { format: 'module', source: doubles[url.slice('start-layout-unit:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { prepareMainLayoutForProductionStart } = await import(prepareUrl) as typeof import('../src/production-start-layout.ts');
const { createServiceHandlers } = await import(serviceUrl) as typeof import('../src/service-entry.ts');
const { prepareProductionQaFixture } = await import(qaFixtureUrl) as typeof import('./production-qa-fixture.ts');
test.after(() => hooks.deregister());

test('native actual-start fixture: configured catalog examples remain valid on the isolated stand', () => {
  const config = (name: string) => JSON.parse(readFileSync(new URL(`../../conf/${name}`, import.meta.url), 'utf8'));
  const projects = config('projects.json');
  const original = structuredClone(projects);
  const isolated = prepareLiveProjects(projects);
  assert.doesNotThrow(() => new CatalogGenerator().compile({
    constants: config('raf-constants.json'), models: config('models.json'), projects: isolated,
  }, productionBindings()));
  assert.deepEqual(projects, original, 'stand setup must not mutate the source configuration');
});

test('native actual-start fixture: initial production registration uses the ordinary legacy main layout', () => {
  const config = (name: string) => JSON.parse(readFileSync(new URL(`../../conf/${name}`, import.meta.url), 'utf8'));
  const projects = config('projects.json');
  const original = structuredClone(projects);
  const legacy = prepareLegacyLiveProjects(projects);
  assert.equal(legacy.projects.raf.mainCopies, undefined, 'the clean first start must register the existing ordinary main before conversion');
  assert.equal(legacy.projects.raf.path, 'raf-main');
  assert.deepEqual(legacy.projects.raf.branchPaths, { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' });
  assert.doesNotThrow(() => new CatalogGenerator().compile({
    constants: config('raf-constants.json'), models: config('models.json'), projects: legacy,
  }, productionBindings()));
  const conversion = prepareLiveProjects(legacy);
  assert.deepEqual(conversion.projects.raf.mainCopies, ['raf-main-a', 'raf-main-b']);
  assert.deepEqual(projects, original);
});

function fixture(t: TestContext, copies = false) {
  const projects = {
    raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' },
      ...(copies ? { mainCopies: ['raf-main-a', 'raf-main-b'] } : {}) },
  };
  const events: string[] = [];
  const storeCalls: ProductionStoreOptions[] = [];
  const layoutCalls: MainLayoutStartOptions[] = [];
  const startCalls: ProductionStartLayoutOptions[] = [];
  const f = {
    projects, events, storeCalls, layoutCalls, startCalls,
    alreadyReady: false,
    storeFailure: undefined as Error | undefined,
    startFailure: undefined as Error | undefined,
    startGate: undefined as Promise<void> | undefined,
    layoutGate: undefined as Promise<void> | undefined,
    async readFile(path: unknown) {
      assert.equal(String(path), `${root}/conf/projects.json`);
      events.push('configuration');
      return JSON.stringify({ projects: f.projects });
    },
    async ensureStore(options: ProductionStoreOptions) {
      events.push('store'); storeCalls.push(options);
      assert.equal(options.root, root);
      if (f.storeFailure) throw f.storeFailure;
      await options.onCheckpoint?.('store-registered');
      return { source: `${root}/.git/modules/raf`, production: `${root}/.git/modules/raf/raf-hotfix/main.git`, control: `${root}/.git/modules/raf/raf-hotfix`, split: true };
    },
    async ensureLayout(options: MainLayoutStartOptions) {
      events.push('layout'); layoutCalls.push(options);
      await f.layoutGate;
      events.push('layout:complete');
      return { status: 'converted', activePath: `${root}/raf-main-a`, inactivePath: `${root}/raf-main-b` };
    },
    async prepareStart(options: ProductionStartLayoutOptions) {
      events.push('prepare:start'); startCalls.push(options);
      await f.startGate;
      if (f.startFailure) throw f.startFailure;
      events.push('prepare:complete');
    },
    async route() {
      events.push('route');
      return { ok: true, project: 'raf', branch: 'main', cwd: `${root}/raf-main` };
    },
    async reader() {
      events.push('pin');
      return { generationRoot: generation, release: async () => { events.push('release'); } };
    },
    background(_options: unknown, deps: BackgroundRuntimeDependencies) {
      const start = async () => {
        events.push('background:start');
        const mainPath = f.alreadyReady ? generation : await deps.resolveMainPath();
        events.push('background:ready');
        return { exitCode: 0, state: 'ready', serviceEpoch: 'same-generation', resourceWaitReady: true, mainPath };
      };
      return { start, ensureReady: start, status: async () => ({ exitCode: 0, state: 'ready' }), stop: async () => ({ exitCode: 0, state: 'stopped' }) };
    },
  };
  const previous = (globalThis as Record<symbol, unknown>)[fixtureKey];
  (globalThis as Record<symbol, unknown>)[fixtureKey] = f;
  t.after(() => { (globalThis as Record<symbol, unknown>)[fixtureKey] = previous; });
  return f;
}

function service() {
  return createServiceHandlers({ orchestratorRoot: root, homeDirectory: home,
    service: { entryRelativePath: 'bin/service.ts', readinessTimeoutMs: 1000 } });
}

test('start: ordinary main without mainCopies splits production Git before dependent work', async t => {
  const f = fixture(t);
  await prepareMainLayoutForProductionStart({ orchestratorRoot: root });
  assert.equal(f.storeCalls.length, 1, 'legacy main still requires the protected production store');
  assert.equal(f.layoutCalls.length, 0, 'missing mainCopies must not invent occupied target paths');
});

test('start: configured copies run controlled layout conversion with current project configuration', async t => {
  const f = fixture(t, true);
  await prepareMainLayoutForProductionStart({ orchestratorRoot: root });
  assert.equal(f.layoutCalls.length, 1);
  assert.equal(f.layoutCalls[0].root, root);
  assert.deepEqual(f.layoutCalls[0].projects, f.projects);
  assert.ok(f.events.indexOf('configuration') < f.events.indexOf('layout'));
});

test('start: writer barrier refusal propagates and prevents dependent layout conversion', async t => {
  const f = fixture(t, true);
  f.storeFailure = new Error('Production Git store refused: writer barrier busy; existing lock retained');
  await assert.rejects(prepareMainLayoutForProductionStart({ orchestratorRoot: root }), error => error === f.storeFailure);
  assert.equal(f.layoutCalls.length, 0);
});

test('start: delegates store checkpoints to recoverable store conversion', async t => {
  const f = fixture(t);
  const checkpoints: string[] = [];
  await prepareMainLayoutForProductionStart({ orchestratorRoot: root,
    onStoreCheckpoint: checkpoint => { checkpoints.push(checkpoint); } });
  assert.deepEqual(checkpoints, ['store-registered']);
  assert.equal(f.storeCalls.length, 1);
});

test('start: configured conversion receives the publication provider and layout checkpoints', async t => {
  const f = fixture(t, true);
  const publicationProvider = { assertSupported: async () => {}, publish: async () => {} };
  const onLayoutCheckpoint: MainLayoutStartOptions['onCheckpoint'] = async () => {};
  await prepareMainLayoutForProductionStart({ orchestratorRoot: root, publicationProvider, onLayoutCheckpoint });
  assert.equal(f.layoutCalls[0]?.publicationProvider, publicationProvider);
  assert.equal(f.layoutCalls[0]?.onCheckpoint, onLayoutCheckpoint);
});

test('service start: layout preparation completes before route resolution and generation pinning', async t => {
  const f = fixture(t);
  const result = await service().handlers['service start']({}) as { mainPath: string };
  assert.equal(f.startCalls.length, 1, 'production service start must invoke controlled layout preparation');
  assert.equal(f.startCalls[0].orchestratorRoot, root);
  assert.ok(f.events.indexOf('prepare:complete') < f.events.indexOf('route'));
  assert.ok(f.events.indexOf('prepare:complete') < f.events.indexOf('pin'));
  assert.equal(result.mainPath, generation, 'the ready service retains the admitted generation');
  assert.equal(f.events.filter(event => event === 'release').length, 1);
});

test('service start: unresolved layout preparation cannot admit a generation reader', async t => {
  const f = fixture(t);
  let release!: () => void;
  f.startGate = new Promise<void>(resolve => { release = resolve; });
  const pending = service().handlers['service start']({});
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.startCalls.length, 1);
    assert.ok(!f.events.includes('route'));
    assert.ok(!f.events.includes('pin'));
    assert.ok(!f.events.includes('background:ready'));
  } finally { release(); await pending; }
});

test('service start: failed split blocks launch without bypassing the admission guard', async t => {
  const f = fixture(t);
  f.startFailure = new Error('Production Git store refused: foreign Git pointer; recovery retained');
  await assert.rejects(service().handlers['service start']({}), /foreign Git pointer|recovery retained/);
  assert.ok(!f.events.includes('pin'));
  assert.ok(!f.events.includes('background:ready'));
});

test('resource readiness: implicit service start uses the same layout preparation barrier', async t => {
  const f = fixture(t);
  const endpoint = await service().ensureResourceReady();
  assert.equal(f.startCalls.length, 1);
  assert.ok(f.events.indexOf('prepare:complete') < f.events.indexOf('pin'));
  assert.equal(endpoint.serviceEpoch, 'same-generation');
});

test('service start: an already ready background service cannot bypass layout preparation', async t => {
  const f = fixture(t);
  f.alreadyReady = true;
  await service().handlers['service start']({});
  assert.equal(f.startCalls.length, 1, 'the readiness fast path must not skip the initial protected-store conversion');
  assert.ok(f.events.indexOf('prepare:complete') < f.events.indexOf('background:ready'));
});

test('service status and stop do not initiate layout mutation', async t => {
  const f = fixture(t);
  const handlers = service().handlers;
  await handlers['service status']({});
  await handlers['service stop']({});
  assert.deepEqual(f.startCalls, []);
  assert.ok(!f.events.includes('pin'));
});

test('production QA fixture: configured main copies are ready before the entry callback', async t => {
  const f = fixture(t, true);
  const cli = await prepareProductionQaFixture(t, { root, home }, async codeRoot => {
    assert.equal(codeRoot, `${root}/raf-develop`);
    assert.equal(f.storeCalls.length, 1, 'the protected production store must still be prepared');
    assert.equal(f.layoutCalls.length, 1, 'configured mainCopies require layout conversion before loading production code');
    assert.deepEqual(f.layoutCalls[0].projects, f.projects);
    assert.ok(f.events.indexOf('store') < f.events.indexOf('layout'));
    assert.ok(f.events.includes('layout:complete'));
  });
  assert.equal(typeof cli, 'function');
});

test('production QA fixture: real configured layout retains registered develop and hotfix worktrees', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'raf-start-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const actualRoot = join(directory, 'root'), actualHome = join(directory, 'home');
  mkdirSync(join(actualRoot, 'conf'), { recursive: true });
  mkdirSync(actualHome);
  cpSync(new URL('../../conf/projects.json', import.meta.url), join(actualRoot, 'conf/projects.json'));
  const projects = JSON.parse(readFileSync(join(actualRoot, 'conf/projects.json'), 'utf8')).projects;
  assert.equal(projects.raf.mainCopies.length, 2, 'exercise the deployed configured layout');
  const realFixture = await import('./production-qa-fixture.ts');
  const callbackReached = new Error('registered real layout reached entry boundary');
  await assert.rejects(realFixture.prepareProductionQaFixture(t, { root: actualRoot, home: actualHome }, async () => {
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const source = git(join(actualRoot, projects.raf.branchPaths.develop), 'rev-parse', '--path-format=absolute', '--git-common-dir');
    for (const branch of ['develop', 'hotfix']) {
      const cwd = join(actualRoot, projects.raf.branchPaths[branch]);
      assert.equal(git(cwd, 'symbolic-ref', '--short', 'HEAD'), branch);
      assert.equal(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'), source);
      assert.ok(git(cwd, 'worktree', 'list', '--porcelain').includes(`worktree ${cwd}\n`));
    }
    assert.equal(realpathSync(join(actualRoot, projects.raf.path)), join(actualRoot, projects.raf.mainCopies[0]));
    assert.notEqual(git(join(actualRoot, projects.raf.path), 'rev-parse', '--path-format=absolute', '--git-common-dir'), source);
    throw callbackReached;
  }), error => error === callbackReached);
});

test('production QA fixture: pending layout conversion blocks entry preparation', async t => {
  const f = fixture(t, true);
  let release!: () => void;
  f.layoutGate = new Promise<void>(resolve => { release = resolve; });
  let entryPrepared = false;
  const pending = prepareProductionQaFixture(t, { root, home }, async () => { entryPrepared = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.layoutCalls.length, 1, 'fixture must enter the configured layout conversion');
    assert.equal(entryPrepared, false, 'production entry cannot observe an unfinished layout');
  } finally { release(); await pending; }
  assert.equal(entryPrepared, true);
});

test('production QA fixture: store refusal prevents entry preparation', async t => {
  const f = fixture(t, true);
  f.storeFailure = new Error('Production Git store refused: writer barrier busy');
  let entryPrepared = false;
  await assert.rejects(prepareProductionQaFixture(t, { root, home }, async () => { entryPrepared = true; }),
    error => error === f.storeFailure);
  assert.equal(entryPrepared, false);
  assert.equal(f.layoutCalls.length, 0);
});

test('native main fixture: actual Claude invocation retains external auth selectors without substituting a stdin receiver', () => {
  const config = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const protocol = config.runnerProtocols.find((p: any) => p.runner === 'claude');
  const selectors = { CODEX_HOME: '/host/provider-codex', CLAUDE_CONFIG_DIR: '/host/provider-claude' };
  const before = structuredClone({ protocol, selectors });
  const id = '8d180acd-e68c-4b55-8f88-9fd0b7142afe';
  const invocation = prepareLiveMainInvocation(protocol, selectors, id);
  assert.equal(invocation.executable, protocol.executable, 'main must run the actual configured Claude CLI');
  assert.deepEqual(invocation.args.slice(0, protocol.baseArgs.length), protocol.baseArgs);
  assert.ok(invocation.args.includes(id), 'native identity must be assigned, then confirmed through /status');
  assert.deepEqual(invocation.env, selectors, 'existing selectors are passed through without reading or copying authentication');
  assert.deepEqual({ protocol, selectors }, before);
  assert.throws(() => prepareLiveMainInvocation(protocol, { CODEX_HOME: selectors.CODEX_HOME }, id), /CLAUDE_CONFIG_DIR/);
  assert.throws(() => prepareLiveMainInvocation(protocol, { ...selectors, CLAUDE_CONFIG_DIR: 'relative' }, id), /absolute|CLAUDE_CONFIG_DIR/);
});

test('native main fixture: a different installed version warns without blocking, while broken binaries still refuse', async () => {
  const protocol = { runner: 'claude', executable: 'claude', version: '2.1.308' };
  const before = structuredClone(protocol);
  const probe = (stdout: string, exitCode = 0, executable = true) => prepareLiveMainAvailability(protocol, {
    env: { PATH: '/provider/bin' }, ports: { isExecutableFile: async () => executable },
    execute: async command => {
      assert.equal(command.executable, '/provider/bin/claude');
      assert.deepEqual(command.args, ['--version']);
      return { exitCode, stdout, stderr: '' };
    },
  });
  const installed = await probe('2.1.310 (Claude Code)\n');
  assert.equal(installed.available, true);
  assert.equal(installed.version, '2.1.310');
  assert.deepEqual(installed.warnings, ['версія 2.1.310 не збігається з перевіреною 2.1.308, протокол не перевірено']);
  assert.deepEqual((await probe('2.1.308 (Claude Code)\n')).warnings, []);
  assert.deepEqual(protocol, before, 'the verified protocol snapshot remains unchanged');
  await assert.rejects(probe('2.1.308 (Claude Code)\n', 1), /повернув код 1/);
  await assert.rejects(probe('not-a-version'), /не вдалося визначити/);
  await assert.rejects(probe('', 0, false), /не знайдено/);
});

test('native main fixture: an unset Claude config selector retains the host HOME only for native invocation', () => {
  const protocol = { executable: 'claude', baseArgs: ['--ax-screen-reader'], sessionIdFlag: '--session-id' };
  const selectors = { CODEX_HOME: '/host/provider-codex', HOME: '/host/native-user' };
  const before = structuredClone(selectors);
  const id = '8d180acd-e68c-4b55-8f88-9fd0b7142afe';
  const invocation = prepareLiveMainInvocation(protocol, selectors, id);
  assert.deepEqual(invocation.env, selectors, 'native Claude must use existing host defaults without inventing CLAUDE_CONFIG_DIR');
  assert.equal(Object.hasOwn(invocation.env, 'CLAUDE_CONFIG_DIR'), false);
  assert.equal(invocation.executable, 'claude');
  assert.ok(invocation.args.includes(id));
  assert.deepEqual(selectors, before, 'the caller environment and isolated coordinator HOME are not mutated');
  assert.throws(() => prepareLiveMainInvocation(protocol, { CODEX_HOME: selectors.CODEX_HOME, HOME: 'relative' }, id), /HOME|absolute/);
  assert.throws(() => prepareLiveMainInvocation(protocol, { CODEX_HOME: selectors.CODEX_HOME }, id), /HOME|CLAUDE_CONFIG_DIR/);
});

test('native continuation fixture: closing only the known failed attempt passes the actual CLI force/reason contract', async () => {
  const conf = new URL('../../conf/', import.meta.url);
  const constants = JSON.parse(readFileSync(new URL('raf-constants.json', conf), 'utf8'));
  const catalog = compileCatalog(constants, JSON.parse(readFileSync(new URL('models.json', conf), 'utf8')),
    constants.commands.map((command: any) => command.path.join(' ')), JSON.parse(readFileSync(new URL('projects.json', conf), 'utf8')));
  const failed = { addressId: 'sym72-native', runId: '566b52f3-80eb-4193-8140-e38e2bcb64e1', result: { status: 'failed' } };
  const calls: Record<string, unknown>[] = [];
  const result = await execute(prepareFailedNativeClose(failed), catalog, { 'agent close': async params => { calls.push(params); return { closed: true }; } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].force, true);
  assert.equal(calls[0].id, failed.addressId);
  assert.match(String(calls[0].reason), /566b52f3/);
  assert.throws(() => prepareFailedNativeClose({ ...failed, result: { status: 'succeeded' } }));
  assert.throws(() => prepareFailedNativeClose({ ...failed, runId: 'another-run' }));
  assert.throws(() => prepareFailedNativeClose({ ...failed, addressId: 'sym72-native-2' }));
});


test('native release fixture: current layout catalog is built before sealing and remains identical at the build gate', async t => {
  const stand = mkdtempSync(join(tmpdir(), 'sym72-catalog-seal-'));
  t.after(() => rmSync(stand, { recursive: true, force: true }));
  const confDirectory = join(stand, 'conf'), outputPath = join(stand, 'raf-develop/dist/catalog.json');
  cpSync(new URL('../../conf/', import.meta.url), confDirectory, { recursive: true });
  const projectPath = join(confDirectory, 'projects.json');
  const projects = JSON.parse(readFileSync(projectPath, 'utf8'));
  const generator = new CatalogGenerator();
  const build = () => { generator.build({ confDirectory, outputPath, bindings: productionBindings() }); };
  writeFileSync(projectPath, JSON.stringify(prepareLegacyLiveProjects(projects)));
  build();
  assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).projects.projects.raf.mainCopies, undefined);
  writeFileSync(projectPath, JSON.stringify(prepareLiveProjects(projects)));
  const inactive = join(stand, 'raf-main-b');
  mkdirSync(join(inactive, 'dist'), { recursive: true });
  writeFileSync(join(inactive, 'dist/obsolete.json'), 'stale previous build');
  const sealed = await prepareLiveReleaseCandidate(build, async () => {
    copyLiveReleaseArtifacts(join(stand, 'raf-develop'), inactive);
    return readFileSync(join(inactive, 'dist/catalog.json'));
  });
  assert.deepEqual(JSON.parse(sealed.toString()).projects.projects.raf.mainCopies, ['raf-main-a', 'raf-main-b'],
    'sealing must receive the artifact for the current layout, rather than the legacy catalog copied at initial start');
  build();
  assert.deepEqual(readFileSync(outputPath), sealed, 'the gate must rebuild the exact presealed bytes without changing its fingerprint');
  assert.deepEqual(readFileSync(join(inactive, 'dist/catalog.json')), sealed, 'inactive slot carries the exact built artifact');
  assert.throws(() => readFileSync(join(inactive, 'dist/obsolete.json')), { code: 'ENOENT' });
  let prepared = false;
  await assert.rejects(prepareLiveReleaseCandidate(() => { throw new Error('source build refused'); }, async () => { prepared = true; }), /source build refused/);
  assert.equal(prepared, false, 'failed build must stop before prepare/sealing');
  assert.throws(() => copyLiveReleaseArtifacts(join(stand, 'raf-develop'), join(stand, 'raf-develop')));
});


test('native continuation fixture: accepted failed report survives close removing its temporary run directory', async t => {
  const stand = mkdtempSync(join(tmpdir(), 'sym72-closed-report-'));
  t.after(() => rmSync(stand, { recursive: true, force: true }));
  const runDirectory = join(stand, 'run');
  mkdirSync(runDirectory);
  const report = join(runDirectory, 'actor.json'), archived = join(stand, 'original-failed-report.json');
  const bytes = Buffer.from(JSON.stringify({ status: 'failed', answer: 'Original accepted failure' }) + '\n');
  writeFileSync(report, bytes);
  let closed = false;
  const saved = await archiveFailedLiveReport(report, archived, async () => {
    assert.deepEqual(readFileSync(archived), bytes, 'archive must exist before the destructive close');
    rmSync(runDirectory, { recursive: true });
    closed = true;
  });
  assert.equal(closed, true);
  assert.equal(saved.archivePath, archived);
  assert.match(saved.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(archived), bytes, 'verification after close uses the preserved immutable evidence');
});


test('native continuation fixture: finished failed session metadata does not require removed launch context', () => {
  const active = { runId: '566b52f3-80eb-4193-8140-e38e2bcb64e1', result: { status: 'failed' }, launchContext: { reportPath: '/isolated/run/original.json' } };
  assert.deepEqual(describeFailedLiveAttempt(active), { runId: active.runId, status: 'failed', report: active.launchContext.reportPath });
  const finished = { runId: active.runId, state: 'finished', result: { status: 'failed', response: '', proof: null } };
  assert.deepEqual(describeFailedLiveAttempt(finished), { runId: active.runId, status: 'failed' }, 'compacted sessions keep identity/result, not a fabricated report location');
  assert.throws(() => describeFailedLiveAttempt({ ...finished, result: { status: 'succeeded' } }));
});


test('native continuation fixture: distinct commands retain distinct coordinator result paths under one continuation prefix', t => {
  const stand = mkdtempSync(join(tmpdir(), 'sym72-control-label-'));
  t.after(() => rmSync(stand, { recursive: true, force: true }));
  const seen = new Set<string>();
  for (const label of ['runner-list', 'runner-limits', 'launch', 'repeat-start']) {
    const key = liveControlLabel('instruction-resume-', label);
    assert.equal(seen.has(key), false, 'A previous result must not collide with a different command');
    seen.add(key);
    writeFileSync(join(stand, key + '.json'), JSON.stringify({ label, cliExitCode: 0 }));
    assert.equal(JSON.parse(readFileSync(join(stand, key + '.json'), 'utf8')).label, label);
    assert.equal(key, 'instruction-resume-' + label);
  }
  assert.equal(liveControlLabel('', 'runner-list'), 'runner-list');
});
