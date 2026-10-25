import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, chmod, cp, mkdir, open, rm, mkdtemp } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
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
const output = resolve(process.argv[2] ?? 'evidence/profile-raf-performance/qa-2.4/host');
assert.equal(process.platform, 'linux', 'Linux host required');
assert.equal(spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' }).stdout, '', 'Use a clean committed clone');
const base = await mkdtemp('/srv/dev/raf-profile-qa-');
await mkdir(output, { recursive: true });
await mkdir(join(base, 'tmp'));
await mkdir(join(base, 'bootstrap-home'));
const environment = { ...process.env };
for (const name of Object.keys(process.env)) {
  if (/^(RAF_|TMUX|CODEX|CLAUDE|ANTHROPIC|OPENAI|AGY|GROK|GOOGLE|AWS|AZURE|OIC_|GIT_)/.test(name) || /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/.test(name)) delete process.env[name];
}
process.env.HOME = join(base, 'bootstrap-home');
process.env.RAF_QA_HOME = process.env.HOME;
process.env.TMPDIR = join(base, 'tmp');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim();
const digest = (value: string) => hash(value);
const summary: any = { sha, base, platform: process.platform, node: process.version, versions: process.versions,
  os: spawnSync('uname', ['-a'], { encoding: 'utf8' }).stdout.trim(),
  osRelease: await readFile('/etc/os-release', 'utf8'),
  tools: Object.fromEntries(['git', 'tmux', 'openspec'].map(name => [name, spawnSync(name, ['--version'], { encoding: 'utf8' }).stdout.trim()])),
  conf: {}, scenarios: [], commands: [], limitations: ['Runner is a synthetic interactive executable using real tmux/worker delivery. No provider credentials or real model call.', 'Per-child helper CPU is explicitly unavailable; total CPU is not claimed.'], cleanup: { complete: false } };
const hooks: (() => unknown)[] = [];
const lifecycle = { after: (action: () => unknown) => hooks.push(action) } as unknown as TestContext;
let f: Awaited<ReturnType<typeof workerFixture>> | undefined;
let runner: Awaited<ReturnType<Awaited<ReturnType<typeof workerFixture>>['launch']>> | undefined;
let cli: (args: string[]) => Promise<any>;
const children = new Set<ReturnType<typeof spawn>>();
async function child(args: string[], env = process.env, cwd = source) {
  const processChild = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(processChild);
  let stdout = '', stderr = '';
  processChild.stdout.on('data', chunk => stdout += chunk);
  processChild.stderr.on('data', chunk => stderr += chunk);
  const result = await new Promise<any>((resolve, reject) => {
    processChild.on('error', reject);
    processChild.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  children.delete(processChild);
  return result;
}
async function scenario(name: string, action: () => Promise<unknown>) {
  try { const evidence = await action(); summary.scenarios.push({ name, status: 'passed', evidence }); }
  catch (error) { summary.scenarios.push({ name, status: 'failed', error: String(error), stack: error instanceof Error ? error.stack : undefined }); }
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}
try {
  f = await workerFixture(lifecycle);
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const local = JSON.parse(await readFile(join(f.confRoot, 'raf.json'), 'utf8'));
  const constants = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  const projects = JSON.parse(await readFile(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
  const models = JSON.parse(await readFile(new URL('../../conf/models.json', import.meta.url), 'utf8'));
  const isolatedSettings = { ...settings, state: { fileName: 'isolated.sqlite' }, runnerProtocols: local.runnerProtocols, bugs: { ...settings.bugs, sections: [] } };
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify(isolatedSettings));
  await writeFile(join(f.confRoot, 'raf-constants.json'), JSON.stringify(constants));
  await writeFile(join(f.confRoot, 'models.json'), JSON.stringify(models));
  for (const name of ['raf.json', 'raf-constants.json', 'projects.json', 'models.json', 'flow.json', 'test-runs.json']) summary.conf[name] = digest(await readFile(join(f.confRoot, name), 'utf8'));
  summary.configurationDifferences = { state: isolatedSettings.state, runner: 'synthetic codex protocol only', bugs: 'No external sections; no network/auth copied', flow: 'existing fixture resource estimates, retained and fingerprinted' };
  const main = join(f.root, projects.projects.raf.branchPaths.main);
  for (const name of ['src', 'bin', 'scripts', 'package.json']) await cp(join(f.cwd, name), join(main, name), { recursive: true });
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=Profile QA', '-c', 'user.email=profile-qa@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: process.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(main, ['init', '-q', '--initial-branch=main', '--separate-git-dir', join(f.root, 'main-git')]);
  git(main, ['add', '--', 'src', 'bin', 'scripts', 'package.json']);
  git(main, ['commit', '-q', '-m', 'Isolated profile QA main']);
  const { compileCatalog } = await import('../src/catalog.ts');
  await writeFile(join(f.root, 'catalog.json'), JSON.stringify(compileCatalog(constants, models, constants.commands.map((c: any) => c.path.join(' ')), projects)));
  const entry = join(f.cwd, 'src/production-entry.ts');
  const launchCode = `import { runProductionCli } from ${JSON.stringify(pathToFileURL(entry).href)}; const r = await runProductionCli(JSON.parse(process.argv[1]), ${JSON.stringify({ orchestratorRoot: f.root, homeDirectory: f.home, artifactPath: join(f.root, 'catalog.json') })}); if(r.stdout)process.stdout.write(r.stdout+'\\n');if(r.stderr)process.stderr.write(r.stderr+'\\n');process.exitCode=r.exitCode;`;
  cli = async args => {
    const result = await child(['--input-type=module', '-e', launchCode, JSON.stringify(args)]);
    const index = summary.commands.length;
    await writeFile(join(output, `cli-${index}.stdout`), result.stdout);
    await writeFile(join(output, `cli-${index}.stderr`), result.stderr);
    summary.commands.push({ args, ...result });
    return { ...result, body: result.stdout ? JSON.parse(result.stdout) : null };
  };
  await scenario('empty profile and preserved EMA', async () => {
    const empty = await cli(['command', 'stats']); assert.equal(empty.code, 0, empty.stderr);
    assert.deepEqual(empty.body.profile.rows, []);
    const later = await cli(['command', 'stats']); assert.equal(later.code, 0, later.stderr);
    assert.ok(later.body.profile.rows.some((r: any) => r.command === 'command stats'));
    assert.ok(Array.isArray(later.body.commands));
    return { empty: empty.body, later: later.body };
  });
  await scenario('runtime failure keeps nonzero CLI', async () => {
    const result = await cli(['agent', 'message', '--to', 'missing-profile-qa', '--text', 'PROFILE_QA_ARGUMENT_CANARY']);
    assert.notEqual(result.code, 0); assert.ok(result.stderr);
    return result;
  });
  await scenario('real service lifecycle and completed snapshot freshness', async () => {
    const start = await cli(['service', 'start']); assert.equal(start.code, 0, start.stderr);
    const status = await cli(['service', 'status']); assert.equal(status.code, 0, status.stderr);
    const stats = await cli(['command', 'stats']); assert.equal(stats.code, 0, stats.stderr);
    assert.ok(stats.body.profile.rows.some((r: any) => r.scope === 'service'));
    for (const row of stats.body.profile.rows) assert.ok(row.updatedAt <= stats.body.profile.readAt);
    return { start, status, stats };
  });
  await scenario('production worker delivers once and publishes completed preparation/delivery', async () => {
    runner = await f!.launch();
    await eventually(() => readFile(f!.deliveredPath, 'utf8').catch(() => ''), text => text.includes('BRIEF_END'), 'runner received assigned brief');
    const delivered = await readFile(f!.deliveredPath, 'utf8');
    assert.equal(delivered.split('BRIEF_END').length - 1, 1);
    const before = await cli(['command', 'stats']); assert.equal(before.code, 0, before.stderr);
    assert.ok(before.body.profile.rows.some((r: any) => r.scope === 'worker' && r.stage === 'delivery'));
    const snapshot = before.body.profile.rows.filter((r: any) => r.scope === 'worker');
    await new Promise(resolve => setTimeout(resolve, local.runnerProtocols[0].timeouts.pollMs * 10));
    const after = await cli(['command', 'stats']); assert.equal(after.code, 0, after.stderr);
    return { runnerPid: runner.identity.pid, workerPid: runner.wrapperPid, deliveredOccurrences: 1, snapshot, later: after.body.profile.rows.filter((r: any) => r.scope === 'worker') };
  });
  const contributor = join(base, 'contributor.mjs');
  await writeFile(contributor, `import { writeFileSync } from 'node:fs';
import { openStateStore } from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/state-store.ts')).href)};
import { productionStateContext } from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/state-migration-guard.ts')).href)};
import { RafCostRuntime } from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/raf-cost-runtime.ts')).href)};
import { executeCommand } from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/os-runtime.ts')).href)};
const context=productionStateContext(${JSON.stringify(f.root)},${JSON.stringify(join(f.cwd, 'src/state-store.ts'))},${JSON.stringify(f.home)},'worker');
const store=openStateStore(context.statePath,{context});const before=process.cpuUsage();
const p=new RafCostRuntime(store,{scope:'worker',command:null},${JSON.stringify(f.root)},'handler');p.install();
const begin=process.cpuUsage();while(process.cpuUsage(begin).user<20000)Math.sqrt(Math.random());
p.stage('wait');await new Promise(r=>setTimeout(r,100));p.stage('handler');
await executeCommand({executable:'git',args:['--version']});p.stage('finalization');
if(process.argv[2]==='crash'){writeFileSync(process.argv[3],'completed');await new Promise(()=>setInterval(()=>{},1000));}else{p.finish();store.close();console.log(JSON.stringify({before,after:process.cpuUsage(),resourceUsage:process.resourceUsage()}));}
`);
  await scenario('profile boundaries add no helper spawn or polling resources', async () => {
    const probe = join(base, 'boundary-probe.mjs');
    await writeFile(probe, `import { createHook } from 'node:async_hooks';
import { openStateStore } from ${JSON.stringify(pathToFileURL(join(f!.cwd, 'src/state-store.ts')).href)};
import { RafCostRuntime } from ${JSON.stringify(pathToFileURL(join(f!.cwd, 'src/raf-cost-runtime.ts')).href)};
const store=openStateStore(${JSON.stringify(f!.statePath)});const resources=[];
const hook=createHook({init(id,type){if(['PROCESSWRAP','Timeout','Immediate','TIMERWRAP'].includes(type))resources.push(type);}});
hook.enable();const p=new RafCostRuntime(store,{scope:'worker',command:null},${JSON.stringify(f!.root)},'handler');p.install();
for(let i=0;i<20;i++){p.stage('wait');p.stage('handler');}p.finish();hook.disable();store.close();console.log(JSON.stringify({resources,boundaries:40}));
`);
    const result = await child([probe]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).resources, []);
    return result;
  });
  await scenario('concurrent SQLite writers and actual CPU accounting', async () => {
    const before = f!.store.readCostProfile();
    const writers = await Promise.all([child([contributor]), child([contributor]), child([contributor])]);
    for (const result of writers) assert.equal(result.code, 0, result.stderr);
    const after = f!.store.readCostProfile();
    const prior = before.rows.find(r => r.scope === 'worker' && r.stage === 'wait' && r.executor === 'self')?.samples ?? 0;
    const wait = after.rows.find(r => r.scope === 'worker' && r.stage === 'wait' && r.executor === 'self')!;
    assert.equal(wait.samples - prior, 3);
    const helper = after.rows.find(r => r.scope === 'worker' && r.executor === 'child')!;
    assert.equal(helper.cpuAvailability, 'unavailable'); assert.equal(helper.cpuUserTotalMs, null); assert.ok(helper.unavailableReason);
    const cpuSum = (snapshot: any) => snapshot.rows.filter((r:any) => r.scope === 'worker' && r.executor === 'self').reduce((n:number,r:any)=>n+(r.cpuUserTotalMs??0)+(r.cpuSystemTotalMs??0),0);
    const measured = cpuSum(after) - cpuSum(before);
    const envelope = writers.map(r=>JSON.parse(r.stdout)).reduce((n,r)=>n+(r.after.user-r.before.user+r.after.system-r.before.system)/1000,0);
    assert.ok(measured > 0 && measured <= envelope);
    return { before, after, writers, selfCpuMs: measured, independentlyObservedEnvelopeMs: envelope };
  });
  await scenario('crash keeps completed work and restart adds to same SQLite aggregate', async () => {
    const marker = join(base, 'crash-ready');
    const c = spawn(process.execPath, [contributor, 'crash', marker], { env: process.env, stdio: ['ignore','ignore','pipe'] }); children.add(c);
    let stderr=''; c.stderr.on('data',b=>stderr+=b);
    const closed = new Promise(resolve=>c.once('close',(code,signal)=>resolve({code,signal,stderr})));
    await eventually(()=>readFile(marker,'utf8').catch(()=>''),v=>v==='completed','crash contribution boundary');
    const before = f!.store.readCostProfile();
    c.kill('SIGKILL'); const exit = await closed; children.delete(c);
    const after = f!.store.readCostProfile(); assert.deepEqual(after.rows,before.rows);
    const restarted = await child([contributor]); assert.equal(restarted.code,0,restarted.stderr);
    const restart = f!.store.readCostProfile();
    assert.ok(restart.rows.reduce((n,r)=>n+r.samples,0)>after.rows.reduce((n,r)=>n+r.samples,0));
    return { before, exit, after, restarted, restart };
  });
  await scenario('no arguments, brief text or identities in aggregate', async () => {
    const rows = f!.store.readCostProfile().rows;
    const serialized = JSON.stringify(rows);
    for(const value of ['PROFILE_QA_ARGUMENT_CANARY','BRIEF_END','FIXTURE_NARROW_BRIEF',f!.runId,f!.address]) assert.equal(serialized.includes(value),false,value);
    for(const row of rows) assert.deepEqual(Object.keys(row).sort(),['scope','command','stage','executor','samples','firstSampleStartedAt','updatedAt','wallTotalMs','wallMeanMs','cpuSamples','cpuUnavailableSamples','cpuUserTotalMs','cpuSystemTotalMs','cpuUserMeanMs','cpuSystemMeanMs','cpuSource','cpuAvailability','unavailableReason'].sort());
    return rows;
  });
  await scenario('service stop and restart retain completed aggregates', async () => {
    const stop = await cli(['service','stop']); assert.equal(stop.code,0,stop.stderr);
    const before = await cli(['command','stats']); assert.equal(before.code,0,before.stderr);
    const start = await cli(['service','start']); assert.equal(start.code,0,start.stderr);
    const after = await cli(['command','stats']); assert.equal(after.code,0,after.stderr);
    for(const old of before.body.profile.rows.filter((r:any)=>r.scope==='service')) {
      const next=after.body.profile.rows.find((r:any)=>r.scope===old.scope&&r.stage===old.stage&&r.executor===old.executor);
      assert.ok(next.samples>=old.samples); assert.equal(next.firstSampleStartedAt,old.firstSampleStartedAt);
    }
    return {stop,before,start,after};
  });
  await scenario('unavailable primary SQLite is explicit and preserves original file', async () => {
    const alternate = join(base, 'unavailable-home'); await mkdir(join(alternate,'.raf'),{recursive:true});
    const blocked = join(alternate,'.raf','isolated.sqlite'); await writeFile(blocked,'PROFILE_QA_CORRUPT_SQLITE');
    const code=launchCode.replaceAll(JSON.stringify(f!.home),JSON.stringify(alternate));
    const result=await child(['--input-type=module','-e',code,JSON.stringify(['command','stats'])],{...process.env,HOME:alternate,RAF_QA_HOME:alternate});
    assert.notEqual(result.code,0);assert.equal(await readFile(blocked,'utf8'),'PROFILE_QA_CORRUPT_SQLITE');return result;
  });
} catch(error) {summary.setupFailure={error:String(error),stack:error instanceof Error?error.stack:undefined};}
finally {
  const failures:string[]=[];
  if(f){
    try{await writeFile(f.releasePath,JSON.stringify({exitCode:0}));await writeFile(f.exitGatePath,'exit');if(runner)await eventually(f.session,s=>s?.state==='finished','worker completion');}catch(e){failures.push(String(e));}
    try{if(cli!)await cli(['service','stop']);}catch(e){failures.push(String(e));}
    try{summary.finalProfile=f.store.readCostProfile();}catch(e){failures.push(String(e));}
  }
  for(const c of children){c.kill('SIGKILL');await new Promise(resolve=>c.once('close',resolve));}
  for(const hook of hooks.reverse()){try{await hook();}catch(e){failures.push(String(e));}}
  summary.cleanup={complete:failures.length===0,failures};
  summary.status=!summary.setupFailure&&summary.cleanup.complete&&summary.scenarios.every((r:any)=>r.status==='passed')?'passed':'failed';
  await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,environment);
  if(summary.cleanup.complete)await rm(base,{recursive:true,force:true});
  console.log(JSON.stringify({output,sha,status:summary.status,scenarios:summary.scenarios.map(({name,status}:any)=>({name,status})),setupFailure:summary.setupFailure,cleanup:summary.cleanup}));
  process.exitCode=summary.status==='passed'?0:1;
}
