#!/usr/bin/env node
import { bindProcessCliOutput, deliverExecutionResult } from '../src/cli-output.ts';

const output = bindProcessCliOutput();
const costStartedAt = { monotonicMs: performance.now(), utc: new Date().toISOString(), cpu: process.cpuUsage() };
const result = await (await import('../src/cli.ts')).runPublicCli(import.meta.url, process.argv.slice(2), costStartedAt);
process.exitCode = await deliverExecutionResult(result, output);
