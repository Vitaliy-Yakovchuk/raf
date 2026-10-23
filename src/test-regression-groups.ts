import type {
  SandboxCommandReply,
  SandboxCommandRequest,
  SandboxTestAssignment,
  SandboxTestControlSnapshot,
  SandboxTestRunPorts,
  SandboxTestSession,
  SandboxUnitContext,
} from './sandbox-test-run.ts';
import type { TestRunConfig, TestRunGroupKey, TestRunRequest } from './test-runs.ts';

export interface RegressionGrant {
  readonly sourceChange: string;
  readonly sourceItem: string;
  readonly group: string;
  readonly profileId: string;
  readonly files: readonly string[];
}

export interface RegressionTestAssignment extends SandboxTestAssignment {
  readonly regressionGroups?: readonly RegressionGrant[];
}

export interface RegressionCatalog {
  readonly config: Pick<TestRunConfig, 'projects' | 'phases'>;
  readonly activeChanges: readonly string[];
  readonly workspaces: SandboxTestControlSnapshot['workspaces'];
}

export interface RegressionLaunchInput {
  readonly assignment: SandboxTestAssignment;
  readonly selectedItems: readonly { readonly change: string; readonly item: string }[];
  readonly verifiedChanges: readonly {
    readonly id: string;
    readonly items: readonly { readonly id: string; readonly description: string }[];
  }[];
  readonly catalog: RegressionCatalog;
}

export interface RegressionTestSession extends SandboxTestSession {
  readonly assignment: RegressionTestAssignment;
}

export interface RegressionControlSnapshot extends SandboxTestControlSnapshot {
  readonly sessions: readonly RegressionTestSession[];
  readonly config: Pick<TestRunConfig, 'projects' | 'phases'>;
}

export interface RegressionAuthorization {
  readonly key: TestRunGroupKey;
  readonly profileId: string | null;
  readonly files: readonly string[];
  readonly provenance: readonly { readonly sourceChange: string; readonly sourceItem: string; readonly group: string }[];
}

export interface RegressionExecutionPorts extends Omit<SandboxTestRunPorts, 'control'> {
  control(caller: SandboxTestRunPorts['caller']): Promise<RegressionControlSnapshot>;
  wrapper(request: TestRunRequest, context: SandboxUnitContext): Promise<SandboxCommandReply>;
  evidence(authorization: RegressionAuthorization, reply: SandboxCommandReply): Promise<void>;
}

export function normalizeRegressionGroups(input: RegressionLaunchInput): readonly RegressionGrant[] {
  throw new Error('NotImplemented');
}

export function snapshotRegressionAssignment(input: RegressionLaunchInput): RegressionTestAssignment {
  throw new Error('NotImplemented');
}

export function resumeRegressionAssignment(snapshot: RegressionTestAssignment): RegressionTestAssignment {
  throw new Error('NotImplemented');
}

export function authorizeRegressionRun(
  request: TestRunRequest,
  assignment: RegressionTestAssignment,
  control: RegressionControlSnapshot,
): RegressionAuthorization {
  throw new Error('NotImplemented');
}

export async function executeRegressionRun(
  request: SandboxCommandRequest,
  ports: RegressionExecutionPorts,
): Promise<SandboxCommandReply> {
  throw new Error('NotImplemented');
}
