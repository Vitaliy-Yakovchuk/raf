import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

type SharedGitState = { scope: AsyncLocalStorage<string>; calls: number; warnedAt: number; threshold?: number };

const key = Symbol.for('raf.git.process');
const shared = globalThis as typeof globalThis & { [key]?: SharedGitState };
const state: SharedGitState = shared[key] ??= { scope: new AsyncLocalStorage<string>(), calls: 0, warnedAt: 0 };
const executeFile = promisify(execFile);
export const defaultGitCallWarningThreshold = 50;

export class GitInCommandError extends Error {
  readonly code = 'GIT_IN_COMMAND';
  constructor(command: string, args: readonly string[]) {
    super(`Programming error: raf command ${command} must not run git (git ${args.join(' ')}); git actions belong to the service or worker`);
    this.name = 'GitInCommandError';
  }
}

export function runGitFreeCommand<T>(command: string, use: () => T): T {
  return state.scope.run(command, use);
}

export function gitAllowed(): boolean {
  return state.scope.getStore() === undefined;
}

export function gitCallCount(): number {
  return state.calls;
}

function configuredThreshold(): number {
  if (state.threshold !== undefined) return state.threshold;
  const roots = [process.env.RAF_ORCHESTRATOR_ROOT, fileURLToPath(new URL('../../', import.meta.url))].filter((root): root is string => !!root);
  for (const root of roots) {
    try {
      const value = JSON.parse(readFileSync(join(root, 'conf', 'raf.json'), 'utf8'))?.git?.warnCallsPerProcess;
      if (Number.isSafeInteger(value) && value > 0) return state.threshold = value;
    } catch {}
  }
  return state.threshold = defaultGitCallWarningThreshold;
}

export function admitGit(args: readonly string[]): void {
  const command = state.scope.getStore();
  if (command !== undefined) throw new GitInCommandError(command, args);
  state.calls += 1;
  const threshold = configuredThreshold();
  if (state.calls > threshold && state.calls - state.warnedAt > threshold) {
    state.warnedAt = state.calls;
    process.emitWarning(`raf process ${process.pid} made ${state.calls} git calls, above conf/raf.json#/git/warnCallsPerProcess ${threshold}; last: git ${args.slice(0, 4).join(' ')}`, { code: 'RAF_GIT_CALLS' });
  }
}

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
}

export async function gitOutput(args: readonly string[], options: GitOptions = {}): Promise<string> {
  admitGit(args);
  return (await executeFile('git', [...args], { cwd: options.cwd, env: options.env, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, timeout: options.timeout })).stdout;
}

export function gitOutputSync(args: readonly string[], options: GitOptions = {}): string {
  admitGit(args);
  return execFileSync('git', [...args], { cwd: options.cwd, env: options.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, timeout: options.timeout });
}

export interface GitMetadata {
  gitDirectory: string;
  commonDirectory: string;
}

export function readGitMetadata(cwd: string): GitMetadata | null {
  try {
    const dotGit = join(cwd, '.git');
    let gitDirectory = dotGit;
    if (!statSync(dotGit).isDirectory()) {
      const pointer = readFileSync(dotGit, 'utf8');
      if (!pointer.startsWith('gitdir:')) return null;
      gitDirectory = resolve(cwd, pointer.slice('gitdir:'.length).trim());
    }
    let commonDirectory = gitDirectory;
    try {
      const common = readFileSync(join(gitDirectory, 'commondir'), 'utf8').trim();
      if (common) commonDirectory = resolve(gitDirectory, common);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { gitDirectory, commonDirectory };
  } catch { return null; }
}

export function readGitHead(cwd: string): { branch: string | null; commit: string | null } {
  const metadata = readGitMetadata(cwd);
  if (!metadata) return { branch: null, commit: null };
  try {
    const head = readFileSync(join(metadata.gitDirectory, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return { branch: null, commit: /^[0-9a-f]{40,64}$/.test(head) ? head : null };
    const ref = head.slice('ref:'.length).trim();
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    for (const directory of [metadata.gitDirectory, metadata.commonDirectory]) {
      try { return { branch, commit: readFileSync(join(directory, ref), 'utf8').trim() }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try {
      const packed = readFileSync(join(metadata.commonDirectory, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(' ' + ref));
      return { branch, commit: packed ? packed.split(' ')[0] : null };
    } catch { return { branch, commit: null }; }
  } catch { return { branch: null, commit: null }; }
}
