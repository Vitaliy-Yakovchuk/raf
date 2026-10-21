#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/bootstrap.ts';
import { UnavailableCommandError } from '../src/cli.ts';
import type { Handler } from '../src/cli.ts';
import type { CompiledCatalog } from '../src/catalog.ts';

const artifactPath = fileURLToPath(new URL('../dist/catalog.json', import.meta.url));
let handlers: Record<string, Handler> = {};
try {
  const catalog: CompiledCatalog = JSON.parse(readFileSync(artifactPath, 'utf8'));
  handlers = Object.fromEntries(catalog.commands.map(command => [command.handlerName, () => { throw new UnavailableCommandError(); }]));
} catch {

}
const result = await runCli(process.argv.slice(2), artifactPath, handlers);
if (result.stdout) process.stdout.write(result.stdout + '\n');
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.exitCode;
