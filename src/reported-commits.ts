import { realpath } from 'node:fs/promises';
import { readGitMetadata } from './git.ts';
import type { ReportedCommitLaunchContext, ReportedCommitRepository } from './reported-commits-contract.ts';

export const reportedCommitsSchema = {
  type: 'array', items: { type: 'object', required: ['repository', 'sha'], additionalProperties: false,
    properties: { repository: { type: 'string' }, sha: { type: 'string' } } },
} as const;

export async function captureReportedCommitLaunchContext(runId: string, reportPath: string, roots: readonly string[], writeBoundaries: readonly string[]): Promise<ReportedCommitLaunchContext> {
  const repositories: ReportedCommitRepository[] = [];
  for (const root of roots) {
    const repositoryRoot = await realpath(root);
    if (repositories.some(row => row.repositoryRoot === repositoryRoot)) continue;
    const metadata = readGitMetadata(repositoryRoot);
    if (!metadata) continue;
    const [gitDirectory, commonDirectory] = await Promise.all([realpath(metadata.gitDirectory), realpath(metadata.commonDirectory)]);
    const launchHead = '';
    repositories.push({ repositoryRoot, gitDirectory, commonDirectory, objectFormat: launchHead.length === 64 ? 'sha256' : 'sha1', launchHead });
  }
  return { contract: 'reported-commits-v1', runId, reportPath, repositories, writeBoundaries: [...writeBoundaries] };
}
