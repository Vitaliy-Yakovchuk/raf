import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, chmod, cp, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import type { RuntimeLaunch } from '../src/app-runtime.ts';
import type { LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { configuration, derivedLaunch, eventually, fixture, recordLaunchRunnerPath } from '../test/production-fixture.ts';
import { hash } from '../src/hotfix-host.ts';
import { randomUUID } from 'node:crypto';
import { settleRuntimeHealthCpu } from '../src/health-cpu-runtime.ts';
import { evaluateResourceAdmission } from '../src/resource-admission.ts';
import { createResourceSnapshotReader, readMachineBootIdentity } from '../src/os-runtime.ts';

async function workerFixture(t: TestContext, prepareInFixture = true, launchRunnerPath?: string | null) {
  const f = await fixture(t, { productionQa: true, tasks: 2 });
  const runtimeUrl = f.runtimeUrl;
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
let release; let payloadBusyMs = 0;
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(outputGatePath)})) { const busyStart = performance.now(); while (performance.now() - busyStart < 15) Math.sqrt(Math.random()); payloadBusyMs += performance.now() - busyStart; process.stdout.write('synthetic active runner output\\n'); }
  if (!release && existsSync(${JSON.stringify(releasePath)})) {
    release = JSON.parse(readFileSync(${JSON.stringify(releasePath)}, 'utf8'));
    if (release.report) writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(release.report));
  }
  if (!release || !existsSync(${JSON.stringify(exitGatePath)})) return;
  clearInterval(timer); clearTimeout(watchdog);
  writeFileSync(${JSON.stringify(join(f.root, 'runner-cpu.json'))}, JSON.stringify({ cpu: process.cpuUsage(), payloadBusyMs }));
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
    const started = await launchPersistentWrapper(request, { timeoutMs: settings.timeouts.overallMs, workerCommand: { executable: process.execPath, args: ['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; import { runProductionWorker } from ${JSON.stringify(runtimeUrl)}; writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid)); process.env.PATH = ${JSON.stringify(f.binRoot + delimiter)} + (process.env.PATH ?? ''); process.env.HOME = ${JSON.stringify(f.home)}; await runProductionWorker();`] } });
    f.trackProcess(started.wrapperPid);
    f.trackProcess(started.identity.pid);
    assert.equal(Number(await readFile(wrapperPidPath, 'utf8')), started.wrapperPid);
    return started;
  };
  const report = { status: 'succeeded', answer: 'Виконано лише доручену fixture.', changes: [{ id: 'fixture-launch', items: [{ id: '2.1', status: 'succeeded' }] }], commits: [] as { repository: string; sha: string }[] };
  return { ...f, runId, address, reportPath, releasePath, exitGatePath, deliveredPath, outputGatePath, pidPath, wrapperPidPath, nativeId, executable, settings, request, runtimeLaunch, launch, session, report };
}

const source = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? 'evidence/monitor-raf-health/cpu-qa/cli-host');
assert.equal(process.platform, 'linux');
assert.equal(spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' }).stdout, '', 'A clean committed clone is required');
const base = await mkdtemp('/srv/dev/raf-health-cpu-cli-');
await mkdir(output, { recursive: true });
await mkdir(join(base, 'tmp'));
await mkdir(join(base, 'bootstrap-home'));
const inherited = { ...process.env };
for (const name of Object.keys(process.env)) {
  if (/^(RAF_|TMUX|CODEX|CLAUDE|ANTHROPIC|OPENAI|AGY|GROK|GOOGLE|AWS|AZURE|OIC_|GIT_)/.test(name) || /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/.test(name)) delete process.env[name];
}
process.env.HOME = join(base, 'bootstrap-home');
process.env.RAF_QA_HOME = process.env.HOME;
process.env.TMPDIR = join(base, 'tmp');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim();
const summary: any = { runId: randomUUID(), sha, node: process.version, versions: process.versions,
  os: spawnSync('uname', ['-a'], { encoding: 'utf8' }).stdout.trim(),
  tools: Object.fromEntries(['git', 'tmux', 'openspec'].map(name => [name, spawnSync(name, [name === 'tmux' ? '-V' : '--version'], { encoding: 'utf8' }).stdout.trim()])),
  base, commands: [], scenarios: [], cleanup: { complete: false },
  limitations: ['Synthetic interactive codex executable, real tmux/production worker and isolated service; no AI provider', 'Fixture CPU window is explicitly shortened; threshold remains production conf value', 'Production helper per-child CPU is unavailable; live partial windows must stay partial', 'Initial complete CPU window uses actual RafCostRuntime contributors with service stopped; live worker/service scenario follows in the same state'] };
const hooks: (() => unknown)[] = [];
const lifecycle = { after: (action: () => unknown) => hooks.push(action) } as unknown as TestContext;
const children = new Set<ReturnType<typeof spawn>>();
let f: Awaited<ReturnType<typeof workerFixture>> | undefined;
let runner: Awaited<ReturnType<Awaited<ReturnType<typeof workerFixture>>['launch']>> | undefined;
let cli: ((args: string[]) => Promise<any>) | undefined;
async function child(args: string[], env = process.env) {
  const c = spawn(process.execPath, args, { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(c);
  let stdout = '', stderr = '';
  c.stdout.on('data', b => stdout += b);
  c.stderr.on('data', b => stderr += b);
  const result = await new Promise<any>((done, reject) => {
    c.once('error', reject);
    c.once('close', (code, signal) => done({ code, signal, stdout, stderr }));
  });
  children.delete(c);
  return result;
}
async function scenario(name: string, action: () => Promise<unknown>) {
  const evidence = await action();
  summary.scenarios.push({ name, status: 'passed', evidence });
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}
try {
  f = await workerFixture(lifecycle);
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const constants = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  const projects = JSON.parse(await readFile(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
  const models = JSON.parse(await readFile(new URL('../../conf/models.json', import.meta.url), 'utf8'));
  const local = JSON.parse(await readFile(join(f.confRoot, 'raf.json'), 'utf8'));
  const isolated = { ...settings, state: { fileName: 'isolated.sqlite' }, runnerProtocols: local.runnerProtocols,
    health: { ...settings.health, cpuWindowMs: 1000 } };
  delete isolated.bugs;
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify(isolated));
  await writeFile(join(f.confRoot, 'raf-constants.json'), JSON.stringify(constants));
  await writeFile(join(f.confRoot, 'models.json'), JSON.stringify(models));
  summary.fixture = { root: f.root, home: f.home, tmpRoot: f.tmpRoot, statePath: f.statePath, configuredHealth: settings.health, standHealth: isolated.health,
    differences: ['isolated.sqlite', 'synthetic runner protocol', 'optional bugs integration omitted', 'cpuWindowMs=1000', 'existing fixture resource estimates for isolated worker reservation'] };
  summary.conf = {};
  for (const name of ['raf.json', 'raf-constants.json', 'projects.json', 'models.json', 'flow.json', 'test-runs.json']) summary.conf[name] = hash(await readFile(join(f.confRoot, name), 'utf8'));
  const main = join(f.root, projects.projects.raf.branchPaths.main);
  for (const name of ['src', 'bin', 'scripts', 'package.json']) await cp(join(f.cwd, name), join(main, name), { recursive: true });
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=CPU QA', '-c', 'user.email=cpu-qa@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(main, ['init', '-q', '--initial-branch=main', '--separate-git-dir', join(f.root, 'main-git')]);
  git(main, ['add', '--', 'src', 'bin', 'scripts', 'package.json']);
  git(main, ['commit', '-q', '-m', 'Isolated CPU QA main']);
  const { compileCatalog } = await import('../src/catalog.ts');
  await writeFile(join(f.root, 'catalog.json'), JSON.stringify(compileCatalog(constants, models, constants.commands.map((c: any) => c.path.join(' ')), projects)));
  const launchCode = `import { runProductionCli } from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/production-entry.ts')).href)};const r=await runProductionCli(JSON.parse(process.argv[1]),${JSON.stringify({ orchestratorRoot: f.root, homeDirectory: f.home, artifactPath: join(f.root, 'catalog.json') })});if(r.stdout)process.stdout.write(r.stdout+'\\n');if(r.stderr)process.stderr.write(r.stderr+'\\n');process.exitCode=r.exitCode;`;
  cli = async args => {
    const result = await child(['--input-type=module', '-e', launchCode, JSON.stringify(args)]);
    const index = summary.commands.length;
    await writeFile(join(output, `cli-${index}.stdout`), result.stdout);
    await writeFile(join(output, `cli-${index}.stderr`), result.stderr);
    summary.commands.push({ args, executable: process.execPath, argv: ['--input-type=module', '-e', launchCode, JSON.stringify(args)], ...result });
    return { ...result, body: result.stdout ? JSON.parse(result.stdout) : null };
  };
  f.store.startupContextDatabase.exec(`CREATE TABLE qa_cpu_observer(payload TEXT NOT NULL);
    CREATE TRIGGER qa_cpu_observer_insert AFTER INSERT ON pending_intents
    WHEN json_extract(NEW.payload,'$.event')='raf.cpu-exceeded'
    BEGIN INSERT INTO qa_cpu_observer VALUES(NEW.payload); END;`);
  const events = () => f!.store.startupContextDatabase.prepare('SELECT payload FROM qa_cpu_observer').all().map(r => JSON.parse(String(r.payload)));
  const queue = () => f!.store.startupContextDatabase.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%queue%' OR name LIKE '%reservation%' OR name LIKE '%test_run%') ORDER BY name").all().map(r => ({ name: r.name, rows: f!.store.startupContextDatabase.prepare(`SELECT * FROM "${String(r.name).replaceAll('"', '""')}"`).all() }));
  await scenario('CLI stats retains commands/profile and reports missing or open CPU explicitly', async () => {
    const stats = await cli!(['command', 'stats']);
    assert.equal(stats.code, 0, stats.stderr);
    assert.ok(Array.isArray(stats.body.commands));
    assert.ok(Array.isArray(stats.body.profile.rows));
    assert.notEqual(stats.body.health.cpu.availability, 'complete');
    assert.equal(stats.body.health.cpu.cores, null);
    return stats;
  });
  const contributor = join(base, 'cpu-contributor.mjs');
  await writeFile(contributor, `import { performance } from 'node:perf_hooks';
import { openStateStore } from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/state-store.ts')).href)};
import { productionStateContext } from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/state-migration-guard.ts')).href)};
import { RafCostRuntime } from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/raf-cost-runtime.ts')).href)};
const role=process.argv[2];let store,p;if(role!=='payload'){const c=productionStateContext(${JSON.stringify(f.root)},${JSON.stringify(join(f.cwd, 'src/state-store.ts'))},${JSON.stringify(f.home)},'worker');store=openStateStore(c.statePath,{context:c});p=new RafCostRuntime(store,{scope:role,command:role==='command'?'agent ps':null},${JSON.stringify(f.root)},'handler');}
const before=process.cpuUsage();const start=performance.now();while(performance.now()-start<2200)for(let i=0;i<10000;i++)Math.sqrt(i+Math.random());const usage=process.cpuUsage(before);p?.finish();store?.close();console.log(JSON.stringify({role,wallMs:performance.now()-start,cpuUserMs:usage.user/1000,cpuSystemMs:usage.system/1000}));
`);
  await scenario('Actual parallel self CPU excludes separate payload and creates exactly one window event', async () => {
    await new Promise(done => setTimeout(done, isolated.health.cpuWindowMs + 50));
    await settleRuntimeHealthCpu(f!.store, f!.root);
    const before = f!.store.healthCpu.readProfile();
    const count = events().length;
    const results = await Promise.all(['service', 'worker', 'command', 'payload'].map(role => child([contributor, role])));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const assessed = await settleRuntimeHealthCpu(f!.store, f!.root);
    assert.equal(assessed?.availability, 'complete', JSON.stringify(assessed));
    assert.equal(assessed?.exceeded, true, JSON.stringify(assessed));
    assert.equal(events().length, count + 1);
    for (const scope of ['service', 'worker', 'command']) assert.ok(assessed!.scopes![scope].cpuUserMs > 0);
    const measured = f!.store.readCostProfile();
    const cpu = (rows: any[]) => rows.reduce((n, r) => n + (r.cpuUserTotalMs ?? 0) + (r.cpuSystemTotalMs ?? 0), 0);
    assert.ok(Math.abs(assessed!.cpuUserMs! + assessed!.cpuSystemMs! - (cpu(measured.rows) - cpu(before.profile.rows))) < 0.01);
    await Promise.all([settleRuntimeHealthCpu(f!.store, f!.root), settleRuntimeHealthCpu(f!.store, f!.root)]);
    const stats = await cli!(['command', 'stats']);
    assert.equal(stats.code, 0, stats.stderr);
    assert.equal(events().length, count + 1);
    return { before, results, assessed, measured, events: events(), stats };
  });
  await scenario('Own service and real production worker under separate busy runner payload stay truthful', async () => {
    const start = await cli!(['service', 'start']);
    assert.equal(start.code, 0, start.stderr);
    const status = await cli!(['service', 'status']);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.body.state, 'ready');
    assert.ok(status.body.mainPath.startsWith(f!.root + '/'));
    runner = await f!.launch();
    await eventually(() => readFile(f!.deliveredPath, 'utf8').catch(() => ''), s => s.includes('BRIEF_END'), 'worker delivered brief');
    await writeFile(f!.outputGatePath, 'busy payload');
    const own = await Promise.all(['worker', 'command'].map(role => child([contributor, role])));
    for (const result of own) assert.equal(result.code, 0, result.stderr);
    const stats = await cli!(['command', 'stats']);
    assert.equal(stats.code, 0, stats.stderr);
    assert.ok(stats.body.profile.rows.some((r: any) => r.scope === 'service'));
    assert.ok(stats.body.profile.rows.some((r: any) => r.scope === 'worker' && r.stage === 'delivery'));
    assert.notEqual(stats.body.health.cpu.availability, 'complete');
    assert.equal(stats.body.health.cpu.cores, null);
    assert.ok(stats.body.health.cpu.reason);
    const delivered = await readFile(f!.deliveredPath, 'utf8');
    assert.equal(delivered.split('BRIEF_END').length - 1, 1);
    return { start, status, runnerIdentity: runner.identity, workerPid: runner.wrapperPid, workerRunId: f!.runId, own, stats, deliveredOccurrences: 1 };
  });
  await scenario('Unavailable health state and missing-recipient refusal preserve real CLI results, admission and queue', async () => {
    await writeFile(f!.releasePath, JSON.stringify({ exitCode: 0 }));
    await writeFile(f!.exitGatePath, 'exit');
    await eventually(f!.session, s => s?.state === 'finished', 'worker completes before invariant snapshot');
    const runnerCpu = JSON.parse(await readFile(join(f!.root, 'runner-cpu.json'), 'utf8'));
    assert.ok(runnerCpu.payloadBusyMs > 0);
    assert.ok(runnerCpu.cpu.user > 0);
    const stop = await cli!(['service', 'stop']);
    assert.equal(stop.code, 0, stop.stderr);
    const identity = await readMachineBootIdentity();
    const resources = await createResourceSnapshotReader({ machineId: identity.machineId, paths: [f!.cwd, f!.home] }).read();
    const fs = resources.fileSystemByPath[f!.cwd];
    assert.ok(fs, JSON.stringify(resources.reasons));
    const input = { measurement: resources.measurement, requested: { ramBytes: 2048, diskBytes: { [fs]: 4096 } }, unusedReservations: [], requiredFileSystemIds: [fs] };
    const before = evaluateResourceAdmission(input);
    const beforeQueue = queue();
    const healthPayload = f!.store.startupContextDatabase.prepare('SELECT payload FROM raf_health_cpu WHERE singleton=1').get()!.payload;
    f!.store.startupContextDatabase.prepare('UPDATE raf_health_cpu SET payload=? WHERE singleton=1').run('{');
    let stats: any, refusal: any;
    try {
      stats = await cli!(['command', 'stats']);
      assert.equal(stats.code, 0, stats.stderr);
      assert.equal(stats.body.health.cpu.availability, 'unavailable');
      assert.equal(stats.body.health.cpu.cores, null);
      assert.match(stats.body.health.cpu.reason, /JSON|Unexpected|property|position/i);
      refusal = await cli!(['agent', 'message', '--to', 'missing-health-qa', '--text', 'CPU_QA_NON_SECRET_CANARY']);
      assert.notEqual(refusal.code, 0);
      assert.ok(refusal.stderr);
      assert.match(refusal.stderr, /AGENT|SESSION|missing-health-qa|not found|Unknown|unknown/i);
      assert.deepEqual(queue(), beforeQueue);
      assert.deepEqual(evaluateResourceAdmission(input), before);
    } finally {
      f!.store.startupContextDatabase.prepare('UPDATE raf_health_cpu SET payload=? WHERE singleton=1').run(healthPayload);
    }
    return { runnerCpu, stop, resources, input, before, after: evaluateResourceAdmission(input), beforeQueue, afterQueue: queue(), stats, refusal };
  });
} catch (error) {
  summary.failure = { message: String(error), stack: error instanceof Error ? error.stack : undefined };
} finally {
  const failures: string[] = [];
  if (f) {
    try {
      await writeFile(f.releasePath, JSON.stringify({ exitCode: 0 }));
      await writeFile(f.exitGatePath, 'exit');
      if (runner) await eventually(f.session, s => s?.state === 'finished', 'owned worker completion');
    } catch (error) { failures.push(String(error)); }
    try { if (cli) { const stop = await cli(['service', 'stop']); assert.equal(stop.code, 0, stop.stderr); } } catch (error) { failures.push(String(error)); }
    try { summary.finalProfile = f.store.readCostProfile(); } catch (error) { failures.push(String(error)); }
  }
  for (const c of children) { c.kill('SIGKILL'); await new Promise(done => c.once('close', done)); }
  for (const hook of hooks.reverse()) { try { await hook(); } catch (error) { failures.push(String(error)); } }
  summary.cleanup = { complete: failures.length === 0, failures, remainingChildPids: [...children].map(c => c.pid) };
  summary.status = !summary.failure && summary.cleanup.complete && summary.scenarios.length === 4 ? 'passed' : 'failed';
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, inherited);
  if (summary.cleanup.complete) await rm(base, { recursive: true, force: true });
  console.log(JSON.stringify({ output, runId: summary.runId, sha, status: summary.status, scenarios: summary.scenarios.map(({ name, status }: any) => ({ name, status })), failure: summary.failure, cleanup: summary.cleanup }));
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}

