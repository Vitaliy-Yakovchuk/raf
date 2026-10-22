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

async function workerFixture(t: TestContext, prepareInFixture = true) {
  const f = await fixture(t);
  const runId = 'fixture-run-1';
  const address = f.params.id;
  const tmuxSession = 'raf-production-fixture';
  const reportPath = join(f.tmpRoot, runId, `${address}.json`);
  const releasePath = join(f.root, 'release.json');
  const exitGatePath = join(f.root, 'exit-gate');
  const deliveredPath = join(f.root, 'delivered.txt');
  const pidPath = join(f.root, 'agent.pid');
  const wrapperPidPath = join(f.root, 'wrapper.pid');
  f.trackPidFile(pidPath);
  f.trackPidFile(wrapperPidPath);
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const executable = join(f.binRoot, 'codex');
  await writeFile(executable, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0'); process.exit(0); }
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
console.log('OpenAI Codex (v0.0.0)\\nAsk Codex to do anything');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  input += text;
  if (input.includes('/status')) { console.log('Session: ${nativeId}\\nAsk Codex to do anything'); input = input.replace('/status', ''); }
  if (input.includes('BRIEF_END')) writeFileSync(${JSON.stringify(deliveredPath)}, input);
});
const watchdog = setTimeout(() => process.exit(91), 20000);
let release;
const timer = setInterval(() => {
  if (!release && existsSync(${JSON.stringify(releasePath)})) {
    release = JSON.parse(readFileSync(${JSON.stringify(releasePath)}, 'utf8'));
    if (release.report) writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(release.report));
  }
  if (!release || !existsSync(${JSON.stringify(exitGatePath)})) return;
  clearInterval(timer); clearTimeout(watchdog);
  process.exit(release.exitCode);
}, 30);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const settings: ProtocolSettings = {
    runner: 'codex', executable, version: '0.0.0', baseArgs: [], modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config',
    modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null, quotaCommand: '/status', navigation: [],
    markers: { ready: ['Ask Codex to do anything'], auth_required: ['FIXTURE_AUTH_REQUIRED'], permission_required: ['FIXTURE_PERMISSION_REQUIRED'] },
    quotaParser: 'unknown', modelPools: {}, quotaReliable: false, liveTaskVerified: true,
    timeouts: { startupMs: 5000, transitionMs: 5000, overallMs: 10000, pollMs: 30 },
    collection: { intervalMs: 60000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  };
  const rafPath = join(f.confRoot, 'raf.json');
  const raf = JSON.parse(await readFile(rafPath, 'utf8'));
  await writeFile(rafPath, JSON.stringify({ ...raf, runnerProtocols: [settings] }));
  const request: LaunchWrapperRequest = { tmpRoot: f.tmpRoot, runId, address, assignment: f.assignment, statePath: f.statePath, cwd: f.cwd, tmuxSession, selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, brief: 'DELIVERY_QA\n' + 'Я'.repeat(6579 - [...'DELIVERY_QA\n\nBRIEF_END'].length) + '\nBRIEF_END', readinessTimeoutMs: 5000 };
  const session = () => f.store.sessionRepository.transaction(tx => tx.getSession(runId));
  const runtimeLaunch: RuntimeLaunch = { runId, addressId: address, tmuxSession, activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd }, assignment: f.assignment, selection: { status: 'selected', ...request.selection, reason: 'synthetic fixture only', quota: 'unknown' }, statePath: f.statePath, tmpRoot: f.tmpRoot };
  if (prepareInFixture) {
    const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
    const descriptor = await services.resolveTask(f.params, f.assignment);
    const prepared = await services.prepareReport(runtimeLaunch);
    assert.equal(prepared.reportPath, reportPath);
    const reservation = await services.reserve({ ...runtimeLaunch, reportPath: prepared.reportPath, requested: descriptor.requested, requiredFileSystemIds: descriptor.requiredFileSystemIds });
    assert.equal(reservation.admitted, true, 'reason' in reservation ? reservation.reason : 'admitted');
    const reserved = session();
    assert.ok(reserved?.launchContext);
    assert.equal(reserved.launchContext.reportPath, prepared.reportPath);
    await writeFile(reserved.launchContext.briefPath, request.brief);
    const claims = listTaskReservations(f.store);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].lease.owner.runId, runId);
    assert.ok(claims[0].lease.owner.fence.length > 0);
    assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  }
  const launch = async () => {
    const started = await launchPersistentWrapper(request, { timeoutMs: settings.timeouts.overallMs, workerCommand: { executable: process.execPath, args: ['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; import { runProductionWorker } from ${JSON.stringify(runtimeUrl)}; writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid)); process.env.PATH = ${JSON.stringify(f.binRoot + delimiter)} + (process.env.PATH ?? ''); process.env.HOME = ${JSON.stringify(f.home)}; await runProductionWorker();`] } });
    f.trackProcess(started.wrapperPid);
    f.trackProcess(started.identity.pid);
    assert.equal(Number(await readFile(wrapperPidPath, 'utf8')), started.wrapperPid);
    return started;
  };
  const report = { status: 'succeeded', answer: 'Виконано лише доручену fixture.', changes: [{ id: 'fixture-launch', items: [{ id: '2.1', status: 'succeeded' }] }] };
  return { ...f, runId, address, reportPath, releasePath, exitGatePath, deliveredPath, pidPath, nativeId, settings, request, runtimeLaunch, launch, session, report };
}

async function deliveryFixture(t: TestContext, mode = 'race') {
  const f = await workerFixture(t, false);
  f.settings.version = '0.160.0';
  f.settings.liveTaskVerified = false;
  f.settings.timeouts.transitionMs = 5000;
  f.settings.timeouts.pollMs = 30;
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify({ version: 1, runnerProtocols: [f.settings] }));
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const descriptor = await services.resolveTask(f.params, f.assignment);
  const prepared = await services.prepareReport(f.runtimeLaunch);
  const reservation = await services.reserve({ ...f.runtimeLaunch, reportPath: prepared.reportPath, requested: descriptor.requested, requiredFileSystemIds: descriptor.requiredFileSystemIds });
  assert.equal(reservation.admitted, true, 'reason' in reservation ? reservation.reason : 'admitted');
  await writeFile(f.session()!.launchContext!.briefPath, f.request.brief);
  const acceptedPath = join(f.root, 'native-accepted.json');
  const inputLog = join(f.root, 'native-input.jsonl');
  await writeFile(f.settings.executable, String.raw`#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
writeFileSync(${JSON.stringify(f.pidPath)}, String(process.pid));
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
const mode = ${JSON.stringify(mode)};
const brief = ${JSON.stringify(f.request.brief)};
const nativeId = ${JSON.stringify(f.nativeId)};
const render = text => process.stdout.write('\x1b[2J\x1b[H' + text);
const header = 'OpenAI Codex (v0.160.0)';
const footer = 'GPT-6.1-Sol high fast · ~/Documents/orchestrator/raf-develop';
const nativeScreen = (input, extra = '') => header + (hasStatus ? '\r\nSession: ' + nativeId : '') + extra + '\r\n› ' + input + '\r\n' + footer;
const ready = () => render(header + '\r\n› Ask Codex to do anything\r\n' + footer);
ready();
let buffer = '';
let pending = false;
let absorbed = false;
let enters = 0;
let hasStatus = false;
const renderPending = () => {
  const count = [...brief].length + (absorbed ? 1 : 0) + (mode === 'wrong-count' ? 7 : 0);
  const id = mode === 'native-mismatch' ? '22222222-2222-4222-8222-222222222222' : nativeId;
  const heading = mode === 'auth' ? '\r\nFIXTURE_AUTH_REQUIRED' : mode === 'permission' ? '\r\nFIXTURE_PERMISSION_REQUIRED' : mode === 'unknown' || mode === 'menu-above-same-footer' ? '\r\nChoose an unknown action\r\nEnter to approve' : '';
  const nativeHeader = header + '\r\nSession: ' + id;
  render(nativeHeader + heading + '\r\n› [Pasted Content ' + count + ' chars]' + (mode === 'stale-ready-menu' ? '\r\nAsk Codex to do anything\r\nChoose an unknown action\r\nEnter to approve' : '') + '\r\n' + footer);
};
const submit = () => {
  enters++;
  if (!absorbed) {
    absorbed = true;
    if (mode !== 'immediate') { renderPending(); return; }
  } else {
    if (mode === 'pending-forever') return;
    if (mode === 'vanished-unknown') { render('Session: ' + nativeId + '\r\nUnknown native transition'); return; }
  }
  writeFileSync(${JSON.stringify(acceptedPath)}, JSON.stringify({ brief, enters }));
  render('Session: ' + nativeId + '\r\n• Working (0s • esc to interrupt)\r\n› ');
};
process.stdin.on('data', data => {
  appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify({ data, pending, absorbed }) + '\n');
  if (!hasStatus) {
    buffer += data;
    if (buffer.includes('/status') && /[\r\n]/.test(buffer)) {
      hasStatus = true;
      buffer = '';
      render(nativeScreen(mode === 'readiness-unknown' ? 'Approve unknown action' : 'Ask Codex to do anything'));
    } else if (buffer.includes('/status')) render(nativeScreen('/status'));
    return;
  }
  if (!pending) {
    buffer += data;
    const end = buffer.indexOf('BRIEF_END');
    if (end < 0) return;
    pending = true;
    renderPending();
    if (/[\r\n]/.test(buffer.slice(end + 'BRIEF_END'.length))) submit();
    return;
  }
  if (/[\r\n]/.test(data)) submit();
});
const watchdog = setTimeout(() => process.exit(91), 20000);
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(f.releasePath)}) || !existsSync(${JSON.stringify(f.exitGatePath)})) return;
  clearInterval(timer); clearTimeout(watchdog);
  process.exit(JSON.parse(readFileSync(${JSON.stringify(f.releasePath)}, 'utf8')).exitCode);
}, 30);
`, { mode: 0o700 });
  const release = async () => {
    await writeFile(f.releasePath, JSON.stringify({ exitCode: 0 }));
    await writeFile(f.exitGatePath, 'exit');
    await eventually(f.session, row => row?.state === 'finished', 'owned synthetic runner finalized');
  };
  const launch = async () => {
    try { return await f.launch(); }
    catch (error) {
      const accepted = await readFile(acceptedPath, 'utf8').catch(() => null);
      const rows = (await readFile(inputLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      t.diagnostic(JSON.stringify({ mode, accepted: accepted !== null, input: rows.map(row => ({ chars: [...row.data].length, pending: row.pending, absorbed: row.absorbed })) }));
      throw error;
    }
  };
  return { ...f, acceptedPath, inputLog, release, launch };
}

for (const mode of ['native-placeholder-replaced', 'race', 'immediate']) {
  test(`[production-codex-delivery-qa] ${mode}: parent handshake follows native acceptance`, async t => {
    const f = await deliveryFixture(t, mode);
    if (mode === 'native-placeholder-replaced') assert.equal([...f.request.brief].length, 6579);
    const started = await f.launch();
    const accepted = JSON.parse(await readFile(f.acceptedPath, 'utf8').catch(() => 'null'));
    assert.ok(accepted, 'parent reported running before native CLI accepted the initial brief');
    assert.equal(accepted.brief, f.request.brief);
    assert.equal(accepted.enters, mode === 'immediate' ? 1 : 2);
    assert.equal(started.identity.runnerSessionId, f.nativeId);
    assert.equal(started.identity.pid, Number(await readFile(f.pidPath, 'utf8')));
    assert.equal(f.session()?.state, 'running');
    assert.equal(f.settings.liveTaskVerified, false);
    await f.release();
  });
}

for (const mode of ['readiness-unknown', 'unknown', 'menu-above-same-footer', 'stale-ready-menu', 'auth', 'permission', 'wrong-count', 'native-mismatch', 'vanished-unknown', 'pending-forever']) {
  test(`[production-codex-delivery-qa] ${mode}: no false handshake or blind submission`, async t => {
    const f = await deliveryFixture(t, mode);
    await assert.rejects(f.launch(), /delivery|accept|submission|identity|screen|protocol/i);
    const accepted = await readFile(f.acceptedPath, 'utf8').catch(() => null);
    assert.equal(accepted, null);
    const rows = (await readFile(f.inputLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (mode === 'readiness-unknown') assert.equal(rows.some(row => row.data.includes('BRIEF_END')), false);
    const retries = rows.filter(row => row.pending && row.absorbed && /[\r\n]/.test(row.data));
    assert.equal(retries.length, ['vanished-unknown', 'pending-forever'].includes(mode) ? 1 : 0);
    assert.notEqual(f.session()?.state, 'reserved');
  });
}
