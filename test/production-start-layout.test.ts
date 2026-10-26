import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import type { MainLayoutStartOptions } from '../src/main-layout.ts';
import type { ProductionStoreOptions } from '../src/main-production-store.ts';
import type { ProductionStartLayoutOptions } from '../src/production-start-layout.ts';
import type { BackgroundRuntimeDependencies } from '../src/background-runtime.ts';

const root = '/unit/production-start/orchestrator';
const home = '/unit/production-start/home';
const generation = `${root}/.git/modules/raf/raf-hotfix/generations/pinned/raf-main`;
const fixtureKey = Symbol.for('raf.production-start-layout.unit');
const prepareUrl = new URL('../src/production-start-layout.ts?start-unit', import.meta.url).href;
const serviceUrl = new URL('../src/service-entry.ts?start-layout-unit', import.meta.url).href;
const bridge = 'const f = () => globalThis[Symbol.for("raf.production-start-layout.unit")];';
const doubles: Record<string, string> = {
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
test.after(() => hooks.deregister());

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

test('service commands leave layout preparation to the service process', async t => {
  const f = fixture(t);
  const handlers = service().handlers;
  await handlers['service start']({});
  assert.deepEqual(f.startCalls, []);
  assert.equal(f.events.filter(event => event === 'release').length, 1);
  f.events.length = 0;
  await handlers['service status']({});
  await handlers['service stop']({});
  assert.deepEqual(f.startCalls, []);
  assert.ok(!f.events.includes('pin'));
});
