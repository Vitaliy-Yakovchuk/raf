import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
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
  const tmuxPath = join(binRoot, 'tmux');
  await writeFile(tmuxPath, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const result = spawnSync(${JSON.stringify(realTmuxPath)}, ['-S', ${JSON.stringify(socket)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const store = openStateStore(statePath);
  t.after(async () => {
    await executeCommand({ executable: realTmuxPath, args: ['-S', socket, 'kill-server'] }).catch(() => undefined);
    store.close();
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
  const assignment: AssignmentSnapshot = {
    root,
    changes: [{ id: 'fixture-launch', items: [{ id: '2.1', description: 'Виконати лише synthetic fixture' }] }],
    baselineArchives: [],
  };
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
  await writeFile(taskContextPath, JSON.stringify({ version: 1, parameters: params, assignment, context: taskContext }), { mode: 0o600 });
  const completedPath = join(root, 'completed');
  const cliCalls = join(root, 'openspec-calls.jsonl');
  const openspecPath = join(binRoot, 'openspec');
  await writeFile(openspecPath, `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cliCalls)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'list') console.log(JSON.stringify({ changes: args.includes('--archived') ? [] : [{ name: 'fixture-launch', completedTasks: existsSync(${JSON.stringify(completedPath)}) ? 1 : 0, totalTasks: 1 }] }));
else if (JSON.stringify(args) === JSON.stringify(['instructions', 'apply', '--change', 'fixture-launch', '--json'])) console.log(JSON.stringify({ contextFiles: { proposal: [${JSON.stringify(join(changeRoot, 'proposal.md'))}], specs: [${JSON.stringify(join(specRoot, 'spec.md'))}], tasks: [${JSON.stringify(tasksPath)}] }, tasks: [{ id: '2.1', description: 'Виконати лише synthetic fixture', sourcePath: ${JSON.stringify(tasksPath)}, line: 3, done: existsSync(${JSON.stringify(completedPath)}) }] }));
else { console.error('fixture unsupported request'); process.exitCode = 7; }
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
  return { root, confRoot, home, cwd, tmpRoot, statePath, binRoot, context, store, assignment, params, taskContext, taskContextPath, execute, calls, completedPath, cliCalls, openspecPath, socket, realTmuxPath };
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
  const request: LaunchWrapperRequest = { tmpRoot: f.tmpRoot, runId, address, assignment: f.assignment, statePath: f.statePath, cwd: f.cwd, tmuxSession, selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, brief: `FIXTURE_NARROW_BRIEF\nreport_path=${reportPath}\nBRIEF_END`, readinessTimeoutMs: 5000 };
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
  const launch = () => launchPersistentWrapper(request, { timeoutMs: settings.timeouts.overallMs, workerCommand: { executable: process.execPath, args: ['--input-type=module', '-e', `import { runProductionWorker } from ${JSON.stringify(runtimeUrl)}; process.env.PATH = ${JSON.stringify(f.binRoot + delimiter)} + (process.env.PATH ?? ''); process.env.HOME = ${JSON.stringify(f.home)}; await runProductionWorker();`] } });
  const report = { status: 'succeeded', answer: 'Виконано лише доручену fixture.', changes: [{ id: 'fixture-launch', items: [{ id: '2.1', status: 'succeeded' }] }] };
  return { ...f, runId, address, reportPath, releasePath, exitGatePath, deliveredPath, pidPath, nativeId, settings, request, runtimeLaunch, launch, session, report };
}

test('[production-factory] default factory returns the existing RuntimeServices without launching a runner', async t => {
  const f = await fixture(t);
  const services = await createProductionServices(f.store, configuration, f.context);
  for (const key of ['assignment', 'resolveTask', 'route', 'routingSnapshot', 'selectModel', 'listModels', 'prepareReport', 'reserve', 'adapter', 'verifyStarted', 'commitStarted', 'compensate', 'abortLaunch', 'control', 'authorizeMain']) assert.ok(key in services, key);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listSessions()).length, 0);
  assert.equal(f.store.getRunnerEnabled('codex'), true);
});

test('[production-factory] assignment uses authoritative OpenSpec argv and the configured root', async t => {
  const f = await fixture(t);
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const valid = await services.assignment.validate({ root: f.root, selections: [{ change: 'fixture-launch', items: [{ id: '2.1' }] }] });
  assert.equal(valid.ok, true);
  const invalid = await services.assignment.validate({ root: f.root, selections: [{ change: 'fixture-launch', items: [{ id: '9.9' }] }] });
  assert.equal(invalid.ok, false);
  assert.ok(f.calls.some(c => c.executable === 'openspec' && c.cwd === f.root && JSON.stringify(c.args) === JSON.stringify(['instructions', 'apply', '--change', 'fixture-launch', '--json'])));
  assert.equal(f.calls.some(c => c.executable === 'tmux'), false);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), []);
});

test('[production-factory] compose reuses runner, stage and completion templates with the exact report path', async t => {
  const f = await fixture(t);
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const reportPath = join(f.tmpRoot, 'run-1', `${f.params.id}.json`);
  const brief = await services.assignment.compose(f.assignment, { briefsRoot: join(f.confRoot, 'briefs'), runner: 'codex', stage: 'implement', project: 'raf', agentId: f.params.id, sessionName: f.params.id, features: f.params.features, phase: 'implement', ...f.taskContext, reportPath });
  for (const part of ['FIXTURE_CODEX_RUNNER', 'FIXTURE_IMPLEMENT_STAGE', 'FIXTURE_COMPLETION', reportPath, '2.1', 'fixture.txt']) assert.ok(brief.includes(part), part);
});

test('[production-factory] route uses configured project and actual Git branch', async t => {
  const f = await fixture(t);
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const routed = await services.route({ root: f.root, project: 'raf', branch: 'develop' });
  assert.equal(routed.ok, true);
  if (routed.ok) assert.equal(routed.cwd, f.cwd);
  const invalid = await services.route({ root: f.root, project: 'raf', branch: 'main' });
  assert.equal(invalid.ok, false);
});

test('[production-factory] task context binds exact parameters and assignment instead of inventing sources or resources', async t => {
  const f = await fixture(t);
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  assert.deepEqual(await services.resolveTask(f.params, f.assignment), f.taskContext);
  await assert.rejects(services.resolveTask({ ...f.params, tasks: ['fixture-launch:9.9'] }, f.assignment), /context|дорученн|mismatch/i);
  await assert.rejects(services.resolveTask(f.params, { ...f.assignment, changes: [{ id: 'fixture-launch', items: [{ id: '2.1', description: 'Змінений зміст' }] }] }), /context|дорученн|mismatch/i);
  await rm(f.taskContextPath);
  await assert.rejects(services.resolveTask(f.params, f.assignment), /context|контекст/i);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
});

test('[production-factory] explicit context path is internal and incomplete context fails before any process', async t => {
  const f = await fixture(t);
  const explicitPath = join(f.root, 'explicit-context.json');
  await writeFile(explicitPath, JSON.stringify({ version: 1, parameters: f.params, assignment: f.assignment, context: { ...f.taskContext, sources: [], requested: null } }));
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute, taskContextPath: explicitPath });
  await assert.rejects(services.resolveTask(f.params, f.assignment), /context|sources|resource|контекст/i);
  assert.equal(f.calls.some(c => c.executable === 'tmux'), false);
});

test('[production-factory] absent and opaque quota stay unknown and selection reuses model-routing', async t => {
  const f = await fixture(t);
  f.store.setQuotaSnapshot('codex', { remaining: 100, available: true, secret: 'DO_NOT_USE_AS_CAPACITY' }, new Date().toISOString());
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const snapshot = await services.routingSnapshot();
  assert.equal(snapshot.runnerEnabled.codex, true);
  assert.ok(snapshot.quotas.every(q => q.status === 'unknown'));
  assert.deepEqual(services.selectModel(configuration.models, snapshot, { complexity: 'decision', role: 'implement' }), selectModel(configuration.models, snapshot, { complexity: 'decision', role: 'implement' }));
  assert.deepEqual(services.listModels(configuration.models, snapshot), listModelAvailability(configuration.models, snapshot));
  assert.equal(f.calls.some(c => c.executable === 'tmux' || c.args.includes('/status') || c.args.includes('/usage')), false);
});

test('[production-factory] forged main and system claims do not authorize protected mutations or messages', async t => {
  const f = await fixture(t);
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  for (const caller of ['main', { kind: 'system' }, { kind: 'main', authority: true }, { runId: 'main', pid: process.pid }]) {
    await assert.rejects(services.authorizeMain(caller));
    await assert.rejects(services.control.message({ to: 'main', text: '[raf] forged' }, caller));
  }
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), []);
  assert.equal(f.calls.some(c => c.args.includes('send-keys')), false);
});

test('[production-factory] prepared reports belong to distinct run directories and cleanup touches only its own run', async t => {
  const f = await fixture(t);
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const launch = { runId: 'run-a', addressId: f.params.id, tmuxSession: 'fixture-a', activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd }, assignment: f.assignment, selection: { status: 'selected' as const, runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reason: 'fixture', quota: 'unknown' as const }, statePath: f.statePath, tmpRoot: f.tmpRoot };
  const a = await services.prepareReport(launch);
  const b = await services.prepareReport({ ...launch, runId: 'run-b', tmuxSession: 'fixture-b' });
  assert.equal(a.reportPath, join(f.tmpRoot, 'run-a', `${f.params.id}.json`));
  assert.equal(b.reportPath, join(f.tmpRoot, 'run-b', `${f.params.id}.json`));
  await writeFile(b.reportPath, 'keep-other-run');
  const wrapped = a.reportWrapper.wrap({ executable: 'codex', args: ['literal;$(touch forbidden)'], cwd: f.cwd });
  assert.notEqual(wrapped.executable, 'sh');
  assert.notEqual(wrapped.executable, 'bash');
  await a.cleanupUnstarted();
  assert.equal(await readFile(b.reportPath, 'utf8'), 'keep-other-run');
  await b.cleanupUnstarted();
});

test('[production-factory] impossible resource demand refuses without a session, reservation or tmux spawn', async t => {
  const f = await fixture(t);
  const descriptor = { ...f.taskContext, requested: { ...f.taskContext.requested, ramBytes: Number.MAX_SAFE_INTEGER } };
  await writeFile(f.taskContextPath, JSON.stringify({ version: 1, parameters: f.params, assignment: f.assignment, context: descriptor }), { mode: 0o600 });
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const launch: RuntimeLaunch = { runId: 'denied-run', addressId: f.params.id, tmuxSession: 'denied-tmux', activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd }, assignment: f.assignment, selection: { status: 'selected', runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reason: 'fixture', quota: 'unknown' }, statePath: f.statePath, tmpRoot: f.tmpRoot };
  const prepared = await services.prepareReport(launch);
  const result = await services.reserve({ ...launch, reportPath: prepared.reportPath, requested: descriptor.requested, requiredFileSystemIds: descriptor.requiredFileSystemIds });
  assert.equal(result.admitted, false);
  if (!result.admitted) assert.ok(result.reason.length > 0);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  assert.deepEqual(listTaskReservations(f.store), []);
  assert.equal(f.calls.some(c => c.args.includes('new-session')), false);
});

test('[production-factory] unknown process scan does not release an existing owner or report it as live', async t => {
  const f = await fixture(t);
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => false });
  state.reserveLaunch(f.params.id, 'scan-run', { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd }, { resource: 'fixture', amount: 1 });
  state.commitStarted('scan-run', { pid: process.pid, startedAt: 'unverified-fixture-start', runner: 'codex', runnerSessionId: 'fixture', tmuxSession: 'missing-fixture-pane', evidence: { runId: 'scan-run', command: process.execPath } });
  const execute: AdapterCommandExecutor = async command => command.executable === 'ps' || command.executable === 'tmux' ? { exitCode: 9, stdout: '', stderr: 'fixture scan unavailable' } : f.execute(command);
  const services = await createProductionServices(f.store, configuration, f.context, { execute });
  await assert.rejects(services.control.ps(), /scan|unknown|inspect|process|перевір/i);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
});

test('[production-launch] default service composition starts the persistent worker and survives the command process exit', async t => {
  const f = await workerFixture(t, false);
  assert.equal(f.session(), undefined);
  assert.deepEqual(listTaskReservations(f.store), []);
  const scriptPath = join(f.root, 'launch-command.mjs');
  const storeUrl = new URL('../src/state-store.ts', import.meta.url).href;
  await writeFile(scriptPath, `import { createProductionServices } from ${JSON.stringify(runtimeUrl)};
import { openStateStore } from ${JSON.stringify(storeUrl)};
import { readFile, writeFile } from 'node:fs/promises';
const raf = JSON.parse(await readFile(${JSON.stringify(join(f.confRoot, 'raf.json'))}, 'utf8'));
const configuration = { catalog: JSON.parse(await readFile(${JSON.stringify(f.context.artifactPath)}, 'utf8')), models: JSON.parse(await readFile(${JSON.stringify(join(f.confRoot, 'models.json'))}, 'utf8')), commandTiming: raf.commandTiming };
const store = openStateStore(${JSON.stringify(f.statePath)});
const context = { ...${JSON.stringify(f.context)}, resolveCaller: async () => undefined };
const services = await createProductionServices(store, configuration, context);
const validation = await services.assignment.validate({ root: context.orchestratorRoot, selections: [{ change: 'fixture-launch', items: [{ id: '2.1' }] }] });
if (!validation.ok) throw new Error(JSON.stringify(validation));
const descriptor = await services.resolveTask(${JSON.stringify(f.params)}, validation.snapshot);
const route = await services.route({ root: context.orchestratorRoot, project: 'raf', branch: descriptor.branch });
if (!route.ok) throw new Error(JSON.stringify(route));
const snapshot = await services.routingSnapshot();
const selection = services.selectModel(configuration.models, snapshot, { complexity: 'decision', role: 'implement' });
if (selection.status !== 'selected') throw new Error(JSON.stringify(selection));
const launch = { ...${JSON.stringify(f.runtimeLaunch)}, assignment: validation.snapshot, selection, activity: { ...${JSON.stringify(f.runtimeLaunch.activity)}, cwd: route.cwd } };
const prepared = await services.prepareReport(launch);
const reservation = await services.reserve({ ...launch, reportPath: prepared.reportPath, requested: descriptor.requested, requiredFileSystemIds: descriptor.requiredFileSystemIds });
if (!reservation.admitted) throw new Error(reservation.reason);
const reserved = store.sessionRepository.transaction(tx => tx.getSession(launch.runId));
if (!reserved?.launchContext) throw new Error('Missing durable launch context');
await writeFile(reserved.launchContext.briefPath, ${JSON.stringify(f.request.brief)});
const session = await services.adapter.start({ selection, tmuxSession: launch.tmuxSession, cwd: route.cwd, brief: ${JSON.stringify(f.request.brief)}, reportWrapper: prepared.reportWrapper });
const identity = await services.verifyStarted(launch, session);
if (!await services.commitStarted(launch.runId, identity)) throw new Error('commitStarted was not confirmed');
store.close();
console.log(JSON.stringify({ identity, reportPath: prepared.reportPath, selection }));
`);
  const command = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 12000, env: { ...process.env, PATH: f.binRoot + delimiter + (process.env.PATH ?? ''), HOME: f.home } });
  assert.equal(command.status, 0, `${command.error ?? ''}\n${command.stderr}\n${command.stdout}`);
  const started = JSON.parse(command.stdout.trim());
  assert.equal(started.identity.pid, Number(await readFile(f.pidPath, 'utf8')));
  assert.equal(started.identity.runnerSessionId, f.nativeId);
  assert.equal(started.reportPath, f.reportPath);
  assert.equal(started.selection.model, 'gpt-6.1-sol');
  assert.equal(started.selection.effort, 'high');
  assert.equal(started.selection.quota, 'unknown');
  assert.equal(f.session()?.state, 'running');
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  const claims = listTaskReservations(f.store);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].lease.owner.runId, f.runId);
  assert.ok(claims[0].lease.owner.fence.length > 0);
  await writeFile(f.completedPath, 'done');
  await writeFile(f.releasePath, JSON.stringify({ report: f.report, exitCode: 17 }));
  const accepted = await eventually(f.session, row => row?.state === 'running' && row.result?.status === 'succeeded', 'report accepted while the runner is held alive');
  assert.equal(accepted?.result?.response, f.report.answer);
  assert.deepEqual(JSON.parse(await readFile(f.reportPath, 'utf8')), f.report);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  await writeFile(f.exitGatePath, 'exit');
  const done = await eventually(f.session, row => row?.state === 'finished', 'report accepted after command process exit');
  assert.equal(done?.result?.status, 'succeeded');
  assert.equal(done?.result?.response, '');
  assert.equal(done?.result?.proof, null);
  assert.equal(done?.launchContext, undefined);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listSessions()).length, 1);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  assert.deepEqual(listTaskReservations(f.store), []);
});

test('[production-worker] persistent child commits the actual native process before returning the handshake', async t => {
  const f = await workerFixture(t);
  const started = await f.launch();
  const agentPid = Number(await readFile(f.pidPath, 'utf8'));
  assert.equal(started.identity.pid, agentPid);
  assert.notEqual(started.identity.pid, started.wrapperPid);
  assert.notEqual(started.wrapperPid, process.pid);
  assert.equal(started.identity.runnerSessionId, f.nativeId);
  assert.equal(started.identity.evidence.runId, f.runId);
  assert.equal(started.reportPath, f.reportPath);
  assert.equal(f.session()?.state, 'running');
  assert.equal(f.session()?.process?.pid, agentPid);
  await eventually(() => readFile(f.deliveredPath, 'utf8').catch(() => ''), text => text.includes('BRIEF_END'), 'brief delivered to synthetic runner');
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const live = await services.control.ps();
  assert.ok(live.some(row => row.runId === f.runId && row.process?.pid === agentPid));
  await writeFile(f.completedPath, 'done');
  await writeFile(f.releasePath, JSON.stringify({ report: f.report, exitCode: 17 }));
  const accepted = await eventually(f.session, row => row?.state === 'running' && row.result?.status === 'succeeded', 'verified report accepted before process exit');
  assert.equal(accepted?.result?.response, f.report.answer);
  assert.deepEqual(JSON.parse(await readFile(f.reportPath, 'utf8')), f.report);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  await writeFile(f.exitGatePath, 'exit');
  const done = await eventually(f.session, row => row?.state === 'finished', 'worker finalizes after the runner exits');
  assert.equal(done?.result?.status, 'succeeded');
  assert.equal(done?.result?.response, '');
  assert.equal(done?.result?.proof, null);
  assert.equal(done?.launchContext, undefined);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  assert.deepEqual(listTaskReservations(f.store), []);
  const calls = (await readFile(f.cliCalls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(c => c.cwd === f.root && c.args[0] === 'instructions'));
});

test('[production-worker] unconfirmed OpenSpec success becomes failed after exit and never auto-resumes', async t => {
  const f = await workerFixture(t);
  await f.launch();
  await writeFile(f.releasePath, JSON.stringify({ report: f.report, exitCode: 17 }));
  await writeFile(f.exitGatePath, 'exit');
  const done = await eventually(f.session, row => row?.state === 'finished', 'unconfirmed result finalization');
  assert.equal(done?.result?.status, 'failed');
  const sessions = f.store.sessionRepository.transaction(tx => tx.listSessions());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].runId, f.runId);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  assert.deepEqual(listTaskReservations(f.store), []);
});

test('[production-worker] crash without a report records failed in the same SQLite and does not launch a replacement', async t => {
  const f = await workerFixture(t);
  const started = await f.launch();
  await writeFile(f.releasePath, JSON.stringify({ exitCode: 23 }));
  await writeFile(f.exitGatePath, 'exit');
  const done = await eventually(f.session, row => row?.state === 'finished', 'crash finalization');
  assert.equal(done?.result?.status, 'failed');
  assert.equal(done?.process?.pid, started.identity.pid);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listSessions()).length, 1);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  assert.deepEqual(listTaskReservations(f.store), []);
});
