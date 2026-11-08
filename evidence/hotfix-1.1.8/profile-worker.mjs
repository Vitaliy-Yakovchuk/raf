// Standalone diagnostic profile of the same production fixture used by the unit regression.
// This is not an additional unit run or a substitute for raf TestRunResult.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const baseline = process.argv.includes('--baseline');
const cleanups = [];
const t = { after: action => cleanups.push(action) };
try {

  const { configuration, derivedLaunch, fixture: productionFixture, eventually } = await import('../../test/production-fixture.ts');
  const { fileURLToPath } = await import('node:url');
  const f = await productionFixture(t, { productionQa: true });
  const executable = join(f.binRoot, 'codex');
  const runnerPidPath = join(f.root, 'runner.pid');
  f.trackPidFile(runnerPidPath);
  const synthetic = await readFile(new URL('../hotfix-1.1.6/synthetic-codex.mjs', import.meta.url), 'utf8');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(executable, synthetic.replace('/* fixture options */', `const runnerPidPath = ${JSON.stringify(runnerPidPath)};`), { mode: 0o700 });
  const workerPath = fileURLToPath(f.runtimeUrl);
  let worker = await readFile(workerPath, 'utf8');
  if (baseline) {
    const deferred = worker.indexOf("        recordLaunchStage(request, 'worker-health-start');");
    const deferredEnd = worker.indexOf('        stopHealthSummary = scheduleWorkerHealthSummary(store, context.orchestratorRoot, settleWorkerHealth);', deferred);
    const end = deferredEnd + '        stopHealthSummary = scheduleWorkerHealthSummary(store, context.orchestratorRoot, settleWorkerHealth);'.length;
    const health = worker.slice(deferred, end);
    assert.ok(deferred > 0 && deferredEnd > deferred);
    worker = worker.slice(0, deferred) + worker.slice(end);
    worker = worker.replace('    const hotfix = manifest.workspaceRoute?.hotfix;', health + '\n    const hotfix = manifest.workspaceRoute?.hotfix;');
  }
  assert.ok(worker.includes('try { await settleWorkerHealth(); } catch'));
  await writeFile(workerPath, worker.replace('try { await settleWorkerHealth(); } catch',
    'try { await new Promise(resolve => setTimeout(resolve, 3500)); await settleWorkerHealth(); } catch'));
  const settings = JSON.parse(await readFile(join(f.confRoot, 'raf.json'), 'utf8')).runnerProtocols.find((row) => row.runner === 'codex');
  const { executeCommand } = await import('../../src/os-runtime.ts');
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
  const at = (stage) => {
    const row = rows.find(row => row.stage === stage);
    assert.ok(row, `Missing stage ${stage}`);
    return row.atMs;
  };
  const runnerMs = at('readiness-end') - at('readiness-start');
  const overheadMs = wallMs - runnerMs;
  await writeFile(new URL(baseline ? './fixture-baseline.json' : './fixture-green.json', import.meta.url),
    JSON.stringify({ scope: 'Isolated production worker, synthetic native runner; explicit 3500ms unrelated health delivery; baseline restores pre-handshake health placement', baseline, wallMs, runnerMs, overheadMs, timeline: rows }, null, 2));
  console.log(JSON.stringify({baseline, wallMs, runnerMs, overheadMs}));
  if (!baseline) assert.ok(wallMs < 3000);

} finally { for (const cleanup of cleanups) await cleanup(); }
