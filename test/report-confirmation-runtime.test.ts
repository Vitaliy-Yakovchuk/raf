import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { createAgentReportWatcher, readPendingAgentReport, isAgentReportConfirmationPending, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import { ConfirmationTransientError } from '../src/report-confirmation-retry.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation } from '../src/task-checkbox-report.ts';
import { openStateStore } from '../src/state-store.ts';
import { reconcileTaskReservations, listTaskReservations, type TaskReservationDependencies } from '../src/task-reservations.ts';

const ok = { ok: true, issues: [] } as const;
function fixture(runId: string) {
  const request: AgentReportRequest = { tmpRoot: '/isolated/tmp', runId, address: 'implement', assignment: {
    root: '/isolated', baselineArchives: [], changes: [{ id: 'demo', items: [{ id: 'A.1', description: 'Implement' }] }],
  } };
  const report = { status: 'succeeded', answer: 'Done', changes: [{ id: 'demo', items: [{ id: 'A.1', status: 'succeeded' }] }] } as const;
  const raw = ` \n${JSON.stringify(report)}\n`;
  const state = { busy: true, checkbox: 0, removed: 0, results: [] as AgentReportResult[],
    diagnostics: [] as Parameters<AgentReportPorts['diagnostic']>[], pending: [] as unknown[] };
  const ports: AgentReportPorts = {
    confirmationRetry: { runner: 'selected', protocol: async () => ({ timeouts: { transitionMs: 40, pollMs: 5 } }), retainPending: async diagnostic => { state.pending.push(diagnostic); } },
    fs: { mkdir: async () => {}, readText: async () => raw, removeTree: async () => { state.removed++; } },
    watch: () => () => {}, process: { onExit: () => () => {} }, now: () => new Date().toISOString(),
    verifyAssignmentCompletion: async () => ok,
    confirmTaskCheckboxes: async () => { state.checkbox++; return state.busy ? { ...ok, ok: false, commits: [], awaitingArchive: false, transient: 'writer-busy' } : { ...ok, commits: [], awaitingArchive: false }; },
    result: async result => { state.results.push(result); }, diagnostic: async (...args) => { state.diagnostics.push(args); },
  };
  return { request, report, raw, ports, state };
}
async function eventually(predicate: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!predicate() && performance.now() < deadline) await pause(5);
  assert.ok(predicate());
}

test('runtime watcher retries a typed source race and busy writer without a file event', async t => {
  const f = fixture('runtime-release');
  f.ports.confirmTaskCheckboxes = async () => {
    if (++f.state.checkbox === 1) throw new ConfirmationTransientError('source-read-race', 'Guard observed concurrent bytes');
    return f.state.checkbox === 2 ? { ...ok, ok: false, commits: [], awaitingArchive: false, transient: 'writer-busy' } : { ...ok, commits: [], awaitingArchive: false };
  };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  assert.equal(f.state.results.length, 1);
  assert.equal(f.state.results[0].status, 'succeeded');
  assert.ok(f.state.checkbox >= 3);
  assert.deepEqual(f.state.results[0].report, f.report);
  assert.equal(await f.ports.fs.readText(watcher.path), f.raw);
  assert.deepEqual(f.state.diagnostics, []);
  await watcher.finish({ code: 9, signal: null });
  assert.equal(f.state.results.length, 1);
});

test('runtime watcher retains pending on exit and automatically accepts unchanged bytes later', async t => {
  const f = fixture('runtime-pending-exit');
  let version = 0;
  let notify: (() => void) | undefined;
  f.ports.confirmationRetry = { ...f.ports.confirmationRetry!, inputs: {
    snapshot: async () => String(version), subscribe: async listener => { notify = listener; return () => { notify = undefined; }; },
  } };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  assert.equal(isAgentReportConfirmationPending(f.request), true);
  await watcher.finish({ code: 1, signal: null });
  assert.equal(f.state.results.length, 0);
  assert.equal(f.state.removed, 0);
  assert.ok(f.state.pending.some(Boolean));
  assert.ok(f.state.diagnostics.length > 0);
  for (const [reason, snapshot] of f.state.diagnostics) {
    assert.match(reason, /Confirmation pending:/);
    assert.equal(snapshot, undefined, 'pending confirmation must not emit a rejection snapshot');
  }
  f.state.busy = false;
  version++;
  notify!();
  await eventually(() => f.state.results.length === 1 && f.state.removed === 1);
  assert.equal(f.state.results[0].status, 'succeeded');
  assert.equal(isAgentReportConfirmationPending(f.request), false);
});

test('disposed pending watcher retains its report for a fresh reconciliation reader', async () => {
  const f = fixture('runtime-restart');
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  await watcher.dispose();
  assert.equal(f.state.removed, 0);
  f.state.busy = false;
  const result = await readPendingAgentReport(f.request, f.ports);
  assert.equal(result?.status, 'succeeded');
  assert.equal(result?.report?.answer, f.report.answer);
  assert.equal(isAgentReportConfirmationPending(f.request), false);
});

test('runtime watcher rejects an untyped error containing busy/race without automatic polling', async t => {
  const f = fixture('runtime-rejection');
  f.ports.confirmTaskCheckboxes = async () => { f.state.checkbox++; throw Object.assign(new Error('busy/race EACCES'), { code: 'EACCES' }); };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  await pause(60);
  assert.equal(f.state.checkbox, 1);
  assert.equal(f.state.results.length, 0);
  assert.equal(f.state.diagnostics.length, 1);
  assert.equal(f.state.diagnostics[0][1]?.reportPath, watcher.path);
  assert.equal(Buffer.from(f.state.diagnostics[0][1]!.bytes!).toString(), f.raw);
});

test('real checkbox adapter classifies a live owner and preserves its lock before idempotent retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'raf-confirmation-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', args, { cwd: root })).stdout.trim();
  await git('init', '-q'); await git('config', 'user.name', 'RAF unit'); await git('config', 'user.email', 'unit@example.invalid');
  const directory = join(root, 'openspec', 'changes', 'demo');
  await mkdir(directory, { recursive: true });
  const tasks = join(directory, 'tasks.md');
  await writeFile(tasks, '- [ ] A.1 Implement\n- [ ] A.2 Neighbor\n');
  await git('add', 'openspec'); await git('commit', '-qm', 'baseline');
  const f = fixture('runtime-real-lock');
  const request = { ...f.request, assignment: { ...f.request.assignment, root } };
  const lock = join(root, '.git', 'raf-task-checkbox.lock');
  const owner = JSON.stringify({ kind: 'raf-task-checkbox-lock', pid: process.pid });
  await writeFile(lock, owner);
  let journal: readonly TaskCheckboxOperation[] = [];
  const ports = { verifyAssignmentCompletion: async () => ok,
    operations: { read: async () => journal, write: async (_run: string, rows: readonly TaskCheckboxOperation[]) => { journal = rows; } } };
  const busy = await prepareReportedTaskCheckboxes(request, f.report, ports);
  assert.equal(busy.transient, 'writer-busy');
  assert.equal(await readFile(lock, 'utf8'), owner);
  assert.match(await readFile(tasks, 'utf8'), /\[ \] A\.1/);
  await rm(lock);
  assert.equal((await prepareReportedTaskCheckboxes(request, f.report, ports)).ok, true);
  const head = await git('rev-parse', 'HEAD');
  assert.equal((await prepareReportedTaskCheckboxes(request, f.report, ports)).ok, true);
  assert.equal(await git('rev-parse', 'HEAD'), head);
  assert.equal(await readFile(tasks, 'utf8'), '- [x] A.1 Implement\n- [ ] A.2 Neighbor\n');
});

test('runtime reader fully validates replacement JSON after a transient without a fresh file event', async () => {
  const f = fixture('runtime-replaced');
  let raw = f.raw;
  f.ports.fs.readText = async () => raw;
  f.ports.confirmTaskCheckboxes = async () => {
    if (++f.state.checkbox === 1) {
      raw = JSON.stringify({ ...f.report, answer: 'Replacement' });
      return { ...ok, ok: false, commits: [], awaitingArchive: false, transient: 'writer-busy' };
    }
    return { ...ok, commits: [], awaitingArchive: false };
  };
  const result = await readPendingAgentReport(f.request, f.ports);
  assert.equal(result?.report?.answer, 'Replacement');
  assert.equal(f.state.checkbox, 2);
  assert.deepEqual(f.state.diagnostics, []);
});

test('runtime reader preserves an unavailable-byte rejection for an unreadable report', async () => {
  const f = fixture('runtime-unreadable');
  f.ports.fs.readText = async () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); };
  assert.equal(await readPendingAgentReport(f.request, f.ports), null);
  assert.equal(f.state.diagnostics.length, 1);
  assert.equal(f.state.diagnostics[0][1]?.bytes, null);
  assert.match(f.state.diagnostics[0][0], /Cannot read report.*Permission denied/);
  assert.equal(f.state.checkbox, 0);
});

test('dead runner claims survive SQLite reopen while confirmation is pending without inventing liveness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'raf-confirmation-claims-'));
  let store = openStateStore(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const runId = 'pending-claims';
  const boot = { machineId: 'machine', bootId: 'boot' };
  const identity = { pid: 41001, startedAt: '2026-10-22T09:00:00.000Z', runner: 'selected', runnerSessionId: 'native', tmuxSession: 'session', evidence: { ...boot, runId, command: 'fixture' } };
  const lease = { owner: { runId, addressId: 'implement', fence: 'fence' }, revision: 0 };
  store.sessionRepository.transaction(tx => tx.putSession({ runId, addressId: 'implement', revision: 0, state: 'running', process: identity }));
  store.taskReservationRepository.transaction(tx => tx.putTaskReservation({ lease, tasks: [{ key: { project: 'raf', changeId: 'demo', taskId: 'A.1' }, changeInstance: 'original', fingerprint: 'original-description' }], boot, stage: 'running', starter: identity, wrapper: identity, agent: identity }));
  let pending = true;
  const dependencies = (): TaskReservationDependencies => ({ store, deferAbandonedFinalization: true, retainPendingConfirmation: async () => pending,
    currentBoot: async () => boot, observe: async () => ({ state: 'exited', observedAt: '2026-10-24T00:00:00.000Z', exitCode: 1, evidence: 'Confirmed exit' }),
    resolveTasks: async () => [], newFence: () => 'unused' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await reconcileTaskReservations(dependencies());
    assert.deepEqual(result.retained, [lease]);
    assert.deepEqual(result.released, []);
    assert.equal(listTaskReservations(store).length, 1);
    assert.equal(store.sessionRepository.transaction(tx => tx.getSession(runId), 'read')?.result, undefined);
    if (attempt === 0) { store.close(); store = openStateStore(join(root, 'state.sqlite')); }
  }
  pending = false;
  const released = await reconcileTaskReservations(dependencies());
  assert.deepEqual(released.released, [lease.owner]);
  assert.equal(listTaskReservations(store).length, 0);
});
