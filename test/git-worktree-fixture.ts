import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export interface GitWorktreeLayout {
  readonly rootGitDir: string;
  readonly commonDir: string;
  readonly worktreeGitDir: string;
}

export async function writeGitWorktreeLayout(root: string, module = 'raf', worktree = `${module}-develop`, primary = `${module}-main`): Promise<GitWorktreeLayout> {
  const rootGit = join(root, '.git');
  const common = join(rootGit, 'modules', module);
  const linked = join(common, 'worktrees', worktree);
  await Promise.all([
    mkdir(join(rootGit, 'objects'), { recursive: true }), mkdir(join(rootGit, 'refs', 'heads'), { recursive: true }),
    mkdir(join(common, 'objects'), { recursive: true }), mkdir(join(common, 'refs', 'heads'), { recursive: true }),
    mkdir(linked, { recursive: true }), mkdir(join(root, worktree), { recursive: true }), mkdir(join(root, primary), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(rootGit, 'HEAD'), 'ref: refs/heads/main\n'),
    writeFile(join(common, 'HEAD'), 'ref: refs/heads/main\n'),
    writeFile(join(common, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ../../../${primary}\n`),
    writeFile(join(linked, 'HEAD'), 'ref: refs/heads/develop\n'),
    writeFile(join(linked, 'commondir'), '../..\n'),
    writeFile(join(linked, 'gitdir'), `${join(root, worktree, '.git')}\n`),
    writeFile(join(root, worktree, '.git'), `gitdir: ${linked}\n`),
    writeFile(join(root, primary, '.git'), `gitdir: ../.git/modules/${module}\n`),
  ]);
  return { rootGitDir: realpathSync(rootGit), commonDir: realpathSync(common), worktreeGitDir: realpathSync(linked) };
}
