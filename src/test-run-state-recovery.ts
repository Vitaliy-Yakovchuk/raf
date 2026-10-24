import type { DiagnosticLimits } from './test-run-diagnostics.ts';
import type { TestRunGroup, TestRunGroupKey, TestRunResult, TestRunTransaction } from './test-runs.ts';

export type StateAccessFailure = {
  store: 'control' | 'unit';
  operation: 'open';
  path: string;
  errorCode: string;
  sqliteCode: number | null;
  message: string;
};
export type StateSnapshot = {
  stateAccess: StateAccessFailure | null;
  groupSnapshot: 'unavailable' | 'absent' | 'loaded';
  groupState: TestRunResult['groupState'] | null;
  timeoutCount: number | null;
};
export type StateRecoveryResult = Omit<TestRunResult, 'groupState' | 'timeoutCount'> & StateSnapshot;
export type RecoveryInFlight = NonNullable<TestRunGroup['inFlight']> & {
  phase: string | null;
  callerPhase: string | null;
  selection: TestRunResult['selection'];
  command: TestRunResult['command'];
  testKind: TestRunResult['testKind'];
  timeoutPolicy: TestRunResult['timeoutPolicy'];
  startedAt: string | null;
  finishedAtMs: number | null;
  deadlineObservedAtMs: number | null;
  ownerIdentity: string | null;
};
export type RecoveryDelivery = {
  runId: string;
  pending: boolean;
  receiptId: string | null;
  returned: boolean;
  forwardedToMain: boolean;
};
export type RecoveryGroup = Omit<TestRunGroup, 'inFlight' | 'lastResult'> & {
  inFlight: RecoveryInFlight | null;
  lastResult: StateRecoveryResult | null;
  delivery: RecoveryDelivery | null;
};
export type RecoveryTransaction = Omit<TestRunTransaction, 'get' | 'put' | 'list'> & {
  get(key: TestRunGroupKey): RecoveryGroup | null;
  put(group: RecoveryGroup): void;
  list(project: string, workspace: string): RecoveryGroup[];
};
export type RecoveryStatePort = {
  transaction<T>(operation: (transaction: RecoveryTransaction) => T): Promise<T>;
};
export type StateOpenPorts = {
  guard(store: 'control' | 'unit', path: string): Promise<void>;
  open(store: 'control' | 'unit', path: string): Promise<RecoveryStatePort>;
  limits: DiagnosticLimits;
};
export type StateRead = StateSnapshot & { group: RecoveryGroup | null; errorCode: string | null };
export type RecoveryObservation = {
  owner: 'lost' | 'alive' | 'unknown';
  tree: 'alive' | 'dead' | 'unknown' | 'pid-reused';
  identity: string | null;
  finishedAtMs: number | null;
  deadlineObservedAtMs: number | null;
  interrupted: boolean;
};
export type RecoveryReply = {
  result: StateRecoveryResult | null;
  stderr: string;
  cliCode: number;
  delivery: RecoveryDelivery | null;
  recovery: {
    runId: string | null;
    processIdentity: string | null;
    deadlineMs: number | null;
    reason: string;
    needsMain: boolean;
  };
};
export type StateRecoveryPorts = {
  state: RecoveryStatePort;
  observe(run: RecoveryInFlight): Promise<RecoveryObservation>;
  cleanup(run: RecoveryInFlight): Promise<TestRunResult['cleanup']>;
  release(runId: string, processIdentity: string | null): Promise<boolean>;
  returnResult(result: StateRecoveryResult): Promise<{ returned: boolean }>;
  messageMain(evidence: RecoveryReply): Promise<{
    accepted: boolean;
    receiptId: string | null;
    forwarded: boolean;
  }>;
};
export async function readTestRunState(
  input: { store: 'control' | 'unit'; path: string; key: TestRunGroupKey },
  ports: StateOpenPorts,
): Promise<StateRead> {
  throw new Error('NotImplemented');
}
export function applyTestRunStateSnapshot(result: TestRunResult, read: StateRead): StateRecoveryResult {
  throw new Error('NotImplemented');
}
export async function recoverTestRun(
  input: { key: TestRunGroupKey; authorized: boolean; nowMs: number },
  ports: StateRecoveryPorts,
): Promise<RecoveryReply> {
  throw new Error('NotImplemented');
}
export async function cleanupDeliveredTestRunGroups(
  activeChanges: readonly string[], key: TestRunGroupKey, ports: StateRecoveryPorts,
): Promise<void> {
  throw new Error('NotImplemented');
}
export function encodeStateRecoveryReply(reply: RecoveryReply): string {
  throw new Error('NotImplemented');
}
export function decodeStateRecoveryReply(value: unknown): RecoveryReply {
  throw new Error('NotImplemented');
}
