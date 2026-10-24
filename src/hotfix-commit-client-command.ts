import type { HotfixCommand } from './hotfix-worktree.ts';

export interface HotfixCommitClientRequest {
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly message: string;
}

export function hotfixCommitClientCommand(
  directory: string,
  request: HotfixCommitClientRequest,
): HotfixCommand & { readonly cwd: string } {
  throw new Error('NotImplemented');
}
