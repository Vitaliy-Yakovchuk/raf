import type { AdmissionTier } from './admission-snapshot.ts';
import type { ResourceWaitCommandResult } from './resource-wait-protocol.ts';
import type { TestRunGroupKey } from './test-runs.ts';

export interface TestRunResourceRoute {
  branchPaths: Readonly<Record<string, string>>;
}

export interface TestRunQueueRecord {
  queueId: string;
  requestId: string;
  testRunId: string;
  fence: string;
}

export interface TestRunQueuePort {
  claimGroup?(testRunId: string, groupKey: TestRunGroupKey): Promise<boolean>;
  releaseGroup?(testRunId: string, groupKey: TestRunGroupKey): Promise<void>;
  hasPending(requestedTier?: AdmissionTier): Promise<boolean>;
  enqueue(input: {
    testRunId: string;
    groupKey: TestRunGroupKey;
    requestedTier: AdmissionTier;
    admission: object | null;
  }): Promise<TestRunQueueRecord>;
  waitForResources(input: {
    record: TestRunQueueRecord;
    level: AdmissionTier;
    workload: 'test';
    requested: import('./resource-admission.ts').ResourceReservation;
    signal?: AbortSignal;
  }): Promise<ResourceWaitCommandResult>;
  transition(record: TestRunQueueRecord, phase: 'waiting' | 'rechecking' | 'starting'): Promise<boolean>;
  started(record: TestRunQueueRecord, processIdentity: string): Promise<boolean>;
  finish(record: TestRunQueueRecord, outcome: 'cancelled' | 'failed', reason: string): Promise<void>;
  writeStderr(line: string): void;
}
