import { randomUUID } from 'node:crypto';
import { createAppRuntime, type RuntimeConfiguration, type RuntimeContext, type RuntimeServices } from './app-runtime.ts';
import { readAssignmentTasks } from './assignment.ts';
import { handoffModelRun, type ModelHandoffResult } from './model-routing-handoff.ts';
import type { StateStore } from './state-store.ts';
import { permitsModelHandoff, type ProcessIdentity, type ProcessObservation, type SessionRecord } from './session-state.ts';
import { listTaskReservations } from './task-reservations.ts';

const draining = new WeakSet<StateStore>();

export async function runProductionModelHandoffs(input: {
  store: StateStore;
  context: RuntimeContext;
  loadConfiguration(): Promise<RuntimeConfiguration>;
  createServices(configuration: RuntimeConfiguration): Promise<RuntimeServices>;
  inspect(identity: ProcessIdentity): Promise<ProcessObservation>;
  assignmentPorts: import('./assignment.ts').AssignmentPorts;
}): Promise<readonly ModelHandoffResult[]> {
  const { store, context } = input;
  if (draining.has(store)) return [];
  draining.add(store);
  try {
    const pending = store.sessionRepository.transaction(tx => tx.listSessions().filter(row => row.state === 'finished' && row.modelHandoff && !row.successorRunId), 'read');
    const results: ModelHandoffResult[] = [];
    for (const predecessor of pending) {
      const saved = predecessor.modelHandoff!;
      if (!permitsModelHandoff({ ...predecessor, launchContext: saved.launchContext }) || predecessor.result?.status === 'succeeded') {
        store.sessionRepository.transaction(tx => {
          const row = tx.getSession(predecessor.runId);
          if (row?.state === 'finished' && row.modelHandoff && !row.successorRunId) tx.putSession({ ...row, revision: row.revision + 1, modelHandoff: undefined });
        });
        continue;
      }
      const session: SessionRecord = { ...predecessor, activity: saved.activity, launchContext: saved.launchContext };
      const parameters = saved.launchContext.modelRouting!.parameters;
      let result: ModelHandoffResult;
      let runtime: ReturnType<typeof createAppRuntime> | undefined;
      try {
      const configuration = await input.loadConfiguration();
      const api = await input.createServices(configuration);
      runtime = createAppRuntime(context, {
        now: Date.now, loadConfiguration: async () => configuration,
        openStore: async () => ({ ...store, close() {} }), createServices: async () => api,
        nextRunIdentity: () => ({ runId: randomUUID(), tmuxSession: randomUUID() }),
      });
      const current = () => store.sessionRepository.transaction(tx => tx.getSession(predecessor.runId), 'read');
      result = await handoffModelRun({ session, signal: { runId: session.runId, observation: saved.launchContext.modelRouting!.cause ?? { status: 'exited', exitCode: null } },
        ownerAction: predecessor.ownerAction ?? 'continue', startupCleanup: { retrySafe: true, pending: [] } }, {
        currentSession: async address => store.sessionRepository.transaction(tx => {
          const active = (tx.listActiveSessions?.() ?? tx.listSessions()).find(row => row.addressId === address && row.state !== 'finished');
          return active ?? tx.getSession(predecessor.runId) ?? null;
        }, 'read'),
        inspect: async row => row.process ? input.inspect(row.process) : { state: 'exited', observedAt: row.finishedAt!, exitCode: null, evidence: 'Existing launch finalization confirmed startup cleanup' },
        checkFinalReport: async () => {
          const row = current();
          return { runId: predecessor.runId, status: row?.result?.status === 'succeeded' ? 'succeeded' : row?.state === 'finished' ? 'failed' : 'pending', reason: row?.result?.response || row?.abortReason || 'Final report check and closure performed by session-recovery' };
        },
        finalize: async () => {
          const row = current();
          const claimsReleased = !listTaskReservations(store).some(set => set.lease.owner.runId === predecessor.runId);
          return { finalized: row?.state === 'finished' && !row.successorRunId, claimsReleased, reason: 'Existing session-recovery closure and task claims must be complete' };
        },
        readCurrentWork: async () => {
          const changes = [];
          for (const change of saved.launchContext.assignment.changes) {
            const tasks = await readAssignmentTasks(saved.launchContext.assignment.root, change.id, input.assignmentPorts);
            const items = [];
            for (const item of change.items) {
              const task = tasks.find(task => task.id === item.id);
              if (!task || task.description !== item.description) return { status: 'changed', reason: `OpenSpec source changed: ${change.id}:${item.id}` };
              if (!task.done) items.push(item);
            }
            if (items.length) changes.push({ ...change, items });
          }
          return { status: 'ready', assignment: { ...saved.launchContext.assignment, changes }, request: { complexity: parameters.complexity, role: parameters.type },
            evidence: [saved.launchContext.reportPath, predecessor.abortReason ?? '', predecessor.result?.response ?? '', JSON.stringify(predecessor.result?.proof ?? null)].filter(Boolean) };
        },
        readRouting: async () => ({ catalog: configuration.models, snapshot: await api.routingSnapshot() }),
        launchNew: async handoff => {
          const launched = await runtime!.launchHandoff({ ...parameters, features: handoff.assignment.changes.map(change => change.id), tasks: handoff.assignment.changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)) }, handoff) as { runId?: string };
          const row = launched.runId ? store.sessionRepository.transaction(tx => tx.getSession(launched.runId!), 'read') : undefined;
          return row ? { status: 'started', session: row } : { status: 'blocked', reason: 'New agent-run did not confirm a durable session' };
        },
      });
      } catch (error) {
        result = { status: 'waiting', predecessorRunId: predecessor.runId, reason: error instanceof Error ? error.message : String(error) };
      } finally { await runtime?.close(); }
      store.sessionRepository.transaction(tx => {
        const row = tx.getSession(predecessor.runId);
        if (!row?.modelHandoff || row.successorRunId) return;
        tx.putSession({ ...row, revision: row.revision + 1, modelHandoff: result.status === 'complete' ? undefined : { ...row.modelHandoff, reason: result.reason } });
      });
      results.push(result);
    }
    return results;
  } finally { draining.delete(store); }
}
