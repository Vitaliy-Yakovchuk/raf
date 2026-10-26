import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { executeCommand } from './os-runtime.ts';
import type { ReportedCommit, ReportedCommitLaunchContext, ReportedCommitRepository } from './reported-commits-contract.ts';

export const reportedCommitsSchema = {
  type: 'array', items: { type: 'object', required: ['repository', 'sha'], additionalProperties: false,
    properties: { repository: { type: 'string' }, sha: { type: 'string' } } },
} as const;

export function validReportedCommits(value: unknown): value is readonly ReportedCommit[] {
  return Array.isArray(value) && value.every(row => row !== null && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).length === 2 && typeof row.repository === 'string' && typeof row.sha === 'string');
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const environment = { ...process.env };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const result = await executeCommand({ executable: 'git', args, cwd: repository, environment });
  if (result.exitCode !== 0) throw new Error(`${repository}: Git ${args.join(' ')}: ${result.stderr.trim() || result.exitCode}`);
  return result.stdout.trim();
}

async function repositoryIdentity(repositoryRoot: string): Promise<Omit<ReportedCommitRepository, 'launchHead'>> {
  if (!isAbsolute(repositoryRoot) || await realpath(repositoryRoot) !== repositoryRoot) throw new Error(`Noncanonical repository: ${repositoryRoot}`);
  const [top, directory, common, objectFormat] = await Promise.all([
    git(repositoryRoot, ['rev-parse', '--show-toplevel']),
    git(repositoryRoot, ['rev-parse', '--absolute-git-dir']),
    git(repositoryRoot, ['rev-parse', '--git-common-dir']),
    git(repositoryRoot, ['rev-parse', '--show-object-format']),
  ]);
  if (top !== repositoryRoot) throw new Error(`Repository root changed: ${repositoryRoot}`);
  const [gitDirectory, commonDirectory] = await Promise.all([realpath(directory), realpath(resolve(repositoryRoot, common))]);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error(`Unsupported Git object format: ${repositoryRoot}`);
  return { repositoryRoot, gitDirectory, commonDirectory, objectFormat };
}

export async function captureReportedCommitLaunchContext(runId: string, reportPath: string, roots: readonly string[], writeBoundaries: readonly string[]): Promise<ReportedCommitLaunchContext> {
  const repositories: ReportedCommitRepository[] = [];
  for (const root of roots) {
    const repositoryRoot = await realpath(root);
    if (repositories.some(row => row.repositoryRoot === repositoryRoot)) continue;
    const identity = await repositoryIdentity(repositoryRoot);
    const launchHead = await git(repositoryRoot, ['rev-parse', '--verify', 'HEAD']);
    if (!new RegExp(`^[a-f0-9]{${identity.objectFormat === 'sha1' ? 40 : 64}}$`).test(launchHead)
      || await git(repositoryRoot, ['cat-file', '-t', launchHead]) !== 'commit') throw new Error(`Launch HEAD is not a commit: ${repositoryRoot}`);
    repositories.push({ ...identity, launchHead });
  }
  return { contract: 'reported-commits-v1', runId, reportPath, repositories, writeBoundaries: [...writeBoundaries] };
}
