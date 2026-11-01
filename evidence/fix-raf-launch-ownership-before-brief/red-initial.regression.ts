import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';
import type { AdapterCommand, AdapterCommandResult } from '../src/agent-adapters.ts';
import { failureContext } from '../src/cli-contract.ts';
import type { LaunchWrapperPorts, LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { ProcessIdentity, SessionRecord, SessionTransaction } from '../src/session-state.ts';
import type { StateStore } from '../src/state-store.ts';

const key = Symbol.for('raf.launch-ownership-before-brief.unit');
const runtimeUrl = new URL('../src/production-runtime.ts?launch-ownership-before-brief-unit', import.meta.url).href;
const bridge = 'const f = () => globalThis[Symbol.for("raf.launch-ownership-before-brief.unit")];';
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
    export const observeKnownProcesses = async identities => identities.map(identity => f().observe(identity));
    export const observeProcessSnapshot = async () => identities => identities.map(identity => ({ state: 'alive', identity, observedAt: new Date().toISOString() }));
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
    export const startTaskReservations = async (_ports, input) => { f().gated.push(input.agent); throw f().boundary; };`,
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
    if (context.parentURL === runtimeUrl && doubles[specifier]) return { url: `launch-ownership-before-brief-unit:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('launch-ownership-before-brief-unit:')) return { format: 'module', source: doubles[url.slice('launch-ownership-before-brief-unit:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { runProductionWorker } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
const configured = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')) as { runnerProtocols: ProtocolSettings[] };
test.after(() => hooks.deregister());

async function fixture(t: TestContext, observations: ('unknown' | 'alive' | 'exited')[]) {
  const root = await mkdtemp(join(tmpdir(), 'raf-agy-session-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace');
  const home = join(root, 'home');
  const context: RuntimeContext = {
    orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'),
    statePath: join(home, 'state.sqlite'), tmpRoot: join(home, 'tmp'),
    mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  };
  const settings = structuredClone(configured.runnerProtocols.find(row => row.runner === 'agy')!);
  assert.equal(settings?.native?.identity.source, 'session_start');
  settings.timeouts = { startupMs: 1000, transitionMs: 1000, overallMs: 3000, pollMs: 1 };
  const assignment = { root, changes: [{ id: 'fix-raf-agy-launch', items: [{ id: '1.1', description: 'agy session start' }] }] };
  const runId = 'worker-agy';
  const request: LaunchWrapperRequest = {
    runId, address: 'agent-agy', tmuxSession: 'unit-agy', assignment,
    cwd, statePath: context.statePath, tmpRoot: context.tmpRoot,
    selection: { runner: 'agy', model: 'unit-model', effort: 'high' }, brief: 'unit-only brief', readinessTimeoutMs: 1000,
  };
  const projectHooks = join(cwd, '.agents', 'hooks.json');
  const projectHooksBody = '{"existing":"do-not-rewrite"}\n';
  await mkdir(join(cwd, '.agents'), { recursive: true });
  await mkdir(join(context.tmpRoot, runId), { recursive: true });
  await writeFile(projectHooks, projectHooksBody);
  const reserved: SessionRecord = {
    runId, addressId: request.address, revision: 0, state: 'reserved',
    activity: { type: 'spec', phase: 'spec', project: 'raf', features: ['fix-raf-agy-launch'], cwd: request.cwd },
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
  const manifest = { version: 1, context, configuration, runnerPath: '/unit/bin/agy' };
  const boundary = new Error('unit cutoff after durable worker start');
  const privateHooks: { directory: string; body: string }[] = [];
  const f = {
    request, context, settings, sessions, boundary,
    gated: [] as ProcessIdentity[], observations: [...observations], observed: [] as string[],
    observe(identity: ProcessIdentity) {
      const state = f.observations.shift() ?? 'alive';
      f.observed.push(state);
      const observedAt = new Date().toISOString();
      return state === 'alive' ? { state, identity, observedAt }
        : state === 'unknown' ? { state, observedAt, error: 'PID present in targeted stat but absent from process observation' }
        : { state, observedAt, exitCode: null, evidence: 'PID absent before targeted observation' };
    },
    stateContext: { ...context, homeDirectory: home, mode: 'test' },
    store: { sessionRepository: { transaction: (operation: (value: SessionTransaction) => unknown) => operation(tx) }, close: () => {} } as unknown as StateStore,
    lease: { owner: { runId, fence: 'unit-fence' } },
    calls: [] as AdapterCommand[], handshake: undefined as unknown,
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
      return '? for shortcuts\n>';
    },
    async execute(command: AdapterCommand): Promise<AdapterCommandResult> {
      f.calls.push(structuredClone(command));
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
      if (command.executable === 'ps') return ok(`${process.pid} 1 Sun Oct 25 12:00:00 2026 unit-main\n4001 1 Sun Oct 25 12:00:00 2026 unit-shell\n4002 4001 Sun Oct 25 12:00:00 2026 /unit/bin/agy\n`);
      assert.equal(command.executable, 'tmux', 'no real CLI, shell, git or external service may execute');
      const args = [...command.args];
      if (args[0] === '-u') args.shift();
      assert.equal(args.shift(), '-S', 'every tmux command must select its socket');
      assert.equal(args.shift(), f.expectedSocket, 'every tmux command must use the launch socket');
      const action = args[0];
      if (action === 'new-session') {
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] !== '--add-dir') continue;
          const directory = args[index + 1];
          if (!directory) continue;
          try {
            privateHooks.push({ directory, body: await readFile(join(directory, '.agents', 'hooks.json'), 'utf8') });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        return ok();
      }
      if (action === 'display-message') {
        if (args.at(-1) === '#{pane_pid}') return ok('4001\n');
        if (args.at(-1) === '#{pane_id}') return ok(`${f.pane}\n`);
        if (args.at(-1) === '#{pane_dead}|#{pane_dead_status}') return ok('0|\n');
      }
      if (action === 'capture-pane') return ok(f.screen());
      if (action === 'load-buffer' || action === 'paste-buffer' || action === 'send-keys') return ok();
      throw new Error(`Unexpected unit tmux command: ${JSON.stringify(args)}`);
    },
    async drive(input: LaunchWrapperRequest, ports: LaunchWrapperPorts) {
      await ports.transport.startWithoutInput(input, reserved.launchContext!.reportPath);
      const ready = await ports.transport.waitReady(input.readinessTimeoutMs);
      assert.equal(ready.state, 'ready', JSON.stringify(ready));
      const owner = await ports.transport.ownership();
      assert.equal(owner.state, 'owned', JSON.stringify(owner));
      if (owner.state !== 'owned') throw new Error('unit runner must be owned');
      await ports.transport.deliver(input.brief);
      throw boundary;
    },
  };
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[key];
  globals[key] = f;
  t.after(() => { globals[key] = previous; });
  t.mock.method(process.stderr, 'write', () => true);
  const failure = await runProductionWorker({ protocolSettings: [settings] }).then(() => undefined, error => error);
  return { f, failure, boundary };
}

test('deliverInitialBrief rechecks a live launched runner after an incomplete ownership observation before the durable start gate', async t => {
  const { f, failure, boundary } = await fixture(t, ['unknown', 'alive']);
  assert.equal(failure, boundary, `worker must reach the durable start gate after confirming ownership: ${String(failure)}`);
  assert.deepEqual(f.observed, ['unknown', 'alive', 'alive']);
  assert.equal(f.gated.length, 1);
  assert.equal(f.gated[0].pid, 4002);
  assert.equal(f.gated[0].evidence.tmuxPane, '%27');
  assert.equal(f.gated[0].evidence.tmuxSocket, f.expectedSocket);
  assert.equal(f.calls.some(command => command.args.includes('paste-buffer')), false, 'no brief before the durable gate');
});

test('deliverInitialBrief rejects real process loss with PROCESS_IDENTITY_UNAVAILABLE before the durable start gate', async t => {
  const { f, failure } = await fixture(t, ['exited']);
  assert.equal(failureContext(failure)?.code, 'PROCESS_IDENTITY_UNAVAILABLE', String(failure));
  assert.equal(f.gated.length, 0);
  assert.equal(f.calls.some(command => command.args.includes('paste-buffer')), false);
});

test('deliverInitialBrief rejects process loss while rechecking incomplete ownership', async t => {
  const { f, failure } = await fixture(t, ['unknown', 'exited']);
  assert.equal(failureContext(failure)?.code, 'PROCESS_IDENTITY_UNAVAILABLE', String(failure));
  assert.deepEqual(f.observed, ['unknown', 'exited']);
  assert.equal(f.gated.length, 0);
});
