import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStateStore } from '../src/state-store.ts';

const code = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const root = resolve(code, '..');
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const stand = process.argv[3] ?? mkdtempSync('/tmp/raf-refusal-qa-');
const confRoot = join(stand, 'orchestrator');
const workspace = join(stand, 'workspace');
const home = join(stand, 'control-home');
for (const path of [join(confRoot, 'conf'), join(confRoot, 'openspec/changes/add-raf-test-run'), workspace, home]) mkdirSync(path, { recursive: true });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
for (const name of ['projects.json', 'raf.json', 'raf-constants.json', 'flow.json', 'test-runs.json']) cpSync(join(root, 'conf', name), join(confRoot, 'conf', name));
const projects = read(join(confRoot, 'conf/projects.json'));
projects.projects.raf.path = resolve(root, projects.projects.raf.path);
for (const branch of Object.keys(projects.projects.raf.branchPaths)) projects.projects.raf.branchPaths[branch] = resolve(root, projects.projects.raf.branchPaths[branch]);
projects.projects.raf.branchPaths['qa-refusal'] = workspace;
write(join(confRoot, 'conf/projects.json'), projects);
if (!existsSync(join(workspace, '.git'))) {
  execFileSync('git', ['init', '-q', '-b', 'qa-refusal', workspace]);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--allow-empty', '-qm', 'Refusal QA stand']);
}
const group = 'add-raf-test-run/refusal-diagnostics';
const conflicting = 'add-raf-test-run/arguments';
const first = 'first.test.ts', second = 'second.test.ts';
const config = read(join(confRoot, 'conf/test-runs.json'));
config.projects = { raf: { profiles: { node: { cwd: '.', executable: process.execPath, argv: [join(code, 'scripts/test-run-node.ts')], unitFiles: [first, second, 'sentinel.test.ts'], exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [] } }, groups: { [group]: { profileId: 'node', files: [first, second] }, [conflicting]: { profileId: 'node', files: [first] } } } };
config.temporaryArtifacts.root = mkdtempSync('/tmp/q-');
const saveConfig = () => write(join(confRoot, 'conf/test-runs.json'), config);
saveConfig();
const flow = read(join(confRoot, 'conf/flow.json'));
flow.unitTests = { timeoutMs: 1800, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 };
write(join(confRoot, 'conf/flow.json'), flow);
const prelude = "import {test} from 'node:test'; import assert from 'node:assert/strict';\n";
const testFile = (name: string, body: string) => writeFileSync(join(workspace, name), prelude + body);
testFile(first, "test('keep', () => {});");
testFile(second, "test('second', () => {});");
testFile('sentinel.test.ts', "test('unselected', () => {});");
const processRow = execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
const store = openStateStore(join(home, '.raf', read(join(confRoot, 'conf/raf.json')).state.fileName));
const runId = randomUUID();
store.sessionRepository.transaction(tx => tx.putSession({ runId, addressId: `refusal-qa-fixture-${runId}`, revision: 0, state: 'running', process: { pid: process.pid, startedAt: new Date(processRow[1]).toISOString(), runner: 'qa', runnerSessionId: runId, tmuxSession: '', evidence: { command: processRow[2] } }, launchContext: { testAssignment: { runId, agentId: 'refusal-qa-fixture', type: 'qa', phase: 'qa', project: 'raf', workspace, branch: 'qa-refusal', changes: ['add-raf-test-run'] } } as any }));
store.close();
const git = (...args: string[]) => execFileSync('git', args, { cwd: code, encoding: 'utf8' }).trim();
const fingerprints = () => Object.fromEntries(['bin/raf.ts', 'src/cli.ts', 'src/cli-arguments.ts', 'src/test-runs.ts', 'src/test-run-cli.ts', 'src/test-run-runtime.ts', 'src/test-run-reporter.ts', 'scripts/test-run-node.ts'].map(name => [name, createHash('sha256').update(readFileSync(join(code, name))).digest('hex')]));
const evidence: any = { stand, environment: { node: process.version, executable: process.execPath, os: release(), platform: process.platform, sha: git('rev-parse', 'HEAD'), dirty: git('status', '--short'), fingerprints: fingerprints(), fixtureSha: execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), confFingerprints: Object.fromEntries(['projects.json', 'flow.json', 'test-runs.json'].map(name => [name, createHash('sha256').update(readFileSync(join(confRoot, 'conf', name))).digest('hex')])) }, policy: flow.unitTests, cases: [], failures: [] };
let unitStatePath: string | undefined;
function groups() {
  if (!unitStatePath || !existsSync(unitStatePath)) return [];
  const db = new DatabaseSync(unitStatePath, { readOnly: true });
  try { return db.prepare('SELECT payload FROM test_run_groups').all().map((row: any) => JSON.parse(row.payload)); } finally { db.close(); }
}
async function cli(label: string, selection: string[] = [], requestedGroup = group) {
  const argv = [join(code, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', 'qa', '--group', requestedGroup, ...selection];
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', HOME: home, RAF_QA_HOME: home, RAF_ORCHESTRATOR_ROOT: confRoot, TMUX: '', TMUX_PANE: '' };
  const before = groups();
  const child = spawn(process.execPath, argv, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', guardFired = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const guard = setTimeout(() => { guardFired = true; child.kill('SIGKILL'); }, 15000);
  const [rc, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done, fail) => { child.once('error', fail); child.once('close', (rc, signal) => done([rc, signal])); });
  clearTimeout(guard);
  let result; try { result = JSON.parse(stdout); } catch {}
  unitStatePath ??= result?.command?.environment?.statePath;
  const row = { label, command: { executable: process.execPath, argv, cwd: workspace, environment: env }, cliExitCode: rc, signal, guardFired, childExitCode: result?.exitCode ?? null, result, before, after: groups() };
  writeFileSync(join(output, `${label}.stdout`), stdout);
  writeFileSync(join(output, `${label}.stderr`), stderr);
  write(join(output, `${label}.json`), row);
  evidence.cases.push(row);
  return row;
}
function expect(row: any, outcome: string) {
  assert.equal(row.guardFired, false);
  assert.equal(row.signal, null);
  assert.equal(row.result?.outcome, outcome);
  assert.equal(row.cliExitCode, outcome === 'passed' ? 0 : 1);
  assert.deepEqual(row.result.cleanup, { complete: true, remainingPids: [] });
  assert.ok(Array.isArray(row.result.removed));
}
async function scenario(label: string, body: () => Promise<void>) {
  try { await body(); process.stdout.write(`PASS ${label}\n`); }
  catch (error) { evidence.failures.push({ label, message: String(error), stack: (error as Error).stack }); process.stdout.write(`FAIL ${label}: ${error}\n`); }
  write(join(output, 'stand.json'), evidence);
}
await scenario('5.6.2-equivalent-file-syntax', async () => {
  const space = await cli('files-space', ['--files', first, second]);
  const repeated = await cli('files-repeated', ['--files', first, '--files', second]);
  expect(space, 'passed'); expect(repeated, 'passed');
  assert.deepEqual(space.result.selection, repeated.result.selection);
  assert.deepEqual(space.result.passed, repeated.result.passed);
  assert.deepEqual(space.result.command.argv, repeated.result.command.argv);
  assert.equal(space.result.command.environment.HOME, repeated.result.command.environment.HOME);
});
await scenario('5.6.2-singleton-duplicate', async () => {
  const row = await cli('duplicate-project', ['--project', 'raf', '--files', first, second]);
  assert.equal(row.cliExitCode, 1);
  const data = readFileSync(join(output, 'duplicate-project.stdout'), 'utf8') + readFileSync(join(output, 'duplicate-project.stderr'), 'utf8');
  assert.match(data, /DUPLICATE_ARGUMENT/);
  for (const name of ['project', 'phase', 'group', 'files', 'only']) assert.ok(data.includes(`--${name}`));
  assert.match(data, /синтаксис|syntax/iu);
  assert.deepEqual(row.before, row.after);
});
await scenario('5.3-inventory-missing', async () => {
  config.projects.raf.profiles.node.unitFiles.push('deleted-one.test.ts', 'deleted-two.test.ts'); saveConfig();
  try {
    const row = await cli('inventory-missing'); expect(row, 'refused');
    assert.equal(row.result.errorCode, 'INVENTORY_INCOMPLETE');
    assert.equal(row.result.command, null);
    const diagnostic = row.result.diagnostics.find((d: any) => d.kind === 'preflight');
    for (const token of ['deleted-one.test.ts', 'deleted-two.test.ts', 'conf/test-runs.json', 'unitFiles', 'restore']) assert.ok(diagnostic.message.includes(token));
    assert.deepEqual(row.before, row.after);
    assert.deepEqual(read(join(confRoot, 'conf/test-runs.json')), config);
  } finally { config.projects.raf.profiles.node.unitFiles.splice(-2); saveConfig(); }
});
await scenario('5.5.7-conflicting-group', async () => {
  const row = await cli('group-conflict', [], conflicting); expect(row, 'refused');
  assert.equal(row.result.errorCode, 'GROUP_RENAME_REFUSED');
  const diagnostic = row.result.diagnostics.find((d: any) => d.kind === 'preflight');
  for (const token of [group, 'release', 'main', 'preserving timeoutCount and knownRed']) assert.ok(diagnostic.message.includes(token));
  assert.deepEqual(row.before, row.after);
});
await scenario('5.5.11-authoritative-collection-only', async () => {
  const stale = { file: first, name: 'deleted' }, keep = { file: first, name: 'keep' };
  testFile(first, "test('deleted', () => assert.fail('old behavior')); test('keep', () => assert.fail('current behavior'));");
  const seed = await cli('assertion-seed'); expect(seed, 'assertions-failed');
  assert.deepEqual(seed.result.knownRed, [stale, keep]);
  writeFileSync(join(workspace, first), "import './missing-fixture.ts';\n");
  const setup = await cli('collection-setup'); expect(setup, 'setup-failed');
  assert.deepEqual(setup.result.knownRed, [stale, keep]); assert.deepEqual(setup.result.removed, []);
  testFile(first, "test('keep', async () => new Promise(() => {})); setInterval(() => {}, 1000);");
  const timeout = await cli('collection-timeout'); expect(timeout, 'timed-out');
  assert.deepEqual(timeout.result.knownRed, [stale, keep]); assert.deepEqual(timeout.result.removed, []);
  assert.equal(timeout.result.timeoutCount, 1);
  testFile(first, "test('keep', () => {});");
  const only = await cli('collection-only', ['--only', `${first}::keep`]); expect(only, 'assertions-failed');
  assert.deepEqual(only.result.knownRed, [stale]); assert.deepEqual(only.result.removed, []);
  const full = await cli('collection-full'); expect(full, 'passed');
  assert.deepEqual(full.result.removed, [stale]);
  assert.deepEqual(full.result.knownRed, []); assert.deepEqual(full.result.unexecuted, []); assert.deepEqual(full.result.unknown, []);
  assert.equal(full.result.timeoutCount, 1);
  assert.deepEqual(full.after[0].lastResult, full.result);
  const next = await cli('collection-next'); expect(next, 'passed'); assert.deepEqual(next.result.removed, []);
  assert.equal(next.result.timeoutCount, 1);
  for (const row of [setup, timeout, only, full, next]) assert.deepEqual(row.after[0].lastResult.removed, row.result.removed);
});
evidence.environment.fingerprintsAfter = fingerprints();
assert.deepEqual(evidence.environment.fingerprintsAfter, evidence.environment.fingerprints);
evidence.status = evidence.failures.length ? 'failed' : 'passed';
write(join(output, 'stand.json'), evidence);
process.exitCode = evidence.failures.length ? 1 : 0;
