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
  constructor(_ports: LaunchQueueEventPorts) {
    throw new Error('NotImplemented');
  }

  queueId(): string {
    throw new Error('NotImplemented');
  }

  validateQueueId(_id: string): boolean {
    throw new Error('NotImplemented');
  }

  record(_input: RecordLaunchQueueEntry): LaunchQueueHandle | null {
    throw new Error('NotImplemented');
  }

  transition(_handle: LaunchQueueHandle, _stage: LaunchQueueStage): void {
    throw new Error('NotImplemented');
  }

  confirmReady(_handle: LaunchQueueHandle): void {
    throw new Error('NotImplemented');
  }

  fail(_handle: LaunchQueueHandle, _reason: LaunchQueueFailure): void {
    throw new Error('NotImplemented');
  }
}
