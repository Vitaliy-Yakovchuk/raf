import { createHotfixRuntimeInventory, defaultHotfixRuntimePolicy } from '../src/hotfix-runtime-inventory.ts';

export async function createStandGeneration(root, commit, host) {
  const files = await host.inventory(root);
  const runtimeInventory = createHotfixRuntimeInventory(root, commit, defaultHotfixRuntimePolicy(root));
  return { root, commit, files, runtimeInventory, fingerprint: host.hash(JSON.stringify(files)) };
}
