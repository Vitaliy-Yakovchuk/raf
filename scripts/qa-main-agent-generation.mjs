import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createStandGeneration(root, commit, host) {
  const files = await host.inventory(root);
  const { createHotfixRuntimeInventory, defaultHotfixRuntimePolicy } = await import(pathToFileURL(join(root, 'src/hotfix-runtime-inventory.ts')).href);
  const runtimeInventory = createHotfixRuntimeInventory(root, commit, defaultHotfixRuntimePolicy(root));
  return { root, commit, files, runtimeInventory, fingerprint: host.hash(JSON.stringify(files)) };
}
