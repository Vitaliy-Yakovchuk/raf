import { promises as fs, watch } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, basename, resolve, relative, sep } from 'node:path';
import { platform, availableParallelism, loadavg, totalmem } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfiguration, RuntimeContext, RuntimeServices, RuntimeLaunch } from './app-runtime.ts';
import { TmuxAgentAdapter, type AdapterCommandExecutor, type AgentRunner, type RunnerProtocol, type AdapterSession } from './agent-adapters.ts';
import { buildRunnerInvocation, observeRunnerScreen, nextRunnerAction, type ProtocolSettings } from './runner-protocols.ts';
import { openStateStore, type StateStore } from './state-store.ts';
import { validateAssignment, composeAssignmentBrief, verifyAssignmentCompletion } from './assignment.ts';
import { createAssignmentIdentityAdapter } from './assignment-identity.ts';
import { createWorkspacePorts, executeCommand, observeProcesses, createResourceSnapshotReader, readMachineBootIdentity } from './os-runtime.ts';
import { resolveWorkspaceRoute } from './workspace-routing.ts';
import { selectModel, listModelAvailability } from './model-routing.ts';
import { createLaunchState, reserveLaunchInTransaction, evaluateLaunchAdmissionInTransaction } from './launch-state.ts';
import { createSessionState, closeSessionInTransaction, type ProcessIdentity, type SessionRecord, type WorkResult } from './session-state.ts';
import { AgentControlService, MainAttachedElsewhereError, type VerifiedSender, type ActivityEvent, type MainAttachment } from './agent-control.ts';
import { ReminderService } from './reminders.ts';
import { evaluateResourceAdmission } from './resource-admission.ts';
import { claimTaskReservations, handoffTaskReservations, startTaskReservations, completeTaskReservations, releaseTaskReservations, reconcileTaskReservations, listTaskReservations, type TaskReservationDependencies, type TaskReservationLease } from './task-reservations.ts';
import { launchPersistentWrapper, runLaunchWrapper, consumeWrapperRequest, type LaunchHandshake, type LaunchOwnership } from './launch-wrapper.ts';
import { commandFailure } from './cli-contract.ts';
import { loadTaskContextConfiguration, deriveTaskContext, assignmentFingerprint, writeTaskContextFile } from './task-context.ts';
import { probeRunnerAvailability, resolveRunnerExecutable } from './runner-availability.ts';
import type { ReminderSessionEffect } from './reminder-repository.ts';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(text);
const now = () => new Date().toISOString();
const effects = { pending: [], domain: [] };
const json = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'));
const fail = (code: string, reason: string): never => { throw commandFailure({ code, message: reason, reason, stage: 'production-runtime', source: 'production-runtime', sourceCode: null, received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true, remediation: ['Уточніть контекст або конфігурацію потрібного production компонента.'] }); };
const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity) => isDeepStrictEqual(a, b);
const mainRemediation = 'Виконайте raf main attach у tmux-панелі сесії main, не змінюючи змінних TMUX і TMUX_PANE.';
const mainFail = (code: string, reason: string, remediation: string, found: unknown = null): never => { throw commandFailure({ code, message: reason, reason, stage: 'main-attach', source: 'production-runtime', sourceCode: null, received: null, expected: null, found, completed: [], pending: [], retrySafe: true, remediation: [remediation] }); };

export const rafSystemCaller: Readonly<Record<string, never>> = Object.freeze({});

async function protocols(confRoot: string, override?: readonly ProtocolSettings[]): Promise<readonly ProtocolSettings[]> {
  if (override) return override;
  const settings = await json(join(confRoot, 'raf.json'));
  if (settings.version !== 1 || !Array.isArray(settings.runnerProtocols)) fail('RUNNER_PROTOCOL_UNAVAILABLE', 'conf/raf.json#runnerProtocols requires versioned installed runner settings and measured time budgets');
  return settings.runnerProtocols;
}
function protocolFor(settings: readonly ProtocolSettings[], runner: string): ProtocolSettings {
  if (runner !== 'codex') fail('RUNNER_IDENTITY_UNAVAILABLE', `Pre-brief native identity evidence is unavailable for ${runner}`);
  const matches = settings.filter(row => row.runner === runner);
  const value = matches[0];
  if (matches.length !== 1 || !value || typeof value.liveTaskVerified !== 'boolean' || value.quotaCommand !== '/status' || !text(value.executable) || !text(value.version) || !Array.isArray(value.baseArgs) || !value.baseArgs.every(text) || !text(value.modelFlag) || !text(value.effortFlag) || !['literal', 'codex_config'].includes(value.effortFormat) || !object(value.modelAliases) || !Array.isArray(value.navigation) || !object(value.markers) || !strings(value.markers.ready) || !object(value.timeouts) || Object.values(value.timeouts).some(n => !Number.isFinite(n) || n <= 0) || !['startupMs', 'transitionMs', 'overallMs', 'pollMs'].every(key => Number.isFinite(value.timeouts[key]) && value.timeouts[key] > 0)) fail('RUNNER_PROTOCOL_UNAVAILABLE', `Runner ${runner} lacks a validated versioned invocation/readiness protocol and deadlines`);
  return value;
}
async function runnerWritableDirectories(cwd: string, boundaries: readonly string[], reportDirectory: string, statePath: string): Promise<string[]> {
  const workspace = await fs.realpath(cwd);
  const stateDirectory = await fs.realpath(dirname(statePath));
  const inside = (root: string, path: string) => {
    const suffix = relative(root, path);
    return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
  };
  const directories = new Set<string>();
  for (const boundary of boundaries) {
    const target = resolve(workspace, boundary);
    let directory: string;
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory() && !stat.isFile()) fail('RUNNER_WRITE_SCOPE_INVALID', 'Declared write boundary is not a file or directory');
      const canonical = await fs.realpath(target);
      directory = stat.isDirectory() ? canonical : dirname(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let parent = boundary.endsWith(sep) ? target : dirname(target);
      const missing: string[] = [];
      for (;;) {
        try { directory = resolve(await fs.realpath(parent), ...missing); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error;
          missing.unshift(basename(parent));
          parent = dirname(parent);
        }
      }
    }
    if (inside(workspace, directory)) continue;
    if (inside(directory, workspace) || inside(directory, stateDirectory) || inside(stateDirectory, directory)) fail('RUNNER_WRITE_SCOPE_INVALID', 'Declared write boundary would grant a workspace ancestor or RAF state directory');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const canonical = await fs.realpath(directory);
    if (inside(canonical, workspace) || inside(canonical, stateDirectory) || inside(stateDirectory, canonical)) fail('RUNNER_WRITE_SCOPE_INVALID', 'Resolved write directory exceeds the declared task scope');
    directories.add(canonical);
  }
  directories.add(await fs.realpath(reportDirectory));
  return [...directories];
}
function runtimeExecution(context: Pick<RuntimeContext, 'tmpRoot'>, override?: AdapterCommandExecutor): AdapterCommandExecutor {
  if (override) return override;
  const directory = join(context.tmpRoot, 'tmux');
  const socketPath = join(directory, 'server.sock');
  return async command => {
    if (command.executable !== 'tmux') return executeCommand(command);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const owner = await fs.lstat(directory);
    if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0) fail('TMUX_CONTEXT_INVALID', 'RAF tmux directory must be private and owned by the current user');
    try { const socket = await fs.lstat(socketPath); if (!socket.isSocket() || socket.uid !== process.getuid?.()) fail('TMUX_CONTEXT_INVALID', 'RAF tmux socket has foreign ownership or file type'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const result = await executeCommand({ ...command, args: ['-S', socketPath, ...command.args] });
    await fs.chmod(socketPath, 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    return result;
  };
}
async function bootIdentity(execute: AdapterCommandExecutor) {
  try { return await readMachineBootIdentity(execute); }
  catch (error) { return fail('PROCESS_IDENTITY_UNAVAILABLE', error instanceof Error ? error.message : String(error)); }
}
async function processRows(execute: AdapterCommandExecutor) {
  const result = await execute({ executable: 'ps', args: ['-ww', '-axo', 'pid=,ppid=,lstart=,command='] });
  if (result.exitCode !== 0) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Cannot inspect process ancestry');
  return result.stdout.split('\n').filter(line => line.trim()).map(line => {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!row) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Malformed OS process ancestry observation');
    return { pid: Number(row[1]), ppid: Number(row[2]), startedAt: new Date(row[3]).toISOString(), command: row[4] };
  });
}
async function belongsToPane(identity: ProcessIdentity, execute: AdapterCommandExecutor): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(identity.tmuxSession)) return false;
  const pane = await execute({ executable: 'tmux', args: ['display-message', '-p', '-t', `=${identity.tmuxSession}:0.0`, '#{pane_pid}'] });
  if (pane.exitCode !== 0 || !/^\d+$/.test(pane.stdout.trim())) return false;
  const rows = await processRows(execute);
  const actual = rows.find(row => row.pid === identity.pid);
  if (!actual || Date.parse(actual.startedAt) !== Date.parse(identity.startedAt) || actual.command !== identity.evidence.command) return false;
  let pid = actual.pid;
  const seen = new Set<number>();
  while (pid && !seen.has(pid)) {
    if (pid === Number(pane.stdout.trim())) return true;
    seen.add(pid);
    pid = rows.find(row => row.pid === pid)?.ppid ?? 0;
  }
  return false;
}
async function ownIdentity(execute: AdapterCommandExecutor, runId: string, tmuxSession: string) {
  const row = (await processRows(execute)).find(row => row.pid === process.pid);
  if (!row) return fail('PROCESS_IDENTITY_UNAVAILABLE', 'Current process identity unavailable');
  return { pid: row.pid, startedAt: row.startedAt, runner: 'raf', runnerSessionId: runId, tmuxSession, evidence: { command: row.command, runId, ...await bootIdentity(execute) } };
}
function paneExecutor(socket: string, execute: AdapterCommandExecutor): AdapterCommandExecutor {
  return command => execute(command.executable === 'tmux' ? { ...command, args: ['-u', '-S', socket, ...command.args] } : command);
}
async function ancestry(execute: AdapterCommandExecutor) {
  const rows = await processRows(execute);
  const chain: number[] = [];
  for (let pid = process.pid; pid && !chain.includes(pid); pid = rows.find(row => row.pid === pid)?.ppid ?? 0) chain.push(pid);
  return { rows, chain };
}
async function observeIdentity(identity: ProcessIdentity, execute: AdapterCommandExecutor) {
  const observation = (await observeProcesses([identity], { execute }))[0];
  if (observation.state !== 'alive' || !identity.evidence.bootId) return observation;
  const boot = await bootIdentity(execute);
  if (boot.bootId === identity.evidence.bootId && boot.machineId === identity.evidence.machineId) return observation;
  return { state: 'exited' as const, observedAt: observation.observedAt, exitCode: null, evidence: 'Process identity belongs to a previous boot' };
}
async function callerPane(execute: AdapterCommandExecutor, direct: AdapterCommandExecutor): Promise<ProcessIdentity> {
  const socket = (process.env.TMUX ?? '').split(',')[0];
  const pane = process.env.TMUX_PANE ?? '';
  if (!isAbsolute(socket) || !/^%\d+$/.test(pane)) return mainFail('MAIN_CALLER_NOT_IN_TMUX', 'raf main attach must run inside a tmux pane', mainRemediation);
  const shown = await paneExecutor(socket, direct)({ executable: 'tmux', args: ['display-message', '-p', '-t', pane, '#{pane_id}\t#{pane_pid}\t#{socket_path}\t#{session_name}'] });
  const [paneId, panePid, socketPath, ...name] = shown.stdout.replace(/\n$/, '').split('\t');
  const canonical = async (path: string) => fs.realpath(path).catch(() => '');
  if (shown.exitCode !== 0 || paneId !== pane || !/^\d+$/.test(panePid ?? '') || !socketPath || await canonical(socketPath) !== await canonical(socket) || !name.length) {
    return mainFail('MAIN_CALLER_NOT_IN_TMUX', 'TMUX and TMUX_PANE do not name a live pane of that tmux server', mainRemediation);
  }
  const { rows, chain } = await ancestry(execute);
  const row = rows.find(row => row.pid === Number(panePid));
  if (!row || !chain.includes(row.pid)) return mainFail('MAIN_CALLER_NOT_IN_TMUX', 'Calling process does not run inside the pane named by TMUX_PANE', mainRemediation);
  return { pid: row.pid, startedAt: row.startedAt, runner: 'main', runnerSessionId: pane, tmuxSession: name.join('\t'), evidence: { command: row.command, tmuxSocket: socket, tmuxPane: pane, ...await bootIdentity(execute) } };
}
function mainAttachment(session: SessionRecord): MainAttachment {
  const identity = session.process!;
  return { id: 'main', runId: session.runId, tmuxSocket: identity.evidence.tmuxSocket, tmuxSession: identity.tmuxSession, tmuxPane: identity.evidence.tmuxPane, pid: identity.pid, startedAt: identity.startedAt, machineId: identity.evidence.machineId, bootId: identity.evidence.bootId };
}
function sessionTools(store: StateStore, execute: AdapterCommandExecutor, configuration: RuntimeConfiguration, context: RuntimeContext, identityExecute?: AdapterCommandExecutor) {
  const verified = new WeakMap<object, string>();
  const mainAuthority = new WeakMap<object, ProcessIdentity>();
  const direct = identityExecute ?? executeCommand;
  const state = createSessionState({ repository: store.sessionRepository, verifyMainAuthority: (authority, identity) => !!authority && typeof authority === 'object' && isDeepStrictEqual(mainAuthority.get(authority), identity), verifyWorkResult: (runId, result) => verified.get(result) === runId });
  const current = (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId));
  const reminders = new ReminderService({ repository: store.reminderRepository, now, nextId: randomUUID, approvedEventKinds: ['agent.succeeded', 'agent.failed', 'agent.started', 'agent.activity-changed', 'agent.closed', 'reminder.activated', 'reminder.closed'] });
  const intents = (rows: readonly ActivityEvent[]) => rows.map(row => { const event = row.kind === 'started' ? 'agent.started' : row.kind === 'updated' ? 'agent.activity-changed' : 'agent.closed'; return { id: `${row.session.runId}:activity:${row.session.revision}:${row.kind}:${row.project}`, runId: row.session.runId, event, payload: { kind: event, id: row.session.addressId, activity: row } }; });
  const publish = async (rows: readonly ActivityEvent[]) => { store.sessionRepository.transaction(tx => { for (const intent of intents(rows)) tx.putPending(intent); }); };
  const finalize = async (session: SessionRecord, rows: readonly ActivityEvent[]) => {
    const wrapper = session.launchContext?.wrapper ?? listTaskReservations(store).find(set => set.lease.owner.runId === session.runId)?.wrapper;
    if (wrapper && wrapper.pid !== process.pid) { const observed = (await observeProcesses([wrapper], { execute }))[0]; if (observed.state !== 'exited') fail('WORKER_RESULT_PENDING', `Worker result processing is ${observed.state}; preserve ${session.runId} before recovery finalization`); }
    const at = now();
    const effect: ReminderSessionEffect = { id: `${session.runId}:reminders:session-ended`, domain: 'reminders', payload: { operation: 'session-ended', runId: session.runId, at, end: { address: session.addressId, confirmedSucceeded: session.result?.status === 'succeeded', crashed: true } } };
    const pending = intents(rows);
    if (!session.result) {
      const result: WorkResult = { status: 'failed', response: 'Runner exited without an accepted result', proof: { runId: session.runId, at } };
      verified.set(result, session.runId);
      state.acceptWorkResult(session.runId, result, { pending: [{ id: `${session.runId}:agent.failed`, runId: session.runId, event: 'agent.failed', payload: { kind: 'agent.failed', id: session.addressId } }], domain: [] });
      session = current(session.runId)!;
    }
    const lease = listTaskReservations(store).find(set => set.lease.owner.runId === session.runId)?.lease;
    if (lease) {
      const released = await releaseTaskReservations(await reservationTools(store, context, execute, identityExecute), { lease, reason: session.result?.status === 'succeeded' ? 'succeeded' : 'failed', closeLaunch: tx => {
        const row = tx.getSession(session.runId);
        if (!row || row.state !== 'exited') throw new Error('Session changed before final closure');
        closeSessionInTransaction(tx, row, at);
        tx.applyEffects([effect]);
        for (const intent of pending) tx.putPending(intent);
      } });
      if (!released) fail('LAUNCH_RECOVERABLE', 'Task reservation cannot be released before verified process exit');
    } else state.finalizeSession(session.runId, session.revision, at, { pending, domain: [effect] });
    return current(session.runId)!;
  };
  const launch = createLaunchState({ repository: store.sessionRepository, measure: async () => { throw new Error('Measurements must precede atomic reserve'); }, evaluateAdmission: evaluateResourceAdmission });
  const resolve = async (caller: unknown): Promise<VerifiedSender> => {
    if (caller === rafSystemCaller) return { kind: 'system' };
    const { chain } = await ancestry(execute);
    const running = state.listReconciliationCandidates().filter(session => session.state === 'running' && session.process);
    for (const pid of chain) {
      for (const session of running.filter(session => session.process!.pid === pid)) {
        if ((await observeIdentity(session.process!, execute)).state === 'alive') return { kind: 'agent', runId: session.runId };
      }
    }
    return fail('CALLER_UNVERIFIED', 'Current process ancestry has no verified registered agent or attached main pane');
  };
  const authorize = async (id: string, caller: unknown) => {
    const sender = await resolve(caller);
    const session = current(sender.kind === 'agent' ? sender.runId : '');
    if (!session || (session.addressId !== id && session.addressId !== 'main')) fail('CALLER_UNAUTHORIZED', `Caller is not authorized for ${id}`);
  };
  const types = configuration.catalog.commands.find(row => row.handlerName === 'agent run')?.parameters.find(row => row.name === 'type')?.values?.map(row => row.id) ?? [];
  const projects = configuration.catalog.commands.find(row => row.handlerName === 'agent run')?.parameters.find(row => row.name === 'project')?.values?.map(row => row.id) ?? [];
  const control = new AgentControlService({ repository: store.sessionRepository, scanner: { inspect: identity => observeIdentity(identity, execute) }, authority: { resolve }, reminders,
    projects, agentTypes: types,
    coordinator: {
      observe: async (session, observation) => {
        if (observation.state === 'exited') {
          const wrapper = session.launchContext?.wrapper ?? listTaskReservations(store).find(set => set.lease.owner.runId === session.runId)?.wrapper;
          if (wrapper) {
            const wrapperState = (await observeProcesses([wrapper], { execute }))[0];
            if (wrapperState.state !== 'exited') fail('WORKER_RESULT_PENDING', `Worker result processing is ${wrapperState.state}; preserve ${session.runId} until its report/exit transition completes`);
          }
        }
        state.commitObservation(session.runId, session.revision, observation, effects);
        if (observation.state === 'unknown') fail('PROCESS_SCAN_UNKNOWN', `Process scan unknown: ${observation.error}`);
        return current(session.runId)!;
      },
      updateActivity: async (session, update, rows) => { if (!launch.updateActivity(session.runId, session.revision, update, intents(rows))) fail('ACTIVITY_CONFLICT', 'Session changed during activity update'); return current(session.runId)!; },
      finalize, publish,
    },
    transport: {
      deliver: async (identity, message) => {
        if (!identity.evidence.tmuxSocket || !isAbsolute(identity.evidence.tmuxSocket)) return { accepted: false, reason: 'Session has no recorded tmux socket' };
        if ((await observeIdentity(identity, execute)).state !== 'alive') return { accepted: false, reason: 'Recipient process is not alive' };
        const tmux = paneExecutor(identity.evidence.tmuxSocket, direct);
        const adapter = new TmuxAgentAdapter({ execute: tmux, protocols: {} as Record<AgentRunner, RunnerProtocol> });
        if (identity.runner === 'main') {
          const pane = identity.evidence.tmuxPane;
          const shown = await tmux({ executable: 'tmux', args: ['display-message', '-p', '-t', pane, '#{pane_id}\t#{pane_pid}'] });
          if (shown.exitCode !== 0 || shown.stdout.replace(/\n$/, '') !== `${pane}\t${identity.pid}`) return { accepted: false, reason: 'Attached main pane no longer holds the attached process' };
          await adapter.deliverToPane(pane, message);
        } else {
          if (!await belongsToPane(identity, tmux)) return { accepted: false, reason: 'Recipient process no longer belongs to its tmux pane' };
          await adapter.deliver({ tmuxSession: identity.tmuxSession, selection: { runner: identity.runner as AgentRunner, model: '', effort: '' } }, message);
        }
        return { accepted: true, receiptId: randomUUID() };
      },
      interrupt: async () => fail('INTERRUPT_UNAVAILABLE', 'Runner-specific busy interrupt evidence is unavailable'),
      close: async identity => {
        const observed = (await observeProcesses([identity], { execute }))[0];
        if (observed.state !== 'alive' || !await belongsToPane(identity, execute)) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Close requires a verified live process in its owned tmux pane');
        const adapter = new TmuxAgentAdapter({ execute, protocols: {} as Record<AgentRunner, RunnerProtocol> });
        await adapter.stop({ tmuxSession: identity.tmuxSession, selection: { runner: identity.runner as AgentRunner, model: '', effort: '' } });
        const after = (await observeProcesses([identity], { execute }))[0];
        if (after.state !== 'exited') fail('PROCESS_TERMINATION_UNKNOWN', 'Runner termination is not confirmed');
      },
    },
  });
  const attachMain = async (): Promise<MainAttachment> => {
    const identity = await callerPane(execute, direct);
    const authority = {};
    mainAuthority.set(authority, identity);
    try {
      return mainAttachment(await control.attachMain(identity, () => state.registerExistingMain(randomUUID(), identity, authority, { type: 'main', project: 'orchestrator', features: [], phase: 'main', cwd: process.cwd() })));
    } catch (error) {
      if (error instanceof MainAttachedElsewhereError) return mainFail('MAIN_ALREADY_ATTACHED', 'Another live pane is attached as main', 'Працюйте з уже зареєстрованої панелі main або завершіть її процес і повторіть raf main attach.', error.session.process ? mainAttachment(error.session) : error.session.runId);
      throw error;
    }
  };
  return { state, current, verified, reminders, publish, control, authorize, resolve, finalize, attachMain };
}

function assignmentPorts(execute: AdapterCommandExecutor) {
  return { cli: { exec: (args: readonly string[], cwd: string) => execute({ executable: 'openspec', args, cwd }) }, fs: { readText: (path: string) => fs.readFile(path, 'utf8') } };
}
async function measureResources(paths: readonly string[], machineId: string, execute: AdapterCommandExecutor) {
  return createResourceSnapshotReader({ machineId, paths }, { platform, loadAverage1m: () => loadavg()[0], availableCores: availableParallelism, totalRamBytes: totalmem, readFile: path => fs.readFile(path, 'utf8'), execute }).read();
}
async function reservationTools(store: StateStore, context: RuntimeContext, execute: AdapterCommandExecutor, identityExecute?: AdapterCommandExecutor): Promise<TaskReservationDependencies> {
  const projects = await json(join(context.confRoot, 'projects.json'));
  const roots = Object.fromEntries(Object.keys(projects.projects).map(project => [project, context.orchestratorRoot]));
  const identity = createAssignmentIdentityAdapter(roots, identityExecute ? { execute: identityExecute } : {});
  return { store, currentBoot: () => bootIdentity(execute), observe: async identity => (await observeProcesses([identity], { execute }))[0], resolveTasks: identity.resolveTasks, newFence: randomUUID };
}

export async function createProductionServices(
  store: StateStore,
  configuration: RuntimeConfiguration,
  context: RuntimeContext,
  options: {
    execute?: AdapterCommandExecutor;
    protocolSettings?: readonly ProtocolSettings[];
    workerModulePath?: string;
  } = {},
): Promise<RuntimeServices> {
  for (const name of ['orchestratorRoot', 'confRoot', 'artifactPath', 'statePath', 'tmpRoot'] as const) if (!isAbsolute(context[name])) fail('INVALID_CONTEXT', `Absolute ${name} required`);
  if (options.workerModulePath && !isAbsolute(options.workerModulePath)) fail('INVALID_CONTEXT', 'Internal worker override must be absolute');
  const execute = runtimeExecution(context, options.execute);
  const tools = sessionTools(store, execute, configuration, context, options.execute);
  const assignments = assignmentPorts(execute);
  const prepared = new Map<string, { launch: RuntimeLaunch; reportPath: string; handshake?: LaunchHandshake; brief?: string; spawnAttempted?: boolean }>();
  const readSession = tools.current;
  const leaseFor = (runId: string) => listTaskReservations(store).find(set => set.lease.owner.runId === runId)?.lease;
  const release = async (runId: string, reason: 'cancelled' | 'failed' | 'succeeded') => {
    const lease = leaseFor(runId);
    if (lease) {
      if (!await releaseTaskReservations(await reservationTools(store, context, execute, options.execute), { lease, reason, closeLaunch: tx => { const session = tx.getSession(runId); if (!session) throw new Error('Unknown launch'); closeSessionInTransaction(tx, session, now()); } })) fail('LAUNCH_RECOVERABLE', `Cannot safely release run ${runId}`);
    } else if (readSession(runId)?.state === 'reserved') tools.state.abortLaunch(runId, reason, now());
  };
  return {
    assignment: { validate: request => validateAssignment(request, assignments), compose: (snapshot, input) => composeAssignmentBrief(snapshot, { ...input, sessionName: input.agentId }, assignments.fs) },
    resolveTask: async (parameters, assignment) => {
      const task = await deriveTaskContext({ root: context.orchestratorRoot, parameters, assignment, configuration: await loadTaskContextConfiguration(context.confRoot) });
      if (task.estimate.status !== 'KNOWN') return fail('RESOURCE_ESTIMATE_UNKNOWN', task.estimate.reason);
      return { ...task, estimate: task.estimate, requested: { ramBytes: task.estimate.ramBytes, diskBytes: {} }, requiredFileSystemIds: [] };
    },
    route: async request => resolveWorkspaceRoute(request, await json(join(context.confRoot, 'projects.json')), createWorkspacePorts(execute)),
    routingSnapshot: async () => {
      const cliAvailable: Record<string, boolean> = {};
      let configured: readonly ProtocolSettings[] = [];
      try { configured = await protocols(context.confRoot, options.protocolSettings); } catch {}
      const cliReasons: Record<string, string> = {};
      for (const runner of configuration.models.runners) {
        let availability;
        try { availability = await probeRunnerAvailability(protocolFor(configured, runner.id), { env: process.env, execute }); }
        catch (error) { availability = { available: false as const, reason: error instanceof Error ? error.message : String(error) }; }
        cliAvailable[runner.id] = availability.available;
        if (!availability.available) cliReasons[runner.id] = availability.reason;
      }
      return { runnerEnabled: Object.fromEntries(configuration.models.runners.map(runner => [runner.id, store.getRunnerEnabled(runner.id) ?? runner.initialEnabled])), cliAvailable, cliReasons, quotas: [] };
    },
    selectModel, listModels: listModelAvailability,
    prepareReport: async launch => {
      if (launch.statePath !== context.statePath || launch.tmpRoot !== context.tmpRoot || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(launch.runId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(launch.addressId)) fail('INVALID_CONTEXT', 'Launch paths or identity mismatch');
      const writeBoundaries = launch.writeBoundaries ?? [];
      if (!Array.isArray(writeBoundaries) || !writeBoundaries.every(text)) fail('INVALID_CONTEXT', 'Launch write boundaries must be declared paths');
      if (!launch.taskContext) return fail('INVALID_CONTEXT', 'Launch lacks derived task context');
      const directory = join(context.tmpRoot, launch.runId);
      await fs.mkdir(context.tmpRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(directory, { mode: 0o700 });
      const reportPath = join(directory, `${launch.addressId}.json`);
      try {
        await writeTaskContextFile(directory, { version: 1, runId: launch.runId, parameters: launch.taskContext.parameters, assignmentFingerprint: assignmentFingerprint(launch.assignment), context: launch.taskContext.context });
        await fs.writeFile(join(directory, 'runtime.json'), JSON.stringify({ version: 1, configuration, context: { ...context, resolveCaller: undefined }, protocolSettings: options.protocolSettings, writeBoundaries }), { mode: 0o600, flag: 'wx' });
      } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
      prepared.set(launch.tmuxSession, { launch: structuredClone(launch), reportPath });
      return { reportPath, reportWrapper: { wrap: command => command }, cleanupUnstarted: async () => { if (readSession(launch.runId)?.state === 'running') fail('LAUNCH_RECOVERABLE', 'Cannot clean a running launch'); await fs.rm(directory, { recursive: true, force: true }); prepared.delete(launch.tmuxSession); } };
    },
    reserve: async input => {
      const dependencies = await reservationTools(store, context, execute, options.execute);
      await reconcileTaskReservations(dependencies);
      const boot = await dependencies.currentBoot();
      const estimate = prepared.get(input.tmuxSession)?.launch.taskContext?.context.estimate;
      const resourceSnapshot = await measureResources([input.activity.cwd, dirname(input.statePath), input.tmpRoot], boot.machineId, execute);
      const requiredFileSystemIds = [...new Set([...input.requiredFileSystemIds, ...Object.values(resourceSnapshot.fileSystemByPath)])];
      const requested = { ramBytes: input.requested.ramBytes, diskBytes: { ...Object.fromEntries(estimate ? requiredFileSystemIds.map(id => [id, estimate.diskBytesPerFileSystem]) : []), ...input.requested.diskBytes } };
      const candidates = tools.state.listReconciliationCandidates().filter(session => session.process);
      const observed = await observeProcesses(candidates.map(session => session.process!), { execute });
      const measured = { measurement: resourceSnapshot.measurement, observedProcesses: candidates.flatMap((session, index) => observed[index].state === 'alive' ? [{ runId: session.runId, identity: session.process! }] : []) };
      const admission = store.sessionRepository.transaction(tx => evaluateLaunchAdmissionInTransaction(tx, { requested, requiredFileSystemIds }, measured, evaluateResourceAdmission));
      if (!admission.allowed[input.activity.type === 'hotfix' ? 'hotfix' : 'normal']) return { admitted: false, reason: admission.reasons.join('; ') };
      const record = prepared.get(input.tmuxSession);
      if (!record || record.reportPath !== input.reportPath || input.assignment.root !== context.orchestratorRoot || !isDeepStrictEqual(record.launch.assignment, input.assignment) || !isDeepStrictEqual(record.launch.writeBoundaries ?? [], input.writeBoundaries ?? [])) fail('INVALID_CONTEXT', 'Prepared launch context mismatch');
      const identityAdapter = createAssignmentIdentityAdapter({ [input.activity.project]: context.orchestratorRoot }, options.execute ? { execute: options.execute } : {});
      const tasks = await identityAdapter.capture(input.activity.project, input.assignment);
      const request = { runId: input.runId, addressId: input.addressId, activity: input.activity, launchContext: { assignment: input.assignment, selection: input.selection, reportPath: input.reportPath, briefPath: join(input.tmpRoot, input.runId, 'brief.txt'), writeBoundaries: [...(record.launch.writeBoundaries ?? [])] }, resource: 'runtime', amount: requested.ramBytes, requested, requiredFileSystemIds, mode: input.activity.type === 'hotfix' ? 'hotfix' as const : 'normal' as const };
      let admissionReason = '';
      try {
        const claimed = await claimTaskReservations(dependencies, { runId: input.runId, addressId: input.addressId, tasks, starter: await ownIdentity(execute, input.runId, input.tmuxSession), reserveLaunch: tx => {
          const result = reserveLaunchInTransaction(tx, request, measured, evaluateResourceAdmission);
          if (!result.reserved) { admissionReason = result.admission.reasons.join('; '); throw new Error('RESOURCE_UNAVAILABLE'); }
          return result.session;
        } });
        if (!claimed.reserved) fail('TASK_RESERVED', JSON.stringify(claimed.conflicts));
        return { admitted: true };
      } catch (error) { if (admissionReason) return { admitted: false, reason: admissionReason }; throw error; }
    },
    adapter: { start: async request => {
      const selection = { runner: request.selection.runner, model: request.selection.model, effort: request.selection.effort };
      const record = prepared.get(request.tmuxSession);
      if (!record || !isDeepStrictEqual({ runner: record.launch.selection.runner, model: record.launch.selection.model, effort: record.launch.selection.effort }, selection) || request.cwd !== record.launch.activity.cwd) fail('INVALID_CONTEXT', 'Unprepared worker launch');
      const session = readSession(record.launch.runId);
      if (session?.state !== 'reserved' || !leaseFor(record.launch.runId)) fail('TASK_CLAIM_REQUIRED', 'Durable launch and task claims required before spawn');
      const settings = protocolFor(await protocols(context.confRoot, options.protocolSettings), request.selection.runner);
      const availability = await probeRunnerAvailability(settings, { env: process.env, execute });
      if (!availability.available) return fail('RUNNER_PROTOCOL_UNAVAILABLE', availability.reason);
      const manifestPath = join(context.tmpRoot, record.launch.runId, 'runtime.json');
      const manifestTemporary = `${manifestPath}.${process.pid}.tmp`;
      await fs.writeFile(manifestTemporary, JSON.stringify({ ...await json(manifestPath), runnerPath: availability.path }), { mode: 0o600, flag: 'wx' });
      await fs.rename(manifestTemporary, manifestPath);
      try { await fs.writeFile(session.launchContext!.briefPath, request.brief, { mode: 0o600, flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const briefFile = await fs.lstat(session.launchContext!.briefPath);
        if (!briefFile.isFile() || briefFile.uid !== process.getuid?.() || await fs.readFile(session.launchContext!.briefPath, 'utf8') !== request.brief) fail('BRIEF_CONTEXT_MISMATCH', 'Existing durable brief does not match this prepared launch');
        await fs.chmod(session.launchContext!.briefPath, 0o600);
      }
      record.brief = request.brief;
      const modulePath = options.workerModulePath ?? fileURLToPath(import.meta.url);
      record.spawnAttempted = true;
      record.handshake = await launchPersistentWrapper({ tmpRoot: context.tmpRoot, statePath: context.statePath, cwd: request.cwd, runId: record.launch.runId, address: record.launch.addressId, assignment: record.launch.assignment, selection, tmuxSession: request.tmuxSession, brief: request.brief, readinessTimeoutMs: settings.timeouts.startupMs }, {
        timeoutMs: settings.timeouts.overallMs,
        workerCommand: { executable: process.execPath, args: ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(modulePath).href)});await m.runProductionWorker();`], cwd: request.cwd },
      });
      return { tmuxSession: request.tmuxSession, selection };
    } },
    verifyStarted: async (launch, session) => {
      const handshake = prepared.get(launch.tmuxSession)?.handshake;
      if (!handshake || !isDeepStrictEqual(session.selection, { runner: launch.selection.runner, model: launch.selection.model, effort: launch.selection.effort }) || session.tmuxSession !== launch.tmuxSession || handshake.runId !== launch.runId || handshake.address !== launch.addressId || handshake.reportPath !== join(launch.tmpRoot, launch.runId, `${launch.addressId}.json`) || handshake.identity.tmuxSession !== launch.tmuxSession || handshake.identity.runner !== launch.selection.runner || handshake.identity.evidence.runId !== launch.runId) fail('RUNNER_IDENTITY_INVALID', 'Worker handshake does not match the requested launch');
      const observation = (await observeProcesses([handshake.identity], { execute }))[0];
      if (observation.state !== 'alive' || !await belongsToPane(handshake.identity, execute)) fail('RUNNER_IDENTITY_INVALID', `Runner observation is ${observation.state} or its owned pane changed`);
      return handshake.identity;
    },
    commitStarted: async (runId, identity) => { const session = readSession(runId); return !!session && ((session.state === 'running' && !!session.process && sameIdentity(session.process, identity)) || tools.state.commitStarted(runId, identity)); },
    compensate: async launch => {
      const preparedLaunch = prepared.get(launch.tmuxSession);
      if (preparedLaunch && !preparedLaunch.spawnAttempted) return { stopped: true };
      const session = readSession(launch.runId);
      const identity = session?.process ?? prepared.get(launch.tmuxSession)?.handshake?.identity;
      if (!identity) return { stopped: false, reason: 'Runner life is unknown after worker spawn; recover this run before retry' };
      const observation = (await observeProcesses([identity], { execute }))[0];
      if (observation.state === 'exited') return { stopped: true };
      if (observation.state !== 'alive' || !await belongsToPane(identity, execute)) return { stopped: false, reason: 'Runner ownership or tmux pane association unknown' };
      const adapter = new TmuxAgentAdapter({ execute, protocols: {} as Record<AgentRunner, RunnerProtocol> });
      await adapter.stop({ tmuxSession: identity.tmuxSession, selection: { runner: identity.runner as AgentRunner, model: launch.selection.model, effort: launch.selection.effort } });
      return (await observeProcesses([identity], { execute }))[0].state === 'exited' ? { stopped: true } : { stopped: false, reason: 'Runner death not confirmed' };
    },
    abortLaunch: async (runId, reason) => { const session = readSession(runId); if (session?.state === 'running') fail('LAUNCH_RECOVERABLE', `${runId}: ${reason}; worker lifecycle owns running launch cleanup`); await release(runId, 'cancelled'); },
    control: {
      ps: async () => { const sessions = await tools.control.ps(); if (sessions.some(session => session.observation?.state === 'unknown')) fail('PROCESS_SCAN_UNKNOWN', 'Process scan returned unknown; reservations retained'); return sessions; },
      update: async (id, patch, caller) => { await tools.authorize(id, caller); const session = tools.state.listReconciliationCandidates().find(session => session.addressId === id); if (!session?.activity) fail('SESSION_UNAVAILABLE', 'Session activity unavailable'); return tools.control.update(id, { ...session.activity, ...patch }); },
      message: (input, caller) => tools.control.message(input, caller),
      close: async (id, caller) => { await tools.authorize(id, caller); return tools.control.close(id); },
      interrupt: async (id, caller) => { await tools.authorize(id, caller); return tools.control.interrupt(id); },
      attachMain: tools.attachMain,
    },
    authorizeMain: async caller => { await tools.authorize('main', caller); },
  };
}

export async function runProductionWorker(
  options: {
    execute?: AdapterCommandExecutor;
    protocolSettings?: readonly ProtocolSettings[];
  } = {},
): Promise<void> {
  const channel = await consumeWrapperRequest();
  const request = channel.request;
  let manifest;
  const manifestPath = join(request.tmpRoot, request.runId, 'runtime.json');
  try {
    const metadata = await fs.lstat(manifestPath);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) fail('WORKER_CONTEXT_INVALID', 'Worker runtime envelope must be an owned private regular file');
    manifest = await json(manifestPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('WORKER_CONTEXT_UNAVAILABLE', `Prepared worker runtime envelope is missing: ${manifestPath}`); throw error; }
  if (manifest.version !== 1 || manifest.context?.statePath !== request.statePath || manifest.context?.tmpRoot !== request.tmpRoot || manifest.context?.orchestratorRoot !== request.assignment.root || !isAbsolute(manifest.context?.confRoot ?? '')) fail('INVALID_CONTEXT', 'Worker runtime envelope mismatch');
  const context: RuntimeContext = { ...manifest.context, resolveCaller: async () => undefined };
  const execute = runtimeExecution(context, options.execute);
  const configured = protocolFor(options.protocolSettings ?? manifest.protocolSettings ?? await protocols(context.confRoot), request.selection.runner);
  const resolution = await resolveRunnerExecutable(configured.runner, configured.executable, process.env);
  if (resolution.status !== 'resolved' || !text(manifest.runnerPath) || resolution.path !== manifest.runnerPath) fail('RUNNER_PROTOCOL_UNAVAILABLE', resolution.status === 'resolved' ? `Worker runner path ${resolution.path} differs from launch runner path ${manifest.runnerPath ?? 'missing'}` : resolution.reason);
  const settings = { ...configured, executable: manifest.runnerPath as string };
  const availability = await probeRunnerAvailability(settings, { env: process.env, execute });
  if (!availability.available) fail('RUNNER_PROTOCOL_UNAVAILABLE', availability.reason);
  const store = openStateStore(request.statePath);
  try {
    const tools = sessionTools(store, execute, manifest.configuration, context, options.execute);
    const session = tools.current(request.runId);
    if (session?.state !== 'reserved' || session.addressId !== request.address || session.activity?.cwd !== request.cwd || !session.launchContext || !isDeepStrictEqual(session.launchContext.assignment, request.assignment) || session.launchContext.reportPath !== join(request.tmpRoot, request.runId, `${request.address}.json`) || !isDeepStrictEqual({ runner: session.launchContext.selection.runner, model: session.launchContext.selection.model, effort: session.launchContext.selection.effort }, request.selection) || await fs.readFile(session.launchContext.briefPath, 'utf8') !== request.brief) fail('INVALID_CONTEXT', 'Worker launch does not match durable reserved context');
    const writeBoundaries = manifest.writeBoundaries ?? [];
    if (!Array.isArray(writeBoundaries) || !writeBoundaries.every(text) || !isDeepStrictEqual(writeBoundaries, session.launchContext.writeBoundaries ?? [])) fail('INVALID_CONTEXT', 'Worker write boundaries do not match durable launch context');
    const dependencies = await reservationTools(store, context, execute, options.execute);
    let lease: TaskReservationLease | null | undefined = listTaskReservations(store).find(set => set.lease.owner.runId === request.runId)?.lease;
    if (!lease) fail('TASK_CLAIM_REQUIRED', 'Worker has no fenced task reservation');
    lease = await handoffTaskReservations(dependencies, { lease, wrapper: await ownIdentity(execute, request.runId, request.tmuxSession) });
    if (!lease) fail('TASK_CLAIM_LOST', 'Worker handoff lost its task reservation');
    const invocation = buildRunnerInvocation(settings, request.selection);
    const writableDirectories = await runnerWritableDirectories(request.cwd, writeBoundaries, dirname(session.launchContext.reportPath), request.statePath);
    invocation.args.push(...writableDirectories.flatMap(path => ['--add-dir', path]));
    let screen = '';
    let nativeId: string | undefined;
    let actual: ProcessIdentity | undefined;
    const protocol: RunnerProtocol = {
      invocation: () => invocation,
      observe: pane => {
        screen = pane;
        nativeId = pane.match(/Session:\s*([0-9a-f]{8}-[0-9a-f-]{27,})/i)?.[1] ?? nativeId;
        const observation = observeRunnerScreen(settings, { text: pane, version: settings.version, requestedCommand: nativeId ? '/status' : null });
        if (observation.state === 'ready' && nativeId) return { status: 'ready', cliSessionId: nativeId };
        if (['auth_required', 'permission_required', 'quota_untrusted'].includes(observation.state)) return { status: 'failed', reason: observation.state };
        return { status: 'starting' };
      },
    };
    const adapter = new TmuxAgentAdapter({ execute, protocols: { [request.selection.runner]: protocol } as Record<AgentRunner, RunnerProtocol> });
    const adapterSession: AdapterSession = { tmuxSession: request.tmuxSession, selection: request.selection };
    const ownership = async (): Promise<LaunchOwnership> => {
      if (actual) { const result = (await observeProcesses([actual], { execute }))[0]; if (result.state === 'alive') return await belongsToPane(actual, execute) ? { state: 'owned', identity: actual, processKind: 'agent' } : { state: 'mismatch', reason: 'Native runner no longer belongs to the owned tmux pane' }; return { state: result.state, reason: result.state === 'unknown' ? result.error : result.evidence }; }
      if (!nativeId) return { state: 'unknown', reason: 'Native runner identity unavailable' };
      const pane = await execute({ executable: 'tmux', args: ['display-message', '-p', '-t', `=${request.tmuxSession}:0.0`, '#{pane_pid}'] });
      if (pane.exitCode !== 0 || !/^\d+$/.test(pane.stdout.trim())) return { state: 'unknown', reason: 'Owned tmux pane PID unavailable' };
      const rows = await processRows(execute);
      const descendants = new Set([Number(pane.stdout.trim())]);
      for (let size = -1; size !== descendants.size;) { size = descendants.size; for (const row of rows) if (descendants.has(row.ppid)) descendants.add(row.pid); }
      const matching = rows.filter(row => descendants.has(row.pid) && row.command.split(/\s+/).some(word => basename(word) === basename(invocation.executable)) && !/^(?:\S*\/)?(?:sh|bash|zsh)\s/.test(row.command));
      const candidates = matching.filter(candidate => !matching.some(other => { let pid = other.ppid; const seen = new Set<number>(); while (pid && !seen.has(pid)) { if (pid === candidate.pid) return true; seen.add(pid); pid = rows.find(row => row.pid === pid)?.ppid ?? 0; } return false; }));
      if (candidates.length !== 1) return { state: 'unknown', reason: 'Actual runner PID is ambiguous or unavailable; shell PID is not identity' };
      const row = candidates[0];
      actual = { pid: row.pid, startedAt: row.startedAt, runner: request.selection.runner, runnerSessionId: nativeId, tmuxSession: request.tmuxSession, evidence: { command: row.command, runId: request.runId, ...await dependencies.currentBoot(), ...(!options.execute ? { tmuxSocket: join(context.tmpRoot, 'tmux', 'server.sock') } : {}) } };
      return { state: 'owned', identity: actual, processKind: 'agent' };
    };
    const transport = adapter.createLaunchTransport({ reportWrapper: { wrap: command => command }, inspectOwnership: ownership, pollIntervalMs: settings.timeouts.pollMs });
    let requestedStatus = false;
    let submittedStatus = false;
    let retriedStatus = false;
    let statusDeadline = 0;
    const target = `=${request.tmuxSession}:0.0`;
    const composerInput = (text: string) => text.split('\n').findLast(line => /^\s*›(?:\s|$)/u.test(line))?.replace(/^\s*›\s?/u, '').trimEnd();
    const sendKeys = async (keys: string[]) => {
      const result = await execute({ executable: 'tmux', args: ['send-keys', '-t', target, ...keys] });
      if (result.exitCode !== 0) throw new Error('Runner status/navigation transport failed');
    };
    transport.waitReady = async timeoutMs => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const observed = await adapter.inspect(adapterSession);
        if (observed.status === 'ready' && observed.cliSessionId) return { state: 'ready', runnerSessionId: observed.cliSessionId };
        if (observed.status === 'exited') return { state: 'exited', reason: 'Runner exited before native identity' };
        if (observed.status === 'failed' || observed.status === 'limited') return { state: 'unknown_screen', reason: observed.reason };
        const observation = observeRunnerScreen(settings, { text: screen, version: settings.version, requestedCommand: requestedStatus ? settings.quotaCommand : null });
        if (observation.state === 'known_navigation') {
          const action = nextRunnerAction(settings, observation);
          if (action.kind !== 'keys') return { state: 'unknown_screen', reason: 'Unsupported startup navigation' };
          await sendKeys(action.keys);
          requestedStatus = false;
          submittedStatus = false;
          retriedStatus = false;
        } else if (observation.state === 'ready' && !nativeId && !requestedStatus) {
          requestedStatus = true;
          statusDeadline = Date.now() + settings.timeouts.transitionMs;
          await sendKeys(['-l', settings.quotaCommand!]);
        } else if (requestedStatus) {
          if (Date.now() >= statusDeadline) return { state: 'timeout', reason: 'Native status transition timed out' };
          if (!submittedStatus && screen.includes(settings.quotaCommand!)) {
            await sendKeys(['Enter']);
            submittedStatus = true;
          } else if (submittedStatus && !retriedStatus && /(?:›|>)\s*\/status(?:\s|$)/m.test(screen)) {
            await sendKeys(['Enter']);
            retriedStatus = true;
          } else if (nativeId && observation.state !== 'ready' && !['', settings.quotaCommand].includes(composerInput(screen) ?? '')) return { state: 'unknown_screen', reason: 'Unrecognized native-status transition screen' };
          else if (screen.trim() && !screen.includes(settings.quotaCommand!) && !/\bSession\b/.test(screen) && observation.state !== 'ready') return { state: 'unknown_screen', reason: 'Unrecognized native-status transition screen' };
        } else if (screen.trim() && observation.state !== 'ready') return { state: 'unknown_screen', reason: `Runner readiness ${observation.state}` };
        await new Promise(resolve => setTimeout(resolve, settings.timeouts.pollMs));
      }
      return { state: 'timeout', reason: 'Native runner readiness timed out' };
    };
    const gate = async (identity: ProcessIdentity) => {
      const current = tools.current(request.runId);
      if (current?.state === 'running' && current.process && sameIdentity(current.process, identity)) return;
      if (!lease) fail('TASK_CLAIM_LOST', 'Task reservation lost before brief');
      const next = await startTaskReservations(dependencies, { lease, agent: identity as Awaited<ReturnType<typeof ownIdentity>> });
      if (!next || !tools.state.commitStarted(request.runId, identity)) fail('TASK_CLAIM_LOST', 'Durable start gate rejected runner before brief');
      lease = next;
    };
    transport.deliver = async brief => {
      const owned = await ownership();
      if (owned.state !== 'owned') fail('PROCESS_IDENTITY_UNAVAILABLE', 'Runner ownership lost before durable start gate');
      await gate(owned.identity);
      const expectedIdentity = owned.identity;
      const verifyOwner = async () => {
        const current = await ownership();
        if (current.state !== 'owned' || !sameIdentity(current.identity, expectedIdentity) || nativeId !== expectedIdentity.runnerSessionId) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Native runner identity changed during initial brief delivery');
      };
      const initial = await adapter.inspect(adapterSession);
      if (initial.status !== 'ready' || initial.cliSessionId !== expectedIdentity.runnerSessionId) fail('RUNNER_DELIVERY_UNAVAILABLE', 'Runner is not on its known native input before initial brief delivery');
      const before = screen;
      const beforeLines = before.split('\n');
      const beforeComposer = beforeLines.findLastIndex(line => /^\s*›(?:\s|$)/u.test(line));
      const beforeInput = beforeLines[beforeComposer]?.replace(/^\s*›\s?/u, '').trimEnd();
      if (beforeInput === undefined || beforeInput !== '' && !settings.markers.ready?.includes(beforeInput)) fail('RUNNER_DELIVERY_UNAVAILABLE', 'Unknown native input before initial brief submission');
      const footer = (lines: string[], index: number) => lines.slice(index + 1).map(line => line.trim()).filter(Boolean).join('\n');
      const beforeFooter = beforeComposer < 0 ? undefined : footer(beforeLines, beforeComposer);
      const header = (lines: string[], index: number) => lines.slice(0, index).map(line => line.trim()).filter(Boolean).join('\n');
      const beforeHeader = beforeComposer < 0 ? undefined : header(beforeLines, beforeComposer);
      await adapter.deliver(adapterSession, brief);
      const deadline = Date.now() + settings.timeouts.transitionMs;
      const characters = [...brief].length;
      let previousPending: string | undefined;
      let retried = false;
      while (Date.now() < deadline) {
        const observed = await adapter.inspect(adapterSession);
        await verifyOwner();
        if (observed.status === 'exited' || observed.status === 'failed' || observed.status === 'limited') fail('RUNNER_DELIVERY_UNAVAILABLE', `Initial brief delivery stopped on ${observed.status}`);
        const lines = screen.split('\n');
        const composerIndex = lines.findLastIndex(line => /^\s*›(?:\s|$)/u.test(line));
        const composer = lines[composerIndex];
        const input = composer?.replace(/^\s*›\s?/u, '').trimEnd();
        const paste = input?.match(/^\[Pasted Content (\d+) chars\]$/u);
        const pending = paste ? Number(paste[1]) === characters || Number(paste[1]) === characters + 1 : !brief.includes('\n') && (input === brief || input === brief + '\n');
        const state = observeRunnerScreen(settings, { text: screen, version: settings.version, requestedCommand: '/status' }).state;
        const working = /^\s*•\s+[^\n]+\([^\n()]*esc to interrupt\)\s*$/mu;
        const emptyInput = input === '' || settings.markers.ready?.includes(input ?? '');
        if (!paste && emptyInput && working.test(screen) && !working.test(before)) {
          await verifyOwner();
          return;
        }
        const sameContext = beforeFooter !== undefined && footer(lines, composerIndex) === beforeFooter && header(lines, composerIndex) === beforeHeader;
        if (pending && (state === 'ready' || state === 'unknown_screen') && sameContext) {
          if (!retried && previousPending === input) {
            const pendingScreen = screen;
            await verifyOwner();
            const latest = await adapter.inspect(adapterSession);
            if ((latest.status === 'ready' || latest.status === 'starting') && screen === pendingScreen && nativeId === expectedIdentity.runnerSessionId) {
              await sendKeys(['Enter']);
              retried = true;
            }
          }
          previousPending = input;
        } else {
          previousPending = undefined;
          if (paste || state !== 'ready' && !working.test(screen)) fail('RUNNER_DELIVERY_UNAVAILABLE', 'Unknown native input or screen during initial brief submission');
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(settings.timeouts.pollMs, Math.max(0, deadline - Date.now()))));
      }
      fail('RUNNER_DELIVERY_UNAVAILABLE', 'Native initial brief acceptance timed out');
    };
    const assignments = assignmentPorts(execute);
    await runLaunchWrapper(request, {
      transport,
      report: {
        fs: { mkdir: async path => { await fs.mkdir(path, { recursive: true, mode: 0o700 }); }, readText: async path => { try { return await fs.readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }, removeTree: path => fs.rm(path, { recursive: true, force: true }) },
        watch: (directory, listener) => { const watcher = watch(directory, (event, filename) => { if (filename) void listener(event === 'rename' ? 'rename' : 'modify', filename.toString()).catch(error => process.emitWarning(error)); }); return () => watcher.close(); },
        now,
        verifyAssignmentCompletion: (assignment, archives) => verifyAssignmentCompletion(assignment, assignments, archives),
        diagnostic: async reason => { process.stderr.write(`${request.runId}: ${reason}\n`); },
      },
      lifecycle: {
        started: async handshake => {
          await gate(handshake.identity);
          await tools.control.started(request.runId);
        },
        acceptReport: async result => {
          if (result.report?.status === 'succeeded') {
            const verification = await verifyAssignmentCompletion(request.assignment, assignments, Object.fromEntries(result.report.changes.filter(change => change.archive).map(change => [change.id, change.archive!])));
            if (!verification.ok) fail('REPORT_UNVERIFIED', 'OpenSpec completion changed before result acceptance');
          }
          const value: WorkResult = { status: result.status, response: result.report?.answer ?? `Runner exited without an accepted report: ${JSON.stringify(result.exit)}`, proof: { runId: request.runId, at: result.at } };
          tools.verified.set(value, request.runId);
          const accepted = tools.state.acceptWorkResult(request.runId, value, { pending: [{ id: `${request.runId}:${result.event}`, runId: request.runId, event: result.event, payload: { kind: result.event, id: request.address } }], domain: [] });
          if (!accepted && !tools.current(request.runId)?.result) fail('REPORT_UNVERIFIED', 'Result could not be durably accepted for the running session');
          if (result.report && lease) {
            const succeeded = new Set(result.report.changes.flatMap(change => change.items.filter(item => item.status === 'succeeded').map(item => JSON.stringify([change.id, item.id]))));
            const subset = { ...request.assignment, changes: request.assignment.changes.map(change => ({ ...change, items: change.items.filter(item => succeeded.has(JSON.stringify([change.id, item.id]))) })).filter(change => change.items.length) };
            if (subset.changes.length && (await verifyAssignmentCompletion(subset, assignments, Object.fromEntries(result.report.changes.filter(change => change.archive).map(change => [change.id, change.archive!])))).ok) {
              const set = listTaskReservations(store).find(set => set.lease.owner.runId === request.runId);
              if (set) { const tasks = set.tasks.filter(task => succeeded.has(JSON.stringify([task.key.changeId, task.key.taskId]))); const completed = await completeTaskReservations(dependencies, { lease, tasks }); if (completed.applied) lease = completed.lease; }
            }
          }
        },
        finish: async (handshake, exit) => {
          let current = tools.current(request.runId)!;
          tools.state.commitObservation(request.runId, current.revision, { state: 'exited', observedAt: now(), exitCode: exit.code, evidence: `Owned tmux runner exit ${exit.signal ?? exit.code}` }, effects);
          current = tools.current(request.runId)!;
          await tools.finalize(current, current.activity ? [{ kind: 'ended', session: current, project: current.activity.project }] : []);
          if ((await adapter.inspect(adapterSession)).status === 'exited') await adapter.stop(adapterSession);
        },
        failed: async (_runId, reason, recoverable) => {
          if (recoverable) { process.stderr.write(`${request.runId}: recoverable launch: ${reason}\n`); return; }
          const current = tools.current(request.runId);
          if (current?.state === 'running' && current.process) {
            tools.state.commitObservation(request.runId, current.revision, { state: 'exited', observedAt: now(), exitCode: null, evidence: reason }, effects);
            const exited = tools.current(request.runId)!;
            await tools.finalize(exited, exited.activity ? [{ kind: 'ended', session: exited, project: exited.activity.project }] : []);
          }
          if (current?.state === 'reserved' && lease) await releaseTaskReservations(dependencies, { lease, reason: 'cancelled', closeLaunch: tx => closeSessionInTransaction(tx, { ...tx.getSession(request.runId)!, abortReason: reason }, now()) });
        },
      },
      handshake: channel.handshake,
    });
  } finally { store.close(); }
}
