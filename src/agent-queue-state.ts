import type { StateStore } from './state-store.ts';
import type { AgentQueueRecord, AgentQueueValidation } from './agent-run-queue.ts';
import type { ReservedTaskSnapshot } from './task-reservations.ts';
import type { SessionTransaction } from './session-state.ts';
import { createStoredLaunchQueueEvents } from './stored-launch-queue-events.ts';
import { stateFailure } from './state-migration-guard.ts';
import type { LaunchQueueFailure } from './launch-queue-events.ts';

export interface StoredAgentQueueEntry {
  record: AgentQueueRecord;
  phase: 'waiting' | 'rechecking' | 'starting';
  tasks: readonly ReservedTaskSnapshot[];
  fingerprint: string;
  ready?: boolean;
  terminalReason?: LaunchQueueFailure;
  delegatedTasks?: readonly ReservedTaskSnapshot[];
}

export function createAgentQueueState(store: StateStore) {
  const database = store.startupContextDatabase;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_launch_queue_entries'").get()) throw stateFailure('STATE_MIGRATION_REQUIRED', 'Agent queue requires explicit state schema migration to 14');
  const list = (): StoredAgentQueueEntry[] => database.prepare('SELECT payload FROM agent_launch_queue_entries').all()
    .map(row => JSON.parse(row.payload as string));
  const get = (record: AgentQueueRecord) => list().find(entry => entry.record.requestId === record.requestId &&
    entry.record.queueId === record.queueId && entry.record.owner.runId === record.owner.runId && entry.record.owner.fence === record.owner.fence);
  const events = (record: AgentQueueRecord) => {
    const row = database.prepare('SELECT state_domain, machine_id FROM agent_launch_queues WHERE queue_id=?').get(record.queueId);
    if (!row || row.machine_id !== record.clientIdentity.machineId) throw new Error('Launch queue identity mismatch');
    return createStoredLaunchQueueEvents(store, { stateDomain: row.state_domain as string, machineId: row.machine_id as string });
  };
  const save = (entry: StoredAgentQueueEntry) => store.taskReservationRepository.transaction(() => {
    const existing = get(entry.record);
    let handle = existing?.record.eventHandle ?? entry.record.eventHandle;
    if (entry.phase === 'waiting' && !entry.ready) handle = events(entry.record).record({ kind: 'agent-run', waited: true,
      requestId: entry.record.requestId, fence: entry.record.owner.fence });
    entry.record.eventHandle = handle;
    if (handle) events(entry.record).transition(handle, entry.phase);
    database.prepare(`INSERT INTO agent_launch_queue_entries(request_id, run_id, agent_id, payload)
      VALUES (?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload`).run(
        entry.record.requestId, entry.record.owner.runId, entry.record.agentId, JSON.stringify(entry));
  });
  const remove = (record: AgentQueueRecord, reason: LaunchQueueFailure = 'launch-failed') => store.taskReservationRepository.transaction(() => {
    const entry = get(record);
    if (!entry) return false;
    if (!entry.ready && entry.record.eventHandle) events(entry.record).fail(entry.record.eventHandle, entry.terminalReason ?? reason);
    database.prepare('DELETE FROM agent_launch_queue_entries WHERE request_id=? AND run_id=?').run(record.requestId, record.owner.runId);
    return true;
  });
  const sameTask = (left: ReservedTaskSnapshot, right: ReservedTaskSnapshot) => left.key.project === right.key.project &&
    left.changeInstance === right.changeInstance && left.key.taskId === right.key.taskId;
  return {
    transaction: <T>(action: (tx: Parameters<Parameters<StateStore['taskReservationRepository']['transaction']>[0]>[0]) => T): T => store.taskReservationRepository.transaction(action),
    list, get, save, remove,
    hasPendingTests(machineId: string): boolean {
      return store.eventRepository.transaction(tx => {
        const queues = database.prepare('SELECT state_domain FROM agent_launch_queues WHERE machine_id=?').all(machineId);
        return queues.some(row => {
          const state = tx.loadQueue({ stateDomain: row.state_domain as string, machineId });
          return state?.pendingTests?.some(test => test.handle && state.entries.some(entry =>
            entry.requestId === test.handle!.requestId && entry.fence === test.fence));
        });
      });
    },
    confirmReady(tx: Parameters<Parameters<StateStore['taskReservationRepository']['transaction']>[0]>[0], record: AgentQueueRecord): boolean {
      const entry = get(record);
      const session = tx.getSession(record.owner.runId);
      if (!entry || entry.phase !== 'starting' || session?.state !== 'running') return false;
      if (entry.ready) return true;
      if (record.coordinator) {
        const sets = tx.listTaskReservations();
        const parent = sets.find(set => set.lease.owner.runId === record.coordinator!.runId && set.lease.owner.fence === record.coordinator!.fence);
        const child = sets.find(set => set.lease.owner.runId === record.owner.runId);
        if (!parent || !child || child.stage !== 'running' || tx.getSession(parent.lease.owner.runId)?.state !== 'running') throw new Error('COORDINATOR_FENCE_LOST');
        const delegated = parent.tasks.filter(task => entry.tasks.some(candidate => sameTask(task, candidate)));
        if (entry.delegatedTasks?.some(task => !delegated.some(candidate => sameTask(task, candidate) && task.fingerprint === candidate.fingerprint))) throw new Error('COORDINATOR_ASSIGNMENT_CHANGED');
        if (delegated.some(task => !entry.tasks.some(candidate => sameTask(task, candidate) && candidate.fingerprint === task.fingerprint))) throw new Error('QUEUE_ASSIGNMENT_CHANGED');
        tx.putTaskReservation({ ...parent, tasks: parent.tasks.filter(task => !entry.tasks.some(candidate => sameTask(task, candidate))), lease: { owner: parent.lease.owner, revision: parent.lease.revision + 1 } });
        tx.putTaskReservation({ ...child, tasks: entry.tasks, lease: { owner: child.lease.owner, revision: child.lease.revision + 1 } });
      }
      if (entry.record.eventHandle) events(entry.record).confirmReady(entry.record.eventHandle);
      save({ ...entry, ready: true });
      return true;
    },
    queueId(stateDomain: string, machineId: string): string {
      return createStoredLaunchQueueEvents(store, { stateDomain, machineId }).queueId();
    },
    assertClaim(tx: SessionTransaction & { listTaskReservations(): import('./task-reservations.ts').TaskReservationSet[] }, entry: StoredAgentQueueEntry, validation: AgentQueueValidation): void {
      const own = get(entry.record);
      if (own && (own.fingerprint !== validation.fingerprint || own.tasks.length !== entry.tasks.length ||
          own.tasks.some(task => !entry.tasks.some(candidate => sameTask(task, candidate) && task.fingerprint === candidate.fingerprint)))) throw new Error('QUEUE_ASSIGNMENT_CHANGED');
      if (tx.listSessions().some(session => session.state !== 'finished' && session.runId !== entry.record.owner.runId && session.addressId === entry.record.agentId)) throw new Error('ADDRESS_IN_USE');
      for (const other of list()) {
        if (other.record.owner.runId === entry.record.owner.runId && other.record.owner.fence === entry.record.owner.fence) continue;
        if (other.record.agentId === entry.record.agentId) throw new Error('ADDRESS_IN_USE');
        if (other.tasks.some(task => entry.tasks.some(candidate => sameTask(task, candidate)))) throw new Error('TASK_RESERVED');
      }
      for (const reservation of tx.listTaskReservations()) {
        if (reservation.lease.owner.runId === entry.record.owner.runId) continue;
        if (!reservation.tasks.some(task => entry.tasks.some(candidate => sameTask(task, candidate)))) continue;
        const coordinator = entry.record.coordinator;
        if (!coordinator || coordinator.runId !== reservation.lease.owner.runId || coordinator.fence !== reservation.lease.owner.fence ||
            tx.getSession(coordinator.runId)?.state !== 'running' || tx.getSession(coordinator.runId)?.activity?.type !== 'coordinator') throw new Error('TASK_RESERVED');
      }
      if (entry.record.coordinator) {
        const parent = tx.listTaskReservations().find(set => set.lease.owner.runId === entry.record.coordinator!.runId);
        if (!parent || parent.lease.owner.fence !== entry.record.coordinator.fence || tx.getSession(parent.lease.owner.runId)?.state !== 'running') throw new Error('COORDINATOR_FENCE_LOST');
        const delegated = parent.tasks.filter(task => entry.tasks.some(candidate => sameTask(task, candidate)));
        if (entry.delegatedTasks?.some(task => !delegated.some(candidate => sameTask(task, candidate) && task.fingerprint === candidate.fingerprint))) throw new Error('COORDINATOR_ASSIGNMENT_CHANGED');
        entry.delegatedTasks ??= delegated;
      }
    },
  };
}
