import { productionResourceWait } from './production-resource-wait.ts';
import { readResourceWaitProtocolOptions } from './resource-wait-protocol.ts';
import { productionStateContext } from './state-migration-guard.ts';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { observeProcesses, createResourceSnapshotReader } from './os-runtime.ts';
import { evaluateResourceAdmission } from './resource-admission.ts';
import { evaluateLaunchAdmissionInTransaction } from './launch-state.ts';
import { createServicePorts as composeServicePorts } from './service-host.ts';
import { startBugSyncService } from './bug-sync.ts';
import { ServiceProducerRuntime } from './service-lifecycle.ts';
import { loadCompiledCatalog } from './compiled-catalog.ts';
import type { StateStore } from './state-store.ts';
import type { DeliveryReceipt, MessageRequest, VerifiedSender } from './agent-control.ts';
import type { ProcessScanDependencies, ResourceSnapshotReader } from './os-runtime.ts';
import type { ServiceEntryContext } from './service-entry.ts';
import type { ComposedServicePorts, ServiceHostDependencies } from './service-host.ts';

export async function createProductionServiceDependencies(
  context: ServiceEntryContext,
  options?: {
    onStore?: (store: StateStore) => void;
    now?: () => number;
    processScan?: ProcessScanDependencies;
    resourceReader?: ResourceSnapshotReader;
    resourcePaths?: readonly string[];
    sharedDelivery?: (request: MessageRequest, sender: VerifiedSender) => Promise<DeliveryReceipt>;
    schedule?: ServiceHostDependencies['schedule'];
    isClientAlive?: (clientId: string) => boolean;
  },
): Promise<ServiceHostDependencies> {
  for (const [name, path] of Object.entries(context)) if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`Service requires absolute ${name}`);
  const settings = JSON.parse(await readFile(join(context.orchestratorRoot, 'conf', 'raf.json'), 'utf8'));
  const cadence = settings.service?.hostTickIntervalMs;
  if (settings.version !== 1 || !Number.isFinite(cadence) || cadence <= 0) throw new Error('Invalid service.hostTickIntervalMs configuration');
  const now = options?.now ?? Date.now;
  const schedule = options?.schedule ?? ((at, wake) => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      if (stopped) return;
      const remaining = at - now();
      if (!Number.isFinite(remaining)) throw new Error('Service scheduler deadline is invalid');
      timer = setTimeout(() => {
        if (stopped) return;
        if (at > now()) arm();
        else void wake().catch(error => process.emitWarning(error));
      }, Math.min(2147483647, Math.max(0, remaining)));
      timer.unref();
    };
    arm();
    return () => { stopped = true; clearTimeout(timer); };
  });
  let store: StateStore | undefined;
  const boundStore = () => {
    if (!store) throw new Error('Production service state store is not bound');
    return store;
  };
  const paths = [...new Set(options?.resourcePaths ?? [context.orchestratorRoot])];
  if (!paths.length || paths.some(path => !isAbsolute(path))) throw new Error('Absolute resource paths are required');
  const reader = options?.resourceReader ?? createResourceSnapshotReader({ machineId: hostname(), paths });
  return {
    now,
    bindStore: handle => {
      if (store && store !== handle) throw new Error('Production service state store is already bound');
      store = handle;
      options?.onStore?.(handle);
    },
    resourceWait: {
      readSnapshot: async () => {
        const handle = boundStore();
        let snapshot;
        try { snapshot = await reader.read(); }
        catch (error) { return { status: 'UNKNOWN', reason: error instanceof Error ? error.message : String(error) }; }
        const requiredIds = paths.map(path => snapshot.fileSystemByPath[path]);
        if (snapshot.reasons.length || requiredIds.some(id => typeof id !== 'string' || !id.trim())) {
          return { status: 'UNKNOWN', reason: [...snapshot.reasons, ...(requiredIds.some(id => !id) ? ['Required filesystem mapping unavailable'] : [])].join('; ') };
        }
        const running = handle.sessionRepository.transaction(tx => (tx.listActiveSessions?.() ?? tx.listSessions()).filter(session => session.state === 'running' && session.process), 'read');
        const observations = await observeProcesses(running.map(session => session.process!), options?.processScan);
        const unknown = observations.find(observation => observation.state === 'unknown');
        if (unknown?.state === 'unknown') return { status: 'UNKNOWN', reason: unknown.error };
        const observedProcesses = observations.flatMap((observation, index) => observation.state === 'alive'
          ? [{ runId: running[index].runId, identity: observation.identity }] : []);
        const ids = [...new Set(requiredIds)];
        const admission = handle.sessionRepository.transaction(tx => evaluateLaunchAdmissionInTransaction(tx, {
          requested: { ramBytes: 0, diskBytes: Object.fromEntries(ids.map(id => [id, 0])) },
          requiredFileSystemIds: ids,
        }, { measurement: snapshot.measurement, observedProcesses }, evaluateResourceAdmission), 'read');
        return { status: admission.level, reason: admission.reasons.join('; ') };
      },
      isClientAlive: options?.isClientAlive ?? (() => false),
      watchResources: wake => {
        let stopped = false;
        let cancel: (() => void) | undefined;
        const arm = () => {
          if (!stopped) cancel = schedule(now() + cadence, async () => {
            try { if (!stopped) await wake(); } finally { arm(); }
          });
        };
        arm();
        return () => { stopped = true; cancel?.(); };
      },
      schedule,
      loadLastGrant: () => {
        const handle = boundStore();
        if (typeof handle.getResourceWaitLastGrant !== 'function') throw new Error('StateStore getResourceWaitLastGrant is unavailable');
        return handle.getResourceWaitLastGrant();
      },
      saveLastGrant: at => {
        const handle = boundStore();
        if (!Number.isFinite(at)) throw new Error('Resource grant timestamp is invalid');
        if (typeof handle.saveResourceWaitLastGrant !== 'function') throw new Error('StateStore saveResourceWaitLastGrant is unavailable');
        handle.saveResourceWaitLastGrant(at);
      },
    },
    schedule,
  };
}

export async function createServicePorts(
  context: ServiceEntryContext,
  options?: Parameters<typeof createProductionServiceDependencies>[1],
): Promise<ComposedServicePorts> {
  const stateContext = productionStateContext(context.orchestratorRoot, fileURLToPath(import.meta.url), context.homeDirectory, 'service-store');
  let resourceStore: StateStore | undefined;
  const clients = new Map<string, AbortSignal>();
  const dependencies = await createProductionServiceDependencies(context, {
    ...options, onStore: store => { resourceStore = store; options?.onStore?.(store); }, isClientAlive: id => {
      const signal = clients.get(id);
      return !!signal && !signal.aborted && (options?.isClientAlive?.(id) ?? true);
    },
  });
  dependencies.disableLegacyResourceWait = true;
  dependencies.resourceWait.watchResources = () => () => {};
  const ports = await composeServicePorts(context, dependencies);
  let resource: Awaited<ReturnType<typeof productionResourceWait>> | undefined;
  let bugSync: Awaited<ReturnType<typeof startBugSyncService>>;
  let defaultDelivery: Promise<import('./service-lifecycle.ts').SharedSystemDelivery> | undefined;
  const sharedDelivery: import('./service-lifecycle.ts').SharedSystemDelivery = options?.sharedDelivery ?? (async (request, sender) => {
    if (!defaultDelivery) defaultDelivery = import('./production-runtime.ts').then(module => {
      if (!resourceStore) throw new Error('Production service state store is not bound');
      const artifactPath = fileURLToPath(new URL('../dist/catalog.json', import.meta.url));
      return module.createProductionSystemDelivery(resourceStore, {
        stateContext, orchestratorRoot: context.orchestratorRoot, confRoot: join(context.orchestratorRoot, 'conf'), artifactPath,
        statePath: stateContext.statePath, tmpRoot: stateContext.tmpRoot, mode: 'production',
        commandStartedAtMs: performance.now(), resolveCaller: async () => undefined,
      }, loadCompiledCatalog(artifactPath));
    });
    return (await defaultDelivery)(request, sender);
  });
  const producers = new ServiceProducerRuntime({
    sharedDelivery,
    resourceWait: {
      start: async epoch => { if (!resource) throw new Error('Resource wait is not initialized'); await resource.start(epoch); },
      stop: async () => { await resource?.stop(); },
    },
    bugSync: {
      start: async notifier => {
        bugSync = await startBugSyncService({
          orchestratorRoot: context.orchestratorRoot, homeDirectory: context.homeDirectory, stateDirectory: context.stateDirectory,
          now: dependencies.now, schedule: dependencies.schedule, notifier,
        });
      },
      stop: async () => { await bugSync?.stop(); },
    },
  });
  try {
    const [constants, raf] = await Promise.all(['raf-constants.json', 'raf.json'].map(async name => JSON.parse(await readFile(join(context.orchestratorRoot, 'conf', name), 'utf8'))));
    resource = await productionResourceWait(context, readResourceWaitProtocolOptions({ constants, raf }), () => { if (!resourceStore) throw new Error('Resource state not initialized'); return resourceStore; }, options?.resourceReader, options?.now);
  } catch (error) {
    await producers.shutdown();
    await ports.shutdown();
    throw error;
  }
  return {
    ...ports,
    resourceWait: resource.attach,
    recover: async bootstrap => {
      await ports.recover();
      if (!bootstrap?.serviceEpoch) throw new Error('Service epoch is required');
      await producers.recover(bootstrap);
    },
    handle: async (request, client) => {
      if (client.signal.aborted) throw new Error('Service request cancelled');
      clients.set(client.clientId, client.signal);
      const remove = () => { if (clients.get(client.clientId) === client.signal) clients.delete(client.clientId); };
      client.signal.addEventListener('abort', remove, { once: true });
      try { return await ports.handle(request, client); }
      finally { remove(); client.signal.removeEventListener('abort', remove); }
    },
    shutdown: async () => {
      clients.clear();
      try { await producers.shutdown(); } finally { await ports.shutdown(); }
    },
  };
}
