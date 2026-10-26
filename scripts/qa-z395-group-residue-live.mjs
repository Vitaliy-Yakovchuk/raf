import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = path.resolve(import.meta.dirname, '..');
const reviewed = process.argv[2];
const output = path.resolve(process.argv[3] ?? '');
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.ok(process.argv[3] && path.isAbsolute(process.argv[3]), 'Supply an absolute new evidence directory');
assert.ok(!fs.existsSync(output), 'Never overwrite a previous stand result');
process.umask(0o077);
fs.mkdirSync(output, { recursive: true });
const stand = fs.mkdtempSync('/srv/dev/z395-');
const root = path.join(stand, 'root');
const workspace = path.join(root, 'raf-develop');
const home = path.join(stand, 'control');
const unitHome = path.join('/tmp', `raf-unit-${process.getuid()}`, createHash('sha256').update(JSON.stringify([root, 'raf', workspace])).digest('hex'));
const a = { file: 'test/z395-a.test.mjs', name: 'Z395 same exact test name' };
const b = { file: 'test/z395-b.test.mjs', name: a.name };
const group = 'z395-live-fixture/residue';
const foreignGroup = 'z395-foreign-fixture/residue';
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const summary = { assignment: 'complete-raf-flow-contracts:Z.395.4', status: 'failed', reviewed, source, stand, root, workspace, home, unitHome,
  startedAt: new Date().toISOString(), commands: [], checks: [], cleanup: { complete: false },
  boundaries: ['Host manual stand; never executed as an integration/unit test file or registered product preset.',
    'Unmodified built public CLI, real SQLite and real Node test runner. No native model agent is launched.',
    'One fixture caller is registered with its actual host PID/start/command/machine/boot. This does not prove native runner launch or tool sandbox transport.',
    'Fresh fixture target starts with timeoutCount=1 before any accepted run; no later aggregate writes/reset. No actual timeout is induced.',
    'Working HOME/state is never explicitly opened or queried; normal production guard may inspect file identities. No credentials copied.'] };
let deadline = Infinity;
let control;
let unit;
let unitOwned = false;
const allowed = ['PATH', 'LANG', 'TZ', 'SYSTEMROOT'];
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.includes(name) || name.startsWith('LC_')));
Object.assign(env, { HOME: home, RAF_QA_HOME: home, TMPDIR: path.join(stand, 'tmp'), XDG_CONFIG_HOME: path.join(home, '.config'), LC_ALL: 'C' });
const globalGit = process.env.GIT_CONFIG_GLOBAL || (fs.existsSync(path.join(userInfo().homedir, '.gitconfig'))
  ? path.join(userInfo().homedir, '.gitconfig') : path.join(process.env.XDG_CONFIG_HOME || path.join(userInfo().homedir, '.config'), 'git/config'));
env.GIT_CONFIG_GLOBAL = globalGit;
let sequence = 0;
const run = (label, executable, argv, cwd = source) => {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, 'Stand integration deadline reached; do not repeat unknown commands');
  const result = spawnSync(executable, argv, { cwd, env, encoding: 'utf8', timeout: Number.isFinite(remaining) ? remaining : undefined, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(output, label + '.stdout'), result.stdout ?? '');
  fs.writeFileSync(path.join(output, label + '.stderr'), result.stderr ?? '');
  const metadata = { label, command: [executable, ...argv], cwd, cliCode: result.status, signal: result.signal,
    error: result.error?.message ?? null, stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    stdoutSha256: hash(path.join(output, label + '.stdout')), stderrSha256: hash(path.join(output, label + '.stderr')) };
  write(path.join(output, label + '.command.json'), metadata); summary.commands.push(metadata);
  assert.equal(metadata.error, null, JSON.stringify(metadata)); assert.equal(metadata.signal, null, label);
  return { ...metadata, stdout: result.stdout, stderr: result.stderr };
};
const must = result => { assert.equal(result.cliCode, 0, result.stderr); return result.stdout.trim(); };
const git = (cwd, ...argv) => must(run('git-' + (++sequence), 'git', ['--no-optional-locks', '-C', cwd, ...argv], cwd));
const statePath = selectedHome => path.join(selectedHome, '.raf', read(path.join(root, 'conf/raf.json')).state.fileName);
const snapshot = label => {
  const file = statePath(unitHome);
  let value = { statePath: file, exists: fs.existsSync(file), rows: [], userVersion: null };
  if (value.exists) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { value.userVersion = db.prepare('PRAGMA user_version').get(); value.rows = db.prepare('SELECT project, workspace, group_id, payload FROM test_run_groups ORDER BY project, workspace, group_id').all(); }
    finally { db.close(); }
  }
  write(path.join(output, label + '.snapshot.json'), value); return value;
};
const aggregate = (snap, selected = group) => JSON.parse(snap.rows.find(row => row.group_id === selected)?.payload ?? 'null');
const runnerExecutions = () => fs.existsSync(path.join(stand, 'executions.jsonl')) ? fs.readFileSync(path.join(stand, 'executions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const cli = (label, phase, selectedGroup, selection) => {
  const result = run(label, path.join(workspace, 'scripts/raf-stand.sh'), ['test', 'run', '--project', 'raf', '--phase', phase, '--group', selectedGroup, ...selection], workspace);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.runId && parsed.selection && parsed.cleanup, label + ': full TestRunResult required');
  write(path.join(output, label + '.codes.json'), { cliCode: result.cliCode, childExitCode: parsed.exitCode, runId: parsed.runId });
  return { ...result, result: parsed };
};
const complete = execution => {
  assert.equal(execution.result.cleanup.complete, true);
  assert.deepEqual(execution.result.cleanup.remainingPids, []);
  assert.equal(execution.result.timedOut, false);
  assert.deepEqual(execution.result.unexecuted, []);
  assert.deepEqual(execution.result.unknown, []);
  assert.equal(execution.result.timeoutCount, 1);
  assert.equal(execution.result.command.environment.HOME, unitHome);
};
const processes = () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
  try {
    const cwd = fs.realpathSync('/proc/' + name + '/cwd');
    if (!(cwd === stand || cwd.startsWith(stand + '/') || cwd === unitHome || cwd.startsWith(unitHome + '/'))) return [];
    const raw = fs.readFileSync('/proc/' + name + '/stat', 'utf8'); const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? [] : [{ pid: Number(name), start: fields[19], cwd }];
  } catch { return []; }
});
try {
  assert.ok(path.isAbsolute(globalGit) && fs.existsSync(globalGit) && fs.statSync(globalGit).isFile(), 'Existing global Git identity selector required');
  summary.sourceHead = git(source, 'rev-parse', 'HEAD');
  summary.sourceStatus = git(source, 'status', '--porcelain');
  assert.equal(summary.sourceHead, reviewed); assert.equal(summary.sourceStatus, '', 'Use a clean checkout');
  summary.versions = { node: process.version, git: must(run('git-version', 'git', ['--version'])), tmux: must(run('tmux-version', 'tmux', ['-V'])) };
  for (const directory of [root, home, env.TMPDIR, path.join(root, 'raf-main')]) fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(path.join(source, '../conf'), path.join(root, 'conf'), { recursive: true, filter: file => !/(?:secret|credential)/i.test(path.basename(file)) });
  const flow = read(path.join(root, 'conf/flow.json'));
  assert.ok(Number.isSafeInteger(flow.integrationTests?.timeoutMs) && flow.integrationTests.timeoutMs > 0);
  assert.ok(flow.unitTests.maxGroupTimeouts > 1, 'Nonzero fixture budget must allow initial selection');
  deadline = Date.now() + flow.integrationTests.timeoutMs;
  summary.timeoutPolicy = { source: 'conf/flow.json#/integrationTests/timeoutMs', timeoutMs: flow.integrationTests.timeoutMs, deadline };
  summary.unitPolicyUnchanged = flow.unitTests;
  summary.originalConfiguration = Object.fromEntries(['flow.json', 'projects.json', 'test-runs.json', 'raf.json', 'raf-constants.json'].map(name => [name, hash(path.join(root, 'conf', name))]));
  must(run('clone', 'git', ['clone', '--no-hardlinks', '--single-branch', source, workspace], root));
  git(workspace, 'checkout', '-B', 'develop', reviewed);
  fs.cpSync(path.join(source, 'node_modules'), path.join(workspace, 'node_modules'), { recursive: true, dereference: true });
  const projectsFile = path.join(root, 'conf/projects.json'); const projects = read(projectsFile);
  const registeredProjectIds = Object.keys(projects.projects);
  projects.projects.raf = { ...projects.projects.raf, path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop' } };
  assert.deepEqual(Object.keys(projects.projects), registeredProjectIds, 'Keep public catalog example/value-source project domains intact');
  write(projectsFile, projects);
  const configFile = path.join(root, 'conf/test-runs.json'); const config = read(configFile);
  const profile = structuredClone(config.projects.raf.profiles.node);
  profile.unitFiles = [a.file, b.file, 'test/z395-unselected.test.mjs'];
  config.projects = { raf: { profiles: { node: profile }, groups: {
    [group]: { profileId: 'node', files: [a.file, b.file] }, [foreignGroup]: { profileId: 'node', files: [a.file] },
  } } };
  write(configFile, config);
  for (const id of ['z395-live-fixture', 'z395-foreign-fixture']) {
    const directory = path.join(root, 'openspec/changes', id); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'tasks.md'), '- [ ] 1.1 Isolated Z395 fixture, no real task mutation.\n');
  }
  const log = JSON.stringify(path.join(stand, 'executions.jsonl'));
  const marker = JSON.stringify(path.join(stand, 'a-green'));
  const testSource = id => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {appendFileSync,existsSync} from 'node:fs';\nappendFileSync(${log},JSON.stringify({file:${JSON.stringify(id.file)},pid:process.pid,home:process.env.HOME})+'\\n');\ntest(${JSON.stringify(id.name)},()=>assert.ok(${id.file === a.file ? `existsSync(${marker})` : 'true'},'controlled Z395 assertion'));\n`;
  for (const id of [a, b, { file: 'test/z395-unselected.test.mjs', name: 'must remain unselected' }]) fs.writeFileSync(path.join(workspace, id.file), testSource(id));
  git(workspace, 'add', '--', a.file, b.file, 'test/z395-unselected.test.mjs');
  git(workspace, 'commit', '-m', 'qa: isolated Z395 A B fixtures');
  summary.fixtureHead = git(workspace, 'rev-parse', 'HEAD');
  summary.fixtureStatus = git(workspace, 'status', '--porcelain');
  must(run('build', process.execPath, ['scripts/build.ts'], workspace));
  summary.fixtureConfiguration = Object.fromEntries(['flow.json', 'projects.json', 'test-runs.json', 'raf.json', 'raf-constants.json'].map(name => [name, hash(path.join(root, 'conf', name))]));
  assert.equal(summary.fixtureConfiguration['flow.json'], summary.originalConfiguration['flow.json']);
  summary.fingerprints = Object.fromEntries(['src/test-runs.ts', 'src/test-run-runtime.ts', 'src/test-run-protocol.ts', 'scripts/test-run-node.ts', 'dist/catalog.json', a.file, b.file].map(name => [name, hash(path.join(workspace, name))]));
  assert.ok(!fs.existsSync(unitHome), 'A fresh stand must never reuse existing unit HOME');
  const beforeAuth = snapshot('01-before-authorisation');
  const denied = cli('02-before-authorisation', 'qa', group, ['--files', b.file]);
  assert.notEqual(denied.cliCode, 0); assert.equal(denied.result.errorCode, 'CALLER_UNAUTHORIZED');
  assert.equal(denied.result.exitCode, null); assert.deepEqual(runnerExecutions(), []);
  assert.deepEqual(snapshot('03-after-authorisation-refusal'), beforeAuth);
  summary.checks.push('Unregistered host caller refused before unit SQLite creation and before runner spawn.');
  const { resolveStateContext } = await import(pathToFileURL(path.join(workspace, 'src/state-migration-guard.ts')));
  const { openStateStore } = await import(pathToFileURL(path.join(workspace, 'src/state-store.ts')));
  const { sqliteTestRunState } = await import(pathToFileURL(path.join(workspace, 'src/test-run-runtime.ts')));
  const contextFor = selectedHome => resolveStateContext({ orchestratorRoot: root, modulePath: path.join(workspace, 'src/test-run-runtime.ts'), homeDirectory: selectedHome,
    operatingSystemHome: userInfo().homedir, environment: { ...env, HOME: selectedHome, RAF_QA_HOME: selectedHome }, entryPoint: 'cli' });
  control = openStateStore(statePath(home), { context: contextFor(home) });
  const line = must(run('caller-identity', 'ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command=']));
  const match = line.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/); assert.ok(match);
  const runId = randomUUID(), agentId = 'z395-host-fixture';
  const assignment = { runId, agentId, type: 'qa', phase: 'qa', project: 'raf', workspace, branch: 'develop', changes: ['z395-live-fixture', 'z395-foreign-fixture'] };
  const processIdentity = { pid: process.pid, startedAt: new Date(match[1]).toISOString(), runner: 'main', runnerSessionId: agentId, tmuxSession: agentId,
    evidence: { command: match[2], machineId: fs.readFileSync('/etc/machine-id', 'utf8').trim(), bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } };
  control.sessionRepository.transaction(tx => tx.putSession({ runId, addressId: agentId, revision: 1, state: 'running', activity: { type: 'qa', phase: 'qa', project: 'raf', cwd: workspace, features: assignment.changes }, process: processIdentity,
    launchContext: { testAssignment: assignment, assignment: { root, changes: [] } } }));
  summary.fixtureCaller = { assignment, process: processIdentity };
  control.close(); control = undefined;
  fs.mkdirSync(unitHome, { recursive: true, mode: 0o700 }); unitOwned = true;
  unit = openStateStore(statePath(unitHome), { context: contextFor(unitHome) });
  await sqliteTestRunState(unit).transaction(tx => {
    for (const selected of [group, foreignGroup]) tx.put({ key: { project: 'raf', workspace, group: selected }, testKind: 'unit', profileId: 'node', timeoutCount: 1, state: 'idle',
      selection: { files: selected === group ? [a.file, b.file] : [a.file], testIds: [] }, knownRed: [], unexecuted: [], unknown: [], inFlight: null, lastResult: null });
  });
  unit.close(); unit = undefined;
  snapshot('04-fixture-initialized');
  const foreignRed = cli('05-foreign-red', 'red', foreignGroup, ['--files', a.file]); complete(foreignRed);
  assert.equal(foreignRed.result.outcome, 'assertions-failed'); assert.notEqual(foreignRed.cliCode, 0); assert.equal(foreignRed.result.exitCode, 1);
  const red = cli('06-target-A-red-B-green', 'red', group, ['--files', a.file, b.file]); complete(red);
  assert.equal(red.result.outcome, 'assertions-failed'); assert.notEqual(red.cliCode, 0); assert.equal(red.result.exitCode, 1);
  assert.deepEqual(red.result.knownRed, [a]); assert.deepEqual(red.result.passed, [b]);
  const redSnapshot = snapshot('07-target-red');
  fs.writeFileSync(path.join(stand, 'a-green'), 'controlled fixture fix\n');
  const foreignGreen = cli('08-foreign-exact-A-green', 'qa', foreignGroup, ['--only', a.file + '::' + a.name]); complete(foreignGreen);
  assert.equal(foreignGreen.cliCode, 0); assert.equal(foreignGreen.result.outcome, 'passed');
  const afterForeign = snapshot('09-after-foreign-green');
  assert.deepEqual(aggregate(afterForeign), aggregate(redSnapshot));
  const foreignPayload = afterForeign.rows.find(row => row.group_id === foreignGroup).payload;
  const beforeSubsetCount = runnerExecutions().length;
  const subset = cli('10-target-subset-B', 'qa', group, ['--files', b.file]); complete(subset);
  assert.equal(subset.result.exitCode, 0); assert.notEqual(subset.cliCode, 0); assert.equal(subset.result.outcome, 'assertions-failed');
  assert.equal(subset.result.nextAction, 'confirm-known-red'); assert.deepEqual(subset.result.selection, { files: [b.file], testIds: [] });
  assert.deepEqual(subset.result.passed, [b]); assert.deepEqual(subset.result.knownRed, [a]); assert.deepEqual(subset.result.removed, []);
  assert.ok(!subset.result.command.argv.includes(a.file));
  assert.deepEqual(runnerExecutions().slice(beforeSubsetCount).map(row => row.file), [b.file]);
  assert.match(JSON.stringify(subset.result.diagnostics), /z395-a\.test\.mjs/);
  const narrowed = snapshot('11-after-subset-B');
  assert.deepEqual(aggregate(narrowed).knownRed, [a]);
  assert.equal(narrowed.rows.find(row => row.group_id === foreignGroup).payload, foreignPayload);
  const green = cli('12-target-exact-A-green', 'qa', group, ['--only', a.file + '::' + a.name]); complete(green);
  assert.equal(green.cliCode, 0); assert.equal(green.result.exitCode, 0); assert.equal(green.result.outcome, 'passed');
  assert.deepEqual(green.result.selection, { files: [a.file], testIds: [a] }); assert.deepEqual(green.result.passed, [a]);
  assert.deepEqual(green.result.knownRed, []); assert.equal(green.result.groupState, 'complete'); assert.equal(green.result.nextAction, 'complete');
  const final = snapshot('13-after-exact-A');
  assert.deepEqual(aggregate(final).knownRed, []); assert.equal(aggregate(final).timeoutCount, 1);
  assert.equal(final.rows.find(row => row.group_id === foreignGroup).payload, foreignPayload);
  assert.ok(runnerExecutions().every(row => row.home === unitHome));
  write(path.join(output, 'runner-executions.json'), runnerExecutions());
  summary.checks.push('Real A assertion-red/B green -> B child 0/CLI nonzero with exact residual guidance -> exact A green, same group/HOME, timeoutCount=1 preserved.',
    'Foreign exact A green did not change target debt. Later target calls did not change foreign aggregate payload.',
    'Public CLI selected only B for subset; no automatic execution of A or the unselected sentinel. Every accepted run reported complete cleanup.');
  summary.status = 'succeeded';
} catch (error) {
  summary.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  try { unit?.close(); control?.close(); } catch (error) { summary.closeError = error.message; }
  const owned = processes();
  for (const row of owned) {
    const current = processes().find(value => value.pid === row.pid && value.start === row.start);
    if (current) { try { process.kill(row.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') summary.cleanup.error = error.message; } }
  }
  for (let attempt = 0; attempt < 50 && processes().length; attempt++) await delay(100);
  for (const row of owned) if (processes().some(value => value.pid === row.pid && value.start === row.start)) {
    try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') summary.cleanup.error = error.message; }
  }
  await delay(100);
  summary.cleanup = { ...summary.cleanup, processesBefore: owned, remainingProcesses: processes(), unitOwned, workingStateExplicitlyOpened: false };
  if (summary.cleanup.remainingProcesses.length || summary.closeError || summary.cleanup.error) summary.status = 'failed';
  if (!summary.cleanup.remainingProcesses.length) {
    if (unitOwned) fs.rmSync(unitHome, { recursive: true });
    fs.rmSync(stand, { recursive: true });
  }
  summary.cleanup.standRemoved = !fs.existsSync(stand);
  summary.cleanup.unitHomeRemoved = !unitOwned || !fs.existsSync(unitHome);
  summary.cleanup.complete = summary.cleanup.standRemoved && summary.cleanup.unitHomeRemoved && !summary.cleanup.error && !summary.closeError;
  if (!summary.cleanup.complete) summary.status = 'failed';
  summary.finishedAt = new Date().toISOString();
  write(path.join(output, 'summary.json'), summary);
  process.stdout.write(JSON.stringify({ status: summary.status, evidence: output, checks: summary.checks, error: summary.error, cleanup: summary.cleanup }) + '\n');
  process.exitCode = summary.status === 'succeeded' ? 0 : 1;
}
