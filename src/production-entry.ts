import { productionStateContext } from './state-migration-guard.ts';
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
import type { CommandStatePorts } from './reminder-cli.ts';
import type { BugCommand } from './bug-cli.ts';
import type { StateStore } from './state-store.ts';
import type { RuntimeServices } from './app-runtime.ts';

export interface ProductionEntryOptions {
  orchestratorRoot: string;
  homeDirectory: string;
  artifactPath: string;
  now?: () => number;
  runIdentity?: { runId: string; tmuxSession: string };
  serviceHostModulePath?: string;
}

function failure(code: string, reason: string, source = 'production-entry'): Error {
  return commandFailure({ code, message: reason, stage: 'startup', source, sourceCode: null, reason,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true,
    remediation: ['Перевірте конфігурацію та доступність потрібного компонента.'] });
}

function readConfiguration(root: string): { models: ModelCatalog; commandTiming: { emaAlpha: number }; fileName: string } {
  const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
  const read = (name: string) => {
    const path = join(root, 'conf', name);
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw failure('CONFIGURATION_INVALID', `Cannot read valid ${path}: ${(error as NodeJS.ErrnoException).code ?? 'invalid JSON'}`, path); }
  };
  const settings = read('raf.json');
  if (!object(settings) || settings.version !== 1 || !object(settings.commandTiming) ||
      !Number.isFinite(settings.commandTiming.emaAlpha) || settings.commandTiming.emaAlpha <= 0 || settings.commandTiming.emaAlpha > 1 ||
      !object(settings.state) || !text(settings.state.fileName) || ['.', '..'].includes(settings.state.fileName) ||
      basename(settings.state.fileName) !== settings.state.fileName || /[\\/\0]/.test(settings.state.fileName)) {
    throw failure('CONFIGURATION_INVALID', 'Invalid raf.json version, commandTiming.emaAlpha or state.fileName', 'raf.json');
  }
  const models = read('models.json');
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
  return { models: models as unknown as ModelCatalog, commandTiming: { emaAlpha: settings.commandTiming.emaAlpha }, fileName: settings.state.fileName };
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

function productionContext(options: ProductionEntryOptions, orchestratorRoot: string, fileName: string, commandStartedAtMs: number, resolveCaller: () => Promise<unknown>) {
  const stateContext = productionStateContext(orchestratorRoot, fileURLToPath(import.meta.url), options.homeDirectory, 'cli');
  return { stateContext, orchestratorRoot: orchestratorRoot, confRoot: join(orchestratorRoot, 'conf'), artifactPath: options.artifactPath,
    statePath: stateContext.statePath, tmpRoot: stateContext.tmpRoot,
    mode: 'production' as const, commandStartedAtMs, resolveCaller };
}

function runnerLimits(options: ProductionEntryOptions, orchestratorRoot: string, commandStartedAtMs: number): Handler {
  return async params => {
    const loaded = readConfiguration(orchestratorRoot);
    const catalog: CompiledCatalog = JSON.parse(readFileSync(options.artifactPath, 'utf8'));
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

function commandState(orchestratorRoot: string): (store: StateStore, services: () => Promise<RuntimeServices>) => CommandStatePorts {
  return (store, services) => ({
    store, now: Date.now, nextReminderId: randomUUID, catalog: loadEventCatalog(orchestratorRoot),
    deliver: async (request, sender) => {
      if (sender.kind !== 'system') return { accepted: false, reason: 'Command state delivers only system messages' };
      try { return await (await services()).control.message(request, rafSystemCaller); }
      catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : String(error) }; }
    },
  });
}

function openProductionRuntime(options: ProductionEntryOptions, orchestratorRoot: string, commandStartedAtMs: number, resolveCaller: () => Promise<unknown>, additionalHandlers: Record<string, Handler> = {}): AppRuntime {
  const now = clock(options);
  const loaded = readConfiguration(orchestratorRoot);
  const catalog: CompiledCatalog = JSON.parse(readFileSync(options.artifactPath, 'utf8'));
  const context = productionContext(options, orchestratorRoot, loaded.fileName, commandStartedAtMs, resolveCaller);
  return createAppRuntime(context, {
    additionalHandlers,
    now, loadConfiguration: async () => ({ catalog, models: loaded.models, commandTiming: loaded.commandTiming }),
    openStore: async path => openStateStore(path, { context: context.stateContext }), nextRunIdentity: () => options.runIdentity ?? ({ runId: randomUUID(), tmuxSession: randomUUID() }),
    createServices: createProductionServices, commandState: commandState(orchestratorRoot),
  });
}

export async function withProductionRuntime<T>(options: ProductionEntryOptions, resolveCaller: () => Promise<unknown>, use: (runtime: AppRuntime) => Promise<T>): Promise<T> {
  const commandStartedAtMs = clock(options)();
  const runtime = openProductionRuntime(options, validatedRoot(options), commandStartedAtMs, resolveCaller);
  try { return await use(runtime); }
  finally { await runtime.close(); }
}

export async function runProductionCli(argv: readonly string[], options: ProductionEntryOptions): Promise<ExecutionResult> {
  if (argv[0] === 'test' && argv[1] === 'run' && !argv.includes('--help')) {
    const { runConfiguredTestRun } = await import('./test-run-runtime.ts');
    return runConfiguredTestRun(argv.slice(2), options);
  }
  const startedAtMs = performance.now();
  let runtime: AppRuntime | undefined;
  const unavailable = () => { throw failure('COMMAND_UNAVAILABLE', 'Production service for this operation is unavailable'); };
  const handlers = new Proxy(Object.create(null) as Record<string, Handler>, {
    get(_target, name) {
      if (typeof name !== 'string') return undefined;
      if (!['agent run', 'agent ps', 'agent update', 'agent message', 'agent close', 'agent interrupt', 'main attach', 'runner enable', 'runner disable', 'runner list', 'runner limits', 'command stats', 'service start', 'service status', 'service stop',
        'reminder add', 'reminder list', 'reminder update', 'reminder activate', 'reminder close', 'reminder reassign', 'reminder close-all',
        'bug list', 'bug show', 'bug comment add', 'bug status set', 'bug attachment get'].includes(name)) return unavailable;
      return async (params: Record<string, unknown>) => {
        try {
          const commandStartedAtMs = options.now?.() ?? startedAtMs;
          const orchestratorRoot = validatedRoot(options);
          readConfiguration(orchestratorRoot);
          productionStateContext(orchestratorRoot, fileURLToPath(import.meta.url), options.homeDirectory, 'cli');
          if (name.startsWith('bug ')) {
            const [{ createBugHandlers }, { createProductionBugPorts }] = await Promise.all([import('./bug-cli.ts'), import('./bug-production.ts')]);
            return await createBugHandlers(createProductionBugPorts({ orchestratorRoot, homeDirectory: options.homeDirectory }))[name as BugCommand](params);
          }
          if (name.startsWith('service ')) {
            readConfiguration(orchestratorRoot);
            const settings = JSON.parse(readFileSync(join(orchestratorRoot, 'conf', 'raf.json'), 'utf8'));
            const services = createServiceHandlers({ orchestratorRoot: orchestratorRoot, homeDirectory: options.homeDirectory,
              service: settings.service, hostModulePath: options.serviceHostModulePath ?? fileURLToPath(new URL('./production-service-ports.ts', import.meta.url)) });
            return await services.handlers[name as keyof typeof services.handlers](params);
          }
          runtime = openProductionRuntime(options, orchestratorRoot, commandStartedAtMs, async () => undefined, { 'runner limits': runnerLimits(options, orchestratorRoot, commandStartedAtMs) });
          const result = await runtime.handlers[name](params);
          await runtime.close();
          return result;
        } catch (error) {
          try { await runtime?.close(); } catch {}
          if (failureContext(error)) throw error;
          throw failure('PRODUCTION_ENTRY_FAILED', error instanceof Error ? error.message : String(error));
        }
      };
    },
  });
  try { return await runCli(argv, options.artifactPath, handlers); }
  finally { await runtime?.close(); }
}
