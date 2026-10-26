import { readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { verifyHotfixRuntimeInventory, verifyHotfixRuntimeModule } from './hotfix-runtime-inventory.ts';

function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
export function hotfixModuleOrigin(modulePath: string, diagnostic?: (reason: string) => void, admitted?: (checkModule: (path: string) => void) => void): string | undefined {
  const marker = modulePath.indexOf('/raf-hotfix/generations/');
  if (marker < 0) return undefined;
  const control = modulePath.slice(0, marker) + '/raf-hotfix';
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
