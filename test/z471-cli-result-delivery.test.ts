import assert from 'node:assert/strict';
import test from 'node:test';
import { createSerializedCliOutput, deliverExecutionResult } from '../src/cli-output.ts';

const requestId = '424c9b55-97ea-4d03-94c6-884085916f22';
const runId = 'a99f4dbe-b0aa-439c-ac4b-cb8b95e1100d';

test('Z.471 queued test run delivery keeps one TestRunResult when stderr is still draining', async () => {
  type Job = { slices: string[]; callback: (error: Error | null) => void };
  const jobs: Job[] = [];
  let merged = '';
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    const step = () => {
      const active = jobs.filter(job => job.slices.length);
      if (active.length > 1) merged += '[[interleave]]';
      const job = active[0];
      if (!job) { pumping = false; return; }
      merged += job.slices.shift();
      if (!job.slices.length) job.callback(null);
      setImmediate(step);
    };
    setImmediate(step);
  };
  const output = createSerializedCliOutput({
    write(_fd, chunk, _encoding, callback) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const slices: string[] = [];
      for (let index = 0; index < text.length; index += 4096) slices.push(text.slice(index, index + 4096));
      jobs.push({ slices, callback });
      pump();
    },
  });
  const warning = `Warning: etchly inventory differs: ${'worker/src/prompt-package-agent-tests/package-output.test.ts; '.repeat(400)}\n`;
  const body = {
    testKind: 'unit', outcome: 'setup-failed', runId, exitCode: 1, errorCode: null,
    queue: { queueId: '15392981-91bf-41d4-857c-5fc6d4899263', waited: true },
    admission: { level: 'HOTFIX_ONLY', requestedTier: 'normal', remaining: { normalizedLoad: 1.4875 } },
    diagnostic: 'd'.repeat(8000),
  };
  const frame = `${JSON.stringify({ kind: 'launch-queue.waiting', requestId, testRunId: runId, admission: { level: 'HOTFIX_ONLY', requestedTier: 'normal', remaining: { normalizedLoad: 1.4875 } } })}\n`;
  const liveWarning = output.writeStderr(warning);
  const code = await deliverExecutionResult({ stdout: JSON.stringify(body), stderr: frame.trimEnd(), exitCode: 1 }, output);
  await liveWarning;
  assert.equal(merged.includes('[[interleave]]'), false);
  const lines = merged.split('\n').filter(line => line.length > 0);
  const parsed = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { testKind?: string; kind?: string; runId?: string; requestId?: string; admission?: { level?: string; requestedTier?: string }; code?: string });
  const result = parsed.find(row => row.testKind === 'unit');
  const waiting = parsed.find(row => row.kind === 'launch-queue.waiting');
  assert.equal(code, 1);
  assert.ok(result, 'delivery must end with one intact TestRunResult');
  assert.equal(result.runId, runId);
  assert.equal(waiting?.requestId, requestId);
  assert.equal(waiting?.admission?.level, 'HOTFIX_ONLY');
  assert.equal(waiting?.admission?.requestedTier, 'normal');
  assert.equal(parsed.filter(row => row.kind === 'launch-queue.waiting').length, 1);
  assert.equal(parsed.some(row => row.code === 'PRODUCTION_ENTRY_FAILED'), false);
});
