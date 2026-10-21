#!/usr/bin/env node
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runProductionCli } from '../src/production-entry.ts';

const result = await runProductionCli(process.argv.slice(2), {
  orchestratorRoot: fileURLToPath(new URL('../../', import.meta.url)),
  homeDirectory: homedir(),
  artifactPath: fileURLToPath(new URL('../dist/catalog.json', import.meta.url)),
});
if (result.stdout) process.stdout.write(result.stdout + '\n');
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.exitCode;
