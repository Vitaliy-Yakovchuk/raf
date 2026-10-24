import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, derivedLaunch, fixture, recordLaunchRunnerPath } from '../test/production-fixture.ts';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import { executeCommand } from '../src/os-runtime.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import { codexPastedBriefFixture } from '../test/codex-pasted-brief-fixture.ts';

const [revision, destination] = process.argv.slice(2);
assert.ok(revision && destination && process.env.HOME === process.env.RAF_QA_HOME && process.env.HOME?.startsWith('/tmp/'), 'isolated QA HOME required');
const evidence = resolve(destination);
await fs.mkdir(evidence, { recursive: true });
const source = resolve(import.meta.dirname, '..');
const inherited = { ...process.env };
const conf = JSON.parse(await fs.readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const settings = conf.runnerProtocols.find((row: any) => row.runner === 'codex');
const git = (args: string[]) => {
  const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const sha = git(['rev-parse', revision === 'workspace' ? 'HEAD' : revision]);
const results: any[] = [];
for (const hasReport of [true, false]) {
  const cleanups: (() => unknown)[] = [];
  Object.assign(process.env, inherited);
  const f = await fixture({ after: action => cleanups.push(action) } as any, { productionQa: true });
  let workerPid: number | undefined;
  let runnerPid: number | undefined;
  const row: any = { hasReport, sha, revision };
  const trace = join(evidence, `${hasReport ? 'report' : 'missing'}.trace.jsonl`);
  try {
    if (revision !== 'workspace') {
      const archive = join(f.root, 'source.tar');
      git(['archive', '--output', archive, sha, 'src', 'bin', 'scripts', 'package.json']);
      assert.equal(spawnSync('tar', ['-xf', archive, '-C', f.cwd]).status, 0);
    }
    const nativeId = '11111111-1111-4111-8111-111111111111';
    const executable = join(f.binRoot, 'codex');
    const screen = codexPastedBriefFixture(20177).before;
    await fs.writeFile(executable, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli ${settings.version}'); process.exit(0); }
console.log(${JSON.stringify(screen)});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  input += text;
  if (input.includes('/status')) { console.log('Session: ${nativeId}\\n' + ${JSON.stringify(screen)}); input = input.replace('/status', ''); }
  if (input.includes('BRIEF_END')) console.log('\\n• Working (0s • esc to interrupt)\\n› ');
});
`, { mode: 0o700 });
    const raf = JSON.parse(await fs.readFile(join(f.confRoot, 'raf.json'), 'utf8'));
    await fs.writeFile(join(f.confRoot, 'raf.json'), JSON.stringify({ ...conf, state: raf.state, runnerProtocols: [{ ...settings, executable }] }));
    const runId = hasReport ? 'exit-report' : 'exit-missing';
    const tmuxSession = runId;
    const selection = { runner: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' };
    const runtimeLaunch = { runId, addressId: f.params.id, tmuxSession, activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd }, assignment: f.assignment, selection: { status: 'selected' as const, ...selection, reason: 'synthetic exit stand', quota: 'unknown' as const }, statePath: f.statePath, tmpRoot: f.tmpRoot };
    const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute, loadAverage1m: () => 0 });
    const { task, launch } = await derivedLaunch(services, f, runtimeLaunch);
    const prepared = await services.prepareReport(launch);
    const reserved = await services.reserve({ ...launch, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
    assert.equal(reserved.admitted, true);
    await recordLaunchRunnerPath(f.tmpRoot, runId, executable);
    const session = () => f.store.sessionRepository.transaction(tx => tx.getSession(runId));
    const brief = 'Synthetic worker exit probe. BRIEF_END';
    await fs.writeFile(session()!.launchContext!.briefPath, brief);
    const environment = { ...inherited, HOME: f.home, RAF_QA_HOME: f.home, PATH: f.binRoot + ':' + inherited.PATH };
    for (const key of Object.keys(environment)) if (key.startsWith('RAF_') && key !== 'RAF_QA_HOME') delete environment[key];
    delete environment.TMUX; delete environment.TMUX_PANE;
    const started = await launchPersistentWrapper({ tmpRoot: f.tmpRoot, runId, address: f.params.id, assignment: f.assignment, reportedCommits: session()!.launchContext!.reportedCommits, statePath: f.statePath, cwd: f.cwd, tmuxSession, selection, brief, reportPath: prepared.reportPath, readinessTimeoutMs: settings.timeouts.startupMs }, {
      timeoutMs: settings.timeouts.overallMs,
      workerCommand: { executable: process.execPath, environment, args: ['--input-type=module', '-e', `const trace=await import(${JSON.stringify(pathToFileURL(join(source, 'scripts/qa-worker-trace.ts')).href)});trace.traceWorkerCommands(${JSON.stringify(trace)},${JSON.stringify(settings)},${JSON.stringify(brief)});const m=await import(${JSON.stringify(f.runtimeUrl)});await m.runProductionWorker();`] },
    });
    workerPid = started.wrapperPid; runnerPid = started.identity.pid;
    f.trackProcess(workerPid); f.trackProcess(runnerPid);
    const socket = join(f.tmpRoot, 'tmux/server.sock');
    const tmux = async (args: string[]) => {
      const result = await executeCommand({ executable: f.realTmuxPath, args: ['-S', socket, ...args] });
      assert.equal(result.exitCode, 0, result.stderr);
      return result.stdout;
    };
    await tmux(['new-session', '-d', '-s', 'stand-keeper', 'sleep', '600']);
    await delay(settings.timeouts.pollMs * 2);
    const ticks = async () => (await fs.readFile(`/proc/${workerPid}/stat`, 'utf8')).split(') ')[1].split(' ').slice(11, 13).map(Number).reduce((a, b) => a + b);
    const before = { at: Date.now(), ticks: await ticks(), commands: (await fs.readFile(trace, 'utf8')).trim().split('\n').length };
    await delay(settings.timeouts.pollMs * 10);
    row.idle = { durationMs: Date.now() - before.at, cpuTicks: await ticks() - before.ticks, completedCommands: (await fs.readFile(trace, 'utf8')).trim().split('\n').length - before.commands };
    if (hasReport) await fs.writeFile(prepared.reportPath, JSON.stringify({ status: 'failed', answer: 'Synthetic failed report retained', changes: [{ id: 'fixture-launch', items: [{ id: '2.1', status: 'failed', reason: 'Synthetic failure' }] }], commits: [] }));
    const removedAt = Date.now();
    await tmux(['kill-session', '-t', '=' + tmuxSession]);
    const deadline = removedAt + settings.timeouts.transitionMs;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
    while (alive(workerPid) && Date.now() < deadline) await delay(settings.timeouts.pollMs);
    row.transitionMs = Date.now() - removedAt;
    row.workerExited = !alive(workerPid);
    row.runnerExited = !alive(runnerPid);
    row.session = session();
    row.reservations = listTaskReservations(f.store);
    row.admission = f.store.sessionRepository.transaction(tx => tx.listReservations());
    row.hooks = await tmux(['show-hooks', '-g']);
    row.workerLog = await fs.readFile(join(f.tmpRoot, runId, 'worker.log'), 'utf8').catch(() => '');
    row.passed = row.workerExited && row.runnerExited && row.session?.state === 'finished' && row.session?.result?.status === 'failed' && row.reservations.length === 0 && row.admission.length === 0 && row.idle.completedCommands === 0 && row.idle.cpuTicks <= 1 && !/raf-exit-/.test(row.hooks);
  } catch (error) { row.error = String(error); row.passed = false; }
  finally {
    for (const pid of [workerPid, runnerPid]) if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    for (const action of cleanups.reverse()) await action();
    row.cleanup = 'owned fixture processes stopped and fixture removed';
    results.push(row);
    await fs.writeFile(join(evidence, 'summary.json'), JSON.stringify({ revision, sha, dirty: git(['status', '--short']), timeoutSource: 'conf/raf.json#/runnerProtocols/codex/timeouts/transitionMs', timeoutMs: settings.timeouts.transitionMs, results }, null, 2));
  }
}
console.log(JSON.stringify(results.map(({ hasReport, workerExited, transitionMs, idle, passed, error }) => ({ hasReport, workerExited, transitionMs, idle, passed, error }))));
process.exitCode = results.every(row => row.passed) ? 0 : 1;
