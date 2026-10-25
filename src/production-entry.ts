import { loadCompiledCatalog } from './compiled-catalog.ts';
import { productionBindings } from './production-bindings.ts';
import { settleRuntimeHealthCpu } from './health-cpu-runtime.ts';
import { RafCostRuntime, rafCostBoundary, type RafCostBoundary } from './raf-cost-runtime.ts';
import { commandTimingFailure, recordCommandTiming, validateCommandTiming } from './command-timing.ts';
import { storedLaunchQueueIdentity, validateStoredQueueId } from './stored-launch-queue-events.ts';
import { readMachineBootIdentity } from './os-runtime.ts';
import { productionStateContext, type StateContext } from './state-migration-guard.ts';
import { createServiceHandlers } from './service-entry.ts';
import { createProductionServices, rafSystemCaller } from './production-runtime.ts';
import { fileURLToPath } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ExecutionResult, Handler } from './cli.ts';
import type { CompiledCatalog } from './catalog.ts';
import { runCli } from './bootstrap.ts';
import { createAppRuntime, runnerLimitsHandler, type AppRuntime } from './app-runtime.ts';
import { openStateStore } from './state-store.ts';
import { type ModelCatalog } from './model-routing.ts';
import { commandFailure, failureContext } from './cli-contract.ts';
import { loadEventCatalog } from './event-catalog.ts';
import { settleCommandState, type CommandStatePorts } from './reminder-cli.ts';
import type { BugCommand } from './bug-cli.ts';
import type { StateStore } from './state-store.ts';
import type { RuntimeServices } from './app-runtime.ts';

export interface ProductionEntryOptions {
  orchestratorRoot: string;
  homeDirectory: string;
  artifactPath: string;
  now?: () => number;
  costStartedAt?: RafCostBoundary;
  runIdentity?: { runId: string; tmuxSession: string };
  serviceHostModulePath?: string;
}

function failure(code: string, reason: string, source = 'production-entry'): Error {
  return commandFailure({ code, message: reason, stage: 'startup', source, sourceCode: null, reason,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true,
    remediation: ['Перевірте конфігурацію та доступність потрібного компонента.'] });
}

function readConfiguration(root: string, catalog: CompiledCatalog): { models: ModelCatalog; commandTiming: { emaAlpha: number; sqliteOnlyMeanBudgetMs: number }; fileName: string } {
  const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
  const read = (name: string) => {
    const path = join(root, 'conf', name);
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw failure('CONFIGURATION_INVALID', `Cannot read valid ${path}: ${(error as NodeJS.ErrnoException).code ?? 'invalid JSON'}`, path); }
  };
  const settings = read('raf.json');
  if (!object(settings) || settings.version !== 1 ||
      !object(settings.state) || !text(settings.state.fileName) || ['.', '..'].includes(settings.state.fileName) ||
      basename(settings.state.fileName) !== settings.state.fileName || /[\\/\0]/.test(settings.state.fileName)) {
    throw failure('CONFIGURATION_INVALID', 'Invalid raf.json version or state.fileName', 'raf.json');
  }
  validateCommandTiming(settings.commandTiming);
  const models = catalog.models;
  if (!object(models) || models.version !== 1 || !Array.isArray(models.runners) || !models.runners.length ||
      models.runners.some((runner: unknown) => !object(runner) || !text(runner.id) || !/^[A-Za-z0-9_-]+$/.test(runner.id) || typeof runner.initialEnabled !== 'boolean') ||
      new Set(models.runners.map((runner: any) => runner.id)).size !== models.runners.length ||
      !Array.isArray(models.models) || !object(models.routing) || !strings(models.routing.complexityOrder) || !models.routing.complexityOrder.length ||
      !object(models.routing.taskClassification) || !Object.values(models.routing.taskClassification).every(strings) ||
      !object(models.routing.roleModelBindings) || !Object.values(models.routing.roleModelBindings).every(strings) ||
      !Array.isArray(models.routing.runnerPreferences) || models.routing.runnerPreferences.some((entry: unknown) => !object(entry) || !text(entry.complexity) || !strings(entry.runners)) ||
      !Array.isArray(models.routing.modelTransitions) || models.routing.modelTransitions.some((entry: unknown) => !object(entry) || !text(entry.from) || !strings(entry.to)) ||
      models.models.some((model: unknown) => !object(model) || !['id', 'version', 'runner', 'effort', 'complexity'].every(key => text(model[key])) || typeof model.enabled !== 'boolean' ||
        !models.runners.some((runner: any) => runner.id === model.runner) || !models.routing.complexityOrder.includes(model.complexity) || (model.quotaPool !== undefined && !text(model.quotaPool))) ||
      new Set(models.models.map((model: any) => model.id)).size !== models.models.length) {
    throw failure('CONFIGURATION_INVALID', 'Invalid models.json configuration or version', 'models.json');
  }
  return { models: models as unknown as ModelCatalog, commandTiming: { emaAlpha: settings.commandTiming.emaAlpha, sqliteOnlyMeanBudgetMs: settings.commandTiming.sqliteOnlyMeanBudgetMs }, fileName: settings.state.fileName };
}

function canonicalRoot(path: string): string {
  try { return realpathSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw failure('INVALID_CONTEXT', `Orchestrator root does not exist: ${path}`); throw error; }
}

function validatedRoot(options: ProductionEntryOptions): string {
  for (const key of ['orchestratorRoot', 'homeDirectory', 'artifactPath'] as const) if (!isAbsolute(options[key])) throw failure('INVALID_CONTEXT', `Absolute ${key} required`);
  return canonicalRoot(options.orchestratorRoot);
}

function clock(options: ProductionEntryOptions): () => number {
  return options.now ?? (() => performance.now());
}

function productionContext(options: ProductionEntryOptions, orchestratorRoot: string, fileName: string, commandStartedAtMs: number, resolveCaller: () => Promise<unknown>, sharedContext?: StateContext) {
  const stateContext = sharedContext ?? productionStateContext(orchestratorRoot, fileURLToPath(import.meta.url), options.homeDirectory, 'cli');
  return { stateContext, orchestratorRoot: orchestratorRoot, confRoot: join(orchestratorRoot, 'conf'), artifactPath: options.artifactPath,
    statePath: stateContext.statePath, tmpRoot: stateContext.tmpRoot,
    mode: 'production' as const, commandStartedAtMs, resolveCaller };
}

function runnerLimits(options: ProductionEntryOptions, orchestratorRoot: string, commandStartedAtMs: number): Handler {
  return async params => {
    const catalog = loadCompiledCatalog(options.artifactPath);
    const loaded = readConfiguration(orchestratorRoot, catalog);
    return runnerLimitsHandler(loaded.models.runners.map(runner => runner.id), async runners => {
      const context = productionContext(options, orchestratorRoot, loaded.fileName, commandStartedAtMs, async () => undefined);
      const store = openStateStore(context.statePath, { context: context.stateContext });
      try {
        store.initializeRunners(loaded.models.runners);
        const services = await createProductionServices(store, { catalog, models: loaded.models, commandTiming: loaded.commandTiming }, context);
        if (!services.collectQuotas) throw failure('COMMAND_UNAVAILABLE', 'Quota collection is unavailable in this runtime');
        return await services.collectQuotas(runners);
      } finally { store.close(); }
    })(params);
  };
}

function commandState(orchestratorRoot: string, catalog: CompiledCatalog): (store: StateStore, services: () => Promise<RuntimeServices>) => CommandStatePorts {
  return (store, services) => ({
    store, orchestratorRoot, now: Date.now, nextReminderId: randomUUID, catalog: loadEventCatalog(orchestratorRoot, catalog),
    validateResourceQueueId: async id => validateStoredQueueId(store, storedLaunchQueueIdentity(store, (await readMachineBootIdentity()).machineId), id),
    deliver: async (request, sender) => {
      if (sender.kind !== 'system') return { accepted: false, reason: 'Command state delivers only system messages' };
      try { return await (await services()).control.message(request, rafSystemCaller); }
      catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : String(error) }; }
    },
  });
}

function openProductionRuntime(options: ProductionEntryOptions, orchestratorRoot: string, commandStartedAtMs: number, resolveCaller: () => Promise<unknown>, additionalHandlers: Record<string, Handler> = {}, commandTimingOwner?: 'production', sharedState?: { store: StateStore; context: StateContext }): AppRuntime {
  const now = clock(options);
  const catalog = loadCompiledCatalog(options.artifactPath);
  const loaded = readConfiguration(orchestratorRoot, catalog);
  const context = { ...productionContext(options, orchestratorRoot, loaded.fileName, commandStartedAtMs, resolveCaller, sharedState?.context), commandTimingOwner };
  return createAppRuntime(context, {
    additionalHandlers,
    now, loadConfiguration: async () => ({ catalog, models: loaded.models, commandTiming: loaded.commandTiming }),
    openStore: async path => sharedState ? { ...sharedState.store, close() {} } : openStateStore(path, { context: context.stateContext }), nextRunIdentity: () => options.runIdentity ?? ({ runId: randomUUID(), tmuxSession: randomUUID() }),
    createServices: createProductionServices, commandState: commandState(orchestratorRoot, catalog),
  });
}

export async function withProductionRuntime<T>(options: ProductionEntryOptions, resolveCaller: () => Promise<unknown>, use: (runtime: AppRuntime) => Promise<T>): Promise<T> {
  const commandStartedAtMs = clock(options)();
  const runtime = openProductionRuntime(options, validatedRoot(options), commandStartedAtMs, resolveCaller);
  try { return await use(runtime); }
  finally { await runtime.close(); }
}

export async function runProductionCli(argv: readonly string[], options: ProductionEntryOptions): Promise<ExecutionResult> {
  const costStartedAt = options.costStartedAt ?? rafCostBoundary();
  const now = clock(options);
  const startedAtMs = options.costStartedAt?.monotonicMs ?? (options.now ? now() : costStartedAt.monotonicMs);
  let runtime: AppRuntime | undefined;
  let testExecution: ExecutionResult | undefined;
  const bindings = productionBindings(async (name, params) => {
        let profileStore: StateStore | undefined;
        let profile: RafCostRuntime | undefined;
        let original: unknown;
        let loaded: ReturnType<typeof readConfiguration> | undefined;
        let command: CompiledCatalog['commands'][number] | undefined;
        let executionCatalog: CompiledCatalog | undefined;
        try {
          const commandStartedAtMs = startedAtMs;
          const orchestratorRoot = validatedRoot(options);
          const catalog = executionCatalog = loadCompiledCatalog(options.artifactPath);
          loaded = readConfiguration(orchestratorRoot, catalog);
          command = catalog.commands.find(candidate => candidate.handlerName === name);
          const profileContext = productionStateContext(orchestratorRoot, fileURLToPath(import.meta.url), options.homeDirectory, 'cli');
          const serviceHandlers = name.startsWith('service ') ? createServiceHandlers({
            orchestratorRoot, homeDirectory: options.homeDirectory,
            service: JSON.parse(readFileSync(join(orchestratorRoot, 'conf', 'raf.json'), 'utf8')).service,
            hostModulePath: options.serviceHostModulePath ?? fileURLToPath(new URL('./production-service-ports.ts', import.meta.url)),
          }) : undefined;
          const sqliteStartedAt = rafCostBoundary();
          profileStore = openStateStore(profileContext.statePath, { context: profileContext });
          profile = new RafCostRuntime(profileStore, { scope: 'command', command: name }, orchestratorRoot, 'handler', costStartedAt, sqliteStartedAt);
          profile.install();
          if (name === 'test run') {
            const { runConfiguredTestRun } = await import('./test-run-runtime.ts');
            let services: Promise<RuntimeServices> | undefined;
            testExecution = await runConfiguredTestRun(argv.slice(2), { ...options, costStartedAt, commandTimingOwner: 'production', settle: async store => {
              const context = productionContext(options, orchestratorRoot, loaded!.fileName, commandStartedAtMs, async () => rafSystemCaller);
              await settleCommandState(commandState(orchestratorRoot, catalog)(store, () => services ??= createProductionServices(store, {
                catalog, models: loaded!.models, commandTiming: loaded!.commandTiming,
              }, context)));
            } });
            return null;
          }
          if (name.startsWith('bug ')) {
            const [{ createBugHandlers }, { createProductionBugPorts }] = await Promise.all([import('./bug-cli.ts'), import('./bug-production.ts')]);
            return await createBugHandlers(createProductionBugPorts({ orchestratorRoot, homeDirectory: options.homeDirectory }))[name as BugCommand](params);
          }
          if (name === 'resource wait') {
            const { waitForResources } = await import('./resource-wait-command.ts');
            const result = await waitForResources({ orchestratorRoot, homeDirectory: options.homeDirectory, level: params.level as string, developmentDirectory: process.cwd(), hostModulePath: options.serviceHostModulePath });
            if (result.kind === 'error') throw commandFailure({ code: 'SERVICE_OPERATION_FAILED', message: result.diagnostic.reason, stage: 'resource wait', source: 'resource-wait', sourceCode: 1,
              reason: result.diagnostic.details, received: result.diagnostic.received, expected: result.diagnostic.expected, found: null,
              completed: [...result.diagnostic.completed], pending: [...result.diagnostic.pending], retrySafe: false, remediation: [result.diagnostic.remediation] });
            return result;
          }
          if (serviceHandlers) return await serviceHandlers.handlers[name as keyof typeof serviceHandlers.handlers](params);
          runtime = openProductionRuntime(options, orchestratorRoot, commandStartedAtMs, async () => undefined, { 'runner limits': runnerLimits(options, orchestratorRoot, commandStartedAtMs) }, 'production', name === 'agent ps' ? { store: profileStore, context: profileContext } : undefined);
          const result = await runtime.handlers[name](params);
          await runtime.close();
          return result;
        } catch (error) {
          original = failureContext(error) ? error : failure('PRODUCTION_ENTRY_FAILED', error instanceof Error ? error.message : String(error));
          const diagnostic = failureContext(original);
          if (profileStore && diagnostic) { try { profileStore.recordHealthRefusal(diagnostic.code, diagnostic.stage); } catch (healthError) { process.emitWarning(String(healthError)); } }
          try { await runtime?.close(); } catch {}
          throw original;
        } finally {
          let finalizationError: unknown;
          try { profile?.stage('finalization'); profile?.finish(); }
          catch (error) { if (original === undefined) finalizationError = error; else process.emitWarning(error instanceof Error ? error : String(error)); }
          if (profileStore) await settleRuntimeHealthCpu(profileStore, options.orchestratorRoot);
          if (profileStore && loaded && executionCatalog && !runtime && name !== 'test run' && !name.startsWith('service ')) {
            try {
              const context = productionContext(options, options.orchestratorRoot, loaded.fileName, startedAtMs, async () => rafSystemCaller);
              let services: Promise<RuntimeServices> | undefined;
              const catalog = executionCatalog;
              await settleCommandState(commandState(options.orchestratorRoot, catalog)(profileStore, () => services ??= createProductionServices(profileStore!, {
                catalog, models: loaded!.models, commandTiming: loaded!.commandTiming,
              }, context)));
            } catch (error) { process.emitWarning(String(error)); }
          }
          try {
            if (profileStore && loaded) recordCommandTiming(profileStore, command, startedAtMs, now, loaded.commandTiming.emaAlpha);
          } catch (error) { finalizationError = commandTimingFailure(error, original ?? finalizationError); }
          finally { profileStore?.close(); }
          if (finalizationError !== undefined) {
            if (!testExecution) throw finalizationError;
            testExecution.exitCode = testExecution.exitCode || 1;
            testExecution.stderr = [testExecution.stderr, finalizationError instanceof Error ? finalizationError.message : String(finalizationError)].filter(Boolean).join('\n');
          }
        }
  });
  const handlers: Record<string, Handler> = Object.fromEntries(bindings.map(binding => [binding.path.join(' '), async (params: Record<string, unknown>) => (await binding.load())(params)]));
  try {
    const result = await runCli(argv, options.artifactPath, handlers);
    return result.exitCode === 0 && testExecution ? testExecution : result;
  }
  finally { await runtime?.close(); }
}
