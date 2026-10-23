import type { ResourceEstimateResolution, ResourceReservationEstimate } from './resource-estimates.ts';
import type { TestRunContext, TestRunGroupKey, TestRunPorts, TestRunRequest, TestRunResult, UnitTestPolicy } from './test-runs.ts';

export interface TestRunResourceClaim {
  machineId: string;
  testRunId: string;
  fence: string;
  groupKey: TestRunGroupKey;
  deadlineMs: number;
  processIdentity: string | null;
}

export interface TestRunResourceRequest {
  testRunId: string;
  groupKey: TestRunGroupKey;
  requestedTier: 'normal' | 'hotfix';
  estimate: ResourceEstimateResolution;
  deadlineMs: number;
}

export type TestRunResourcePreparation =
  | { status: 'prepared'; claim: TestRunResourceClaim; admission: object }
  | { status: 'refused'; claim: null; admission: object; nextAction: 'retry' | 'fix-setup' };

export interface TestRunTreeObservation {
  state: 'dead' | 'alive' | 'unknown';
  processIdentity: string | null;
  consumed: ResourceReservationEstimate | null;
}

export interface TestRunResourcePort {
  estimateProfile(project: string, profileId: string): Promise<ResourceEstimateResolution>;
  prepare(request: TestRunResourceRequest): Promise<TestRunResourcePreparation>;
  commit(claim: TestRunResourceClaim): Promise<boolean>;
  current(claim: TestRunResourceClaim): Promise<boolean>;
  bindProcess(claim: TestRunResourceClaim, processIdentity: string): Promise<void>;
  observeTree(claim: TestRunResourceClaim): Promise<TestRunTreeObservation>;
  accountUsage(claim: TestRunResourceClaim, consumed: ResourceReservationEstimate): Promise<void>;
  release(claim: TestRunResourceClaim): Promise<boolean>;
  list(machineId: string): Promise<TestRunResourceClaim[]>;
}

export interface ResourceReservedTestRunPorts extends TestRunPorts {
  resources: TestRunResourcePort;
  machineId: string;
}

export interface ResourceReservedTestRunResult extends TestRunResult {
  admission: object | null;
}

export interface TestRunResourceReconciliation {
  released: TestRunResourceClaim[];
  retained: TestRunResourceClaim[];
}

export async function runResourceReservedTestRun(
  request: TestRunRequest,
  configInput: unknown,
  policy: UnitTestPolicy,
  context: TestRunContext,
  ports: ResourceReservedTestRunPorts,
): Promise<ResourceReservedTestRunResult> {
  throw new Error('NotImplemented');
}

export async function reconcileTestRunResources(
  context: TestRunContext,
  policy: UnitTestPolicy,
  ports: ResourceReservedTestRunPorts,
): Promise<TestRunResourceReconciliation> {
  throw new Error('NotImplemented');
}
