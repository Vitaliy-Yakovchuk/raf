import { validateEventObjectId } from './event-catalog.ts';
import type { EventTransaction, PendingEvent } from './event-registry.ts';

export interface LaunchQueueIdentity {
  readonly stateDomain: string;
  readonly machineId: string;
}

export interface LaunchQueueHandle {
  readonly queueId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly fence: string;
}

export type LaunchQueueStage = 'waiting' | 'rechecking' | 'starting';
export type LaunchQueueFailure = 'cancelled' | 'client-died' | 'launch-failed';

export interface LaunchQueueEntry extends LaunchQueueHandle {
  readonly stage: LaunchQueueStage;
}

export interface LaunchQueueState {
  readonly queueId: string;
  readonly generation: number;
  readonly entries: readonly LaunchQueueEntry[];
  readonly hadFailure: boolean;
}

export interface LaunchQueueDrainedFact extends PendingEvent {
  readonly data: {
    readonly queueId: string;
    readonly generation: number;
  };
}

export interface LaunchQueueTransaction extends EventTransaction {
  loadQueue(identity: LaunchQueueIdentity): LaunchQueueState | undefined;
  saveQueue(identity: LaunchQueueIdentity, state: LaunchQueueState): void;
}

export interface LaunchQueueEventPorts {
  readonly identity: LaunchQueueIdentity;
  nextQueueId(): string;
  transaction<T>(operation: (transaction: LaunchQueueTransaction) => T): T;
}

export interface RecordLaunchQueueEntry {
  readonly kind: 'agent-run' | 'resource-wait' | 'test-run';
  readonly waited: boolean;
  readonly requestId: string;
  readonly fence: string;
}

export class LaunchQueueEvents {
  private readonly ports: LaunchQueueEventPorts;
  private readonly identity: LaunchQueueIdentity;

  constructor(ports: LaunchQueueEventPorts) {
    this.ports = ports;
    this.identity = { ...ports.identity };
    if (!this.identity.stateDomain || !this.identity.machineId) throw new Error('Launch queue identity is required');
    ports.transaction(tx => {
      if (tx.loadQueue(this.identity)) return;
      const queueId = ports.nextQueueId();
      if (!validateEventObjectId('resourceQueueId', queueId)) throw new Error('Invalid resourceQueueId');
      tx.saveQueue(this.identity, { queueId, generation: 0, entries: [], hadFailure: false });
    });
  }

  private state(tx: LaunchQueueTransaction): LaunchQueueState {
    const state = tx.loadQueue(this.identity);
    if (!state) throw new Error('Launch queue state is missing');
    return state;
  }

  queueId(): string {
    return this.ports.transaction(tx => this.state(tx).queueId);
  }

  validateQueueId(id: string): boolean {
    return validateEventObjectId('resourceQueueId', id) && id === this.queueId();
  }

  record(input: RecordLaunchQueueEntry): LaunchQueueHandle | null {
    if (input.kind !== 'agent-run' || !input.waited) return null;
    if (!input.requestId || !input.fence) throw new Error('A fenced launch request is required');
    return this.ports.transaction(tx => {
      const state = this.state(tx);
      const existing = state.entries.find(entry => entry.requestId === input.requestId);
      if (existing) {
        if (existing.fence !== input.fence) throw new Error('Launch request fence changed');
        return this.handle(existing);
      }
      const generation = state.entries.length ? state.generation : state.generation + 1;
      if (!Number.isSafeInteger(generation)) throw new Error('Launch queue generation exhausted');
      const handle = { queueId: state.queueId, generation, requestId: input.requestId, fence: input.fence };
      tx.saveQueue(this.identity, { ...state, generation, hadFailure: state.entries.length ? state.hadFailure : false,
        entries: [...state.entries, { ...handle, stage: 'waiting' }] });
      return handle;
    });
  }

  private handle(entry: LaunchQueueEntry): LaunchQueueHandle {
    return { queueId: entry.queueId, generation: entry.generation, requestId: entry.requestId, fence: entry.fence };
  }

  private matches(entry: LaunchQueueEntry, handle: LaunchQueueHandle): boolean {
    return entry.queueId === handle.queueId && entry.generation === handle.generation &&
      entry.requestId === handle.requestId && entry.fence === handle.fence;
  }

  transition(handle: LaunchQueueHandle, stage: LaunchQueueStage): void {
    this.ports.transaction(tx => {
      const state = this.state(tx);
      if (!state.entries.some(entry => this.matches(entry, handle))) return;
      tx.saveQueue(this.identity, { ...state, entries: state.entries.map(entry => this.matches(entry, handle) ? { ...entry, stage } : entry) });
    });
  }

  confirmReady(handle: LaunchQueueHandle): void {
    this.finish(handle, false);
  }

  fail(handle: LaunchQueueHandle, _reason: LaunchQueueFailure): void {
    this.finish(handle, true);
  }

  private finish(handle: LaunchQueueHandle, failed: boolean): void {
    this.ports.transaction(tx => {
      const state = this.state(tx);
      if (!state.entries.some(entry => this.matches(entry, handle))) return;
      const entries = state.entries.filter(entry => !this.matches(entry, handle));
      const hadFailure = state.hadFailure || failed;
      if (!entries.length && !hadFailure) {
        const fact: LaunchQueueDrainedFact = {
          key: JSON.stringify(['launch-queue.drained', state.queueId, state.generation]),
          event: { kind: 'launch-queue.drained', id: state.queueId },
          data: { queueId: state.queueId, generation: state.generation },
        };
        tx.savePending(fact);
      }
      tx.saveQueue(this.identity, { ...state, entries, hadFailure: entries.length ? hadFailure : false });
    });
  }
}
