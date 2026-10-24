import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runVitestBatchFromSource } from '../src/test-run-etchly.ts';

const workspace = process.env.RAF_TEST_RUN_WORKSPACE!;
const api = await import(pathToFileURL(resolve(workspace, 'node_modules/vitest/dist/node.js')).href);
process.env.TEST = 'true';
process.env.VITEST = 'true';
process.env.NODE_ENV ??= 'test';
const runner = fileURLToPath(new URL('../src/test-run-vitest-runner.ts', import.meta.url));
const temporary = process.env.TMPDIR;
if (!temporary) throw new Error('Trusted private Vitest temporary directory required');
await runVitestBatchFromSource(api as any, process.argv.slice(2), runner, temporary);
