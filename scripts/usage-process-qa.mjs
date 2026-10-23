import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { openStateStore } from '../src/state-store.ts';
import { createSessionState } from '../src/session-state.ts';
import { observeProcesses } from '../src/os-runtime.ts';
import { runtimeResourceUsage, usageProcessIdentity } from '../src/resource-usage-runtime.ts';
import { createTestRunResourcePort } from '../src/test-run-resource-runtime.ts';
import { testWrapperIdentity } from '../src/test-run-resource-process.ts';

const script = fileURLToPath(import.meta.url);
const code = resolve(dirname(script), '..');
const root = resolve(code, '..');
const mode = process.argv[2] ?? 'driver';
const delay = ms => new Promise(done => setTimeout(done, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const confFiles = ['flow.json', 'raf.json', 'test-runs.json', 'raf-constants.json'];
const confHashes = () => Object.fromEntries(confFiles.map(file => [file, hash(readFileSync(join(root, 'conf', file)))]));
const minimalEnv = home => ({ HOME: home, TMPDIR: join(home, 'tmp'), PATH: process.env.PATH, LC_ALL: 'C' });
let sequence = 0;
function request(child, command) {
  return new Promise((resolveRequest, reject) => {
    const serial = ++sequence;
    const timer = setTimeout(() => finish(new Error(`Process QA RPC stalled: ${command.action}`)), 25000);
    const received = message => { if (message.serial === serial) finish(message.error ? new Error(message.error) : null, message.value); };
    const exited = (exitCode, signal) => finish(new Error(`RPC child exited: ${exitCode}/${signal}`));
    function finish(error, value) {
      clearTimeout(timer); child.off('message', received); child.off('exit', exited);
      if (error) reject(error); else resolveRequest(value);
    }
    child.on('message', received); child.once('exit', exited);
    child.send({ ...command, serial }, error => { if (error) finish(error); });
  });
}
function serve(handler) {
  process.on('message', async message => {
    try { process.send({ serial: message.serial, value: await handler(message) }); }
    catch (error) { process.send({ serial: message.serial, error: error.stack }); }
  });
  process.send({ ready: true, pid: process.pid, home: process.env.HOME });
}
async function ready(child) {
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try { const [message] = await once(child, 'message'); assert.equal(message.ready, true); return message; }
  finally { clearTimeout(timer); }
}

if (mode === 'leaf') {
  let memory = null;
  let held = null;
  serve(async message => {
    const directory = process.argv[3];
    if (message.action === 'grow') {
      memory = Buffer.alloc(message.memoryBytes, 7);
      writeFileSync(join(directory, 'growth'), Buffer.alloc(message.diskBytes, 9));
      return { pid: process.pid, allocated: statSync(join(directory, 'growth')).blocks * 512, memoryBytes: memory.length };
    }
    if (message.action === 'shrink') {
      memory = null;
      unlinkSync(join(directory, 'growth'));
      for (let i = 0; i < 4; i++) { global.gc(); await delay(100); }
      return { pid: process.pid, memoryBytes: 0 };
    }
    if (message.action === 'deleted-open') {
      const path = join(directory, 'deleted-open');
      writeFileSync(path, Buffer.alloc(message.bytes, 3));
      held = openSync(path, 'r');
      const allocated = statSync(path).blocks * 512;
      unlinkSync(path);
      return { held, allocated, path };
    }
    if (message.action === 'close-file') { closeSync(held); held = null; return true; }
    if (message.action === 'ping') return { pid: process.pid, memoryBytes: memory?.length ?? 0 };
    throw new Error(`Unexpected leaf action ${message.action}`);
  });
} else if (mode === 'workload') {
  const child = fork(script, ['leaf', process.argv[3]], { execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await ready(child);
  serve(message => request(child, message));
} else if (mode === 'observer') {
  const statePath = join(process.env.HOME, '.raf', 'state.sqlite');
  const store = openStateStore(statePath);
  const usage = runtimeResourceUsage(store.startupContextDatabase, root);
  const state = createSessionState({ repository: store.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => false });
  const flow = json(join(root, 'conf/flow.json'));
  const cadence = json(join(root, 'conf/raf.json')).service.hostTickIntervalMs;
  const ticks = [];
  const timer = setInterval(() => { const at = Date.now(); usage.tracker.hostTick(at); ticks.push(at); }, cadence);
  const getSession = id => store.sessionRepository.transaction(tx => tx.getSession(id), 'read');
  const get = id => usage.repository.get({ kind: 'agent', id });
  let testResources;
  let testClaim;
  serve(async message => {
    if (message.action === 'prepare') {
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const estimate = flow.resourceEstimates.agentTypes.qa;
      const context = { identity: { kind: 'agent', id: message.id, machineId: readFileSync('/etc/machine-id', 'utf8').trim(), bootId, fence: randomUUID(), root: null },
        project: 'raf', agentType: 'qa', testProfile: null, items: [{ project: 'raf', change: 'fix-raf-load-admission', item: '3.6' }],
        requestedEstimate: { ramBytes: estimate.ramBytes, diskBytes: { [message.volume]: estimate.diskBytesPerFileSystem }, sources: ['conf/flow.json#/resourceEstimates/agentTypes/qa'], confHash: hash(JSON.stringify({ resources: flow.resources, resourceEstimates: flow.resourceEstimates })) },
        requiredFileSystems: [{ id: message.volume, paths: [message.directory, process.env.HOME] }], attributedPaths: [message.directory] };
      const reserved = state.reserveLaunch(message.id, message.id, { type: 'qa', project: 'raf', features: ['fix-raf-load-admission'], phase: 'qa', cwd: code }, { resource: 'runtime', amount: estimate.ramBytes });
      store.sessionRepository.transaction(tx => tx.putSession({ ...reserved, launchContext: { resourceUsageContext: context, assignment: { root, changes: [] }, selection: { runner: 'process-qa', model: 'fixture', effort: 'fixture', reason: 'process QA' }, briefPath: join(process.env.HOME, 'brief.txt'), reportPath: join(process.env.HOME, 'report.json') } }));
      return get(message.id);
    }
    if (message.action === 'start') {
      const startedAt = new Date(execFileSync('ps', ['-p', String(message.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()).toISOString();
      const command = execFileSync('ps', ['-ww', '-p', String(message.pid), '-o', 'args='], { encoding: 'utf8' }).trim();
      assert.ok(state.commitStarted(message.id, { pid: message.pid, startedAt, runner: 'process-qa', runnerSessionId: message.id, tmuxSession: '', evidence: { command } }));
      assert.equal(get(message.id).context.identity.root.pid, message.pid);
      return get(message.id);
    }
    if (message.action === 'reconcile') {
      const session = getSession(message.id);
      const [observation] = await observeProcesses([session.process]);
      assert.ok(state.commitObservation(message.id, session.revision, observation, { pending: [], domain: [] }));
      return { observation, record: get(message.id), session: getSession(message.id) };
    }
    if (message.action === 'snapshot') return { record: get(message.id), ticks, session: getSession(message.id), raw: usage.measurement.sample(get(message.id).context.identity, Date.now()) };
    if (message.action === 'finish') {
      const session = getSession(message.id);
      assert.ok(state.finalizeSession(message.id, session.revision, new Date().toISOString(), { pending: [], domain: [] }));
      return { record: get(message.id), session: getSession(message.id), reservations: store.sessionRepository.transaction(tx => tx.listReservations(), 'read') };
    }
    if (message.action === 'retention') {
      const session = getSession(message.id);
      const before = state.cleanupCompleted(new Date(Date.parse(session.finishedAt) + flow.retention.finishedSessionsMs - 1).toISOString());
      assert.ok(get(message.id));
      const removed = state.cleanupCompleted(new Date(Date.parse(session.finishedAt) + flow.retention.finishedSessionsMs).toISOString());
      return { before, removed, usage: get(message.id), session: getSession(message.id) ?? null, retainedActive: get(message.active) };
    }
    if (message.action === 'test-prepare') {
      const config = json(join(root, 'conf/test-runs.json'));
      const fixtureEstimate = { ramBytes: 2147483648, diskBytesPerFileSystem: 10737418240 };
      assert.equal(config.projects.raf.profiles.node.resourceEstimate, undefined);
      config.projects.raf.profiles.node.resourceEstimate = fixtureEstimate;
      testResources = createTestRunResourcePort(store, { root, workspace: code, home: process.env.HOME, machineId: readFileSync('/etc/machine-id', 'utf8').trim(),
        config, resultStatePath: join(process.env.HOME, '.raf', 'test-results.sqlite') });
      const estimate = await testResources.estimateProfile('raf', 'node');
      assert.equal(estimate.status, 'KNOWN');
      const machineId = readFileSync('/etc/machine-id', 'utf8').trim();
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      testClaim = { machineId, testRunId: 'process-QA-C', fence: randomUUID(), groupKey: { project: 'raf', workspace: code, group: 'fix-raf-load-admission/usage' },
        deadlineMs: Date.now() + 90000, processIdentity: null };
      store.sessionRepository.transaction(tx => tx.putReservation({ runId: testClaim.testRunId, resource: 'test-run', amount: estimate.reservation.ramBytes,
        resourceBundle: { machineId, resources: estimate.reservation }, testRun: { claim: testClaim, committed: false, ownerIdentity: testWrapperIdentity() } }));
      usage.tracker.prepare({ identity: { kind: 'test', id: testClaim.testRunId, machineId, bootId, fence: testClaim.fence, root: null }, project: 'raf', agentType: null, testProfile: 'node', items: [],
        requestedEstimate: { ...estimate.reservation, sources: estimate.sources, confHash: hash(JSON.stringify(config)) },
        requiredFileSystems: Object.keys(estimate.reservation.diskBytes).map(id => ({ id, paths: [root, code] })),
        resultStatePath: join(process.env.HOME, '.raf', 'test-results.sqlite') }, true, Date.now());
      assert.ok(await testResources.commit(testClaim));
      await testResources.beforeSpawn(testClaim, [message.directory]);
      return { status: 'fixture-prepared', claim: testClaim, estimate, fixtureEstimate,
        fixtureSource: 'Usage-only fixture seeds a claim in isolated SQLite, then exercises real test lifecycle port. Admission is excluded: actual attempts 3/4 were UNKNOWN/NO_RESOURCES. Item 3.2.1 estimate is applied only to in-memory QA config; source conf files unchanged.', record: await testResources.resourceUsage(testClaim) };
    }
    if (message.action === 'test-start') {
      const identity = usageProcessIdentity(message.pid);
      await testResources.bindProcess(testClaim, JSON.stringify({ pid: identity.pid, start: identity.startTicks, boot: identity.bootId }));
      return await testResources.resourceUsage(testClaim);
    }
    if (message.action === 'test-sample') {
      await testResources.sampleUsage(testClaim);
      return { tree: await testResources.observeTree(testClaim), record: await testResources.resourceUsage(testClaim) };
    }
    if (message.action === 'test-finish') {
      const tree = await testResources.observeTree(testClaim);
      assert.equal(tree.state, 'dead');
      await testResources.finishUsage(testClaim, 'death');
      assert.ok(await testResources.release(testClaim));
      const record = await testResources.resourceUsage(testClaim);
      const kept = usage.repository.prune({ now: Date.now(), finishedSessionsMs: flow.retention.finishedSessionsMs, retainedTestRunIds: [testClaim.testRunId] });
      assert.ok(await testResources.resourceUsage(testClaim));
      const removed = usage.repository.prune({ now: Date.now(), finishedSessionsMs: flow.retention.finishedSessionsMs, retainedTestRunIds: [] });
      return { tree, record, kept, removed, afterRetention: await testResources.resourceUsage(testClaim) };
    }
    if (message.action === 'close') { clearInterval(timer); store.close(); setImmediate(() => process.exit(0)); return true; }
    throw new Error(`Unexpected observer action ${message.action}`);
  });
} else {
  const output = resolve(process.argv[3] ?? '/tmp/raf-usage-process-qa.json');
  const fixture = mkdtempSync('/tmp/raf-usage-process-qa-');
  const testScope = mkdtempSync(join(code, '.usage-process-qa-'));
  const home = join(fixture, 'home');
  for (const directory of [join(home, '.raf'), join(home, 'tmp'), join(fixture, 'A'), join(fixture, 'B'), join(fixture, 'C'), join(fixture, 'foreign')]) mkdirSync(directory, { recursive: true });
  const evidence = { assignment: 'fix-raf-load-admission:3.6', command: [process.execPath, script, 'driver', output],
    environment: { platform: process.platform, osRelease: release(), arch: arch(), node: process.version, codeSha: execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      orchestratorSha: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workspaceStatus: execFileSync('git', ['-C', code, 'status', '--porcelain=v1'], { encoding: 'utf8' }), home, fixture, testScope, confBefore: confHashes(),
      sourceHashes: Object.fromEntries(['scripts/usage-process-qa.mjs', 'src/resource-usage.ts', 'src/resource-usage-runtime.ts', 'src/state-store.ts', 'src/session-state.ts', 'src/os-runtime.ts'].map(file => [file, hash(readFileSync(join(code, file)))])) },
    method: { integration: 'Real Linux parent/leaf trees and OS process observations, production StateStore/session lifecycle, runtimeResourceUsage and configured host tick; no raf CLI, adapter, tmux or service activation simulated as production.',
      ram: 'Simultaneous /proc VmRSS sum over identity-verified tree, sampled; RSS page precision, shared pages can count per process; short intersample peaks may be missed.',
      disk: 'st_blocks*512 for attributed paths and verified open fds, above pre-spawn inode baseline; shared checkout remains partial. Agents use isolated tmpfs fixture; test port uses the actual development volume. Simultaneous per-run multiple-volume arithmetic is unit-covered only.',
      retention: 'Production cleanupCompleted called with explicit logical timestamp around configured retention boundary; no 24-hour wall-clock wait, no conf edits.' },
    checkpoints: [], processes: [], failures: [] };
  const children = [];
  let observer;
  const launch = async (role, args = [], detached = false) => {
    const child = fork(script, [role, ...args], { execArgv: [], env: minimalEnv(home), detached, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const row = { role, pid: child.pid, argv: [process.execPath, script, role, ...args], stdout: '', stderr: '', exitCode: null, signal: null };
    evidence.processes.push(row); children.push({ child, detached });
    child.stdout.on('data', chunk => { row.stdout += chunk; }); child.stderr.on('data', chunk => { row.stderr += chunk; });
    child.on('exit', (exitCode, signal) => { row.exitCode = exitCode; row.signal = signal; });
    const message = await ready(child); assert.equal(message.home, home);
    return child;
  };
  const stop = async (child, detached = false) => {
    const exited = once(child, 'exit');
    if (detached) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');
    await exited;
  };
  const checkpoint = async (label, id) => { const snapshot = await request(observer, { action: 'snapshot', id }); evidence.checkpoints.push({ label, ...snapshot }); return snapshot.record; };
  const sample = async id => request(observer, { action: 'reconcile', id });
  const guard = setTimeout(() => { for (const { child, detached } of children) { try { if (detached) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} } }, 180000);
  try {
    for (const id of ['A', 'B']) writeFileSync(join(fixture, id, 'baseline'), Buffer.alloc(1024 * 1024, 1));
    const volume = String(statSync(fixture).dev);
    observer = await launch('observer');
    for (const id of ['A', 'B']) await request(observer, { action: 'prepare', id, volume, directory: join(fixture, id) });
    const [a, b] = await Promise.all([launch('workload', [join(fixture, 'A')], true), launch('workload', [join(fixture, 'B')], true)]);
    for (const [id, child] of [['A', a], ['B', b]]) await request(observer, { action: 'start', id, pid: child.pid });
    const a0 = await checkpoint('A baseline', 'A');
    const b0 = await checkpoint('B baseline', 'B');
    assert.equal(a0.disk[volume].currentBytes, 0); assert.equal(b0.disk[volume].currentBytes, 0);
    const [allocatedA, allocatedB] = await Promise.all([
      request(a, { action: 'grow', memoryBytes: 64 * 1024 * 1024, diskBytes: 8 * 1024 * 1024 }),
      request(b, { action: 'grow', memoryBytes: 32 * 1024 * 1024, diskBytes: 16 * 1024 * 1024 })]);
    evidence.workloads = { A: allocatedA, B: allocatedB, volume };
    const cadence = json(join(root, 'conf/raf.json')).service.hostTickIntervalMs;
    await delay(2 * cadence + 1500);
    const a1 = await checkpoint('A host tick grown', 'A');
    const b1 = await checkpoint('B host tick grown', 'B');
    assert.ok(a1.lastObservedAt > a0.lastObservedAt); assert.ok(b1.lastObservedAt > b0.lastObservedAt);
    assert.ok(a1.ram.currentBytes - a0.ram.currentBytes > 48 * 1024 * 1024);
    assert.ok(b1.ram.currentBytes - b0.ram.currentBytes > 24 * 1024 * 1024);
    assert.equal(a1.disk[volume].currentBytes, allocatedA.allocated); assert.equal(b1.disk[volume].currentBytes, allocatedB.allocated);
    const rawA = evidence.checkpoints.at(-2).raw;
    assert.deepEqual(new Set(rawA.ram.processes.map(row => row.identity.pid)), new Set([a.pid, allocatedA.pid]));
    writeFileSync(join(fixture, 'foreign', 'growth'), Buffer.alloc(24 * 1024 * 1024, 5));
    await sample('A'); await sample('B');
    const a2 = await checkpoint('A foreign growth excluded', 'A');
    const b2 = await checkpoint('B foreign growth excluded', 'B');
    assert.equal(a2.disk[volume].currentBytes, allocatedA.allocated); assert.equal(b2.disk[volume].currentBytes, allocatedB.allocated);
    const held = await request(a, { action: 'deleted-open', bytes: 4 * 1024 * 1024 });
    await sample('A'); const openDeleted = await checkpoint('A deleted open file', 'A');
    assert.equal(openDeleted.disk[volume].currentBytes, allocatedA.allocated + held.allocated);
    await request(a, { action: 'close-file' }); await request(a, { action: 'shrink' });
    await sample('A'); const a3 = await checkpoint('A RAM and disk released', 'A');
    assert.ok(a1.ram.currentBytes - a3.ram.currentBytes > 32 * 1024 * 1024);
    assert.equal(a3.disk[volume].currentBytes, 0);
    assert.equal(a3.peakDiskBytes[volume], openDeleted.peakDiskBytes[volume]);
    assert.ok(a3.peakRamBytes >= a1.peakRamBytes);
    await stop(observer);
    assert.ok(usageProcessIdentity(a.pid)); assert.ok(usageProcessIdentity(b.pid));
    observer = await launch('observer');
    const a4 = await checkpoint('A observer restarted', 'A');
    assert.equal(a4.peakDiskBytes[volume], a3.peakDiskBytes[volume]); assert.equal(a4.peakRamBytes, a3.peakRamBytes);
    assert.equal(a4.completeness, 'partial'); assert.ok(a4.reasons.some(reason => reason.includes('reattached')));
    const b4 = await checkpoint('B observer restarted', 'B');
    await stop(a, true);
    const dead = await sample('A'); evidence.reconciledDeath = dead;
    assert.equal(dead.observation.state, 'exited'); assert.equal(dead.record.finishReason, 'death'); assert.equal(dead.record.completeness, 'partial');
    assert.equal(dead.record.peakDiskBytes[volume], a3.peakDiskBytes[volume]);
    const repeat = await request(observer, { action: 'snapshot', id: 'A' }); assert.deepEqual(repeat.record, dead.record);
    const finished = await request(observer, { action: 'finish', id: 'A' }); evidence.finished = finished;
    assert.ok(finished.record); assert.equal(finished.reservations.some(row => row.runId === 'A'), false);
    const retained = await request(observer, { action: 'retention', id: 'A', active: 'B' }); evidence.retention = retained;
    assert.equal(retained.before, 0); assert.equal(retained.removed, 1); assert.equal(retained.usage, null); assert.equal(retained.session, null);
    assert.equal(retained.retainedActive.finishedAt, null); assert.equal(retained.retainedActive.peakDiskBytes[volume], b4.peakDiskBytes[volume]);
    await stop(b, true); await sample('B'); await request(observer, { action: 'finish', id: 'B' });
    const testPrepared = await request(observer, { action: 'test-prepare', directory: testScope });
    evidence.testUsage = { preparation: testPrepared };
    assert.equal(testPrepared.status, 'fixture-prepared');
    const c = await launch('workload', [testScope], true);
    const c0 = await request(observer, { action: 'test-start', pid: c.pid });
    const allocatedC = await request(c, { action: 'grow', memoryBytes: 32 * 1024 * 1024, diskBytes: 4 * 1024 * 1024 });
    evidence.workloads.C = allocatedC;
    const c1 = await request(observer, { action: 'test-sample' });
    evidence.testUsage.baseline = c0; evidence.testUsage.grown = c1;
    assert.equal(c1.tree.state, 'alive'); assert.ok(c1.record.peakRamBytes > c0.peakRamBytes + 24 * 1024 * 1024);
    const testVolume = Object.keys(c1.record.disk)[0];
    assert.equal(c1.record.disk[testVolume].currentBytes, allocatedC.allocated);
    await request(c, { action: 'shrink' });
    const c2 = await request(observer, { action: 'test-sample' }); evidence.testUsage.released = c2;
    assert.equal(c2.record.disk[testVolume].currentBytes, 0); assert.equal(c2.record.peakDiskBytes[testVolume], allocatedC.allocated);
    await stop(c, true);
    const c3 = await request(observer, { action: 'test-finish' }); evidence.testUsage.finished = c3;
    assert.equal(c3.record.peakDiskBytes[testVolume], allocatedC.allocated); assert.equal(c3.record.completeness, 'partial');
    assert.equal(c3.afterRetention, null); assert.deepEqual(c3.kept, []); assert.deepEqual(c3.removed, [{ kind: 'test', id: 'process-QA-C' }]);
    await request(observer, { action: 'close' }); await once(observer, 'exit');
    evidence.environment.confAfter = confHashes(); assert.deepEqual(evidence.environment.confAfter, evidence.environment.confBefore);
    evidence.outcome = 'passed';
  } catch (error) { evidence.outcome = 'failed'; evidence.failures.push(error.stack); process.exitCode = 1; }
  finally {
    clearTimeout(guard);
    for (const { child, detached } of children) {
      try { if (detached) process.kill(-child.pid, 'SIGKILL'); else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch {}
    }
    await delay(200);
    const pids = [...children.map(({ child }) => child.pid), ...Object.values(evidence.workloads ?? {}).filter(value => value?.pid).map(value => value.pid)];
    evidence.cleanup = { checkedPids: pids, remainingPids: pids.filter(pid => usageProcessIdentity(pid)), removedFixture: fixture };
    rmSync(fixture, { recursive: true, force: true }); evidence.cleanup.fixtureAbsent = !existsSync(fixture);
    rmSync(testScope, { recursive: true, force: true }); evidence.cleanup.testScope = testScope; evidence.cleanup.testScopeAbsent = !existsSync(testScope);
    if (evidence.cleanup.remainingPids.length) { evidence.outcome = 'failed'; process.exitCode = 1; }
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ outcome: evidence.outcome, output, checkpoints: evidence.checkpoints.length, failures: evidence.failures, cleanup: evidence.cleanup }));
  }
}
