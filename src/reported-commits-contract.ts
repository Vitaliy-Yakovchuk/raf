import type { AssignmentSnapshot, AssignmentVerification } from './assignment.ts';
import type { TaskCheckboxCommit } from './task-checkbox-report.ts';
import type { ReportCommitIndexRequest } from './report-commit-index.ts';

export interface ReportedCommit {
  readonly repository: string;
  readonly sha: string;
}

export interface ReportedCommitRepository {
  readonly repositoryRoot: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly launchHead: string;
}

export interface ReportedCommitLaunchContext {
  readonly contract: 'reported-commits-v1';
  readonly runId: string;
  readonly reportPath: string;
  readonly repositories: readonly ReportedCommitRepository[];
  readonly writeBoundaries: readonly string[];
}

export interface ReportedCommitRequestContext {
  readonly reportedCommits?: ReportedCommitLaunchContext;
}

export interface ReportedCommitAcceptancePorts {
  reconcileReportedCommitIndex(request: ReportCommitIndexRequest): Promise<void>;
  verifyAssignmentSourceIdentity(snapshot: AssignmentSnapshot): Promise<AssignmentVerification>;
  isCurrentReport(runId: string, reportPath: string): Promise<boolean>;
  readTaskCheckboxCommits(runId: string): Promise<readonly TaskCheckboxCommit[]>;
}
