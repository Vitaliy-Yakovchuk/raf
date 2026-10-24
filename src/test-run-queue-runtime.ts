import { randomUUID } from 'node:crypto';
import type { StateStore } from './state-store.ts';
import type { TestRunQueuePort, TestRunQueueRecord } from './test-run-queue.ts';
import type { LaunchQueueState } from './launch-queue-events.ts';
import { createStoredLaunchQueueEvents, storedLaunchQueueIdentity } from './stored-launch-queue-events.ts';
import { observeReservedTestTree, testWrapperIdentity } from './test-run-resource-process.ts';
import { waitForResources } from './resource-wait-command.ts';

export function reconcilePendingTestQueues(store: StateStore): void {
  const queues = store.startupContextDatabase.prepare('SELECT state_domain, machine_id FROM agent_launch_queues').all();
  for (const row of queues) {
    const identity = { stateDomain: row.state_domain as string, machineId: row.machine_id as string };
    const events = createStoredLaunchQueueEvents(store, identity);
    store.eventRepository.transaction(tx => {
      const state = tx.loadQueue(identity)!;
      for (const test of state.pendingTests ?? []) {
        if (observeReservedTestTree(test.ownerIdentity).state !== 'dead') continue;
        const reservation = store.sessionRepository.transaction(sessions => sessions.listReservations().find(candidate =>
          candidate.testRun?.claim.testRunId === test.testRunId && candidate.testRun.ownerIdentity === test.ownerIdentity), 'read');
        const processIdentity = test.processIdentity ?? reservation?.testRun?.claim.processIdentity;
        if (processIdentity) {
          if (observeReservedTestTree(processIdentity).state === 'unknown') continue;
          if (test.handle) events.confirmReady(test.handle);
        } else {
          if (reservation?.testRun?.spawning) continue;
          if (test.handle) events.fail(test.handle, 'client-died');
        }
        const current = tx.loadQueue(identity)!;
        tx.saveQueue(identity, { ...current, pendingTests: current.pendingTests?.filter(candidate =>
          candidate.testRunId !== test.testRunId || candidate.fence !== test.fence) });
      }
    });
  }
}

export function createTestRunQueuePort(store: StateStore, options: {
  root: string; workspace: string; home: string; machineId: string;
  settle(): Promise<void>;
}): TestRunQueuePort {
  const identity = storedLaunchQueueIdentity(store, options.machineId);
  const events = createStoredLaunchQueueEvents(store, identity);
  const ownerIdentity = testWrapperIdentity();
  const transaction = <T>(action: (state: LaunchQueueState, save: (state: LaunchQueueState) => void) => T): T =>
    store.eventRepository.transaction(tx => action(tx.loadQueue(identity)!, state => tx.saveQueue(identity, state)));
  const sameGroup = (a: { project: string; workspace: string; group: string }, b: typeof a) =>
    a.project === b.project && a.workspace === b.workspace && a.group === b.group;
  const owned = (state: LaunchQueueState, record: TestRunQueueRecord) => state.pendingTests?.find(test =>
    test.testRunId === record.testRunId && test.fence === record.fence && test.ownerIdentity === ownerIdentity &&
    test.handle?.requestId === record.requestId && test.handle.queueId === record.queueId);
  return {
    claimGroup: async (testRunId, groupKey) => {
      reconcilePendingTestQueues(store);
      const claimed = transaction((state, save) => {
        if (state.pendingTests?.some(test => sameGroup(test.groupKey, groupKey))) return false;
        save({ ...state, pendingTests: [...state.pendingTests ?? [], { testRunId, fence: randomUUID(), groupKey,
          ownerIdentity, processIdentity: null, handle: null }] });
        return true;
      });
      await options.settle();
      return claimed;
    },
    releaseGroup: async (testRunId, groupKey) => {
      transaction((state, save) => {
        const test = state.pendingTests?.find(test => test.testRunId === testRunId && test.ownerIdentity === ownerIdentity && sameGroup(test.groupKey, groupKey));
        if (test?.handle && state.entries.some(entry => entry.requestId === test.handle!.requestId && entry.fence === test.fence)) throw new Error('Unresolved test launch requires reconciliation');
        save({ ...state, pendingTests: state.pendingTests?.filter(row => row !== test) });
      });
      await options.settle();
    },
    hasPending: async () => transaction(state => state.entries.length > 0 ||
      store.startupContextDatabase.prepare('SELECT 1 FROM agent_launch_queue_entries LIMIT 1').get() !== undefined),
    enqueue: async ({ testRunId, groupKey }) => transaction((state, save) => {
      const test = state.pendingTests?.find(test => test.testRunId === testRunId && test.ownerIdentity === ownerIdentity && sameGroup(test.groupKey, groupKey));
      if (!test) throw new Error('Pending test group fence lost');
      const handle = test.handle ?? events.record({ kind: 'test-run', waited: true, requestId: randomUUID(), fence: test.fence })!;
      const current = store.eventRepository.transaction(tx => tx.loadQueue(identity)!);
      save({ ...current, pendingTests: current.pendingTests!.map(row => row === test || row.testRunId === testRunId && row.fence === test.fence ? { ...row, handle } : row) });
      return { queueId: handle.queueId, requestId: handle.requestId, testRunId, fence: test.fence };
    }),
    waitForResources: ({ level, workload, signal }) => waitForResources({ orchestratorRoot: options.root,
      homeDirectory: options.home, developmentDirectory: options.workspace, level, workload, signal }),
    transition: async (record, phase) => transaction(state => {
      const test = owned(state, record);
      if (!test?.handle || !state.entries.some(entry => entry.requestId === record.requestId && entry.fence === record.fence)) return false;
      events.transition(test.handle, phase);
      return true;
    }),
    started: async (record, processIdentity) => {
      const confirmed = transaction((state, save) => {
        const test = owned(state, record);
        if (!test?.handle || test.processIdentity !== processIdentity || observeReservedTestTree(processIdentity).state === 'unknown') return false;
        save({ ...state, pendingTests: state.pendingTests!.map(row => row.testRunId === test.testRunId && row.fence === test.fence ? { ...row, processIdentity } : row) });
        events.confirmReady(test.handle);
        return true;
      });
      await options.settle();
      return confirmed;
    },
    finish: async (record, outcome) => {
      transaction(state => {
        const test = owned(state, record);
        if (!test?.handle) return;
        const reservation = store.sessionRepository.transaction(tx => tx.listReservations().find(row =>
          row.testRun?.claim.testRunId === test.testRunId && row.testRun.ownerIdentity === ownerIdentity), 'read');
        const identity = test.processIdentity ?? reservation?.testRun?.claim.processIdentity;
        if (identity) {
          if (observeReservedTestTree(identity).state !== 'unknown') events.confirmReady(test.handle);
        } else if (!reservation?.testRun?.spawning) events.fail(test.handle, outcome === 'cancelled' ? 'cancelled' : 'launch-failed');
      });
      await options.settle();
    },
    writeStderr: line => { process.stderr.write(line); },
  };
}
