import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function inventory(root: string): { path: string; sha256: string; mode: number }[] {
  const files: { path: string; sha256: string; mode: number }[] = [];
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      if (directory === root && ['.git', 'node_modules'].includes(name)) continue;
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error('Generation symlink');
      if (info.isDirectory()) walk(path);
      else if (info.isFile() && info.nlink === 1) files.push({ path: relative(root, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), mode: info.mode & 0o777 });
      else throw new Error('Generation alias');
    }
  }
  walk(root);
  return files;
}
export function hotfixModuleOrigin(orchestratorRoot: string, productionRoot: string, modulePath: string, qa: boolean): string | undefined {
  const common = git(productionRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const control = join(realpathSync(common), 'raf-hotfix');
  const root = dirname(dirname(modulePath));
  if (realpathSync(root) !== root || !['src', 'bin', 'scripts'].includes(relative(root, modulePath).split('/')[0])) return undefined;
  try {
    const state = json(join(control, 'registry.json'));
    const generation = state.generations?.[root];
    if (generation && root.startsWith(join(control, 'generations') + '/') && generation.root === root) {
      if (createHash('sha256').update(JSON.stringify(inventory(root))).digest('hex') !== generation.fingerprint) return undefined;
      return root;
    }
  } catch {}
  if (!qa) return undefined;
  try {
    const owner = json(join(dirname(root), 'ownership.json'));
    if (owner.cwd !== root || owner.runId !== dirname(root).split('/').at(-1) || owner.repositoryIdentity !== realpathSync(common) || owner.ownershipPath !== join(dirname(root), 'ownership.json') || owner.project !== 'raf' || owner.targetBranch !== 'main' || !root.startsWith(join(orchestratorRoot, '.raf-hotfix', 'runs') + '/')) return undefined;
    if (git(root, 'rev-parse', '--show-toplevel') !== root || git(root, 'rev-parse', '--path-format=absolute', '--git-dir') !== owner.gitDirectory || git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== owner.commonDirectory) return undefined;
    return root;
  } catch { return undefined; }
}
