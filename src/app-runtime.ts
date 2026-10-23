import { isAbsolute, join } from 'node:path';
import { commandFailure, failureContext, type CommandFailureContext } from './cli-contract.ts';
import type { Handler } from './cli.ts';
import type { CompiledCatalog } from './catalog.ts';
import type { StateStore } from './state-store.ts';
import type { SessionActivity, SessionRecord, ProcessIdentity } from './session-state.ts';
import type { AssignmentSnapshot, AssignmentRequest, AssignmentValidation, AssignmentBriefContext } from './assignment.ts';
import type { WorkspaceRouteRequest, WorkspaceRouteResult } from './workspace-routing.ts';
import type { ModelCatalog, ModelRequest, ModelSelection, ModelAvailability, RoutingSnapshot } from './model-routing.ts';
import type { AdapterStartRequest, AdapterSession, ReportWrapper } from './agent-adapters.ts';
import type { DeliveryReceipt, CloseResult, MainAttachment } from './agent-control.ts';
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
  resolveCaller(): Promise<unknown>;
}

export interface RuntimeConfiguration {
  catalog: CompiledCatalog;
  models: ModelCatalog;
  commandTiming: { emaAlpha: number };
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
  readonly reportSchema: Readonly<Record<string, unknown>>;
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
  notify?: NotifyTarget;
  taskContext?: { parameters: RuntimeRunParameters; context: RuntimeTaskContext };
}

export interface PreparedRuntimeReport {
  reportPath: string;
  reportWrapper: ReportWrapper;
  cleanupUnstarted(): Promise<void>;
}

export interface RuntimeServices {
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
  reserve(input: RuntimeLaunch & { reportPath: string; requested: ResourceReservation; requiredFileSystemIds: string[] }): Promise<{ admitted: true } | { admitted: false; reason: string }>;
  adapter: { start(request: AdapterStartRequest): Promise<AdapterSession> };
  verifyStarted(launch: RuntimeLaunch, session: AdapterSession): Promise<ProcessIdentity>;
  commitStarted(runId: string, identity: ProcessIdentity): Promise<boolean>;
  compensate(launch: RuntimeLaunch, error: unknown): Promise<{ stopped: true } | { stopped: false; reason: string }>;
  abortLaunch(runId: string, reason: string): Promise<void>;
  control: {
    ps(): Promise<SessionRecord[]>;
    update(id: string, patch: Partial<Pick<SessionActivity, 'project' | 'features' | 'phase'>>, caller: unknown): Promise<SessionRecord>;
    message(input: { to: string; text: string }, caller: unknown): Promise<DeliveryReceipt>;
    close(id: string, caller: unknown): Promise<CloseResult>;
    interrupt(id: string, caller: unknown): Promise<void>;
    attachMain(): Promise<MainAttachment>;
  };
  authorizeMain(caller: unknown): Promise<void>;
  collectQuotas?(runners: string[]): Promise<CollectionResult>;
}

export interface AppRuntimeDependencies {
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
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true,
    remediation: ['Виправте причину та повторіть команду.'], ...facts,
  });
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  const config = () => configuration ??= (async () => {
    if (closed) throw fail('RUNTIME_CLOSED', 'context', 'Runtime closed');
    for (const name of ['orchestratorRoot', 'confRoot', 'artifactPath', 'statePath', 'tmpRoot'] as const) {
      if (!isAbsolute(context[name])) throw fail('INVALID_CONTEXT', 'context', `Absolute ${name} required`);
    }
    return dependencies.loadConfiguration(context);
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
  const builtins: Record<string, Handler> = {
    'agent run': async raw => {
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
        return api.resolveNotify(params.notify);
      })();
      const validation = await api.assignment.validate({ root: context.orchestratorRoot, selections: [...selections].map(([change, items]) => ({ change, items })) });
      if (!validation.ok) throw fail('INVALID_ASSIGNMENT', 'assignment', `${validation.kind}: ${validation.issues.map(issue => `${issue.change}: ${issue.reason}`).join('; ')}`, { received: params.tasks, found: validation.issues });
      const assignment = validation.snapshot;
      const task = await api.resolveTask(params, assignment);
      const identity = dependencies.nextRunIdentity();
      const hotfix = params.type === 'hotfix' && params.project === 'raf';
      const route = await api.route({ root: context.orchestratorRoot, project: params.project, branch: task.branch, ...(hotfix ? { hotfixRunId: identity.runId } : {}) });
      if (!route.ok) throw fail(route.error.code, 'workspace', route.error.message);
      const workspaceBoundaries = bindWorkspaceBoundaries(task, route.cwd);
      const gitBoundaries = await resolveGitWriteBoundaries(route.cwd, context.orchestratorRoot, hotfix || !task.workspaceWritable ? task.writeBoundaries : undefined);
      const commitOwnWork = task.workspaceWritable || gitBoundaries.length > 0;
      const writeBoundaries = [...workspaceBoundaries, ...gitBoundaries.filter(path => !workspaceBoundaries.includes(path))];
      const selection = api.selectModel(loaded.models, await snapshot(), { complexity: params.complexity, role: params.type });
      if (selection.status === 'waiting') throw fail(selection.code, 'selection', selection.reason);
      const launch: RuntimeLaunch = { ...identity, addressId: params.id,
        ...(notify ? { notify } : {}),
        activity: { type: params.type, project: params.project, features: [...params.features], phase: params.phase, cwd: route.cwd },
        assignment, selection, statePath: context.statePath, tmpRoot: context.tmpRoot, writeBoundaries: [...writeBoundaries], taskContext: { parameters: params, context: { ...task, ...(route.hotfix ? { hotfix: route.hotfix } : {}) } } };
      let prepared: PreparedRuntimeReport | undefined;
      let reserved = false;
      let startAttempted = false;
      let stage = 'report';
      try {
        prepared = await api.prepareReport(launch);
        stage = 'brief';
        let brief = await api.assignment.compose(assignment, { briefsRoot: join(context.confRoot, 'briefs'), runner: selection.runner,
          stage: params.phase, project: params.project, agentId: params.id, sessionName: launch.tmuxSession,
          features: params.features, phase: params.phase, outcome: task.outcome, writeBoundaries,
          sources: task.sources, reportPath: prepared.reportPath, reportSchema: task.reportSchema,
          ...(commitOwnWork ? { commitOwnWork: true, commitPaths: workspaceBoundaries, commitRepositories: task.workspaceWritable ? [route.cwd, context.orchestratorRoot] : [context.orchestratorRoot], workspaceWritable: task.workspaceWritable } : {}),
          rafCommand: rafCommandFor(), ...(rafSubcommandsFor(params.type) ? { rafSubcommands: rafSubcommandsFor(params.type)! } : {}) });
        if (hotfix) brief += `\nHotfix raf: фізичний кандидат ${route.cwd}; логічна база й ціль main, baseCommit ${route.hotfix?.baseCommit}. Коміт кандидата не активує main; живий main і push недоступні. Коміт коду виконай довіреним портом: node ${join(context.tmpRoot, launch.runId, 'hotfix-commit.mjs')} --message <повідомлення> <власні відносні шляхи>.\n`;
        stage = 'reservation';
        const admission = await api.reserve({ ...launch, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
        if (!admission.admitted) throw fail('RESOURCE_UNAVAILABLE', stage, admission.reason);
        reserved = true;
        stage = 'start';
        startAttempted = true;
        const session = await api.adapter.start({ selection: { runner: selection.runner as AdapterStartRequest['selection']['runner'], model: selection.model, effort: selection.effort }, tmuxSession: launch.tmuxSession, cwd: route.cwd, brief, reportWrapper: prepared.reportWrapper });
        stage = 'identity';
        const identity = await api.verifyStarted(launch, session);
        stage = 'commit';
        if (!await api.commitStarted(launch.runId, identity)) throw fail('START_COMMIT_CONFLICT', stage, 'Started process could not be committed');
        return { runId: launch.runId, addressId: launch.addressId, tmuxSession: launch.tmuxSession,
          cwd: route.cwd, ...selection, status: 'running', selection, process: identity, reportPath: prepared.reportPath };
      } catch (error) {
        let safe = !startAttempted;
        const pending: string[] = [];
        if (startAttempted) {
          try { const result = await api.compensate(launch, error); safe = result.stopped; if (!safe) pending.push('process termination'); }
          catch { safe = false; pending.push('process termination'); }
        }
        if (safe && reserved) {
          try { await api.abortLaunch(launch.runId, describe(error)); }
          catch { safe = false; pending.push('abortLaunch'); }
        }
        if (safe && prepared) {
          try { await prepared.cleanupUnstarted(); }
          catch { pending.push('report cleanup'); safe = false; }
        }
        const supplied = failureContext(error);
        throw fail(supplied?.code ?? 'LAUNCH_FAILED', stage, supplied?.reason ?? describe(error), {
          ...supplied, message: `${supplied?.message ?? describe(error)} (runId: ${launch.runId})`, received: { runId: launch.runId, ...(supplied?.received ? { input: supplied.received } : {}) },
          completed: reserved ? ['reservation'] : [], pending, retrySafe: safe,
        });
      }
    },
    'agent ps': async () => (await service()).control.ps(),
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
      const result = await (await service()).control.close(params.id as string, await context.resolveCaller());
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
      return loaded.catalog.commands.filter(command => command.handlerName !== 'help').map(command => ({ command: command.path.join(' '), ...(state.getCommandTiming(command.path.join(' ')) ?? { averageMs: null, updatedAt: null }) }));
    },
  };
  if (dependencies.commandState) for (const name of reminderCommands) builtins[name] = async params => createReminderHandlers(await statePorts())[name](params);
  for (const [name, enabled] of [['runner enable', true], ['runner disable', false]] as const) builtins[name] = async params => {
    const loaded = await config();
    if (!loaded.models.runners.some(runner => runner.id === params.runner)) throw fail('INVALID_VALUE', 'runner', 'Unknown runner', { received: params.runner });
    await (await service()).authorizeMain(await context.resolveCaller());
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
      if (failureContext(error)) throw error;
      throw fail('HANDLER_FAILED', 'handler', describe(error), { sourceCode: (error as { code?: string })?.code ?? null });
    } finally {
      await settle();
      if (opening && configuration) {
        try {
          const loaded = await configuration;
          const command = loaded.catalog.commands.find(command => command.handlerName === name);
          if (command && command.metadata.recordDuration !== false) (await opening).recordCommandDuration(command.path.join(' '), Math.max(0, dependencies.now() - context.commandStartedAtMs), loaded.commandTiming.emaAlpha);
        } catch (error) {
          if (original === undefined) throw fail('TIMING_FAILED', 'timing', describe(error));
        }
      }
    }
  };
  return { handlers, async close() {
    if (closed) return;
    closed = true;
    if (opening) {
      let state: StateStore;
      try { state = await opening; } catch { return; }
      state.close();
    }
  } };

}
