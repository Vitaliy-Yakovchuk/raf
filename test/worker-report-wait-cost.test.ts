import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentReportWatcher, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import { onConfirmationInputChange, reportConfirmationInputs } from '../src/report-confirmation-inputs.ts';

function fixture(runId: string) {
  const request: AgentReportRequest = { tmpRoot: '/unit/report-wait', runId, address: 'worker',
    assignment: { root: '/unit/orchestrator', changes: [{ id: 'worker-wait', items: [{ id: '5.12', description: 'Complete assigned work' }] }] } };
  let bytes: string | null = JSON.stringify({ status: 'succeeded', answer: 'Done', changes: [{ id: 'worker-wait', items: [{ id: '5.12', status: 'succeeded' }] }] });
  let busy = true;
  let attempts = 0;
  let reads = 0;
  let listener: Parameters<AgentReportPorts['watch']>[1];
  let inputListener: (() => void) | undefined;
  let inputVersion = 0;
  let stopped = 0;
  let accepted!: () => void;
  const acceptance = new Promise<void>(resolve => { accepted = resolve; });
  const results: AgentReportResult[] = [];
  const ports: AgentReportPorts = {
    fs: { mkdir: async () => {}, readText: async () => { reads++; return bytes; }, removeTree: async () => {} },
    watch: (_path, callback) => { listener = callback; return () => {}; },
    process: { onExit: () => () => {} },
    confirmationRetry: { runner: 'codex', protocol: async () => ({ timeouts: { transitionMs: 1000, pollMs: 10 } }) },
    confirmTaskCheckboxes: async () => { attempts++; return { ok: !busy, budgetExhausted: busy, issues: [], commits: [], awaitingArchive: false }; },
    verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }),
    now: () => new Date().toISOString(), result: async result => { results.push(result); accepted(); }, diagnostic: async () => {},
  };
  return { request, ports, results, counts: () => ({ attempts, reads }),
    release: () => { busy = false; },
    absent: () => { bytes = null; },
    notify: () => listener('rename', 'worker.json'),
    observeInputs: () => Object.assign(ports.confirmationRetry!, { inputs: {
      snapshot: async () => String(inputVersion),
      subscribe: async (callback: () => void) => { inputListener = callback; return () => { stopped++; inputListener = undefined; }; },
    } }),
    changeInput: () => { assert.ok(inputListener, 'pending confirmation must subscribe to its inputs'); inputVersion++; inputListener(); },
    inputState: () => ({ watching: !!inputListener, stopped }), acceptance,
    changeBeforeSubscription: () => { inputVersion++; inputListener?.(); },
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

test('5.12 a writer released before input subscription is rechecked within the same deadline', { timeout: 5000 }, async t => {
  const f = fixture('input-arm-race');
  f.observeInputs();
  const original = f.ports.confirmTaskCheckboxes!;
  f.ports.confirmTaskCheckboxes = async (...args) => {
    const result = await original(...args);
    if (result.budgetExhausted) {
      f.release(); f.changeBeforeSubscription();
      return { ...result, budgetExhausted: false, transient: 'writer-busy' as const };
    }
    return result;
  };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  assert.equal(f.results.length, 1);
  assert.equal(f.counts().attempts, 2);
  assert.equal(f.inputState().watching, false);
});

test('5.12 native input observations ignore completed own lock churn and wake on foreign lock release', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'raf-report-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture('native-input');
  const directory = join(root, '.git');
  const source = join(root, 'openspec/changes/worker-wait');
  await mkdir(directory); await mkdir(source, { recursive: true });
  await writeFile(join(source, 'tasks.md'), '- [ ] 5.12 Complete assigned work\n');
  const inputs = reportConfirmationInputs({ ...f.request, assignment: { ...f.request.assignment, root }, reportedCommits: {
    contract: 'reported-commits-v1', runId: f.request.runId, reportPath: join(f.request.tmpRoot, f.request.runId, 'worker.json'), writeBoundaries: [root],
    repositories: [{ repositoryRoot: root, gitDirectory: directory, commonDirectory: directory, objectFormat: 'sha1', launchHead: 'a'.repeat(40) }],
  } });
  const before = await inputs.snapshot();
  const lock = join(directory, 'raf-task-checkbox.lock');
  await writeFile(lock, 'own temporary lock'); await unlink(lock);
  assert.equal(await inputs.snapshot(), before, 'own lock creation/removal must not sustain a confirmation loop');
  await writeFile(lock, 'known live foreign owner');
  const blocked = await inputs.snapshot();
  let stop = () => {};
  t.after(() => stop());
  const released = new Promise<void>((resolve, reject) => {
    void onConfirmationInputChange(inputs, blocked, error => error ? reject(error) : resolve()).then(dispose => { stop = dispose; }, reject);
  });
  await unlink(lock);
  await released;
  assert.notEqual(await inputs.snapshot(), blocked);
});

test('5.12 writer release accepts unchanged report bytes automatically after the runner exits', { timeout: 5000 }, async t => {
  const f = fixture('input-release');
  f.observeInputs();
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  await watcher.finish({ code: 0, signal: null });
  assert.equal(f.results.length, 0);
  assert.equal(f.inputState().watching, true);
  const before = f.counts().reads;
  f.release();
  f.changeInput();
  await f.acceptance;
  assert.ok(f.counts().reads > before);
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].status, 'succeeded');
});

test('5.12 releasing an in-process confirmation writer wakes another report without file changes', { timeout: 5000 }, async t => {
  const owner = fixture('local-owner');
  const waiting = fixture('local-waiter');
  owner.release(); waiting.release(); waiting.observeInputs();
  let entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const original = owner.ports.confirmTaskCheckboxes!;
  owner.ports.confirmTaskCheckboxes = async (...args) => { entered(); await released; return original(...args); };
  const first = createAgentReportWatcher(owner.request, owner.ports);
  t.after(release);
  await holding;
  let subscribed!: () => void;
  const armed = new Promise<void>(resolve => { subscribed = resolve; });
  const inputs = waiting.ports.confirmationRetry!.inputs!;
  const subscribe = inputs.subscribe.bind(inputs);
  inputs.subscribe = async callback => { const stop = await subscribe(callback); subscribed(); return stop; };
  const second = createAgentReportWatcher(waiting.request, waiting.ports);
  await armed;
  release();
  const watchers = await Promise.all([first, second]);
  t.after(async () => { for (const watcher of watchers) await watcher.dispose(); });
  assert.equal(owner.results.length, 1);
  assert.equal(waiting.results.length, 1, 'local writer release must resume the unchanged waiting report');
});

test('5.12 pending input subscriptions close on disposal without deleting the report', async () => {
  const f = fixture('input-dispose');
  f.observeInputs();
  let removed = 0;
  f.ports.fs.removeTree = async () => { removed++; };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  assert.equal(f.inputState().watching, true);
  await watcher.dispose();
  assert.equal(f.inputState().watching, false);
  assert.ok(f.inputState().stopped > 0);
  assert.equal(removed, 0);
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
