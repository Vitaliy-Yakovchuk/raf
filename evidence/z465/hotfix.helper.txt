import type { AdmissionTier } from './admission-snapshot.ts';
import type { StoredAgentQueueEntry } from './agent-queue-state.ts';
import type { LaunchQueueIdentity } from './launch-queue-events.ts';
import type { StateStore } from './state-store.ts';

export function hasTestRunPredecessor(store: StateStore, identity: LaunchQueueIdentity, tier: AdmissionTier): boolean {
  return store.eventRepository.transaction(tx => {
    const state = tx.loadQueue(identity);
    const agents = store.startupContextDatabase.prepare('SELECT payload FROM agent_launch_queue_entries').all()
      .map(row => JSON.parse(row.payload as string) as StoredAgentQueueEntry)
      .filter(row => row.record.clientIdentity.machineId === identity.machineId && row.record.queueId === state?.queueId);
    const precedes = (agent: StoredAgentQueueEntry) => {
      const queuedTier = agent.record.requestedTier ?? store.sessionRepository.transaction(sessions => {
        const session = sessions.getSession(agent.record.owner.runId);
        return session?.activity ? session.activity.type === 'hotfix' ? 'hotfix' : 'normal' : undefined;
      }, 'read');
      return tier === 'normal' && queuedTier !== 'normal';
    };
    if (agents.some(precedes)) return true;
    return state?.entries.some(entry => {
      const test = state.pendingTests?.find(test => test.handle?.requestId === entry.requestId && test.fence === entry.fence);
      if (test) return tier === 'normal' || test.requestedTier !== 'normal';
      const agent = agents.find(agent => agent.record.requestId === entry.requestId && agent.record.owner.fence === entry.fence);
      return agent ? precedes(agent) : true;
    }) ?? false;
  });
}
