#!/usr/bin/env node
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const owner = (() => { try { return JSON.parse(readFileSync(fileURLToPath(new URL('../../ownership.json', import.meta.url)), 'utf8')); } catch { return undefined; } })();
const orchestratorRoot = process.env.RAF_ORCHESTRATOR_ROOT ?? owner?.orchestratorRoot ?? fileURLToPath(new URL('../../', import.meta.url));
const codeRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
let lease: { generationRoot: string; release(): Promise<void> } | undefined;
const configuration = await (await import('node:fs/promises')).readFile(join(orchestratorRoot, 'conf/projects.json'), 'utf8').then(JSON.parse, () => ({})).catch(() => ({}));
const main = configuration.projects?.raf?.branchPaths?.main;
const attachedMain = () => { try { return execFileSync('git', ['-C', codeRoot, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'main'; } catch { return false; } };
if (main && resolve(orchestratorRoot, main) === codeRoot && attachedMain()) {
  const { acquireHotfixReader } = await import('../src/hotfix-activation.ts');
  lease = await acquireHotfixReader({ orchestratorRoot, qaHome: homedir(), environment: {}, sandboxExecutable: 'codex' }, 'cli');
}
const root = lease?.generationRoot ?? codeRoot;
const { runProductionCli } = await import(pathToFileURL(join(root, 'src/production-entry.ts')).href);

const result = statSync(fileURLToPath(import.meta.url)).nlink !== 1 ? {
  exitCode: 1,
  stdout: '',
  stderr: JSON.stringify({ code: 'STATE_CONTEXT_REFUSED', message: 'STATE_CONTEXT_REFUSED: hardlinked raf entry has ambiguous code provenance', remediation: 'Use the original production entry or a separate RAF_QA_HOME stand.' }),
} : await runProductionCli(process.argv.slice(2), {
  orchestratorRoot,
  homeDirectory: homedir(),
  artifactPath: join(root, 'dist/catalog.json'),
});
if (result.stdout) process.stdout.write(result.stdout + '\n');
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.exitCode;

await lease?.release();
