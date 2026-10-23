import { productionResourceWait } from './production-resource-wait.ts';
import { readResourceWaitProtocolOptions } from './resource-wait-protocol.ts';
import { productionStateContext } from './state-migration-guard.ts';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { observeProcesses, createResourceSnapshotReader, readMachineBootIdentity } from './os-runtime.ts';
import { createAssignmentIdentityAdapter } from './assignment-identity.ts';
import { reconcileTaskReservations, listTaskReservations } from './task-reservations.ts';
import { evaluateResourceAdmission } from './resource-admission.ts';
import { evaluateLaunchAdmissionInTransaction } from './launch-state.ts';
import { createServicePorts as composeServicePorts } from './service-host.ts';
import { validateEventObjectId } from './event-catalog.ts';
import { startBugSyncService } from './bug-sync.ts';
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
    nextReminderId?: () => string;
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
    deliverStartupContextEvent: async intent => {
      if (!options?.sharedDelivery) return false;
      const payload = intent.payload as { to: string; id: string; runIds: readonly string[] };
      const receipt = await options.sharedDelivery({ to: payload.to, text: JSON.stringify({ event: intent.event, contextReviewId: intent.id, runIds: payload.runIds }) }, { kind: 'system' });
      return receipt.accepted;
    },
    now,
    nextReminderId: options?.nextReminderId ?? randomUUID,
    reconcileLaunches: async () => {
      const handle = boundStore();
      const currentBoot = () => readMachineBootIdentity(options?.processScan?.execute);
      const retained = new Set<string>();
      if (listTaskReservations(handle).length) {
        const projects = JSON.parse(await readFile(join(context.orchestratorRoot, 'conf', 'projects.json'), 'utf8'));
        if (projects.version !== 1 || !projects.projects || typeof projects.projects !== 'object' || Array.isArray(projects.projects)) throw new Error('Invalid recovery project configuration');
        const identity = createAssignmentIdentityAdapter(Object.fromEntries(Object.keys(projects.projects).map(project => [project, context.orchestratorRoot])));
        const result = await reconcileTaskReservations({ store: handle, currentBoot, deferAbandonedFinalization: true,
          observe: async process => (await observeProcesses([process], options?.processScan))[0],
          resolveTasks: identity.resolveTasks, newFence: randomUUID });
        for (const lease of result.retained) retained.add(lease.owner.runId);
      }
      const candidates = handle.sessionRepository.transaction(tx => tx.listSessions().filter(session =>
        session.state !== 'finished' && !retained.has(session.runId) && session.launchContext?.wrapper), 'read');
      if (candidates.length) {
        const boot = await currentBoot();
        for (const session of candidates) {
          const wrapper = session.launchContext!.wrapper!;
          const evidence = wrapper.evidence;
          const unknown = (reason: string): never => { throw Object.assign(new Error(`${session.runId}: ${reason}`), { code: 'TASK_LIVENESS_UNKNOWN' }); };
          if (!evidence || evidence.runId !== session.runId || !evidence.machineId || !evidence.bootId || !evidence.command ||
              !Number.isSafeInteger(wrapper.pid) || wrapper.pid <= 0 || !Number.isFinite(Date.parse(wrapper.startedAt)) ||
              !wrapper.runner || !wrapper.runnerSessionId || !wrapper.tmuxSession) unknown('Incomplete report wrapper identity');
          if (evidence.machineId !== boot.machineId) unknown('Report wrapper belongs to another machine');
          if (evidence.bootId !== boot.bootId) continue;
          const observation = (await observeProcesses([wrapper], options?.processScan))[0];
          if (observation.state === 'unknown') unknown(`Report wrapper observation unknown: ${observation.error}`);
          if (observation.state === 'alive') retained.add(session.runId);
        }
      }
      return [...retained];
    },
    observeProcesses: identities => observeProcesses(identities, options?.processScan),
    effectsForObservation: (session, observation) => ({
      pending: observation.state === 'exited' && session.result?.status !== 'succeeded' ? [{
        id: `${session.runId}:agent.failed`, runId: session.runId, event: 'agent.failed',
        payload: { kind: 'agent.failed', id: session.addressId },
      }] : [],
      domain: [],
    }),
    sessionValidation: { verifyMainAuthority: () => false, verifyWorkResult: () => false },
    eventPorts: handle => {
      if (store && store !== handle) throw new Error('Production service state store is already bound');
      const repository = handle.eventRepository;
      if (!repository || typeof repository.transaction !== 'function') throw new Error('StateStore eventRepository transaction is unavailable');
      store = handle;
      options?.onStore?.(handle);
      return {
        transaction: operation => repository.transaction(operation),
        validateId: validateEventObjectId,
      };
    },
    deliverReminder: async reminder => {
      if (!options?.sharedDelivery) return { delivered: false, reason: 'Shared reminder delivery transport is unavailable or unverified' };
      const text = reminder.createdFor === reminder.assignedTo
        ? `Reminder ${reminder.id}: ${reminder.text}`
        : `Reminder ${reminder.id} (created for ${reminder.createdFor}, assigned to ${reminder.assignedTo}): ${reminder.text}`;
      const receipt = await options.sharedDelivery({ to: reminder.assignedTo, text }, { kind: 'system' });
      return receipt.accepted ? { delivered: true } : { delivered: false, reason: receipt.reason };
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
        const running = handle.sessionRepository.transaction(tx => tx.listSessions().filter(session => session.state === 'running' && session.process), 'read');
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
  productionStateContext(context.orchestratorRoot, fileURLToPath(import.meta.url), context.homeDirectory, 'service-store');
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
  let resource: Awaited<ReturnType<typeof productionResourceWait>>;
  let bugSync: Awaited<ReturnType<typeof startBugSyncService>>;
  try {
    const [constants, raf] = await Promise.all(['raf-constants.json', 'raf.json'].map(async name => JSON.parse(await readFile(join(context.orchestratorRoot, 'conf', name), 'utf8'))));
    resource = await productionResourceWait(context, readResourceWaitProtocolOptions({ constants, raf }), () => { if (!resourceStore) throw new Error('Resource state not initialized'); return resourceStore; }, options?.resourceReader);
    bugSync = await startBugSyncService({
      orchestratorRoot: context.orchestratorRoot, homeDirectory: context.homeDirectory, stateDirectory: context.stateDirectory,
      now: dependencies.now, schedule: dependencies.schedule,
      notifier: {
        notify: async notice => {
          if (!options?.sharedDelivery) throw new Error('Shared main delivery transport is unavailable or unverified');
          const text = notice.kind === 'new-bug' ? `[raf] New bug ${notice.bugKey}` : `[raf] New human comment ${notice.commentId} on ${notice.bugKey}`;
          const receipt = await options.sharedDelivery({ to: 'main', text }, { kind: 'system' });
          if (!receipt.accepted) throw new Error(receipt.reason);
        },
      },
    });
  } catch (error) {
    await ports.shutdown();
    throw error;
  }
  return {
    ...ports,
    resourceWait: resource.attach,
    recover: async bootstrap => { await ports.recover(); if (bootstrap?.serviceEpoch) await resource.start(bootstrap.serviceEpoch); },
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
      await resource.stop();
      try { await bugSync?.stop(); } finally { await ports.shutdown(); }
    },
  };
}
