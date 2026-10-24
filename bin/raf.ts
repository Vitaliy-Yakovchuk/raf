#!/usr/bin/env node
import { statSync } from 'node:fs';

const costStartedAt = { monotonicMs: performance.now(), utc: new Date().toISOString(), cpu: process.cpuUsage() };
const result = statSync(new URL(import.meta.url)).nlink !== 1
  ? { exitCode: 1, stdout: '', stderr: JSON.stringify({ code: 'STATE_CONTEXT_REFUSED', message: 'Hardlinked raf entry has ambiguous code provenance' }) }
  : await (await import('../src/cli.ts')).runPublicCli(import.meta.url, process.argv.slice(2), costStartedAt);
if (result.stdout) {
  await new Promise<void>((done, fail) => process.stdout.write(result.stdout + '\n', error => error ? fail(error) : done()));
  try { await result.afterDelivery?.(); } catch { }
}
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.exitCode;
