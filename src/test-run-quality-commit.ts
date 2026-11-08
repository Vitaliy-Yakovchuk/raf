import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function materializeQualityCommit(workspace: string, revision: string, storage: string) {
  const container = mkdtempSync(join(storage, '.raf-quality-source-'));
  const root = join(container, 'source');
  const cleanup = () => rmSync(container, { recursive: true, force: true });
  const git = (args: string[], cwd = workspace) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: Infinity });
    if (result.status !== 0) throw Object.assign(new Error(`Cannot materialize quality commit: ${result.stderr}`), { code: 'QUALITY_UNSUPPORTED' });
    return result.stdout;
  };
  try {
    git(['clone', '--shared', '--no-checkout', '--quiet', '--', workspace, root]);
    git(['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', '--force', revision], root);
    const paths = git(['ls-tree', '-rz', '--name-only', revision], root).split('\0').filter(Boolean);
    for (const path of paths) {
      const file = join(root, path);
      if (!lstatSync(file).isSymbolicLink()) continue;
      const target = readlinkSync(file);
      if (!isAbsolute(target) || !target.startsWith(workspace + sep)) continue;
      unlinkSync(file);
      symlinkSync(resolve(root, relative(workspace, target)), file);
    }
    return { root, paths, cleanup };
  } catch (error) { cleanup(); throw error; }
}
