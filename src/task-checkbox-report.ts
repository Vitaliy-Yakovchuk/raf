import type { AgentReport, AgentReportRequest } from './agent-report.ts';
import type { AssignmentSnapshot, AssignmentVerification } from './assignment.ts';

export interface TaskCheckboxCommit {
  readonly change: string;
  readonly item: string;
  readonly sha: string;
}

export interface TaskCheckboxConfirmation extends AssignmentVerification {
  readonly commits: readonly TaskCheckboxCommit[];
  readonly awaitingArchive: boolean;
}

export interface TaskCheckboxOperation {
  readonly runId: string;
  readonly change: string;
  readonly item: string;
  readonly originalLine: string;
  readonly parent: string;
  readonly phase: 'prepared' | 'written' | 'committed' | 'verified';
  readonly sha?: string;
}

export type TaskCheckboxCheckpoint = 'validated' | 'before-write' | 'after-write' | 'before-ref-update' | 'after-commit' | 'after-verification';

export interface TaskCheckboxPorts {
  verifySourceIdentity(snapshot: AssignmentSnapshot, archiveClaims: Readonly<Record<string, string>>): Promise<AssignmentVerification>;
  verifyAssignmentCompletion(snapshot: AssignmentSnapshot, archiveClaims: Readonly<Record<string, string>>): Promise<AssignmentVerification>;
  readonly operations: {
    read(runId: string): Promise<readonly TaskCheckboxOperation[]>;
    write(runId: string, operations: readonly TaskCheckboxOperation[]): Promise<void>;
  };
  checkpoint?(phase: TaskCheckboxCheckpoint, item: Readonly<{ change: string; item: string }> | null): Promise<void>;
  executeGit?(args: readonly string[], options: Readonly<{ cwd: string; env?: Readonly<Record<string, string>> }>): Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;
  waitForIndex?(): Promise<void>;
}

export interface TaskCheckboxReportPort {
  confirmTaskCheckboxes(request: AgentReportRequest, report: AgentReport): Promise<TaskCheckboxConfirmation>;
}

export async function prepareReportedTaskCheckboxes(
  request: AgentReportRequest,
  report: AgentReport,
  ports: TaskCheckboxPorts,
): Promise<TaskCheckboxConfirmation> {
  throw new Error('NotImplemented');
}
