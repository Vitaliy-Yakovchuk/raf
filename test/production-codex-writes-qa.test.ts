import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rename, rm, realpath } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createProductionServices } from '../src/production-runtime.ts';
import { createResourceSnapshotReader, executeCommand } from '../src/os-runtime.ts';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import { openStateStore } from '../src/state-store.ts';
import { createSessionState } from '../src/session-state.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import { selectModel, listModelAvailability } from '../src/model-routing.ts';
import type { RuntimeConfiguration, RuntimeContext, RuntimeLaunch, RuntimeTaskContext } from '../src/app-runtime.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { AssignmentSnapshot } from '../src/assignment.ts';
import type { LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const appRuntimeUrl = new URL('../src/app-runtime.ts', import.meta.url).href;
const storeUrl = new URL('../src/state-store.ts', import.meta.url).href;
const runtimeUrl = pathToFileURL(fileURLToPath(new URL('../src/production-runtime.ts', import.meta.url))).href;
const configuration: RuntimeConfiguration = {
  catalog: { commands: [], reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }] },
  models: {
    version: 1,
    runners: [{ id: 'codex', initialEnabled: true }],
    models: [{ id: 'gpt-6.1-sol', version: '6.1', runner: 'codex', effort: 'high', complexity: 'decision', enabled: true }],
    routing: { complexityOrder: ['decision'], taskClassification: {}, runnerPreferences: [], modelTransitions: [], roleModelBindings: {} },
  },
  commandTiming: { emaAlpha: 0.1 },
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-prod-'));
  const confRoot = join(root, 'conf');
  const home = join(root, 'home');
  const tmpRoot = join(root, 'tmp');
  const cwd = join(root, 'raf-develop');
  const statePath = join(home, '.raf', 'isolated.sqlite');
  const binRoot = join(root, 'bin');
  const socket = join(root, 'tmux.sock');
  await Promise.all([mkdir(confRoot), mkdir(dirname(statePath), { recursive: true }), mkdir(tmpRoot), mkdir(cwd), mkdir(binRoot)]);
  const tmuxLookup = spawnSync('which', ['tmux'], { encoding: 'utf8' });
  assert.equal(tmuxLookup.status, 0, tmuxLookup.stderr);
  const realTmuxPath = tmuxLookup.stdout.trim();
  const openspecLookup = spawnSync('which', ['openspec'], { encoding: 'utf8' });
  assert.equal(openspecLookup.status, 0, openspecLookup.stderr);
  const realOpenSpecPath = openspecLookup.stdout.trim();
  assert.ok(realOpenSpecPath.startsWith('/') && !realOpenSpecPath.startsWith(binRoot + '/'));
  const openspecVersion = spawnSync(realOpenSpecPath, ['--version'], { encoding: 'utf8' });
  assert.equal(openspecVersion.status, 0, openspecVersion.stderr);
  assert.equal(openspecVersion.stdout.trim(), '1.14.3');
  const tmuxPath = join(binRoot, 'tmux');
  await writeFile(tmuxPath, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const result = spawnSync(${JSON.stringify(realTmuxPath)}, ['-S', ${JSON.stringify(socket)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const store = openStateStore(statePath);
  const ownedPids = new Set<number>();
  const ownedPidFiles = new Set<string>();
  const trackProcess = (pid: number) => {
    assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    ownedPids.add(pid);
  };
  const trackPidFile = (path: string) => ownedPidFiles.add(path);
  t.after(async () => {
    await executeCommand({ executable: realTmuxPath, args: ['-S', socket, 'kill-server'] }).catch(() => undefined);
    await executeCommand({ executable: realTmuxPath, args: ['-S', join(tmpRoot, 'tmux', 'server.sock'), 'kill-server'] }).catch(() => undefined);
    for (const path of ownedPidFiles) {
      const pid = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (pid !== undefined) trackProcess(Number(pid));
    }
    try {
      await Promise.all([...ownedPids].map(pid => eventually(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
          throw error;
        }
      }, exited => exited, `owned process ${pid} exited before fixture removal`)));
    } finally { store.close(); }
    await rm(root, { recursive: true, force: true });
  });
  const git = spawnSync('git', ['init', '--quiet', '--initial-branch=develop', cwd], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  await writeFile(join(confRoot, 'projects.json'), JSON.stringify({
    version: 1,
    projects: { raf: { path: 'raf-develop', profile: 'raf', branchPaths: { develop: 'raf-develop' }, usesSharedLibs: false } },
    profiles: { raf: { development: 'develop', integration: 'main', production: 'main' } },
    layout: { directoryPattern: '{project}-{branch}', sharedLibrariesLink: 'shared-libs', sharedLibrariesTarget: '../shared-libs-{branch}' },
  }));
  await writeFile(join(confRoot, 'models.json'), JSON.stringify(configuration.models));
  await writeFile(join(root, 'catalog.json'), JSON.stringify(configuration.catalog));
  await writeFile(join(confRoot, 'raf.json'), JSON.stringify({ version: 1, state: { fileName: 'isolated.sqlite' }, commandTiming: configuration.commandTiming }));
  await writeFile(join(confRoot, 'raf-constants.json'), JSON.stringify({
    version: 1,
    agentTypes: [{ id: 'main', launchableByRaf: false }, { id: 'implement', launchableByRaf: true }],
    reportStatuses: [{ id: 'succeeded', event: 'agent.succeeded' }, { id: 'failed', event: 'agent.failed' }],
    eventIdKinds: { agentAddress: 'Fixture agent address', reminderId: 'Fixture reminder ID' },
    events: ['agent.started', 'agent.activity-changed', 'agent.interrupted', 'agent.closed', 'agent.succeeded', 'agent.failed', 'reminder.activated', 'reminder.closed'].map(id => ({ id, idKind: id.startsWith('reminder.') ? 'reminderId' : 'agentAddress' })),
  }));
  const templates = join(confRoot, 'briefs');
  await Promise.all([mkdir(join(templates, 'runners'), { recursive: true }), mkdir(join(templates, 'tasks'), { recursive: true })]);
  await Promise.all([
    writeFile(join(templates, 'runners', 'codex.md'), 'FIXTURE_CODEX_RUNNER'),
    writeFile(join(templates, 'tasks', 'implement.md'), 'FIXTURE_IMPLEMENT_STAGE'),
    writeFile(join(templates, 'completion.md'), 'FIXTURE_COMPLETION'),
  ]);
  const changeRoot = join(root, 'openspec', 'changes', 'fixture-launch');
  const specRoot = join(changeRoot, 'specs', 'projects', 'raf', 'agent-run');
  await mkdir(specRoot, { recursive: true });
  const tasksPath = join(changeRoot, 'tasks.md');
  await Promise.all([
    writeFile(tasksPath, '## 2. Fixture\n\n- [ ] 2.1 Виконати лише synthetic fixture\n'),
    writeFile(join(changeRoot, 'proposal.md'), '# Fixture launch\n\n## Why\n\nVerify isolated production composition.\n\n## What Changes\n\nRun a synthetic executable only.\n'),
    writeFile(join(changeRoot, 'design.md'), '# Fixture design\n\nUse the production composition with an isolated home and owned tmux socket.\n'),
    writeFile(join(specRoot, 'spec.md'), '## ADDED Requirements\n\n### Requirement: Synthetic execution\n\nThe fixture SHALL run only its synthetic executable.\n\n#### Scenario: Owned launch\n\n- **WHEN** the fixture starts\n- **THEN** its report belongs to the reserved run\n'),
  ]);
  const params = { id: 'worker-fixture', type: 'implement', project: 'raf', features: ['fixture-launch'], phase: 'implement', complexity: 'decision', tasks: ['fixture-launch:2.1'] };
  const resourcePaths = [cwd, dirname(statePath), tmpRoot];
  const resources = await createResourceSnapshotReader({ machineId: hostname(), paths: resourcePaths }).read();
  const fileSystemIds = [...new Set(resourcePaths.map(path => resources.fileSystemByPath[path]))];
  assert.ok(fileSystemIds.every(id => typeof id === 'string' && id.length > 0), JSON.stringify(resources.reasons));
  const taskContext: RuntimeTaskContext = {
    branch: 'develop', outcome: 'Перевірити ізольовану production composition', writeBoundaries: ['fixture.txt'],
    sources: ['openspec/changes/fixture-launch/specs/projects/raf/agent-run/spec.md'],
    requested: { ramBytes: 1024, diskBytes: Object.fromEntries(fileSystemIds.map(id => [id, 1024])) }, requiredFileSystemIds: fileSystemIds,
    reportSchema: { type: 'object', required: ['status', 'answer', 'changes'] },
  };
  const taskContextPath = join(tmpRoot, 'task-context', `${params.id}.json`);
  await mkdir(dirname(taskContextPath));
  const cliCalls = join(root, 'openspec-calls.jsonl');
  const openspecPath = join(binRoot, 'openspec');
  await writeFile(openspecPath, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cliCalls)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const result = spawnSync(${JSON.stringify(realOpenSpecPath)}, args, { cwd: process.cwd(), stdio: 'inherit' });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const calls: AdapterCommand[] = [];
  const execute: AdapterCommandExecutor = async command => {
    calls.push(structuredClone(command));
    if (command.executable === 'openspec') return executeCommand({ ...command, executable: openspecPath });
    if (command.executable === 'tmux') return executeCommand({ ...command, executable: realTmuxPath, args: ['-S', socket, ...command.args] });
    if (['codex', 'grok', 'agy', 'claude'].includes(command.executable) && !command.args.includes('--version')) throw new Error('Real model CLI is forbidden in this fixture');
    return executeCommand(command);
  };
  store.initializeRunners(configuration.models.runners);
  const context: RuntimeContext = { orchestratorRoot: root, confRoot, artifactPath: join(root, 'catalog.json'), statePath, tmpRoot, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined };
  const services = await createProductionServices(store, configuration, context, { execute });
  const validation = await services.assignment.validate({ root, selections: [{ change: 'fixture-launch', items: [{ id: '2.1' }] }] });
  if (!validation.ok) assert.fail(JSON.stringify(validation));
  const assignment: AssignmentSnapshot = validation.snapshot;
  await writeFile(taskContextPath, JSON.stringify({ version: 1, parameters: params, assignment, context: taskContext }), { mode: 0o600 });
  const completeAssignment = async () => {
    const current = await readFile(tasksPath, 'utf8');
    const pending = '- [ ] 2.1 Виконати лише synthetic fixture';
    assert.equal(current.split(pending).length, 2);
    const completed = current.replace(pending, '- [x] 2.1 Виконати лише synthetic fixture');
    const staging = join(changeRoot, 'tasks.next.md');
    await writeFile(staging, completed, { mode: 0o600, flag: 'wx' });
    await rename(staging, tasksPath);
    assert.equal(await readFile(tasksPath, 'utf8'), completed);
  };
  return { root, confRoot, home, cwd, tmpRoot, statePath, binRoot, context, store, assignment, params, taskContext, taskContextPath, execute, calls, completeAssignment, cliCalls, openspecPath, socket, realTmuxPath, realOpenSpecPath, trackProcess, trackPidFile };
}

async function eventually<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 12000;
  let last: T;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`${description}: ${JSON.stringify(last)}`);
}

async function scopedFixture(t: TestContext, metadata: boolean) {
  const f = await fixture(t);
  const catalog = JSON.parse(await readFile(new URL('../dist/catalog.json', import.meta.url), 'utf8'));
  const configured = { ...configuration, catalog };
  const runId = 'writes-run-1';
  const reportPath = join(f.tmpRoot, runId, `${f.params.id}.json`);
  const metadataDirectory = join(f.root, 'openspec', 'changes', 'fixture-launch');
  const documentPath = join(metadataDirectory, 'qa', 'new-document.md');
  const relativePath = join(f.root, 'approved-relative', 'note.md');
  const approvedDirectory = join(f.root, 'approved-directory');
  await mkdir(approvedDirectory);
  const targets = metadata ? [documentPath, relativePath, join(f.cwd, 'local.txt'), join(approvedDirectory, 'generated.md')] : [];
  const boundaries = metadata ? [join(metadataDirectory, 'tasks.md'), documentPath, '../approved-relative/note.md', 'local.txt', approvedDirectory] : [];
  const taskContext = { ...f.taskContext, writeBoundaries: boundaries };
  await writeFile(f.taskContextPath, JSON.stringify({ version: 1, parameters: f.params, assignment: f.assignment, context: taskContext }), { mode: 0o600 });
  const pidPath = join(f.root, 'runner.pid');
  const argvPath = join(f.root, 'runner-argv.json');
  const releasePath = join(f.root, 'write-and-report');
  const exitGate = join(f.root, 'runner-exit');
  const writeEvidence = join(f.root, 'write-evidence.json');
  const nativeId = '11111111-1111-4111-8111-111111111111';
  f.trackPidFile(pidPath);
  const executable = join(f.binRoot, 'codex');
  await writeFile(executable, String.raw`#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
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
const within = (path, root) => { const suffix = relative(root, path); return suffix === '' || !suffix.startsWith('..' + '/') && suffix !== '..' && !isAbsolute(suffix); };
const timer = setInterval(() => {
  if (!assignment) return;
  if (!reported && existsSync(${JSON.stringify(releasePath)})) {
    const roots = [realpathSync(process.cwd()), ...args.flatMap((arg, index) => arg === '--add-dir' ? [realpathSync(args[index + 1])] : [])];
    const allows = path => roots.some(root => within(resolve(realpathSync(dirname(path)), path.split('/').at(-1)), root));
    const allowed = [...targets, assignment.report_path].map(path => ({ path, allowed: existsSync(dirname(path)) && allows(path) }));
    writeFileSync(${JSON.stringify(writeEvidence)}, JSON.stringify(allowed));
    if (!allowed.every(row => row.allowed)) { reported = true; return; }
    for (const target of targets) writeFileSync(target, 'approved synthetic write');
    if (metadata) {
      const task = ${JSON.stringify(join(metadataDirectory, 'tasks.md'))};
      writeFileSync(task, readFileSync(task, 'utf8').replace('- [ ] 2.1 ', '- [x] 2.1 '));
    }
    const report = { status: metadata ? 'succeeded' : 'failed', answer: 'Scoped synthetic writes', changes: assignment.assignments.map(change => ({ id: change.id, items: change.items.map(item => ({ id: item.id, status: metadata ? 'succeeded' : 'failed', ...(metadata ? {} : { reason: 'Synthetic report-only scope keeps task unfinished' }) })) })) };
    writeFileSync(assignment.report_path, JSON.stringify(report));
    reported = true;
  }
  if (existsSync(${JSON.stringify(exitGate)})) { clearInterval(timer); process.exit(17); }
}, 30);
`, { mode: 0o700 });
  const syntax = spawnSync(process.execPath, ['--check', executable], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify({ version: 1, runnerProtocols: [{
    runner: 'codex', executable, version: '0.160.0', baseArgs: ['--no-daemon', '--no-alt-screen', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null,
    quotaCommand: '/status', navigation: [], markers: { ready: ['Ask Codex to do anything'] }, quotaParser: 'codex_status', modelPools: {}, quotaReliable: false, liveTaskVerified: false,
    timeouts: { startupMs: 5000, transitionMs: 5000, overallMs: 15000, pollMs: 30 }, collection: { intervalMs: 60000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  }] }));
  const command = join(f.root, 'writes-command.mjs');
  await writeFile(command, `import { createAppRuntime } from ${JSON.stringify(appRuntimeUrl)};
import { createProductionServices } from ${JSON.stringify(runtimeUrl)};
import { openStateStore } from ${JSON.stringify(storeUrl)};
const context = { ...${JSON.stringify(f.context)}, resolveCaller: async () => undefined };
const app = createAppRuntime(context, { loadConfiguration: async () => (${JSON.stringify(configured)}), openStore: async path => openStateStore(path), createServices: createProductionServices, nextRunIdentity: () => ({runId:${JSON.stringify(runId)},tmuxSession:'raf-writes-synthetic'}), now: Date.now });
try { console.log(JSON.stringify(await app.handlers['agent run'](${JSON.stringify(f.params)}))); } finally { await app.close(); }
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
  return { ...f, runId, reportPath, metadataDirectory, documentPath, relativePath, approvedDirectory, targets, boundaries, argvPath, releasePath, exitGate, writeEvidence, nativeId, launch, session };
}

for (const metadata of [true, false]) {
  test(`[production-codex-writes-qa] ${metadata ? 'approved metadata and relative paths' : 'empty task boundaries'} persist scoped native writes after parent exit`, async t => {
    const f = await scopedFixture(t, metadata);
    const started = f.launch();
    assert.equal(started.status, 'running');
    assert.equal(started.selection.quota, 'unknown');
    assert.equal(started.process.runnerSessionId, f.nativeId);
    const args: string[] = JSON.parse(await readFile(f.argvPath, 'utf8'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
    const directories = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
    const expected = [await realpath(dirname(f.reportPath))];
    if (metadata) expected.push(await realpath(f.metadataDirectory), join(await realpath(f.metadataDirectory), 'qa'), join(await realpath(f.root), 'approved-relative'), await realpath(f.approvedDirectory));
    assert.deepEqual(directories.sort(), [...new Set(expected)].sort(), 'actual native argv must grant only declared outside-cwd parents plus own report directory');
    assert.equal(directories.includes(await realpath(f.root)), false);
    assert.equal(directories.includes(await realpath(f.home)), false);
    assert.equal(directories.includes(await realpath(dirname(f.statePath))), false);
    assert.deepEqual(f.session()?.launchContext?.writeBoundaries, f.boundaries);
    assert.equal(listTaskReservations(f.store).length, 1);
    await writeFile(f.releasePath, 'go');
    const accepted = await eventually(f.session, row => row?.result?.status === (metadata ? 'succeeded' : 'failed'), 'worker writes exact report path and accepts report after parent exited');
    assert.equal(accepted?.state, 'running');
    assert.equal(accepted?.result?.response, 'Scoped synthetic writes');
    const writes = JSON.parse(await readFile(f.writeEvidence, 'utf8'));
    assert.ok(writes.every((row: { allowed: boolean }) => row.allowed));
    for (const path of f.targets) assert.equal(await readFile(path, 'utf8'), 'approved synthetic write');
    assert.equal(JSON.parse(await readFile(f.reportPath, 'utf8')).status, metadata ? 'succeeded' : 'failed');
    await writeFile(f.exitGate, 'exit');
    const done = await eventually(f.session, row => row?.state === 'finished', 'owned worker finalizes after native exit');
    assert.equal(done?.result?.status, metadata ? 'succeeded' : 'failed');
    assert.equal(done?.result?.response, '');
    assert.equal(done?.launchContext, undefined);
    assert.deepEqual(listTaskReservations(f.store), []);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  });
}
