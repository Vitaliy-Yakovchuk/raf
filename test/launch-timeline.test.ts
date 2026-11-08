import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLaunchWrapper, type LaunchWrapperPorts, type LaunchWrapperRequest } from '../src/launch-wrapper.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raf-launch-timeline-'));
  const ready = gate();
  const delivered = gate();
  const accepted = gate();
  const exited = gate();
  const events: string[] = [];
  const identity = { pid: process.pid, startedAt: new Date().toISOString(), runner: 'codex' as const,
    runnerSessionId: '38af550b-c12a-4246-9f1c-fd6448a3f603', tmuxSession: 'timeline', evidence: { command: 'codex', runId: 'timeline' } };
  const request: LaunchWrapperRequest = { tmpRoot: root, statePath: join(root, 'state.sqlite'), cwd: root,
    runId: 'timeline', address: 'timeline', tmuxSession: 'timeline', brief: 'Assignment text must stay out of timing records',
    selection: { runner: 'codex', model: 'configured-model', effort: 'configured-effort' }, readinessTimeoutMs: 10000,
    assignment: { root, changes: [], baselineArchives: [] } };
  const ports: LaunchWrapperPorts = {
    transport: {
      startWithoutInput: async () => { events.push('spawn'); },
      waitReady: async () => { await ready.promise; return { state: 'ready', runnerSessionId: identity.runnerSessionId }; },
      ownership: async () => ({ state: 'owned', identity, processKind: 'agent' }),
      deliver: async () => { events.push('delivery'); await delivered.promise; },
      waitExit: async () => { await exited.promise; return { code: 0, signal: null }; },
      stop: async () => {},
    },
    report: {
      fs: { mkdir: path => mkdir(path, { recursive: true }).then(() => {}), readText: async () => null, removeTree: async () => {} },
      watch: () => () => {}, now: () => new Date().toISOString(), verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }),
      diagnostic: async () => {},
    },
    lifecycle: { started: async () => { events.push('started'); }, acceptReport: async () => {}, finish: async () => {}, failed: async () => {} },
    handshake: async () => { events.push('handshake'); accepted.resolve(); },
  };
  return { root, request, ports, ready, delivered, accepted, exited, events };
}

test('launch records separate runner readiness and accepted delivery before its handshake', async () => {
  const f = await fixture();
  const work = runLaunchWrapper(f.request, f.ports);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.events.includes('handshake'), false);
    f.ready.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.events.includes('handshake'), false);
    f.delivered.resolve();
    await f.accepted.promise;
    const text = await readFile(join(f.root, 'timeline', 'launch-timeline.jsonl'), 'utf8').catch(() => '');
    const rows = text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
    assert.deepEqual(rows.map(row => row.stage), [
      'tmux-spawn-start', 'tmux-spawn-end', 'readiness-start', 'readiness-end',
      'delivery-start', 'delivery-end', 'lifecycle-start', 'lifecycle-end', 'handshake-start',
    ]);
    for (const row of rows) {
      assert.equal(row.runId, f.request.runId);
      assert.equal(row.pid, process.pid);
      assert.ok(Number.isFinite(row.atMs));
      assert.equal(new Date(row.atMs).toISOString(), row.at);
    }
    assert.equal(text.includes(f.request.brief), false);
  } finally {
    f.ready.resolve(); f.delivered.resolve(); f.exited.resolve();
    await work;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('production launch excludes duplicate worker health delivery from the handshake path', async t => {
  const { configuration, derivedLaunch, fixture: productionFixture, eventually } = await import('./production-fixture.ts');
  const { fileURLToPath } = await import('node:url');
  const f = await productionFixture(t, { productionQa: true });
  const executable = join(f.binRoot, 'codex');
  const runnerPidPath = join(f.root, 'runner.pid');
  f.trackPidFile(runnerPidPath);
  const synthetic = await readFile(new URL('../evidence/hotfix-1.1.6/synthetic-codex.mjs', import.meta.url), 'utf8');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(executable, synthetic.replace('/* fixture options */', `const runnerPidPath = ${JSON.stringify(runnerPidPath)};`), { mode: 0o700 });
  const workerPath = fileURLToPath(f.runtimeUrl);
  const worker = await readFile(workerPath, 'utf8');
  assert.ok(worker.includes('try { await settleWorkerHealth(); } catch'));
  await writeFile(workerPath, worker.replace('try { await settleWorkerHealth(); } catch',
    'try { await new Promise(resolve => setTimeout(resolve, 3500)); await settleWorkerHealth(); } catch'));
  const settings = JSON.parse(await readFile(join(f.confRoot, 'raf.json'), 'utf8')).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
  const { executeCommand } = await import('../src/os-runtime.ts');
  const services = await f.createProductionServices(f.store, configuration, f.context, {
    execute: command => command.executable === 'tmux'
      ? executeCommand({ ...command, executable: f.realTmuxPath, args: ['-S', join(f.tmpRoot, 'tmux', 'server.sock'), ...command.args] })
      : f.execute(command),
    protocolSettings: [{ ...settings, executable, version: '0.133.0', baseArgs: [] }],
  });
  const runId = 'slow-health';
  const { task, launch } = await derivedLaunch(services, f, {
    runId, addressId: f.params.id, tmuxSession: runId,
    activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd },
    assignment: f.assignment, selection: { status: 'selected', runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reason: 'synthetic fixture', quota: 'unknown' },
    statePath: f.statePath, tmpRoot: f.tmpRoot,
  });
  const prepared = await services.prepareReport(launch);
  const admission = await services.reserve({ ...launch, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
  assert.equal(admission.admitted, true);
  const start = performance.now();
  const started = await services.adapter.start({ selection: launch.selection, tmuxSession: runId, cwd: f.cwd,
    brief: 'Synthetic launch timing only. BRIEF_END', reportWrapper: prepared.reportWrapper });
  const wallMs = performance.now() - start;
  const readTimeline = async () => (await readFile(join(f.tmpRoot, runId, 'launch-timeline.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const workerIdentity = (await readTimeline()).find(row => row.stage === 'worker-start');
  assert.ok(workerIdentity, 'worker identity is recorded before the launch handshake');
  f.trackProcess(workerIdentity.pid);
  const identity = await services.verifyStarted(launch, started);
  f.trackProcess(identity.pid);
  const rows = await eventually(readTimeline, rows => rows.some(row => row.stage === 'worker-health-end'), 'deferred worker health completes');
  const at = (stage: string) => {
    const row = rows.find(row => row.stage === stage);
    assert.ok(row, `Missing stage ${stage}`);
    return row.atMs;
  };
  const runnerMs = at('readiness-end') - at('readiness-start');
  const overheadMs = wallMs - runnerMs;
  t.diagnostic(JSON.stringify({ wallMs, runnerMs, overheadMs, timeline: rows }));
  assert.ok(at('worker-health-start') >= at('handshake-start'));
  assert.ok(at('worker-health-end') > at('handshake-received'));
  assert.ok(wallMs < 3000, `synthetic launch took ${wallMs}ms before its accepted handshake`);
  assert.ok(overheadMs < 3000, `raf overhead ${overheadMs}ms includes an unrelated 3500ms health delivery`);
  assert.ok(at('delivery-end') <= at('handshake-start'));
});
