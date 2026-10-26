import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { verifyHotfixRuntimeInventory, verifyHotfixRuntimeModule } from './hotfix-runtime-inventory.ts';
import { execFileSync } from 'node:child_process';

function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
export function hotfixModuleOrigin(orchestratorRoot: string, productionRoot: string, modulePath: string, qa: boolean, diagnostic?: (reason: string) => void, admitted?: (checkModule: (path: string) => void) => void): string | undefined {
  const common = git(productionRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const projects = json(join(orchestratorRoot, 'conf/projects.json')).projects;
  const source = realpathSync(git(resolve(orchestratorRoot, projects.raf.branchPaths.develop), 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const control = join(source, 'raf-hotfix');
  if (realpathSync(common) !== source) {
    const registration = json(join(control, 'main-store.json'));
    if (registration.root !== orchestratorRoot || registration.source !== source || registration.control !== control || registration.production !== join(control, 'main.git') || realpathSync(common) !== registration.production) return undefined;
  }
  try {
    const state = json(join(control, 'registry.json'));
    for (const [root, generation] of Object.entries(state.generations ?? {}) as [string, any][]) {
      if (!modulePath.startsWith(root + '/')) continue;
      if (!root.startsWith(join(control, 'generations') + '/') || generation.root !== root || realpathSync(root) !== root || !['src', 'bin', 'scripts'].includes(relative(root, modulePath).split('/')[0])) return undefined;
      verifyHotfixRuntimeInventory(root, generation.commit, generation.runtimeInventory, modulePath);
      admitted?.(path => verifyHotfixRuntimeModule(root, generation.commit, generation.runtimeInventory, path));
      return root;
    }
  } catch (error) { diagnostic?.(error instanceof Error ? error.message : String(error)); }
  return undefined;
}
