import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';
import type { AdapterCommand, AdapterCommandResult } from '../src/agent-adapters.ts';
import type { LaunchWrapperPorts, LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { ProcessIdentity, SessionRecord, SessionTransaction } from '../src/session-state.ts';
import type { StateStore } from '../src/state-store.ts';

const key = Symbol.for('raf.worker-pane.unit');
const runtimeUrl = new URL('../src/production-runtime.ts?worker-pane-unit', import.meta.url).href;
const bridge = 'const f = () => globalThis[Symbol.for("raf.worker-pane.unit")];';
const real = (name: string) => JSON.stringify(new URL(`../src/${name}`, import.meta.url).href);
const doubles: Record<string, string> = {
  'node:fs': `${bridge} export * from 'node:fs'; import { promises as actual } from 'node:fs';
    export const promises = { ...actual,
      readFile: (...args) => f().readFile(...args), readlink: async () => 'unit-namespace',
      realpath: async path => path, mkdir: async () => {}, chmod: async () => {},
      lstat: async path => f().metadata(path), stat: async path => f().metadata(path),
    };`,
  './state-migration-guard.ts': `${bridge}
    export const productionStateContext = () => f().stateContext;
    export const stateContextEnvironment = (_context, env) => env;
    export const stateFailure = (_code, reason) => new Error(reason);
    export const verifyStateModule = () => {};`,
  './hotfix-activation.ts': `export * from ${real('hotfix-activation.ts')};
    export const retainHotfixGeneration = async () => ({ release: async () => {} });`,
  './state-store.ts': `${bridge} export * from ${real('state-store.ts')};
    export const openStateStore = () => f().store;`,
  './os-runtime.ts': `${bridge} export * from ${real('os-runtime.ts')};
    export const executeCommand = command => f().execute(command);
    export const observeProcesses = async identities => identities.map(identity => ({ state: 'alive', identity, observedAt: new Date().toISOString() }));
    export const readMachineBootIdentity = async () => ({ machineId: 'unit-machine', bootId: 'unit-boot' });`,
  './runner-availability.ts': `${bridge} export * from ${real('runner-availability.ts')};
    export const resolveRunnerExecutable = async runner => ({ status: 'resolved', path: '/unit/bin/' + runner });
    export const probeRunnerAvailability = async () => ({ available: true, version: f().settings.version });`,
  './launch-wrapper.ts': `${bridge} export * from ${real('launch-wrapper.ts')};
    export const consumeWrapperRequest = async () => ({ request: f().request, handshake: async handshake => { f().handshake = handshake; } });
    export const runLaunchWrapper = (request, ports) => f().drive(request, ports);`,
  './task-reservations.ts': `${bridge} export * from ${real('task-reservations.ts')};
    export const listTaskReservations = () => [{ lease: f().lease }];
    export const handoffTaskReservations = async (_ports, input) => input.lease;
    export const startTaskReservations = async (_ports, input) => input.lease;`,
  './task-context.ts': `export * from ${real('task-context.ts')};
    export const rafSubcommandsFor = () => null;`,
  './runner-protocols.ts': `export * from ${real('runner-protocols.ts')};
    export const nativeSandboxArgs = (_settings, args) => args;`,
  './codex-raf-command-access.ts': `export * from ${real('codex-raf-command-access.ts')};
    export const codexInvocationSandboxMode = () => null;
    export const prepareCodexRafCommandAccess = async ({ invocation }) => ({ invocation, cleanup: async () => {} });`,
  './resource-wait-identity.ts': `export * from ${real('resource-wait-identity.ts')};
    export const tryWaitLease = async () => ({ release: async () => {} });`,
  './agent-report.ts': `export * from ${real('agent-report.ts')};
    export const readPendingAgentReport = async () => null;`,
  './raf-cost-runtime.ts': `export const rafCostBoundary = () => ({});
    export class RafCostRuntime { install() {} stage() {} finish() {} }`,
  './health-cpu-runtime.ts': 'export const settleRuntimeHealthCpu = async () => {};',
  './event-catalog.ts': 'export const loadEventCatalog = () => ({ events: [] });',
  './reminder-cli.ts': `export * from ${real('reminder-cli.ts')}; export const settleCommandState = async () => {};`,
  './health-summary-runtime.ts': 'export const scheduleWorkerHealthSummary = () => async () => {};',
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && doubles[specifier]) return { url: `worker-pane-unit:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('worker-pane-unit:')) return { format: 'module', source: doubles[url.slice('worker-pane-unit:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { runProductionWorker, createProductionServices, rafSystemCaller } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
const configured = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')) as { runnerProtocols: ProtocolSettings[] };
test.after(() => hooks.deregister());

async function fixture(t: TestContext, runner: 'codex' | 'claude') {
  const root = '/unit/worker-pane';
  const context: RuntimeContext = {
    orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'),
    statePath: join(root, 'home/state.sqlite'), tmpRoot: join(root, 'home/tmp'),
    mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  };
  const settings = structuredClone(configured.runnerProtocols.find(row => row.runner === runner)!);
  assert.ok(settings?.native, `configured ${runner} native protocol is required`);
  assert.equal(settings.native.identity.source, runner === 'codex' ? 'status' : 'assigned');
  settings.timeouts = { startupMs: 1000, transitionMs: 1000, overallMs: 3000, pollMs: 1 };
  const assignment = { root, changes: [{ id: 'pane-fixture', items: [{ id: '1.1', description: 'unit pane identity' }] }] };
  const runId = `worker-${runner}`;
  const request: LaunchWrapperRequest = {
    runId, address: `agent-${runner}`, tmuxSession: `unit-${runner}`, assignment,
    cwd: join(root, 'raf-develop'), statePath: context.statePath, tmpRoot: context.tmpRoot,
    selection: { runner, model: 'unit-model', effort: 'high' }, brief: 'unit-only brief', readinessTimeoutMs: 1000,
  };
  const reserved: SessionRecord = {
    runId, addressId: request.address, revision: 0, state: 'reserved',
    activity: { type: 'spec', phase: 'spec', project: 'raf', features: ['pane-fixture'], cwd: request.cwd },
    launchContext: { assignment, selection: { ...request.selection, reason: 'unit only' }, briefPath: join(context.tmpRoot, runId, 'brief.txt'), reportPath: join(context.tmpRoot, runId, `${request.address}.json`) },
  };
  const sessions = new Map<string, SessionRecord>([[runId, reserved]]);
  const pending = new Map();
  const tx = {
    getSession: (id: string) => structuredClone(sessions.get(id)),
    listSessions: () => structuredClone([...sessions.values()]),
    putSession: (session: SessionRecord) => sessions.set(session.runId, structuredClone(session)),
    putPending: (intent: { id: string }) => pending.set(intent.id, intent),
    applyEffects: () => {},
  } as unknown as SessionTransaction;
  const configuration = { catalog: { commands: [], reportStatuses: [] } } as unknown as RuntimeConfiguration;
  const manifest = { version: 1, context, configuration, runnerPath: `/unit/bin/${runner}` };
  const boundary = new Error('unit cutoff after durable worker start');
  const f = {
    request, context, settings, sessions,
    stateContext: { ...context, homeDirectory: join(root, 'home'), mode: 'test' },
    store: { sessionRepository: { transaction: (operation: (value: SessionTransaction) => unknown) => operation(tx) }, close: () => {} } as unknown as StateStore,
    lease: { owner: { runId, fence: 'unit-fence' } },
    calls: [] as AdapterCommand[], handshake: undefined as unknown,
    nativeId: '11111111-1111-4111-8111-111111111111',
    busy: false, accepted: '', buffer: '', interrupted: false, statusVisible: false,
    expectedSocket: join(context.tmpRoot, 'tmux/server.sock'), pane: '%27',
    metadata(path: string) {
      if (path.endsWith('server.sock')) throw Object.assign(new Error('unit socket absent'), { code: 'ENOENT' });
      return { uid: process.getuid?.(), mode: 0o600, isFile: () => path.endsWith('.json'), isDirectory: () => !path.endsWith('.json') };
    },
    async readFile(path: string) {
      if (path === join(context.tmpRoot, runId, 'runtime.json')) return JSON.stringify(manifest);
      if (path === reserved.launchContext!.briefPath) return request.brief;
      if (path === join(context.confRoot, 'projects.json')) return JSON.stringify({ projects: { raf: {} } });
      if (path === '/proc/self/stat') return '1 (unit) R 0 0 0';
      throw Object.assign(new Error(`Unit file absent: ${path}`), { code: 'ENOENT' });
    },
    screen() {
      const identity = runner === 'codex' ? `Session: ${f.nativeId}` : `Session ID: ${f.nativeId}`;
      const composer = runner === 'codex' ? '› ' : '$ ';
      return `${f.statusVisible ? identity : ''}\n${settings.markers.ready![0]}\n${f.accepted}\n${f.busy ? '• Working (0s • esc to interrupt)\n' : ''}${composer}`;
    },
    async execute(command: AdapterCommand): Promise<AdapterCommandResult> {
      f.calls.push(structuredClone(command));
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
      if (command.executable === 'ps') return ok(`${process.pid} 1 Sun Oct 25 12:00:00 2026 unit-main\n4001 1 Sun Oct 25 12:00:00 2026 unit-shell\n4002 4001 Sun Oct 25 12:00:00 2026 /unit/bin/${runner}\n`);
      assert.equal(command.executable, 'tmux', 'no real CLI, shell, git or external service may execute');
      const args = [...command.args];
      if (args[0] === '-u') args.shift();
      assert.equal(args.shift(), '-S', 'every tmux command must select its socket');
      assert.equal(args.shift(), f.expectedSocket, 'every tmux command must use the launch socket');
      const action = args[0];
      if (action === 'new-session') {
        const flag = args.indexOf('--session-id');
        if (flag >= 0) f.nativeId = args[flag + 1];
        return ok();
      }
      if (action === 'display-message') {
        if (args.at(-1) === '#{pane_pid}') return ok('4001\n');
        if (args.at(-1) === '#{pane_id}') return ok(`${f.pane}\n`);
        if (args.at(-1) === '#{pane_dead}|#{pane_dead_status}') return ok('0|\n');
      }
      if (action === 'capture-pane') return ok(f.screen());
      if (action === 'load-buffer') { f.buffer = command.stdin!; return ok(); }
      if (action === 'paste-buffer') return ok();
      if (action === 'send-keys') {
        if (args.includes('/status')) f.statusVisible = true;
        if (args.at(-1) === 'Enter' && f.buffer) { f.accepted = f.buffer; f.buffer = ''; f.busy = true; }
        if (args.at(-1) === 'Escape') { f.busy = false; f.interrupted = true; }
        return ok();
      }
      throw new Error(`Unexpected unit tmux command: ${JSON.stringify(args)}`);
    },
    async drive(input: LaunchWrapperRequest, ports: LaunchWrapperPorts) {
      await ports.transport.startWithoutInput(input, reserved.launchContext!.reportPath);
      const ready = await ports.transport.waitReady(input.readinessTimeoutMs);
      assert.equal(ready.state, 'ready', JSON.stringify(ready));
      const owner = await ports.transport.ownership();
      assert.equal(owner.state, 'owned', JSON.stringify(owner));
      if (owner.state !== 'owned') throw new Error('unit runner must be owned');
      const handshake = { runId, address: input.address, reportPath: reserved.launchContext!.reportPath, identity: owner.identity };
      await ports.lifecycle.started(handshake);
      await ports.handshake(handshake);
      throw boundary;
    },
  };
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[key];
  globals[key] = f;
  t.after(() => { globals[key] = previous; });
  t.mock.method(process.stderr, 'write', () => true);
  const failure = await runProductionWorker({ protocolSettings: [settings] }).then(() => undefined, error => error);
  assert.equal(failure, boundary, `unit worker must reach its durable start boundary: ${String(failure)}`);
  assert.ok(f.handshake, 'public worker must publish the start handshake');
  assert.equal(sessions.get(runId)?.state, 'running');
  const mainIdentity: ProcessIdentity = { pid: process.pid, startedAt: '2026-10-25T12:00:00.000Z', runner: 'main', runnerSessionId: '%0', tmuxSession: 'main', evidence: { command: 'unit-main', tmuxSocket: f.expectedSocket, tmuxPane: '%0', machineId: 'unit-machine', bootId: 'unit-boot' } };
  sessions.set('unit-main', { runId: 'unit-main', addressId: 'main', revision: 0, state: 'running', process: mainIdentity });
  const services = await createProductionServices(f.store, configuration, context, { protocolSettings: [settings] });
  return { ...f, services, current: () => sessions.get(runId)!, startAction: () => { f.busy = true; }, isIdle: () => !f.busy };
}

for (const runner of ['codex', 'claude'] as const) {
  test(`worker ${runner}: durable process evidence records the launch tmux socket and pane`, async t => {
    const f = await fixture(t, runner);
    const evidence = f.current().process!.evidence;
    assert.deepEqual({ tmuxSocket: evidence.tmuxSocket, tmuxPane: evidence.tmuxPane }, { tmuxSocket: f.expectedSocket, tmuxPane: f.pane });
  });

  test(`worker ${runner}: agent message reaches the recorded pane and confirms native acceptance`, async t => {
    const f = await fixture(t, runner);
    const receipt = await f.services.control.message({ to: f.request.address, text: 'pane regression message' }, rafSystemCaller);
    assert.equal(receipt.accepted, true);
    assert.ok('receiptId' in receipt && receipt.receiptId);
    const load = f.calls.find(command => command.args.includes('load-buffer'));
    assert.equal(load?.stdin, '[raf] pane regression message');
    const paste = f.calls.find(command => command.args.includes('paste-buffer'));
    assert.equal(paste?.args.at(-1), f.pane);
    assert.equal(f.current().state, 'running', 'message must preserve the same running session');
  });

  test(`worker ${runner}: authorized interrupt reaches the recorded pane and confirms idle`, async t => {
    const f = await fixture(t, runner);
    f.startAction();
    await f.services.control.interrupt(f.request.address, {});
    const interrupt = f.calls.find(command => command.args.includes('send-keys') && command.args.at(-1) === 'Escape' && command.args.includes(f.pane));
    assert.ok(interrupt, 'interrupt must send Escape to the launched pane');
    assert.equal(f.isIdle(), true, 'native pane must confirm an idle composer');
    assert.equal(f.current().state, 'running', 'interrupt must preserve the running session');
    assert.equal(f.current().ownerAction, 'paused');
  });
}
