import { loadCompiledCatalog } from './compiled-catalog.ts';
import { deliverCheckedMessage } from './message-delivery.ts';
import { deliverStartupContextEvents } from './startup-context-delivery.ts';
import { tryWaitLease } from './resource-wait-identity.ts';
import { runProductionModelHandoffs } from './production-model-handoff.ts';
import { scheduleWorkerHealthSummary } from './health-summary-runtime.ts';
import { settleRuntimeHealthCpu } from './health-cpu-runtime.ts';
import { RafCostRuntime, rafCostBoundary } from './raf-cost-runtime.ts';
import { sameProcessOwnership } from './process-identity.ts';
import { selectNativeLaunchProtocol, confirmAgySessionStart, type PrepareSessionStartChannel, type OwnedSessionStartChannel } from './agy-session-start.ts';
import { createRafToolSocketDirectory, rafSocketDirectory, releaseRafSocketDirectory, socketPathFits } from './raf-temporary-socket.ts';
import { ConfirmationTransientError, type ConfirmationBudget } from './report-confirmation-retry.ts';
import { reportConfirmationInputs } from './report-confirmation-inputs.ts';
import { createHash } from 'node:crypto';
import { loadEventCatalog } from './event-catalog.ts';
import { createStoredLaunchQueueEvents } from './stored-launch-queue-events.ts';
import { createProductionAgentQueue, reconcileFinishedAgentQueues } from './production-agent-queue.ts';
import { createAgentQueueState } from './agent-queue-state.ts';
import { reconcileHandoffLaunches } from './handoff-reconcile.ts';
import { resolveAgentResourceEstimate } from './resource-estimates.ts';
import { recordReportRejection, type ReportRejectionSnapshot } from './report-rejection.ts';
import { captureReportedCommitLaunchContext } from './reported-commits.ts';
import type { ReportedCommitLaunchContext } from './reported-commits-contract.ts';
import { prepareAgentClose } from './agent-close-preparation.ts';
import type { SandboxCallerControlSnapshot } from './sandbox-test-caller.ts';
import type { SandboxTestControlSnapshot, SandboxTestAssignment } from './sandbox-test-run.ts';
import { retainHotfixGeneration } from './hotfix-activation.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { agentChannelReadOnlyPaths } from './main-switch-agent-launcher.ts';
import { sharedLibraryReadOnlyPaths } from './shared-libs-sandbox.ts';
import { describeHotfixWorktree, refreshHotfixWorktree, startHotfixCommitPort, type HotfixWorkspace } from './hotfix-worktree.ts';
import { gitAllowed } from './git.ts';
import { productionStateContext, stateContextEnvironment, stateFailure } from './state-migration-guard.ts';
import { promises as fs, watch } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, basename, resolve, relative, sep } from 'node:path';
import { homedir, platform, availableParallelism, loadavg, totalmem } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { RuntimeConfiguration, RuntimeContext, RuntimeServices, RuntimeLaunch } from './app-runtime.ts';
import { TmuxAgentAdapter, type AdapterCommandExecutor, type AgentRunner, type RunnerProtocol, type AdapterSession } from './agent-adapters.ts';
import { redactDeliveryText, type DeliveryFrame } from './delivery-diagnostic.ts';
import { preserveFailedDeliveryEvidence } from './delivery-evidence.ts';
import { privateDeliveryEvidencePorts, cleanupExpiredDeliveryEvidence } from './delivery-evidence-storage.ts';
import { buildRunnerInvocation, observeRunnerScreen, nextRunnerAction, readNativeComposer, matchPendingBrief, readNativeSessionId, isNativeWorking, isNativeFinished, nativeDeliveryContext, matchesNativeDeliveryContext, nativeWriteScopeArgs, nativeSandboxArgs, type ProtocolSettings, type NativeDialect } from './runner-protocols.ts';
import { openStateStore, retryStateOperation, type StateStore } from './state-store.ts';
import { validateAssignment, composeAssignmentBrief, verifyAssignmentCompletion } from './assignment.ts';
import { createAssignmentIdentityAdapter } from './assignment-identity.ts';
import { createWorkspacePorts, executeCommand, observeKnownProcesses, observeProcessSnapshot, createResourceSnapshotReader, readMachineBootIdentity } from './os-runtime.ts';
import { resolveWorkspaceRoute } from './workspace-routing.ts';
import { selectModel, listModelAvailability, type RoutingSnapshot } from './model-routing.ts';
import { createLaunchState, reserveLaunchInTransaction, evaluateLaunchAdmissionInTransaction } from './launch-state.ts';
import { createSessionState, closeSessionInTransaction, type ProcessIdentity, type SessionRecord, type WorkResult } from './session-state.ts';
import { AgentControlService, MainAttachedElsewhereError, type VerifiedSender, type ActivityEvent, type MainAttachment } from './agent-control.ts';
import { ReminderService, type SessionEnd } from './reminders.ts';
import { evaluateResourceAdmission, type ResourceAdmission, type ResourceAdmissionInput } from './resource-admission.ts';
import { buildAdmissionSnapshot, type AdmissionSnapshot } from './admission-snapshot.ts';
import { loadFlowPolicy, type FlowPolicy } from './flow-policy.ts';
import { deriveResourceAdmissionVolumes } from './home-disk-admission.ts';
import { claimTaskReservations, handoffTaskReservations, startTaskReservations, completeTaskReservations, releaseTaskReservations, reconcileTaskReservations, listTaskReservations, type TaskReservationDependencies, type TaskReservationLease } from './task-reservations.ts';
import { launchPersistentWrapper, runLaunchWrapper, consumeWrapperRequest, type LaunchHandshake, type LaunchOwnership, type PersistentWrapperFailure } from './launch-wrapper.ts';
import { commandFailure, failureContext } from './cli-contract.ts';
import { loadTaskContextConfiguration, deriveTaskContext, assignmentFingerprint, writeTaskContextFile, rafCommandFor, rafSubcommandsFor } from './task-context.ts';
import { probeRunnerAvailability, resolveRunnerExecutable } from './runner-availability.ts';
import type { ReminderSessionEffect } from './reminder-repository.ts';
import { collectRunnerQuotas, readQuotaViews, type CollectionError, type CollectionLock, type CollectionResult, type CurrentQuota, type ProbeTransport, type QuotaCurrentStore } from './quota-collection.ts';
import { parseRunnerLimitScreen, validateQuotaProtocol, quotaProbeInvocation, routingQuotaEntries, type QuotaProtocol, type ScreenQuotaView } from './quota-screens.ts';
import type { RunnerId } from './runner-protocols.ts';
import { NO_REPORT_REASON, NOTIFY_TARGET_INVALID } from './launcher-notice.ts';
import { settleCommandState, settleResultNotices, resultNoticeViews } from './reminder-cli.ts';
import { readPendingAgentReport, verifyPendingAgentReportFreshness, rejectPendingAgentReport, type AgentReport, type AgentReportRequest } from './agent-report.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation } from './task-checkbox-report.ts';
import { finalizeStartupContextRun, reserveStartupContextReview, cleanupStartupContextCompleted } from './startup-context-lifecycle.ts';
import { startupContextRuntimeFiles, startupContextAcceptedReport } from './startup-context-runtime.ts';
import { readStartupContextTrace } from './startup-context.ts';
import { prepareCodexRafCommandAccess, codexInvocationSandboxMode, type PreparedCodexRafCommandAccess } from './codex-raf-command-access.ts';
import { prepareCodexSandbox, CodexSandboxUnavailable, type PreparedCodexSandbox } from './codex-sandbox.ts';
import { interruptAgentAction } from './agent-interrupt.ts';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(text);
const now = () => new Date().toISOString();
const effects = { pending: [], domain: [] };
const json = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'));
async function readReportBytes(path: string): Promise<Uint8Array | null> {
  try { return await fs.readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const fail: (code: string, reason: string) => never = (code, reason) => { throw commandFailure({ code, message: reason, reason, stage: 'production-runtime', source: 'production-runtime', sourceCode: null, received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true, remediation: ['Уточніть контекст або конфігурацію потрібного production компонента.'] }); };
const sameIdentity = sameProcessOwnership;
const mainRemediation = 'Виконайте raf main attach у tmux-панелі сесії main, не змінюючи змінних TMUX і TMUX_PANE.';
const mainFail = (code: string, reason: string, remediation: string, found: unknown = null): never => { throw commandFailure({ code, message: reason, reason, stage: 'main-attach', source: 'production-runtime', sourceCode: null, received: null, expected: null, found, completed: [], pending: [], retrySafe: true, remediation: [remediation] }); };

const launchFailurePath = (tmpRoot: string, runId: string) => join(tmpRoot, runId, 'launch-failure.json');
async function workerLaunchFailure(tmpRoot: string, runId: string, wrapper: PersistentWrapperFailure['wrapper'] | undefined) {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(launchFailurePath(tmpRoot, runId), 'utf8')); } catch { return undefined; }
  if (!object(value) || value.code !== 'RUNNER_WORKSPACE_UNTRUSTED' || !text(value.reason) || !strings(value.remediation)) return undefined;
  return Object.assign(commandFailure({ code: value.code, message: value.reason, reason: value.reason, stage: 'readiness', source: 'production-runtime', sourceCode: null, received: null, expected: null, found: value.found ?? null, completed: [], pending: [], retrySafe: true, remediation: value.remediation }), { wrapper });
}

export const rafSystemCaller: Readonly<Record<string, never>> = Object.freeze({});

async function protocols(confRoot: string, override?: readonly ProtocolSettings[]): Promise<readonly ProtocolSettings[]> {
  if (override) return override;
  const settings = await json(join(confRoot, 'raf.json'));
  if (settings.version !== 1 || !Array.isArray(settings.runnerProtocols)) fail('RUNNER_PROTOCOL_UNAVAILABLE', 'conf/raf.json#runnerProtocols requires versioned installed runner settings and measured time budgets');
  return settings.runnerProtocols;
}
const codexStatusDialect: NativeDialect = {
  identity: { source: 'status', command: '/status', pattern: 'Session:\\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', dismissKeys: [] },
  composer: '^\\s*›(?:\\s|$)',
  pendingPaste: { pattern: '^\\[Pasted Content (\\d+) chars\\]$', unit: 'characters' },
  working: '^\\s*•\\s+[^\\n]+\\([^\\n()]*esc to interrupt\\)\\s*$',
  writeScope: { directoryFlag: '--add-dir', ruleFlag: null, rule: null },
  exitCommand: '/exit',
  startup: [],
};
function protocolFor(settings: readonly ProtocolSettings[], runner: string): ProtocolSettings {
  const matches = settings.filter(row => row.runner === runner);
  const found = matches[0];
  const native = found?.native ?? (runner === 'codex' && found?.quotaCommand === '/status' ? codexStatusDialect : undefined);
  if (!native) fail('RUNNER_IDENTITY_UNAVAILABLE', `Pre-brief native identity evidence is unavailable for ${runner}`);
  const value = { ...found, native } as ProtocolSettings;
  if (matches.length !== 1 || !found || typeof value.liveTaskVerified !== 'boolean' || !text(value.executable) || !text(value.version) || !Array.isArray(value.baseArgs) || !value.baseArgs.every(text) || !text(value.modelFlag) || !text(value.effortFlag) || !['literal', 'codex_config'].includes(value.effortFormat) || !object(value.modelAliases) || !Array.isArray(value.navigation) || !object(value.markers) || !strings(value.markers.ready) || !object(value.timeouts) || Object.values(value.timeouts).some(n => !Number.isFinite(n) || n <= 0) || !['startupMs', 'transitionMs', 'overallMs', 'pollMs'].every(key => Number.isFinite(value.timeouts[key]) && value.timeouts[key] > 0)) fail('RUNNER_PROTOCOL_UNAVAILABLE', `Runner ${runner} lacks a validated versioned invocation/readiness protocol and deadlines`);
  try { selectNativeLaunchProtocol(value); } catch (error) { fail('RUNNER_PROTOCOL_UNAVAILABLE', error instanceof Error ? error.message : String(error)); }
  return value;
}
async function registeredBranchDirectory(orchestratorRoot: string, confRoot: string, cwd: string, task?: { type: string; project: string; branch: string }, execute: AdapterCommandExecutor = executeCommand): Promise<boolean> {
  const real = async (path: string) => fs.realpath(path).catch(() => undefined);
  const root = await real(orchestratorRoot);
  if (!root || !isAbsolute(cwd)) return false;
  const projects = await json(join(confRoot, 'projects.json')).catch(() => undefined);
  const paths = object(projects?.projects) ? Object.values(projects.projects).flatMap(entry => object(entry) && object(entry.branchPaths) ? Object.values(entry.branchPaths).filter(text) : []) : [];
  const candidate = resolve(root, relative(orchestratorRoot, cwd));
  if (await real(candidate) !== candidate || await real(cwd) !== candidate) return false;
  if (candidate === root) {
    if (!task || !['spec', 'design'].includes(task.type) || task.project !== 'orchestrator' || !text(task.branch) || projects?.projects?.orchestrator?.path !== '.') return false;
    const route = await resolveWorkspaceRoute({ root, project: task.project, branch: task.branch }, projects, createWorkspacePorts());
    return route.ok && route.cwd === candidate;
  }
  return paths.some(path => resolve(root, path) === candidate);
}
async function runnerWorkspaceUntrusted(request: { cwd: string; tmpRoot: string; runId: string }, runner: string, answered = false): Promise<never> {
  const root = request.cwd;
  const answer = answered ? 'the prompt stayed after the protocol navigation keys' : 'raf answers it only for a registered branch directory or a verified spec/design Orchestrator root from conf/projects.json';
  const reason = `RUNNER_WORKSPACE_UNTRUSTED: runner ${runner} asks to trust workspace ${request.cwd}; ${answer}; raf does not edit CLI configuration`;
  const failure = { code: 'RUNNER_WORKSPACE_UNTRUSTED', reason, found: { cwd: request.cwd, runner }, remediation: [`Запускайте агента з каталогу гілки з conf/projects.json branchPaths; інший каталог ${root} власник довіряє вручну в діалозі ${runner} CLI.`] };
  await fs.writeFile(launchFailurePath(request.tmpRoot, request.runId), JSON.stringify(failure), { mode: 0o600, flag: 'wx' }).catch(() => undefined);
  return fail(failure.code, reason);
}
async function runnerWorkspaceTrusted(context: Pick<RuntimeContext, 'orchestratorRoot' | 'confRoot'>, cwd: string, runner: string, task: { type: string; project: string; branch: string } | undefined, hotfix: HotfixWorkspace | undefined, execute: AdapterCommandExecutor): Promise<boolean> {
  if (!['codex', 'claude'].includes(runner)) return true;
  return hotfix ? cwd === hotfix.cwd : await registeredBranchDirectory(context.orchestratorRoot, context.confRoot, cwd, task, execute);
}
async function runnerWritableDirectories(cwd: string, boundaries: readonly string[], reportDirectory: string, statePath: string, exactFiles = false, orchestratorRoot?: string): Promise<{ directories: string[]; workspace: string[] }> {
  const workspace = await fs.realpath(cwd);
  const stateDirectory = await fs.realpath(dirname(statePath));
  const inside = (root: string, path: string) => {
    const suffix = relative(root, path);
    return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
  };
  const directories = new Set<string>();
  const inWorkspace = new Set<string>();
  for (const boundary of boundaries) {
    const target = resolve(workspace, boundary);
    let directory: string;
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory() && !stat.isFile()) fail('RUNNER_WRITE_SCOPE_INVALID', 'Declared write boundary is not a file or directory');
      const canonical = await fs.realpath(target);
      directory = stat.isDirectory() || exactFiles ? canonical : dirname(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const missingFile = exactFiles && !boundary.endsWith(sep);
      const root = missingFile && orchestratorRoot ? await fs.realpath(orchestratorRoot) : undefined;
      if (missingFile && (!root || !inside(resolve(orchestratorRoot!), target) || target === resolve(orchestratorRoot!))) fail('RUNNER_WRITE_SCOPE_INVALID', 'Missing file boundary must lie inside Orchestrator');
      if (missingFile && await fs.lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      })) fail('RUNNER_WRITE_SCOPE_INVALID', 'Missing file boundary must not be a dangling link');
      let parent = boundary.endsWith(sep) ? target : dirname(target);
      const missing: string[] = [];
      for (;;) {
        try { directory = resolve(await fs.realpath(parent), ...missing); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error;
          if (missingFile && await fs.lstat(parent).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return null;
          })) fail('RUNNER_WRITE_SCOPE_INVALID', 'Missing file boundary has an unresolved ancestor');
          missing.unshift(basename(parent));
          parent = dirname(parent);
        }
      }
      if (missingFile) {
        const intended = join(directory, basename(target));
        if (!inside(root!, directory) || inside(intended, workspace) || inside(intended, stateDirectory) || inside(stateDirectory, intended)) fail('RUNNER_WRITE_SCOPE_INVALID', 'Missing file boundary exceeds the declared task scope');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const canonicalParent = await fs.realpath(directory);
        if (!inside(root!, canonicalParent)) fail('RUNNER_WRITE_SCOPE_INVALID', 'Missing file parent lies outside Orchestrator');
        const file = await fs.open(join(canonicalParent, basename(target)), 'wx', 0o600);
        await file.close();
        directory = await fs.realpath(target);
      }
    }
    if (inside(workspace, directory)) { inWorkspace.add(directory); continue; }
    if (inside(directory, workspace) || inside(directory, stateDirectory) || inside(stateDirectory, directory)) fail('RUNNER_WRITE_SCOPE_INVALID', 'Declared write boundary would grant a workspace ancestor or RAF state directory');
    if (!(await fs.stat(directory).catch(() => null))?.isFile()) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const canonical = await fs.realpath(directory);
    if (inside(canonical, workspace) || inside(canonical, stateDirectory) || inside(stateDirectory, canonical)) fail('RUNNER_WRITE_SCOPE_INVALID', 'Resolved write directory exceeds the declared task scope');
    directories.add(canonical);
  }
  directories.add(await fs.realpath(reportDirectory));
  return { directories: [...directories], workspace: [...inWorkspace] };
}
async function runnerSandboxScope(type: string | undefined, reportDirectory: string, statePath: string) {
  const report = await fs.realpath(reportDirectory);
  const secrets = [...new Set([join(dirname(statePath), 'secrets.json'), join(await fs.realpath(dirname(statePath)), 'secrets.json')])];
  const command = rafCommandFor();
  const subcommands = type === undefined ? [] : rafSubcommandsFor(type);
  return {
    hidden: secrets,
    readable: [report], tmuxDirectory: report, excludedCommands: subcommands === null ? [`${command}:*`] : subcommands.map(subcommand => `${command} ${subcommand}:*`),
  };
}


export async function sandboxTestControlSnapshot(store: StateStore, root: string, project: string, group: string, validatedConfiguration?: { projects: Record<string, unknown>; config: SandboxTestControlSnapshot['config'] }): Promise<SandboxCallerControlSnapshot> {
  const { rows, chain } = await ancestry(executeCommand);
  const boot = await readMachineBootIdentity();
  const sessions = store.sessionRepository.transaction(tx => tx.listSessions(), 'read');
  const activeChanges = (await fs.readdir(join(root, 'openspec/changes'), { withFileTypes: true })).filter(row => row.isDirectory() && row.name !== 'archive').map(row => row.name);
  const projects = validatedConfiguration ? validatedConfiguration.projects : JSON.parse(await fs.readFile(join(root, 'conf/projects.json'), 'utf8')).projects;
  const config = validatedConfiguration ? validatedConfiguration.config : JSON.parse(await fs.readFile(join(root, 'conf/test-runs.json'), 'utf8'));
  const workspaces: SandboxTestControlSnapshot['workspaces'][number][] = [];
  for (const [id, value] of Object.entries(projects) as [string, any][]) for (const [branch, path] of Object.entries(value.branchPaths ?? { main: value.path })) {
    const workspace = resolve(root, String(path));
    if (id !== project) continue;
    try {
      if (await fs.realpath(workspace) !== workspace) continue;
      workspaces.push({ project: id, workspace, branch });
    } catch {}
  }
  const claims = sessions.filter(session => session.process && chain.includes(session.process.pid)).map(session => {
    const identity = session.process!;
    let assignment = session.launchContext?.testAssignment ?? null;
    if (session.addressId === 'main' && session.activity?.type === 'main') {
      const workspace = workspaces.find(row => row.workspace === process.cwd());
      if (workspace) assignment = { runId: session.runId, agentId: session.addressId, type: 'main', phase: 'main', project, workspace: workspace.workspace, branch: workspace.branch, changes: activeChanges };
    }
    if (assignment) {
      const delegatedByMain = session.delegatedBy?.addressId === 'main' && sessions.some(row => row.runId === session.delegatedBy!.runId && row.addressId === 'main');
      assignment = { ...assignment, delegatedByMain };
    }
    return { process: { pid: identity.pid, startedAt: identity.startedAt, machineId: identity.evidence.machineId ?? '', bootId: identity.evidence.bootId ?? '' }, state: session.state === 'running' ? 'running' as const : 'finished' as const, runId: session.runId, assignment };
  });
  const ancestors = chain.flatMap(pid => {
    const row = rows.find(row => row.pid === pid);
    if (!row) return [];
    const registered = sessions.filter(session => session.process?.pid === pid && Date.parse(session.process.startedAt) === Date.parse(row.startedAt) && session.state === 'running');
    return [{ pid, startedAt: row.startedAt, parentPid: row.ppid || null, ...boot, originVerified: registered.every(session => session.process!.evidence.command === row.command) }];
  });
  const caller = ancestors.find(row => row.pid === process.pid);
  if (!caller) throw new Error('Host CLI ancestry is unavailable');
  return {
    ancestors: chain.flatMap(pid => { const row = rows.find(row => row.pid === pid); return row ? [{ pid, startedAt: row.startedAt }] : []; }),
    callerEvidence: { caller: { pid: caller.pid, startedAt: caller.startedAt }, ...boot, ancestors, claims },
    sessions: claims.map(claim => ({ process: claim.process, state: claim.state, assignment: claim.assignment! })), workspaces, activeChanges,
    config,
    groups: workspaces.flatMap(row => config.projects?.[row.project]?.groups?.[group] ? [{ project: row.project, workspace: row.workspace, group }] : []),
  };
}
async function runtimeTmuxSocket(context: Pick<RuntimeContext, 'tmpRoot' | 'stateContext'>, environment: NodeJS.ProcessEnv): Promise<string> {
  const directory = join(context.tmpRoot, 'tmux');
  const logicalSocket = join(directory, 'server.sock');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const owner = await fs.lstat(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0) fail('TMUX_CONTEXT_INVALID', 'RAF tmux directory must be private and owned by the current user');
  const socketPath = socketPathFits(logicalSocket) ? logicalSocket : join(rafSocketDirectory(directory), 'server.sock');
  const socket = await fs.lstat(logicalSocket).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (socket && (!socket.isSocket() || socket.uid !== process.getuid?.())) fail('TMUX_CONTEXT_INVALID', 'RAF tmux socket has foreign ownership or file type');
  if (context.stateContext?.mode === 'qa' && socket) {
    const live = await new Promise<boolean>((resolve, reject) => {
      const connection = createConnection(socketPath);
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', error => {
        connection.destroy();
        if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(false);
        else reject(stateFailure('STATE_CONTEXT_REFUSED', 'Existing QA tmux server context cannot be verified; stop the stand server and retry'));
      });
    });
    if (live) {
      for (const key of ['HOME', 'RAF_QA_HOME']) {
        const observed = await executeCommand({ executable: 'tmux', args: ['-S', socketPath, 'show-environment', '-g', key], environment });
        if (observed.exitCode !== 0 || observed.stdout.trim() !== `${key}=${context.stateContext.homeDirectory}`) {
          throw stateFailure('STATE_CONTEXT_REFUSED', `Existing QA tmux server has foreign ${key}; stop the stand server and retry`);
        }
      }
    }
  }
  return socketPath;
}
const runtimeEnvironments = new WeakMap<AdapterCommandExecutor, () => NodeJS.ProcessEnv>();
export function runtimeExecution(context: Pick<RuntimeContext, 'tmpRoot' | 'stateContext'>, override?: AdapterCommandExecutor, snapshotEnvironment = false): AdapterCommandExecutor {
  if (override) return override;
  const preparedEnvironment = snapshotEnvironment ? { ...(context.stateContext ? stateContextEnvironment(context.stateContext, process.env) : process.env) } : undefined;
  const environmentForCommand = () => preparedEnvironment ?? (context.stateContext ? stateContextEnvironment(context.stateContext, process.env) : process.env);
  const observationEnvironment = { ...process.env };
  if (context.stateContext) {
    const state = context.stateContext;
    Object.assign(observationEnvironment, { HOME: state.homeDirectory, RAF_HOME_DIRECTORY: state.homeDirectory,
      RAF_ORCHESTRATOR_ROOT: state.orchestratorRoot, RAF_STATE_DIRECTORY: dirname(state.statePath), RAF_SOCKET_PATH: join(dirname(state.statePath), 'service.sock') });
    delete observationEnvironment.ALLOW_MIGRATIONS;
    if (state.mode === 'qa') { observationEnvironment.RAF_QA_HOME = state.homeDirectory; delete observationEnvironment.TMUX; delete observationEnvironment.TMUX_PANE; }
    else delete observationEnvironment.RAF_QA_HOME;
  }
  const execute: AdapterCommandExecutor = async command => {
    const observation = command.executable === 'ps' || command.executable === 'tmux' &&
      ['capture-pane', 'display-message', 'list-panes', 'list-sessions', 'show-environment'].includes(command.args[0]);
    const environment = { ...(observation ? observationEnvironment : environmentForCommand()), ...command.environment };
    if (command.executable !== 'tmux') return executeCommand({ ...command, environment });
    const socketPath = await runtimeTmuxSocket(context, environment);
    const args = [...command.args];
    if (context.stateContext && args[0] === 'new-session') {
      args.splice(1, 0, ...['HOME', 'RAF_QA_HOME'].flatMap(key => environment[key] === undefined ? [] : ['-e', `${key}=${environment[key]}`]));
    }
    const result = await executeCommand({ ...command, environment, args: ['-S', socketPath, ...args] });
    await fs.chmod(socketPath, 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    return result;
  };
  runtimeEnvironments.set(execute, environmentForCommand);
  return execute;
}
async function bootIdentity(execute: AdapterCommandExecutor) {
  try { return await readMachineBootIdentity(execute); }
  catch (error) { return fail('PROCESS_IDENTITY_UNAVAILABLE', error instanceof Error ? error.message : String(error)); }
}
async function processRows(execute: AdapterCommandExecutor, pid?: number) {
  const result = await execute({ executable: 'ps', args: pid === undefined ? ['-ww', '-axo', 'pid=,ppid=,lstart=,command='] : ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,lstart=,command='] });
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
  if (identity.nativeIdentity || identity.evidence.tmuxPane !== undefined) {
    const paneId = await execute({ executable: 'tmux', args: ['display-message', '-p', '-t', `=${identity.tmuxSession}:0.0`, '#{pane_id}'] });
    if (paneId.exitCode !== 0 || paneId.stdout.trim() !== identity.evidence.tmuxPane) return false;
  }
  if ((await observeIdentity(identity, execute)).state !== 'alive') return false;
  let pid = identity.pid;
  const seen = new Set<number>();
  while (pid && !seen.has(pid)) {
    if (pid === Number(pane.stdout.trim())) return true;
    seen.add(pid);
    const row = (await processRows(execute, process.platform === 'linux' ? pid : undefined)).find(row => row.pid === pid);
    if (!row) return false;
    if (pid === identity.pid && (Date.parse(row.startedAt) !== Date.parse(identity.startedAt) || row.command !== identity.evidence.command)) return false;
    pid = row.ppid;
  }
  return false;
}
async function ownIdentity(execute: AdapterCommandExecutor, runId: string, tmuxSession: string) {
  const row = (await processRows(execute, process.platform === 'linux' ? process.pid : undefined)).find(row => row.pid === process.pid);
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
const processObservationPass = new AsyncLocalStorage<{ execute: AdapterCommandExecutor; observations: Map<string, Promise<ProcessObservation>>; snapshot?: ReturnType<typeof observeProcessSnapshot> }>();
async function observeIdentity(identity: ProcessIdentity, execute: AdapterCommandExecutor) {
  return (await observeIdentities([identity], execute))[0];
}
async function observeIdentities(identities: readonly ProcessIdentity[], execute: AdapterCommandExecutor) {
  const pass = processObservationPass.getStore();
  const observationsByIdentity = pass?.execute === execute ? pass.observations : new Map<string, Promise<ProcessObservation>>();
  const key = (identity: ProcessIdentity) => JSON.stringify(identity);
  const missing = [...new Map(identities.filter(identity => !observationsByIdentity.has(key(identity))).map(identity => [key(identity), identity])).values()];
  const batch = pass?.execute === execute
    ? missing.length ? (async () => {
      const observe = await (pass.snapshot ??= observeProcessSnapshot({ execute }));
      const observations = observe(missing);
      if (!observations.some(observation => observation.state === 'unknown' && observation.error.startsWith('Process snapshot predates process start'))) return observations;
      pass.snapshot = observeProcessSnapshot({ execute });
      return (await pass.snapshot)(missing);
    })() : Promise.resolve([])
    : observeKnownProcesses(missing, { execute });
  let boot: ReturnType<typeof bootIdentity> | undefined;
  missing.forEach((identity, index) => observationsByIdentity.set(key(identity), (async () => {
    const observation = (await batch)[index];
    if (observation.state !== 'alive' || !identity.evidence.bootId) return observation;
    try {
      const current = await (boot ??= bootIdentity(execute));
      if (current.bootId === identity.evidence.bootId && current.machineId === identity.evidence.machineId) return observation;
      return { state: 'exited' as const, observedAt: observation.observedAt, exitCode: null, evidence: 'Process identity belongs to a previous boot' };
    } catch (error) {
      return { state: 'unknown' as const, observedAt: observation.observedAt, error: String(error) };
    }
  })()));
  return Promise.all(identities.map(identity => observationsByIdentity.get(key(identity))!));
}
async function processExited(execute: AdapterCommandExecutor, identity: ProcessIdentity, budget: { transitionMs: number; pollMs: number }): Promise<boolean> {
  const deadline = Date.now() + budget.transitionMs;
  for (;;) {
    if ((await observeKnownProcesses([identity], { execute }))[0].state === 'exited') return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, budget.pollMs));
  }
}
async function discardOwnedTmuxSession(execute: AdapterCommandExecutor, tmuxSession: string, budget: { transitionMs: number; pollMs: number }): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(tmuxSession)) return false;
  const panes = await execute({ executable: 'tmux', args: ['list-panes', '-s', '-t', `=${tmuxSession}`, '-F', '#{pane_pid}'] });
  if (panes.exitCode !== 0) {
    const sessions = await execute({ executable: 'tmux', args: ['list-sessions', '-F', '#{session_name}'] });
    if (sessions.exitCode === 0) return !sessions.stdout.split('\n').includes(tmuxSession);
    return /no server running|error connecting/i.test(sessions.stderr);
  }
  const roots = panes.stdout.split('\n').filter(line => /^\d+$/.test(line.trim())).map(Number);
  const rows = await processRows(execute);
  const descendants = new Set(roots);
  for (let size = -1; size !== descendants.size;) { size = descendants.size; for (const row of rows) if (descendants.has(row.ppid)) descendants.add(row.pid); }
  const owned = rows.filter(row => descendants.has(row.pid));
  const killed = await execute({ executable: 'tmux', args: ['kill-session', '-t', `=${tmuxSession}`] });
  if (killed.exitCode !== 0 && !/can't find session|no server running|error connecting/i.test(killed.stderr)) return false;
  let deadline = Date.now() + budget.transitionMs;
  let forced = false;
  for (;;) {
    const current = await processRows(execute);
    const survivors = owned.filter(row => current.some(candidate => candidate.pid === row.pid && candidate.startedAt === row.startedAt));
    if (!survivors.length) return true;
    if (Date.now() >= deadline) {
      if (forced) return false;
      forced = true;
      deadline = Date.now() + budget.transitionMs;
      for (const row of survivors) { try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    }
    await new Promise(resolve => setTimeout(resolve, budget.pollMs));
  }
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
function recordedMainRunner(command: string, rows: readonly Pick<ProtocolSettings, 'runner' | 'executable'>[]): string | undefined {
  const names = new Map<string, string>();
  for (const row of rows) {
    for (const name of [row.runner, row.executable]) {
      const key = name.trim().toLowerCase();
      if (key) names.set(key, row.runner);
    }
  }
  for (const token of command.split(/\s+/)) {
    if (!token || token.startsWith('-')) continue;
    const base = token.replace(/^['"]+|['"]+$/g, '').split(/[/\\]/).pop()?.replace(/\.(?:exe|js|mjs|cjs)$/i, '').toLowerCase();
    const runner = base ? names.get(base) : undefined;
    if (runner) return runner;
  }
  return undefined;
}
function protocolExecutableInCommand(command: string, rows: readonly Pick<ProtocolSettings, 'runner' | 'executable'>[]): string | undefined {
  const executables = new Map<string, string>();
  for (const row of rows) {
    const key = row.executable.trim().toLowerCase();
    if (key) executables.set(key, row.runner);
  }
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index];
    if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token.at(-1) === token[0]) token = token.slice(1, -1);
    if (!token || token.startsWith('-') || token.includes('=')) continue;
    const base = token.split(/[/\\]/).pop()?.replace(/\.exe$/i, '').toLowerCase();
    const runner = base ? executables.get(base) : undefined;
    if (runner && (index === 0 || token.includes('/') || token.includes('\\'))) return runner;
  }
  return undefined;
}
async function mainRunnerFromPaneLineage(pid: number, execute: AdapterCommandExecutor, rows: readonly Pick<ProtocolSettings, 'runner' | 'executable'>[]): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const processes = await processRows(execute);
  const children = new Map<number, number[]>();
  for (const row of processes) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const byPid = new Map(processes.map(row => [row.pid, row]));
  const seen = new Set<number>([pid]);
  const found = new Set<string>();
  for (let frontier = children.get(pid) ?? []; frontier.length;) {
    const next: number[] = [];
    for (const child of frontier) {
      if (seen.has(child)) continue;
      seen.add(child);
      const row = byPid.get(child);
      if (!row) continue;
      const runner = protocolExecutableInCommand(row.command, rows);
      if (runner) found.add(runner);
      for (const grandchild of children.get(child) ?? []) next.push(grandchild);
    }
    frontier = next;
  }
  return found.size === 1 ? [...found][0] : undefined;
}
function mainAttachment(session: SessionRecord): MainAttachment {
  const identity = session.process!;
  return { id: 'main', runId: session.runId, tmuxSocket: identity.evidence.tmuxSocket, tmuxSession: identity.tmuxSession, tmuxPane: identity.evidence.tmuxPane, pid: identity.pid, startedAt: identity.startedAt, machineId: identity.evidence.machineId, bootId: identity.evidence.bootId };
}
type TransitionBudget = { transitionMs: number; pollMs: number };
function recordLaunchFailure(store: StateStore, runId: string, reason: string): void {
  store.sessionRepository.transaction(tx => {
    const session = tx.getSession(runId);
    if (!session || session.abortReason || session.result?.status === 'succeeded') return;
    tx.putSession({ ...session, revision: session.revision + 1, abortReason: reason.slice(0, 4096) });
  });
}
async function waitWrapperExit(execute: AdapterCommandExecutor, wrapper: ProcessIdentity, budget: TransitionBudget): Promise<boolean> {
  const deadline = Date.now() + budget.transitionMs;
  for (;;) {
    if ((await observeKnownProcesses([wrapper], { execute }))[0].state === 'exited') return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, budget.pollMs));
  }
}
export async function confirmReportedTasks(store: StateStore, context: RuntimeContext, execute: AdapterCommandExecutor, request: AgentReportRequest, report: AgentReport, budget: TransitionBudget, identityExecute?: AdapterCommandExecutor, confirmationBudget?: ConfirmationBudget, beforeWrite?: () => Promise<void>) {
  const directory = join(context.tmpRoot, request.runId);
  const journal = join(directory, 'task-checkbox-operations.json');
  const assignments = assignmentPorts(execute);
  const confirmation = await prepareReportedTaskCheckboxes(request, report, {
    budget: confirmationBudget,
    verifyAssignmentCompletion: (assignment, archives) => verifyAssignmentCompletion(assignment, assignments, archives),
    operations: {
      read: async () => { try { return JSON.parse(await fs.readFile(journal, 'utf8')) as TaskCheckboxOperation[]; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } },
      write: async (_runId, operations) => {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${journal}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, JSON.stringify(operations), { mode: 0o600 }); await fs.rename(temporary, journal); }
        finally { await fs.rm(temporary, { force: true }); }
      },
    },
    executeGit: async (args, options) => {
      const environment = identityExecute ? { ...(runtimeEnvironments.get(execute)?.() ?? (context.stateContext ? stateContextEnvironment(context.stateContext, process.env) : process.env)), ...options.env } : options.env;
      if (!gitAllowed()) throw new ConfirmationTransientError('index-busy', 'Checkbox commit is left to the worker; raf commands do not run git');
      const result = await (identityExecute ?? execute)({ executable: 'git', args, cwd: options.cwd, environment });
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    beforeWrite: async () => {
      if (beforeWrite) await beforeWrite();
    },
    waitForIndex: async () => {
      if (confirmationBudget) throw new ConfirmationTransientError('index-busy', 'Git index.lock is busy; retain foreign lock');
      await new Promise(resolve => setTimeout(resolve, budget.pollMs));
    },
  });
  return confirmation;
}
function reportedCommitPorts(store: StateStore, context: RuntimeContext, execute: AdapterCommandExecutor, session: SessionRecord, identityExecute?: AdapterCommandExecutor) {
  return {
    isCurrentReport: async (runId: string, reportPath: string) => store.sessionRepository.transaction(tx => {
      const current = tx.getSession(runId);
      return !!current && ['running', 'exited'].includes(current.state) && !current.result && current.addressId === session.addressId
        && current.launchContext?.reportPath === reportPath && isDeepStrictEqual(current.launchContext.assignment, session.launchContext?.assignment)
        && isDeepStrictEqual(current.launchContext.reportedCommits, session.launchContext?.reportedCommits);
    }, 'read'),
  };
}
function sessionTools(store: StateStore, execute: AdapterCommandExecutor, configuration: Pick<RuntimeConfiguration, 'catalog'>, context: RuntimeContext, settingsFor: (runner: string) => Promise<ProtocolSettings>, identityExecute?: AdapterCommandExecutor, protocolsFor?: () => Promise<readonly ProtocolSettings[]>) {
  const budgetFor = async (runner: string) => (await settingsFor(runner)).timeouts;
  const verified = new WeakMap<object, string>();
  const mainAuthority = new WeakMap<object, ProcessIdentity>();
  const direct = identityExecute ?? executeCommand;
  const state = createSessionState({ repository: store.sessionRepository, verifyMainAuthority: (authority, identity) => !!authority && typeof authority === 'object' && isDeepStrictEqual(mainAuthority.get(authority), identity), verifyWorkResult: (runId, result) => verified.get(result) === runId });
  const current = (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
  const reportDirectory = (session: SessionRecord) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(session.runId) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(session.addressId) && session.launchContext?.reportPath === join(context.tmpRoot, session.runId, `${session.addressId}.json`) ? join(context.tmpRoot, session.runId) : undefined;
  const acceptPendingReport = async (session: SessionRecord): Promise<SessionRecord> => {
    session = current(session.runId) ?? session;
    if (session.result || !['running', 'exited'].includes(session.state) || !gitAllowed()) return session;
    const expectedPath = join(context.tmpRoot, session.runId, `${session.addressId}.json`);
    const metadataFailure = !session.launchContext ? 'Report launch metadata is missing'
      : !reportDirectory(session) ? 'Report path does not match the durable run identity'
      : Array.isArray(session.launchContext.reportSchema?.required) && session.launchContext.reportSchema.required.includes('commits') && !session.launchContext.reportedCommits ? 'Reported commit launch metadata is missing' : null;
    if (metadataFailure) {
      let bytes: Uint8Array | null;
      try { bytes = await readReportBytes(expectedPath); }
      catch (error) { await reportDiagnostic(session.runId, metadataFailure, { reportPath: expectedPath, bytes: null, reason: `${metadataFailure}: Cannot read report: ${String(error)}` }); return session; }
      if (bytes !== null) await reportDiagnostic(session.runId, metadataFailure, { reportPath: expectedPath, bytes, reason: metadataFailure });
      return session;
    }
    const request: AgentReportRequest = { catalog: configuration.catalog, tmpRoot: context.tmpRoot, runId: session.runId, address: session.addressId, phase: session.launchContext!.testAssignment?.phase ?? session.launchContext!.modelRouting?.parameters.phase, assignment: session.launchContext!.assignment, reportedCommits: session.launchContext!.reportedCommits };
    const runner = session.process?.runner ?? session.launchContext!.selection.runner;
    const reportPorts: import('./agent-report.ts').PendingAgentReportPorts = {
      acceptResult: result => accept(result),
      confirmationRetry: { runner, protocol: async () => ({ timeouts: await budgetFor(runner) }), inputs: reportConfirmationInputs(request) },
      fs: { readText: async path => { const bytes = await readReportBytes(path); return bytes === null ? null : Buffer.from(bytes).toString('utf8'); }, readBytes: readReportBytes },
      now,
      ...reportedCommitPorts(store, context, execute, session, identityExecute),
      verifyAssignmentCompletion: (assignment, archives) => verifyAssignmentCompletion(assignment, assignmentPorts(execute), archives),
      confirmTaskCheckboxes: async (request, report, confirmationBudget, beforeWrite) => confirmReportedTasks(store, context, execute, request, report, await budgetFor(runner), identityExecute, confirmationBudget, beforeWrite),
      diagnostic: (reason, snapshot) => reportDiagnostic(session.runId, reason, snapshot),
    };
    const accept = async (result: import('./agent-report.ts').AgentReportResult) => {
      if (request.reportedCommits) await verifyPendingAgentReportFreshness(request, result, reportPorts);
      const value: WorkResult = { status: result.status, response: result.report!.answer, proof: { runId: session.runId, at: result.at, context: result.report?.context, ...(session.launchContext!.reportedCommits ? { commits: result.report?.commits } : {}), checkboxCommits: result.checkboxCommits } };
      verified.set(value, session.runId);
      const accepted = state.acceptWorkResult(session.runId, value, { pending: [{ id: `${session.runId}:${result.event}`, runId: session.runId, event: result.event, payload: { kind: result.event, id: session.addressId } }], domain: [], reportAccepted: true });
      if (!accepted && !current(session.runId)?.result) throw new Error('Result could not be durably accepted for the running session');
    };
    const result = await readPendingAgentReport(request, reportPorts);
    if (result) {
      try { await accept(result); }
      catch (error) { await rejectPendingAgentReport(request, result, reportPorts, error instanceof Error ? error.message : String(error)); }
    }
    return current(session.runId) ?? session;
  };
  let reminderService: ReminderService | undefined;
  const reminders = { sessionEnded: (input: SessionEnd) => (reminderService ??= new ReminderService({ repository: store.reminderRepository, now, nextId: randomUUID,
    approvedEventKinds: loadEventCatalog(context.orchestratorRoot, configuration.catalog).events.map(event => event.id) })).sessionEnded(input) };
  const intents = (rows: readonly ActivityEvent[]) => rows.map(row => { const event = row.kind === 'started' ? 'agent.started' : row.kind === 'updated' ? 'agent.activity-changed' : 'agent.closed'; return { id: `${row.session.runId}:activity:${row.session.revision}:${row.kind}:${row.project}`, runId: row.session.runId, event, payload: { kind: event, id: row.session.addressId, activity: row } }; });
  const publish = async (rows: readonly ActivityEvent[]) => { store.sessionRepository.transaction(tx => { for (const intent of intents(rows)) tx.putPending(intent); }); };
  const finalize = async (session: SessionRecord, rows: readonly ActivityEvent[]) => {
    const wrapper = session.launchContext?.wrapper ?? listTaskReservations(store).find(set => set.lease.owner.runId === session.runId)?.wrapper;
    if (wrapper && wrapper.pid !== process.pid) { const observed = (await observeKnownProcesses([wrapper], { execute }))[0]; if (observed.state !== 'exited') fail('WORKER_RESULT_PENDING', `Worker result processing is ${observed.state}; preserve ${session.runId}. Inspect ${join(context.tmpRoot, session.runId, 'worker.log')}; use agent close --id ${session.addressId} --force --reason TEXT to stop its verified live runner, then agent ps after worker result processing exits`); }
    session = await acceptPendingReport(session);
    const finished = await finalizeStartupContextRun(session.runId, {
      ...startupContextRuntimeFiles(context.tmpRoot, dirname(dirname(context.statePath))), database: store.startupContextDatabase,
      flowPath: join(context.confRoot, 'flow.json'), mainAddress: 'main', now,
      sessions: {
        get: current,
        acceptReport: async row => startupContextAcceptedReport(await acceptPendingReport(row), context.tmpRoot, now),
        cleanupCompleted: at => state.cleanupCompleted(at),
        finish: async (row, at, startupPending) => {
          session = row;
          if (!session.result) {
            const result: WorkResult = { status: 'failed', response: session.abortReason ?? NO_REPORT_REASON, proof: { runId: session.runId, at } };
            verified.set(result, session.runId);
            state.acceptWorkResult(session.runId, result, { pending: [{ id: `${session.runId}:agent.failed`, runId: session.runId, event: 'agent.failed', payload: { kind: 'agent.failed', id: session.addressId } }], domain: [] });
            session = current(session.runId)!;
          }
          const effect: ReminderSessionEffect = { id: `${session.runId}:reminders:session-ended`, domain: 'reminders', payload: { operation: 'session-ended', runId: session.runId, at, end: { address: session.addressId, confirmedSucceeded: session.result?.status === 'succeeded', crashed: true } } };
          const pending = [...intents(rows), ...startupPending];
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
        },
      },
    });
    await deliverResults();
    return finished;
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
  const authorize = async (id: string, caller: unknown, delegated = false) => {
    const sender = await resolve(caller);
    const session = current(sender.kind === 'agent' ? sender.runId : '');
    if (session && (session.addressId === id || session.addressId === 'main')) return;
    const owns = (link: { addressId: string; runId: string } | undefined) => link?.runId === session?.runId && link?.addressId === session?.addressId;
    const child = (target: SessionRecord) => target.addressId === id && (owns(target.delegatedBy) || owns(target.launchedBy));
    if (session && delegated && id !== 'main' && state.listReconciliationCandidates().some(child)) return;
    fail('CALLER_UNAUTHORIZED', `Caller is not authorized for ${id}`);
  };
  const types = configuration.catalog.commands.find(row => row.handlerName === 'agent run')?.parameters.find(row => row.name === 'type')?.values?.map(row => row.id) ?? [];
  const projects = configuration.catalog.commands.find(row => row.handlerName === 'agent run')?.parameters.find(row => row.name === 'project')?.values?.map(row => row.id) ?? [];
  const closeRunner = async (identity: ProcessIdentity) => {
    const tmux = identity.evidence.tmuxSocket ? paneExecutor(identity.evidence.tmuxSocket, direct) : execute;
    const observed = (await observeKnownProcesses([identity], { execute }))[0];
    if (observed.state !== 'alive' || !await belongsToPane(identity, tmux)) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Close requires a verified live process in its owned tmux pane');
    const adapter = new TmuxAgentAdapter({ execute: tmux, protocols: {} as Record<AgentRunner, RunnerProtocol> });
    await adapter.stop({ tmuxSession: identity.tmuxSession, selection: { runner: identity.runner as AgentRunner, model: '', effort: '' } });
    const budget = await budgetFor(identity.runner);
    if (!await processExited(execute, identity, budget)) fail('PROCESS_TERMINATION_UNKNOWN', `Runner termination is not confirmed within ${budget.transitionMs} ms`);
  };
  const control = new AgentControlService({ repository: store.sessionRepository, scanner: {
    inspect: identity => observeIdentity(identity, execute),
    inspectMany: identities => observeIdentities(identities, execute),
  }, authority: { resolve }, reminders,
    projects, agentTypes: types, agentPhases: configuration.catalog.commands.find(row => row.handlerName === 'agent update')?.parameters.find(row => row.name === 'phase')?.values?.map(row => row.id) ?? types,
    coordinator: {
      prepareClose: (session, options) => prepareAgentClose({
        repository: store.sessionRepository,
        acceptPendingReport,
        acceptedReport: (_tx, row) => {
          const fact = row.reportAcceptance;
          const event = configuration.catalog.reportStatuses.find(status => status.id === fact?.status)?.event;
          return fact && (fact.status === 'succeeded' || fact.status === 'failed') ? { runId: fact.runId, status: fact.status, eventRecorded: fact.event === event } : null;
        },
        eventForStatus: status => {
          const event = configuration.catalog.reportStatuses.find(row => row.id === status)?.event;
          if (!text(event)) fail('CONFIGURATION_INVALID', `Missing report event for ${status}`);
          return event;
        },
      }, session, options),
      observe: async (session, observation) => {
        if (observation.state === 'alive' && !session.result && (session.process?.runner === 'grok' || session.process?.runner === 'agy')) {
          const identity = session.process;
          const socket = identity.evidence.tmuxSocket;
          const pane = identity.evidence.tmuxPane;
          if (socket && isAbsolute(socket) && pane && /^%\d+$/.test(pane)) {
            const tmux = paneExecutor(socket, direct);
            if (await belongsToPane(identity, tmux)) {
              const captured = await tmux({ executable: 'tmux', args: ['capture-pane', '-p', '-t', pane] });
              const snapshot = captured.exitCode === 0 ? parseRunnerLimitScreen(await settingsFor(identity.runner), captured.stdout, now()) : null;
              if (snapshot) {
                store.setQuotaSnapshot(identity.runner, snapshot, snapshot.observedAt);
                const limited = store.sessionRepository.transaction(tx => {
                  const row = tx.getSession(session.runId);
                  if (!row || (row.revision !== session.revision && (!row.process || !sameIdentity(identity, row.process))) || row.state !== 'running' || row.result) return null;
                  const next = { ...row, revision: row.revision + 1, abortReason: `quota exhausted: ${identity.runner} — ${snapshot.pools[0]?.windows[0]?.explanation}` };
                  tx.putSession(next);
                  return next;
                });
                if (!limited) return current(session.runId)!;
                session = limited;
                await closeRunner(identity);
                observation = (await observeKnownProcesses([identity], { execute }))[0];
              }
            }
          }
        }
        if (observation.state === 'exited') {
          const wrapper = session.launchContext?.wrapper ?? listTaskReservations(store).find(set => set.lease.owner.runId === session.runId)?.wrapper;
          if (wrapper) {
            const wrapperState = (await observeKnownProcesses([wrapper], { execute }))[0];
            if (wrapperState.state !== 'exited') fail('WORKER_RESULT_PENDING', `Worker result processing is ${wrapperState.state}; preserve ${session.runId} until its report/exit transition completes`);
          }
        }
        const latest = current(session.runId);
        if (latest?.state === 'running' && latest.process && session.process && sameIdentity(session.process, latest.process)) {
          session = latest;
          if (observation.state === 'alive') observation = { ...observation, identity: structuredClone(latest.process) };
        }
        state.commitObservation(session.runId, session.revision, observation, effects);
        if (observation.state === 'unknown') fail('PROCESS_SCAN_UNKNOWN', `Process scan unknown: ${observation.error}`);
        return current(session.runId)!;
      },
      updateActivity: async (session, update, rows) => { if (!launch.updateActivity(session.runId, session.revision, update, intents(rows))) fail('ACTIVITY_CONFLICT', 'Session changed during activity update'); return current(session.runId)!; },
      finalize, publish,
      acceptPendingReport,
    },
    transport: {
      deliver: async (identity, message) => {
        if (!identity.evidence.tmuxSocket || !isAbsolute(identity.evidence.tmuxSocket)) return { accepted: false, reason: 'Session has no recorded tmux socket' };
        const pane = identity.evidence.tmuxPane;
        if (!pane || !/^%\d+$/.test(pane)) return { accepted: false, reason: 'Session has no recorded tmux pane' };
        const tmux = paneExecutor(identity.evidence.tmuxSocket, direct);
        const adapter = new TmuxAgentAdapter({ execute: tmux, protocols: {} as Record<AgentRunner, RunnerProtocol> });
        const directory = join(context.tmpRoot, 'message-locks');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const key = createHash('sha256').update(`${identity.evidence.tmuxSocket}\0${pane}`).digest('hex');
        const protocolRows = identity.runner === 'main' && protocolsFor ? await protocolsFor() : [];
        const recorded = identity.runner === 'main' ? recordedMainRunner(identity.evidence.command ?? '', protocolRows) ?? await mainRunnerFromPaneLineage(identity.pid, direct, protocolRows) ?? 'claude' : identity.runner;
        const settings = await settingsFor(recorded);
        const verify = async () => {
          if ((await observeIdentity(identity, direct)).state !== 'alive') return false;
          if (identity.runner !== 'main') return belongsToPane(identity, tmux);
          const shown = await tmux({ executable: 'tmux', args: ['display-message', '-p', '-t', pane, '#{pane_id}\t#{pane_pid}'] });
          return shown.exitCode === 0 && shown.stdout.replace(/\n$/, '') === `${pane}\t${identity.pid}`;
        };
        const result = await deliverCheckedMessage({
          settings, waitForComposer: identity.runner === 'main', verify,
          acquire: () => tryWaitLease(join(directory, key), settings.timeouts.transitionMs),
          capture: async () => {
            const result = await tmux({ executable: 'tmux', args: ['capture-pane', '-p', '-t', pane] });
            if (result.exitCode !== 0) throw new Error('Recipient pane capture failed');
            return result.stdout;
          },
          paste: text => adapter.deliverToPane(pane, text),
          enter: async () => {
            const result = await tmux({ executable: 'tmux', args: ['send-keys', '-t', pane, 'Enter'] });
            if (result.exitCode !== 0) throw new Error('Recipient Enter retry failed');
          },
          now: Date.now, delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
        }, message);
        return result.accepted ? { accepted: true, receiptId: randomUUID() } : { accepted: false, reason: result.reason! };
      },
      interrupt: async identity => {
        const socket = identity.evidence.tmuxSocket;
        const pane = identity.evidence.tmuxPane;
        if (!socket || !isAbsolute(socket) || !pane || !/^%\d+$/.test(pane)) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Interrupt requires a recorded tmux socket and pane');
        const tmux = paneExecutor(socket, direct);
        await interruptAgentAction({
          pane, settings: await settingsFor(identity.runner), execute: tmux,
          verify: async () => {
            if ((await observeIdentity(identity, direct)).state !== 'alive' || !await belongsToPane(identity, tmux)) return false;
            const shown = await tmux({ executable: 'tmux', args: ['display-message', '-p', '-t', `=${identity.tmuxSession}:0.0`, '#{pane_id}'] });
            return shown.exitCode === 0 && shown.stdout.trim() === pane;
          },
        });
      },
      close: closeRunner,
      closeWorker: async session => {
        const identity = session.process;
        if (identity) {
          const observed = (await observeKnownProcesses([identity], { execute }))[0];
          if (observed.state === 'alive') await closeRunner(identity);
          else if (observed.state === 'unknown') fail('PROCESS_IDENTITY_UNAVAILABLE', 'Runner identity is unknown; preserve its tmux session and worker');
          else if (identity.evidence.tmuxSocket && identity.evidence.tmuxPane) {
            const tmux = paneExecutor(identity.evidence.tmuxSocket, direct);
            const pane = await tmux({ executable: 'tmux', args: ['display-message', '-p', '-t', `=${identity.tmuxSession}:0.0`, '#{pane_id}'] });
            if (pane.exitCode === 0) {
              if (pane.stdout.trim() !== identity.evidence.tmuxPane) {
                const accepted = session.reportAcceptance?.status === 'succeeded' || session.reportAcceptance?.status === 'failed' || session.result?.status === 'succeeded' || session.result?.status === 'failed' && !session.result.forcedClose;
                const completed = session.state === 'finished' || accepted;
                if (!completed) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Exited runner pane was replaced; preserve its tmux session');
                process.stderr.write(`Warning: ${session.addressId}: Exited runner pane was replaced; preserve its tmux session\n`);
              } else if (!await discardOwnedTmuxSession(tmux, identity.tmuxSession, await budgetFor(identity.runner))) fail('PROCESS_TERMINATION_UNKNOWN', 'Owned tmux session processes did not finish after close');
            } else if (!/can't find (?:session|pane)|no server running|error connecting.*No such file/i.test(pane.stderr)) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Exited runner tmux session removal could not be verified');
          }
        }
        const wrapper = session.launchContext?.wrapper ?? session.worker ?? listTaskReservations(store).find(set => set.lease.owner.runId === session.runId)?.wrapper;
        if (!wrapper || wrapper.pid === process.pid) return;
        const budget = await budgetFor(session.process?.runner ?? session.launchContext!.selection.runner);
        for (const signal of ['-TERM', '-KILL']) {
          const observed = await observeIdentity(wrapper, execute);
          if (observed.state === 'exited') return;
          if (observed.state !== 'alive') fail('WORKER_RESULT_PENDING', `Worker identity is unknown; preserve ${session.runId} and retry agent close after process observation is available`);
          const result = await execute({ executable: 'kill', args: [signal, String(wrapper.pid)] });
          if (await waitWrapperExit(execute, wrapper, budget)) return;
          if (result.exitCode !== 0) fail('WORKER_RESULT_PENDING', `Worker termination could not be confirmed for ${session.runId}`);
        }
        fail('WORKER_RESULT_PENDING', `Worker termination could not be confirmed for ${session.runId}`);
      },
    },
  });
  const deliverResults = async () => {
    await deliverStartupContextEvents(store, now, async intent => {
      const payload = intent.payload as { to: string; id: string; runIds: string[] };
      const receipt = await control.message({ to: payload.to, text: JSON.stringify({ event: intent.event, contextReviewId: intent.id, runIds: payload.runIds }) }, rafSystemCaller);
      return receipt.accepted;
    });
    await cleanupExpiredDeliveryEvidence(context.tmpRoot, now()).catch(() => { process.stderr.write('Delivery evidence cleanup unavailable\n'); });
    cleanupStartupContextCompleted(now(), { database: store.startupContextDatabase, flowPath: join(context.confRoot, 'flow.json'), sessions: state });
    return settleResultNotices({ store, now: Date.now, deliver: (request, sender) => {
      if (sender.kind !== 'system') throw new Error('Result notices require a system sender');
      return control.message(request, rafSystemCaller);
    } });
  };
  const reportDiagnostic = async (runId: string, reason: string, snapshot?: ReportRejectionSnapshot) => {
    if (!snapshot) { process.stderr.write(`${runId}: ${reason}\n`); return; }
    await retryStateOperation(() => recordReportRejection(store, runId, snapshot), await budgetFor(current(runId)?.process?.runner ?? 'codex'));
    await deliverResults();
  };
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
  return { state, current, verified, reminders, publish, control, authorize, resolve, finalize, attachMain, deliverResults, reportDiagnostic, acceptPendingReport };
}

const quotaRemedy = 'Перевірте вхід, версію CLI та блок quota в conf/raf.json, потім повторіть raf runner limits.';
async function quotaProtocols(confRoot: string, override?: readonly ProtocolSettings[]): Promise<{ rows: QuotaProtocol[]; invalid: Record<string, string> }> {
  const rows: QuotaProtocol[] = [];
  const invalid: Record<string, string> = {};
  for (const row of await protocols(confRoot, override)) {
    try { rows.push(validateQuotaProtocol(row)); }
    catch (error) { invalid[object(row) && text(row.runner) ? row.runner : 'unknown'] = error instanceof Error ? error.message : String(error); }
  }
  return { rows, invalid };
}
function quotaStore(store: StateStore): QuotaCurrentStore {
  return {
    read: async runner => {
      const row = store.getQuota(runner);
      if (!row) return null;
      let error: CollectionError | null = null;
      if (row.error !== null) {
        try { error = JSON.parse(row.error); } catch { error = { code: 'probe_failed', message: row.error, remedy: quotaRemedy }; }
      }
      return { runner, snapshot: row.snapshot as CurrentQuota['snapshot'], lastAttemptAt: row.lastAttemptAt, error, nextAttemptAt: null };
    },
    replaceCurrent: async value => {
      if (value.snapshot && value.lastAttemptAt) store.setQuotaSnapshot(value.runner, value.snapshot, value.snapshot.observedAt, { attemptedAt: value.lastAttemptAt, error: value.error ? JSON.stringify(value.error) : null });
      else store.recordQuotaError(value.runner, JSON.stringify(value.error ?? { code: 'probe_failed', message: 'Quota probe produced no snapshot', remedy: quotaRemedy }), value.lastAttemptAt ?? now());
    },
  };
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function quotaLock(store: StateStore, rows: readonly QuotaProtocol[]): CollectionLock {
  return {
    acquire: async key => {
      const settings = rows.find(row => `quota:${row.runner}` === key);
      if (!settings) return null;
      const token = randomUUID();
      const holdMs = settings.timeouts.overallMs + 2 * settings.timeouts.transitionMs;
      const acquired = store.acquireQuotaLease(key, token, process.pid, new Date(Date.now() + holdMs).toISOString(), holder => Date.parse(holder.expiresAt) <= Date.now() || !processAlive(holder.pid));
      return acquired ? { release: async () => store.releaseQuotaLease(key, token) } : null;
    },
  };
}
async function quotaProbeWorkspace(context: Pick<RuntimeContext, 'orchestratorRoot' | 'confRoot'>, execute: AdapterCommandExecutor): Promise<string | undefined> {
  const projects = await json(join(context.confRoot, 'projects.json')).catch(() => undefined);
  const raf = object(projects?.projects) ? projects.projects.raf : undefined;
  if (!object(raf) || !text(raf.path) || !object(raf.branchPaths) || !Object.values(raf.branchPaths).includes(raf.path)) return undefined;
  const cwd = resolve(context.orchestratorRoot, raf.path);
  return await registeredBranchDirectory(context.orchestratorRoot, context.confRoot, cwd, undefined, execute) ? cwd : undefined;
}
function quotaTransport(context: Pick<RuntimeContext, 'tmpRoot' | 'orchestratorRoot' | 'confRoot'>, execute: AdapterCommandExecutor): ProbeTransport {
  const owned = new Map<string, { session: AdapterSession; directory: string; cleanupSocket(): Promise<void>; version: string; settings: QuotaProtocol; adapter: TmuxAgentAdapter }>();
  const handle = (token: string) => {
    const value = owned.get(token);
    if (!value) throw new Error('Quota probe handle is not owned by this process');
    return value;
  };
  return {
    openOwned: async row => {
      if (!('quota' in row)) throw new Error(`Runner ${row.runner} has no quota probe settings`);
      const settings = row;
      const availability = await probeRunnerAvailability(settings, { env: process.env, execute });
      if (!availability.available) throw new Error(availability.reason);
      const root = join(context.tmpRoot, 'quota');
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const workspace = await quotaProbeWorkspace(context, execute);
      const directory = await fs.mkdtemp(join(root, `${settings.runner}-`));
      const cwd = workspace ?? directory;
      const compact = settings.quota.args.some(value => value.includes('{probeDirectory}') && !socketPathFits(value.replaceAll('{probeDirectory}', directory))) ? rafSocketDirectory(directory) : directory;
      const cleanupSocket = async () => { if (compact !== directory) await releaseRafSocketDirectory(directory, compact); };
      const invocation = quotaProbeInvocation({ ...settings, executable: availability.path }, compact);
      const command = { executable: 'env', args: [...Object.entries(invocation.env).map(([key, value]) => `${key}=${value}`), invocation.executable, ...invocation.args], cwd };
      const probe: RunnerProtocol = { invocation: () => command, observe: () => ({ status: 'starting' }) };
      const adapter = new TmuxAgentAdapter({ execute, protocols: { [settings.runner]: probe } as Record<AgentRunner, RunnerProtocol> });
      const tmuxSession = `raf-quota-${settings.runner}-${randomUUID().slice(0, 8)}`;
      let session: AdapterSession;
      try { session = await adapter.startWithoutInput({ selection: { runner: settings.runner as AgentRunner, model: '', effort: '' }, tmuxSession, cwd, reportWrapper: { wrap: value => value } }); }
      catch (error) {
        await discardOwnedTmuxSession(execute, tmuxSession, settings.timeouts).catch(() => false);
        await cleanupSocket();
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
      const token = randomUUID();
      owned.set(token, { session, directory, cleanupSocket, version: availability.version, settings, adapter });
      return { socket: join(context.tmpRoot, 'tmux', 'server.sock'), session: tmuxSession, ownershipToken: token, trustWorkspace: workspace !== undefined };
    },
    captureOwned: async probe => {
      const value = handle(probe.ownershipToken);
      const pane = await value.adapter.capture(value.session);
      return { text: pane.text, version: value.version, observedAt: now(), truncated: false, exited: pane.exited };
    },
    sendTextOwned: async (probe, value) => { const owner = handle(probe.ownershipToken); await owner.adapter.typeText(owner.session, value); },
    sendKeysOwned: async (probe, keys) => { const owner = handle(probe.ownershipToken); await owner.adapter.sendKeys(owner.session, keys); },
    cleanupOwned: async probe => {
      const value = handle(probe.ownershipToken);
      const stopped = await discardOwnedTmuxSession(execute, value.session.tmuxSession, value.settings.timeouts);
      if (!stopped) throw new Error(`Own quota probe session ${value.session.tmuxSession} could not be confirmed terminated`);
      await value.cleanupSocket();
      await fs.rm(value.directory, { recursive: true, force: true });
      owned.delete(probe.ownershipToken);
    },
  };
}
function runnerEnablement(store: StateStore, configuration: RuntimeConfiguration): Record<RunnerId, boolean> {
  return Object.fromEntries(configuration.models.runners.map(runner => [runner.id, store.getRunnerEnabled(runner.id) ?? runner.initialEnabled])) as Record<RunnerId, boolean>;
}
function assignmentPorts(execute: AdapterCommandExecutor) {
  return { cli: { exec: (args: readonly string[], cwd: string) => execute({ executable: 'openspec', args, cwd }) }, fs: { readText: (path: string) => fs.readFile(path, 'utf8') } };
}
async function measureResources(paths: readonly string[], machineId: string, execute: AdapterCommandExecutor, loadAverage1m: () => number) {
  return createResourceSnapshotReader({ machineId, paths }, { platform, loadAverage1m, availableCores: availableParallelism, totalRamBytes: totalmem, readFile: path => fs.readFile(path, 'utf8'), execute }).read();
}
async function reservationTools(store: StateStore, context: RuntimeContext, execute: AdapterCommandExecutor, identityExecute?: AdapterCommandExecutor): Promise<TaskReservationDependencies> {
  const projects = await json(join(context.confRoot, 'projects.json'));
  const roots = Object.fromEntries(Object.keys(projects.projects).map(project => [project, context.orchestratorRoot]));
  const identity = createAssignmentIdentityAdapter(roots, identityExecute ? { execute: identityExecute } : {});
  return { store, deferAbandonedFinalization: true, currentBoot: () => bootIdentity(execute), observe: identity => observeIdentity(identity, execute), resolveTasks: identity.resolveTasks, newFence: randomUUID };
}

export function createProductionSystemDelivery(store: StateStore, context: RuntimeContext, catalog: RuntimeConfiguration['catalog']) {
  const execute = runtimeExecution(context);
  const settingsFor = async (runner: string) => protocolFor(await protocols(context.confRoot), runner);
  const tools = sessionTools(store, execute, { catalog }, context, settingsFor, undefined, () => protocols(context.confRoot));
  return (request: import('./agent-control.ts').MessageRequest, sender: VerifiedSender) => {
    if (sender.kind !== 'system') throw new Error('Internal delivery requires a verified system sender');
    return tools.control.message(request, rafSystemCaller);
  };
}

export async function reconcileProductionReports(store: StateStore, context: RuntimeContext, catalog: RuntimeConfiguration['catalog']): Promise<void> {
  const execute = runtimeExecution(context);
  const tools = sessionTools(store, execute, { catalog }, context, async runner => protocolFor(await protocols(context.confRoot), runner), undefined, () => protocols(context.confRoot));
  const candidates = store.sessionRepository.transaction(tx => tx.listSessions().filter(row => !row.result && ['running', 'exited'].includes(row.state) && row.launchContext?.reportPath), 'read');
  for (const session of candidates) await tools.acceptPendingReport(session);
}
async function settleModelHandoffs(store: StateStore, context: RuntimeContext, configuration: RuntimeConfiguration, options: Parameters<typeof createProductionServices>[3] = {}) {
  const execute = runtimeExecution(context, options.execute);
  return runProductionModelHandoffs({ store, context,
    loadConfiguration: async () => {
      const { readConfiguration } = await import('./production-entry.ts');
      const catalog = loadCompiledCatalog(context.artifactPath);
      return { ...configuration, catalog, ...readConfiguration(context.orchestratorRoot, catalog) };
    },
    createServices: current => createProductionServices(store, current, context, options),
    inspect: identity => observeIdentity(identity, execute), assignmentPorts: assignmentPorts(execute),
  });
}
export async function createProductionServices(
  store: StateStore,
  configuration: RuntimeConfiguration,
  context: RuntimeContext,
  options: {
    execute?: AdapterCommandExecutor;
    loadAverage1m?: () => number;
    admissionQueueId?: (identity: { stateDomain: string; machineId: string }) => string;
    protocolSettings?: readonly ProtocolSettings[];
    workerModulePath?: string;
  } = {},
): Promise<RuntimeServices> {
  for (const name of ['orchestratorRoot', 'confRoot', 'artifactPath', 'statePath', 'tmpRoot'] as const) if (!isAbsolute(context[name])) fail('INVALID_CONTEXT', `Absolute ${name} required`);
  if (options.workerModulePath && !isAbsolute(options.workerModulePath)) fail('INVALID_CONTEXT', 'Internal worker override must be absolute');
  const execute = runtimeExecution(context, options.execute);
  const settingsFor = async (runner: string) => protocolFor(await protocols(context.confRoot, options.protocolSettings), runner);
  const budgetFor = async (runner: string) => (await settingsFor(runner)).timeouts;
  const tools = sessionTools(store, execute, configuration, context, settingsFor, options.execute, () => protocols(context.confRoot, options.protocolSettings));
  const assignments = assignmentPorts(execute);
  const prepared = new Map<string, { testAssignment: SandboxTestAssignment; launch: RuntimeLaunch; reportPath: string; workspaceTrustDenied: boolean; reportedCommits?: ReportedCommitLaunchContext; handshake?: LaunchHandshake; brief?: string; spawnAttempted?: boolean; wrapperFailure?: PersistentWrapperFailure['wrapper']; wrapperGone?: boolean }>();
  const readSession = tools.current;
  const reconcileHandoffs = async () => {
    const stopped = await reconcileHandoffLaunches({ store, currentBoot: () => bootIdentity(execute),
      observe: identity => observeIdentity(identity, execute),
      stopWorker: async (identity, runner) => {
        const budget = await budgetFor(runner);
        for (const signal of ['-TERM', '-KILL']) {
          const observation = (await observeKnownProcesses([identity], { execute }))[0];
          if (observation.state === 'exited') return true;
          if (observation.state !== 'alive' || !sameIdentity(identity, observation.identity)) return false;
          const killed = await execute({ executable: 'kill', args: [signal, String(identity.pid)] });
          if (killed.exitCode !== 0 && (await observeKnownProcesses([identity], { execute }))[0].state !== 'exited') return false;
          if (await processExited(execute, identity, budget)) return true;
        }
        return false;
      },
      stopRunner: async (tmuxSession, runner) => discardOwnedTmuxSession(execute, tmuxSession, await budgetFor(runner)),
    });
    const pass = processObservationPass.getStore();
    if (stopped && pass?.execute === execute) {
      pass.observations.clear();
      pass.snapshot = undefined;
    }
  };
  const markOwnerAction = (id: string, action: 'paused' | 'stopped') => {
    if (id === 'main') return;
    store.sessionRepository.transaction(tx => {
      const row = (tx.listActiveSessions?.() ?? tx.listSessions()).find(row => row.addressId === id && row.state !== 'finished');
      if (row) tx.putSession({ ...row, revision: row.revision + 1, ownerAction: action });
    });
  };
  const cleanQueuedReport = async (runId: string) => {
    if (readSession(runId)?.state === 'running') fail('LAUNCH_RECOVERABLE', 'Cannot clean a running launch');
    await fs.rm(join(context.tmpRoot, runId), { recursive: true, force: true });
    for (const [key, row] of prepared) if (row.launch.runId === runId) prepared.delete(key);
  };
  const leaseFor = (runId: string) => listTaskReservations(store).find(set => set.lease.owner.runId === runId)?.lease;
  const release = async (runId: string, reason: 'cancelled' | 'failed' | 'succeeded') => {
    const lease = leaseFor(runId);
    if (lease) {
      const stage = listTaskReservations(store).find(set => set.lease.owner.runId === runId)?.stage;
      if (reason === 'cancelled' && stage !== 'starting') reason = 'failed';
      const wrapper = stage === 'handoff' ? listTaskReservations(store).find(set => set.lease.owner.runId === runId)?.wrapper : undefined;
      const runner = readSession(runId)?.launchContext?.selection.runner;
      if (wrapper && runner && !await waitWrapperExit(execute, wrapper, await budgetFor(runner))) fail('LAUNCH_RECOVERABLE', `Worker of run ${runId} is still alive or its liveness is unknown after the runner transition budget; the next reconciliation releases its reservation`);
      if (!await releaseTaskReservations(await reservationTools(store, context, execute, options.execute), { lease, reason, closeLaunch: tx => { const session = tx.getSession(runId); if (!session) throw new Error('Unknown launch'); closeSessionInTransaction(tx, session, now()); } })) fail('LAUNCH_RECOVERABLE', `Cannot safely release run ${runId}`);
    } else if (readSession(runId)?.state === 'reserved') tools.state.abortLaunch(runId, readSession(runId)?.abortReason ?? reason, now());
  };
  const api: RuntimeServices = {
    agentQueue: input => createProductionAgentQueue(input, { store, context, configuration, api, current: readSession,
      caller: async () => { try { const sender = await tools.resolve(await context.resolveCaller()); return sender.kind === 'agent' ? sender.runId : undefined; } catch { return undefined; } },
      observe: identity => observeIdentity(identity, execute),
      reconcile: async () => { await reconcileHandoffs(); await tools.control.ps(); await reconcileTaskReservations(await reservationTools(store, context, execute, options.execute)); },
      cleanReport: cleanQueuedReport,
    }),
    resolveNotify: async address => {
      const session = tools.state.listReconciliationCandidates().find(row => row.addressId === address && row.state === 'running');
      if (!session?.process) return fail(NOTIFY_TARGET_INVALID, `Notify target is not active: ${address}`);
      const observation = await observeIdentity(session.process, execute);
      if (observation.state !== 'alive') return fail(NOTIFY_TARGET_INVALID, `Notify target is not confirmed alive: ${address}`);
      return { addressId: session.addressId, runId: session.runId };
    },
    assignment: { validate: request => validateAssignment(request, assignments), compose: (snapshot, input) => composeAssignmentBrief(snapshot, { ...input, sessionName: input.agentId }, assignments.fs, configuration.catalog) },
    resolveTask: async (parameters, assignment) => {
      const task = await deriveTaskContext({ root: context.orchestratorRoot, parameters, assignment, configuration: await loadTaskContextConfiguration(context.confRoot, configuration.catalog) });
      if (task.estimate.status !== 'KNOWN') return fail('RESOURCE_ESTIMATE_UNKNOWN', task.estimate.reason);
      const fileSystemId = `dev:${(await fs.stat(context.orchestratorRoot, { bigint: true })).dev}`;
      return { ...task, estimate: task.estimate, requested: { ramBytes: task.estimate.ramBytes, diskBytes: { [fileSystemId]: task.estimate.diskBytesPerFileSystem } }, requiredFileSystemIds: [fileSystemId] };
    },
    route: async request => {
      if (request.hotfixRunId) {
        if (request.project !== 'raf' || request.branch !== 'hotfix') return fail('BRANCH_MISMATCH', 'Persistent hotfix route is restricted to raf hotfix');
        const host = { orchestratorRoot: context.orchestratorRoot, qaHome: context.stateContext?.homeDirectory ?? homedir(), environment: {}, sandboxExecutable: 'codex' };
        const route = await resolveWorkspaceRoute(request, await json(join(context.confRoot, 'projects.json')), createWorkspacePorts());
        if (!route.ok) return route;
        let workspace: HotfixWorkspace;
        try { workspace = await describeHotfixWorktree(host, request.hotfixRunId); }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const code = ['UNKNOWN_BRANCH', 'WORKSPACE_UNAVAILABLE', 'BRANCH_MISMATCH'].find(code => reason.startsWith(code + ':'));
          return fail(code ?? 'BRANCH_MISMATCH', reason);
        }
        return { ok: true, project: 'raf', branch: 'hotfix', cwd: workspace.cwd, hotfix: workspace };
      }
      return resolveWorkspaceRoute(request, await json(join(context.confRoot, 'projects.json')), createWorkspacePorts());
    },
    routingSnapshot: async () => {
      const cliAvailable: Record<string, boolean> = {};
      let configured: readonly ProtocolSettings[] = [];
      try { configured = await protocols(context.confRoot, options.protocolSettings); } catch {}
      const cliReasons: Record<string, string> = {};
      const cliWarnings: Record<string, readonly string[]> = {};
      for (const runner of configuration.models.runners) {
        let availability;
        try { availability = await probeRunnerAvailability(protocolFor(configured, runner.id), { env: process.env, execute }); }
        catch (error) { availability = { available: false as const, reason: error instanceof Error ? error.message : String(error) }; }
        cliAvailable[runner.id] = availability.available;
        if (availability.available) cliWarnings[runner.id] = availability.warnings;
        if (!availability.available) cliReasons[runner.id] = availability.reason;
      }
      let quotas: RoutingSnapshot['quotas'] = [];
      try {
        const { rows } = await quotaProtocols(context.confRoot, options.protocolSettings);
        const views = await readQuotaViews(rows, runnerEnablement(store, configuration), { store: quotaStore(store), now });
        quotas = routingQuotaEntries(rows, views as ScreenQuotaView[], configuration.models.models, now());
      } catch {}
      return { runnerEnabled: Object.fromEntries(configuration.models.runners.map(runner => [runner.id, store.getRunnerEnabled(runner.id) ?? runner.initialEnabled])), cliAvailable, cliReasons, cliWarnings, quotas };
    },
    collectQuotas: async requested => {
      const { rows, invalid } = await quotaProtocols(context.confRoot, options.protocolSettings);
      const runnable = requested.filter(runner => rows.some(row => row.runner === runner));
      const collected: CollectionResult = runnable.length ? await collectRunnerQuotas({ requested: runnable, settings: rows, enabled: runnerEnablement(store, configuration) }, {
        transport: quotaTransport(context, execute), store: quotaStore(store), lock: quotaLock(store, rows), now,
        wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
      }) : { exitCode: 0, results: [] };
      const results = requested.map(runner => collected.results.find(result => result.runner === runner) ?? { runner: runner as RunnerId, collected: false, view: { runner: runner as RunnerId, snapshot: null, ageMs: null, current: false, reason: 'failed' as const, error: { code: 'probe_failed' as const, message: invalid[runner] ?? `Runner ${runner} has no quota protocol in conf/raf.json#runnerProtocols`, remedy: quotaRemedy } } });
      return { exitCode: results.every(result => result.collected) ? 0 : 1, results };
    },
    selectModel, listModels: listModelAvailability,
    prepareReport: async launch => {
      if (launch.statePath !== context.statePath || launch.tmpRoot !== context.tmpRoot || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(launch.runId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(launch.addressId)) fail('INVALID_CONTEXT', 'Launch paths or identity mismatch');
      const writeBoundaries = launch.writeBoundaries ?? [];
      if (!Array.isArray(writeBoundaries) || !writeBoundaries.every(text)) fail('INVALID_CONTEXT', 'Launch write boundaries must be declared paths');
      if (!launch.taskContext) return fail('INVALID_CONTEXT', 'Launch lacks derived task context');
      const testAssignment: SandboxTestAssignment = { runId: launch.runId, agentId: launch.addressId, type: launch.activity.type, phase: launch.activity.phase, project: launch.activity.project, workspace: launch.activity.cwd, branch: launch.taskContext.context.branch, changes: launch.assignment.changes.map(change => change.id) };
      const directory = join(context.tmpRoot, launch.runId);
      await fs.mkdir(context.tmpRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(directory, { mode: 0o700 });
      const reportPath = join(directory, `${launch.addressId}.json`);
      let reportedCommits: ReportedCommitLaunchContext | undefined;
      let workspaceTrustDenied: boolean;
      try {
        workspaceTrustDenied = !await runnerWorkspaceTrusted(context, launch.activity.cwd, launch.selection.runner, { type: launch.activity.type, project: launch.activity.project, branch: launch.taskContext.context.branch }, launch.taskContext.context.hotfix, execute);
        const required = launch.taskContext.context.reportSchema.required;
        if (Array.isArray(required) && required.includes('commits')) {
          if (!launch.commitRepositories) throw new Error('Authorized commit repositories are missing');
          reportedCommits = workspaceTrustDenied
            ? { contract: 'reported-commits-v1', runId: launch.runId, reportPath, repositories: [], writeBoundaries: [...writeBoundaries] }
            : await captureReportedCommitLaunchContext(launch.runId, reportPath, launch.commitRepositories, writeBoundaries);
        }
        await writeTaskContextFile(directory, { version: 1, runId: launch.runId, parameters: launch.taskContext.parameters, assignmentFingerprint: assignmentFingerprint(launch.assignment), ...(launch.taskContext.context.hotfix ? { workspace: launch.taskContext.context.hotfix } : {}), context: { ...launch.taskContext.context, workspaceWritable: launch.taskContext.context.workspaceWritable ?? false, estimate: launch.taskContext.context.estimate ?? { status: 'UNKNOWN', reason: 'Task resource estimate is unavailable' } } });
        await fs.writeFile(join(directory, 'runtime.json'), JSON.stringify({ version: 1, workspaceTrustDenied, ...(launch.taskContext.context.hotfix ? { workspace: launch.taskContext.context.hotfix } : {}), configuration, context: { ...context, resolveCaller: undefined }, protocolSettings: options.protocolSettings, writeBoundaries, workspaceRoute: { type: launch.activity.type, project: launch.activity.project, branch: launch.taskContext.context.branch, ...(launch.taskContext.context.hotfix ? { hotfix: launch.taskContext.context.hotfix } : {}) } }), { mode: 0o600, flag: 'wx' });
      } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
      prepared.set(launch.tmuxSession, { testAssignment, launch: structuredClone(launch), reportPath, reportedCommits, workspaceTrustDenied });
      return { reportPath, reportedCommits, warnings: [], reportWrapper: { wrap: command => command }, cleanupUnstarted: async () => { if (readSession(launch.runId)?.state === 'running') fail('LAUNCH_RECOVERABLE', 'Cannot clean a running launch'); await fs.rm(directory, { recursive: true, force: true }); prepared.delete(launch.tmuxSession); } };
    },
    reserve: async input => {
      const dependencies = await reservationTools(store, context, execute, options.execute);
      await reconcileHandoffs();
      await reconcileTaskReservations(dependencies);
      const boot = await dependencies.currentBoot();
      const volumePaths = { orchestratorRoot: context.orchestratorRoot, workspace: input.activity.cwd, home: homedir() };
      const paths = [...new Set(Object.values(volumePaths))];
      const resourceSnapshot = await measureResources(paths, boot.machineId, execute, options.loadAverage1m ?? (() => loadavg()[0]));
      const { requiredFileSystemIds, homeFileSystemId, reasons } = deriveResourceAdmissionVolumes(volumePaths, resourceSnapshot.fileSystemByPath);
      const requestedTier = input.activity.type === 'hotfix' ? 'hotfix' as const : 'normal' as const;
      const queueId = input.queueClaim?.record.queueId ?? options.admissionQueueId?.({ stateDomain: await fs.realpath(context.statePath), machineId: boot.machineId }) ?? createStoredLaunchQueueEvents(store, { stateDomain: await fs.realpath(context.statePath), machineId: boot.machineId }).queueId();
      let policy: FlowPolicy | null = null;
      try { policy = loadFlowPolicy(join(context.confRoot, 'flow.json')); }
      catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
      const unavailable = (reason: string, sources: string[] = []) => {
        const admission = buildAdmissionSnapshot({ input: { measurement: resourceSnapshot.measurement, requested: null, unusedReservations: [], requiredFileSystemIds, homeFileSystemId,
          estimate: { status: 'UNKNOWN', sources, reason } }, policy, requestedTier, queueId });
        return { admitted: false as const, reason: admission.reasons.join('; '), admission };
      };
      if (reasons.length) return unavailable(reasons.join('; '));
      const taskConfiguration = await loadTaskContextConfiguration(context.confRoot, configuration.catalog);
      const resolution = resolveAgentResourceEstimate({
        flow: { resourceEstimates: taskConfiguration.resourceEstimates }, type: input.activity.type, project: input.activity.project,
        tasks: input.assignment.changes.flatMap(change => change.items.map(item => ({ project: input.activity.project, change: change.id, item: item.id }))),
        fileSystemIds: requiredFileSystemIds,
      });
      if (resolution.status === 'UNKNOWN') return unavailable(resolution.reason, resolution.sources);
      const requested = resolution.reservation;
      const estimate = { status: 'KNOWN' as const, sources: resolution.sources, reason: null };
      const candidates = tools.state.listReconciliationCandidates().filter(session => session.process);
      const observed = await observeKnownProcesses(candidates.map(session => session.process!), { execute });
      const measured = { measurement: resourceSnapshot.measurement, observedProcesses: candidates.flatMap((session, index) => observed[index].state === 'alive' ? [{ runId: session.runId, identity: session.process! }] : []) };
      let admissionSnapshot: AdmissionSnapshot | undefined;
      const evaluate = (value: ResourceAdmissionInput): ResourceAdmission => {
        admissionSnapshot = buildAdmissionSnapshot({ input: { ...value, estimate }, policy, requestedTier, queueId });
        return { level: admissionSnapshot.level, allowed: {
          normal: admissionSnapshot.level === 'ANY_RUN',
          hotfix: admissionSnapshot.level === 'ANY_RUN' || admissionSnapshot.level === 'HOTFIX_ONLY',
        }, reasons: admissionSnapshot.reasons, measurement: value.measurement, remaining: admissionSnapshot.remaining, estimate };
      };
      const synchronize = (decision: ResourceAdmission) => {
        if (!admissionSnapshot || decision.level === 'UNKNOWN' && admissionSnapshot.level !== 'UNKNOWN') {
          admissionSnapshot = buildAdmissionSnapshot({ input: { measurement: measured.measurement, requested, unusedReservations: [], requiredFileSystemIds, homeFileSystemId,
            estimate: { status: 'UNKNOWN', sources: estimate.sources, reason: decision.reasons.join('; ') } }, policy, requestedTier, queueId });
        }
        return admissionSnapshot;
      };
      const admission = store.sessionRepository.transaction(tx => evaluateLaunchAdmissionInTransaction(tx, { requested, requiredFileSystemIds, homeFileSystemId, estimate }, measured, evaluate), 'read');
      synchronize(admission);
      if ((!input.queueClaim && !admission.allowed[requestedTier]) || admission.level === 'UNKNOWN') return { admitted: false, reason: admission.reasons.join('; '), admission: admissionSnapshot! };
      const record = prepared.get(input.tmuxSession);
      if (!record || record.reportPath !== input.reportPath || input.assignment.root !== context.orchestratorRoot || !isDeepStrictEqual(record.launch.assignment, input.assignment) || !isDeepStrictEqual(record.launch.writeBoundaries ?? [], input.writeBoundaries ?? [])) fail('INVALID_CONTEXT', 'Prepared launch context mismatch');
      const identityAdapter = createAssignmentIdentityAdapter({ [input.activity.project]: context.orchestratorRoot }, options.execute ? { execute: options.execute } : {});
      const tasks = await identityAdapter.capture(input.activity.project, input.assignment);
      const queueState = input.queueClaim ? createAgentQueueState(store) : undefined;
      if (input.queueClaim) {
        const claim = input.queueClaim;
        const wait = queueState!.transaction(tx => {
          const own = queueState!.get(claim.record);
          if (claim.rechecking && (!own || own.phase !== 'rechecking')) fail('LAUNCH_FENCE_LOST', 'Queue claim changed before resource recheck');
          if (!claim.rechecking && own) fail('LAUNCH_FENCE_LOST', 'Queue claim already exists');
          const entry = { ...own, record: claim.record, phase: 'waiting' as const, tasks, fingerprint: claim.validation.fingerprint };
          queueState!.assertClaim(tx, entry, claim.validation);
          const predecessors = queueState!.hasPendingTests(claim.record.clientIdentity.machineId) || queueState!.list().some(other => other.record.clientIdentity.machineId === claim.record.clientIdentity.machineId && other.record.requestId !== claim.record.requestId);
          const waiting = !admission.allowed[requestedTier] || !claim.rechecking && predecessors;
          queueState!.save({ ...entry, phase: waiting ? 'waiting' : 'starting' });
          return waiting;
        });
        if (wait) return { admitted: false, waiting: true, reason: admission.reasons.join('; ') || 'Existing launch queue requires a resource permit', admission: admissionSnapshot! };
      }
      const testAssignment = record.testAssignment;
      const resourceUsageContext = {
        identity: { kind: 'agent' as const, id: input.runId, machineId: boot.machineId, bootId: boot.bootId, fence: randomUUID(), root: null },
        project: input.activity.project, agentType: input.activity.type, testProfile: null,
        items: input.assignment.changes.flatMap(change => change.items.map(item => ({ project: input.activity.project, change: change.id, item: item.id }))),
        requestedEstimate: { ...requested, sources: resolution.sources, confHash: createHash('sha256').update(JSON.stringify({ resources: taskConfiguration.resources, resourceEstimates: taskConfiguration.resourceEstimates })).digest('hex') },
        requiredFileSystems: requiredFileSystemIds.map(id => ({ id, paths: paths.filter(path => resourceSnapshot.fileSystemByPath[path] === id) })),
        attributedPaths: [join(input.tmpRoot, input.runId)],
      };
      const request = { runId: input.runId, addressId: input.addressId, activity: input.activity, launchContext: { ...(input.taskContext ? { modelRouting: { parameters: input.taskContext.parameters } } : {}), resourceUsageContext, ...(input.queueClaim ? { agentQueue: input.queueClaim.record } : {}), ...(record.workspaceTrustDenied ? { workspaceTrustDenied: true as const } : {}), reportedCommits: record.reportedCommits, reportSchema: record.launch.taskContext?.context.reportSchema, testAssignment, assignment: input.assignment, selection: input.selection, reportPath: input.reportPath, briefPath: join(input.tmpRoot, input.runId, 'brief.txt'), writeBoundaries: [...(record.launch.writeBoundaries ?? [])] }, resource: 'runtime', amount: requested.ramBytes, requested, requiredFileSystemIds, homeFileSystemId, estimate, mode: input.activity.type === 'hotfix' ? 'hotfix' as const : 'normal' as const };
      let admissionReason = '';
      const caller = input.queueClaim ? input.queueClaim.record.launcher?.runId : input.handoff
        ? readSession(input.handoff.predecessorRunId)?.launchedBy?.runId : await (async () => {
        try { const sender = await tools.resolve(await context.resolveCaller()); return sender.kind === 'agent' ? sender.runId : undefined; }
        catch { return undefined; }
      })();
      try {
        const claimed = await claimTaskReservations(dependencies, { runId: input.runId, addressId: input.addressId, tasks, starter: await ownIdentity(execute, input.runId, input.tmuxSession), reserveLaunch: tx => {
          if (input.queueClaim) {
            const entry = queueState!.get(input.queueClaim.record);
            if (!entry || entry.phase !== 'starting') fail('LAUNCH_FENCE_LOST', 'Queue claim changed before atomic resource reserve');
            queueState!.assertClaim(tx, entry, input.queueClaim.validation);
          }
          if (input.notify) {
            const target = tx.getSession(input.notify.runId);
            if (target?.state !== 'running' || target.addressId !== input.notify.addressId) fail(NOTIFY_TARGET_INVALID, `Notify target is no longer active: ${input.notify.addressId}`);
          }
          const predecessor = input.handoff ? tx.getSession(input.handoff.predecessorRunId) : undefined;
          if (input.handoff && (!predecessor || predecessor.state !== 'finished' || !predecessor.modelHandoff || predecessor.successorRunId || predecessor.ownerAction || predecessor.result?.status === 'succeeded' || predecessor.result?.forcedClose)) fail('LAUNCH_FENCE_LOST', 'Predecessor is not available for one new handoff launch');
          const result = reserveLaunchInTransaction(tx, request, measured, evaluate);
          synchronize(result.admission);
          if (!result.reserved) { admissionReason = result.admission.reasons.join('; '); throw new Error('RESOURCE_UNAVAILABLE'); }
          if (predecessor) tx.putSession({ ...predecessor, revision: predecessor.revision + 1, successorRunId: input.runId, modelHandoff: undefined });
          if (input.activity.phase === 'context-review') {
            const review = reserveStartupContextReview({ runId: input.runId, phase: 'context-review', brief: '', assignment: input.assignment }, { database: store.startupContextDatabase });
            if (review) tx.putSession({ ...result.session, launchContext: { ...result.session.launchContext!, contextReview: review } });
          }
          const launcher = caller ? tx.getSession(caller) : undefined;
          const launchedBy = input.queueClaim ? input.queueClaim.record.launcher ?? undefined : input.handoff
            ? predecessor?.launchedBy : launcher?.state === 'running'
              ? { addressId: launcher.addressId, runId: launcher.runId } : undefined;
          if (!launchedBy && !input.notify) return tx.getSession(input.runId)!;
          const session = { ...tx.getSession(input.runId)!, revision: result.session.revision + 1,
            ...(launchedBy ? { launchedBy } : {}), ...(input.notify ? { notify: input.notify } : {}) };
          tx.putSession(session);
          return session;
        }, resolveDelegator: async () => caller, deferDelegation: !!input.queueClaim?.record.coordinator });
        if (!claimed.reserved) fail('TASK_RESERVED', JSON.stringify(claimed.conflicts));
        return { admitted: true, admission: admissionSnapshot! };
      } catch (error) {
        if (admissionReason) {
          if (input.queueClaim && admissionSnapshot?.level !== 'UNKNOWN') {
            queueState!.transaction(() => {
              const entry = queueState!.get(input.queueClaim!.record);
              if (!entry) fail('LAUNCH_FENCE_LOST', 'Queue claim lost after resource refusal');
              queueState!.save({ ...entry!, phase: 'waiting' });
            });
            return { admitted: false, waiting: true, reason: admissionReason, admission: admissionSnapshot! };
          }
          if (input.queueClaim && !input.queueClaim.rechecking) queueState!.transaction(() => { queueState!.remove(input.queueClaim!.record); });
          return { admitted: false, reason: admissionReason, admission: admissionSnapshot! };
        }
        if (input.queueClaim && !input.queueClaim.rechecking) queueState!.transaction(() => { queueState!.remove(input.queueClaim!.record); });
        throw error;
      }
    },
    adapter: { start: async request => {
      const selection = { runner: request.selection.runner, model: request.selection.model, effort: request.selection.effort };
      const record = prepared.get(request.tmuxSession);
      if (!record || !isDeepStrictEqual({ runner: record.launch.selection.runner, model: record.launch.selection.model, effort: record.launch.selection.effort }, selection) || request.cwd !== record.launch.activity.cwd) fail('INVALID_CONTEXT', 'Unprepared worker launch');
      const session = readSession(record.launch.runId);
      if (session?.state !== 'reserved' || !leaseFor(record.launch.runId)) fail('TASK_CLAIM_REQUIRED', 'Durable launch and task claims required before spawn');
      if (session.launchContext?.contextReview) {
        const review = session.launchContext.contextReview;
        const contextReviewInputPath = join(context.tmpRoot, session.runId, 'context-review-input.json');
        const payload = { contextReviewId: review.contextReviewId, runIds: review.runIds, traces: review.runIds.map(runId => readStartupContextTrace(store.startupContextDatabase, runId)) };
        await fs.writeFile(contextReviewInputPath, JSON.stringify(payload), { mode: 0o600 });
        request = { ...request, brief: `${request.brief}${review.brief}contextReviewInputPath: ${contextReviewInputPath}\n` };
      }
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
      const sessionStartEntry = new URL('./production-entry.ts', import.meta.url).href;
      if (!options.execute && context.stateContext?.mode === 'qa') await runtimeTmuxSocket(context, stateContextEnvironment(context.stateContext, process.env));
      record.spawnAttempted = true;
      try {
        record.handshake = await launchPersistentWrapper({ tmpRoot: context.tmpRoot, statePath: context.statePath, cwd: request.cwd, runId: record.launch.runId, address: record.launch.addressId, phase: record.launch.activity.phase, assignment: record.launch.assignment, reportedCommits: session.launchContext?.reportedCommits, selection, tmuxSession: request.tmuxSession, brief: request.brief, readinessTimeoutMs: settings.timeouts.startupMs }, {
        timeoutMs: settings.timeouts.overallMs, signal: request.signal,
        workerCommand: { executable: process.execPath, environment: context.stateContext ? stateContextEnvironment(context.stateContext, process.env) : process.env, args: ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(modulePath).href)});const entry=await import(${JSON.stringify(sessionStartEntry)});await m.runProductionWorker({prepareSessionStartChannel:entry.prepareProductionSessionStartChannel});`], cwd: request.cwd },
        });
      } catch (error) {
        record.wrapperFailure = (error as Partial<PersistentWrapperFailure>).wrapper;
        if (request.signal?.aborted) throw error;
        const failure = await workerLaunchFailure(context.tmpRoot, record.launch.runId, record.wrapperFailure) ?? error;
        await retryStateOperation(() => recordLaunchFailure(store, record.launch.runId, failure instanceof Error ? failure.message : String(failure)), settings.timeouts);
        throw failure;
      }
      return { tmuxSession: request.tmuxSession, selection, warnings: record.handshake.warnings ?? [] };
    } },
    verifyStarted: async (launch, session) => {
      const handshake = prepared.get(launch.tmuxSession)?.handshake;
      if (!handshake || !isDeepStrictEqual(session.selection, { runner: launch.selection.runner, model: launch.selection.model, effort: launch.selection.effort }) || session.tmuxSession !== launch.tmuxSession || handshake.runId !== launch.runId || handshake.address !== launch.addressId || handshake.reportPath !== join(launch.tmpRoot, launch.runId, `${launch.addressId}.json`) || handshake.identity.tmuxSession !== launch.tmuxSession || handshake.identity.runner !== launch.selection.runner || handshake.identity.evidence.runId !== launch.runId) fail('RUNNER_IDENTITY_INVALID', 'Worker handshake does not match the requested launch');
      const observation = (await observeKnownProcesses([handshake.identity], { execute }))[0];
      if (observation.state !== 'alive' || !await belongsToPane(handshake.identity, execute)) fail('RUNNER_IDENTITY_INVALID', `Runner observation is ${observation.state} or its owned pane changed`);
      return handshake.identity;
    },
    commitStarted: async (runId, identity) => { const session = readSession(runId); return !!session && ((session.state === 'running' && !!session.process && sameIdentity(session.process, identity)) || tools.state.commitStarted(runId, identity)); },
    compensate: async launch => {
      const preparedLaunch = prepared.get(launch.tmuxSession);
      if (preparedLaunch && !preparedLaunch.spawnAttempted) return { stopped: true };
      const session = readSession(launch.runId);
      const identity = session?.process ?? prepared.get(launch.tmuxSession)?.handshake?.identity;
      if (preparedLaunch?.wrapperFailure) {
        await preparedLaunch.wrapperFailure.terminate();
        preparedLaunch.wrapperGone = true;
        if (!identity) {
          const budget = protocolFor(await protocols(context.confRoot, options.protocolSettings), launch.selection.runner).timeouts;
          return await discardOwnedTmuxSession(execute, launch.tmuxSession, budget) ? { stopped: true } : { stopped: false, reason: 'Own tmux session of the failed launch could not be confirmed terminated' };
        }
      }
      if (!identity) return { stopped: false, reason: 'Runner life is unknown after worker spawn; recover this run before retry' };
      const observation = (await observeKnownProcesses([identity], { execute }))[0];
      if (observation.state === 'exited') return { stopped: true };
      if (observation.state !== 'alive' || !await belongsToPane(identity, execute)) return { stopped: false, reason: 'Runner ownership or tmux pane association unknown' };
      const adapter = new TmuxAgentAdapter({ execute, protocols: {} as Record<AgentRunner, RunnerProtocol> });
      await adapter.stop({ tmuxSession: identity.tmuxSession, selection: { runner: identity.runner as AgentRunner, model: launch.selection.model, effort: launch.selection.effort } });
      return (await observeKnownProcesses([identity], { execute }))[0].state === 'exited' ? { stopped: true } : { stopped: false, reason: 'Runner death not confirmed' };
    },
    abortLaunch: async (runId, reason) => {
      const runner = readSession(runId)?.launchContext?.selection.runner ?? [...prepared.values()].find(row => row.launch.runId === runId)?.launch.selection.runner;
      if (runner) await retryStateOperation(() => recordLaunchFailure(store, runId, reason), await budgetFor(runner));
      const session = readSession(runId);
      if (session?.state === 'running') {
        const record = [...prepared.values()].find(row => row.launch.runId === runId);
        if (!record?.wrapperGone || !session.process || (await observeKnownProcesses([session.process], { execute }))[0].state !== 'exited') fail('LAUNCH_RECOVERABLE', `${runId}: ${reason}; worker lifecycle owns running launch cleanup`);
        tools.state.commitObservation(runId, session.revision, { state: 'exited', observedAt: now(), exitCode: null, evidence: reason }, effects);
        const exited = readSession(runId)!;
        await tools.finalize(exited, exited.activity ? [{ kind: 'ended', session: exited, project: exited.activity.project }] : []);
        return;
      }
      await release(runId, 'cancelled');
    },
    control: {
      ps: async () => {
        const sessions = await processObservationPass.run({ execute, observations: new Map() }, async () => {
          await reconcileHandoffs();
          const sessions = await tools.control.ps();
          if (sessions.some(session => session.observation?.state === 'unknown')) fail('PROCESS_SCAN_UNKNOWN', 'Process scan returned unknown; reservations retained');
          await reconcileTaskReservations(await reservationTools(store, context, execute, options.execute));
          await reconcileFinishedAgentQueues({ store, current: readSession, observe: identity => observeIdentity(identity, execute), cleanReport: cleanQueuedReport });
          return sessions;
        });
        await tools.deliverResults();
        const handoffs = await settleModelHandoffs(store, context, configuration, options);
        const started = handoffs.flatMap(result => result.status === 'started' ? [result.session] : []);
        return resultNoticeViews(store, [...sessions, ...started.filter(row => !sessions.some(session => session.runId === row.runId))]);
      },
      update: async (id, patch, caller) => { await tools.authorize(id, caller); const session = tools.state.listReconciliationCandidates().find(session => session.addressId === id); if (!session?.activity) fail('SESSION_UNAVAILABLE', 'Session activity unavailable'); return tools.control.update(id, { ...session.activity, ...patch }); },
      message: (input, caller) => tools.control.message(input, caller),
      close: async (id, caller, options) => {
        await tools.authorize(id, caller, true);
        markOwnerAction(id, 'stopped');
        return tools.control.close(id, options);
      },
      interrupt: async (id, caller) => {
        await tools.authorize(id, caller, true);
        markOwnerAction(id, 'paused');
        return tools.control.interrupt(id);
      },
      attachMain: tools.attachMain,
    },
  };
  return api;
}

export async function runProductionWorker(
  options: {
    execute?: AdapterCommandExecutor;
    protocolSettings?: readonly ProtocolSettings[];
    prepareSessionStartChannel?: PrepareSessionStartChannel;
  } = {},
): Promise<void> {
  const costStartedAt = rafCostBoundary();
  const stateContext = productionStateContext(process.env.RAF_ORCHESTRATOR_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), fileURLToPath(import.meta.url), homedir(), 'worker');
  const generationLease = await retainHotfixGeneration({ orchestratorRoot: stateContext.orchestratorRoot, qaHome: homedir(), environment: {}, sandboxExecutable: 'codex' }, fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''));
  const channel = await consumeWrapperRequest();
  if (channel.request.statePath !== stateContext.statePath || channel.request.tmpRoot !== stateContext.tmpRoot) throw stateFailure('STATE_CONTEXT_REFUSED', 'Worker state/tmp paths differ from selected HOME');
  const request = channel.request;
  process.stderr.write(`${now()} worker started run=${request.runId} pid=${process.pid} ppid=${process.ppid}\n`);
  if (platform() === 'linux') {
    try {
      const [stat, namespace] = await Promise.all([fs.readFile('/proc/self/stat', 'utf8'), fs.readlink('/proc/self/ns/pid')]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      process.stderr.write(`${request.runId}: worker process group=${fields[2]} session=${fields[3]} pidNamespace=${namespace}\n`);
    } catch (error) { process.stderr.write(`${request.runId}: worker process context unavailable: ${String(error)}\n`); }
  }
  let manifest;
  const manifestPath = join(request.tmpRoot, request.runId, 'runtime.json');
  try {
    const metadata = await fs.lstat(manifestPath);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) fail('WORKER_CONTEXT_INVALID', 'Worker runtime envelope must be an owned private regular file');
    manifest = await json(manifestPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('WORKER_CONTEXT_UNAVAILABLE', `Prepared worker runtime envelope is missing: ${manifestPath}`); throw error; }
  if (manifest.version !== 1 || manifest.context?.statePath !== request.statePath || manifest.context?.tmpRoot !== request.tmpRoot || manifest.context?.orchestratorRoot !== request.assignment.root || !isAbsolute(manifest.context?.confRoot ?? '')) fail('INVALID_CONTEXT', 'Worker runtime envelope mismatch');
  const context: RuntimeContext = { ...manifest.context, stateContext, resolveCaller: async () => undefined };
  const execute = runtimeExecution(context, options.execute, true);
  const configured = protocolFor(options.protocolSettings ?? manifest.protocolSettings ?? await protocols(context.confRoot), request.selection.runner);
  const resolution = await resolveRunnerExecutable(configured.runner, configured.executable, process.env);
  if (resolution.status !== 'resolved' || !text(manifest.runnerPath) || resolution.path !== manifest.runnerPath) fail('RUNNER_PROTOCOL_UNAVAILABLE', resolution.status === 'resolved' ? `Worker runner path ${resolution.path} differs from launch runner path ${manifest.runnerPath ?? 'missing'}` : resolution.reason);
  const settings = { ...configured, executable: manifest.runnerPath as string };
  const availability = await probeRunnerAvailability(settings, { env: process.env, execute });
  if (!availability.available) fail('RUNNER_PROTOCOL_UNAVAILABLE', availability.reason);
  const sqliteStartedAt = rafCostBoundary();
  const store = openStateStore(request.statePath, { context: stateContext });
  let costProfile: RafCostRuntime | undefined;
  let workerFailure: unknown;
  let stopHealthSummary: (() => Promise<void>) | undefined;
  let sessionStartChannel: OwnedSessionStartChannel | undefined;
  let unsubscribeSessionStart: (() => void) | undefined;
  let sessionStartWork: Promise<void> = Promise.resolve();
  let hotfixCommitPort: Awaited<ReturnType<typeof startHotfixCommitPort>> | undefined;
  let codexAccess: PreparedCodexRafCommandAccess | undefined;
  let codexSandbox: PreparedCodexSandbox | undefined;
  let toolTmuxDirectory: Awaited<ReturnType<typeof createRafToolSocketDirectory>> | undefined;
  try {
    costProfile = new RafCostRuntime(store, { scope: 'worker', command: null }, context.orchestratorRoot, 'preparation', costStartedAt, sqliteStartedAt);
    costProfile.install();
    await settleRuntimeHealthCpu(store, context.orchestratorRoot);
    const tools = sessionTools(store, execute, manifest.configuration, context, async () => settings, options.execute);
    const session = tools.current(request.runId);
    if (session?.state !== 'reserved' || session.addressId !== request.address || session.activity?.cwd !== request.cwd || !session.launchContext || !isDeepStrictEqual(session.launchContext.assignment, request.assignment) || session.launchContext.reportPath !== join(request.tmpRoot, request.runId, `${request.address}.json`) || !isDeepStrictEqual({ runner: session.launchContext.selection.runner, model: session.launchContext.selection.model, effort: session.launchContext.selection.effort }, request.selection) || await fs.readFile(session.launchContext.briefPath, 'utf8') !== request.brief) fail('INVALID_CONTEXT', 'Worker launch does not match durable reserved context');
    const settleWorkerHealth = () => settleCommandState({ store, orchestratorRoot: context.orchestratorRoot, now: Date.now, nextReminderId: randomUUID,
      catalog: loadEventCatalog(context.orchestratorRoot, manifest.configuration.catalog), deliver: message => tools.control.message(message, rafSystemCaller) });
    try { await settleWorkerHealth(); } catch (error) { process.emitWarning(String(error)); }
    stopHealthSummary = scheduleWorkerHealthSummary(store, context.orchestratorRoot, settleWorkerHealth);
    const hotfix = manifest.workspaceRoute?.hotfix;
    if (hotfix) {
      if (hotfix.runId !== request.runId || manifest.workspaceRoute.branch !== 'hotfix' || !isDeepStrictEqual(hotfix, manifest.workspace) || request.cwd !== hotfix.cwd) fail('BRANCH_MISMATCH', 'Invalid persistent hotfix identity');
      await refreshHotfixWorktree({ orchestratorRoot: context.orchestratorRoot, qaHome: stateContext.homeDirectory, environment: {}, sandboxExecutable: 'codex' }, hotfix);
      hotfixCommitPort = await startHotfixCommitPort({ orchestratorRoot: context.orchestratorRoot, qaHome: stateContext.homeDirectory, environment: {}, sandboxExecutable: 'codex' }, hotfix, dirname(session.launchContext.reportPath));
    }
    const writeBoundaries = manifest.writeBoundaries ?? [];
    const workspaceTrustDenied = session.launchContext.workspaceTrustDenied === true;
    if ((manifest.workspaceTrustDenied === true) !== workspaceTrustDenied) fail('INVALID_CONTEXT', 'Worker workspace trust decision does not match durable launch context');
    if (!Array.isArray(writeBoundaries) || !writeBoundaries.every(text) || !isDeepStrictEqual(writeBoundaries, session.launchContext.writeBoundaries ?? [])) fail('INVALID_CONTEXT', 'Worker write boundaries do not match durable launch context');
    const dependencies = await reservationTools(store, context, execute, options.execute);
    let lease: TaskReservationLease | null | undefined = listTaskReservations(store).find(set => set.lease.owner.runId === request.runId)?.lease;
    if (!lease) fail('TASK_CLAIM_REQUIRED', 'Worker has no fenced task reservation');
    lease = await handoffTaskReservations(dependencies, { lease, wrapper: await ownIdentity(execute, request.runId, request.tmuxSession) });
    if (!lease) fail('TASK_CLAIM_LOST', 'Worker handoff lost its task reservation');
    const native = settings.native!;
    const deferred = native.identity.source === 'session_start';
    const identityCommand = native.identity.source === 'session_start' ? null : native.identity.command;
    const assignedId = native.identity.source === 'assigned' ? randomUUID() : undefined;
    let invocation = buildRunnerInvocation(settings, { ...request.selection, ...(assignedId ? { sessionId: assignedId } : {}) });
    if (hotfix && settings.runner === 'codex') invocation.args.push('-C', request.cwd);
    let deliveryEvidenceIsolated = false;
    try {
      const writable = await runnerWritableDirectories(request.cwd, writeBoundaries, dirname(session.launchContext.reportPath), request.statePath, settings.runner === 'codex', context.orchestratorRoot);
      invocation.args.push(...nativeWriteScopeArgs(settings, hotfix ? [...new Set([...writable.directories, ...writable.workspace])] : writable.directories, writable.workspace));
      const scope = await runnerSandboxScope(session?.launchContext?.testAssignment?.type ?? session.activity?.type, dirname(session.launchContext.reportPath), request.statePath);
      const protectsMain = rafSubcommandsFor(session.launchContext.testAssignment?.type ?? session.activity?.type ?? '') !== null;
      const mainReadOnly = protectsMain ? await agentChannelReadOnlyPaths(context.orchestratorRoot, stateContext.homeDirectory) : [];
      const runnerReadOnly = [...mainReadOnly, ...await sharedLibraryReadOnlyPaths(context.orchestratorRoot, await json(join(context.confRoot, 'projects.json')), session.launchContext.reportedCommits)];
      if (settings.runner === 'claude' && !socketPathFits(join(scope.tmuxDirectory, `tmux-${process.getuid?.() ?? 0}`, 'default'))) {
        toolTmuxDirectory = await createRafToolSocketDirectory();
        scope.tmuxDirectory = toolTmuxDirectory.directory;
        scope.readable.push(toolTmuxDirectory.directory);
        invocation.args.push(...nativeWriteScopeArgs(settings, [toolTmuxDirectory.directory]));
      }
      invocation.args.splice(0, invocation.args.length, ...nativeSandboxArgs(settings, invocation.args, scope));
      deliveryEvidenceIsolated = settings.runner === 'claude';
      if ((hotfix || runnerReadOnly.length) && settings.runner === 'claude') {
        const index = invocation.args.indexOf('--settings');
        const settingsValue = index < 0 ? undefined : JSON.parse(invocation.args[index + 1]);
        if (settingsValue?.sandbox) {
          settingsValue.sandbox.filesystem = { ...settingsValue.sandbox.filesystem, denyWrite: [...(settingsValue.sandbox.filesystem?.denyWrite ?? []), ...runnerReadOnly, ...(hotfix ? [hotfix.commonDirectory, join(hotfix.cwd, '.git')] : [])], allowWrite: [...writable.directories, ...writable.workspace] };
          invocation.args[index + 1] = JSON.stringify(settingsValue);
        }
      }
      if (settings.runner === 'codex' && codexInvocationSandboxMode(invocation.args) !== null) {
        try {
          codexSandbox = await prepareCodexSandbox({ runId: request.runId, invocation, scope, cwd: request.cwd, runDirectory: dirname(session.launchContext.reportPath), writableDirectories: [...writable.directories, ...writable.workspace], readOnlyDirectories: [...runnerReadOnly, ...(hotfix ? [hotfix.commonDirectory, join(hotfix.cwd, '.git')] : [])], environment: process.env });
        } catch (error) {
          if (error instanceof CodexSandboxUnavailable) fail('RUNNER_SANDBOX_UNAVAILABLE', error.message);
          throw error;
        }
        deliveryEvidenceIsolated = process.platform !== 'darwin';
        invocation = codexSandbox.invocation;
      }
      if (settings.runner === 'codex') {
        codexAccess = await prepareCodexRafCommandAccess({ invocation, scope, cwd: request.cwd, runDirectory: dirname(session.launchContext.reportPath), environment: process.env, timeoutMs: settings.timeouts.transitionMs,
          publication: { orchestratorRoot: context.orchestratorRoot, homeDirectory: stateContext.homeDirectory, runId: request.runId, agentId: request.address } });
        invocation = codexAccess.invocation;
        if (codexAccess.unavailable) process.stderr.write(`${request.runId}: ${codexAccess.unavailable}\n`);
      }
    } catch (error) {
      if (workspaceTrustDenied) await runnerWorkspaceUntrusted(request, settings.runner);
      throw error;
    }
    if (deferred) {
      let prepareSessionStartChannel = options.prepareSessionStartChannel;
      if (!prepareSessionStartChannel) {
        const entry = await import('./production-entry.ts') as { prepareProductionSessionStartChannel?: PrepareSessionStartChannel };
        prepareSessionStartChannel = entry.prepareProductionSessionStartChannel;
      }
      if (!prepareSessionStartChannel) fail('RUNNER_IDENTITY_UNAVAILABLE', 'An owned per-launch SessionStart channel is required; live agy attachment is not enabled');
      sessionStartChannel = await prepareSessionStartChannel({ runId: request.runId, workspace: request.cwd, runDirectory: dirname(session.launchContext.reportPath), invocation });
      if (!text(sessionStartChannel.writerGeneration) || !sessionStartChannel.invocation || typeof sessionStartChannel.verifyOrigin !== 'function' || typeof sessionStartChannel.subscribe !== 'function') fail('RUNNER_IDENTITY_UNAVAILABLE', 'Invalid owned SessionStart channel');
      invocation = { ...invocation, ...sessionStartChannel.invocation, args: [...sessionStartChannel.invocation.args] };
      store.sessionRepository.transaction(tx => {
        const current = tx.getSession(request.runId);
        if (!current || current.state !== 'reserved' || !current.launchContext) fail('INVALID_CONTEXT', 'SessionStart launch is no longer reserved');
        tx.putSession({ ...current, revision: current.revision + 1, launchContext: { ...current.launchContext, sessionStart: { workspace: request.cwd, writerGeneration: sessionStartChannel!.writerGeneration } } });
      });
    }
    if (hotfix) await fs.writeFile(join(dirname(session.launchContext.reportPath), 'invocation.json'), JSON.stringify({ cwd: request.cwd, runId: request.runId, runner: settings.runner, invocation }), { mode: 0o600 });
    let screen = '';
    let screenCapturedAt: string | undefined;
    let nativeId: string | null = null;
    let dismissed = false;
    let actual: ProcessIdentity | undefined;
    const ownedProcessPath = join(dirname(session.launchContext.reportPath), 'owned-process.json');
    let ownedProcessPublication = Promise.resolve();
    const publishOwnedProcess = (identity: ProcessIdentity) => {
      if (!deferred) return Promise.resolve();
      const contents = JSON.stringify(identity);
      const publication = ownedProcessPublication.then(async () => {
        const temporary = `${ownedProcessPath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, contents, { mode: 0o600 });
        await fs.rename(temporary, ownedProcessPath);
      });
      ownedProcessPublication = publication.catch(error => { process.stderr.write(`${request.runId}: Owned process publication failed: ${String(error)}\n`); });
      return publication;
    };
    const emptyComposer = (pane: string) => { const input = readNativeComposer(settings, pane)?.input; return input !== undefined && (input === '' || !!settings.markers.ready?.includes(input)); };
    const protocol: RunnerProtocol = {
      nativeIdentitySource: native.identity.source,
      invocation: () => invocation,
      observe: pane => {
        screen = pane;
        screenCapturedAt = now();
        const observation = observeRunnerScreen(settings, { text: pane, version: availability.version, requestedCommand: nativeId ? identityCommand : null });
        if (observation.state === 'workspace_trust_required') return { status: 'failed', reason: observation.state };
        const durable = tools.current(request.runId)?.process;
        if (deferred && actual && durable && sameIdentity(actual, durable)) { actual = structuredClone(durable); nativeId = actual.runnerSessionId; void publishOwnedProcess(actual); }
        const shown = readNativeSessionId(settings, pane)?.toLowerCase();
        if (assignedId && shown && shown !== assignedId) return { status: 'failed', reason: 'Native session identity differs from the assigned session id' };
        if (shown) nativeId = shown;
        if (deferred && observation.state === 'ready' && emptyComposer(pane)) return { status: 'ready', cliSessionId: nativeId, nativeIdentity: actual?.nativeIdentity ?? { state: 'pending', id: null, reason: 'Awaiting owned SessionStart conversationId' } };
        if (observation.state === 'ready' && nativeId && dismissed && (native.identity.source !== 'session_start' && !native.identity.dismissKeys.length || emptyComposer(pane))) return { status: 'ready', cliSessionId: nativeId };
        if (['auth_required', 'permission_required', 'quota_untrusted'].includes(observation.state)) return { status: 'failed', reason: observation.state };
        return { status: 'starting' };
      },
    };
    const adapter = new TmuxAgentAdapter({ execute, protocols: { [request.selection.runner]: protocol } as Record<AgentRunner, RunnerProtocol> });
    const adapterSession: AdapterSession = { tmuxSession: request.tmuxSession, selection: request.selection };
    const ownership = async (): Promise<LaunchOwnership> => {
      if (actual) { const durable = tools.current(request.runId)?.process; if (deferred && durable && sameIdentity(actual, durable)) { actual = structuredClone(durable); nativeId = actual.runnerSessionId; void publishOwnedProcess(actual); } const result = (await observeKnownProcesses([actual], { execute }))[0]; if (result.state === 'alive') return await belongsToPane(actual, execute) ? { state: 'owned', identity: actual, processKind: 'agent' } : { state: 'mismatch', reason: 'Native runner no longer belongs to the owned tmux pane' }; return { state: result.state, reason: result.state === 'unknown' ? result.error : result.evidence }; }
      if (!nativeId && !deferred) return { state: 'unknown', reason: 'Native runner identity unavailable' };
      const pane = await execute({ executable: 'tmux', args: ['display-message', '-p', '-t', `=${request.tmuxSession}:0.0`, '#{pane_pid}'] });
      if (pane.exitCode !== 0 || !/^\d+$/.test(pane.stdout.trim())) return { state: 'unknown', reason: 'Owned tmux pane PID unavailable' };
      const rows = await processRows(execute);
      const descendants = new Set([Number(pane.stdout.trim())]);
      for (let size = -1; size !== descendants.size;) { size = descendants.size; for (const row of rows) if (descendants.has(row.ppid)) descendants.add(row.pid); }
      const matching = rows.filter(row => descendants.has(row.pid) && row.command.split(/\s+/).some(word => basename(word) === basename(invocation.executable)) && !/^(?:\S*\/)?(?:sh|bash|zsh)\s/.test(row.command));
      const candidates = matching.filter(candidate => !matching.some(other => { let pid = other.ppid; const seen = new Set<number>(); while (pid && !seen.has(pid)) { if (pid === candidate.pid) return true; seen.add(pid); pid = rows.find(row => row.pid === pid)?.ppid ?? 0; } return false; }));
      if (candidates.length !== 1) return { state: 'unknown', reason: 'Actual runner PID is ambiguous or unavailable; shell PID is not identity' };
      const row = candidates[0];
      const paneId = await execute({ executable: 'tmux', args: ['display-message', '-p', '-t', `=${request.tmuxSession}:0.0`, '#{pane_id}'] });
      if (paneId.exitCode !== 0 || !/^%\d+$/.test(paneId.stdout.trim())) return { state: 'unknown', reason: 'Owned tmux pane identity unavailable' };
      actual = { pid: row.pid, startedAt: row.startedAt, runner: request.selection.runner, runnerSessionId: nativeId, ...(deferred ? { nativeIdentity: { state: 'pending' as const, id: null, reason: 'Awaiting owned SessionStart conversationId' } } : {}), tmuxSession: request.tmuxSession, evidence: { command: row.command, runId: request.runId, tmuxPane: paneId.stdout.trim(), cwd: request.cwd, executable: availability.path, ...await dependencies.currentBoot(), tmuxSocket: await runtimeTmuxSocket(context, stateContextEnvironment(stateContext, process.env)) } };
      await publishOwnedProcess(actual);
      return { state: 'owned', identity: actual, processKind: 'agent' };
    };
    const transport = adapter.createLaunchTransport({ reportWrapper: { wrap: command => command }, inspectOwnership: ownership, pollIntervalMs: settings.timeouts.pollMs, waitForExit: session => adapter.waitForExit(session) });
    let requestedStatus = false;
    let submittedStatus = false;
    let retriedStatus = false;
    let statusDeadline = 0;
    let statusScreen = '';
    const target = `=${request.tmuxSession}:0.0`;
    const composerInput = (text: string) => readNativeComposer(settings, text)?.input;
    let trustAnsweredAt: number | undefined;
    let trustWarned = false;
    const untrusted = async (): Promise<never> => {
      return runnerWorkspaceUntrusted(request, settings.runner, trustAnsweredAt !== undefined);
    };
    const answerTrust = async (): Promise<void> => {
      if (trustAnsweredAt !== undefined) {
        if (!trustWarned && Date.now() - trustAnsweredAt >= settings.timeouts.transitionMs) { trustWarned = true; process.stderr.write(`${request.runId}: Warning: workspace trust prompt still shown ${Date.now() - trustAnsweredAt} ms after the answer; waiting\n`); }
        return;
      }
      const route = manifest.workspaceRoute;
      const task = object(route) && route.type === session.activity?.type && route.project === session.activity?.project && text(route.branch) ? { type: route.type, project: route.project, branch: route.branch } : undefined;
      if (workspaceTrustDenied || !(route?.hotfix ? request.cwd === route.hotfix.cwd : await registeredBranchDirectory(context.orchestratorRoot, context.confRoot, request.cwd, task, execute))) await untrusted();
      const observation = observeRunnerScreen(settings, { text: screen, version: availability.version, requestedCommand: null });
      const action = nextRunnerAction(settings, observation, { trustWorkspace: true });
      if (observation.state !== 'workspace_trust_required' || action.kind !== 'keys') await untrusted();
      trustAnsweredAt = Date.now();
      if (route?.hotfix) await fs.writeFile(join(dirname(session.launchContext!.reportPath), 'trust.json'), JSON.stringify({ cwd: request.cwd, runId: request.runId, screen, keys: (action as { keys: string[] }).keys, answeredAt: trustAnsweredAt }), { mode: 0o600 });
      await sendKeys((action as { keys: string[] }).keys);
    };
    const sendKeys = async (keys: string[]) => {
      const result = await execute({ executable: 'tmux', args: ['send-keys', '-t', target, ...keys] });
      if (result.exitCode !== 0) throw new Error('Runner status/navigation transport failed');
    };
    transport.waitReady = async timeoutMs => {
      const startedAt = Date.now();
      let trustShown = false;
      let lastScreen = 'no pane captured';
      const expiry = setTimeout(() => {
        const stage = requestedStatus ? `native status transition (${nativeId ? 'session id shown' : 'session id not shown'})` : `startup screen ${lastScreen}`;
        process.stderr.write(`${request.runId}: Warning: native runner readiness still pending after ${Date.now() - startedAt} ms (readiness deadline ${timeoutMs} ms); last ${stage}; waiting\n`);
      }, timeoutMs);
      const poll = async (): Promise<LaunchReadiness> => {
        for (;;) {
          const observed = await adapter.inspect(adapterSession);
          trustShown = observed.status === 'failed' && observed.reason === 'workspace_trust_required';
          if (observed.status === 'ready' && (observed.cliSessionId || deferred)) {
            if (workspaceTrustDenied) await untrusted();
            return { state: 'ready', runnerSessionId: observed.cliSessionId ?? null, ...(observed.nativeIdentity ? { nativeIdentity: observed.nativeIdentity } : {}) };
          }
          if (observed.status === 'exited') return { state: 'exited', reason: 'Runner exited before native identity' };
          if (trustShown) {
            await answerTrust();
            await new Promise(resolve => setTimeout(resolve, settings.timeouts.pollMs));
            continue;
          }
          if (observed.status === 'failed' || observed.status === 'limited') return { state: 'unknown_screen', reason: observed.reason };
          const observation = observeRunnerScreen(settings, { text: screen, version: availability.version, requestedCommand: requestedStatus ? identityCommand : null });
          lastScreen = observation.state;
          if (observation.state === 'starting' && !requestedStatus) {
            await new Promise(resolve => setTimeout(resolve, settings.timeouts.pollMs));
            continue;
          }
          if (observation.state === 'known_navigation') {
            const action = nextRunnerAction(settings, observation);
            if (action.kind !== 'keys') return { state: 'unknown_screen', reason: 'Unsupported startup navigation' };
            await sendKeys(action.keys);
            if (!requestedStatus) {
              dismissed = false;
              submittedStatus = false;
              retriedStatus = false;
            }
          } else if (observation.state === 'ready' && !nativeId && !requestedStatus) {
            requestedStatus = true;
            statusDeadline = Date.now() + settings.timeouts.transitionMs;
            if (!identityCommand) return { state: 'unknown_screen', reason: 'SessionStart composer is unavailable' };
            await sendKeys(['-l', identityCommand]);
          } else if (requestedStatus) {
            if (statusDeadline && Date.now() >= statusDeadline) { statusDeadline = 0; process.stderr.write(`${request.runId}: Warning: native status transition still pending after ${settings.timeouts.transitionMs} ms; waiting\n`); }
            if (nativeId && !dismissed) {
              if (native.identity.source !== 'session_start' && native.identity.dismissKeys.length) await sendKeys([...native.identity.dismissKeys]);
              dismissed = true;
            } else if (!submittedStatus && identityCommand !== null && screen.includes(identityCommand)) {
              statusScreen = screen;
              await sendKeys(['Enter']);
              submittedStatus = true;
            } else if (submittedStatus && !nativeId && observation.state === 'ready' && emptyComposer(screen) && screen !== statusScreen) {
              requestedStatus = false;
              submittedStatus = false;
              retriedStatus = false;
            } else if (submittedStatus && !retriedStatus && !nativeId && (composerInput(screen) === identityCommand || new RegExp(`>\\s*${identityCommand?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'mu').test(screen))) {
              await sendKeys(['Enter']);
              retriedStatus = true;
            } else if (nativeId && observation.state !== 'ready' && !['', identityCommand].includes(composerInput(screen) ?? '')) return { state: 'unknown_screen', reason: 'Unrecognized native-status transition screen' };
            else if (screen.trim() && (identityCommand === null || !screen.includes(identityCommand)) && !nativeId && !/\bSession\b/.test(screen) && observation.state !== 'ready') return { state: 'unknown_screen', reason: 'Unrecognized native-status transition screen' };
          } else if (screen.trim() && observation.state !== 'ready') return { state: 'unknown_screen', reason: `Runner readiness ${observation.state}` };
          await new Promise(resolve => setTimeout(resolve, settings.timeouts.pollMs));
        }
      };
      try { return await poll(); }
      finally { clearTimeout(expiry); }
    };
    transport.lastScreen = async () => redactDeliveryText(settings, { screen, brief: request.brief, phase: deliveryPhase, retried: deliveryRetried });
    const gate = async (identity: ProcessIdentity) => {
      const current = tools.current(request.runId);
      if (current?.launchContext?.agentQueue) {
        const queueState = createAgentQueueState(store);
        if (!queueState.transaction(() => queueState.get(current.launchContext!.agentQueue!))) fail('LAUNCH_FENCE_LOST', 'Queue claim lost before initial brief');
      }
      if (current?.state === 'running' && current.process && sameIdentity(current.process, identity)) return;
      if (!lease) fail('TASK_CLAIM_LOST', 'Task reservation lost before brief');
      const next = await startTaskReservations(dependencies, { lease, agent: identity as Awaited<ReturnType<typeof ownIdentity>> });
      if (!next || !await retryStateOperation(() => tools.state.commitStarted(request.runId, identity), settings.timeouts)) fail('TASK_CLAIM_LOST', 'Durable start gate rejected runner before brief');
      lease = next;
    };
    const pendingSessionStarts: unknown[] = [];
    const applySessionStarts = async () => {
      while (pendingSessionStarts.length) {
        const current = tools.current(request.runId);
        if (current?.state === 'reserved') return;
        const payload = pendingSessionStarts.shift();
        if (!current?.process || !sessionStartChannel) { process.stderr.write(`${request.runId}: SessionStart launch no longer exists\n`); continue; }
        let target: SessionRecord | undefined = current;
        while (target?.state === 'running' && target.process) {
          const result = await confirmAgySessionStart({ runId: request.runId, workspace: request.cwd, process: target.process, writerGeneration: sessionStartChannel.writerGeneration, expectedRevision: target.revision, payload }, {
            repository: store.sessionRepository,
            verifyOrigin: value => sessionStartChannel!.verifyOrigin(value),
            inspectProcess: async identity => {
              const observed = await observeIdentity(identity, execute);
              return observed.state === 'alive' && !await belongsToPane(identity, execute) ? { state: 'unknown', observedAt: now(), error: 'SessionStart runner no longer owns its tmux pane' } : observed;
            },
            now,
            diagnostic: reason => process.stderr.write(`${request.runId}: ${reason}\n`),
          });
          if (result.status !== 'rejected' || result.reason !== 'Stale SessionStart revision') break;
          const refreshed = tools.current(request.runId);
          target = refreshed?.state === 'running' && refreshed.process && sameIdentity(target.process, refreshed.process) && refreshed.revision !== target.revision ? refreshed : undefined;
        }
        const latest = tools.current(request.runId)?.process;
        if (latest && actual && sameIdentity(actual, latest)) { actual = structuredClone(latest); nativeId = actual.runnerSessionId; void publishOwnedProcess(actual); }
      }
    };
    if (sessionStartChannel) unsubscribeSessionStart = sessionStartChannel.subscribe(async payload => {
      pendingSessionStarts.push(payload);
      sessionStartWork = sessionStartWork.then(applySessionStarts).catch(error => { process.stderr.write(`${request.runId}: SessionStart channel failure: ${String(error)}\n`); });
      await sessionStartWork;
    });
    let deliveryPhase: DeliveryFrame['phase'] = 'before_submission';
    let deliveryRetried = false;
    const deliverInitialBrief = async (brief: string) => {
      let owned = await ownership();
      while (owned.state === 'unknown') {
        const observed = await adapter.inspect(adapterSession);
        if (observed.status === 'exited' || observed.status === 'failed' || observed.status === 'limited') fail('PROCESS_IDENTITY_UNAVAILABLE', `Runner ownership lost before durable start gate: ${owned.state}: ${owned.reason}; runner ${observed.status}`);
        await new Promise(resolve => setTimeout(resolve, settings.timeouts.pollMs));
        owned = await ownership();
      }
      if (owned.state !== 'owned') fail('PROCESS_IDENTITY_UNAVAILABLE', `Runner ownership lost before durable start gate: ${owned.state}: ${owned.reason}`);
      await gate(owned.identity);
      sessionStartWork = sessionStartWork.then(applySessionStarts);
      await sessionStartWork;
      const expectedIdentity = owned.identity;
      const verifyOwner = async () => {
        const current = await ownership();
        if (current.state !== 'owned' || !sameIdentity(current.identity, expectedIdentity) || !deferred && nativeId !== expectedIdentity.runnerSessionId) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Native runner identity changed during initial brief delivery');
      };
      const initial = await adapter.inspect(adapterSession);
      if (initial.status !== 'ready' || !deferred && initial.cliSessionId !== expectedIdentity.runnerSessionId) fail('RUNNER_DELIVERY_UNAVAILABLE', 'Runner is not on its known native input before initial brief delivery');
      const before = screen;
      const beforeLines = before.split('\n');
      const beforeNative = readNativeComposer(settings, before);
      const beforeComposer = beforeNative?.line ?? -1;
      const beforeInput = beforeNative?.input;
      if (beforeInput === undefined || beforeInput !== '' && !settings.markers.ready?.includes(beforeInput)) fail('RUNNER_DELIVERY_UNAVAILABLE', 'Unknown native input before initial brief submission');
      const beforeContext = beforeComposer < 0 ? undefined : nativeDeliveryContext(settings, beforeLines, beforeComposer);
      deliveryPhase = 'submitting';
      await adapter.deliver(adapterSession, brief);
      deliveryPhase = 'awaiting_acceptance';
      const deadline = Date.now() + settings.timeouts.transitionMs;
      let previousPending: string | undefined;
      let retried = false;
      while (Date.now() < deadline) {
        const observed = await adapter.inspect(adapterSession);
        await verifyOwner();
        if (observed.status === 'exited' || observed.status === 'failed' || observed.status === 'limited') fail('RUNNER_DELIVERY_UNAVAILABLE', `Initial brief delivery stopped on ${observed.status}`);
        const lines = screen.split('\n');
        const composer = readNativeComposer(settings, screen);
        const composerIndex = composer?.line ?? -1;
        const input = composer?.input;
        const matched = input === undefined ? 'none' : matchPendingBrief(settings, input, brief);
        const paste = input !== undefined && new RegExp(native.pendingPaste.pattern, 'u').test(input);
        const pending = matched === 'pending';
        const state = observeRunnerScreen(settings, { text: screen, version: availability.version, requestedCommand: identityCommand }).state;
        const emptyInput = input === '' || settings.markers.ready?.includes(input ?? '');
        const working = isNativeWorking(settings, screen) && !isNativeWorking(settings, before);
        const finished = isNativeFinished(settings, screen) && !isNativeFinished(settings, before);
        if (!paste && emptyInput && (working || finished)) {
          await verifyOwner();
          return;
        }
        const context = composerIndex < 0 ? undefined : nativeDeliveryContext(settings, lines, composerIndex);
        const sameContext = beforeContext !== undefined && context !== undefined && matchesNativeDeliveryContext(settings, beforeContext, context, brief);
        if (pending && (state === 'ready' || state === 'unknown_screen') && sameContext) {
          if (!retried && previousPending === input) {
            const pendingScreen = screen;
            await verifyOwner();
            const latest = await adapter.inspect(adapterSession);
            if ((latest.status === 'ready' || latest.status === 'starting') && screen === pendingScreen && (deferred || nativeId === expectedIdentity.runnerSessionId)) {
              deliveryRetried = true;
              await sendKeys(['Enter']);
              retried = true;
            }
          }
          previousPending = input;
        } else {
          previousPending = undefined;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(settings.timeouts.pollMs, Math.max(0, deadline - Date.now()))));
      }
      fail('RUNNER_DELIVERY_UNAVAILABLE', 'Native initial brief acceptance timed out');
    };
    transport.deliver = async brief => {
      const reportRequired = session.launchContext!.reportSchema?.required;
      if (Array.isArray(reportRequired) && reportRequired.includes('commits') && !session.launchContext!.reportedCommits) fail('INVALID_CONTEXT', 'Reported commit launch metadata is missing');
      if (!isDeepStrictEqual(request.reportedCommits, session.launchContext!.reportedCommits)) fail('INVALID_CONTEXT', 'Worker reported commit contract does not match durable launch context');
      try { await deliverInitialBrief(brief); }
      catch (error) {
        const deliveryFailure = failureContext(error);
        let configuration: unknown;
        try { configuration = await json(join(context.confRoot, 'flow.json')); } catch {}
        const evidence = await preserveFailedDeliveryEvidence({
          runId: request.runId, generation: createHash('sha256').update(fileURLToPath(new URL('../', import.meta.url))).digest('hex'),
          settings: { ...settings, version: availability.version }, firstFailureAt: now(), configuration,
          primaryReason: deliveryFailure?.reason ?? (error instanceof Error ? error.message : String(error)),
          retrySafe: deliveryFailure?.retrySafe ?? true, cleanupFailures: [],
          capture: screenCapturedAt ? {
            frame: { screen, brief, phase: deliveryPhase, retried: deliveryRetried }, capturedAt: screenCapturedAt,
            method: 'tmux capture-pane -p', limitations: ['Visible pane only; scrollback and earlier frames are not captured'],
          } : { unavailable: 'No adapter decision frame was captured' },
        }, privateDeliveryEvidencePorts(request.tmpRoot, async runId => {
          if (runId !== request.runId || !deliveryEvidenceIsolated) throw new Error('Runner private evidence isolation unavailable');
        }));
        const reason = `${evidence.reason}; deliveryEvidence=${JSON.stringify(evidence.evidence)}`;
        throw deliveryFailure ? commandFailure({ ...deliveryFailure, message: reason, reason }) : new Error(reason);
      }
    };
    const assignments = assignmentPorts(execute);
    let handedOff = false;
    const discardFailedLaunch = async () => {
      if (!await discardOwnedTmuxSession(execute, request.tmuxSession, settings.timeouts)) { process.stderr.write(`${request.runId}: own tmux session termination is not confirmed\n`); return; }
      const current = tools.current(request.runId);
      if (current?.state !== 'running' || !current.process) return;
      tools.state.commitObservation(request.runId, current.revision, { state: 'exited', observedAt: now(), exitCode: null, evidence: 'Failed launch discarded its own tmux session' }, effects);
      const exited = tools.current(request.runId)!;
      await tools.finalize(exited, exited.activity ? [{ kind: 'ended', session: exited, project: exited.activity.project }] : []);
    };
    const reportPorts: import('./launch-wrapper.ts').LaunchWrapperPorts['report'] = {
        confirmationRetry: { runner: request.selection.runner, protocol: async () => ({ timeouts: protocolFor(await protocols(context.confRoot, options.protocolSettings), request.selection.runner).timeouts }), inputs: reportConfirmationInputs(request) },
        fs: { mkdir: async path => { await fs.mkdir(path, { recursive: true, mode: 0o700 }); }, readBytes: readReportBytes, readText: async path => { try { return await fs.readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }, removeTree: async () => {} },
        watch: (directory, listener) => { const watcher = watch(directory, (event, filename) => { if (filename) void listener(event === 'rename' ? 'rename' : 'modify', filename.toString()).catch(error => process.emitWarning(error)); }); watcher.on('error', error => process.stderr.write(`${request.runId}: Report watcher error: ${String(error)}\n`)); return () => watcher.close(); },
        now,
        verifyAssignmentCompletion: (assignment, archives) => verifyAssignmentCompletion(assignment, assignments, archives),
        confirmTaskCheckboxes: (reportRequest, report, confirmationBudget, beforeWrite) => confirmReportedTasks(store, context, execute, reportRequest, report, settings.timeouts, options.execute, confirmationBudget, beforeWrite),
        diagnostic: (reason, snapshot) => tools.reportDiagnostic(request.runId, reason, snapshot),
      ...reportedCommitPorts(store, context, execute, session!, options.execute),
    };
    const launched = runLaunchWrapper(request, {
      transport,
      report: reportPorts,
      lifecycle: {
        started: async handshake => {
          await gate(handshake.identity);
          sessionStartWork = sessionStartWork.then(applySessionStarts);
          await sessionStartWork;
          const queued = tools.current(request.runId)?.launchContext?.agentQueue;
          if (queued) {
            const queueState = createAgentQueueState(store);
            await retryStateOperation(() => queueState.transaction(tx => {
              if (!queueState.confirmReady(tx, queued)) fail('LAUNCH_FENCE_LOST', 'Queue launch readiness fence changed');
            }), settings.timeouts);
          }
          await tools.control.started(request.runId);
          if (queued?.eventHandle) await settleCommandState({ store, now: Date.now, nextReminderId: randomUUID,
            catalog: loadEventCatalog(context.orchestratorRoot, manifest.configuration.catalog),
            deliver: message => tools.control.message(message, rafSystemCaller),
          });
        },
        acceptReport: async result => {
          if (result.report && session!.launchContext?.reportedCommits) {
            try { await verifyPendingAgentReportFreshness(request, result, reportPorts); }
            catch (error) { if (error instanceof ConfirmationTransientError) throw error; fail('REPORT_UNVERIFIED', error instanceof Error ? error.message : String(error)); }
          }
          let checkboxCommits = result.checkboxCommits;
          if (result.report?.status === 'succeeded' && !session!.launchContext?.reportedCommits && !reportPorts.confirmationRetry) {
            const verification = await confirmReportedTasks(store, context, execute, request, result.report, settings.timeouts, options.execute);
            if (!verification.ok) fail('REPORT_UNVERIFIED', `OpenSpec completion changed before result acceptance: ${JSON.stringify(verification.issues)}`);
            checkboxCommits = verification.commits;
          }
          const value: WorkResult = { status: result.status, response: result.report?.answer ?? `${NO_REPORT_REASON}: ${JSON.stringify(result.exit)}`, proof: { runId: request.runId, at: result.at, context: result.report?.context, ...(session!.launchContext?.reportedCommits ? { commits: result.report?.commits } : {}), checkboxCommits } };
          tools.verified.set(value, request.runId);
          const accepted = tools.state.acceptWorkResult(request.runId, value, { pending: [{ id: `${request.runId}:${result.event}`, runId: request.runId, event: result.event, payload: { kind: result.event, id: request.address } }], domain: [], reportAccepted: !!result.report });
          if (!accepted && !tools.current(request.runId)?.result) fail('REPORT_UNVERIFIED', 'Result could not be durably accepted for the running session');
          try {
            await tools.deliverResults();
            if (result.report && lease) {
              const succeeded = new Set(result.report.changes.flatMap(change => change.items.filter(item => item.status === 'succeeded').map(item => JSON.stringify([change.id, item.id]))));
              const subset = { ...request.assignment, changes: request.assignment.changes.map(change => ({ ...change, items: change.items.filter(item => succeeded.has(JSON.stringify([change.id, item.id]))) })).filter(change => change.items.length) };
              if (subset.changes.length && (await verifyAssignmentCompletion(subset, assignments, Object.fromEntries(result.report.changes.filter(change => change.archive).map(change => [change.id, change.archive!])))).ok) {
                const set = listTaskReservations(store).find(set => set.lease.owner.runId === request.runId);
                if (set && set.lease.owner.fence === lease.owner.fence) {
                  const tasks = set.tasks.filter(task => succeeded.has(JSON.stringify([task.key.changeId, task.key.taskId])));
                  if (tasks.length) { const completed = await completeTaskReservations(dependencies, { lease: set.lease, tasks }); if (completed.applied) lease = completed.lease; }
                }
              }
            }
          } catch (error) { process.stderr.write(`${request.runId}: accepted report follow-up: ${String(error)}\n`); }
        },
        finish: async (handshake, exit) => {
          let current = tools.current(request.runId)!;
          tools.state.commitObservation(request.runId, current.revision, { state: 'exited', observedAt: now(), exitCode: exit.code, evidence: `Owned tmux runner exit ${exit.signal ?? exit.code}`, finishReason: exit.signal ? 'signal' : 'exit' }, effects);
          current = tools.current(request.runId)!;
          await tools.finalize(current, current.activity ? [{ kind: 'ended', session: current, project: current.activity.project }] : []);
          if ((await adapter.inspect(adapterSession)).status === 'exited') await adapter.stop(adapterSession);
        },
        failed: async (_runId, reason, recoverable) => {
          await retryStateOperation(() => recordLaunchFailure(store, request.runId, reason), settings.timeouts);
          store.sessionRepository.transaction(tx => {
            const row = tx.getSession(request.runId);
            if (row?.launchContext?.modelRouting) tx.putSession({ ...row, revision: row.revision + 1, launchContext: { ...row.launchContext, modelRouting: { ...row.launchContext.modelRouting, cause: { status: 'failed', reason } } } });
          });
          if (recoverable) { process.stderr.write(`${request.runId}: recoverable launch: ${reason}\n`); return; }
          const current = tools.current(request.runId);
          if (current?.state === 'running' && current.process) {
            if (!await processExited(execute, current.process, settings.timeouts)) fail('LAUNCH_RECOVERABLE', `${request.runId}: runner process exit is not confirmed within ${settings.timeouts.transitionMs} ms after its own tmux session stopped; task reservations stay until reconciliation`);
            await retryStateOperation(() => tools.state.commitObservation(request.runId, current.revision, { state: 'exited', observedAt: now(), exitCode: null, evidence: reason }, effects), settings.timeouts);
            const exited = tools.current(request.runId)!;
            await tools.finalize(exited, exited.activity ? [{ kind: 'ended', session: exited, project: exited.activity.project }] : []);
          }
          if (current?.state === 'reserved' && lease) await releaseTaskReservations(dependencies, { lease, reason: 'cancelled', closeLaunch: tx => closeSessionInTransaction(tx, tx.getSession(request.runId)!, now()) });
          const queued = tools.current(request.runId)?.launchContext?.agentQueue;
          if (queued && tools.current(request.runId)?.state === 'finished') {
            const queueState = createAgentQueueState(store);
            await retryStateOperation(() => queueState.transaction(() => queueState.remove(queued, 'launch-failed')), settings.timeouts);
            await settleCommandState({ store, now: Date.now, nextReminderId: randomUUID,
              catalog: loadEventCatalog(context.orchestratorRoot, manifest.configuration.catalog),
              deliver: message => tools.control.message(message, rafSystemCaller),
            });
          }
        },
      },
      handshake: async handshake => { await channel.handshake({ ...handshake, warnings: availability.warnings }); handedOff = true; },
    });
    try { await launched; await settleModelHandoffs(store, context, manifest.configuration, options); }
    catch (error) {
      if (!handedOff) await discardFailedLaunch().catch(cleanup => process.stderr.write(`${request.runId}: failed launch cleanup: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}\n`));
      throw error;
    }
  } catch (error) { workerFailure = error; throw error; }
  finally { try { await stopHealthSummary?.(); unsubscribeSessionStart?.(); await sessionStartWork; await sessionStartChannel?.close(); } finally { try { await hotfixCommitPort?.close(); await codexAccess?.cleanup(); } finally { try { await codexSandbox?.cleanup(); if (toolTmuxDirectory) await toolTmuxDirectory.cleanup(async socket => {
        await executeCommand({ executable: 'tmux', args: ['-S', socket, 'kill-server'], environment: stateContextEnvironment(stateContext, process.env) });
        await new Promise<void>((resolve, reject) => {
          const connection = createConnection(socket);
          const timer = setTimeout(() => { connection.destroy(); reject(new Error('Own tool tmux stop confirmation timed out')); }, settings.timeouts.transitionMs);
          connection.once('connect', () => { clearTimeout(timer); connection.destroy(); reject(new Error('Own tool tmux server is still live')); });
          connection.once('error', error => { clearTimeout(timer); connection.destroy(); if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(); else reject(error); });
        });
      }); } finally { try { costProfile?.stage('completion'); costProfile?.finish(); await settleRuntimeHealthCpu(store, context.orchestratorRoot); } catch (error) { if (workerFailure === undefined) throw error; process.emitWarning(error instanceof Error ? error : String(error)); } finally { store.close(); await generationLease?.release(); } } } } }
}
