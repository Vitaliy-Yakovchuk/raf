import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AdapterCommand } from '../src/agent-adapters.ts';

const fixtureUrl = new URL('./production-fixture.ts?l6-cleanup-unit', import.meta.url).href;
const key = Symbol.for('raf.l6.production-fixture-cleanup');
const globals = globalThis as Record<symbol, unknown>;
const initial = globals[key];
const configs: Record<string, unknown> = {
  'raf-constants.json': { commands: [], agentPhases: [], eventIdKinds: [], events: [] },
  'models.json': {},
  'projects.json': { projects: { raf: { path: 'raf-main', branchPaths: { develop: 'raf-develop', main: 'raf-main', hotfix: 'raf-hotfix' } } } },
  'raf.json': { state: {}, commandTiming: {}, service: {} },
  'flow.json': { resources: { normal: {}, hotfix: {}, home: {} } },
  'test-runs.json': { projects: {} },
};

type Cleanup = () => unknown | Promise<unknown>;
type Store = { path: string; closed: boolean; closeCalls: number; initializeRunners(): void; close(): void };

function lifecycle() {
  const actions: Cleanup[] = [];
  return {
    context: { after(action: Cleanup) { actions.push(action); } } as unknown as TestContext,
    async cleanup(): Promise<unknown[]> {
      const failures: unknown[] = [];
      for (const action of actions) {
        try { await action(); } catch (error) { failures.push(error); }
      }
      return failures;
    },
  };
}

function harness(t?: TestContext) {
  const previous = globals[key];
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const sockets = new Set<string>();
  const stores: Store[] = [];
  const roots: string[] = [];
  const removed: string[] = [];
  const commands: AdapterCommand[] = [];
  const fault = new Error('injected lifecycle failure');
  const f = {
    files, directories, sockets, stores, roots, removed, commands, fault,
    mkdirFailure: false, lookupFailure: '', storeFailure: false, initializeFailure: false,
    readFailure: '', closeFailure: false, commandFailure: '', qaFailure: false,
    async mkdtemp(prefix: string) {
      const root = `${prefix}${roots.length + 1}`;
      roots.push(root);
      directories.add(root);
      return root;
    },
    async mkdir(path: string) {
      if (f.mkdirFailure) throw fault;
      directories.add(path);
    },
    async readFile(path: string | URL) {
      const address = String(path);
      if (address === f.readFailure) throw fault;
      if (files.has(address)) return files.get(address)!;
      if (path instanceof URL && basename(path.pathname) in configs) return JSON.stringify(configs[basename(path.pathname)]);
      throw Object.assign(new Error(`No fixture file: ${address}`), { code: 'ENOENT' });
    },
    async writeFile(path: string, content: string) { files.set(path, String(content)); },
    async rename(source: string, destination: string) { files.set(destination, files.get(source)!); files.delete(source); },
    async rm(path: string, options: { recursive?: boolean; force?: boolean }) {
      assert.equal(options.recursive, true);
      assert.equal(options.force, true);
      removed.push(path);
      for (const entry of directories) if (entry === path || entry.startsWith(path + '/')) directories.delete(entry);
      for (const entry of files.keys()) if (entry === path || entry.startsWith(path + '/')) files.delete(entry);
    },
    spawnSync(executable: string, args: string[]) {
      if (executable === 'which') {
        const name = args[0];
        return { status: f.lookupFailure === name ? 1 : 0, stdout: `/unit/bin/${name}\n`, stderr: f.lookupFailure === name ? fault.message : '' };
      }
      if (executable === '/unit/bin/openspec' && args[0] === '--version') return { status: 0, stdout: '1.14.3\n', stderr: '' };
      assert.equal(executable, 'git', 'unit fixture must never spawn a real executable');
      return { status: 0, stdout: '', stderr: '' };
    },
    openStateStore(path: string) {
      if (f.storeFailure) throw fault;
      const store: Store = {
        path, closed: false, closeCalls: 0,
        initializeRunners() { if (f.initializeFailure) throw fault; },
        close() { store.closeCalls++; store.closed = true; if (f.closeFailure) throw fault; },
      };
      stores.push(store);
      return store;
    },
    async executeCommand(command: AdapterCommand) {
      commands.push(structuredClone(command));
      assert.equal(command.executable, '/unit/bin/tmux');
      assert.equal(command.args[0], '-S');
      assert.equal(command.args[2], 'kill-server');
      const socket = command.args[1];
      if (socket === f.commandFailure) throw fault;
      sockets.delete(socket);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async prepareProductionQaFixture() { if (f.qaFailure) throw fault; },
    async createProductionServices() { return { assignment: { validate: async () => ({ ok: true, snapshot: { root: roots.at(-1), changes: [] } }) } }; },
  };
  globals[key] = f;
  t?.after(() => { globals[key] = previous; });
  return f;
}

harness();
const bridge = 'const f = () => globalThis[Symbol.for("raf.l6.production-fixture-cleanup")];';
const doubles: Record<string, string> = {
  'node:fs/promises': `${bridge} ${['mkdtemp', 'mkdir', 'readFile', 'writeFile', 'rename', 'rm'].map(name => `export const ${name} = (...args) => f().${name}(...args);`).join('\n')}`,
  'node:os': 'export const tmpdir = () => "/unit/l6";',
  'node:child_process': `${bridge} export const spawnSync = (...args) => f().spawnSync(...args);`,
  '../src/production-runtime.ts': `${bridge} export const createProductionServices = (...args) => f().createProductionServices(...args);`,
  '../src/catalog.ts': 'export const compileCatalog = () => ({ commands: [] });',
  '../src/os-runtime.ts': `${bridge} export const executeCommand = (...args) => f().executeCommand(...args);`,
  '../src/state-store.ts': `${bridge} export const openStateStore = (...args) => f().openStateStore(...args);`,
  '../src/task-context.ts': 'export const bindWorkspaceBoundaries = () => [];',
  './production-qa-fixture.ts': `${bridge} export const prepareProductionQaFixture = (...args) => f().prepareProductionQaFixture(...args);`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === fixtureUrl) {
      if (doubles[specifier]) return { url: `l6-fixture-unit:${specifier}`, shortCircuit: true };
      if (specifier.startsWith('file:///unit/l6/') && specifier.endsWith('/src/production-runtime.ts')) {
        return { url: 'l6-fixture-unit:../src/production-runtime.ts', shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('l6-fixture-unit:')) return { format: 'module', source: doubles[url.slice('l6-fixture-unit:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { fixture } = await import(fixtureUrl) as typeof import('./production-fixture.ts');
test.after(() => { hooks.deregister(); globals[key] = initial; });

function assertRemoved(f: ReturnType<typeof harness>, root = f.roots[0]): void {
  assert.ok(f.removed.includes(root), 'L.6: cleanup must remove its temporary base even when setup or teardown fails');
  assert.equal([...f.directories, ...f.files.keys()].some(path => path === root || path.startsWith(root + '/')), false, 'L.6: no owned temporary directory or file remains');
}

for (const phase of ['mkdir', 'tmux lookup', 'openspec lookup', 'state open'] as const) {
  test(`L.6: setup failure at ${phase} still removes the allocated base`, async t => {
    const f = harness(t);
    const owner = lifecycle();
    if (phase === 'mkdir') f.mkdirFailure = true;
    if (phase === 'tmux lookup') f.lookupFailure = 'tmux';
    if (phase === 'openspec lookup') f.lookupFailure = 'openspec';
    if (phase === 'state open') f.storeFailure = true;
    await assert.rejects(fixture(owner.context, { externalHome: phase === 'mkdir' }), /injected lifecycle failure/);
    await owner.cleanup();
    assertRemoved(f);
  });
}

test('L.6: failure after opening state closes it and removes the base', async t => {
  const f = harness(t);
  f.initializeFailure = true;
  const owner = lifecycle();
  await assert.rejects(fixture(owner.context), error => error === f.fault);
  await owner.cleanup();
  assert.equal(f.stores[0].closeCalls, 1);
  assertRemoved(f);
});

for (const productionQa of [false, true]) {
  test(`L.6: failed test body cleans both owned tmux servers and the base (productionQa=${productionQa})`, async t => {
    const f = harness(t);
    const owner = lifecycle();
    const prepared = await fixture(owner.context, { productionQa, externalHome: true });
    const ownSockets = [prepared.socket, join(prepared.tmpRoot, 'tmux', 'server.sock')];
    ownSockets.forEach(socket => f.sockets.add(socket));
    const foreignRoot = '/unit/l6/raf-prod-foreign';
    const foreignSocket = join(foreignRoot, 'tmux.sock');
    f.directories.add(foreignRoot);
    f.sockets.add(foreignSocket);
    await assert.rejects(async () => {
      try { throw f.fault; } finally { assert.deepEqual(await owner.cleanup(), []); }
    }, error => error === f.fault);
    assert.deepEqual([...f.sockets], [foreignSocket], 'L.6: cleanup kills only its own servers');
    assert.deepEqual(f.commands.map(command => command.args[1]), ownSockets);
    assert.equal(f.stores[0].closed, true);
    assertRemoved(f);
    assert.ok(f.directories.has(foreignRoot));
  });
}

test('L.6: QA preparation failure still disposes opened resources', async t => {
  const f = harness(t);
  f.qaFailure = true;
  const owner = lifecycle();
  await assert.rejects(fixture(owner.context, { productionQa: true }), error => error === f.fault);
  await owner.cleanup();
  assert.equal(f.stores[0].closed, true);
  assertRemoved(f);
});

test('L.6: unreadable tracked PID file does not bypass state close or base removal', async t => {
  const f = harness(t);
  const owner = lifecycle();
  const prepared = await fixture(owner.context);
  const pidFile = join(prepared.tmpRoot, 'worker.pid');
  prepared.trackPidFile(pidFile);
  f.readFailure = pidFile;
  await owner.cleanup();
  assert.equal(f.stores[0].closeCalls, 1, 'L.6: a PID file failure must not bypass closing SQLite');
  assertRemoved(f);
});

test('L.6: failed owned-process observation does not bypass base removal', async t => {
  const f = harness(t);
  const owner = lifecycle();
  const prepared = await fixture(owner.context);
  const pid = 999_101;
  prepared.trackProcess(pid);
  t.mock.method(process, 'kill', (observed: number, signal: number | string) => {
    assert.equal(observed, pid, 'only the registered fixture process may be observed');
    assert.equal(signal, 0);
    throw Object.assign(new Error('injected process observation failure'), { code: 'EPERM' });
  });
  await owner.cleanup();
  assert.equal(f.stores[0].closeCalls, 1);
  assertRemoved(f);
});

test('L.6: state close failure does not bypass base removal', async t => {
  const f = harness(t);
  const owner = lifecycle();
  await fixture(owner.context);
  f.closeFailure = true;
  await owner.cleanup();
  assert.equal(f.stores[0].closeCalls, 1);
  assertRemoved(f);
});

test('L.6: missing PID file is harmless and an exited tracked process leaves no residue', async t => {
  const f = harness(t);
  const owner = lifecycle();
  const prepared = await fixture(owner.context);
  prepared.trackPidFile(join(prepared.tmpRoot, 'never-started.pid'));
  const pid = 999_102;
  const pidFile = join(prepared.tmpRoot, 'exited.pid');
  f.files.set(pidFile, String(pid));
  prepared.trackPidFile(pidFile);
  t.mock.method(process, 'kill', (observed: number, signal: number | string) => {
    assert.equal(observed, pid);
    assert.equal(signal, 0);
    throw Object.assign(new Error('exited'), { code: 'ESRCH' });
  });
  assert.deepEqual(await owner.cleanup(), []);
  assertRemoved(f);
});

test('L.6: independently owned fixtures leave no servers or directories after the group', async t => {
  const f = harness(t);
  const owners = [lifecycle(), lifecycle()];
  const first = await fixture(owners[0].context);
  const second = await fixture(owners[1].context, { productionQa: true });
  for (const prepared of [first, second]) {
    f.sockets.add(prepared.socket);
    f.sockets.add(join(prepared.tmpRoot, 'tmux', 'server.sock'));
  }
  await owners[0].cleanup();
  assertRemoved(f, f.roots[0]);
  assert.ok(f.directories.has(f.roots[1]), 'cleanup of the first fixture preserves the second fixture');
  assert.equal(f.sockets.size, 2);
  await owners[1].cleanup();
  assertRemoved(f, f.roots[1]);
  assert.equal(f.sockets.size, 0, 'L.6: no owned tmux server remains after the group');
  assert.equal(f.directories.size, 0, 'L.6: no owned temporary root remains after the group');
  assert.ok(f.stores.every(store => store.closed));
});
