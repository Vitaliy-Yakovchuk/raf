import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as disk from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import type { TestContext } from 'node:test';
import type { CodexRafCommandAccessRequest, PreparedCodexRafCommandAccess } from '../../src/codex-raf-command-access.ts';
import type { LaunchWrapperPorts, LaunchWrapperRequest } from '../../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../../src/runner-protocols.ts';
import type { SessionRecord, SessionTransaction } from '../../src/session-state.ts';
import { parseSandboxCommand } from '../../src/sandbox-test-run.ts';

const key = Symbol.for('raf.z394.unit');
const runtimeUrl = new URL('../../src/production-runtime.ts?z394-unit', import.meta.url).href;
const accessUrl = new URL('../../src/codex-raf-command-access.ts?z394-unit', import.meta.url).href;
const launcherUrl = new URL('../../src/main-switch-agent-launcher.ts?z394-unit', import.meta.url).href;
const bridge = 'const f = () => globalThis[Symbol.for("raf.z394.unit")];';
const real = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);
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
  './hotfix-activation.ts': `${bridge} export * from ${real('hotfix-activation.ts')};
    export const retainHotfixGeneration = async () => ({ release: async () => {} }); export const acquireHotfixReader = async () => ({ generationRoot: f().generationRoot, release: async () => { f().generationReleased++; } });`,
  './state-store.ts': `${bridge} export * from ${real('state-store.ts')};
    export const openStateStore = (path, options) => { f().stateOpens.push({ path, options }); return f().store; };`,
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
  './task-context.ts': `${bridge} export * from ${real('task-context.ts')}; export const rafSubcommandsFor = () => ['agent ps', 'agent message', 'test run']; export const rafCommandFor = () => f().prefix;`,
  './runner-protocols.ts': `export * from ${real('runner-protocols.ts')};
    export const nativeSandboxArgs = (_settings, args) => args;`,
  './codex-raf-command-access.ts': `${bridge} export * from ${real('codex-raf-command-access.ts')};
    export const prepareCodexRafCommandAccess = request => f().prepare(request);`,
  './codex-sandbox.ts': `${bridge} export * from ${real('codex-sandbox.ts')};
    export const prepareCodexSandbox = async request => { f().sandbox = request; return { invocation: request.invocation, cleanup: async () => { f().sandboxCleaned++; } }; };`,
  './main-switch-agent-launcher.ts': `export * from ${real('main-switch-agent-launcher.ts')}; export const agentChannelReadOnlyPaths = async () => ['/unit/protected-main'];`,
  './resource-wait-identity.ts': `export * from ${real('resource-wait-identity.ts')};
    export const tryWaitLease = async () => ({ release: async () => {} });`,
  './agent-report.ts': `export * from ${real('agent-report.ts')};
    export const readPendingAgentReport = async () => null;`,
  './raf-cost-runtime.ts': `export const rafCostBoundary = () => ({});
    export class RafCostRuntime { install() {} stage() {} finish() {} }`,
  './health-cpu-runtime.ts': 'export const settleRuntimeHealthCpu = async () => {};',
  './event-catalog.ts': 'export const loadEventCatalog = () => ({ events: [] });',
  './flow-runtime.ts': `export * from ${real('flow-runtime.ts')}; export const flowEvidencePorts = () => ({});`,
  './reminder-cli.ts': `export * from ${real('reminder-cli.ts')}; export const settleCommandState = async () => {};`,
  './health-summary-runtime.ts': 'export const scheduleWorkerHealthSummary = () => async () => {};',
};
doubles['inspector'] = `${bridge} export const spawn = (...args) => f().inspect(...args);`;
doubles['host-process'] = `${bridge} export const spawn = (...args) => f().generationSpawn(...args);`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('#raf-z394-eval') && ['node:fs/promises', 'node:child_process'].includes(specifier)) return { url: `z394-unit:vm-${specifier}`, shortCircuit: true };
    if (context.parentURL === launcherUrl && specifier === 'node:child_process') return { url: 'z394-unit:host-process', shortCircuit: true };
    if (context.parentURL === launcherUrl && doubles[specifier]) return { url: `z394-unit:${specifier}`, shortCircuit: true };
    if (context.parentURL === accessUrl && specifier === 'node:child_process') return { url: 'z394-unit:inspector', shortCircuit: true };
    if (context.parentURL === runtimeUrl && doubles[specifier]) return { url: `z394-unit:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('z394-unit:')) return { format: 'module', source: doubles[url.slice('z394-unit:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
export const { runProductionWorker } = await import(runtimeUrl) as typeof import('../../src/production-runtime.ts');
const { runPublishedAgentChannel } = await import(launcherUrl) as typeof import('../../src/main-switch-agent-launcher.ts');
const { prepareCodexRafCommandAccess } = await import(accessUrl) as typeof import('../../src/codex-raf-command-access.ts');
const confRoot = new URL('../../../conf/', import.meta.url);
const configured = JSON.parse(await disk.readFile(new URL('raf.json', confRoot), 'utf8'));
const testConfig = await disk.readFile(new URL('test-runs.json', confRoot), 'utf8');
const flow = await disk.readFile(new URL('flow.json', confRoot), 'utf8');
export const timeoutMs: number = JSON.parse(flow).unitTests.timeoutMs;

export async function stateChannelFixture(t: TestContext) {
  const root = await disk.mkdtemp(join(tmpdir(), 'raf-z394-'));
  const context = { orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'), statePath: join(root, 'home/.raf/state.sqlite'), tmpRoot: join(root, 'home/.raf/tmp'), mode: 'test', commandStartedAtMs: 0 };
  const settings: ProtocolSettings = structuredClone(configured.runnerProtocols.find((row: ProtocolSettings) => row.runner === 'codex'));
  const assignment = { root, changes: [{ id: 'complete-raf-flow-contracts', items: [{ id: 'Z.394.1', description: 'state channel unit' }] }] };
  const request: LaunchWrapperRequest = { runId: 'unit-z394', address: 'z394-worker', tmuxSession: 'unit-z394', assignment, cwd: join(root, 'workspace'), statePath: context.statePath, tmpRoot: context.tmpRoot, selection: { runner: 'codex', model: 'unit-model', effort: 'high' }, brief: 'Z394 BRIEF MUST WAIT FOR CHANNEL', readinessTimeoutMs: settings.timeouts.startupMs };
  const runDirectory = join(context.tmpRoot, request.runId);
  await disk.mkdir(runDirectory, { recursive: true });
  const reserved: SessionRecord = { runId: request.runId, addressId: request.address, revision: 0, state: 'reserved', activity: { type: 'test-scaffold', phase: 'test-scaffold', project: 'raf', features: ['complete-raf-flow-contracts'], cwd: request.cwd }, launchContext: { assignment, selection: { ...request.selection, reason: 'unit' }, briefPath: join(runDirectory, 'brief.txt'), reportPath: join(runDirectory, request.address + '.json') } };
  const sessions = new Map([[request.runId, reserved]]);
  const tx = { getSession: (id: string) => structuredClone(sessions.get(id)), listSessions: () => structuredClone([...sessions.values()]), putSession: (value: SessionRecord) => sessions.set(value.runId, structuredClone(value)), applyEffects: () => {} } as unknown as SessionTransaction;
  const manifest = { version: 1, context, configuration: { catalog: { commands: [], reportStatuses: [] } }, runnerPath: '/unit/bin/codex' };
  const cutoff = new Error('unit cutoff after launch/channel assertions');
  const prepared: PreparedCodexRafCommandAccess[] = [];
  let activeScope: CodexRafCommandAccessRequest['scope'] | undefined;
  const f = {
    request, settings, prefix: `node ${new URL('../../bin/raf.ts', import.meta.url).pathname}`,
    stateContext: { ...context, homeDirectory: join(root, 'home') },
    store: { sessionRepository: { transaction: (operation: (value: SessionTransaction) => unknown) => operation(tx) }, close() {} },
    lease: { owner: { runId: request.runId, fence: 'unit' } },
    generationRoot: join(root, 'published-generation'), generationReleased: 0, generationSpawns: [] as any[], hostChild: undefined as any,
    stateOpens: [] as any[], prepareRequests: [] as CodexRafCommandAccessRequest[],
    calls: [] as any[], hostCalls: [] as any[], directDenials: [] as string[],
    sandbox: undefined as any, sandboxCleaned: 0, driveCount: 0,
    prepareFailure: undefined as Error | undefined,
    hostReply: { stdout: '{"hostOnly":true}\n', stderr: 'host diagnostic\n', code: 0 },
    async readFile(path: string) {
      if (path === join(runDirectory, 'runtime.json')) return JSON.stringify(manifest);
      if (path === reserved.launchContext!.briefPath) return request.brief;
      if (path === join(context.confRoot, 'projects.json')) return '{"projects":{"raf":{}}}';
      if (path === join(context.confRoot, 'test-runs.json')) return testConfig;
      if (path === join(context.confRoot, 'flow.json')) return flow;
      if (path === '/proc/self/stat') return '1 (unit) R 0 0 0';
      throw Object.assign(new Error('unit file absent: ' + path), { code: 'ENOENT' });
    },
    metadata(path: string) { if (path.endsWith('server.sock')) throw Object.assign(new Error('unit socket absent'), { code: 'ENOENT' }); return { uid: process.getuid?.(), mode: 0o600, isFile: () => path.endsWith('.json'), isDirectory: () => !path.endsWith('.json') }; },
    async execute(command: any) { f.calls.push(command); if (command.executable === 'ps') return { exitCode: 0, stdout: command.args.some((arg: string) => arg.includes('lstart')) ? `${process.pid} 1 Sun Oct 25 12:00:00 2026 unit-worker\n` : `${process.pid} 1\n`, stderr: '' }; if (command.executable !== 'tmux' || !command.args.includes('new-session')) throw new Error('unexpected OS operation'); return { exitCode: 0, stdout: '', stderr: '' }; },
    generationSpawn(executable: string, args: string[], options: any) {
      f.generationSpawns.push({ executable, args, options });
      const child = new EventEmitter() as any;
      setImmediate(() => { f.hostChild.stdout.end(f.hostReply.stdout); f.hostChild.stderr.end(f.hostReply.stderr); child.emit('close', f.hostReply.code); });
      return child;
    },
    inspect(_executable: string, args: string[]) {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      const hook = args.find(arg => arg.startsWith('hooks.PreToolUse='))!;
      const command = JSON.parse(hook.match(/command=("(?:\\.|[^"\\])*")/)![1]);
      const timeoutSec = Number(hook.match(/timeout=(\d+)/)![1]);
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        const input = JSON.parse(chunk.toString());
        if (input.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: input.id, result: input.id === 1 ? {} : { data: [{ hooks: [{ source: 'sessionFlags', eventName: 'preToolUse', command, key: 'unit-hook', currentHash: 'unit-hash', timeoutSec, async: false }] }] } }) + '\n'));
        done();
      } });
      return child;
    },
    async prepare(input: CodexRafCommandAccessRequest) {
      f.prepareRequests.push(structuredClone(input)); activeScope = input.scope;
      if (f.prepareFailure) throw f.prepareFailure;
      const result = await prepareCodexRafCommandAccess(input); prepared.push(result); return result;
    },
    async drive(_input: LaunchWrapperRequest, ports: LaunchWrapperPorts) { f.driveCount++; await f.assertions(ports); throw cutoff; },
    assertions: async (_ports: LaunchWrapperPorts) => {},
    async run(assertions?: (ports: LaunchWrapperPorts) => Promise<void>) {
      f.assertions = assertions ?? (async () => {});
      return runProductionWorker({ protocolSettings: [settings] }).then(() => undefined, error => { if (error === cutoff || error === f.prepareFailure) return error; if (error?.code === 'ERR_ASSERTION') throw error; throw Object.assign(new Error('Unit fixture boundary failure: ' + String(error?.message ?? error), { cause: error }), { diagnosticOrigin: 'fixture-setup' }); });
    },
    async evaluate(command: string, input = '', deliveryFailure = false) {
      const words = parseSandboxCommand(command)!;
      assert.ok(words, 'generated hook/reader must be a simple command');
      const codeIndex = words.indexOf('-e');
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const out = new PassThrough(), err = new PassThrough();
      out.on('data', chunk => stdout.push(Buffer.from(chunk)));
      err.on('data', chunk => stderr.push(Buffer.from(chunk)));
      const sandboxProcess = { pid: process.pid, env: {}, argv: [words[0], ...words.slice(codeIndex + 2)], stdin: Readable.from([input]), stdout: out, stderr: err, exitCode: 0 };
      const protectedFs = { ...disk, open: async (path: any, ...args: any[]) => {
        const value = String(path);
        if (activeScope?.hidden.some(hidden => value === hidden || value.startsWith(hidden + '/')) && !value.startsWith(runDirectory + '/')) { f.directDenials.push(value); throw Object.assign(new Error('sandbox state denied'), { code: 'EACCES' }); }
        return (disk.open as any)(path, ...args);
      }, rename: async (...args: any[]) => {
        if (deliveryFailure && String(args[1]).includes('/ready-')) throw Object.assign(new Error('unit delivery lost after host close'), { code: 'EIO' });
        return (disk.rename as any)(...args);
      } };
      const spawnHost = (executable: string, args: string[], options: any) => {
        f.hostCalls.push({ executable, args, options });
        const child = new EventEmitter() as any;
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        setImmediate(async () => {
          f.hostChild = child;
          const prior = sessions.get(request.runId)!;
          sessions.set(request.runId, { ...prior, state: 'running', process: { pid: process.pid, startedAt: '2026-10-25T12:00:00Z', runner: 'codex', runnerSessionId: 'unit-native', tmuxSession: request.tmuxSession, evidence: { machineId: 'unit-machine', bootId: 'unit-boot' } } });
          try { child.emit('close', await runPublishedAgentChannel(JSON.parse(args.at(-1)!))); }
          catch (error) { child.stderr.end(String(error)); child.stdout.end(); child.emit('close', 1); }
          finally { sessions.set(request.runId, prior); }
        });
        return child;
      };
      const imports = { 'node:fs/promises': protectedFs, 'node:child_process': { spawn: spawnHost } };
      (f as any).vmImports = imports;
      for (const [name, object] of Object.entries(imports)) {
        doubles['vm-' + name] = bridge + Object.entries(object).filter(([key]) => key !== 'default').map(([key, value]) => typeof value === 'function' ? `export const ${key}=(...args)=>f().vmImports[${JSON.stringify(name)}][${JSON.stringify(key)}](...args);` : `export const ${key}=f().vmImports[${JSON.stringify(name)}][${JSON.stringify(key)}];`).join('');
      }
      const module = await import('data:text/javascript,' + encodeURIComponent('export default async function(process) {\n' + words[codeIndex + 1] + '\n}') + '#raf-z394-eval');
      await module.default(sandboxProcess);
      return { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code: sandboxProcess.exitCode };
    },
    async probeDirectState(paths: string[]) {
      const source = `const fs = await import("node:fs/promises"); const rows = []; for (const path of ${JSON.stringify(paths)}) { try { const file = await fs.open(path, "r"); await file.close(); rows.push({ path, code: "opened" }); } catch (error) { rows.push({ path, code: error.code }); } } process.stdout.write(JSON.stringify(rows));`;
      const result = await f.evaluate(`node -e '${source}'`);
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout) as { path: string; code: string }[];
    },
    hook() {
      const definition = prepared.at(-1)!.invocation.args.find(arg => arg.startsWith('hooks.PreToolUse='))!;
      return JSON.parse(definition.match(/command=("(?:\\.|[^"\\])*")/)![1]) as string;
    },
    async invoke(command: string, deliveryFailure = false) {
      const response = await f.evaluate(f.hook(), JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), deliveryFailure);
      return { ...response, response: JSON.parse(response.stdout), replacement: JSON.parse(response.stdout).hookSpecificOutput?.updatedInput?.command as string | undefined };
    },
    runDirectory, context, cutoff,
  };
  const globals = globalThis as any; globals[key] = f;
  t.mock.method(process.stderr, 'write', () => true);
  t.after(async () => { for (const result of prepared) await result.cleanup(); await disk.rm(root, { recursive: true, force: true }); delete globals[key]; });
  return f;
}
