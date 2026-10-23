import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { LaunchQueueEvents, type LaunchQueueIdentity } from './launch-queue-events.ts';
import type { StateStore } from './state-store.ts';
import { validateEventObjectId } from './event-catalog.ts';

export function createStoredLaunchQueueEvents(store: StateStore, identity: LaunchQueueIdentity): LaunchQueueEvents {
  return new LaunchQueueEvents({ identity, nextQueueId: randomUUID,
    transaction: action => store.eventRepository.transaction(action) });
}

export function storedLaunchQueueIdentity(store: StateStore, machineId: string): LaunchQueueIdentity {
  const file = store.startupContextDatabase.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (typeof file !== 'string' || !file) throw new Error('A persisted control state domain is required');
  return { stateDomain: realpathSync(file), machineId };
}

export function validateStoredQueueId(store: StateStore, identity: LaunchQueueIdentity, id: string): boolean {
  if (!validateEventObjectId('resourceQueueId', id)) return false;
  return store.eventRepository.transaction(tx => tx.loadQueue(identity)?.queueId === id);
}
