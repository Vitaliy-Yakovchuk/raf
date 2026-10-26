import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, release, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const code = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const source = resolve(code, '..');
const output = resolve(process.argv[2] ?? '/tmp/raf-test-run-qa-evidence');
mkdirSync(output, { recursive: true });
const stand = mkdtempSync(join(tmpdir(), 'raf-test-run-qa-'));
const workspace = join(stand, 'workspace');
const confRoot = join(stand, 'orchestrator');
mkdirSync(workspace, { recursive: true });
mkdirSync(join(confRoot, 'conf'), { recursive: true });
mkdirSync(join(confRoot, 'openspec/changes/add-raf-test-run'), { recursive: true });
for (const file of ['projects.json', 'raf.json', 'raf-constants.json', 'flow.json', 'test-runs.json']) cpSync(join(source, 'conf', file), join(confRoot, 'conf', file));
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const projects = json(join(confRoot, 'conf/projects.json'));
projects.projects.raf.path = resolve(source, projects.projects.raf.path);
for (const key of Object.keys(projects.projects.raf.branchPaths)) projects.projects.raf.branchPaths[key] = resolve(source, projects.projects.raf.branchPaths[key]);
projects.projects.raf.branchPaths['qa-fixture'] = workspace;
write(join(confRoot, 'conf/projects.json'), projects);
execFileSync('git', ['init', '-q', workspace]);
execFileSync('git', ['-C', workspace, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'QA fixture', '--allow-empty']);
const test = (name: string, text: string) => writeFileSync(join(workspace, name), text);
const prelude = "import { test, describe } from 'node:test'; import assert from 'node:assert/strict';\n";
test('green.test.ts', prelude + "test('green', () => assert.equal(2 + 2, 4));\n");
test('red.test.ts', prelude + "test('literal a.* [x] (one)|two$', () => assert.equal(1, 2)); test('other', () => assert.ok(true));\n");
test('setup.test.ts', prelude + "test('broken setup', () => { throw new Error('fixture failure'); });\n");
test('import.test.ts', "import './missing-module.ts';\n");
test('nested.test.ts', prelude + "describe('suite', () => { test('red child', () => assert.equal(1, 2)); test('other child', () => assert.ok(true)); });\n");
test('skip.test.ts', prelude + "test.skip('not executed', () => {});\n");
test('hang.test.ts', prelude + "import { spawn } from 'node:child_process'; import { appendFileSync } from 'node:fs';\nconst child = spawn(process.execPath, ['-e', `require('node:fs').appendFileSync(process.env.QA_PID_LOG, process.pid + String.fromCharCode(10)); setInterval(()=>{},1000)`], { stdio: 'ignore', detached: true }); appendFileSync(process.env.QA_PID_LOG, process.pid + String.fromCharCode(10)); test('hang', async () => { await new Promise(() => {}); }); setInterval(()=>{},1000);\n");
test('redhang.test.ts', prelude + "test('known red', () => assert.fail('behavior missing')); test('hang', async () => { await new Promise(() => {}); }); setInterval(()=>{},1000);\n");
test('sentinel.test.ts', prelude + "test('inventory sentinel', () => {});\n");
const inventory = readdirSync(workspace).filter(file => file.endsWith('.test.ts'));
const baseConfig = json(join(confRoot, 'conf/test-runs.json'));
baseConfig.projects = { raf: { profiles: { node: { cwd: '.', executable: process.execPath, argv: [join(code, 'scripts/test-run-node.ts')], unitFiles: inventory, exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [] } }, groups: { unit: { profileId: 'node', files: ['green.test.ts'] } } } };
const config = () => structuredClone(baseConfig);
const setConfig = (value = config()) => write(join(confRoot, 'conf/test-runs.json'), value);
setConfig();
const baseFlow = json(join(confRoot, 'conf/flow.json'));
const setBudget = (timeoutMs = 2500) => { const flow = structuredClone(baseFlow); flow.unitTests = { timeoutMs, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 }; write(join(confRoot, 'conf/flow.json'), flow); };
setBudget();
const evidence: any = { environment: { stand, workspace, code, node: process.version, executable: process.execPath, platform: process.platform, release: release(), arch: arch(), sha: execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), confSource: source, fingerprints: Object.fromEntries(['src/test-runs.ts', 'src/test-run-runtime.ts', 'src/test-run-processes.ts', 'src/test-run-reporter.ts', 'scripts/test-run-node.ts', 'scripts/test-run-qa.ts'].map(file => [file, createHash('sha256').update(readFileSync(join(code, file))).digest('hex')])), testPolicy: { timeoutMs: 2500, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 }, operationalState: 'Not opened. QA HOME selected; inherited operational paths tested only as refusal inputs.' }, cases: [], failures: [] };
const owned = new Set<number>();
const live = (pid: number) => { try { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'; } catch { return false; } };
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
let serial = 0;
function start(label: string, files: string[] | null = ['green.test.ts'], options: any = {}) {
  const home = join(stand, options.home ?? `home-${++serial}`);
  mkdirSync(home, { recursive: true });
  const args = options.raw ?? ['--project', 'raf', '--phase', options.phase ?? 'qa', '--group', `add-raf-test-run/${options.group ?? 'unit'}`, ...(files ? ['--files', ...files] : []), ...(options.only ? ['--only', ...options.only] : [])];
  const pidLog = join(home, `pids-${label}.txt`);
  const env = { ...process.env, HOME: home, RAF_QA_HOME: home, RAF_ORCHESTRATOR_ROOT: confRoot, QA_PID_LOG: pidLog, ...options.env };
  const argv = [join(code, 'bin/raf.ts'), 'test', 'run', ...args];
  const child = spawn(process.execPath, argv, { cwd: options.cwd ?? workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(child.pid!);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const track = setInterval(() => {
    const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      try { const raw = readFileSync(`/proc/${name}/stat`, 'utf8'); const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' '); return [{ pid: Number(name), parent: Number(fields[1]) }]; } catch { return []; }
    });
    const descendants = new Set([child.pid!]);
    for (let size = -1; size !== descendants.size;) { size = descendants.size; for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid); }
    for (const pid of descendants) owned.add(pid);
  }, 20);
  const guard = setTimeout(() => child.kill('SIGKILL'), 15000);
  const done = new Promise<any>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (rc, signal) => {
      clearTimeout(guard); clearInterval(track);
      const pids = existsSync(pidLog) ? readFileSync(pidLog, 'utf8').trim().split('\n').map(Number) : [];
      pids.forEach(pid => owned.add(pid));
      let result; try { result = JSON.parse(stdout); } catch { }
      const row = { label, argv: [process.execPath, ...argv], home, cwd: options.cwd ?? workspace, rc, signal, result, stdout, stderr, pids, sqlite: existsSync(join(home, '.raf', json(join(confRoot, 'conf/raf.json')).state.fileName)) ? state(home) : null, livePids: pids.filter(live) };
      evidence.cases.push(row); write(join(output, `${label}.json`), row); resolve(row);
    });
  });
  return { child, done, home, pidLog };
}
async function run(label: string, files: string[] | null = ['green.test.ts'], options: any = {}) { return start(label, files, options).done; }
function expect(row: any, outcome: string) {
  assert.equal(row.result?.outcome, outcome, row.stdout + row.stderr);
  assert.equal(row.rc === 0, outcome === 'passed');
  assert.equal(row.signal, null);
  assert.equal(row.result.cleanup.complete, true);
  assert.deepEqual(row.result.cleanup.remainingPids, []);
  assert.deepEqual(row.livePids, []);
  if (row.sqlite && row.result.profileId && !['refused', 'setup-failed'].includes(outcome)) {
    const group = row.sqlite.groups.find((value: any) => value.key.group === row.result.group);
    assert.ok(group); assert.equal(group.timeoutCount, row.result.timeoutCount); assert.equal(group.inFlight, null); assert.deepEqual(group.knownRed, row.result.knownRed);
  }
}
function state(home: string) {
  const db = new DatabaseSync(join(home, '.raf', json(join(confRoot, 'conf/raf.json')).state.fileName));
  try { return { schema: db.prepare('PRAGMA user_version').get(), groups: db.prepare('SELECT payload FROM test_run_groups').all().map((row: any) => JSON.parse(row.payload)) }; } finally { db.close(); }
}
async function scenario(label: string, body: () => Promise<void>) {
  try { setConfig(); setBudget(); await body(); process.stdout.write(`PASS ${label}\n`); }
  catch (error) { evidence.failures.push({ label, error: String(error), stack: (error as Error).stack }); process.stdout.write(`FAIL ${label}: ${String(error)}\n`); }
  write(join(output, 'summary.json'), evidence);
}
await scenario('exact-and-preset', async () => {
  for (const [label, files] of [['exact', ['green.test.ts']], ['preset', null]] as const) { const row = await run(label, files as any); expect(row, 'passed'); assert.deepEqual(row.result.selection.files, ['green.test.ts']); assert.equal(row.result.exitCode, 0); }
});
await scenario('refusals', async () => {
  const base = ['--project', 'raf', '--group', 'add-raf-test-run/unit'];
  for (const [label, raw] of [
    ['missing-phase', [...base, '--files', 'green.test.ts']],
    ['unknown-phase', [...base, '--phase', 'imaginary', '--files', 'green.test.ts']],
    ['forbidden-phase', [...base, '--phase', 'test-scaffold', '--files', 'green.test.ts']],
    ['command', [...base, '--phase', 'qa', '--command', 'echo injected']],
    ['tail', [...base, '--phase', 'qa', '--', 'echo injected']],
    ['unknown-preset', ['--project', 'raf', '--phase', 'qa', '--group', 'add-raf-test-run/missing']],
  ] as [string, string[]][]) { const row = await run(label, null, { raw }); expect(row, 'refused'); assert.equal(row.result.command, null); assert.equal(existsSync(join(row.home, '.raf/state.sqlite')), false); }
  for (const [label, files] of [ ['directory', ['.']], ['glob', ['*.test.ts']], ['escape', ['../green.test.ts']], ['absolute', [join(workspace, 'green.test.ts')]], ['option', ['--test']], ['not-unit', ['README.md']], ['empty', []], ['full-suite', inventory] ] as [string, string[]][]) { const row = await run(label, files); expect(row, 'refused'); assert.equal(row.result.command, null); }
  symlinkSync(join(workspace, 'green.test.ts'), join(workspace, 'alias.test.ts'));
  const c = config(); c.projects.raf.profiles.node.unitFiles.push('alias.test.ts'); setConfig(c);
  const row = await run('symlink', ['alias.test.ts']); expect(row, 'refused'); assert.equal(row.result.command, null);
});
await scenario('failure-kinds-and-hints', async () => {
  for (const [label, files, outcome] of [ ['assertion', ['red.test.ts'], 'assertions-failed'], ['setup', ['setup.test.ts'], 'setup-failed'], ['import', ['import.test.ts'], 'setup-failed'], ['mixed', ['red.test.ts', 'setup.test.ts'], 'setup-failed'], ['skip', ['skip.test.ts'], 'setup-failed'] ] as [string, string[], string][]) {
    const row = await run(label, files); expect(row, outcome); assert.ok(row.result.hints.length);
    assert.equal(row.result.timeoutCount, 0);
    if (label === 'mixed') { assert.ok(row.result.failureKinds.includes('assertions')); assert.ok(row.result.failureKinds.includes('setup')); }
  }
  const c = config(); c.hints['qa-assertions'] = 'QA changed hint from isolated conf'; setConfig(c);
  const row = await run('changed-hint', ['red.test.ts']); expect(row, 'assertions-failed'); assert.ok(row.result.hints.includes(c.hints['qa-assertions']));
});
await scenario('preflight', async () => {
  for (const [label, edit] of [ ['missing-runtime', (c: any) => { c.projects.raf.profiles.node.executable = '/nonexistent/node'; }], ['dependency', (c: any) => { c.projects.raf.profiles.node.checks = ['missing-dependency']; }], ['inventory', (c: any) => { c.projects.raf.profiles.node.unitFiles.push('absent.test.ts'); }], ['invalid-config', (c: any) => { delete c.phases.qa.hints; }] ] as [string, (c: any) => void][]) { const c = config(); edit(c); setConfig(c); const row = await run(label); assert.notEqual(row.rc, 0); assert.equal(row.result.exitCode, null); assert.equal(row.result.command, null); }
  setConfig();
  const row = await run('inherited-channel', ['green.test.ts'], { env: { RAF_STATE_DIRECTORY: '/home/dev/.raf' } }); expect(row, 'setup-failed'); assert.equal(row.result.command, null);
  const aliasHome = join(stand, 'alias-home'); mkdirSync(aliasHome); symlinkSync('/home/dev/.raf', join(aliasHome, '.raf'));
  const alias = await run('aliased-state', ['green.test.ts'], { home: 'alias-home' }); expect(alias, 'setup-failed'); assert.equal(alias.result.command, null);
  const unisolated = await run('no-qa-home', ['green.test.ts'], { env: { RAF_QA_HOME: '' } }); expect(unisolated, 'setup-failed'); assert.equal(unisolated.result.command, null);
});
await scenario('exact-only', async () => {
  const initial = await run('only-red', ['red.test.ts'], { home: 'only' }); expect(initial, 'assertions-failed');
  const id = initial.result.knownRed[0];
  const confirm = await run('only-confirm', null, { home: 'only', only: [JSON.stringify(id)] }); expect(confirm, 'assertions-failed'); assert.deepEqual(confirm.result.selection.testIds, [id]); assert.equal(confirm.result.passed.length, 0);
  const unknown = await run('only-unknown', null, { home: 'only', only: ['red.test.ts::other'] }); expect(unknown, 'refused'); assert.equal(unknown.result.errorCode, 'UNKNOWN_RED_TEST');
  const nested = await run('nested-red', ['nested.test.ts'], { home: 'nested' }); expect(nested, 'assertions-failed');
  const confirmed = await run('nested-confirm', null, { home: 'nested', only: [JSON.stringify(nested.result.knownRed[0])] }); expect(confirmed, 'assertions-failed');
});
await scenario('timeout-budget-and-optimization', async () => {
  const initial = await run('timeout-first', ['hang.test.ts', 'green.test.ts'], { home: 'timeouts', phase: 'red' }); expect(initial, 'timed-out'); assert.equal(initial.result.timeoutCount, 1); assert.equal(initial.result.nextAction, 'optimize'); assert.ok(initial.result.durationMs < 5000); assert.equal(initial.result.signal, 'SIGKILL');
  execFileSync('git', ['-C', workspace, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'QA new SHA', '--allow-empty']);
  assert.ok(initial.result.unexecuted.some((id: any) => id.name === 'hang')); assert.ok(initial.pids.length >= 2);
  const next = await run('timeout-optimized', ['hang.test.ts'], { home: 'timeouts', phase: 'implement' }); expect(next, 'timed-out'); assert.equal(next.result.timeoutCount, 2);
  const remaining = await run('timeout-remainder', ['hang.test.ts'], { home: 'timeouts', phase: 'qa' }); expect(remaining, 'unverified-remainder'); assert.equal(remaining.result.exitCode, null); assert.equal(remaining.result.timeoutCount, 2);
  const snapshot = state(initial.home); evidence.timeoutState = snapshot; assert.equal(snapshot.groups[0].timeoutCount, 2); assert.equal(snapshot.groups[0].inFlight, null);
});
await scenario('known-red-confirmation-timeout', async () => {
  const first = await run('red-timeout-1', ['redhang.test.ts'], { home: 'redtimeouts', phase: 'red' }); expect(first, 'timed-out'); assert.equal(first.result.knownRed.length, 1);
  const second = await run('red-timeout-2', ['redhang.test.ts'], { home: 'redtimeouts', phase: 'implement' }); expect(second, 'timed-out'); assert.equal(second.result.groupState, 'confirm-known-red');
  const refused = await run('red-exhausted', ['redhang.test.ts'], { home: 'redtimeouts' }); expect(refused, 'refused'); assert.equal(refused.result.errorCode, 'GROUP_BUDGET_EXHAUSTED');
  const known = first.result.knownRed[0];
  test('redhang.test.ts', prelude + "test('known red', async () => { await new Promise(() => {}); }); setInterval(()=>{},1000);\n");
  const confirmation = await run('red-confirm-timeout', null, { home: 'redtimeouts', only: [JSON.stringify(known)] }); expect(confirmation, 'timed-out'); assert.deepEqual(confirmation.result.knownRed, [known]); assert.equal(confirmation.result.timeoutCount, 3);
  evidence.knownRedState = state(first.home);
});
await scenario('interruption-concurrent-recovery', async () => {
  setBudget(5000);
  const first = start('interrupted', ['hang.test.ts'], { home: 'concurrent' });
  for (let i = 0; i < 150 && !existsSync(first.pidLog); i++) await delay(20);
  assert.ok(existsSync(first.pidLog));
  const blocked = await run('concurrent-refusal', ['hang.test.ts'], { home: 'concurrent' }); expect(blocked, 'refused'); assert.equal(blocked.result.errorCode, 'GROUP_IN_FLIGHT');
  first.child.kill('SIGTERM');
  const interrupted = await first.done; expect(interrupted, 'interrupted'); assert.equal(interrupted.result.timeoutCount, 0); assert.equal(interrupted.result.signal, 'SIGTERM');
  const dead = start('recovery-killed-wrapper', ['hang.test.ts'], { home: 'recovery' });
  for (let i = 0; i < 150 && !existsSync(dead.pidLog); i++) await delay(20);
  assert.ok(existsSync(dead.pidLog));
  dead.child.kill('SIGKILL'); await dead.done;
  const blockedRecovery = await run('recovery-before-deadline', ['hang.test.ts'], { home: 'recovery' }); expect(blockedRecovery, 'refused'); assert.equal(blockedRecovery.result.errorCode, 'GROUP_IN_FLIGHT');
  await delay(5100);
  for (let i = 0; i < 10 && state(dead.home).groups[0].inFlight; i++) {
    const reconciled = await run(`recovery-reconcile-${i}`, ['hang.test.ts'], { home: 'recovery' }); expect(reconciled, 'refused'); await delay(20);
  }
  const snapshot = state(dead.home); evidence.recoveryState = snapshot; assert.equal(snapshot.groups[0].inFlight, null); assert.equal(snapshot.groups[0].timeoutCount, 1);
  for (const pid of evidence.cases.find((row: any) => row.label === 'recovery-killed-wrapper').pids) assert.equal(live(pid), false);
  const after = await run('recovery-after', ['green.test.ts'], { home: 'recovery' }); expect(after, 'passed'); assert.equal(after.result.timeoutCount, 1);
});
await scenario('protocol-output', async () => {
  for (const [label, body] of [['missing-output', ''], ['truncated-output', "process.stdout.write('{bad');"], ['invalid-output', "console.log('not json');"]]) {
    test('protocol.mjs', body); const c = config(); c.projects.raf.profiles.node.argv = [join(workspace, 'protocol.mjs')]; setConfig(c);
    const row = await run(label); expect(row, 'setup-failed'); assert.equal(row.result.exitCode, 0);
  }
});
await delay(100);
evidence.liveOwnedPids = [...owned].filter(live);
if (evidence.liveOwnedPids.length) evidence.failures.push({ label: 'final-process-cleanup', pids: evidence.liveOwnedPids });
for (const pid of evidence.liveOwnedPids) { try { process.kill(pid, 'SIGKILL'); } catch { } }
evidence.endedAt = new Date().toISOString();
evidence.status = evidence.failures.length ? 'failed' : 'passed';
write(join(output, 'summary.json'), evidence);
process.stdout.write(JSON.stringify({ status: evidence.status, cases: evidence.cases.length, failures: evidence.failures.map((row: any) => row.label), output, stand }) + '\n');
process.exitCode = evidence.failures.length ? 1 : 0;
