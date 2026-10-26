import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import test from 'node:test';
import { createAgentReportWatcher, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';

function fixture(runId: string) {
  const request: AgentReportRequest = { tmpRoot: '/unit/report-wait', runId, address: 'worker',
    assignment: { root: '/unit/orchestrator', changes: [{ id: 'worker-wait', items: [{ id: '5.12', description: 'Complete assigned work' }] }] } };
  let bytes: string | null = JSON.stringify({ status: 'succeeded', answer: 'Done', changes: [{ id: 'worker-wait', items: [{ id: '5.12', status: 'succeeded' }] }] });
  let busy = true;
  let attempts = 0;
  let reads = 0;
  let listener: Parameters<AgentReportPorts['watch']>[1];
  const results: AgentReportResult[] = [];
  const ports: AgentReportPorts = {
    fs: { mkdir: async () => {}, readText: async () => { reads++; return bytes; }, removeTree: async () => {} },
    watch: (_path, callback) => { listener = callback; return () => {}; },
    process: { onExit: () => () => {} },
    confirmationRetry: { runner: 'codex', protocol: async () => ({ timeouts: { transitionMs: 1000, pollMs: 10 } }) },
    confirmTaskCheckboxes: async () => { attempts++; return { ok: !busy, budgetExhausted: busy, issues: [], commits: [], awaitingArchive: false }; },
    verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }),
    now: () => new Date().toISOString(), result: async result => { results.push(result); }, diagnostic: async () => {},
  };
  return { request, ports, results, counts: () => ({ attempts, reads }),
    release: () => { busy = false; },
    absent: () => { bytes = null; },
    notify: () => listener('rename', 'worker.json'),
  };
}

test('5.12 an idle worker adds no polling timers after report confirmation exhausts its budget', async t => {
  const f = fixture('exhausted');
  const timers: string[] = [];
  const hook = createHook({ init(_id, type) { if (type === 'Timeout') timers.push(type); } });
  t.after(() => hook.disable());
  hook.enable();
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  hook.disable();
  t.after(() => watcher.dispose());
  assert.equal(f.counts().attempts, 1);
  assert.equal(f.results.length, 0);
  assert.deepEqual(timers, [], 'pending confirmation must sleep on input changes, not repeatedly launch a fresh expensive cycle');
});

test('5.12 an unchanged pending report is freshly verified on its next input notification', async t => {
  const f = fixture('notification');
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  assert.equal(f.counts().attempts, 1);
  const before = f.counts().reads;
  f.release();
  await f.notify();
  assert.ok(f.counts().reads > before, 'a notification must recheck the report bytes');
  assert.equal(f.counts().attempts, 2);
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].status, 'succeeded');
  await f.notify();
  assert.equal(f.results.length, 1);
});

test('5.12 waiting for the first report neither polls nor verifies assignments', async t => {
  const f = fixture('absent');
  f.absent();
  const timers: string[] = [];
  const hook = createHook({ init(_id, type) { if (type === 'Timeout') timers.push(type); } });
  t.after(() => hook.disable());
  hook.enable();
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  hook.disable();
  t.after(() => watcher.dispose());
  assert.deepEqual(timers, []);
  assert.equal(f.counts().attempts, 0);
  assert.equal(f.counts().reads, 1);
});
