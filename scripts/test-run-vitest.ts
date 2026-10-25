import { RunnerProtocol } from '../src/test-run-protocol.ts';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { TestRunCommand } from '../src/test-runs.ts';

const batches: TestRunCommand[] = JSON.parse(process.env.RAF_TEST_RUN_VITEST_BATCHES ?? '[]');
const limits = JSON.parse(process.env.RAF_TEST_RUN_DIAGNOSTICS!);
if (!batches.length) throw new Error('Trusted Vitest batches required');
for (const batch of batches) {
  const run = batch.argv.indexOf('run');
  if (run < 1) throw new Error('Trusted Vitest run required');
  const argv = [...batch.argv.slice(0, run - 1), fileURLToPath(new URL('./test-run-vitest-api.ts', import.meta.url)), ...batch.argv.slice(run)];
  const child = spawn(batch.executable, argv, { cwd: batch.cwd, shell: false, env: { ...process.env, RAF_TEST_RUN_IDS: JSON.stringify(batch.environment.testIds ?? []) }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  child.stdout!.pipe(process.stderr, { end: false });
  child.stderr!.pipe(process.stderr, { end: false });
  let complete = false, rejected = false, buffer = '';
  const protocol = new RunnerProtocol();
  const decoder = new StringDecoder('utf8');
  child.stdio[3]!.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
      if (rejected) continue;
      buffer += part;
      if (Buffer.byteLength(buffer) > limits.maxProtocolLineBytes) { rejected = true; buffer = ''; continue; }
      if (part.endsWith('\n')) {
        try { const event = protocol.accept(JSON.parse(buffer)); if (event?.kind === 'complete' && event.expected.length) complete = true; if (event?.kind === 'protocol-error') rejected = true; } catch { rejected = true; }
        buffer = '';
      }
    }
  });
  const code = await new Promise<number>((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done(signal ? 1 : code ?? 1)); });
  try { protocol.finish(); } catch { rejected = true; }
  if (!complete || rejected || buffer || decoder.end()) {
    process.stdout.write(JSON.stringify({ kind: 'protocol-error', diagnostic: 'Vitest batch missing complete structured protocol' }) + '\n');
    process.exitCode = 1;
  }
  if (code) process.exitCode = code;
}
