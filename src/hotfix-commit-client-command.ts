import { isAbsolute, join } from 'node:path';
import type { HotfixCommand } from './hotfix-worktree.ts';

export interface HotfixCommitClientRequest {
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly message: string;
}

export function hotfixCommitClientCommand(directory: string, request: HotfixCommitClientRequest): HotfixCommand & { readonly cwd: string } {
  if (!isAbsolute(directory) || !isAbsolute(request.cwd) || !request.paths.length || !request.message.trim()) throw new Error('Hotfix client requires directory, workspace, message and explicit paths');
  return { executable: process.execPath, args: [join(directory, 'hotfix-commit.mjs'), '--message', request.message, ...request.paths], cwd: request.cwd };
}
