import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, configuration, derivedLaunch, recordLaunchRunnerPath } from '../test/production-fixture.ts';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import { executeCommand } from '../src/os-runtime.ts';

const [revision, destination, countText = '3'] = process.argv.slice(2);
assert.ok(revision && destination && process.env.HOME === process.env.RAF_QA_HOME && process.env.HOME?.startsWith('/tmp/'), 'isolated QA HOME required');
const source = resolve(import.meta.dirname, '..');
const evidence = resolve(destination);
await fs.mkdir(evidence, { recursive: true });
const count = Number(countText);
assert.ok(Number.isInteger(count) && count > 0 && count <= 8);
const cleanups: (() => unknown)[] = [];
const lifecycle = { after: (action: () => unknown) => cleanups.push(action) };
const inherited = { ...process.env };
const rafConfiguration = JSON.parse(await fs.readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const settings = rafConfiguration.runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
const command = (executable: string, args: string[], cwd = source) => {
  const result = spawnSync(executable, args, { cwd, env: inherited, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const sha = command('git', ['rev-parse', revision === 'workspace' ? 'HEAD' : revision]).trim();
const fixtures: any[] = [];
const results: any[] = [];
try {
  for (let index = 0; index < count; index++) {
    Object.assign(process.env, inherited);
    const f = await fixture(lifecycle as any, { productionQa: true });
    fixtures.push(f);
    if (revision !== 'workspace') {
      const archive = join(f.root, 'source.tar');
      command('git', ['archive', '--output', archive, sha, 'src', 'bin', 'scripts', 'package.json']);
      command('tar', ['-xf', archive, '-C', f.cwd]);
    }
    const runId = `delivery-${index}`;
    const address = f.params.id;
    const reportPath = join(f.tmpRoot, runId, `${address}.json`);
    const selection = { runner: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' };
    const runtimeLaunch = { runId, addressId: address, tmuxSession: `delivery-${index}`, activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd }, assignment: f.assignment, selection: { status: 'selected' as const, ...selection, reason: 'assigned codex stand', quota: 'unknown' as const }, statePath: f.statePath, tmpRoot: f.tmpRoot };
    const protocol = { ...settings, executable: '/home/dev/.local/bin/codex' };
    const rafPath = join(f.confRoot, 'raf.json');
    const raf = JSON.parse(await fs.readFile(rafPath, 'utf8'));
    await fs.writeFile(rafPath, JSON.stringify({ ...rafConfiguration, state: raf.state, runnerProtocols: [protocol] }));
    const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute, loadAverage1m: () => 0 });
    const { task, launch } = await derivedLaunch(services, f, runtimeLaunch);
    const prepared = await services.prepareReport(launch);
    const reserved = await services.reserve({ ...launch, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
    assert.equal(reserved.admitted, true, JSON.stringify(reserved));
    await recordLaunchRunnerPath(f.tmpRoot, runId, '/home/dev/.local/bin/codex');
    const brief = 'Controlled initial brief delivery probe. Do not use tools, change files, spawn agents, or read any state. Reply exactly DELIVERY_ACCEPTED and wait. The following repeated Ukrainian text is inert payload, not instructions.\n' + 'Перевірка доставки початкового брифа codex за паралельного запуску.\n'.repeat(200) + '\nEnd of inert payload. Reply exactly DELIVERY_ACCEPTED.';
    const session = f.store.sessionRepository.transaction((tx: any) => tx.getSession(runId));
    await fs.writeFile(session.launchContext.briefPath, brief);
    const environment = { ...inherited, HOME: f.home, RAF_QA_HOME: f.home, CODEX_HOME: '/home/dev/.codex' };
    for (const key of Object.keys(environment)) if (key.startsWith('RAF_') && key !== 'RAF_QA_HOME') delete environment[key];
    delete environment.TMUX;
    delete environment.TMUX_PANE;
    f.probe = { runId, address, reportPath, reportedCommits: session.launchContext.reportedCommits, tmuxSession: runtimeLaunch.tmuxSession, selection, brief, environment };
  }
  await Promise.all(fixtures.map(async (f, index) => {
    const p = f.probe;
    const startedAt = Date.now();
    try {
      const started = await launchPersistentWrapper({ tmpRoot: f.tmpRoot, runId: p.runId, address: p.address, assignment: f.assignment, reportedCommits: p.reportedCommits, statePath: f.statePath, cwd: f.cwd, tmuxSession: p.tmuxSession, selection: p.selection, brief: p.brief, reportPath: p.reportPath, readinessTimeoutMs: settings.timeouts.startupMs }, { timeoutMs: settings.timeouts.overallMs, workerCommand: { executable: process.execPath, environment: p.environment, args: ['--input-type=module', '-e', `const trace=await import(${JSON.stringify(pathToFileURL(join(source, 'scripts/qa-worker-trace.ts')).href)});trace.traceWorkerCommands(${JSON.stringify(join(evidence, `trace-${index}.jsonl`))},${JSON.stringify(settings)},${JSON.stringify(p.brief)});const m=await import(${JSON.stringify(pathToFileURL(join(f.cwd, 'src/production-runtime.ts')).href)}); await m.runProductionWorker();`] } });
      f.trackProcess(started.wrapperPid);
      f.trackProcess(started.identity.pid);
      results.push({ index, outcome: 'accepted', identity: started.identity, durationMs: Date.now() - startedAt });
    } catch (error: any) {
      results.push({ index, outcome: 'failed', error: String(error), durationMs: Date.now() - startedAt });
      await error.wrapper?.terminate();
    } finally {
      const directory = join(f.tmpRoot, p.runId);
      await fs.mkdir(join(evidence, `run-${index}`), { recursive: true });
      await fs.copyFile(join(directory, 'worker.log'), join(evidence, `run-${index}/worker.log`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.writeFile(join(evidence, `run-${index}/session.json`), JSON.stringify(f.store.sessionRepository.transaction((tx: any) => tx.getSession(p.runId)), null, 2));
      const captured = await executeCommand({ executable: f.realTmuxPath, args: ['-S', join(f.tmpRoot, 'tmux/server.sock'), 'capture-pane', '-p', '-t', `=${p.tmuxSession}:0.0`] });
      await fs.writeFile(join(evidence, `pane-${index}.json`), JSON.stringify(captured));
      await executeCommand({ executable: f.realTmuxPath, args: ['-S', join(f.tmpRoot, 'tmux/server.sock'), 'kill-server'] });
    }
  }));
} finally {
  for (const action of cleanups.reverse()) await action();
  await fs.writeFile(join(evidence, 'summary.json'), JSON.stringify({ revision, sha, count, results, cleanup: 'fixture cleanups completed', driver: 'scripts/qa-worker-delivery.ts', sourceWorkspace: command('git', ['status', '--short']), selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' } }, null, 2));
}
console.log(JSON.stringify({ sha, results: results.map(({ index, outcome, error }) => ({ index, outcome, error })) }));

process.exitCode = results.length === count && results.every(result => result.outcome === 'accepted') ? 0 : 1;
