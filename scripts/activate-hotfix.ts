import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { activateHotfix, recoverHotfixActivation } from '../src/hotfix-activation.ts';
import type { HotfixHost } from '../src/hotfix-worktree.ts';

const [root, qaHome, candidate] = process.argv.slice(2);
try {
  if (!root || !qaHome || !candidate) throw new Error('Usage: node scripts/activate-hotfix.ts <orchestrator-root> <qa-home> <verified.json|--recover>');
  const host: HotfixHost = {
    orchestratorRoot: await fs.realpath(resolve(root)), qaHome: await fs.realpath(resolve(qaHome)),
    environment: { ...process.env }, sandboxExecutable: 'codex',
  };
  const result = candidate === '--recover'
    ? await recoverHotfixActivation(host)
    : await activateHotfix(host, JSON.parse(await fs.readFile(resolve(candidate), 'utf8')));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exitCode = 1;
}
