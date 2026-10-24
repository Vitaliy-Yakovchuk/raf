import { validateEventObjectId } from './event-catalog.ts';
import type { EventTransaction, PendingEvent } from './event-registry.ts';
import { commandFailure } from './cli-contract.ts';

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

export interface LaunchQueueTotals {
  readonly started: number;
  readonly cancelled: number;
  readonly failed: number;
}

export interface LaunchQueueState extends LaunchQueueTotals {
  readonly queueId: string;
  readonly generation: number;
  readonly entries: readonly LaunchQueueEntry[];
}

export interface LaunchQueueDrainedFact extends PendingEvent {
  readonly data: LaunchQueueTotals & {
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
      if (tx.loadQueue(this.identity)) { this.state(tx); return; }
      const queueId = ports.nextQueueId();
      if (!validateEventObjectId('resourceQueueId', queueId)) throw new Error('Invalid resourceQueueId');
      tx.saveQueue(this.identity, { queueId, generation: 0, entries: [], started: 0, cancelled: 0, failed: 0 });
    });
  }

  private state(tx: LaunchQueueTransaction): LaunchQueueState {
    const state = tx.loadQueue(this.identity);
    if (!state) throw new Error('Launch queue state is missing');
    const incompatible = () => commandFailure({ code: 'STATE_MIGRATION_REQUIRED', message: 'Launch queue totals are unavailable or invalid',
      reason: 'Legacy active generations and pending facts cannot be reconstructed from hadFailure', stage: 'state-preflight',
      source: 'launch-queue-events', sourceCode: null, received: null, expected: 'Exact started/cancelled/failed totals',
      found: null, completed: [], pending: ['launch queue format transfer'], retrySafe: false,
      remediation: ['Let the previous raf version finish its active launch generation and process pending facts before transferring the new version; preserve the existing state.'] });
    for (const fact of tx.listPending()) {
      if (fact.event.kind !== 'launch-queue.drained' || fact.event.id !== state.queueId) continue;
      if (!this.validTotals(fact.data) || this.total(fact.data) === 0) throw incompatible();
    }
    if ([state.started, state.cancelled, state.failed].every(value => value === undefined) && !state.entries.length) {
      const migrated: LaunchQueueState = { queueId: state.queueId, generation: state.generation, entries: [], started: 0, cancelled: 0, failed: 0 };
      tx.saveQueue(this.identity, migrated);
      return migrated;
    }
    if (!this.validTotals(state)) throw incompatible();
    return state;
  }

  private total(totals: LaunchQueueTotals): number {
    return totals.started + totals.cancelled + totals.failed;
  }

  private validTotals(value: unknown): value is LaunchQueueTotals {
    if (!value || typeof value !== 'object') return false;
    const totals = value as LaunchQueueTotals;
    return [totals.started, totals.cancelled, totals.failed].every(count => Number.isSafeInteger(count) && count >= 0) &&
      Number.isSafeInteger(this.total(totals));
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
      const totals = state.entries.length ? { started: state.started, cancelled: state.cancelled, failed: state.failed } : { started: 0, cancelled: 0, failed: 0 };
      tx.saveQueue(this.identity, { ...state, generation, ...totals,
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
    this.finish(handle, 'started');
  }

  fail(handle: LaunchQueueHandle, reason: LaunchQueueFailure): void {
    this.finish(handle, reason === 'cancelled' ? 'cancelled' : 'failed');
  }

  private finish(handle: LaunchQueueHandle, outcome: keyof LaunchQueueTotals): void {
    this.ports.transaction(tx => {
      const state = this.state(tx);
      if (!state.entries.some(entry => this.matches(entry, handle))) return;
      const entries = state.entries.filter(entry => !this.matches(entry, handle));
      const totals = { started: state.started, cancelled: state.cancelled, failed: state.failed };
      totals[outcome]++;
      if (!this.validTotals(totals)) throw new Error('Launch queue totals exhausted');
      if (!entries.length) {
        const fact: LaunchQueueDrainedFact = {
          key: JSON.stringify(['launch-queue.drained', state.queueId, state.generation]),
          event: { kind: 'launch-queue.drained', id: state.queueId },
          data: { queueId: state.queueId, generation: state.generation, ...totals },
        };
        tx.savePending(fact);
      }
      tx.saveQueue(this.identity, { ...state, entries, ...totals });
    });
  }
}
