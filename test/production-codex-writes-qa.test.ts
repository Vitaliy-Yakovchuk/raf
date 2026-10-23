import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';
import { buildRunnerInvocation, nativeWriteScopeArgs, type ProtocolSettings } from '../src/runner-protocols.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import { configuration, eventually } from './production-fixture.ts';
import { productionCodexQaFixture as fixture } from './production-codex-qa-fixture.ts';

const rafConfiguration = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const codexProtocol: ProtocolSettings = rafConfiguration.runnerProtocols.find((entry: ProtocolSettings) => entry.runner === 'codex');
assert.ok(codexProtocol?.native, 'the configured codex native dialect is required');

async function linkedWorktree(root: string, cwd: string) {
  const common = join(root, '.git', 'modules', 'raf');
  const linked = join(common, 'worktrees', 'raf-develop');
  await mkdir(dirname(common), { recursive: true });
  await rename(join(cwd, '.git'), common);
  await mkdir(linked, { recursive: true });
  await writeFile(join(linked, 'HEAD'), 'ref: refs/heads/develop\n');
  await writeFile(join(linked, 'commondir'), '../..\n');
  await writeFile(join(linked, 'gitdir'), `${join(cwd, '.git')}\n`);
  await writeFile(join(cwd, '.git'), `gitdir: ${linked}\n`);
  const probe = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const directories = [await realpath(linked), await realpath(common), await realpath(join(root, '.git'))];
  assert.deepEqual(await Promise.all(probe.stdout.trim().split('\n').map(path => realpath(path))), [await realpath(cwd), directories[0], directories[1]]);
  return directories;
}

async function scopedFixture(t: TestContext, metadata: boolean, worktree = false, missingQuestions = false) {
  const f = await fixture(t);
  const gitEnvironment: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete gitEnvironment[name];
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: f.root, env: gitEnvironment, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', '--local', 'user.name', 'Fixture');
  git('config', '--local', 'user.email', 'fixture@example.invalid');
  git('config', '--local', 'commit.gpgsign', 'false');
  git('config', '--local', 'core.hooksPath', '/dev/null');
  git('-C', f.cwd, 'add', '--', 'package.json');
  git('-C', f.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '-m', 'Fixture code baseline');
  assert.ok((await lstat(join(f.cwd, '.git'))).isDirectory(), 'the plain code checkout owns its .git directory');
  assert.equal(git('-C', f.cwd, 'rev-parse', '--show-toplevel'), await realpath(f.cwd),
    'the code checkout must not resolve to the Orchestrator repository');
  assert.deepEqual(git('-C', f.cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir').split('\n'),
    [await realpath(join(f.cwd, '.git')), await realpath(join(f.cwd, '.git'))],
    'both code git roots belong to the code checkout before the optional linked-worktree layout');
  const gitDirectories = worktree ? await linkedWorktree(f.root, f.cwd)
    : await Promise.all([join(f.cwd, '.git'), join(f.root, '.git')].map(path => realpath(path)));
  const initialTasks = `${await readFile(f.tasksPath, 'utf8')}\n- [ ] 2.2 Unassigned fixture task stays open\n`;
  await writeFile(f.tasksPath, initialTasks);
  git('add', '--', relative(f.root, f.changeRoot));
  git('commit', '--quiet', '-m', 'Fixture assignment baseline');
  const baselineHead = git('rev-parse', 'HEAD');
  if (missingQuestions) await rm(dirname(f.questionsPath), { recursive: true });
  const catalog = JSON.parse(await readFile(new URL('../dist/catalog.json', import.meta.url), 'utf8'));
  const configured = { ...configuration, catalog };
  const runId = 'writes-run-1';
  const reportPath = join(f.tmpRoot, runId, `${f.params.id}.json`);
  const metadataDirectory = f.changeRoot;
  const params = metadata ? f.params : { ...f.params, type: 'spec', phase: 'spec' };
  const documentPath = join(metadataDirectory, 'new-document.md');
  const writableGitDirectories = metadata ? gitDirectories : gitDirectories.slice(-1);
  const targets = [f.questionsPath, ...writableGitDirectories.map(directory => join(directory, 'raf-write-probe'))];
  if (metadata) targets.push(documentPath, join(f.cwd, 'local.txt'));
  const boundaries = metadata ? [f.cwd, metadataDirectory, f.questionsPath] : [metadataDirectory, f.questionsPath];
  const siblingPath = join(dirname(f.questionsPath), 'unassigned.md');
  const denied = [siblingPath, join(f.root, 'unassigned.md')];
  if (!metadata) denied.push(join(f.cwd, 'local.txt'), ...gitDirectories.slice(0, -1).map(directory => join(directory, 'raf-forbidden-probe')));
  await mkdir(dirname(f.legacyTaskContextPath), { recursive: true, mode: 0o700 });
  await writeFile(f.legacyTaskContextPath, JSON.stringify({ version: 1, parameters: params, assignment: f.assignment, context: { branch: 'develop', outcome: 'FOREIGN', writeBoundaries: [join(f.root, 'foreign-directory'), f.root], sources: [], requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [], reportSchema: { type: 'object' } } }), { mode: 0o600 });
  const pidPath = join(f.root, 'runner.pid');
  const argvPath = join(f.root, 'runner-argv.json');
  const releasePath = join(f.root, 'write-and-report');
  const exitGate = join(f.root, 'runner-exit');
  const writeEvidence = join(f.root, 'write-evidence.json');
  const nativeId = '11111111-1111-4111-8111-111111111111';
  f.trackPidFile(pidPath);
  const executable = join(f.binRoot, 'codex');
  const writeProbe = String.raw`
import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const { targets, denied, reportPath, report, commitTargets } = JSON.parse(process.argv[1]);
for (const path of denied) assert.throws(() => writeFileSync(path, 'forbidden synthetic write'), path);
const writes = targets.map(path => {
  try { writeFileSync(path, 'approved synthetic write'); return { path, allowed: true }; }
  catch (error) { return { path, allowed: false, reason: String(error) }; }
});
process.stdout.write(JSON.stringify(writes));
assert.ok(writes.every(row => row.allowed), 'every assigned write must succeed inside the tool sandbox');
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const name of Object.keys(gitEnvironment)) if (name.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(name)) delete gitEnvironment[name];
for (const { repository, paths } of commitTargets) {
  const git = args => {
    const result = spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env: gitEnvironment });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['add', '--', ...paths]);
  git(['commit', '--quiet', '-m', 'Synthetic assigned writes']);
  report.commits.push({ repository, sha: git(['rev-parse', '--verify', 'HEAD']) });
}
writeFileSync(reportPath + '.tmp', JSON.stringify(report));
renameSync(reportPath + '.tmp', reportPath);
`;
  await writeFile(executable, String.raw`#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
if (process.argv[2] === 'sandbox') {
  const fixture = realpathSync(${JSON.stringify(f.root)});
  const real = (process.env.PATH ?? '').split(':').filter(isAbsolute).map(directory => join(directory, 'codex')).find(path => existsSync(path) && !realpathSync(path).startsWith(fixture + '/'));
  if (!real) process.exit(127);
  process.exit(spawnSync(real, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);
}
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args));
const nativeId = ${JSON.stringify(nativeId)};
const targets = ${JSON.stringify(targets)};
const metadata = ${JSON.stringify(metadata)};
const render = text => process.stdout.write('\x1b[2J\x1b[H' + text);
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
render('Ask Codex to do anything\r\n› Ask Codex to do anything');
let input = '', assignment, reported = false;
process.stdin.on('data', data => {
  input += data.replace(/\r/g, '\n');
  if (input.includes('/status')) {
    input = '';
    render('Session: ' + nativeId + '\r\nAsk Codex to do anything\r\n› Ask Codex to do anything');
    return;
  }
  if (assignment) return;
  const offset = input.search(/\{\s*"project"\s*:/);
  if (offset < 0) return;
  let candidate;
  try { candidate = JSON.parse(input.slice(offset).trim()); } catch { return; }
  if (!/[\r\n]\s*$/.test(input)) return;
  assignment = candidate;
  render('Session: ' + nativeId + '\r\n• Working (0s • esc to interrupt)\r\n› ');
});
const timer = setInterval(() => {
  if (!assignment) return;
  if (!reported && existsSync(${JSON.stringify(releasePath)})) {
    const report = { status: metadata ? 'succeeded' : 'failed', answer: 'Scoped synthetic writes', changes: assignment.assignments.map(change => ({ id: change.id, items: change.items.map(item => ({ id: item.id, status: metadata ? 'succeeded' : 'failed', ...(metadata ? {} : { reason: 'Synthetic report-only scope keeps task unfinished' }) })) })), commits: [] };
    const launcher = JSON.parse(readFileSync(${JSON.stringify(releasePath)}, 'utf8'));
    const probe = spawnSync(launcher.executable, [...launcher.args, process.execPath, '--input-type=module', '-e', ${JSON.stringify(writeProbe)}, JSON.stringify({ targets, denied: ${JSON.stringify(denied)}, reportPath: assignment.report_path, report, commitTargets: ${JSON.stringify(metadata ? [{ repository: f.root, paths: [documentPath, f.questionsPath] }, { repository: f.cwd, paths: [join(f.cwd, 'local.txt')] }] : [])} })], { encoding: 'utf8', env: launcher.environment, timeout: launcher.timeoutMs });
    writeFileSync(${JSON.stringify(writeEvidence)}, JSON.stringify({ status: probe.status, stdout: probe.stdout, stderr: probe.stderr, error: probe.error?.message }));
    reported = true;
  }
  if (existsSync(${JSON.stringify(exitGate)})) { clearInterval(timer); process.exit(17); }
}, 30);
`, { mode: 0o700 });
  const syntax = spawnSync(process.execPath, ['--check', executable], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const rafPath = join(f.confRoot, 'raf.json');
  const raf = JSON.parse(await readFile(rafPath, 'utf8'));
  const protocol: ProtocolSettings = {
    runner: 'codex', executable: 'codex', version: '0.160.0', baseArgs: ['--no-daemon', '--no-alt-screen', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    native: codexProtocol.native,
    modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null,
    quotaCommand: '/status', navigation: [], markers: { ready: ['Ask Codex to do anything'] }, quotaParser: 'codex_status', modelPools: {}, quotaReliable: false, liveTaskVerified: false,
    timeouts: { startupMs: 5000, transitionMs: 5000, overallMs: 15000, pollMs: 30 }, collection: { intervalMs: 60000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  };
  await writeFile(rafPath, JSON.stringify({ ...raf, runnerProtocols: [protocol] }));
  const command = join(f.root, 'writes-command.mjs');
  await writeFile(command, `import { createAppRuntime } from ${JSON.stringify(f.appRuntimeUrl)};
import { createProductionServices } from ${JSON.stringify(f.runtimeUrl)};
import { openStateStore } from ${JSON.stringify(f.storeUrl)};
const context = { ...${JSON.stringify(f.context)}, resolveCaller: async () => undefined };
const app = createAppRuntime(context, { loadConfiguration: async () => (${JSON.stringify(configured)}), openStore: async path => openStateStore(path), createServices: createProductionServices, nextRunIdentity: () => ({runId:${JSON.stringify(runId)},tmuxSession:'raf-writes-synthetic'}), now: Date.now });
try { console.log(JSON.stringify(await app.handlers['agent run'](${JSON.stringify(params)}))); } finally { await app.close(); }
`);
  const syntaxCommand = spawnSync(process.execPath, ['--check', command], { encoding: 'utf8' });
  assert.equal(syntaxCommand.status, 0, syntaxCommand.stderr);
  const launch = () => {
    const child = spawnSync(process.execPath, [command], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: f.binRoot + delimiter + (process.env.PATH ?? ''), HOME: f.home } });
    assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stderr}\n${child.stdout}`);
    const started = JSON.parse(child.stdout.trim());
    f.trackProcess(started.process.pid);
    const wrapper = f.store.sessionRepository.transaction(tx => tx.getSession(runId))?.launchContext?.wrapper;
    if (wrapper) f.trackProcess(wrapper.pid);
    return started;
  };
  const session = () => f.store.sessionRepository.transaction(tx => tx.getSession(runId));
  return { ...f, runId, reportPath, metadataDirectory, documentPath, targets, boundaries, gitDirectories, writableGitDirectories, siblingPath, protocol, argvPath, releasePath, exitGate, writeEvidence, nativeId, launch, session, git, initialTasks, baselineHead };
}

for (const [metadata, worktree, missingQuestions] of [[true, false, false], [false, false, false], [true, true, false], [false, true, false], [false, true, true]] as const) {
  test(`[production-codex-writes-qa] ${metadata ? 'implement: derived change, questions and workspace boundaries' : 'spec: derived document boundaries and Orchestrator git without code git'}${worktree ? ' in a linked worktree' : ''}${missingQuestions ? ' creates an absent questions file and parent directory' : ''} persist scoped native writes after parent exit`, async t => {
    const f = await scopedFixture(t, metadata, worktree, missingQuestions);
    const started = f.launch();
    assert.equal(started.status, 'running');
    assert.equal(started.selection.quota, 'unknown');
    assert.equal(started.process.runnerSessionId, f.nativeId);
    const args: string[] = JSON.parse(await readFile(f.argvPath, 'utf8'));
    assert.ok(args.includes('sandbox_mode="workspace-write"') && !args.includes('--sandbox'), 'workspace-write is kept by the Codex permission profile, not the legacy --sandbox override');
    assert.ok(args.includes('default_permissions="linux"'));
    assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
    assert.equal(args.some(arg => arg === '--add-dir' || arg.startsWith('--add-dir=')), false, 'permission profiles replace native directory flags');
    const filesystemConfig = args.find(arg => arg.startsWith('permissions.linux.filesystem='));
    assert.ok(filesystemConfig);
    const filesystem: Record<string, string> = JSON.parse(filesystemConfig.slice(filesystemConfig.indexOf('=') + 1).replace(/("(?:[^"\\]|\\.)*")=/gu, '$1:'));
    const directories = Object.entries(filesystem).filter(([path, access]) => path.startsWith('/') && access === 'write').map(([path]) => path);
    const expected = [await realpath(dirname(f.reportPath))];
    expected.push(await realpath(f.metadataDirectory), ...f.writableGitDirectories);
    if (metadata) expected.push(await realpath(f.cwd));
    if (metadata && worktree) expected.push(join(await realpath(f.cwd), '.git'));
    assert.deepEqual(directories.sort(), [...new Set(expected)].sort(), 'the profile grants only declared directories, required git roots and own report directory');
    assert.equal(directories.includes(await realpath(dirname(f.questionsPath))), false, 'an exact questions file bind must never grant its parent directory');
    assert.equal(directories.includes(await realpath(f.questionsPath)), false, 'file boundaries use exact binds rather than native directory arguments');
    assert.equal(directories.includes(await realpath(f.root)), false);
    assert.equal(directories.includes(await realpath(f.home)), false);
    assert.equal(directories.includes(await realpath(dirname(f.statePath))), false);
    const durable = await Promise.all((f.session()?.launchContext?.writeBoundaries ?? []).map(path => realpath(path).catch(() => path)));
    assert.deepEqual(durable.sort(), (await Promise.all([...f.boundaries, ...f.writableGitDirectories].map(path => realpath(path)))).sort());
    const root = await realpath(f.root);
    for (const path of [...directories, ...durable].filter(path => path.split('/').includes('.git'))) {
      const suffix = relative(root, path);
      assert.ok(suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix), `git boundary must remain inside Orchestrator: ${path}`);
    }
    assert.equal([...directories, ...durable].includes(join(dirname(root), '.git')), false, 'an ancestor .git is never a writable boundary');
    if (!metadata && worktree) for (const path of f.gitDirectories.slice(0, -1)) {
      assert.equal(directories.includes(path), false, 'spec must not gain native code git rights');
      assert.equal(durable.includes(path), false, 'spec must not persist code git rights');
    }
    if (missingQuestions) assert.equal(await readFile(f.questionsPath, 'utf8'), '', 'preflight creates only an empty questions file');
    assert.equal(listTaskReservations(f.store).length, 1);
    const runDirectory = dirname(f.reportPath);
    const probeDirectory = join(f.tmpRoot, `${f.runId}-write-probe`);
    await mkdir(probeDirectory);
    const writableDirectories = [...durable, runDirectory];
    const model = configuration.models.models[0];
    const baseInvocation = buildRunnerInvocation(f.protocol, { model: model.id, effort: model.effort });
    const invocation = { ...baseInvocation, args: [...baseInvocation.args, ...nativeWriteScopeArgs(f.protocol, writableDirectories, [])] };
    const prepared = await prepareCodexSandbox({
      runId: `${f.runId}-write-probe`, invocation, cwd: f.cwd, runDirectory: probeDirectory, writableDirectories,
      environment: { ...process.env, HOME: f.home, PATH: process.env.PATH ?? '' },
      timeoutMs: f.protocol.timeouts.overallMs,
      scope: { hidden: [f.statePath, `${f.statePath}-wal`, `${f.statePath}-shm`, join(dirname(f.statePath), 'secrets.json')], readable: [runDirectory], tmuxDirectory: probeDirectory, excludedCommands: [] },
    });
    t.after(() => prepared.cleanup());
    await writeFile(f.releasePath, JSON.stringify({ ...prepared.toolSandbox, environment: prepared.environment, timeoutMs: f.protocol.timeouts.overallMs }));
    const evidence = await eventually(() => readFile(f.writeEvidence, 'utf8').catch(() => undefined), value => value !== undefined, 'synthetic runner executes actual sandbox writes');
    const probe = JSON.parse(evidence!);
    assert.equal(probe.status, 0, `${probe.error ?? ''}\n${probe.stderr}\n${probe.stdout}`);
    assert.equal(await readFile(f.siblingPath, 'utf8').catch((error: NodeJS.ErrnoException) => error.code), 'ENOENT', 'questions sibling stays unwritable');
    const accepted = await eventually(f.session, row => row?.result?.status === (metadata ? 'succeeded' : 'failed'), 'worker writes exact report path and accepts report after parent exited');
    assert.equal(accepted?.state, 'running');
    assert.equal(accepted?.result?.response, 'Scoped synthetic writes');
    const expectedTasks = metadata ? f.initialTasks.replace('- [ ] 2.1 ', '- [x] 2.1 ') : f.initialTasks;
    assert.equal(await readFile(f.tasksPath, 'utf8'), expectedTasks, 'raf alone marks the assigned task and preserves the unassigned task');
    const tasksRelative = relative(f.root, f.tasksPath);
    assert.equal(f.git('show', `HEAD:${tasksRelative}`), expectedTasks.trim(), 'the accepted checkbox state is committed');
    assert.equal(f.git('diff', 'HEAD', '--', tasksRelative), '', 'no uncommitted checkbox remains');
    const reported = JSON.parse(await readFile(f.reportPath, 'utf8'));
    if (metadata) {
      assert.deepEqual(reported.commits, [
        { repository: f.root, sha: f.git('rev-parse', 'HEAD^') },
        { repository: f.cwd, sha: f.git('-C', f.cwd, 'rev-parse', 'HEAD') },
      ], 'the report names the sandbox commits separately from the raf checkbox commit');
      assert.equal(f.git('rev-list', '--count', `${reported.commits[0].sha}..HEAD`), '1', 'raf creates exactly one checkbox commit after the reported document commit');
      assert.equal(f.git('rev-list', '--count', `${f.baselineHead}..HEAD`), '2', 'only the synthetic document commit and raf checkbox commit advance Orchestrator');
      assert.deepEqual(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', reported.commits[0].sha).split('\n').sort(),
        [relative(f.root, f.documentPath), relative(f.root, f.questionsPath)].sort(), 'the synthetic document commit contains only its assigned writes');
      assert.equal(f.git('-C', f.cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', reported.commits[1].sha), 'local.txt');
      assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), tasksRelative, 'the checkbox commit touches only tasks.md');
    } else {
      assert.deepEqual(reported.commits, []);
      assert.equal(f.git('rev-parse', 'HEAD'), f.baselineHead, 'a failed report creates no checkbox commit');
    }
    const writes = JSON.parse(probe.stdout);
    assert.ok(writes.every((row: { allowed: boolean }) => row.allowed));
    for (const path of f.targets) assert.equal(await readFile(path, 'utf8'), 'approved synthetic write');
    assert.equal(reported.status, metadata ? 'succeeded' : 'failed');
    await writeFile(f.exitGate, 'exit');
    const done = await eventually(f.session, row => row?.state === 'finished', 'owned worker finalizes after native exit');
    assert.equal(done?.result?.status, metadata ? 'succeeded' : 'failed');
    assert.equal(done?.result?.response, '');
    assert.equal(done?.launchContext, undefined);
    assert.deepEqual(listTaskReservations(f.store), []);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  });
}
