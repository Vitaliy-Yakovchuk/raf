import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { createAgentReportWatcher, readPendingAgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import { ConfirmationTransientError } from '../src/report-confirmation-retry.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation } from '../src/task-checkbox-report.ts';

const ok = { ok: true, issues: [] } as const;
function fixture(runId: string) {
  const request: AgentReportRequest = { tmpRoot: '/isolated/tmp', runId, address: 'implement', assignment: {
    root: '/isolated', baselineArchives: [], changes: [{ id: 'demo', items: [{ id: 'A.1', description: 'Implement' }] }],
  } };
  const report = { status: 'succeeded', answer: 'Done', changes: [{ id: 'demo', items: [{ id: 'A.1', status: 'succeeded' }] }] } as const;
  const raw = ` \n${JSON.stringify(report)}\n`;
  const state = { busy: true, sources: 0, checkbox: 0, removed: 0, results: [] as AgentReportResult[],
    diagnostics: [] as Parameters<AgentReportPorts['diagnostic']>[] };
  const ports: AgentReportPorts = {
    confirmationRetry: { runner: 'selected', protocol: async () => ({ timeouts: { transitionMs: 40, pollMs: 5 } }) },
    fs: { mkdir: async () => {}, readText: async () => raw, removeTree: async () => { state.removed++; } },
    watch: () => () => {}, process: { onExit: () => () => {} }, now: () => new Date().toISOString(),
    verifyAssignmentSourceIdentity: async () => { state.sources++; return ok; },
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
  f.ports.verifyAssignmentSourceIdentity = async () => {
    if (++f.state.sources === 1) throw new ConfirmationTransientError('source-read-race', 'Guard observed concurrent bytes');
    return ok;
  };
  f.ports.confirmTaskCheckboxes = async () => ++f.state.checkbox === 1
    ? { ...ok, ok: false, commits: [], awaitingArchive: false, transient: 'writer-busy' }
    : { ...ok, commits: [], awaitingArchive: false };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  assert.equal(f.state.results.length, 1);
  assert.equal(f.state.results[0].status, 'succeeded');
  assert.ok(f.state.sources >= 5);
  assert.deepEqual(f.state.results[0].report, f.report);
  assert.equal(await f.ports.fs.readText(watcher.path), f.raw);
  assert.deepEqual(f.state.diagnostics, []);
  await watcher.finish({ code: 9, signal: null });
  assert.equal(f.state.results.length, 1);
});

test('runtime watcher rejects an untyped error containing busy/race without automatic polling', async t => {
  const f = fixture('runtime-rejection');
  f.ports.verifyAssignmentSourceIdentity = async () => { f.state.sources++; throw Object.assign(new Error('busy/race EACCES'), { code: 'EACCES' }); };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  await pause(60);
  assert.equal(f.state.sources, 1);
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
  const ports = { verifySourceIdentity: async () => ok, verifyAssignmentCompletion: async () => ok,
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
  assert.equal(f.state.sources, 0);
});

