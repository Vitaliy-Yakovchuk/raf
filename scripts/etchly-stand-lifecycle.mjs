import { join } from 'node:path';

export function standCodeRoot(stand) {
  return '/srv/dev/work/orchestrator/raf-develop';
}

export async function withFixtureWorkspace(configFile, fixtures, run) {
  return await run();
}
