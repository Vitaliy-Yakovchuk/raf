import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, chmod, cp, mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import type { RuntimeLaunch } from '../src/app-runtime.ts';
import type { LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { configuration, derivedLaunch, eventually, fixture, recordLaunchRunnerPath } from '../test/production-fixture.ts';
import { hash, inventory } from '../src/hotfix-host.ts';

async function workerFixture(t: TestContext, prepareInFixture = true, launchRunnerPath?: string | null) {
  const f = await fixture(t, { productionQa: true, tasks: 2 });
  let runtimeUrl = f.runtimeUrl;
  if (process.argv[3] === 'report') {
    const projects = JSON.parse(await readFile(join(f.confRoot, 'projects.json'), 'utf8'));
    const productionRoot = join(f.root, projects.projects.raf.branchPaths.main);
    const git = (cwd: string, args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git(productionRoot, ['init', '-q', '--initial-branch=main']);
    git(f.root, ['config', 'user.name', 'Worker stand']);
    git(f.root, ['config', 'user.email', 'worker@example.invalid']);
    const control = join(productionRoot, '.git', 'raf-hotfix');
    const generation = join(control, 'generations', 'idle-cost', 'raf-main');
    await mkdir(generation, { recursive: true });
    for (const name of ['src', 'bin', 'scripts', 'package.json']) await cp(join(f.root, projects.projects.raf.branchPaths.develop, name), join(generation, name), { recursive: true });
    await writeFile(join(control, 'registry.json'), JSON.stringify({ version: 1, generations: { [generation]: { root: generation, fingerprint: hash(JSON.stringify(await inventory(generation))) } } }));
    runtimeUrl = pathToFileURL(join(generation, 'src', 'production-runtime.ts')).href;
  }
  const runId = 'fixture-run-1';
  const address = f.params.id;
  const tmuxSession = 'raf-production-fixture';
  const reportPath = join(f.tmpRoot, runId, `${address}.json`);
  const releasePath = join(f.root, 'release.json');
  const exitGatePath = join(f.root, 'exit-gate');
  const deliveredPath = join(f.root, 'delivered.txt');
  const outputGatePath = join(f.root, 'output-gate');
  const pidPath = join(f.root, 'agent.pid');
  const wrapperPidPath = join(f.root, 'wrapper.pid');
  f.trackPidFile(pidPath);
  f.trackPidFile(wrapperPidPath);
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const executable = join(f.binRoot, 'codex');
  await writeFile(executable, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0'); process.exit(0); }
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
console.log('OpenAI Codex (v0.0.0)\\nAsk Codex to do anything\\n› Ask Codex to do anything');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  input += text;
  if (input.includes('/status')) { console.log('Session: ${nativeId}\\nAsk Codex to do anything\\n› Ask Codex to do anything'); input = input.replace('/status', ''); }
  if (input.includes('BRIEF_END')) { writeFileSync(${JSON.stringify(deliveredPath)}, input); console.log('\\n• Working (0s • esc to interrupt)\\n› '); }
});
const watchdog = setTimeout(() => process.exit(91), 180000);
let release;
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(outputGatePath)})) process.stdout.write('synthetic active runner output\\n');
  if (!release && existsSync(${JSON.stringify(releasePath)})) {
    release = JSON.parse(readFileSync(${JSON.stringify(releasePath)}, 'utf8'));
    if (release.report) writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(release.report));
  }
  if (!release || !existsSync(${JSON.stringify(exitGatePath)})) return;
  clearInterval(timer); clearTimeout(watchdog);
  process.exit(release.exitCode);
}, 30);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const settings: ProtocolSettings = {
    runner: 'codex', executable: 'codex', version: '0.0.0', baseArgs: [], modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config',
    modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null, quotaCommand: '/status', navigation: [],
    markers: { ready: ['Ask Codex to do anything'], auth_required: ['FIXTURE_AUTH_REQUIRED'], permission_required: ['FIXTURE_PERMISSION_REQUIRED'] },
    quotaParser: 'unknown', modelPools: {}, quotaReliable: false, liveTaskVerified: true,
    timeouts: { startupMs: 5000, transitionMs: 5000, overallMs: 10000, pollMs: 30 },
    collection: { intervalMs: 60000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  };
  const rafPath = join(f.confRoot, 'raf.json');
  const raf = JSON.parse(await readFile(rafPath, 'utf8'));
  await writeFile(rafPath, JSON.stringify({ ...raf, runnerProtocols: [settings] }));
  let request: LaunchWrapperRequest = { tmpRoot: f.tmpRoot, runId, address, assignment: f.assignment, statePath: f.statePath, cwd: f.cwd, tmuxSession, selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, brief: `FIXTURE_NARROW_BRIEF\nreport_path=${reportPath}\nBRIEF_END`, readinessTimeoutMs: 5000 };
  const session = () => f.store.sessionRepository.transaction(tx => tx.getSession(runId));
  const runtimeLaunch: RuntimeLaunch = { runId, addressId: address, tmuxSession, activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd }, assignment: f.assignment, selection: { status: 'selected', ...request.selection, reason: 'synthetic fixture only', quota: 'unknown' }, statePath: f.statePath, tmpRoot: f.tmpRoot };
  if (prepareInFixture) {
    const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute, loadAverage1m: () => 0 });
    const { task: descriptor, launch: derived } = await derivedLaunch(services, f, runtimeLaunch);
    const prepared = await services.prepareReport(derived);
    assert.equal(prepared.reportPath, reportPath);
    const reservation = await services.reserve({ ...derived, reportPath: prepared.reportPath, requested: descriptor.requested, requiredFileSystemIds: [...descriptor.requiredFileSystemIds] });
    assert.equal(reservation.admitted, true, 'reason' in reservation ? reservation.reason : 'admitted');
    if (launchRunnerPath !== null) await recordLaunchRunnerPath(f.tmpRoot, runId, launchRunnerPath ?? executable);
    const reserved = session();
    assert.ok(reserved?.launchContext);
    assert.equal(reserved.launchContext.reportPath, prepared.reportPath);
    assert.ok(reserved.launchContext.reportedCommits);
    request = { ...request, reportedCommits: reserved.launchContext.reportedCommits };
    await writeFile(reserved.launchContext.briefPath, request.brief);
    const claims = listTaskReservations(f.store);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].lease.owner.runId, runId);
    assert.ok(claims[0].lease.owner.fence.length > 0);
    assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  }
  const launch = async () => {
    const started = await launchPersistentWrapper(request, { timeoutMs: settings.timeouts.overallMs, workerCommand: { executable: process.execPath, args: ['--cpu-prof', '--cpu-prof-dir=' + process.cwd() + '/evidence/profile-raf-performance-5.1', '--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; import { runProductionWorker } from ${JSON.stringify(runtimeUrl)}; writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid)); process.env.PATH = ${JSON.stringify(f.binRoot + delimiter)} + (process.env.PATH ?? ''); process.env.HOME = ${JSON.stringify(f.home)}; await runProductionWorker();`] } });
    f.trackProcess(started.wrapperPid);
    f.trackProcess(started.identity.pid);
    assert.equal(Number(await readFile(wrapperPidPath, 'utf8')), started.wrapperPid);
    return started;
  };
  const report = { status: 'succeeded', answer: 'Виконано лише доручену fixture.', changes: [{ id: 'fixture-launch', items: [{ id: '2.1', status: 'succeeded' }] }], commits: [] as { repository: string; sha: string }[] };
  return { ...f, runId, address, reportPath, releasePath, exitGatePath, deliveredPath, outputGatePath, pidPath, wrapperPidPath, nativeId, executable, settings, request, runtimeLaunch, launch, session, report };
}


const hooks: (() => unknown)[] = [];
const lifecycle = { after: (action: () => unknown) => hooks.push(action) } as unknown as TestContext;
let f: Awaited<ReturnType<typeof workerFixture>> | undefined;
try {
  f = await workerFixture(lifecycle);
  console.log(JSON.stringify({stage:'prepared', root:f.root}));
  const started = await f.launch();
  console.log(JSON.stringify({stage:'launched', pid:started.wrapperPid, runnerPid:started.identity.pid}));
  const sample = async () => {
    const raw = await readFile('/proc/' + started.wrapperPid + '/stat', 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return {at:performance.now(), user:Number(fields[11]), system:Number(fields[12]), start:fields[19]};
  };
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (process.argv[3] === 'active') await writeFile(f.outputGatePath, 'active');
  if (process.argv[3] === 'report') await writeFile(f.reportPath, JSON.stringify(f.report));
  const before = await sample();
  await new Promise(resolve => setTimeout(resolve, 60000));
  const after = await sample();
  const hz = Number(spawnSync('getconf', ['CLK_TCK'], {encoding:'utf8'}).stdout.trim());
  const wallMs=after.at-before.at;
  const cpuMs=(after.user-before.user+after.system-before.system)*1000/hz;
  const pending = await readFile(join(f.tmpRoot, f.runId, 'report-confirmation-pending.json'), 'utf8').then(JSON.parse, () => null);
  const measurement={mode:process.argv[3] ?? 'quiet',before,after,hz,wallMs,cpuMs,corePercent:100*cpuMs/wallMs,pending,session:f.session()};
  console.log(JSON.stringify({stage:'measured', ...measurement}));
  await writeFile('evidence/profile-raf-performance-5.1/'+process.argv[2]+'-cpu.json',JSON.stringify(measurement,null,2)+'\n');
  await writeFile(f.releasePath, JSON.stringify({exitCode:0}));
  await writeFile(f.exitGatePath, 'exit');
  await eventually(() => f!.session(), s => s?.state === 'finished', 'worker finalized', 45000);
} finally {
  if(f) {await writeFile(f.releasePath,JSON.stringify({exitCode:0})); await writeFile(f.exitGatePath,'exit');}
  for (const hook of hooks) await hook();
}
