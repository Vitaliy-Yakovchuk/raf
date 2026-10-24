import { RafCostRuntime, rafCostBoundary, measureRafCost } from './raf-cost-runtime.ts';
import { runtimeResourceUsage } from './resource-usage-runtime.ts';
import { productionStateContext, stateFailure } from './state-migration-guard.ts';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { openStateStore } from './state-store.ts';
import { createSessionState, closeSessionInTransaction } from './session-state.ts';
import { finalizeStartupContextRun, cleanupStartupContextCompleted } from './startup-context-lifecycle.ts';
import { startupContextRuntimeFiles, startupContextAcceptedReport } from './startup-context-runtime.ts';
import { ReminderService } from './reminders.ts';
import { createEventRegistry } from './event-registry.ts';
import { createResourceWaitQueue } from './resource-wait.ts';
import type { ServiceEntryContext, ServicePorts } from './service-entry.ts';
import type { StateStore } from './state-store.ts';
import type { ProcessIdentity, ProcessObservation, SessionRecord, SessionStateDependencies, TransitionEffects, PendingIntent } from './session-state.ts';
import type { Reminder } from './reminders.ts';
import type { EventRegistryPorts } from './event-registry.ts';
import type { ResourceWaitDependencies } from './resource-wait.ts';
import type { ReminderSessionEffect } from './reminder-repository.ts';

export type ServiceHostDependencies = {
  deliverStartupContextEvent?: (intent: PendingIntent) => Promise<boolean>;
  disableLegacyResourceWait?: boolean;
  preserveSessionState?: boolean;
  now: () => number;
  reconcileLaunches?: () => Promise<readonly string[]>;
  nextReminderId: () => string;
  observeProcesses: (identities: readonly ProcessIdentity[]) => Promise<ProcessObservation[]>;
  effectsForObservation: (session: SessionRecord, observation: ProcessObservation) => TransitionEffects;
  sessionValidation: Pick<SessionStateDependencies, 'verifyMainAuthority' | 'verifyWorkResult'>;
  eventPorts: (store: StateStore) => EventRegistryPorts;
  deliverReminder: (reminder: Reminder) => Promise<{ delivered: boolean; reason?: string }>;
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
  const required = [dependencies.now, dependencies.nextReminderId, dependencies.observeProcesses, dependencies.effectsForObservation,
    dependencies.sessionValidation?.verifyMainAuthority, dependencies.sessionValidation?.verifyWorkResult, dependencies.eventPorts,
    dependencies.deliverReminder, dependencies.schedule, dependencies.resourceWait?.readSnapshot, dependencies.resourceWait?.isClientAlive,
    dependencies.resourceWait?.watchResources, dependencies.resourceWait?.schedule, dependencies.resourceWait?.loadLastGrant, dependencies.resourceWait?.saveLastGrant];
  if (required.some(value => typeof value !== 'function')) throw new Error('Service host dependencies are incomplete');
  for (const [name, path] of Object.entries(context)) if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`Service host requires absolute ${name}`);
  const [settings, catalog] = await Promise.all(['raf.json', 'raf-constants.json'].map(async name => JSON.parse(await readFile(join(context.orchestratorRoot, 'conf', name), 'utf8'))));
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
    const sessions = createSessionState({ repository: store.sessionRepository, ...dependencies.sessionValidation });
    const reminders = new ReminderService({ repository: store.reminderRepository, now: () => new Date(clock()).toISOString(), nextId: dependencies.nextReminderId, approvedEventKinds: catalog.events.map((event: { id: string }) => event.id) });
    const eventPorts = dependencies.eventPorts(store);
    if (!eventPorts || typeof eventPorts.transaction !== 'function' || typeof eventPorts.validateId !== 'function') throw new Error('Service event ports are incomplete');
    const events = createEventRegistry(catalog, eventPorts);
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
    const delivered = new Map<string, string>();
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
      const now = clock();
      const deadlines = reminders.list().filter(reminder => reminder.state === 'pending').map(reminder => Date.parse(reminder.at)).filter(at => Number.isFinite(at) && at > now);
      const at = Math.min(now + cadence, ...deadlines);
      cancelWake = dependencies.schedule(at, async () => { cancelWake = undefined; await refresh(); });
    };
    const reconcile = async () => {
      const retained = new Set(await dependencies.reconcileLaunches?.() ?? []);
      const candidates = sessions.listReconciliationCandidates().filter(session => !retained.has(session.runId) && session.state === 'running' && session.process);
      const observations = await dependencies.observeProcesses(candidates.map(session => session.process!));
      if (!Array.isArray(observations) || observations.length !== candidates.length) throw new Error('Process observation result does not match service candidates');
      for (let index = 0; index < candidates.length; index++) {
        const session = candidates[index];
        const observation = observations[index];
        if (!observation || !['alive', 'exited', 'unknown'].includes(observation.state)) throw new Error('Invalid service process observation');
        sessions.commitObservation(session.runId, session.revision, observation, observation.state === 'unknown' || session.launchContext && observation.state === 'exited' ? { pending: [], domain: [] } : dependencies.effectsForObservation(session, observation));
      }
      for (const session of sessions.listReconciliationCandidates().filter(candidate => !retained.has(candidate.runId) && candidate.state === 'exited')) {
        if (session.launchContext) {
          const get = (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
          await finalizeStartupContextRun(session.runId, {
            ...startupContextRuntimeFiles(join(context.homeDirectory, '.raf', 'tmp'), context.homeDirectory), database: store.startupContextDatabase,
            flowPath: join(context.orchestratorRoot, 'conf', 'flow.json'), mainAddress: 'main', now: () => new Date(clock()).toISOString(),
            sessions: {
              get, cleanupCompleted: at => sessions.cleanupCompleted(at),
              acceptReport: async row => {
                const report = await startupContextAcceptedReport(row, join(context.homeDirectory, '.raf', 'tmp'), () => new Date(clock()).toISOString());
                store.sessionRepository.transaction(tx => {
                  const current = tx.getSession(row.runId)!;
                  if (!current.result) tx.putSession({ ...current, revision: current.revision + 1, result: { status: report.status, response: report.report?.answer ?? '', proof: { context: report.report?.context } } });
                  tx.putPending({ id: `${row.runId}:${report.event}`, runId: row.runId, event: report.event, payload: { kind: report.event, id: row.addressId } });
                });
                return report;
              },
              finish: async (row, at, pending) => {
                store.sessionRepository.transaction(tx => {
                  closeSessionInTransaction(tx, tx.getSession(row.runId)!, at);
                  tx.applyEffects([{ id: `${row.runId}:reminders:session-ended`, domain: 'reminders', payload: { operation: 'session-ended', runId: row.runId, at, end: { address: row.addressId, confirmedSucceeded: row.result?.status === 'succeeded', crashed: true } } }]);
                  for (const intent of [...pending, { id: `${row.runId}:agent.closed`, runId: row.runId, event: 'agent.closed', payload: { kind: 'agent.closed', id: row.addressId } }]) tx.putPending(intent);
                });
                return get(row.runId)!;
              },
            },
          });
          continue;
        }
        const at = new Date(clock()).toISOString();
        const effect: ReminderSessionEffect = {
          id: `${session.runId}:reminders:session-ended`, domain: 'reminders',
          payload: { operation: 'session-ended', runId: session.runId, at,
            end: { address: session.addressId, confirmedSucceeded: session.result?.status === 'succeeded', crashed: true } },
        };
        sessions.finalizeSession(session.runId, session.revision, at, {
          domain: [effect], pending: [{ id: `${session.runId}:agent.closed`, runId: session.runId,
            event: 'agent.closed', payload: { kind: 'agent.closed', id: session.addressId } }],
        });
      }
    };
    const cycle = async () => {
      try {
        runtimeResourceUsage(store.startupContextDatabase, context.orchestratorRoot).tracker.hostTick(clock());
        if (!dependencies.preserveSessionState) {
          await measureRafCost('reconciliation', reconcile);
          cleanupStartupContextCompleted(new Date(clock()).toISOString(), { database: store.startupContextDatabase, flowPath: join(context.orchestratorRoot, 'conf', 'flow.json'), sessions });
        }
        if (closed) return;
        for (const intent of sessions.listPending().filter(row => row.event === 'context-review.due' && !(row.payload as any).mainDelivered)) {
          try {
            if (await dependencies.deliverStartupContextEvent?.(intent)) store.sessionRepository.transaction(tx => {
              tx.deletePending(intent.id);
              tx.putPending({ ...intent, payload: { ...(intent.payload as object), kind: intent.event, id: intent.id, mainDelivered: true } });
            });
          } catch {}
        }
        reminders.activateDue();
        events.dispatch();
        reminders.pruneClosed();
        const active = reminders.list().filter(reminder => reminder.state === 'active');
        const activeIds = new Set(active.map(reminder => reminder.id));
        for (const id of delivered.keys()) if (!activeIds.has(id)) delivered.delete(id);
        for (const reminder of active) {
          if (closed) return;
          const key = JSON.stringify([reminder.assignedTo, reminder.text, reminder.at]);
          if (delivered.get(reminder.id) === key) continue;
          const receipt = await dependencies.deliverReminder(reminder);
          if (receipt?.delivered === true) delivered.set(reminder.id, key);
        }
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
          const result = await resourceQueue.enqueue({ clientId: client.clientId, level: input.level, signal: client.signal }).result;
          return result;
        }
        return serial(() => measureRafCost('handler', async () => {
          if (client.signal.aborted) throw new Error('Service request cancelled');
          const input = payload(request.payload);
          let result: unknown;
          switch (request.operation) {
            case 'reminder.add': result = reminders.add(input as Parameters<ReminderService['add']>[0]); break;
            case 'reminder.list': return reminders.list(input.to);
            case 'reminder.update': result = reminders.update(input.id, input.patch ?? input); break;
            case 'reminder.activate': result = reminders.activate(input.id); break;
            case 'reminder.close': result = reminders.close(input.id, input.reason); break;
            case 'reminder.reassign': result = reminders.reassign(input.id, input.to); break;
            case 'reminder.close-all': result = reminders.closeAll(input.createdFor, input.reason); break;
            case 'event.emit': events.enqueue(input as Parameters<typeof events.enqueue>[0]); result = events.dispatch(); break;
            default: throw new Error(`Unsupported service operation: ${request.operation}`);
          }
          await cycle();
          return result;
        }));
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
