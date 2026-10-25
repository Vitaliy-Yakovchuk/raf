import type { WorkspaceProjectsConfig } from './workspace-routing.ts';
import type { ReportedCommitLaunchContext } from './reported-commits-contract.ts';

export async function sharedLibraryReadOnlyPaths(root: string, projects: WorkspaceProjectsConfig, commits?: Pick<ReportedCommitLaunchContext, 'repositories'>): Promise<string[]> {
  return [];
}
