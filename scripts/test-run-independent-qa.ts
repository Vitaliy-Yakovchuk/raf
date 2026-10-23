import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const code = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const root = resolve(code, '..');
const output = resolve(process.argv[2] ?? '/tmp/raf-independent-qa');
mkdirSync(output, { recursive: true });
const stand = mkdtempSync('/tmp/raf-independent-qa-');
const workspace = join(stand, 'workspace');
const confRoot = join(stand, 'orchestrator');
mkdirSync(workspace);
mkdirSync(join(confRoot, 'conf'), { recursive: true });
mkdirSync(join(confRoot, 'openspec/changes/add-raf-test-run'), { recursive: true });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
for (const file of ['projects.json', 'raf.json', 'raf-constants.json', 'flow.json', 'test-runs.json']) cpSync(join(root, 'conf', file), join(confRoot, 'conf', file));
const projects = read(join(confRoot, 'conf/projects.json'));
projects.projects.raf.path = resolve(root, projects.projects.raf.path);
for (const branch of Object.keys(projects.projects.raf.branchPaths)) projects.projects.raf.branchPaths[branch] = resolve(root, projects.projects.raf.branchPaths[branch]);
projects.projects.raf.branchPaths.independent = workspace;
write(join(confRoot, 'conf/projects.json'), projects);
execFileSync('git', ['init', '-q', workspace]);
execFileSync('git', ['-C', workspace, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--allow-empty', '-qm', 'Independent QA']);
const prelude = "import {test, describe} from 'node:test'; import assert from 'node:assert/strict';\n";
const fixtures: Record<string, string> = {
  'green.test.ts': prelude + "describe('outer', () => describe('inner', () => test('green', () => assert.ok(true))));",
  'parent.test.ts': prelude + "test('parent', async t => { await t.test('completed child', () => {}); await new Promise(() => {}); }); setInterval(() => {}, 1000);",
  'parent-red.test.ts': prelude + "test('parent', async t => { await t.test('red child', () => assert.fail('missing behavior')); });",
  'tree.test.ts': prelude + "import {spawn} from 'node:child_process'; import {appendFileSync} from 'node:fs'; const body = `require('node:fs').appendFileSync(process.env.QA_PID_LOG, process.pid + String.fromCharCode(10)); setInterval(() => {}, 1000);`; spawn(process.execPath, ['-e', body], {detached:true, stdio:'ignore'}); appendFileSync(process.env.QA_PID_LOG, process.pid + '\\n'); describe('outer', () => describe('inner', () => { test('blocked', async () => new Promise(() => {})); test('queued', () => {}); })); setInterval(() => {}, 1000);",
  'sentinel.test.ts': prelude + "test('unselected inventory', () => {});",
};
for (const [file, body] of Object.entries(fixtures)) writeFileSync(join(workspace, file), body);
const config = read(join(confRoot, 'conf/test-runs.json'));
config.projects = { raf: { profiles: { node: { cwd: '.', executable: process.execPath, argv: [join(code, 'scripts/test-run-node.ts')], unitFiles: Object.keys(fixtures), exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [] } }, groups: {} } };
write(join(confRoot, 'conf/test-runs.json'), config);
const flow = read(join(confRoot, 'conf/flow.json'));
flow.unitTests = { timeoutMs: 1800, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 };
write(join(confRoot, 'conf/flow.json'), flow);
const owned = new Map<number, string>();
function identity(pid: number): string | null {
  try { const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' '); return fields[0] === 'Z' ? null : fields[19]; } catch { return null; }
}
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
const evidence: any = { stand, environment: { node: process.version, executable: process.execPath, os: release(), platform: process.platform, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(), fingerprints: Object.fromEntries(['src/test-run-processes.ts', 'src/test-run-runtime.ts', 'src/test-run-reporter.ts', 'src/test-runs.ts', 'scripts/test-run-independent-qa.ts'].map(file => [file, createHash('sha256').update(readFileSync(join(code, file))).digest('hex')])) }, policy: flow.unitTests, cases: [], failures: [] };
const database = (home: string) => join(home, '.raf', read(join(confRoot, 'conf/raf.json')).state.fileName);
function state(home: string) {
  const db = new DatabaseSync(database(home));
  try { return db.prepare('SELECT payload FROM test_run_groups').all().map((row: any) => JSON.parse(row.payload)); } finally { db.close(); }
}
function launch(label: string, file: string, homeName: string, phase = 'qa') {
  const home = join(stand, homeName);
  mkdirSync(home, { recursive: true });
  const pidLog = join(home, `${label}.pids`);
  const argv = [join(code, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', phase, '--group', `add-raf-test-run/${homeName}`, '--files', file];
  const started = Date.now();
  const child = spawn(process.execPath, argv, { cwd: workspace, env: { ...process.env, HOME: home, RAF_QA_HOME: home, RAF_ORCHESTRATOR_ROOT: confRoot, QA_PID_LOG: pidLog }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const track = () => {
    if (!existsSync(pidLog)) return [];
    const pids = readFileSync(pidLog, 'utf8').trim().split('\n').filter(Boolean).map(Number);
    for (const pid of pids) { const start = identity(pid); if (start) owned.set(pid, start); }
    return pids;
  };
  const tracker = setInterval(track, 10);
  const guard = setTimeout(() => child.kill('SIGKILL'), 12000);
  const done = new Promise<any>((done, fail) => {
    child.once('error', fail);
    child.once('close', (rc, signal) => {
      const pids = track(); clearTimeout(guard); clearInterval(tracker);
      let result; try { result = JSON.parse(stdout); } catch { }
      const row = { label, argv: [process.execPath, ...argv], cwd: workspace, home, rc, signal, durationMs: Date.now() - started, result, stdout, stderr, pids, livePids: pids.filter(pid => identity(pid)), state: existsSync(database(home)) ? state(home) : null };
      evidence.cases.push(row); write(join(output, `${label}.json`), row); done(row);
    });
  });
  return { child, home, pidLog, done };
}
async function ready(run: ReturnType<typeof launch>) {
  for (let count = 0; count < 100 && (!existsSync(run.pidLog) || readFileSync(run.pidLog, 'utf8').trim().split('\n').length < 2); count++) await delay(10);
  assert.ok(existsSync(run.pidLog), 'fixture must start before interruption');
}
function expect(row: any, outcome: string) {
  assert.equal(row.signal, null, row.stderr);
  assert.equal(row.result?.outcome, outcome, row.stdout + row.stderr);
  assert.equal(row.rc, outcome === 'passed' ? 0 : 1);
  assert.deepEqual(row.result.cleanup, { complete: true, remainingPids: [] });
  assert.deepEqual(row.livePids, []);
}
async function scenario(label: string, body: () => Promise<void>) {
  try { await body(); process.stdout.write(`PASS ${label}\n`); }
  catch (error) { evidence.failures.push({ label, error: String(error), stack: (error as Error).stack }); process.stdout.write(`FAIL ${label}: ${String(error)}\n`); }
  write(join(output, 'summary.json'), evidence);
}
await scenario('nested-green', async () => {
  const row = await launch('nested-green', 'green.test.ts', 'green').done;
  expect(row, 'passed'); assert.deepEqual(row.result.passed, [{ file: 'green.test.ts', name: 'outer inner green' }]);
});
await scenario('pending-parent-after-completed-child', async () => {
  const row = await launch('parent', 'parent.test.ts', 'parent').done;
  expect(row, 'timed-out'); assert.deepEqual(row.result.unexecuted, [{ file: 'parent.test.ts', name: 'parent' }]);
});
await scenario('completed-parent-with-red-child', async () => {
  const row = await launch('parent-red', 'parent-red.test.ts', 'parent-red').done;
  expect(row, 'assertions-failed'); assert.deepEqual(row.result.failureKinds, ['assertions']);
  assert.deepEqual(row.result.knownRed, [{ file: 'parent-red.test.ts', name: 'parent red child' }]);
  assert.deepEqual(row.result.unexecuted, []); assert.deepEqual(row.result.unknown, []);
});
await scenario('nested-pending-and-detached-cleanup', async () => {
  const row = await launch('tree', 'tree.test.ts', 'tree').done;
  expect(row, 'timed-out'); assert.ok(row.pids.length >= 2);
  assert.deepEqual(row.result.unexecuted.map((id: any) => id.name).sort(), ['outer inner blocked', 'outer inner queued']);
  assert.equal(row.result.timeoutCount, 1); assert.equal(row.state[0].timeoutCount, 1);
});
await scenario('sigint', async () => {
  const run = launch('interrupt', 'tree.test.ts', 'interrupt'); await ready(run); run.child.kill('SIGINT');
  const row = await run.done; expect(row, 'interrupted'); assert.equal(row.result.timeoutCount, 0); assert.equal(row.result.signal, 'SIGINT');
});
for (const killTree of [false, true]) await scenario(`recovery-tree-${killTree ? 'gone' : 'alive'}`, async () => {
  const name = killTree ? 'recovery-gone' : 'recovery-alive';
  const run = launch(`${name}-killed`, 'tree.test.ts', name, 'red'); await ready(run);
  const snapshot = state(run.home)[0];
  const runner = JSON.parse(snapshot.inFlight.processIdentity);
  run.child.kill('SIGKILL'); await run.done;
  if (killTree) {
    for (const pid of readFileSync(run.pidLog, 'utf8').trim().split('\n').map(Number)) { try { process.kill(pid, 'SIGKILL'); } catch { } }
    try { process.kill(-runner.pid, 'SIGKILL'); } catch { }
  } else {
    const blocked = await launch(`${name}-blocked`, 'tree.test.ts', name).done;
    expect(blocked, 'refused'); assert.equal(blocked.result.errorCode, 'GROUP_IN_FLIGHT'); assert.equal(state(run.home)[0].timeoutCount, 0);
  }
  await delay(Math.max(0, snapshot.inFlight.deadlineMs - Date.now()) + 30);
  const recovered = await launch(`${name}-reconciled`, 'tree.test.ts', name).done;
  expect(recovered, 'refused'); assert.equal(recovered.result.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(recovered.state[0].inFlight, null); assert.equal(recovered.state[0].timeoutCount, 1);
  const green = await launch(`${name}-green`, 'green.test.ts', name, 'implement').done;
  expect(green, 'passed'); assert.equal(green.result.timeoutCount, 1);
});
await delay(30);
evidence.liveOwnedPids = [...owned].filter(([pid, start]) => identity(pid) === start).map(([pid]) => pid);
if (evidence.liveOwnedPids.length) evidence.failures.push({ label: 'leaked-owned-processes', pids: evidence.liveOwnedPids });
for (const pid of evidence.liveOwnedPids) { try { process.kill(pid, 'SIGKILL'); } catch { } }
evidence.status = evidence.failures.length ? 'failed' : 'passed';
write(join(output, 'summary.json'), evidence);
process.stdout.write(JSON.stringify({ status: evidence.status, cases: evidence.cases.length, failures: evidence.failures.map((row: any) => row.label), output }) + '\n');
process.exitCode = evidence.failures.length ? 1 : 0;
