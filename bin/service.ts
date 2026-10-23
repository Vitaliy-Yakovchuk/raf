import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { retainHotfixGeneration } from '../src/hotfix-activation.ts';
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const orchestratorRoot = process.env.RAF_ORCHESTRATOR_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const lease = await retainHotfixGeneration({ orchestratorRoot, qaHome: homedir(), environment: {}, sandboxExecutable: 'codex' }, root).catch(error => { if (process.env.RAF_QA_HOME) return undefined; throw error; });
const { runServiceEntry } = await import(pathToFileURL(join(root, 'src/service-entry.ts')).href);

try {
  const host = await runServiceEntry();
  await host.closed;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}

await lease?.release();
