import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { compileCatalog, type CompiledCommand } from '../src/catalog.ts';
import { commandFailure, execute, type ExecutionResult, type Handler } from '../src/cli.ts';
import { createAppRuntime, type RuntimeContext, type AppRuntimeDependencies } from '../src/app-runtime.ts';
import type { RafCostRow } from '../src/raf-cost-profile.ts';
import type { StateStore } from '../src/state-store.ts';

const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../../conf/${name}.json`, import.meta.url), 'utf8'));
const constants = read('raf-constants');
const models = read('models');
const settings = read('raf');
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), read('projects'));
const runtimeCommands = catalog.commands.filter(command => command.handlerName !== 'help');
const root = '/unit/timing-orchestrator';
const home = '/unit/timing-home';
const artifact = `${root}/catalog.json`;
const fixtureKey = Symbol.for('raf.runtime-command-timing.fixture');
type Contribution = [command: string, durationMs: number, alpha: number];

function operationError() {
  return commandFailure({ code: 'TIMING_UNIT_OPERATION_FAILED', message: 'Controlled runtime failure', stage: 'unit-handler',
    source: 'timing-unit-port', sourceCode: 'EUNIT', reason: 'Controlled runtime failure', received: null, expected: null,
    found: null, completed: ['admitted'], pending: ['operation'], retrySafe: false, remediation: ['Repair unit operation'] });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, command: string, outcome: 'success' | 'failure' = 'success') {
  let mono = 5;
  let user = 0;
  let system = 0;
  let gate: ReturnType<typeof deferred> | undefined;
  const entered = deferred();
  const contributions: Contribution[] = [];
  const events: string[] = [];
  const rows = new Map<string, RafCostRow>();
  const result = { canonical: command, completed: true };
  const original = operationError();
  const store = {
    initializeRunners() {},
    close() { events.push('close'); },
    recordCommandDuration(...args: Contribution) { events.push('ema'); contributions.push(args); },
    costProfileRepository: {
      update(key: RafCostRow, change: (previous: RafCostRow | undefined) => RafCostRow) {
        const id = JSON.stringify([key.scope, key.command, key.stage, key.executor]);
        rows.set(id, change(rows.get(id)));
      },
      readRows: () => [...rows.values()],
    },
  } as unknown as StateStore;
  const operation: Handler = async () => {
    events.push(`handler:${command}`);
    entered.resolve();
    if (gate) await gate.promise;
    mono += 17; user += 3000; system += 1000;
    if (outcome === 'failure') throw original;
    return result;
  };
  const handlers = Object.fromEntries(runtimeCommands.map(value => [value.handlerName, operation]));
  const openStore = () => { events.push('sqlite'); mono += 13; return store; };
  const f = {
    store, operation, handlers, contributions, events, rows, result, original,
    now: () => mono,
    block() { gate = deferred(); return { entered: entered.promise, release: gate.resolve }; },
    backgroundWork() { mono += 3_600_000; },
    openStore,
    createApp(context: RuntimeContext, dependencies: AppRuntimeDependencies) {
      if (!f.useRealApp) return { handlers, close: async () => {} };
      return createAppRuntime(context, { ...dependencies, commandState: undefined, additionalHandlers: undefined,
        loadConfiguration: async () => ({ catalog, models, commandTiming: settings.commandTiming }),
        openStore: async () => openStore(), createServices: async () => ({ control: { ps: operation } }) as never });
    },
    useRealApp: false,
    async runTests(argv: string[]) {
      const response = await execute(['test', 'run', ...argv], catalog, { 'test run': async () => {
        openStore();
        try { await operation({}); } catch (error) { if (error !== original) throw error; }
        return { status: outcome === 'success' ? 'passed' : 'assertions-failed', exitCode: outcome === 'success' ? 0 : 1 };
      } });
      return response.exitCode === 0 ? { ...response, exitCode: outcome === 'success' ? 0 : 1 } : response;
    },
  };
  const previous = (globalThis as Record<symbol, unknown>)[fixtureKey];
  (globalThis as Record<symbol, unknown>)[fixtureKey] = f;
  const realRead = fs.readFileSync;
  const realPath = fs.realpathSync;
  t.mock.method(fs, 'readFileSync', (path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    const name = String(path);
    if (name === artifact) { events.push('catalog'); mono += 2; return JSON.stringify(catalog); }
    if (name.startsWith(`${root}/conf/`)) {
      events.push('config'); mono += 3;
      const file = name.slice(name.lastIndexOf('/') + 1);
      return JSON.stringify(file === 'models.json' ? models : file === 'raf-constants.json' ? constants : settings);
    }
    return Reflect.apply(realRead, fs, [path, ...args]);
  });
  t.mock.method(fs, 'realpathSync', (path: fs.PathLike, ...args: unknown[]) => String(path) === root ? root : Reflect.apply(realPath, fs, [path, ...args]));
  t.mock.method(performance, 'now', () => mono);
  t.mock.method(process, 'cpuUsage', () => ({ user, system }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); (globalThis as Record<symbol, unknown>)[fixtureKey] = previous; });
  return f;
}

const bridge = 'const f = () => globalThis[Symbol.for("raf.runtime-command-timing.fixture")];';
const doubles: Record<string, string> = {
  'app-runtime.ts': `${bridge} export const createAppRuntime = (...args) => f().createApp(...args); export const runnerLimitsHandler = () => f().operation;`,
  'state-store.ts': `${bridge} export const openStateStore = () => f().openStore();`,
  'production-runtime.ts': 'export const rafSystemCaller = {}; export const createProductionServices = async () => { throw new Error("Unexpected real services"); };',
  'service-entry.ts': `${bridge} export const createServiceHandlers = () => ({ handlers: f().handlers });`,
  'bug-cli.ts': `${bridge} export const createBugHandlers = () => f().handlers;`,
  'bug-production.ts': 'export const createProductionBugPorts = () => ({});',
  'test-run-runtime.ts': `${bridge} export const runConfiguredTestRun = argv => f().runTests(argv);`,
  'resource-wait-command.ts': `${bridge} export const waitForResources = () => f().operation({});`,
  'state-migration-guard.ts': `export const productionStateContext = () => ({ statePath: '${home}/.raf/state.sqlite', tmpRoot: '${home}/.raf/tmp' });`,
  'stored-launch-queue-events.ts': 'export const storedLaunchQueueIdentity = () => ({}); export const validateStoredQueueId = async () => {};',
  'os-runtime.ts': 'export const readMachineBootIdentity = async () => ({});',
  'event-catalog.ts': 'export const loadEventCatalog = () => ({});',
  'reminder-cli.ts': 'export const settleCommandState = async () => {};',
};
const entryUrl = new URL('../src/production-entry.ts?timing-coverage-unit', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === entryUrl && specifier.startsWith('./') && doubles[specifier.slice(2)]) {
      return { url: `timing-unit:${specifier.slice(2)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('timing-unit:')) return { format: 'module', source: doubles[url.slice('timing-unit:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { runProductionCli } = await import(entryUrl) as typeof import('../src/production-entry.ts');
test.after(() => hooks.deregister());

function argv(command: CompiledCommand): string[] {
  const literals: Record<string, string> = { id: 'unit-agent', to: 'unit-recipient', text: 'unit payload',
    type: 'implement', phase: 'implement',
    features: 'profile-raf-performance', tasks: 'profile-raf-performance:3.3', group: 'profile-raf-performance/timing-coverage',
    at: '2026-10-25T10:00:00.000Z', bug: 'projects/raf/bug#1', 'text-file': '/unit/comment.txt', status: 'open', attachment: 'unit-attachment' };
  return [...command.path, ...command.parameters.filter(parameter => parameter.required).flatMap(parameter => [parameter.option,
    parameter.values?.find(value => value.id === literals[parameter.name])?.id ??
    parameter.values?.find(value => value.launchableByRaf !== false)?.id ?? literals[parameter.name] ?? 'unit-value'])];
}

function invoke(args: string[], f: ReturnType<typeof fixture>) {
  return runProductionCli(args, { orchestratorRoot: root, homeDirectory: home, artifactPath: artifact, now: f.now,
    costStartedAt: { monotonicMs: 0, utc: '2026-10-25T00:00:00.000Z', cpu: { user: 0, system: 0 } } });
}

function assertOne(f: ReturnType<typeof fixture>, command: string) {
  assert.deepEqual(f.contributions, [[command, f.now(), settings.commandTiming.emaAlpha]],
    'One completed canonical EMA contribution must cover CLI startup, configuration, SQLite and handler');
}

for (const command of runtimeCommands) {
  for (const outcome of ['success', 'failure'] as const) test(`timing dispatch: ${command.handlerName} ${outcome}`, async t => {
    const f = fixture(t, command.handlerName, outcome);
    const result: ExecutionResult = await invoke(argv(command), f);
    assert.equal(result.exitCode === 0, outcome === 'success', result.stderr);
    assert.ok(f.events.includes(`handler:${command.handlerName}`), 'Reach the production-selected leaf, not an early parser/config failure');
    if (outcome === 'failure') {
      if (command.handlerName === 'test run') assert.deepEqual(JSON.parse(result.stdout), { status: 'assertions-failed', exitCode: 1 });
      else {
        assert.equal(JSON.parse(result.stderr).code, 'TIMING_UNIT_OPERATION_FAILED');
        assert.equal(JSON.parse(result.stderr).details.sourceCode, 'EUNIT');
      }
    }
    if (command.metadata.recordDuration === false) assert.deepEqual(f.contributions, []);
    else assertOne(f, command.handlerName);
  });
  test(`timing dispatch: ${command.handlerName} help and parser rejection stay lazy`, async t => {
    const f = fixture(t, command.handlerName);
    assert.equal((await invoke([...command.path, '--help'], f)).exitCode, 0);
    assert.notEqual((await invoke([...argv(command), '--unknown-unit-option'], f)).exitCode, 0);
    assert.deepEqual(f.events.filter(event => event !== 'catalog'), []);
    assert.deepEqual(f.contributions, []);
  });
}

for (const outcome of ['success', 'failure'] as const) test(`timing dispatch: real inner app-runtime and production finalization together contribute once on ${outcome}`, async t => {
  const f = fixture(t, 'agent ps', outcome);
  f.useRealApp = true;
  const result = await invoke(['agent', 'ps'], f);
  assert.equal(result.exitCode === 0, outcome === 'success', result.stderr);
  assertOne(f, 'agent ps');
});

test('timing dispatch: cancelled production resource wait never contributes EMA', async t => {
  const f = fixture(t, 'resource wait');
  f.operation = async () => { throw Object.assign(new Error('Unit cancellation'), { name: 'AbortError' }); };
  const command = runtimeCommands.find(value => value.handlerName === 'resource wait')!;
  assert.notEqual((await invoke(argv(command), f)).exitCode, 0);
  assert.deepEqual(f.contributions, []);
});

for (const name of ['agent run', 'service start', 'test run']) test(`timing dispatch: ${name} waits for its result, excludes subsequent process lifetime and payload CPU`, async t => {
  const f = fixture(t, name);
  const gate = f.block();
  const command = runtimeCommands.find(value => value.handlerName === name)!;
  const pending = invoke(argv(command), f);
  try {
    await Promise.race([gate.entered, pending.then(result => assert.fail(`Production returned before the unit leaf: ${JSON.stringify(result)}`))]);
    assert.deepEqual(f.contributions, [], 'An unfinished runtime invocation has no completed EMA sample');
  } finally { gate.release(); }
  const result = await pending;
  assert.equal(result.exitCode, 0, result.stderr);
  assertOne(f, name);
  const snapshot = structuredClone(f.contributions);
  const profile = [...f.rows.values()].filter(row => row.scope === 'command' && row.command === name);
  assert.ok(profile.length > 0, 'The production path publishes its own completed cost profile');
  assert.equal(profile.reduce((sum, row) => sum + (row.cpuUserTotalMs ?? 0), 0), 3);
  assert.equal(profile.reduce((sum, row) => sum + (row.cpuSystemTotalMs ?? 0), 0), 1);
  f.backgroundWork();
  assert.deepEqual(f.contributions, snapshot, 'Agent/service lifetime and test payload cannot create a second command sample');
});
