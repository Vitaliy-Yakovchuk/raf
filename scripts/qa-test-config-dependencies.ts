import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture, configuration } from '../test/production-fixture.ts';
import { compileCatalog } from '../src/catalog.ts';
import { runServiceHost } from '../src/background-runtime.ts';
import { productionResourceWait } from '../src/production-resource-wait.ts';
import { readResourceWaitProtocolOptions } from '../src/resource-wait-protocol.ts';
import { createResourceSnapshotReader, readMachineBootIdentity } from '../src/os-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import { sqliteTestRunState } from '../src/test-run-runtime.ts';
import { validateTestRunConfig } from '../src/test-runs.ts';

const code = resolve(import.meta.dirname, '..');
const source = resolve(code, '..', 'conf');
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const callbacks: (() => unknown)[] = [];
const children: any[] = [];
const evidence: any = {
  assignment: 'monitor-raf-health:6.4', outcome: 'failed', assertions: [], invocations: [], samples: [],
  environment: { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: code, encoding: 'utf8' }),
    node: process.version, os: release(), platform: process.platform, browser: 'not applicable: CLI',
    openspec: execFileSync('openspec', ['--version'], { encoding: 'utf8' }).trim(),
    tmux: execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim() },
  limitations: [
    'Isolated local process stand: real CLI, production service, Unix socket, OS caller identities, SQLite, reservation and test child tree. No AI runner or provider is required by test run.',
    'Only loadAverage1m is controlled at the production resource reader and a stand-only node:os preload. RAM, disk, process identities and configured admission thresholds are real. This is not a physical CPU pressure test.',
    'The prior timeout/knownRed ledger is explicitly seeded synthetic fixture state; no operational or assigned unit aggregate is reset.'
  ]
};
let f: any, host: any, ledger: any, unitHome: string | undefined, artifacts: string | undefined;
const until = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 90000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Stand guard expired: ${label}; ${JSON.stringify(children.map(row => ({ label: row.label, code: row.child.exitCode, stderr: row.stderr.slice(-2500) })))}`);
    await new Promise(done => setTimeout(done, 30));
  }
};
function start(label: string, argv: string[], cwd: string, environment: Record<string, string>) {
  const child = spawn(process.execPath, argv, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const row: any = { label, child, stdout: '', stderr: '', startedAt: Date.now() };
  child.stdout!.on('data', chunk => row.stdout += chunk);
  child.stderr!.on('data', chunk => row.stderr += chunk);
  row.done = new Promise<any>(done => child.once('close', (cliExitCode, signal) => {
    writeFileSync(join(output, `${label}.TestRunResult.json`), row.stdout);
    writeFileSync(join(output, `${label}.stderr`), row.stderr);
    const exit = { cliExitCode, signal };
    write(join(output, `${label}.exit.json`), exit);
    evidence.invocations.push({ label, executable: process.execPath, argv, cwd, environment, pid: child.pid,
      startedAt: row.startedAt, finishedAt: Date.now(), ...exit });
    try { row.result = JSON.parse(row.stdout); } catch {}
    done({ ...exit, result: row.result });
  }));
  children.push(row);
  return row;
}
try {
  f = await fixture({ after: action => callbacks.unshift(action) } as any, { productionQa: true });
  const constants = read(join(source, 'raf-constants.json'));
  const flow = read(join(source, 'flow.json'));
  write(f.flowPath, flow);
  write(join(f.confRoot, 'raf-constants.json'), constants);
  const raf = read(join(source, 'raf.json'));
  raf.state.fileName = 'isolated.sqlite';
  write(join(f.confRoot, 'raf.json'), raf);
  const projects = read(join(f.confRoot, 'projects.json'));
  const catalog = compileCatalog(constants, configuration.models, constants.commands.map(row => row.path.join(' ')), projects);
  mkdirSync(join(f.cwd, 'dist'), { recursive: true });
  write(join(f.cwd, 'dist/catalog.json'), catalog);
  const tests = read(join(source, 'test-runs.json'));
  artifacts = join('/tmp', `c6-${randomUUID().slice(0, 8)}`);
  mkdirSync(artifacts, { mode: 0o700 });
  tests.temporaryArtifacts.root = artifacts;
  const groups = ['unaffected', 'dependent', 'unauthorized'];
  const ready = (name: string) => join(f.root, `${name}.ready.json`);
  const gate = (name: string) => join(f.root, `${name}.release`);
  for (const name of groups) writeFileSync(join(f.cwd, `${name}.test.ts`),
    `import {test} from 'node:test';import {writeFileSync,existsSync} from 'node:fs';
test(${JSON.stringify(name)},async()=>{writeFileSync(${JSON.stringify(ready(name))},JSON.stringify({pid:process.pid,at:Date.now(),HOME:process.env.HOME,RAF_QA_HOME:process.env.RAF_QA_HOME,RAF_STATE_DIRECTORY:process.env.RAF_STATE_DIRECTORY}));while(!existsSync(${JSON.stringify(gate(name))}))await new Promise(done=>setTimeout(done,25));});\n`);
  const profile = { cwd: '.', executable: process.execPath, argv: ['./scripts/test-run-node.ts'],
    unitFiles: groups.map(name => `${name}.test.ts`), exactIds: 'node-test-name', resultAdapter: 'node-test-events',
    environment: { isolatedHome: true, stateOrigin: true }, checks: [], resourceEstimate: { ramBytes: 1048576, diskBytesPerFileSystem: 0 } };
  tests.projects = { raf: { profiles: Object.fromEntries(groups.map(name => [name, { ...structuredClone(profile), unitFiles: [`${name}.test.ts`] }])),
    groups: Object.fromEntries(groups.map(name => [`fixture-launch/${name}`, { profileId: name, files: [`${name}.test.ts`] }])) } };
  write(join(f.confRoot, 'test-runs.json'), tests);
  validateTestRunConfig(tests, constants.agentPhases.map(row => row.id), flow.unitTests, flow.integrationTests);
  const stage = join(f.root, 'stage');
  writeFileSync(stage, 'blocked');
  const machine = await readMachineBootIdentity();
  const reader = createResourceSnapshotReader({ machineId: machine.machineId, paths: [f.root, f.cwd, f.home] });
  const baseline = await reader.read();
  assert.deepEqual(baseline.reasons, []);
  const protocol = readResourceWaitProtocolOptions({ constants, raf });
  const resourceRuntime = await productionResourceWait({ orchestratorRoot: f.root } as any, protocol, () => f.store, { read: async () => {
    const sample = await reader.read();
    const actual = sample.measurement.loadAverage1m;
    sample.measurement.loadAverage1m = (readFileSync(stage, 'utf8') === 'blocked' ? flow.resources.hotfix.maxNormalizedLoad + 1 : 0) * sample.measurement.availableCores;
    evidence.samples.push({ at: Date.now(), actualLoad: actual, controlledLoad: sample.measurement.loadAverage1m });
    return sample;
  } });
  process.env.RAF_MAIN_PATH = f.root;
  host = await runServiceHost({ stateDirectory: join(f.home, '.raf'), socketPath: join(f.home, '.raf/service.sock'),
    handlers: { recover: async bootstrap => resourceRuntime.start(bootstrap!.serviceEpoch), resourceWait: resourceRuntime.attach,
      shutdown: resourceRuntime.stop, handle: async () => null } });
  const ps = execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
  const callerId = randomUUID();
  const session: any = { runId: callerId, addressId: 'configuration-qa-caller', revision: 0, state: 'running',
    activity: { type: 'qa', project: 'raf', phase: 'qa', cwd: f.cwd, features: ['fixture-launch'] },
    process: { pid: process.pid, startedAt: new Date(ps[1]).toISOString(), runner: 'qa', runnerSessionId: callerId, tmuxSession: '',
      evidence: { command: ps[2], machineId: machine.machineId, bootId: machine.bootId } },
    launchContext: { assignment: f.assignment, testAssignment: { runId: callerId, agentId: 'configuration-qa-caller', type: 'qa', phase: 'qa',
      project: 'raf', workspace: f.cwd, branch: 'develop', changes: ['fixture-launch'] } } };
  f.store.sessionRepository.transaction(tx => tx.putSession(session));
  const preload = join(f.root, 'load-preload.mjs');
  writeFileSync(preload, `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {readFileSync} from 'node:fs';
const original=os.loadavg;os.loadavg=()=>[(readFileSync(${JSON.stringify(stage)},'utf8')==='blocked'?${flow.resources.hotfix.maxNormalizedLoad + 1}:0)*${baseline.measurement.availableCores},...original().slice(1)];syncBuiltinESMExports();\n`);
  const env = { PATH: process.env.PATH!, HOME: f.home, RAF_QA_HOME: f.home, LANG: 'C.UTF-8', TZ: 'UTC', RAF_MAIN_PATH: f.root };
  unitHome = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`, createHash('sha256').update(JSON.stringify([f.root, 'raf', f.cwd])).digest('hex'));
  mkdirSync(unitHome, { recursive: true, mode: 0o700 });
  ledger = openStateStore(join(unitHome, '.raf/isolated.sqlite'));
  const state = sqliteTestRunState(ledger);
  const seeds = groups.map(name => ({ key: { project: 'raf', workspace: f.cwd, group: `fixture-launch/${name}` }, testKind: 'unit' as const,
    profileId: name, timeoutCount: flow.unitTests.optimizeAfterTimeouts, state: 'optimize' as const, selection: { files: [`${name}.test.ts`], testIds: [] },
    knownRed: [{ file: `${name}.test.ts`, name }], unexecuted: [], inFlight: null, lastResult: null }));
  await state.transaction(tx => { for (const seed of seeds) tx.put(seed); });
  const ledgerSnapshot = () => ledger.startupContextDatabase.prepare('SELECT payload FROM test_run_groups ORDER BY group_id').all().map(row => JSON.parse(row.payload));
  const queueSnapshot = () => f.store.startupContextDatabase.prepare('SELECT payload FROM agent_launch_queues').all().map(row => JSON.parse(row.payload));
  const reservations = () => f.store.sessionRepository.transaction(tx => tx.listReservations(), 'read');
  evidence.stand = { root: f.root, workspace: f.cwd, controlHome: f.home, statePath: f.statePath, unitHome, machine, baseline, protocol,
    configurationHashes: Object.fromEntries(['flow.json', 'test-runs.json', 'projects.json', 'raf.json', 'raf-constants.json'].map(name => [name, createHash('sha256').update(readFileSync(join(f.confRoot, name))).digest('hex')])),
    unitPolicy: flow.unitTests, thresholds: flow.resources, seedLedger: seeds };
  write(join(output, 'stand-config-before.json'), { flow, tests, projects, raf });
  const cli = (name: string) => start(name, ['--import', preload, join(f.cwd, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', 'qa', '--group', `fixture-launch/${name}`], f.cwd, env);
  const queued = async (row: any) => {
    await until(() => row.stderr.includes('launch-queue.waiting') || row.child.exitCode !== null, `${row.label} waiting`);
    assert.equal(row.child.exitCode, null, row.stderr + row.stdout);
    assert.equal(existsSync(ready(row.label)), false);
  };
  const first = cli('unaffected');
  await queued(first);
  const second = cli('dependent');
  await queued(second);
  const before = { ledger: ledgerSnapshot(), queues: queueSnapshot(), reservations: reservations(), lastGrant: f.store.readResourceWaitGrant() };
  assert.equal(before.reservations.length, 0);
  assert.deepEqual(before.ledger, [...seeds].sort((a, b) => a.key.group.localeCompare(b.key.group)));
  evidence.beforeMutation = before;
  const pending = before.queues.flatMap(q => q.pendingTests);
  assert.equal(pending.length, 2);
  assert.equal(new Set(pending.map(p => p.ownerIdentity)).size, 2);
  const changed = read(join(f.confRoot, 'test-runs.json'));
  changed.projects.raf.profiles.dependent.resourceEstimate.ramBytes += 1048576;
  changed.projects['unrelated-project'] = structuredClone(changed.projects.raf);
  writeFileSync(join(f.confRoot, 'test-runs.json'), JSON.stringify(Object.fromEntries(Object.entries(changed).reverse())));
  write(join(output, 'stand-test-runs-after.json'), changed);
  assert.deepEqual(ledgerSnapshot(), before.ledger);
  assert.deepEqual(queueSnapshot(), before.queues);
  assert.deepEqual(f.store.readResourceWaitGrant(), before.lastGrant);
  evidence.assertions.push('Two distinct live CLI owner identities wait in one queue without children/reservations; semantic edits preserve both pending fences, FIFO entries and seeded timeout/knownRed ledger while blocked.');
  writeFileSync(stage, 'open');
  await until(() => existsSync(ready('unaffected')) || first.child.exitCode !== null, 'unaffected child');
  assert.equal(first.child.exitCode, null, first.stderr + first.stdout);
  const active = { child: read(ready('unaffected')), ledger: ledgerSnapshot(), reservations: reservations(), queues: queueSnapshot(), lastGrant: f.store.readResourceWaitGrant() };
  assert.equal(active.reservations.length, 1);
  assert.ok(active.reservations[0].testRun.committed);
  assert.ok(active.reservations[0].testRun.claim.processIdentity);
  assert.equal(active.child.HOME, unitHome);
  assert.equal(active.child.RAF_QA_HOME, unitHome);
  assert.equal(active.child.RAF_STATE_DIRECTORY, join(unitHome, '.raf'));
  assert.equal(second.child.exitCode, null, second.stderr + second.stdout);
  assert.ok(active.queues.flatMap(q => q.entries).some(entry => entry.stage === 'waiting' &&
    before.queues.flatMap(q => q.pendingTests).find(p => p.groupKey.group === 'fixture-launch/dependent').handle.requestId === entry.requestId));
  evidence.unaffectedRunning = active;
  writeFileSync(gate('unaffected'), '');
  const passed = await first.done;
  assert.equal(passed.cliExitCode, 0);
  assert.equal(passed.result.outcome, 'passed');
  assert.equal(passed.result.exitCode, 0);
  assert.equal(passed.result.timeoutCount, seeds[0].timeoutCount);
  assert.equal(passed.result.queue.waited, true);
  assert.deepEqual(passed.result.knownRed, []);
  assert.deepEqual(passed.result.unexecuted, []);
  assert.deepEqual(passed.result.unknown, []);
  assert.equal(passed.result.nextAction, 'complete');
  assert.equal(passed.result.timedOut, false);
  assert.deepEqual(passed.result.cleanup, { complete: true, remainingPids: [] });
  const refused = await second.done;
  assert.notEqual(refused.cliExitCode, 0);
  assert.equal(refused.result.errorCode, 'CONFIGURATION_INVALID');
  assert.equal(refused.result.exitCode, null);
  assert.equal(refused.result.outcome, 'refused');
  assert.equal(existsSync(ready('dependent')), false);
  const pointer = 'conf/test-runs.json#/projects/raf/profiles/dependent/resourceEstimate/ramBytes';
  assert.ok(refused.result.diagnostics.some(d => d.message.includes(pointer)), JSON.stringify(refused.result.diagnostics));
  assert.deepEqual(refused.result.cleanup, { complete: true, remainingPids: [] });
  assert.equal(refused.result.timedOut, false);
  assert.equal(refused.result.timeoutCount, seeds[1].timeoutCount);
  assert.deepEqual(refused.result.knownRed, seeds[1].knownRed);
  assert.deepEqual(ledgerSnapshot().find(g => g.key.group === seeds[1].key.group), seeds[1]);
  assert.equal(reservations().length, 0);
  evidence.afterConfiguration = { ledger: ledgerSnapshot(), queues: queueSnapshot(), reservations: reservations(), lastGrant: f.store.readResourceWaitGrant(),
    passedRunId: passed.result.runId, refusedRunId: refused.result.runId, expectedPointer: pointer };
  evidence.assertions.push('Unrelated profile/project and JSON order/format edits do not invalidate the earlier FIFO waiter: one child, committed reservation, isolated child HOME and passed CLI/child 0. Only dependent profile returns CONFIGURATION_INVALID with exact leaf pointer, child null, no ready marker and byte-equivalent seeded ledger.');
  writeFileSync(stage, 'blocked');
  const unauthorized = cli('unauthorized');
  await queued(unauthorized);
  const beforeAuth = { ledger: ledgerSnapshot(), reservations: reservations(), queues: queueSnapshot() };
  assert.equal(beforeAuth.reservations.length, 0);
  f.store.sessionRepository.transaction(tx => tx.putSession({ ...session, revision: 1, state: 'finished', finishedAt: new Date().toISOString() }));
  writeFileSync(stage, 'open');
  const auth = await unauthorized.done;
  assert.notEqual(auth.cliExitCode, 0);
  assert.equal(auth.result.errorCode, 'CALLER_UNAUTHORIZED');
  assert.equal(auth.result.exitCode, null);
  assert.equal(existsSync(ready('unauthorized')), false);
  assert.deepEqual(auth.result.cleanup, { complete: true, remainingPids: [] });
  assert.deepEqual(ledgerSnapshot(), beforeAuth.ledger);
  assert.equal(reservations().length, 0);
  const finalQueues = queueSnapshot();
  assert.ok(finalQueues.every(q => q.entries.length === 0 && q.pendingTests.length === 0));
  evidence.authorization = { before: beforeAuth, resultRunId: auth.result.runId, ledger: ledgerSnapshot(), queues: finalQueues, reservations: reservations() };
  evidence.assertions.push('Closing the verified caller session while queued returns CALLER_UNAUTHORIZED rather than configuration refusal, without child, reservations, pending fence or ledger mutation.');
  evidence.outcome = 'passed';
} catch (error) {
  evidence.error = String(error);
  evidence.stack = (error as Error).stack;
  process.exitCode = 1;
} finally {
  for (const row of children) if (row.child.exitCode === null && row.child.signalCode === null) row.child.kill('SIGTERM');
  await Promise.all(children.map(row => row.done));
  try { await host?.close(); } catch (error) { evidence.hostCleanupError = String(error); process.exitCode = 1; }
  ledger?.close();
  const errors: string[] = [];
  for (const callback of callbacks) try { await callback(); } catch (error) { errors.push(String(error)); }
  if (unitHome) rmSync(unitHome, { recursive: true, force: true });
  if (artifacts) rmSync(artifacts, { recursive: true, force: true });
  evidence.cleanup = { children: children.map(row => ({ label: row.label, pid: row.child.pid, exitCode: row.child.exitCode, signal: row.child.signalCode })),
    standRemoved: f ? !existsSync(f.root) : null, unitHomeRemoved: unitHome ? !existsSync(unitHome) : null,
    artifactsRemoved: artifacts ? !existsSync(artifacts) : null, errors };
  if (errors.length || evidence.hostCleanupError) { evidence.outcome = 'failed'; process.exitCode = 1; }
  write(join(output, 'process.json'), evidence);
}
process.stdout.write(JSON.stringify({ outcome: evidence.outcome, assertions: evidence.assertions, cleanup: evidence.cleanup, error: evidence.error }) + '\n');
