import { loadCompiledCatalog } from './compiled-catalog.ts';
import { RafCostRuntime, rafCostBoundary, measureRafCost } from './raf-cost-runtime.ts';
import { productionStateContext, stateFailure } from './state-migration-guard.ts';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { openStateStore } from './state-store.ts';
import { createResourceWaitQueue } from './resource-wait.ts';
import type { ServiceEntryContext, ServicePorts } from './service-entry.ts';
import type { StateStore } from './state-store.ts';
import type { ResourceWaitDependencies } from './resource-wait.ts';

export type ServiceHostDependencies = {
  disableLegacyResourceWait?: boolean;
  now: () => number;
  bindStore?: (store: StateStore) => void;
  resourceWait: Omit<ResourceWaitDependencies, 'now'>;
  schedule: (at: number, wake: () => Promise<void>) => () => void;
};

export type ComposedServicePorts = ServicePorts & {
  refresh: () => Promise<void>;
};

export async function createServicePorts(
  context: ServiceEntryContext,
  dependencies?: ServiceHostDependencies,
): Promise<ComposedServicePorts> {
  const stateContext = productionStateContext(context.orchestratorRoot, fileURLToPath(import.meta.url), context.homeDirectory, 'service-store');
  if (context.stateDirectory !== dirname(stateContext.statePath) || context.socketPath !== join(context.stateDirectory, 'service.sock')) throw stateFailure('STATE_CONTEXT_REFUSED', 'Service paths differ from selected state context');
  const costStartedAt = rafCostBoundary();
  if (!dependencies) return (await import('./production-service-ports.ts')).createServicePorts(context);
  const required = [dependencies.now, dependencies.schedule, dependencies.resourceWait?.readSnapshot, dependencies.resourceWait?.isClientAlive,
    dependencies.resourceWait?.watchResources, dependencies.resourceWait?.schedule, dependencies.resourceWait?.loadLastGrant, dependencies.resourceWait?.saveLastGrant];
  if (required.some(value => typeof value !== 'function')) throw new Error('Service host dependencies are incomplete');
  for (const [name, path] of Object.entries(context)) if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`Service host requires absolute ${name}`);
  const settings = JSON.parse(await readFile(join(context.orchestratorRoot, 'conf', 'raf.json'), 'utf8'));
  const catalog = loadCompiledCatalog().constants as Record<string, any>;
  const fileName = settings.state?.fileName;
  if (settings.version !== 1 || typeof fileName !== 'string' || !fileName || ['.', '..'].includes(fileName) || basename(fileName) !== fileName || /[\\/\0]/.test(fileName)) throw new Error('Invalid service state.fileName configuration');
  const cadence = settings.service?.hostTickIntervalMs;
  const grantIntervalMs = settings.resourceWait?.grantIntervalMs;
  if (!Number.isFinite(cadence) || cadence <= 0) throw new Error('Invalid service.hostTickIntervalMs configuration');
  if (!Number.isFinite(grantIntervalMs) || grantIntervalMs <= 0) throw new Error('Invalid resourceWait.grantIntervalMs configuration');
  if (!Array.isArray(catalog.events) || !catalog.events.length || !catalog.eventIdKinds || !Array.isArray(catalog.resourceWaitLevels) || !catalog.resourceWaitLevels.length ||
      catalog.resourceWaitLevels.some((level: { id: string; priority: number }) => typeof level.id !== 'string' || !level.id || !Number.isFinite(level.priority)) ||
      new Set(catalog.resourceWaitLevels.map((level: { id: string }) => level.id)).size !== catalog.resourceWaitLevels.length) throw new Error('Invalid service event or resource level catalog');
  const clock = () => {
    const value = dependencies.now();
    if (!Number.isFinite(value)) throw new Error('Service clock unavailable');
    return value;
  };
  const sqliteStartedAt = rafCostBoundary();
  const store = openStateStore(join(context.stateDirectory, fileName), { context: stateContext });
  let profile: RafCostRuntime | undefined;
  let queue: ReturnType<typeof createResourceWaitQueue> | undefined;
  try {
    profile = new RafCostRuntime(store, { scope: 'service', command: null }, context.orchestratorRoot, 'wait', costStartedAt, sqliteStartedAt);
    profile.install();
    dependencies.bindStore?.(store);
    let resourceInitializationError: unknown;
    if (!dependencies.disableLegacyResourceWait) queue = createResourceWaitQueue({ grantIntervalMs, levels: catalog.resourceWaitLevels }, {
      ...dependencies.resourceWait, now: clock,
      loadLastGrant: () => {
        try {
          const at = dependencies.resourceWait.loadLastGrant();
          if (at !== null && !Number.isFinite(at)) throw new Error('Persisted resource grant time is invalid');
          return at;
        } catch (error) { resourceInitializationError = error; throw error; }
      },
      watchResources: wake => {
        try { return dependencies.resourceWait.watchResources(wake); }
        catch (error) { resourceInitializationError = error; throw error; }
      },
    });
    if (resourceInitializationError !== undefined) throw resourceInitializationError;
    const resourceQueue = queue;
    let closed = false;
    let recovered = false;
    let recovery: Promise<void> | undefined;
    let shutdown: Promise<void> | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    let cancelWake: (() => void) | undefined;
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      const next = tail.then(() => {
        if (closed) throw new Error('Service host is closed');
        return operation();
      });
      tail = next.catch(() => {});
      return next;
    };
    const arm = () => {
      cancelWake?.();
      cancelWake = undefined;
      if (closed) return;
      cancelWake = dependencies.schedule(clock() + cadence, async () => { cancelWake = undefined; await refresh(); });
    };
    const cycle = async () => {
      try {
        await measureRafCost('resource-queue', async () => resourceQueue?.pump());
      } finally { arm(); }
    };
    const refresh = () => serial(() => measureRafCost('handler', cycle));
    const recover = (): Promise<void> => {
      if (closed) return Promise.reject(new Error('Service host is closed'));
      if (!recovery) recovery = refresh().then(() => { recovered = true; });
      return recovery;
    };
    const payload = (value: unknown): Record<string, any> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Service operation payload must be an object');
      return value as Record<string, any>;
    };
    return {
      recover, refresh,
      handle: async (request, client) => {
        if (closed) throw new Error('Service host is closed');
        if (!recovered) throw new Error('Service host recovery has not completed');
        if (client.signal.aborted) throw new Error('Service request cancelled');
        if (request.operation === 'resource.wait') {
          const input = payload(request.payload);
          if (!resourceQueue) throw new Error('Resource wait requires the offer/ready/commit channel');
          return resourceQueue.enqueue({ clientId: client.clientId, level: input.level, signal: client.signal }).result;
        }
        throw new Error(`Unsupported service operation: ${request.operation}`);
      },
      shutdown: () => {
        if (!shutdown) {
          closed = true;
          shutdown = (async () => {
            cancelWake?.();
            cancelWake = undefined;
            resourceQueue?.close('Service stopped');
            await tail;
            try { profile?.stage('finalization'); profile?.finish(); } finally { store.close(); }
          })();
        }
        return shutdown;
      },
    };
  } catch (error) {
    queue?.close('Service initialization failed');
    try { profile?.finish(); } catch (failure) { process.emitWarning(failure instanceof Error ? failure : String(failure)); }
    store.close();
    throw error;
  }
}

export default createServicePorts;
