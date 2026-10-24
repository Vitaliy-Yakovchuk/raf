import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, configuration } from '../test/production-fixture.ts';
import { compileCatalog } from '../src/catalog.ts';
import { runServiceHost } from '../src/background-runtime.ts';
import { productionResourceWait } from '../src/production-resource-wait.ts';
import { readResourceWaitProtocolOptions } from '../src/resource-wait-protocol.ts';
import { createResourceSnapshotReader, readMachineBootIdentity } from '../src/os-runtime.ts';
import { openStateStore } from '../src/state-store.ts';

const code = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(code, '..');
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const callbacks: (() => unknown)[] = [];
const children: any[] = [];
const evidence: any = { environment: { code, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: code, encoding: 'utf8' }), node: process.version, os: release(), platform: process.platform },
  limitations: ['Isolated process stand with real CLI parsing, production services, OS identities, Unix sockets, SQLite and real test wrapper. Ordinary agent CLI is deliberately cancelled while still queued after the priority assertion. The AI provider is a controlled terminal executable; it performs no agent work or network calls.',
    'Only the load measurement is controlled at documented reader seams (and a stand-only node:os preload for the test CLI); RAM, disks, process identities, clocks and resource thresholds are real. This does not generate actual host CPU pressure.'],
  invocations: [], assertions: [], outcome: 'failed', samples: [] };
let host: Awaited<ReturnType<typeof runServiceHost>> | undefined;
let f: any;
let unitHome: string | undefined;
let privateTmp: string | undefined;
const until = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 90000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Stand guard expired: ${label}; child state ${JSON.stringify(children.map(c => ({ label: c.label, code: c.child.exitCode, stderr: c.stderr.slice(-6000) })))}`);
    await new Promise(done => setTimeout(done, 30));
  }
};
function start(label: string, argv: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const item: any = { label, child, stdout: '', stderr: '', startedAt: Date.now() };
  child.stdout!.on('data', value => { item.stdout += value; });
  child.stderr!.on('data', value => { item.stderr += value; });
  item.done = new Promise<any>(done => child.once('close', (cliExitCode, signal) => {
    writeFileSync(join(output, `${label}.stdout.json`), item.stdout);
    writeFileSync(join(output, `${label}.stderr`), item.stderr);
    writeFileSync(join(output, `${label}.cli-code`), String(cliExitCode) + '\n');
    const result = { label, command: { executable: process.execPath, argv, cwd, environment: env }, pid: child.pid, cliExitCode, signal, startedAt: item.startedAt, finishedAt: Date.now() };
    evidence.invocations.push(result); done(result);
  }));
  children.push(item);
  return item;
}
try {
  f = await fixture({ after: (action: () => unknown) => { callbacks.unshift(action); } } as any, { productionQa: true });
  const flow = read(join(sourceRoot, 'conf/flow.json'));
  flow.resourceEstimates.agentTypes.implement = { ramBytes: 1048576, diskBytesPerFileSystem: 0 };
  write(f.flowPath, flow);
  const constants = read(join(sourceRoot, 'conf/raf-constants.json'));
  write(join(f.confRoot, 'raf-constants.json'), constants);
  const raf = read(join(sourceRoot, 'conf/raf.json'));
  raf.state.fileName = 'isolated.sqlite';
  const hotfix = join(f.root, 'raf-hotfix');
  cpSync(f.cwd, hotfix, { recursive: true, filter: path => !path.includes('/.git') });
  execFileSync('git', ['init', '-q', '-b', 'hotfix', hotfix]);
  execFileSync('git', ['-C', hotfix, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--allow-empty', '-qm', 'Isolated hotfix route']);
  const projects = read(join(f.confRoot, 'projects.json'));
  projects.projects = { raf: { ...projects.projects.raf, path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } } };
  write(join(f.confRoot, 'projects.json'), projects);
  const catalog = compileCatalog(constants, configuration.models, constants.commands.map((command: any) => command.path.join(' ')), projects);
  const configured = { ...configuration, catalog };
  for (const target of [f.cwd, hotfix]) {
    mkdirSync(join(target, 'dist'), { recursive: true });
    write(join(target, 'dist/catalog.json'), catalog);
  }
  write(f.context.artifactPath, catalog);
  const runnerPid = join(f.root, 'runner.pid');
  f.trackPidFile(runnerPid);
  const runnerAssigned = join(f.root, 'runner-assigned.json');
  const runnerPath = join(f.binRoot, 'priority-runner');
  writeFileSync(runnerPath, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('codex-cli 0.160.0');process.exit(0);}
writeFileSync(${JSON.stringify(runnerPid)},String(process.pid));
process.stdin.setEncoding('utf8');process.stdin.setRawMode(true);
const render=text=>process.stdout.write('\\x1b[2J\\x1b[H'+text);
const ready='Session: 11111111-1111-4111-8111-111111111111\\r\\nAsk Codex to do anything\\r\\n› Ask Codex to do anything';
render(ready);let input='',assigned=false;
process.stdin.on('data',data=>{input+=data.replace(/\\r/g,'\\n');if(input.includes('/status')){input='';render(ready);return;}
const at=input.search(/\\{\\s*"project"\\s*:/);if(at<0||assigned)return;
try{const assignment=JSON.parse(input.slice(at).trim());assigned=true;writeFileSync(${JSON.stringify(runnerAssigned)},JSON.stringify({pid:process.pid,at:Date.now(),project:assignment.project}));render('Session: 11111111-1111-4111-8111-111111111111\\r\\n• Working (0s • esc to interrupt)\\r\\n› ');}catch{}});
setInterval(()=>{},1000);
`, { mode: 0o700 });
  raf.runnerProtocols = [{ ...raf.runnerProtocols.find((entry: any) => entry.runner === 'codex'), executable: runnerPath,
    version: '0.160.0', liveTaskVerified: false, quotaReliable: false,
    timeouts: { startupMs: 15000, transitionMs: 15000, overallMs: 45000, pollMs: 30 } }];
  write(join(f.confRoot, 'raf.json'), raf);
  const group = 'fixture-launch/priority';
  const testReady = join(f.root, 'test-ready.json');
  const testRelease = join(f.root, 'test-release');
  writeFileSync(join(hotfix, 'priority.test.ts'), `import {test} from 'node:test';
import {existsSync,writeFileSync} from 'node:fs';
test('hotfix priority CLI stand',async()=>{writeFileSync(${JSON.stringify(testReady)},JSON.stringify({pid:process.pid,at:Date.now(),HOME:process.env.HOME,RAF_QA_HOME:process.env.RAF_QA_HOME,RAF_STATE_DIRECTORY:process.env.RAF_STATE_DIRECTORY,TMPDIR:process.env.TMPDIR}));while(!existsSync(${JSON.stringify(testRelease)}))await new Promise(done=>setTimeout(done,25));});\n`);
  writeFileSync(join(hotfix, 'unselected.test.ts'), "import {test} from 'node:test';test('unselected inventory fixture',()=>{});\n");
  const tests = read(join(sourceRoot, 'conf/test-runs.json'));
  privateTmp = join('/tmp', `qp-${randomUUID().slice(0, 8)}`);
  mkdirSync(privateTmp, { mode: 0o700 });
  tests.temporaryArtifacts.root = privateTmp;
  tests.projects = { raf: { profiles: { node: { cwd: '.', executable: process.execPath, argv: ['./scripts/test-run-node.ts'],
    unitFiles: ['priority.test.ts', 'unselected.test.ts'], exactIds: 'node-test-name', resultAdapter: 'node-test-events',
    environment: { isolatedHome: true, stateOrigin: true }, checks: [], resourceEstimate: { ramBytes: 1048576, diskBytesPerFileSystem: 0 } } },
    groups: { [group]: { profileId: 'node', files: ['priority.test.ts'] } } } };
  write(join(f.confRoot, 'test-runs.json'), tests);
  const stagePath = join(f.root, 'stage');
  writeFileSync(stagePath, 'blocked');
  const machine = await readMachineBootIdentity();
  const reader = createResourceSnapshotReader({ machineId: machine.machineId, paths: [f.root, f.cwd, hotfix, f.home] });
  const baseline = await reader.read();
  assert.deepEqual(baseline.reasons, []);
  const stageLoad = (cores: number) => (readFileSync(stagePath, 'utf8') === 'blocked' ? flow.resources.hotfix.maxNormalizedLoad + 1 :
    readFileSync(stagePath, 'utf8') === 'hotfix' ? (flow.resources.normal.maxNormalizedLoad + flow.resources.hotfix.maxNormalizedLoad) / 2 : 0) * cores;
  const protocol = readResourceWaitProtocolOptions({ constants, raf });
  const resourceRuntime = await productionResourceWait({ orchestratorRoot: f.root } as any, protocol, () => f.store, { read: async () => {
    const sample = await reader.read(); const actual = sample.measurement.loadAverage1m;
    sample.measurement.loadAverage1m = stageLoad(sample.measurement.availableCores);
    evidence.samples.push({ stage: readFileSync(stagePath, 'utf8'), at: Date.now(), actualLoad: actual, injectedLoad: sample.measurement.loadAverage1m });
    return sample;
  } });
  process.env.RAF_MAIN_PATH = f.root;
  host = await runServiceHost({ stateDirectory: join(f.home, '.raf'), socketPath: join(f.home, '.raf/service.sock'),
    handlers: { recover: async bootstrap => resourceRuntime.start(bootstrap!.serviceEpoch), resourceWait: resourceRuntime.attach,
      shutdown: resourceRuntime.stop, handle: async () => null } });
  const ps = execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
  const callerId = randomUUID();
  f.store.sessionRepository.transaction((tx: any) => tx.putSession({ runId: callerId, addressId: 'priority-test-caller', revision: 0, state: 'running',
    activity: { type: 'hotfix', project: 'raf', phase: 'hotfix', cwd: hotfix, features: ['fixture-launch'] },
    process: { pid: process.pid, startedAt: new Date(ps[1]).toISOString(), runner: 'qa', runnerSessionId: callerId, tmuxSession: '', evidence: { command: ps[2], machineId: machine.machineId, bootId: machine.bootId } },
    launchContext: { assignment: f.assignment, testAssignment: { runId: callerId, agentId: 'priority-test-caller', type: 'hotfix', phase: 'hotfix', project: 'raf', workspace: hotfix, branch: 'hotfix', changes: ['fixture-launch'] } } }));
  const preload = join(f.root, 'load-preload.mjs');
  writeFileSync(preload, `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {readFileSync} from 'node:fs';
const original=os.loadavg;os.loadavg=()=>{const stage=readFileSync(${JSON.stringify(stagePath)},'utf8');const value=stage==='blocked'?${flow.resources.hotfix.maxNormalizedLoad + 1}:stage==='hotfix'?${(flow.resources.normal.maxNormalizedLoad + flow.resources.hotfix.maxNormalizedLoad) / 2}:0;return [value*${baseline.measurement.availableCores},...original().slice(1)];};syncBuiltinESMExports();\n`);
  const agentRunId = randomUUID();
  const agentDriver = join(f.root, 'agent-command.mjs');
  writeFileSync(agentDriver, `import {readFileSync} from 'node:fs';
import {createAppRuntime} from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/app-runtime.ts')).href)};
import {createProductionServices} from ${JSON.stringify(f.runtimeUrl)};
import {openStateStore} from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/state-store.ts')).href)};
import {execute} from ${JSON.stringify(pathToFileURL(join(f.cwd, 'src/cli.ts')).href)};
const context={...${JSON.stringify(f.context)},resolveCaller:async()=>undefined};
const app=createAppRuntime(context,{loadConfiguration:async()=>(${JSON.stringify(configured)}),openStore:async path=>openStateStore(path),
createServices:(store,conf,ctx)=>createProductionServices(store,conf,ctx,{loadAverage1m:()=>{const stage=readFileSync(${JSON.stringify(stagePath)},'utf8');return (stage==='blocked'?${flow.resources.hotfix.maxNormalizedLoad + 1}:stage==='hotfix'?${(flow.resources.normal.maxNormalizedLoad + flow.resources.hotfix.maxNormalizedLoad) / 2}:0)*${baseline.measurement.availableCores};}}),
nextRunIdentity:()=>({runId:${JSON.stringify(agentRunId)},tmuxSession:'priority-normal-agent'}),now:Date.now});
try{const result=await execute(process.argv.slice(2),${JSON.stringify(catalog)},app.handlers);if(result.stdout)console.log(result.stdout);if(result.stderr)console.error(result.stderr);process.exitCode=result.exitCode;}finally{await app.close();}\n`);
  const env = { PATH: f.binRoot + ':' + process.env.PATH, HOME: f.home, RAF_QA_HOME: f.home, LANG: 'C.UTF-8', TZ: 'UTC', TERM: 'xterm', RAF_MAIN_PATH: f.root };
  evidence.stand = { root: f.root, home: f.home, hotfix, develop: f.cwd, statePath: f.statePath, machine, protocol, baseline,
    flowUnmodified: readFileSync(f.flowPath).equals(readFileSync(join(sourceRoot, 'conf/flow.json'))),
    thresholdsUnmodified: JSON.stringify(flow.resources) === JSON.stringify(read(join(sourceRoot, 'conf/flow.json')).resources),
    fixtureEstimate: flow.resourceEstimates.agentTypes.implement,
    configurationHashes: Object.fromEntries(['flow.json', 'test-runs.json', 'projects.json', 'raf.json'].map(name => [name, createHash('sha256').update(readFileSync(join(f.confRoot, name))).digest('hex')])) };
  const agent = start('normal-agent', [agentDriver, 'agent', 'run', '--id', 'worker-fixture', '--type', 'implement', '--project', 'raf', '--features', 'fixture-launch', '--phase', 'implement', '--complexity', 'decision', '--tasks', 'fixture-launch:2.1'], f.cwd, env);
  await until(() => agent.stderr.includes('launch-queue.waiting') || agent.child.exitCode !== null, 'ordinary agent queued');
  assert.equal(agent.child.exitCode, null, agent.stderr + agent.stdout);
  const test = start('hotfix-test', ['--import', preload, join(hotfix, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', 'hotfix', '--group', group], hotfix, env);
  await until(() => test.stderr.includes('launch-queue.waiting') || test.child.exitCode !== null, 'hotfix test queued');
  assert.equal(test.child.exitCode, null, test.stderr + test.stdout);
  assert.equal(existsSync(testReady), false); assert.equal(existsSync(runnerPid), false);
  assert.equal(f.store.sessionRepository.transaction((tx: any) => tx.listReservations(), 'read').length, 0);
  evidence.waiting = { normal: agent.stderr, hotfix: test.stderr, at: Date.now() };
  evidence.assertions.push('Earlier ordinary agent and later hotfix test are both live pending CLI processes; neither spawns or reserves under NO_RESOURCES.');
  writeFileSync(stagePath, 'hotfix');
  await until(() => existsSync(testReady) || test.child.exitCode !== null, 'hotfix test tree started');
  assert.equal(test.child.exitCode, null, test.stderr + test.stdout);
  assert.equal(existsSync(runnerPid), false); assert.equal(agent.child.exitCode, null);
  const descendant = read(testReady);
  unitHome = descendant.HOME;
  assert.equal(descendant.HOME, descendant.RAF_QA_HOME); assert.notEqual(descendant.HOME, f.home);
  assert.equal(descendant.RAF_STATE_DIRECTORY, join(descendant.HOME, '.raf'));
  const unitStore = openStateStore(join(descendant.HOME, '.raf/isolated.sqlite'));
  try { evidence.groupDuringExecution = unitStore.startupContextDatabase.prepare('SELECT payload FROM test_run_groups').all().map((row: any) => JSON.parse(row.payload)); } finally { unitStore.close(); }
  const reservations = f.store.sessionRepository.transaction((tx: any) => tx.listReservations(), 'read');
  assert.equal(reservations.length, 1); assert.ok(reservations[0].testRun.committed); assert.ok(reservations[0].testRun.claim.processIdentity);
  evidence.testAtStart = { descendant, reservations, lastGrant: f.store.readResourceWaitGrant(), at: Date.now() };
  evidence.assertions.push('Later trusted hotfix CLI test receives permit, commits its group/resource claims and executes its real test tree under HOTFIX_ONLY while the earlier ordinary agent remains queued.');
  writeFileSync(testRelease, '');
  assert.equal((await test.done).cliExitCode, 0, test.stderr);
  const result = JSON.parse(test.stdout);
  assert.equal(result.outcome, 'passed'); assert.equal(result.exitCode, 0); assert.equal(result.queue.waited, true);
  assert.equal(result.admission.requestedTier, 'hotfix'); assert.equal(result.admission.level, 'HOTFIX_ONLY');
  assert.equal(result.timeoutCount, 0); assert.equal(result.timedOut, false);
  assert.deepEqual(result.cleanup, { complete: true, remainingPids: [] });
  for (const field of ['knownRed', 'unexecuted', 'unknown']) assert.deepEqual(result[field], []);
  assert.equal(f.store.sessionRepository.transaction((tx: any) => tx.listReservations(), 'read').length, 0);
  assert.equal(existsSync(runnerPid), false); assert.equal(agent.child.exitCode, null);
  evidence.testResultSummary = { runId: result.runId, outcome: result.outcome, queue: result.queue, timeoutCount: result.timeoutCount, cleanup: result.cleanup };
  evidence.assertions.push('Test CLI returns its single final TestRunResult with queue.waited=true, HOTFIX_ONLY admission, passed outcome and verified cleanup; ordinary CLI remains pending.');
  agent.child.kill('SIGTERM');
  const cancelled = await agent.done;
  assert.equal(cancelled.cliExitCode, 1);
  const cancellation = JSON.parse(agent.stderr.trim().split('\n').at(-1)!);
  assert.equal(cancellation.code, 'RESOURCE_WAIT_FAILED');
  assert.equal(cancellation.details.cleanup.state, 'released');
  assert.deepEqual(cancellation.details.cleanup.pending, []);
  assert.equal(cancellation.details.admission.queueId, result.queue.queueId);
  assert.equal(existsSync(runnerPid), false);
  assert.equal(f.store.sessionRepository.transaction((tx: any) => tx.listReservations(), 'read').length, 0);
  const queue = f.store.startupContextDatabase.prepare('SELECT payload FROM agent_launch_queue_entries').all().map((row: any) => JSON.parse(row.payload));
  assert.ok(queue.every((entry: any) => !['waiting', 'rechecking', 'starting'].includes(entry.state)));
  evidence.afterCancellation = { cancellation, queue, lastGrant: f.store.readResourceWaitGrant() };
  assert.deepEqual(evidence.afterCancellation.lastGrant, evidence.testAtStart.lastGrant);
  evidence.assertions.push('Owned ordinary CLI is cancelled while still pending; same queueId, released cleanup, no runner spawn, no remaining resource reservations or live queue entries, and no second permit.');
  evidence.outcome = 'passed';
} catch (error) {
  evidence.error = String(error); evidence.stack = (error as Error).stack; process.exitCode = 1;
} finally {
  for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGTERM');
  await Promise.all(children.map(item => item.done));
  await host?.close();
  if (f) {
    for (const socket of [f.socket, join(f.tmpRoot, 'tmux/server.sock')]) spawnSync(f.realTmuxPath, ['-S', socket, 'kill-server']);

  }
  const cleanupErrors: string[] = [];
  for (const callback of callbacks) { try { await callback(); } catch (error) { cleanupErrors.push(String(error)); } }
  if (unitHome) rmSync(unitHome, { recursive: true, force: true });
  if (privateTmp) rmSync(privateTmp, { recursive: true, force: true });
  evidence.cleanup = { childProcesses: children.map(item => ({ label: item.label, pid: item.child.pid, exitCode: item.child.exitCode, signal: item.child.signalCode })),
    standRemoved: f ? !existsSync(f.root) : null, unitHomeRemoved: unitHome ? !existsSync(unitHome) : null, privateTmpRemoved: privateTmp ? !existsSync(privateTmp) : null, errors: cleanupErrors };
  if (cleanupErrors.length) { evidence.outcome = 'failed'; process.exitCode = 1; }
  write(join(output, 'process.json'), evidence);
}
process.stdout.write(JSON.stringify({ outcome: evidence.outcome, assertions: evidence.assertions, cleanup: evidence.cleanup, error: evidence.error }) + '\n');
