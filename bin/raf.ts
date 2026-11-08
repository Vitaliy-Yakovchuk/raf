#!/usr/bin/env node
import { bindProcessCliOutput, runCliEntry } from '../src/cli-output.ts';
import { enableCompileCache } from 'node:module';

enableCompileCache();
const output = bindProcessCliOutput();
const costStartedAt = { monotonicMs: performance.now(), utc: new Date().toISOString(), cpu: process.cpuUsage() };
process.exitCode = await runCliEntry(async () => (await import('../src/cli.ts')).runPublicCli(import.meta.url, process.argv.slice(2), costStartedAt), output);
