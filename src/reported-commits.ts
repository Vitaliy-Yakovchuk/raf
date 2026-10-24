import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { executeCommand } from './os-runtime.ts';
import type { ReportedCommit, ReportedCommitLaunchContext, ReportedCommitRepository } from './reported-commits-contract.ts';
import type { ReportCommitIndexRequest } from './report-commit-index.ts';
import type { TaskCheckboxCommit } from './task-checkbox-report.ts';

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

export async function validateReportedCommitGroups(context: ReportedCommitLaunchContext, commits: readonly ReportedCommit[], checkboxCommits: readonly TaskCheckboxCommit[]): Promise<readonly ReportCommitIndexRequest[]> {
  if (context.contract !== 'reported-commits-v1' || !Array.isArray(context.repositories) || !Array.isArray(context.writeBoundaries)) throw new Error('Reported commit launch metadata is unavailable');
  const groups = new Map<string, string[]>();
  const roots = new Set<string>();
  for (const saved of context.repositories) {
    if (roots.has(saved.repositoryRoot)) throw new Error('Duplicate launch repository');
    roots.add(saved.repositoryRoot);
    const { launchHead, ...identity } = saved;
    const oid = new RegExp(`^[a-f0-9]{${saved.objectFormat === 'sha1' ? 40 : 64}}$`);
    if (!oid.test(launchHead)) throw new Error(`Invalid launch baseline: ${saved.repositoryRoot}`);
    const [currentIdentity, type] = await Promise.all([
      repositoryIdentity(saved.repositoryRoot),
      git(saved.repositoryRoot, ['cat-file', '-t', launchHead]),
      git(saved.repositoryRoot, ['merge-base', '--is-ancestor', launchHead, 'HEAD']),
    ]);
    if (!isDeepStrictEqual(currentIdentity, identity)) throw new Error(`Git identity changed: ${saved.repositoryRoot}`);
    if (type !== 'commit') throw new Error(`Invalid launch baseline: ${saved.repositoryRoot}`);
  }
  for (const entry of commits) {
    const repository = context.repositories.find(row => row.repositoryRoot === entry.repository);
    if (!repository) throw new Error(`Unlisted reported commit repository: ${entry.repository}`);
    const oid = new RegExp(`^[a-f0-9]{${repository.objectFormat === 'sha1' ? 40 : 64}}$`);
    if (!oid.test(entry.sha)) throw new Error(`Invalid full commit SHA: ${entry.repository}: ${entry.sha}`);
    if (checkboxCommits.some(row => row.sha === entry.sha)) throw new Error(`Checkbox commit is not an executor commit: ${entry.sha}`);
    const ordered = groups.get(entry.repository) ?? [];
    if (ordered.includes(entry.sha)) throw new Error(`Duplicate reported commit: ${entry.sha}`);
    if (entry.sha === repository.launchHead) throw new Error(`Reported commit equals launch baseline: ${entry.sha}`);
    const [type, resolved] = await Promise.all([
      git(entry.repository, ['cat-file', '-t', entry.sha]),
      git(entry.repository, ['rev-parse', '--verify', entry.sha]),
      git(entry.repository, ['merge-base', '--is-ancestor', repository.launchHead, entry.sha]),
      git(entry.repository, ['merge-base', '--is-ancestor', entry.sha, 'HEAD']),
      ...(ordered.length ? [git(entry.repository, ['merge-base', '--is-ancestor', ordered[ordered.length - 1], entry.sha])] : []),
    ]);
    if (type !== 'commit' || resolved !== entry.sha) throw new Error(`Not a commit object: ${entry.sha}`);
    ordered.push(entry.sha);
    groups.set(entry.repository, ordered);
  }
  return [...groups].map(([repositoryRoot, commits]) => ({ repositoryRoot, commits }));
}
