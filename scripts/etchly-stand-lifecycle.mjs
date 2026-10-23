import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function standCodeRoot(stand) {
  return join(stand, 'raf-develop');
}

export async function withFixtureWorkspace(configFile, fixtures, run) {
  if (existsSync(fixtures)) throw new Error('Refuse to overwrite existing fixture workspace');
  const original = readFileSync(configFile);
  try {
    return await run();
  } finally {
    try { writeFileSync(configFile, original); }
    finally { rmSync(fixtures, { recursive: true, force: true }); }
  }
}
