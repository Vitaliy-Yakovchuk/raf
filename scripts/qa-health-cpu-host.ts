import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { openStateStore } from '../src/state-store.ts';
import { RafCostRuntime } from '../src/raf-cost-runtime.ts';
import { settleRuntimeHealthCpu } from '../src/health-cpu-runtime.ts';
import { evaluateResourceAdmission } from '../src/resource-admission.ts';
import { executeCommand } from '../src/os-runtime.ts';

const source = resolve(import.meta.dirname, '..');
const root = resolve(source, '..');
const mode = process.argv[2];
const burn = (ms: number) => {
  const started = performance.now();
  let n = 1;
  while (performance.now() - started < ms) for (let i = 0; i < 10000; i++) n = Math.sqrt(n + i);
  return n;
};

if (mode === 'own' || mode === 'payload') {
  const store = mode === 'own' ? openStateStore(process.argv[3]) : null;
  const scope = process.argv[4] as 'service' | 'worker' | 'command';
  const runtime = store ? new RafCostRuntime(store, { scope, command: scope === 'command' ? 'agent ps' : null }, root, 'handler') : null;
  process.send!({ ready: true });
  await new Promise<void>(done => process.once('message', () => done()));
  const before = process.cpuUsage();
  const startedAt = new Date().toISOString();
  burn(2200);
  const usage = process.cpuUsage(before);
  runtime?.finish();
  store?.close();
  process.send!({ role: mode, scope, startedAt, completedAt: new Date().toISOString(), cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000 });
  process.disconnect!();
} else {
  const output = resolve(process.argv[2] ?? 'evidence/monitor-raf-health/cpu-qa');
  await mkdir(output, { recursive: true });
  const base = await mkdtemp('/tmp/raf-health-cpu-host-');
  const fixtureRoot = join(base, 'root');
  await mkdir(join(fixtureRoot, 'conf'), { recursive: true });
  const raf = JSON.parse(await readFile(join(root, 'conf/raf.json'), 'utf8'));
  const configuredPolicy = structuredClone(raf.health);
  raf.health.cpuWindowMs = 1000;
  await writeFile(join(fixtureRoot, 'conf/raf.json'), JSON.stringify(raf));
  await writeFile(join(fixtureRoot, 'conf/raf-constants.json'), await readFile(join(root, 'conf/raf-constants.json')));
  const statePath = join(base, 'state.sqlite');
  let store = openStateStore(statePath);
  const children = new Set<ReturnType<typeof fork>>();
  const summary: any = {
    runId: randomUUID(), kind: 'local Linux integration stand with production modules and actual CPU; no raf CLI routing',
    sha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim(),
    workspaceStatus: spawnSync('git', ['status', '--porcelain=v1'], { cwd: source, encoding: 'utf8' }).stdout,
    platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite,
    configuredPolicy, standPolicy: raf.health, statePath,
    limitations: ['cpuWindowMs explicitly shortened in isolated fixture conf; production threshold retained', 'Own workload runs RafCostRuntime directly, not daemon/worker/CLI dispatch', 'No production state, HOME, service, agent or admission reservation is modified'],
    scenarios: [], cleanup: { complete: false },
  };
  const facts: unknown[] = [];
  const observeFacts = () => {
    const original = store.eventRepository.transaction;
    store.eventRepository.transaction = action => original(tx => action({ ...tx, savePending: fact => {
      facts.push(structuredClone(fact));
      return tx.savePending(fact);
    } }));
  };
  observeFacts();
  const pending = () => structuredClone(facts);
  const assess = () => settleRuntimeHealthCpu(store, fixtureRoot);
  const admissionUnit = JSON.parse(await readFile(join(output, 'unit.TestRunResult.json'), 'utf8'));
  const admissionInput = { measurement: admissionUnit.admission.measurement, requested: admissionUnit.admission.reservation.requested,
    unusedReservations: [], requiredFileSystemIds: Object.keys(admissionUnit.admission.reservation.requested.diskBytes) };
  const admissionBefore = evaluateResourceAdmission(admissionInput);
  const queueSnapshot = () => store.startupContextDatabase.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%queue%' OR name LIKE '%reservation%' OR name LIKE '%test_run%') ORDER BY name").all().map(row => ({ name: row.name, rows: store.startupContextDatabase.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all() }));
  const queueBefore = queueSnapshot();
  const record = (name: string, evidence: unknown) => summary.scenarios.push({ name, outcome: 'passed', evidence });
  async function startChild(role: 'own' | 'payload', scope = 'command') {
    const child = fork(import.meta.filename, [role, statePath, scope], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    let stdout = '', stderr = '', measurement: unknown;
    child.stdout!.on('data', data => stdout += data);
    child.stderr!.on('data', data => stderr += data);
    const ready = new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('message', () => done());
      child.once('exit', code => { if (code !== 0) reject(new Error(`Child failed before ready: ${code}: ${stderr}`)); });
    });
    const completed = new Promise<any>((done, reject) => {
      child.on('message', data => { if (!(data as any).ready) measurement = data; });
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); done({ code, signal, measurement, stdout, stderr }); });
    });
    await ready;
    return { child, completed };
  }
  try {
    const initial = await assess();
    assert.equal(initial?.availability, 'unavailable');
    assert.equal(initial?.cores, null);
    record('No baseline is unavailable', initial);
    const work = await Promise.all([startChild('own', 'service'), startChild('own', 'worker'), startChild('own', 'command'), startChild('payload')]);
    const baseline = store.healthCpu.readProfile();
    const opened = await assess();
    assert.notEqual(opened?.availability, 'complete');
    for (const item of work) item.child.send('go');
    const results = await Promise.all(work.map(item => item.completed));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const beforeAssessment = store.healthCpu.readProfile();
    const high = await assess();
    assert.equal(high?.availability, 'complete', JSON.stringify(high));
    assert.equal(high?.exceeded, true, JSON.stringify(high));
    assert.equal(pending().length, 1);
    assert.deepEqual(high!.sources, ['process.cpuUsage']);
    for (const scope of ['service', 'worker', 'command']) assert.ok(high!.scopes![scope].cpuUserMs > 0);
    const totals = beforeAssessment.profile.rows.reduce((a, row) => a + (row.cpuUserTotalMs ?? 0) + (row.cpuSystemTotalMs ?? 0), 0);
    assert.ok(Math.abs(high!.cpuUserMs! + high!.cpuSystemMs! - totals) < 0.001);
    record('Concurrent real self CPU and separate busy payload; one event', { baseline, opened, beforeAssessment, high, results, events: pending() });
    const eventsBefore = pending();
    await Promise.all([assess(), assess(), assess()]);
    assert.deepEqual(pending(), eventsBefore);
    store.close();
    store = openStateStore(statePath);
    observeFacts();
    await assess();
    assert.deepEqual(pending(), eventsBefore);
    record('Repeated observers and reopened SQLite retain one event', { events: pending() });
    const beforePayload = store.readCostProfile();
    const payload = await startChild('payload');
    payload.child.send('go');
    const payloadResult = await payload.completed;
    assert.equal(payloadResult.code, 0);
    const afterPayload = store.readCostProfile();
    assert.deepEqual(afterPayload.rows, beforePayload.rows);
    const noSamples = await assess();
    assert.notEqual(noSamples?.availability, 'complete');
    assert.equal(noSamples?.cores, null);
    assert.equal(pending().length, 1);
    record('Payload-only CPU never becomes own CPU or healthy zero', { payloadResult, beforePayload, afterPayload, assessment: noSamples });
    const runtime = new RafCostRuntime(store, { scope: 'command', command: 'agent ps' }, root, 'handler');
    runtime.install();
    const openUntil = performance.now() + raf.health.cpuWindowMs + 10;
    await new Promise(done => setTimeout(done, Math.max(0, openUntil - performance.now())));
    const openAssessment = await assess();
    assert.equal(openAssessment?.availability, 'partial');
    assert.equal(openAssessment?.reason, 'Unfinished own CPU intervals');
    const ok = await executeCommand({ executable: 'git', args: ['--version'], cwd: source });
    const refused = await executeCommand({ executable: 'git', args: ['--definitely-invalid-health-qa-option'], cwd: source });
    runtime.finish();
    await new Promise(done => setTimeout(done, raf.health.cpuWindowMs + 10));
    const unavailable = await assess();
    assert.equal(ok.exitCode, 0);
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.stderr, /unknown option/);
    assert.notEqual(unavailable?.availability, 'complete');
    assert.equal(unavailable?.cores, null);
    assert.equal(pending().length, 1);
    record('Open interval and real helper without per-child CPU remain unavailable; command statuses retained', { openAssessment, ok, refused, assessment: unavailable, profile: store.readCostProfile() });
    store.startupContextDatabase.exec('DROP TABLE raf_cost_profile');
    const readFailure = await assess();
    assert.equal(readFailure?.availability, 'unavailable');
    assert.match(readFailure!.reason!, /raf_cost_profile/);
    assert.equal(readFailure?.cores, null);
    assert.deepEqual(evaluateResourceAdmission(admissionInput), admissionBefore);
    assert.deepEqual(queueSnapshot(), queueBefore);
    record('Profile read failure preserves admission and actual queue/reservation tables', { readFailure, admissionInput, admissionBefore, admissionAfter: evaluateResourceAdmission(admissionInput), queueBefore, queueAfter: queueSnapshot() });
    summary.outcome = 'passed';
  } catch (error) {
    summary.outcome = 'failed';
    summary.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    process.exitCode = 1;
  } finally {
    for (const child of children) child.kill('SIGKILL');
    for (const child of children) await new Promise(done => child.once('close', done));
    store.close();
    await rm(base, { recursive: true, force: true });
    summary.cleanup = { complete: true, remainingPids: [], removed: base };
    await writeFile(join(output, 'host.summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ outcome: summary.outcome, runId: summary.runId, scenarios: summary.scenarios.map((s: any) => s.name), error: summary.error, cleanup: summary.cleanup }));
  }
}
