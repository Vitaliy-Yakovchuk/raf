import { runtimeHealthSummary } from './health-summary-runtime.ts';
import { settleRuntimeHealthCpu } from './health-cpu-runtime.ts';
import { measureRafCost } from './raf-cost-runtime.ts';
import { commandTimingFailure, recordCommandTiming, validateCommandTiming } from './command-timing.ts';
import { runAgentWithQueue, type AgentQueueRecord, type AgentQueueValidation, type AgentQueueRequest, type AgentRunQueuePorts } from './agent-run-queue.ts';
import { isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { commandFailure, failureContext, type CommandFailureContext } from './cli-contract.ts';
import type { Handler } from './cli.ts';
import type { CompiledCatalog } from './catalog.ts';
import type { StateStore } from './state-store.ts';
import type { SessionActivity, SessionRecord, ProcessIdentity } from './session-state.ts';
import type { AssignmentSnapshot, AssignmentRequest, AssignmentValidation, AssignmentBriefContext } from './assignment.ts';
import type { WorkspaceRouteRequest, WorkspaceRouteResult } from './workspace-routing.ts';
import type { ModelHandoffLaunch } from './model-routing-handoff.ts';
import type { ModelCatalog, ModelRequest, ModelSelection, ModelAvailability, RoutingSnapshot } from './model-routing.ts';
import type { AdapterStartRequest, AdapterSession, ReportWrapper } from './agent-adapters.ts';
import type { DeliveryReceipt, CloseResult, MainAttachment } from './agent-control.ts';
import type { AdmissionSnapshot } from './admission-snapshot.ts';
import type { ResourceReservation } from './resource-admission.ts';
import { validateQuotaRunners, type CollectionResult } from './quota-collection.ts';
import type { RunnerId } from './runner-protocols.ts';
import { bindWorkspaceBoundaries, rafCommandFor, resolveGitWriteBoundaries, rafSubcommandsFor, type DerivedTaskContext, type KnownTaskResourceEstimate } from './task-context.ts';
import { createReminderHandlers, settleCommandState, type CommandStatePorts, type ReminderCommand } from './reminder-cli.ts';
import type { HotfixWorkspace } from './hotfix-worktree.ts';
import type { NotifyTarget } from './launcher-notice.ts';

export interface RuntimeContext {
  stateContext?: import('./state-migration-guard.ts').StateContext;
  orchestratorRoot: string;
  confRoot: string;
  artifactPath: string;
  statePath: string;
  tmpRoot: string;
  mode: 'production' | 'test';
  commandStartedAtMs: number;
  commandTimingOwner?: 'production';
  resolveCaller(): Promise<unknown>;
}

export interface RuntimeConfiguration {
  catalog: CompiledCatalog;
  models: ModelCatalog;
  commandTiming: { emaAlpha: number; sqliteOnlyMeanBudgetMs?: number };
}

export interface RuntimeRunParameters {
  id: string;
  type: string;
  project: string;
  features: string[];
  phase: string;
  complexity: string;
  tasks: string[];
  notify?: string;
}

export type RuntimeTaskContext = Pick<DerivedTaskContext, 'branch' | 'outcome' | 'writeBoundaries' | 'sources'> & Partial<Pick<DerivedTaskContext, 'workspaceWritable'>> & {
  readonly hotfix?: HotfixWorkspace;
  readonly reportSchema: DerivedTaskContext['reportSchema'];
  readonly requested: ResourceReservation;
  readonly requiredFileSystemIds: readonly string[];
  readonly estimate?: KnownTaskResourceEstimate;
};

export interface RuntimeLaunch {
  runId: string;
  addressId: string;
  tmuxSession: string;
  activity: SessionActivity;
  assignment: AssignmentSnapshot;
  selection: Extract<ModelSelection, { status: 'selected' }>;
  statePath: string;
  tmpRoot: string;
  writeBoundaries?: readonly string[];
  commitRepositories?: readonly string[];
  notify?: NotifyTarget;
  taskContext?: { parameters: RuntimeRunParameters; context: RuntimeTaskContext };
  handoff?: ModelHandoffLaunch;
}

export interface PreparedRuntimeReport {
  warnings?: readonly string[];
  reportedCommits?: import('./reported-commits-contract.ts').ReportedCommitLaunchContext;
  reportPath: string;
  reportWrapper: ReportWrapper;
  cleanupUnstarted(): Promise<void>;
}

export type RuntimeReservationInput = RuntimeLaunch & { reportPath: string; requested: ResourceReservation; requiredFileSystemIds: string[];
  queueClaim?: { record: AgentQueueRecord; validation: AgentQueueValidation; rechecking: boolean } };

export interface RuntimeServices {
  agentQueue?(input: RuntimeReservationInput): Promise<{ request: AgentQueueRequest; ports: Omit<AgentRunQueuePorts, 'start' | 'verifyReady'> }>;

  resolveNotify?(address: string): Promise<NotifyTarget>;
  assignment: {
    validate(request: AssignmentRequest): Promise<AssignmentValidation>;
    compose(snapshot: AssignmentSnapshot, context: AssignmentBriefContext): Promise<string>;
  };
  resolveTask(params: RuntimeRunParameters, assignment: AssignmentSnapshot): Promise<RuntimeTaskContext>;
  route(request: WorkspaceRouteRequest): Promise<WorkspaceRouteResult>;
  routingSnapshot(): Promise<RoutingSnapshot>;
  selectModel(catalog: ModelCatalog, snapshot: RoutingSnapshot, request: ModelRequest): ModelSelection;
  listModels(catalog: ModelCatalog, snapshot: RoutingSnapshot): ModelAvailability[];
  prepareReport(launch: RuntimeLaunch): Promise<PreparedRuntimeReport>;
  reserve(input: RuntimeReservationInput): Promise<{ admitted: true; admission?: AdmissionSnapshot | null } | { admitted: false; reason: string; admission?: AdmissionSnapshot | null; waiting?: boolean }>;
  adapter: { start(request: AdapterStartRequest): Promise<AdapterSession> };
  verifyStarted(launch: RuntimeLaunch, session: AdapterSession): Promise<ProcessIdentity>;
  commitStarted(runId: string, identity: ProcessIdentity): Promise<boolean>;
  compensate(launch: RuntimeLaunch, error: unknown): Promise<{ stopped: true } | { stopped: false; reason: string }>;
  abortLaunch(runId: string, reason: string): Promise<void>;
  control: {
    ps(): Promise<SessionRecord[]>;
    update(id: string, patch: Partial<Pick<SessionActivity, 'project' | 'features' | 'phase'>>, caller: unknown): Promise<SessionRecord>;
    message(input: { to: string; text: string }, caller: unknown): Promise<DeliveryReceipt>;
    close(id: string, caller: unknown, options?: { force?: boolean; reason?: string }): Promise<CloseResult>;
    interrupt(id: string, caller: unknown): Promise<void>;
    attachMain(): Promise<MainAttachment>;
  };
  collectQuotas?(runners: string[]): Promise<CollectionResult>;
}

export interface AppRuntimeDependencies {
  resolveGitWriteBoundaries?: typeof resolveGitWriteBoundaries;
  loadConfiguration(context: RuntimeContext): Promise<RuntimeConfiguration>;
  openStore(path: string): Promise<StateStore>;
  createServices(store: StateStore, config: RuntimeConfiguration, context: RuntimeContext): Promise<RuntimeServices>;
  nextRunIdentity(): { runId: string; tmuxSession: string };
  now(): number;
  additionalHandlers?: Record<string, Handler>;
  commandState?(store: StateStore, services: () => Promise<RuntimeServices>): CommandStatePorts;
}

const reminderCommands: readonly ReminderCommand[] = ['reminder add', 'reminder list', 'reminder update', 'reminder activate', 'reminder close', 'reminder reassign', 'reminder close-all'];

export interface AppRuntime {
  handlers: Record<string, Handler>;
  close(): Promise<void>;
  launchHandoff(parameters: RuntimeRunParameters, handoff: ModelHandoffLaunch): Promise<unknown>;
}

export function runnerLimitsHandler(available: readonly string[], collect: (runners: string[]) => Promise<CollectionResult>): Handler {
  const fail = (code: string, stage: string, reason: string, facts: Partial<CommandFailureContext> = {}) => commandFailure({
    code, message: reason, stage, source: 'app-runtime', sourceCode: null, reason,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true,
    remediation: ['Виправте причину та повторіть команду.'], ...facts,
  });
  return async params => {
    const requested = Array.isArray(params.runners) ? params.runners.map(String) : params.runners === undefined ? [] : [String(params.runners)];
    let runners: string[];
    try { runners = validateQuotaRunners(requested, available as RunnerId[]); }
    catch (error) { throw fail('INVALID_VALUE', 'runners', error instanceof Error ? error.message : String(error), { received: requested, expected: [...available], remediation: [`Передайте непорожній --runners із значень: ${available.join(', ')}.`] }); }
    const collected = await collect(runners);
    const results = collected.results.map(({ runner, collected: fresh, view }) => {
      const snapshot = view.snapshot;
      const measured = snapshot ? { observedAt: snapshot.observedAt, ageMs: view.ageMs, pools: snapshot.pools, credits: snapshot.credits, issues: snapshot.issues } : null;
      return fresh
        ? { runner, collected: true, reason: view.reason, ...measured }
        : { runner, collected: false, reason: view.reason, error: view.error, previous: measured };
    });
    if (collected.exitCode !== 0) {
      const failed = results.filter(result => !result.collected);
      throw fail('QUOTA_COLLECTION_FAILED', 'quota', `Quota collection failed for ${failed.map(result => result.runner).join(', ')}`, {
        found: results, completed: results.filter(result => result.collected).map(result => result.runner), pending: failed.map(result => result.runner),
        remediation: [...new Set(failed.map(result => (result as { error?: { remedy?: string } | null }).error?.remedy).filter((value): value is string => !!value))],
      });
    }
    return results;
  };
}

export function createAppRuntime(context: RuntimeContext, dependencies: AppRuntimeDependencies): AppRuntime {
  let configuration: Promise<RuntimeConfiguration> | undefined;
  let opening: Promise<StateStore> | undefined;
  let services: Promise<RuntimeServices> | undefined;
  let closed = false;
  const fail = (code: string, stage: string, reason: string, facts: Partial<CommandFailureContext> = {}) => commandFailure({
    code, message: reason, stage, source: 'app-runtime', sourceCode: null, reason,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true, admission: null,
    remediation: ['Виправте причину та повторіть команду.'], ...facts,
  });
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  const config = () => configuration ??= (async () => {
    if (closed) throw fail('RUNTIME_CLOSED', 'context', 'Runtime closed');
    for (const name of ['orchestratorRoot', 'confRoot', 'artifactPath', 'statePath', 'tmpRoot'] as const) {
      if (!isAbsolute(context[name])) throw fail('INVALID_CONTEXT', 'context', `Absolute ${name} required`);
    }
    const loaded = await dependencies.loadConfiguration(context);
    validateCommandTiming(loaded.commandTiming);
    return loaded;
  })();
  const store = () => opening ??= (async () => {
    const loaded = await config();
    const state = await dependencies.openStore(context.statePath);
    try { state.initializeRunners(loaded.models.runners); }
    catch (error) { state.close(); throw error; }
    return state;
  })();
  const service = () => services ??= (async () => dependencies.createServices(await store(), await config(), context))();
  let commandPorts: Promise<CommandStatePorts> | undefined;
  const statePorts = () => commandPorts ??= (async () => dependencies.commandState!(await store(), service))();
  const settle = async () => {
    if (!dependencies.commandState || !opening) return;
    try {
      await opening;
      await settleCommandState(await statePorts());
    } catch {}
  };
  const snapshot = async () => {
    const current = await (await service()).routingSnapshot();
    const state = await store();
    return { ...current, runnerEnabled: { ...current.runnerEnabled, ...Object.fromEntries((await config()).models.runners.map(runner => [runner.id, state.getRunnerEnabled(runner.id) ?? runner.initialEnabled])) } };
  };
  const launchAgent = async (raw: Record<string, unknown>, handoff?: ModelHandoffLaunch) => {
      const params = raw as unknown as RuntimeRunParameters;
      const loaded = await config();
      const command = loaded.catalog.commands.find(command => command.handlerName === 'agent run');
      const type = command?.parameters.find(parameter => parameter.name === 'type')?.values?.find(value => value.id === params.type);
      if (params.id === 'main') throw fail('MAIN_NOT_LAUNCHABLE', 'preflight', 'Address main belongs to the attached main session and cannot be launched', { received: params.id,
        remediation: ['Зареєструйте наявну сесію командою raf main attach з її tmux-панелі або оберіть інший --id.'] });
      if (params.type === 'main' || type?.launchableByRaf === false) throw fail('TYPE_NOT_LAUNCHABLE', 'preflight', 'Agent type cannot be launched', { received: params.type });
      const selections = new Map<string, { id: string }[]>();
      if (!Array.isArray(params.tasks) || !params.tasks.length) throw fail('INVALID_ASSIGNMENT', 'assignment', 'Nonempty tasks required');
      for (const task of params.tasks) {
        if (typeof task !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*:[^:\s]+$/.test(task)) throw fail('INVALID_ASSIGNMENT', 'assignment', 'Expected change:item; pass several items by repeating the option: --tasks a:1 --tasks a:2', { received: task, expected: '--tasks a:1 --tasks a:2' });
        const [change, id] = task.split(':');
        const items = selections.get(change) ?? [];
        items.push({ id });
        selections.set(change, items);
      }
      const api = await service();
      const notify = params.notify === undefined ? undefined : await (async () => {
        if (!api.resolveNotify) throw fail('NOTIFY_TARGET_INVALID', 'preflight', 'Notify target validation is unavailable');
        return api.resolveNotify(params.notify!);
      })();
      const validation = await api.assignment.validate({ root: context.orchestratorRoot, selections: [...selections].map(([change, items]) => ({ change, items: items.map(item => {
        const expected = handoff?.assignment.changes.find(row => row.id === change)?.items.find(row => row.id === item.id);
        return expected ? { ...item, expectedDescription: expected.description } : item;
      }) })) });
      if (handoff && (params.tasks.length !== handoff.assignment.changes.reduce((count, change) => count + change.items.length, 0) || params.tasks.some(task => {
        const [change, item] = task.split(':');
        return !handoff.assignment.changes.some(row => row.id === change && row.items.some(row => row.id === item));
      }))) throw fail('INVALID_ASSIGNMENT', 'assignment', 'Handoff must contain exactly the current unfinished assignment');
      if (!validation.ok) throw fail('INVALID_ASSIGNMENT', 'assignment', `${validation.kind}: ${validation.issues.map(issue => `${issue.change}: ${issue.reason}`).join('; ')}`, { received: params.tasks, found: validation.issues });
      const assignment = validation.snapshot;
      const task = await api.resolveTask(params, assignment);
      const identity = dependencies.nextRunIdentity();
      const hotfix = params.type === 'hotfix' && params.project === 'raf';
      const route = await api.route({ root: context.orchestratorRoot, project: params.project, branch: task.branch, ...(hotfix ? { hotfixRunId: identity.runId } : {}) });
      if (!route.ok) throw fail(route.error.code, 'workspace', route.error.message);
      const codeWorkspaces = [route.cwd, ...(task.workspaceWritable && route.sharedLibrariesPath ? [await realpath(route.sharedLibrariesPath)] : [])];
      const workspaceBoundaries = [...new Set([...bindWorkspaceBoundaries(task, route.cwd), ...codeWorkspaces.slice(1)])];
      const gitBoundaries = hotfix ? [] : [...new Set((await Promise.all(codeWorkspaces.map(cwd =>
        (dependencies.resolveGitWriteBoundaries ?? resolveGitWriteBoundaries)(cwd, context.orchestratorRoot, !task.workspaceWritable ? task.writeBoundaries : undefined)
      ))).flat())];
      const commitOwnWork = task.workspaceWritable || gitBoundaries.length > 0;
      const writeBoundaries = [...workspaceBoundaries, ...gitBoundaries.filter(path => !workspaceBoundaries.includes(path))];
      const policy = handoff ? { ...loaded.models, models: loaded.models.models.filter(model => model.id !== handoff.causeModel) } : loaded.models;
      const selection = api.selectModel(policy, await snapshot(), { complexity: params.complexity, role: params.type, ...(handoff ? { previousModel: handoff.causeModel } : {}) });
      if (handoff && selection.status === 'selected' && (selection.runner !== handoff.selection.runner || selection.model !== handoff.selection.model || selection.effort !== handoff.selection.effort)) throw fail('RUNNER_UNAVAILABLE', 'selection', 'Routing changed before handoff launch');
      if (selection.status === 'waiting') throw fail(selection.code, 'selection', selection.reason);
      const launch: RuntimeLaunch = { ...identity, addressId: params.id,
        ...(notify ? { notify } : {}),
        activity: { type: params.type, project: params.project, features: [...params.features], phase: params.phase, cwd: route.cwd },
        assignment, selection, ...(handoff ? { handoff } : {}), statePath: context.statePath, tmpRoot: context.tmpRoot, writeBoundaries: [...writeBoundaries], commitRepositories: [...new Set(task.workspaceWritable ? [...codeWorkspaces, context.orchestratorRoot] : gitBoundaries.length ? [context.orchestratorRoot] : [])], taskContext: { parameters: params, context: { ...task, ...(route.hotfix ? { hotfix: route.hotfix, writeBoundaries: [...writeBoundaries] } : {}) } } };
      let prepared: PreparedRuntimeReport | undefined;
      let reserved = false;
      let startAttempted = false;
      let stage = 'report';
      let admissionSnapshot: AdmissionSnapshot | null = null;
      let queueOwnsCleanup = false;
      try {
        prepared = await api.prepareReport(launch);
        stage = 'brief';
        let brief = await api.assignment.compose(assignment, { briefsRoot: join(context.confRoot, 'briefs'), runner: selection.runner,
          cwd: route.cwd, stage: params.phase, project: params.project, agentId: params.id, sessionName: launch.tmuxSession,
          features: params.features, phase: params.phase, outcome: task.outcome, writeBoundaries,
          sources: task.sources, reportPath: prepared.reportPath, reportSchema: task.reportSchema,
          commitRepositories: prepared.reportedCommits?.repositories.map(row => row.repositoryRoot) ?? launch.commitRepositories,
          ...(commitOwnWork && !hotfix ? { commitOwnWork: true, commitPaths: workspaceBoundaries, workspaceWritable: task.workspaceWritable } : {}),
          rafCommand: rafCommandFor(), ...(rafSubcommandsFor(params.type) ? { rafSubcommands: rafSubcommandsFor(params.type)! } : {}) });
        if (hotfix) brief += `\nHotfix raf: постійне спільне дерево ${route.cwd}, гілка hotfix, спільний індекс і HEAD; main включений до baseCommit ${route.hotfix?.baseCommit}. Кожен виконавець комітить лише власні явні шляхи; спільні файли та staged hunks узгоджуй через agent message за projects/orchestrator/parallel-development. Чужий index.lock очікуй, не видаляй. Коміт не активує main; push і активацію виконує лише main за окремими повноваженнями. Код hotfix запускай лише з ізольованим QA HOME. Коміт коду виконай довіреним портом: node ${join(context.tmpRoot, launch.runId, 'hotfix-commit.mjs')} --message <повідомлення> <власні відносні шляхи>. Cleanup прибирає лише власний запуск, спільне raf-hotfix зберігається.\n`;
        if (handoff) brief += `\nПопередній runId: ${handoff.predecessorRunId}. Це новий запуск незавершених пунктів без resume. Причина: ${JSON.stringify(handoff.cause)}\nДокази попередньої спроби:\n${handoff.evidence.join('\n')}\n`;
        stage = 'reservation';
        if (api.agentQueue) {
          queueOwnsCleanup = true;
          const queued = await api.agentQueue({ ...launch, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
          let session: AdapterSession | undefined;
          let processIdentity: ProcessIdentity | undefined;
          const controller = new AbortController();
          const abort = () => controller.abort();
          process.once('SIGINT', abort);
          process.once('SIGTERM', abort);
          try {
            const result = await runAgentWithQueue({ ...queued.request, signal: controller.signal }, { ...queued.ports,
              start: async () => {
                stage = 'start';
                startAttempted = true;
                session = await api.adapter.start({ selection: { runner: selection.runner as AdapterStartRequest['selection']['runner'], model: selection.model, effort: selection.effort }, tmuxSession: launch.tmuxSession, cwd: route.cwd, brief, reportWrapper: prepared!.reportWrapper });
                processIdentity = await api.verifyStarted(launch, session);
                return { pid: processIdentity.pid, startedAt: processIdentity.startedAt, machineId: processIdentity.evidence.machineId,
                  bootId: processIdentity.evidence.bootId, runnerSessionId: processIdentity.runnerSessionId, runner: processIdentity.runner, ...(processIdentity.nativeIdentity ? { nativeIdentity: processIdentity.nativeIdentity } : {}) };
              },
              verifyReady: async () => {
                stage = 'identity';
                processIdentity = await api.verifyStarted(launch, session!);
                return { pid: processIdentity.pid, startedAt: processIdentity.startedAt,
                  machineId: processIdentity.evidence.machineId, bootId: processIdentity.evidence.bootId, runnerSessionId: processIdentity.runnerSessionId, runner: processIdentity.runner, ...(processIdentity.nativeIdentity ? { nativeIdentity: processIdentity.nativeIdentity } : {}) };
              },
            });
            const value = JSON.parse(result.exitCode === 0 ? result.stdout : result.stderr);
            admissionSnapshot = value.admission ?? value.details?.admission ?? null;
            if (result.exitCode !== 0) {
              const details = value.details;
              throw fail(value.code, details.stage, value.message, { ...details, remediation: value.remediation });
            }
            reserved = true;
            return { runId: launch.runId, addressId: launch.addressId, tmuxSession: launch.tmuxSession,
              cwd: route.cwd, admission: admissionSnapshot, queue: value.queue, ...selection, status: 'running', selection,
              process: processIdentity, reportPath: prepared.reportPath, warnings: [...new Set([...(session?.warnings ?? []), ...(prepared.warnings ?? [])])] };
          } finally {
            process.off('SIGINT', abort);
            process.off('SIGTERM', abort);
          }
        }
        const admission = await api.reserve({ ...launch, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
        admissionSnapshot = admission.admission ?? null;
        if (!admission.admitted) throw fail('RESOURCE_UNAVAILABLE', stage, admission.reason, { admission: admissionSnapshot });
        reserved = true;
        stage = 'start';
        startAttempted = true;
        const session = await api.adapter.start({ selection: { runner: selection.runner as AdapterStartRequest['selection']['runner'], model: selection.model, effort: selection.effort }, tmuxSession: launch.tmuxSession, cwd: route.cwd, brief, reportWrapper: prepared.reportWrapper });
        stage = 'identity';
        const identity = await api.verifyStarted(launch, session);
        stage = 'commit';
        if (!await api.commitStarted(launch.runId, identity)) throw fail('START_COMMIT_CONFLICT', stage, 'Started process could not be committed');
        return { runId: launch.runId, addressId: launch.addressId, tmuxSession: launch.tmuxSession,
          cwd: route.cwd, admission: admissionSnapshot, ...selection, status: 'running', selection, process: identity, reportPath: prepared.reportPath, warnings: [...new Set([...(session.warnings ?? []), ...(prepared.warnings ?? [])])] };
      } catch (error) {
        let safe = !startAttempted;
        const pending: string[] = [];
        if (startAttempted && !queueOwnsCleanup) {
          try { const result = await api.compensate(launch, error); safe = result.stopped; if (!safe) pending.push('process termination'); }
          catch { safe = false; pending.push('process termination'); }
        }
        if (safe && reserved && !queueOwnsCleanup) {
          try { await api.abortLaunch(launch.runId, describe(error)); }
          catch { safe = false; pending.push('abortLaunch'); }
        }
        if (safe && prepared && !queueOwnsCleanup) {
          try { await prepared.cleanupUnstarted(); }
          catch { pending.push('report cleanup'); safe = false; }
        }
        const supplied = failureContext(error);
        if (queueOwnsCleanup && prepared && (!startAttempted && !supplied?.cleanup || supplied?.cleanup?.state === 'released')) {
          try { await prepared.cleanupUnstarted(); } catch { pending.push('report cleanup'); }
        }
        throw fail(supplied?.code ?? 'LAUNCH_FAILED', stage, supplied?.reason ?? describe(error), {
          ...supplied, message: `${supplied?.message ?? describe(error)} (runId: ${launch.runId})`, received: { runId: launch.runId, ...(supplied?.received ? { input: supplied.received } : {}) },
          completed: queueOwnsCleanup ? supplied?.completed ?? [] : reserved ? ['reservation'] : [], pending: queueOwnsCleanup ? [...new Set([...(supplied?.pending ?? []), ...pending])] : pending, retrySafe: queueOwnsCleanup ? supplied?.retrySafe ?? false : safe, admission: admissionSnapshot,
        });
      }
  };
  const builtins: Record<string, Handler> = {
    'agent run': raw => launchAgent(raw),
    'agent ps': async () => measureRafCost('reconciliation', async () => (await service()).control.ps()),
    'agent update': async params => {
      const patch: Partial<Pick<SessionActivity, 'project' | 'features' | 'phase'>> = {};
      for (const key of ['project', 'features', 'phase'] as const) {
        if (params[key] !== undefined) {
          if (key === 'features') {
            if (!Array.isArray(params.features) || !params.features.length) throw fail('INVALID_VALUE', 'activity', 'Nonempty features required');
            patch.features = [...params.features] as string[];
          } else patch[key] = params[key] as string;
        }
      }
      return (await service()).control.update(params.id as string, patch, await context.resolveCaller());
    },
    'agent message': async params => {
      const receipt = await (await service()).control.message({ to: params.to as string, text: params.text as string }, await context.resolveCaller());
      if (!receipt.accepted) throw fail('MESSAGE_NOT_ACCEPTED', 'message', receipt.reason);
      return receipt;
    },
    'agent close': async params => {
      const result = await (await service()).control.close(params.id as string, await context.resolveCaller(), { force: params.force as boolean | undefined, reason: params.reason as string | undefined });
      if (!result.closed) throw fail('SESSION_CLOSE_BLOCKED', 'close', 'Session has unfinished reminders', { found: result.unfinished });
      return result;
    },
    'agent interrupt': async params => {
      await (await service()).control.interrupt(params.id as string, await context.resolveCaller());
      return { interrupted: true, id: params.id };
    },
    'main attach': async () => (await service()).control.attachMain(),
    'runner list': async () => (await service()).listModels((await config()).models, await snapshot()),
    'command stats': async () => {
      const loaded = await config();
      const state = await store();
      const budget = loaded.commandTiming.sqliteOnlyMeanBudgetMs;
      await settleRuntimeHealthCpu(state, context.orchestratorRoot);
      const summary = runtimeHealthSummary(state, context.orchestratorRoot);
      await summary.settle();
      const health = await summary.read();
      return { commands: loaded.catalog.commands.filter(command => command.handlerName !== 'help').map(command => ({ command: command.path.join(' '), budgetMs: command.handlerName === 'command stats' || command.metadata.sqliteOnly === true ? budget : null, ...(state.getCommandTiming(command.path.join(' ')) ?? { averageMs: null, updatedAt: null }) })), profile: state.readCostProfile(), health };
    },
  };
  if (dependencies.commandState) for (const name of reminderCommands) builtins[name] = async params => createReminderHandlers(await statePorts())[name](params);
  for (const [name, enabled] of [['runner enable', true], ['runner disable', false]] as const) builtins[name] = async params => {
    const loaded = await config();
    if (!loaded.models.runners.some(runner => runner.id === params.runner)) throw fail('INVALID_VALUE', 'runner', 'Unknown runner', { received: params.runner });
    (await store()).setRunnerEnabled(params.runner as string, enabled);
    return { runner: params.runner, enabled };
  };
  for (const [name, handler] of Object.entries(dependencies.additionalHandlers ?? {})) {
    if (name === 'help' || Object.hasOwn(builtins, name)) throw fail('HANDLER_CONFLICT', 'dispatch', `Handler already owned: ${name}`);
    if (typeof handler !== 'function') throw fail('INVALID_HANDLER', 'dispatch', `Handler must be a function: ${name}`);
    Object.defineProperty(builtins, name, { value: handler, enumerable: true });
  }
  const handlers: Record<string, Handler> = Object.create(null);
  for (const [name, handler] of Object.entries(builtins)) handlers[name] = async params => {
    let original: unknown;
    try {
      const loaded = await config();
      if (!loaded.catalog.commands.some(command => command.handlerName === name)) throw fail('COMMAND_UNAVAILABLE', 'dispatch', 'Command absent from approved catalog');
      await store();
      return await handler(params);
    } catch (error) {
      original = error;
      if (name === 'agent close' && (params.force === true || params.reason !== undefined) && opening) {
        try { (await opening).recordForcedCloseRefusal(failureContext(error)?.code ?? 'HANDLER_FAILED', new Date().toISOString()); }
        catch { }
      }
      if (failureContext(error)) throw error;
      original = fail('HANDLER_FAILED', 'handler', describe(error), { sourceCode: (error as { code?: string })?.code ?? null });
      throw original;
    } finally {
      await settle();
      if (context.commandTimingOwner !== 'production' && opening && configuration) {
        try {
          const loaded = await configuration;
          const command = loaded.catalog.commands.find(command => command.handlerName === name);
          recordCommandTiming(await opening, command, context.commandStartedAtMs, dependencies.now, loaded.commandTiming.emaAlpha);
        } catch (error) {
          throw commandTimingFailure(error, original);
        }
      }
    }
  };
  return { handlers, launchHandoff: (parameters, handoff) => launchAgent(parameters as unknown as Record<string, unknown>, handoff), async close() {
    if (closed) return;
    closed = true;
    if (opening) {
      let state: StateStore;
      try { state = await opening; } catch { return; }
      state.close();
    }
  } };

}
