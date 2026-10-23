#!/usr/bin/env node
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProductionCli } from '../src/production-entry.ts';

const result = statSync(fileURLToPath(import.meta.url)).nlink !== 1 ? {
  exitCode: 1,
  stdout: '',
  stderr: JSON.stringify({ code: 'STATE_CONTEXT_REFUSED', message: 'STATE_CONTEXT_REFUSED: hardlinked raf entry has ambiguous code provenance', remediation: 'Use the original production entry or a separate RAF_QA_HOME stand.' }),
} : await runProductionCli(process.argv.slice(2), {
  orchestratorRoot: fileURLToPath(new URL('../../', import.meta.url)),
  homeDirectory: homedir(),
  artifactPath: fileURLToPath(new URL('../dist/catalog.json', import.meta.url)),
});
if (result.stdout) process.stdout.write(result.stdout + '\n');
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.exitCode;
