export interface ReportCommitIndexRequest {
  repositoryRoot: string;
  commits: readonly string[];
}

export async function reconcileReportedCommitIndex(
  request: ReportCommitIndexRequest,
): Promise<void> {
  throw new Error("NotImplemented");
}
