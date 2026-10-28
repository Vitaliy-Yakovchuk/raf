export async function createStandGeneration(root, commit, host) {
  const files = await host.inventory(root);
  return { root, commit, files, fingerprint: host.hash(JSON.stringify(files)) };
}
