import type { WorkspaceProjectsConfig } from './workspace-routing.ts';
import type { ReportedCommitLaunchContext } from './reported-commits-contract.ts';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { gitDirectories } from './task-context.ts';

export async function sharedLibraryReadOnlyPaths(root: string, projects: WorkspaceProjectsConfig, commits?: Pick<ReportedCommitLaunchContext, 'repositories'>): Promise<string[]> {
  const library = projects.projects['shared-libs'];
  if (!library) return [];
  const rootMetadata = await gitDirectories(root);
  const repositories = commits?.repositories ?? [];
  const allowedRoots = new Set(repositories.map(row => row.repositoryRoot));
  const allowedMetadata = repositories.flatMap(row => [row.gitDirectory, row.commonDirectory]).filter(path => !rootMetadata.includes(path));
  const within = (parent: string, path: string) => {
    const suffix = relative(parent, path);
    return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
  };
  const protectedPaths = new Set<string>();
  for (const path of new Set(Object.values(library.branchPaths ?? {}))) {
    let workspace: string;
    try { workspace = await realpath(resolve(root, path)); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    if (!allowedRoots.has(workspace)) protectedPaths.add(workspace);
    for (const directory of await gitDirectories(workspace)) {
      if (!rootMetadata.includes(directory) && !allowedMetadata.some(parent => within(parent, directory))) protectedPaths.add(directory);
    }
  }
  return [...protectedPaths];
}
