import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentReportWatcher, readPendingAgentReport } from '../src/agent-report.ts';
import type { AgentReportPorts, AgentReportResult, AgentReportRequest, AgentReportExit } from '../src/agent-report.ts';
import type { AssignmentVerification } from '../src/assignment.ts';

const request: AgentReportRequest = {
  tmpRoot: '/workspace/tmp', runId: 'run-one', address: 'implement-demo',
  assignment: { root: '/workspace', baselineArchives: [], changes: [{ id: 'demo', items: [{ id: '1.1', description: 'Deliver selected task' }] }] },
};
const valid = { status: 'succeeded', answer: 'Done', changes: [{ id: 'demo', items: [{ id: '1.1', status: 'succeeded' }] }] };
function fixture() {
  const files = new Map<string, string>();
  const results: AgentReportResult[] = [];
  const reads: string[] = [];
  const removed: string[] = [];
  const diagnostics: string[] = [];
  const verifications: unknown[] = [];
  const watches: { directory: string; listener: Parameters<AgentReportPorts['watch']>[1]; stopped: boolean }[] = [];
  let exitListener: ((exit: AgentReportExit) => Promise<void>) | undefined;
  let processStopped = false;
  let verification: AssignmentVerification = { ok: true, issues: [] };
  let verificationError: Error | undefined;
  const ports: AgentReportPorts = {
    fs: {
      async mkdir() {},
      async readText(path) { reads.push(path); return files.get(path) ?? null; },
      async removeTree(path) { removed.push(path); for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key); },
    },
    watch(directory, listener) { const entry = { directory, listener, stopped: false }; watches.push(entry); return () => { entry.stopped = true; }; },
    process: { onExit(listener) { exitListener = listener; return () => { processStopped = true; }; } },
    now: () => '2026-10-21T10:00:00.000Z',
    async verifyAssignmentCompletion(snapshot, archives) { verifications.push({ snapshot, archives }); if (verificationError) throw verificationError; return verification; },
    async result(result) { results.push(result); },
    async diagnostic(reason) { diagnostics.push(reason); },
  };
  return { ports, files, results, reads, removed, diagnostics, verifications, watches,
    setVerification(value: AssignmentVerification) { verification = value; },
    failVerification() { verificationError = new Error('OpenSpec unavailable'); },
    processStopped: () => processStopped,
    async exit(code = 1) { assert.ok(exitListener); await exitListener({ code, signal: null }); },
    async notify(event: 'create' | 'modify' | 'rename' = 'modify') { await watches[0].listener(event, 'implement-demo.json'); },
  };
}
const path = '/workspace/tmp/run-one/implement-demo.json';

test('initial read accepts verified report with extensions and addresses the result event', async () => {
  const f = fixture();
  f.files.set(path, JSON.stringify({ ...valid, extra: { informational: true } }));
  const watcher = await createAgentReportWatcher(request, f.ports);
  assert.equal(watcher.path, path);
  assert.deepEqual(f.reads, [path]);
  assert.equal(f.watches[0].directory, '/workspace/tmp/run-one');
  assert.deepEqual(f.verifications, [{ snapshot: request.assignment, archives: {} }]);
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].event, 'agent.succeeded');
  assert.equal(f.results[0].id, request.address);
  assert.equal(f.results[0].runId, request.runId);
  assert.equal(f.results[0].at, f.ports.now());
});

for (const event of ['create', 'modify', 'rename'] as const) test(`${event} discovers a completed report after a partial write`, async () => {
  const f = fixture();
  await createAgentReportWatcher(request, f.ports);
  f.files.set(path, '{"status":"failed"');
  await f.notify(event);
  assert.equal(f.results.length, 0);
  assert.equal(f.verifications.length, 0);
  f.files.set(path, JSON.stringify(valid));
  await f.notify(event);
  assert.equal(f.results[0].status, 'succeeded');
});

for (const bad of [null, {}, { ...valid, status: 'done' }, { ...valid, answer: undefined }, { ...valid, changes: [] }, { ...valid, changes: [{ id: 'other', items: [] }] }]) test(`malformed or mismatched report is not accepted: ${JSON.stringify(bad)}`, async () => {
  const f = fixture();
  f.files.set(path, JSON.stringify(bad));
  await createAgentReportWatcher(request, f.ports);
  assert.equal(f.results.length, 0);
});

test('concurrent duplicate notifications emit exactly one result', async () => {
  const f = fixture();
  await createAgentReportWatcher(request, f.ports);
  f.files.set(path, JSON.stringify(valid));
  await Promise.all([f.notify(), f.notify('rename'), f.notify('create')]);
  assert.equal(f.results.length, 1);
});

test('final process read catches an unannounced report and preserves success after crash', async () => {
  const f = fixture();
  await createAgentReportWatcher(request, f.ports);
  f.files.set(path, JSON.stringify(valid));
  await f.exit(137);
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].event, 'agent.succeeded');
});

test('accepted success survives later malformed report and process failure', async () => {
  const f = fixture();
  f.files.set(path, JSON.stringify(valid));
  await createAgentReportWatcher(request, f.ports);
  f.files.set(path, '{');
  await f.exit(1);
  assert.deepEqual(f.results.map(result => result.event), ['agent.succeeded']);
});

test('crash without a valid report emits failure only once', async () => {
  const f = fixture();
  const watcher = await createAgentReportWatcher(request, f.ports);
  await f.exit(1);
  await watcher.finish({ code: 1, signal: null });
  assert.deepEqual(f.results.map(result => result.event), ['agent.failed']);
  assert.equal(f.results[0].id, request.address);
});

test('reported failure records partial task outcomes without verifying success', async () => {
  const f = fixture();
  const report = { ...valid, status: 'failed', changes: [{ id: 'demo', items: [{ id: '1.1', status: 'failed', reason: 'Still open' }] }] };
  f.files.set(path, JSON.stringify(report));
  await createAgentReportWatcher(request, f.ports);
  assert.equal(f.results[0].event, 'agent.failed');
  assert.deepEqual(f.results[0].report, report);
  assert.equal(f.verifications.length, 0);
});

for (const unavailable of [false, true]) test(`unconfirmed assignment cannot succeed, unavailable=${unavailable}`, async () => {
  const f = fixture();
  f.setVerification({ ok: false, issues: [{ change: 'demo', requestedItems: ['1.1'], reason: 'Task remains open', foundItems: [], archives: [], remedy: 'Complete task' }] });
  if (unavailable) f.failVerification();
  f.files.set(path, JSON.stringify(valid));
  await createAgentReportWatcher(request, f.ports);
  assert.equal(f.results.length, 0);
  assert.ok(f.diagnostics.length > 0);
  await f.exit(1);
  assert.deepEqual(f.results.map(result => result.event), ['agent.failed']);
});

test('archive claim reaches the injected OpenSpec verifier', async () => {
  const f = fixture();
  f.files.set(path, JSON.stringify({ ...valid, changes: [{ ...valid.changes[0], archive: '2026-10-21-demo' }] }));
  await createAgentReportWatcher(request, f.ports);
  assert.deepEqual(f.verifications, [{ snapshot: request.assignment, archives: { demo: '2026-10-21-demo' } }]);
});

test('reused address reads only its own run and cleans temporary artifacts', async () => {
  const f = fixture();
  f.files.set('/workspace/tmp/previous-run/implement-demo.json', JSON.stringify(valid));
  const watcher = await createAgentReportWatcher(request, f.ports);
  assert.deepEqual(f.reads, [path]);
  assert.equal(f.results.length, 0);
  await f.exit(1);
  await watcher.dispose();
  assert.deepEqual(f.removed, ['/workspace/tmp/run-one']);
  assert.ok(f.watches[0].stopped);
  assert.ok(f.processStopped());
  assert.ok(f.files.has('/workspace/tmp/previous-run/implement-demo.json'));
});

test('[pending-report] a verified report without a live watcher becomes the same addressed result, without watching or cleanup', async () => {
  const f = fixture();
  f.files.set(path, JSON.stringify({ ...valid, extra: { session: 'later' } }));
  const result = await readPendingAgentReport(request, f.ports);
  assert.deepEqual(f.reads, [path]);
  assert.deepEqual(f.verifications, [{ snapshot: request.assignment, archives: {} }]);
  assert.deepEqual(result, { runId: request.runId, id: request.address, event: 'agent.succeeded', status: 'succeeded', at: f.ports.now(), report: { ...valid, extra: { session: 'later' } } });
  assert.equal(f.watches.length, 0);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.results, [], 'the caller, not the reader, records the result');
});

test('[pending-report] a valid failed report is returned without OpenSpec verification', async () => {
  const f = fixture();
  const report = { ...valid, status: 'failed', changes: [{ id: 'demo', items: [{ id: '1.1', status: 'failed', reason: 'Contradicts the spec' }] }] };
  f.files.set(path, JSON.stringify(report));
  const result = await readPendingAgentReport(request, f.ports);
  assert.equal(result?.event, 'agent.failed');
  assert.equal(result?.status, 'failed');
  assert.deepEqual(result?.report, report);
  assert.equal(result?.exit, undefined, 'a pending report is not a process exit');
  assert.equal(f.verifications.length, 0);
});

test('[pending-report] an absent report yields nothing and no diagnostic', async () => {
  const f = fixture();
  assert.equal(await readPendingAgentReport(request, f.ports), null);
  assert.deepEqual(f.diagnostics, []);
});

for (const [label, content] of [['partial JSON', '{"status":"succeeded"'], ['assignment mismatch', JSON.stringify({ ...valid, changes: [{ id: 'other', items: [{ id: '1.1', status: 'succeeded' }] }] })], ['failed item without reason', JSON.stringify({ ...valid, status: 'failed', changes: [{ id: 'demo', items: [{ id: '1.1', status: 'failed' }] }] })]] as const) test(`[pending-report] ${label} is not accepted and is diagnosed`, async () => {
  const f = fixture();
  f.files.set(path, content);
  assert.equal(await readPendingAgentReport(request, f.ports), null);
  assert.ok(f.diagnostics.length > 0, label);
});

for (const unavailable of [false, true]) test(`[pending-report] unconfirmed OpenSpec completion keeps a succeeded report pending, unavailable=${unavailable}`, async () => {
  const f = fixture();
  f.setVerification({ ok: false, issues: [{ change: 'demo', requestedItems: ['1.1'], reason: 'Task remains open', foundItems: [], archives: [], remedy: 'Complete task' }] });
  if (unavailable) f.failVerification();
  f.files.set(path, JSON.stringify(valid));
  assert.equal(await readPendingAgentReport(request, f.ports), null);
  assert.ok(f.diagnostics.length > 0);
});

test('[pending-report] archive claims reach the verifier and the reader stays within its own run', async () => {
  const f = fixture();
  f.files.set('/workspace/tmp/previous-run/implement-demo.json', JSON.stringify(valid));
  assert.equal(await readPendingAgentReport(request, f.ports), null);
  f.files.set(path, JSON.stringify({ ...valid, changes: [{ ...valid.changes[0], archive: '2026-10-22-demo' }] }));
  assert.equal((await readPendingAgentReport(request, f.ports))?.status, 'succeeded');
  assert.deepEqual(f.verifications, [{ snapshot: request.assignment, archives: { demo: '2026-10-22-demo' } }]);
  assert.ok(f.reads.every(read => read === path));
});

test('[pending-report] invalid run directory components are rejected', async () => {
  const f = fixture();
  await assert.rejects(() => readPendingAgentReport({ ...request, runId: '../escape' }, f.ports));
  await assert.rejects(() => readPendingAgentReport({ ...request, tmpRoot: 'relative' }, f.ports));
  assert.deepEqual(f.reads, []);
});
