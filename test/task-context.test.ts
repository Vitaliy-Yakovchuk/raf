import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, stat, access } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAppRuntime, type RuntimeConfiguration, type RuntimeContext, type RuntimeRunParameters, type RuntimeServices, type RuntimeTaskContext } from '../src/app-runtime.ts';
import { createProductionServices } from '../src/production-runtime.ts';
import { compileCatalog } from '../src/catalog.ts';
import { failureContext } from '../src/cli-contract.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';
import { createAgentReportWatcher, type AgentReportExit, type AgentReportResult } from '../src/agent-report.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { AssignmentSnapshot } from '../src/assignment.ts';
import type { ModelCatalog, ModelSelection } from '../src/model-routing.ts';
import {
  assignmentFingerprint, bindWorkspaceBoundaries, deriveTaskContext, rafCommandFor, rafSubcommandsFor, loadTaskContextConfiguration, writeTaskContextFile,
  TASK_CONTEXT_FILE_NAME, type TaskContextConfiguration, type TaskContextEnvelope,
} from '../src/task-context.ts';

const realConf = new URL('../../conf/', import.meta.url);
const constants = JSON.parse(readFileSync(new URL('raf-constants.json', realConf), 'utf8'));
const models: ModelCatalog = JSON.parse(readFileSync(new URL('models.json', realConf), 'utf8'));
const realProjects = JSON.parse(readFileSync(new URL('projects.json', realConf), 'utf8'));
const realFlow = readFileSync(new URL('flow.json', realConf), 'utf8');
const flowResources = JSON.parse(realFlow).resources;
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), realProjects);
const estimateReason = /оцінка резерву не налаштована/;

const descriptions = {
  a11: 'Вивести контекст за conf/flow.json. Перевірка: node --test test/a.test.ts дає код 0.',
  a12: 'Друге завдання зміни A. Перевірка: ручний огляд звіту.',
  b11: 'Завдання зміни B з тим самим номером. Перевірка: інший доказ для B.',
  c11: 'Прочитати conf/missing-source.json перед роботою. Перевірка: файл прочитано.',
};

const changes: Record<string, { tasksMd: string; items: { id: string; description: string }[] }> = {
  'change-a': {
    tasksMd: `## Джерела за етапом\n\n- 1.1: openspec/specs/core/demo/spec.md — демо-вимога для 1.1.\n- 1.2: conf/stage-only-for-a12.json — джерело лише для 1.2.\n\n## 1. Робота\n\n- [ ] 1.1 ${descriptions.a11}\n- [ ] 1.2 ${descriptions.a12}\n`,
    items: [{ id: '1.1', description: descriptions.a11 }, { id: '1.2', description: descriptions.a12 }],
  },
  'change-b': {
    tasksMd: `## 1. Робота\n\n- [ ] 1.1 ${descriptions.b11}\n`,
    items: [{ id: '1.1', description: descriptions.b11 }],
  },
  'change-c': {
    tasksMd: `## 1. Робота\n\n- [ ] 1.1 ${descriptions.c11}\n`,
    items: [{ id: '1.1', description: descriptions.c11 }],
  },
};

const baseParams: RuntimeRunParameters = { id: 'worker', type: 'implement', project: 'raf', features: ['agent-run'], phase: 'implement', complexity: models.routing.complexityOrder[0], tasks: ['change-a:1.1'] };

function snapshotFor(root: string, tasks: readonly string[]): AssignmentSnapshot {
  const grouped = new Map<string, { id: string; description: string }[]>();
  for (const task of tasks) {
    const [change, item] = task.split(':');
    const found = changes[change].items.find(row => row.id === item)!;
    grouped.set(change, [...(grouped.get(change) ?? []), { ...found }]);
  }
  return { root, changes: [...grouped].map(([id, items]) => ({ id, items })), baselineArchives: [] };
}

function failureText(error: unknown): string {
  return `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(failureContext(error) ?? {})}`;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

const normalize = (root: string, path: string) => resolve(root, path).replace(/\/+$/, '');
const sourcePath = (line: string) => line.split(' — ')[0];

async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-task-context-'));
  const home = join(root, 'home');
  const confRoot = join(root, 'conf');
  const tmpRoot = join(home, '.raf', 'tmp');
  const statePath = join(home, '.raf', 'state.sqlite');
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([mkdir(confRoot, { recursive: true }), mkdir(tmpRoot, { recursive: true, mode: 0o700 }), mkdir(join(root, 'raf-develop')), mkdir(join(root, 'raf-main')), mkdir(join(root, 'solo-develop'))]);
  const projects = {
    version: 1, profiles: realProjects.profiles, layout: realProjects.layout,
    projects: {
      raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' }, usesSharedLibs: false },
      solo: { path: 'solo-develop', profile: 'raf', branchPaths: { develop: 'solo-develop' }, usesSharedLibs: false },
      orchestrator: { path: '.', profile: 'orchestrator' },
    },
  };
  await Promise.all([
    writeFile(join(confRoot, 'projects.json'), JSON.stringify(projects)),
    writeFile(join(confRoot, 'raf-constants.json'), JSON.stringify(constants)),
    writeFile(join(confRoot, 'flow.json'), realFlow),
    writeFile(join(confRoot, 'stage-only-for-a12.json'), '{}'),
  ]);
  await Promise.all([mkdir(join(confRoot, 'briefs', 'runners'), { recursive: true }), mkdir(join(confRoot, 'briefs', 'tasks'), { recursive: true })]);
  await Promise.all([
    writeFile(join(confRoot, 'briefs', 'runners', 'codex.md'), 'FIXTURE_RUNNER'),
    writeFile(join(confRoot, 'briefs', 'tasks', 'implement.md'), 'FIXTURE_STAGE'),
    writeFile(join(confRoot, 'briefs', 'completion.md'), 'FIXTURE_COMPLETION'),
  ]);
  const writeChange = async (change: string, extra: Record<string, string>) => {
    const changeRoot = join(root, 'openspec', 'changes', change);
    await mkdir(join(changeRoot, 'specs', 'projects', 'raf', change), { recursive: true });
    await Promise.all([
      writeFile(join(changeRoot, 'tasks.md'), changes[change].tasksMd),
      writeFile(join(changeRoot, 'proposal.md'), `# ${change}\n`),
      writeFile(join(changeRoot, 'design.md'), `# ${change} design\n`),
      writeFile(join(changeRoot, 'specs', 'projects', 'raf', change, 'spec.md'), '## ADDED Requirements\n'),
      ...Object.entries(extra).map(([name, content]) => writeFile(join(changeRoot, name), content)),
    ]);
  };
  await writeChange('change-a', { 'extra-design.md': '# extra\n', 'notes.md': 'не джерело\n' });
  await writeChange('change-b', {});
  await writeChange('change-c', {});
  await mkdir(join(root, 'openspec', 'specs', 'core', 'demo'), { recursive: true });
  await writeFile(join(root, 'openspec', 'specs', 'core', 'demo', 'spec.md'), '# demo\n');
  await mkdir(join(root, 'questions', 'projects', 'raf'), { recursive: true });
  await writeFile(join(root, 'questions', 'projects', 'raf', 'questions.md'), '# Питання\n');
  const configuration: TaskContextConfiguration = { projects, reportStatuses: constants.reportStatuses, resources: structuredClone(flowResources) };
  return { root, home, confRoot, tmpRoot, statePath, configuration };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

function fakeOpenSpec(args: readonly string[]) {
  const json = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });
  if (args[0] === 'list' && args.includes('--archived')) return json({ changes: [] });
  if (args[0] === 'list') return json({ changes: Object.entries(changes).map(([name, change]) => ({ name, completedTasks: 0, totalTasks: change.items.length })) });
  if (args[0] === 'instructions' && args[1] === 'apply') {
    const change = changes[args[args.indexOf('--change') + 1]];
    if (!change) return { exitCode: 1, stdout: '', stderr: 'unknown change' };
    return json({ tasks: change.items.map((item, index) => ({ id: String(index + 1), description: `${item.id} ${item.description}`, done: false })) });
  }
  return { exitCode: 2, stdout: '', stderr: `unexpected openspec ${args.join(' ')}` };
}

async function harness(t: TestContext, w: Workspace, override: (services: RuntimeServices) => RuntimeServices = services => services) {
  const calls: AdapterCommand[] = [];
  const execute: AdapterCommandExecutor = async command => {
    calls.push(structuredClone(command));
    if (command.executable === 'openspec') return fakeOpenSpec(command.args);
    if (command.executable === 'git') return { exitCode: 0, stdout: `${(command.cwd ?? '').endsWith('-main') ? 'main' : 'develop'}\n`, stderr: '' };
    throw new Error(`Forbidden executable in unit fixture: ${command.executable}`);
  };
  let store: StateStore | undefined;
  const context: RuntimeContext = { orchestratorRoot: w.root, confRoot: w.confRoot, artifactPath: join(w.root, 'catalog.json'), statePath: w.statePath, tmpRoot: w.tmpRoot, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined };
  const configuration: RuntimeConfiguration = { catalog, models, commandTiming: { emaAlpha: 0.1 } };
  const runtime = createAppRuntime(context, {
    loadConfiguration: async () => configuration,
    openStore: async path => (store = openStateStore(path)),
    createServices: async (opened, config, ctx) => override(await createProductionServices(opened, config, ctx, { execute })),
    nextRunIdentity: () => ({ runId: randomUUID(), tmuxSession: randomUUID() }),
    now: () => Date.now(),
  });
  t.after(() => runtime.close());
  const run = (params: RuntimeRunParameters) => Promise.resolve(runtime.handlers['agent run']({ ...params } as unknown as Record<string, unknown>));
  const durable = () => store ? store.sessionRepository.transaction(tx => ({ sessions: tx.listSessions(), reservations: tx.listReservations() })) : { sessions: [], reservations: [] };
  const runDirectories = async () => (await readdir(w.tmpRoot)).filter(name => name !== 'task-context');
  return { calls, run, durable, runDirectories };
}

const fixtureSelection: ModelSelection = { status: 'selected', runner: 'codex', model: 'fixture-model', effort: 'fixture-effort', reason: 'fixture', quota: 'unknown' };

type ReserveInput = Parameters<RuntimeServices['reserve']>[0];

function refusingReserve(seen: ReserveInput[]) {
  return (services: RuntimeServices): RuntimeServices => ({
    ...services,
    routingSnapshot: async () => ({ runnerEnabled: { codex: true }, cliAvailable: { codex: true }, quotas: [] }),
    selectModel: () => fixtureSelection,
    reserve: async input => { seen.push(structuredClone(input)); return { admitted: false, reason: 'fixture admission refused' }; },
  });
}

async function writeFlowResources(w: Workspace, resources: unknown) {
  const flow = JSON.parse(realFlow);
  if (resources === undefined) delete flow.resources; else flow.resources = resources;
  await writeFile(join(w.confRoot, 'flow.json'), JSON.stringify(flow));
}

test('[task-context] 1. agent run без файла task-context/<id>.json виводить контекст і оцінку з порогів рівня', async t => {
  const w = await workspace(t);
  assert.equal(await exists(join(w.tmpRoot, 'task-context', `${baseParams.id}.json`)), false);
  const seen: ReserveInput[] = [];
  const h = await harness(t, w, refusingReserve(seen));
  const failure = await h.run(baseParams).then(() => undefined, error => error);
  assert.ok(failure, 'фікстура відмовляє в допуску, тож запуск не стартує');
  const text = failureText(failure);
  assert.doesNotMatch(text, /TASK_CONTEXT_UNAVAILABLE|TASK_CONTEXT_MISMATCH/);
  assert.doesNotMatch(text, estimateReason);
  assert.match(text, /fixture admission refused/);
  assert.equal(seen.length, 1, 'запуск має дійти до резервування');
  assert.equal(seen[0].requested.ramBytes, flowResources.normal.minRamBytes);
  for (const id of seen[0].requiredFileSystemIds) assert.equal(seen[0].requested.diskBytes[id], flowResources.normal.minDiskBytes, id);
  for (const value of Object.values(seen[0].requested.diskBytes)) assert.equal(value, flowResources.normal.minDiskBytes);
  assert.equal(h.calls.some(call => call.executable === 'tmux'), false);
  const derived = await deriveTaskContext({ root: w.root, parameters: baseParams, assignment: snapshotFor(w.root, baseParams.tasks), configuration: w.configuration });
  assert.equal(derived.branch, 'develop');
  assert.equal(derived.outcome, `change-a:1.1 — ${descriptions.a11}`);
  assert.deepEqual(derived.estimate, { status: 'KNOWN', tier: 'normal', ramBytes: flowResources.normal.minRamBytes, diskBytesPerFileSystem: flowResources.normal.minDiskBytes, source: 'conf/flow.json#/resources/normal' });
  const derive = (parameters: Partial<RuntimeRunParameters>) => deriveTaskContext({ root: w.root, parameters: { ...baseParams, ...parameters }, assignment: snapshotFor(w.root, baseParams.tasks), configuration: w.configuration });
  const qa = await derive({ type: 'qa', phase: 'qa' });
  assert.equal(qa.estimate.status === 'KNOWN' && qa.estimate.tier, 'normal');
  const hotfix = await derive({ type: 'hotfix' });
  assert.deepEqual(hotfix.estimate, { status: 'KNOWN', tier: 'hotfix', ramBytes: flowResources.hotfix.minRamBytes, diskBytesPerFileSystem: flowResources.hotfix.minDiskBytes, source: 'conf/flow.json#/resources/hotfix' });
});

test('[task-context] 2. старий чужий task-context/<id>.json ігнорується', async t => {
  const w = await workspace(t);
  const legacy = join(w.tmpRoot, 'task-context', `${baseParams.id}.json`);
  await mkdir(dirname(legacy), { mode: 0o700 });
  const foreign = { version: 1, parameters: baseParams, assignment: snapshotFor(w.root, baseParams.tasks), context: {
    branch: 'main', outcome: 'FOREIGN_OUTCOME', writeBoundaries: ['/FOREIGN_BOUNDARY'], sources: ['FOREIGN_SOURCE — чуже; завжди'],
    requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [], reportSchema: { type: 'object', foreign: true },
  } };
  await writeFile(legacy, JSON.stringify(foreign), { mode: 0o600 });
  const seen: ReserveInput[] = [];
  const h = await harness(t, w, refusingReserve(seen));
  const failure = await h.run(baseParams).then(() => undefined, error => error);
  assert.ok(failure);
  const text = failureText(failure);
  assert.doesNotMatch(text, /FOREIGN|TASK_CONTEXT_MISMATCH|TASK_CONTEXT_UNAVAILABLE/);
  assert.match(text, /fixture admission refused/);
  assert.equal(seen.length, 1);
  assert.doesNotMatch(JSON.stringify(seen[0]), /FOREIGN/);
  assert.notEqual(seen[0].requested.ramBytes, foreign.context.requested.ramBytes);
  assert.equal(h.calls.some(call => call.executable === 'tmux'), false);
  const derived = await deriveTaskContext({ root: w.root, parameters: baseParams, assignment: snapshotFor(w.root, baseParams.tasks), configuration: w.configuration });
  assert.doesNotMatch(JSON.stringify(derived), /FOREIGN/);
  assert.equal(derived.branch, 'develop');
});

test('[task-context] 3. гілка: implement і qa → develop, hotfix → main, відсутній ключ → UNKNOWN_BRANCH без підстановки', async t => {
  const w = await workspace(t);
  const derive = (parameters: Partial<RuntimeRunParameters>) => deriveTaskContext({ root: w.root, parameters: { ...baseParams, ...parameters }, assignment: snapshotFor(w.root, baseParams.tasks), configuration: w.configuration });
  assert.equal((await derive({ type: 'implement' })).branch, 'develop');
  assert.equal((await derive({ type: 'qa', phase: 'qa' })).branch, 'develop');
  assert.equal((await derive({ type: 'hotfix' })).branch, 'main');
  await assert.rejects(derive({ type: 'hotfix', project: 'solo' }), error => /UNKNOWN_BRANCH/.test(failureText(error)));
  await assert.rejects(derive({ type: 'implement', project: 'orchestrator' }), error => /UNKNOWN_BRANCH/.test(failureText(error)));
});

test('[task-context] 4. outcome зберігає зміна:пункт і дослівні описи для однакових номерів у порядку --tasks', async t => {
  const w = await workspace(t);
  const tasks = ['change-a:1.1', 'change-b:1.1', 'change-a:1.2'];
  const derived = await deriveTaskContext({ root: w.root, parameters: { ...baseParams, tasks }, assignment: snapshotFor(w.root, tasks), configuration: w.configuration });
  assert.deepEqual(derived.outcome.split('\n'), [
    `change-a:1.1 — ${descriptions.a11}`,
    `change-b:1.1 — ${descriptions.b11}`,
    `change-a:1.2 — ${descriptions.a12}`,
  ]);
  assert.ok(derived.outcome.includes('Перевірка: інший доказ для B.'));
});

test('[task-context] 5. межі запису: spec без cwd коду, implement із cwd; каталоги змін і файл питань', async t => {
  const w = await workspace(t);
  const tasks = ['change-a:1.1', 'change-b:1.1'];
  const cwd = join(w.root, 'raf-develop');
  const expected = [join(w.root, 'openspec', 'changes', 'change-a'), join(w.root, 'openspec', 'changes', 'change-b'), join(w.root, 'questions', 'projects', 'raf', 'questions.md')];
  const spec = await deriveTaskContext({ root: w.root, parameters: { ...baseParams, type: 'spec', phase: 'spec', tasks }, assignment: snapshotFor(w.root, tasks), configuration: w.configuration });
  const specBound = bindWorkspaceBoundaries(spec, cwd).map(path => normalize(w.root, path));
  assert.equal(spec.workspaceWritable, false);
  for (const path of expected) assert.ok(specBound.includes(path), path);
  assert.equal(specBound.includes(cwd), false);
  assert.equal(specBound.some(path => path.startsWith(cwd + '/')), false);
  const implement = await deriveTaskContext({ root: w.root, parameters: { ...baseParams, tasks }, assignment: snapshotFor(w.root, tasks), configuration: w.configuration });
  const implementBound = bindWorkspaceBoundaries(implement, cwd).map(path => normalize(w.root, path));
  assert.equal(implement.workspaceWritable, true);
  for (const path of [...expected, cwd]) assert.ok(implementBound.includes(path), path);
  assert.equal(implementBound.includes(w.root), false);
});

test('[task-context] 5a. координувальні типи отримують точну команду raf цієї гілки raf, виконавці — лише для agent message і agent ps; межі запису не містять стану raf', async t => {
  const w = await workspace(t);
  const entry = realpathSync(fileURLToPath(new URL('../bin/raf.ts', import.meta.url)));
  for (const type of ['coordinator', 'main']) assert.equal(rafCommandFor(), `node ${entry}`, type);
  for (const type of ['coordinator', 'main']) assert.equal(rafSubcommandsFor(type), null, type);
  for (const type of ['implement', 'hotfix', 'spec', 'design', 'test-scaffold', 'qa']) {
    assert.equal(rafCommandFor(), `node ${entry}`, type);
    assert.deepEqual(rafSubcommandsFor(type), ['agent message', 'agent ps'], type);
  }
  const tasks = ['change-a:1.1'];
  const coordinator = await deriveTaskContext({ root: w.root, parameters: { ...baseParams, type: 'coordinator', phase: 'coordinator', tasks }, assignment: snapshotFor(w.root, tasks), configuration: w.configuration });
  assert.equal(bindWorkspaceBoundaries(coordinator, join(w.root, 'raf-develop')).some(path => path.includes('.raf')), false);
});

test('[task-context] 6. sources: файли зміни, шлях із пункту, «Джерела за етапом»; неіснуючий шлях до каталогу запуску', async t => {
  const w = await workspace(t);
  const missing = { ...baseParams, tasks: ['change-c:1.1'] };
  const h = await harness(t, w);
  await assert.rejects(h.run(missing), error => failureText(error).includes('conf/missing-source.json'));
  assert.deepEqual(await h.runDirectories(), []);
  assert.equal(h.calls.some(call => call.executable === 'tmux'), false);
  await assert.rejects(deriveTaskContext({ root: w.root, parameters: missing, assignment: snapshotFor(w.root, missing.tasks), configuration: w.configuration }), error => failureText(error).includes('conf/missing-source.json'));
  const derived = await deriveTaskContext({ root: w.root, parameters: baseParams, assignment: snapshotFor(w.root, baseParams.tasks), configuration: w.configuration });
  for (const line of derived.sources) assert.match(line, /^\S+ — .+; .+$/, line);
  const paths = derived.sources.map(line => normalize(w.root, sourcePath(line)));
  const change = join(w.root, 'openspec', 'changes', 'change-a');
  for (const path of [join(change, 'proposal.md'), join(change, 'design.md'), join(change, 'extra-design.md'), join(change, 'specs', 'projects', 'raf', 'change-a', 'spec.md'), join(w.root, 'conf', 'flow.json'), join(w.root, 'openspec', 'specs', 'core', 'demo', 'spec.md')]) assert.ok(paths.includes(path), path);
  assert.equal(paths.includes(join(change, 'notes.md')), false);
  assert.equal(paths.includes(join(w.root, 'conf', 'stage-only-for-a12.json')), false);
});

test('[task-context] 7. reportSchema будується з reportStatuses conf без зміни коду', async t => {
  const w = await workspace(t);
  const derive = (configuration: TaskContextConfiguration) => deriveTaskContext({ root: w.root, parameters: baseParams, assignment: snapshotFor(w.root, baseParams.tasks), configuration });
  const fromConf = await loadTaskContextConfiguration(w.confRoot);
  const schema = (await derive(fromConf)).reportSchema;
  const ids = constants.reportStatuses.map((status: { id: string }) => status.id);
  assert.deepEqual(schema.properties.status.enum, ids);
  for (const field of ['status', 'answer', 'changes']) assert.ok(schema.required.includes(field), field);
  assert.equal('assignments' in schema.properties, false);
  const change = schema.properties.changes.items;
  for (const field of ['id', 'items']) assert.ok(change.required.includes(field), field);
  assert.equal(change.required.includes('archive'), false);
  assert.equal(change.properties.archive.type, 'string');
  const item = change.properties.items.items;
  for (const field of ['id', 'status']) assert.ok(item.required.includes(field), field);
  assert.equal(item.required.includes('reason'), false);
  assert.deepEqual(item.properties.status.enum, ids);
  assert.equal(schema.additionalProperties, true);
  await writeFile(join(w.confRoot, 'raf-constants.json'), JSON.stringify({ ...constants, reportStatuses: [...constants.reportStatuses, { id: 'fixture-status', description: 'Фікстура', event: 'agent.failed' }] }));
  const changed = (await derive(await loadTaskContextConfiguration(w.confRoot))).reportSchema;
  assert.deepEqual(changed.properties.status.enum, [...ids, 'fixture-status']);
  assert.deepEqual(changed.properties.changes.items.properties.items.items.properties.status.enum, [...ids, 'fixture-status']);
});

const brokenThresholds: { name: string; tier: 'normal' | 'hotfix'; pointer: string; resources: () => unknown }[] = [
  { name: 'без resources', tier: 'normal', pointer: '/resources', resources: () => undefined },
  { name: 'без рівня normal', tier: 'normal', pointer: '/resources/normal', resources: () => ({ hotfix: flowResources.hotfix }) },
  { name: 'без minRamBytes', tier: 'normal', pointer: '/resources/normal/minRamBytes', resources: () => ({ ...flowResources, normal: { ...flowResources.normal, minRamBytes: undefined } }) },
  { name: 'рядковий minDiskBytes', tier: 'normal', pointer: '/resources/normal/minDiskBytes', resources: () => ({ ...flowResources, normal: { ...flowResources.normal, minDiskBytes: '10GiB' } }) },
  { name: 'нульовий minRamBytes', tier: 'normal', pointer: '/resources/normal/minRamBytes', resources: () => ({ ...flowResources, normal: { ...flowResources.normal, minRamBytes: 0 } }) },
  { name: 'від’ємний minDiskBytes', tier: 'normal', pointer: '/resources/normal/minDiskBytes', resources: () => ({ ...flowResources, normal: { ...flowResources.normal, minDiskBytes: -1 } }) },
  { name: 'дробовий minRamBytes', tier: 'normal', pointer: '/resources/normal/minRamBytes', resources: () => ({ ...flowResources, normal: { ...flowResources.normal, minRamBytes: 1.5 } }) },
  { name: 'без hotfix minDiskBytes', tier: 'hotfix', pointer: '/resources/hotfix/minDiskBytes', resources: () => ({ ...flowResources, hotfix: { ...flowResources.hotfix, minDiskBytes: null } }) },
];

for (const broken of brokenThresholds) {
  test(`[task-context] 8. невалідні пороги (${broken.name}) дають UNKNOWN з причиною, без нуля, резерву й сесії`, async t => {
    const w = await workspace(t);
    await writeFlowResources(w, broken.resources());
    const parameters: RuntimeRunParameters = { ...baseParams, type: broken.tier === 'hotfix' ? 'hotfix' : 'implement' };
    const seen: ReserveInput[] = [];
    const h = await harness(t, w, refusingReserve(seen));
    await assert.rejects(h.run(parameters), error => estimateReason.test(failureText(error)) && failureText(error).includes(broken.pointer));
    assert.deepEqual(seen, []);
    assert.deepEqual(h.durable(), { sessions: [], reservations: [] });
    assert.deepEqual(await h.runDirectories(), []);
    assert.equal(h.calls.some(call => call.executable === 'tmux' || call.executable === 'codex'), false);
    const configuration = await loadTaskContextConfiguration(w.confRoot);
    const derived = await deriveTaskContext({ root: w.root, parameters, assignment: snapshotFor(w.root, parameters.tasks), configuration });
    assert.equal(derived.estimate.status, 'UNKNOWN');
    assert.ok(derived.estimate.status === 'UNKNOWN' && estimateReason.test(derived.estimate.reason) && derived.estimate.reason.includes(broken.pointer), JSON.stringify(derived.estimate));
    assert.equal('ramBytes' in derived.estimate, false);
    assert.equal('diskBytesPerFileSystem' in derived.estimate, false);
    assert.doesNotMatch(JSON.stringify(derived.estimate), /:0[,}]/);
  });
}

test('[task-context] 8. поломка порогів hotfix не зачіпає оцінку normal і навпаки', async t => {
  const w = await workspace(t);
  const derive = (resources: unknown, type: string) => deriveTaskContext({ root: w.root, parameters: { ...baseParams, type }, assignment: snapshotFor(w.root, baseParams.tasks), configuration: { ...w.configuration, resources } });
  const brokenHotfix = { ...flowResources, hotfix: { ...flowResources.hotfix, minRamBytes: 'x' } };
  assert.equal((await derive(brokenHotfix, 'hotfix')).estimate.status, 'UNKNOWN');
  assert.deepEqual((await derive(brokenHotfix, 'implement')).estimate, { status: 'KNOWN', tier: 'normal', ramBytes: flowResources.normal.minRamBytes, diskBytesPerFileSystem: flowResources.normal.minDiskBytes, source: 'conf/flow.json#/resources/normal' });
  const brokenNormal = { ...flowResources, normal: { ...flowResources.normal, minDiskBytes: 0 } };
  assert.equal((await derive(brokenNormal, 'implement')).estimate.status, 'UNKNOWN');
  assert.equal((await derive(brokenNormal, 'hotfix')).estimate.status, 'KNOWN');
});

test('[task-context] 9. атомарний запис: 0600 у каталозі 0700, без .tmp; збій перед rename не лишає валідного файла', async t => {
  const w = await workspace(t);
  const snapshot = snapshotFor(w.root, baseParams.tasks);
  const fingerprint = assignmentFingerprint(snapshot);
  assert.equal(fingerprint, assignmentFingerprint(snapshotFor(w.root, baseParams.tasks)));
  assert.notEqual(fingerprint, assignmentFingerprint({ ...snapshot, changes: [{ id: 'change-a', items: [{ id: '1.1', description: 'Змінений опис' }] }] }));
  const context = await deriveTaskContext({ root: w.root, parameters: baseParams, assignment: snapshot, configuration: w.configuration });
  const runDirectory = join(w.tmpRoot, 'run-atomic');
  await mkdir(runDirectory, { mode: 0o700 });
  const envelope: TaskContextEnvelope = { version: 1, runId: 'run-atomic', parameters: baseParams, assignmentFingerprint: fingerprint, context };
  const written = await writeTaskContextFile(runDirectory, envelope);
  assert.equal(written, join(runDirectory, TASK_CONTEXT_FILE_NAME));
  assert.equal((await stat(written)).mode & 0o777, 0o600);
  assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(runDirectory), [TASK_CONTEXT_FILE_NAME]);
  assert.deepEqual(JSON.parse(await readFile(written, 'utf8')), JSON.parse(JSON.stringify(envelope)));
  const failingDirectory = join(w.tmpRoot, 'run-crash');
  await mkdir(failingDirectory, { mode: 0o700 });
  await assert.rejects(writeTaskContextFile(failingDirectory, { ...envelope, runId: 'run-crash' }, { rename: async () => { throw new Error('fixture crash before rename'); } }), /fixture crash before rename/);
  assert.equal(await exists(join(failingDirectory, TASK_CONTEXT_FILE_NAME)), false);
});

test('[task-context] 10. помилка після prepareReport прибирає <tmpRoot>/<runId>/, однаковий --id дає різні каталоги', async t => {
  const w = await workspace(t);
  const seen: { runId: string; contextFile: unknown; mode: number }[] = [];
  const fixedContext: RuntimeTaskContext = { branch: 'develop', outcome: `change-a:1.1 — ${descriptions.a11}`, writeBoundaries: [], sources: [], requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [], reportSchema: { type: 'object' } };
  const h = await harness(t, w, services => ({
    ...services,
    resolveTask: async () => structuredClone(fixedContext),
    routingSnapshot: async () => ({ runnerEnabled: { codex: true }, cliAvailable: { codex: true }, quotas: [] }),
    selectModel: () => fixtureSelection,
    reserve: async input => {
      const path = join(w.tmpRoot, input.runId, TASK_CONTEXT_FILE_NAME);
      const content = await readFile(path, 'utf8').then(text => JSON.parse(text), () => undefined);
      const mode = await stat(path).then(info => info.mode & 0o777, () => -1);
      seen.push({ runId: input.runId, contextFile: content, mode });
      return { admitted: false, reason: 'fixture admission refused' };
    },
  }));
  for (let attempt = 0; attempt < 2; attempt += 1) await assert.rejects(h.run(baseParams), error => /fixture admission refused/.test(failureText(error)));
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].runId, seen[1].runId);
  assert.deepEqual(await h.runDirectories(), []);
  for (const entry of seen) {
    assert.equal(entry.mode, 0o600, `task-context.json у каталозі ${entry.runId}`);
    const file = entry.contextFile as { version?: number; runId?: string; parameters?: unknown; context?: { branch?: string } } | undefined;
    assert.equal(file?.version, 1);
    assert.equal(file?.runId, entry.runId);
    assert.deepEqual(file?.parameters, baseParams);
    assert.equal(file?.context?.branch, 'develop');
  }
  assert.deepEqual(h.durable(), { sessions: [], reservations: [] });
});

function reportPorts(results: AgentReportResult[], diagnostics: string[]) {
  let listener: (event: 'create' | 'modify' | 'rename', filename: string) => Promise<void> = async () => {};
  let exitListener: (exit: AgentReportExit) => Promise<void> = async () => {};
  const ports = {
    fs: {
      mkdir: async (path: string) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
      readText: (path: string) => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }),
      removeTree: (path: string) => rm(path, { recursive: true, force: true }),
    },
    watch: (_directory: string, next: typeof listener) => { listener = next; return () => { listener = async () => {}; }; },
    process: { onExit: (next: typeof exitListener) => { exitListener = next; return () => { exitListener = async () => {}; }; } },
    now: () => '2026-10-22T12:00:00.000Z',
    verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }),
    result: async (result: AgentReportResult) => { results.push(result); },
    diagnostic: async (reason: string) => { diagnostics.push(reason); },
  };
  return { ports, emit: (event: 'create' | 'modify' | 'rename', filename: string) => listener(event, filename), exit: (exit: AgentReportExit) => exitListener(exit) };
}

test('[task-context] 11. частковий .tmp не приймається, повний JSON після rename приймається, старий звіт іншого runId не використовується', async t => {
  const w = await workspace(t);
  const assignment = snapshotFor(w.root, ['change-a:1.1', 'change-b:1.1']);
  const report = { status: 'succeeded', answer: 'Виконано.', changes: [{ id: 'change-a', items: [{ id: '1.1', status: 'succeeded' }] }, { id: 'change-b', items: [{ id: '1.1', status: 'succeeded' }] }] };
  await mkdir(join(w.tmpRoot, 'run-old'), { mode: 0o700 });
  await writeFile(join(w.tmpRoot, 'run-old', 'worker.json'), JSON.stringify(report), { mode: 0o600 });
  const results: AgentReportResult[] = [];
  const diagnostics: string[] = [];
  const p = reportPorts(results, diagnostics);
  const watcher = await createAgentReportWatcher({ tmpRoot: w.tmpRoot, runId: 'run-new', address: 'worker', assignment }, p.ports);
  assert.equal(watcher.path, join(w.tmpRoot, 'run-new', 'worker.json'));
  assert.deepEqual(results, []);
  const staging = join(w.tmpRoot, 'run-new', 'worker.json.tmp');
  const full = JSON.stringify(report);
  await writeFile(staging, full.slice(0, Math.floor(full.length / 2)), { mode: 0o600 });
  await p.emit('create', 'worker.json.tmp');
  await p.emit('modify', 'worker.json.tmp');
  assert.deepEqual(results, []);
  await writeFile(staging, full, { mode: 0o600 });
  await rename(staging, watcher.path);
  await p.emit('rename', 'worker.json');
  assert.equal(results.length, 1, diagnostics.join('; '));
  assert.equal(results[0].runId, 'run-new');
  assert.equal(results[0].status, 'succeeded');
  assert.deepEqual(results[0].report?.changes, report.changes);
  await watcher.dispose();
});

test('[task-context] 11. старий succeeded попереднього runId не підтверджує новий запуск', async t => {
  const w = await workspace(t);
  const assignment = snapshotFor(w.root, baseParams.tasks);
  const report = { status: 'succeeded', answer: 'Старий запуск.', changes: [{ id: 'change-a', items: [{ id: '1.1', status: 'succeeded' }] }] };
  await mkdir(join(w.tmpRoot, 'run-old'), { mode: 0o700 });
  await writeFile(join(w.tmpRoot, 'run-old', 'worker.json'), JSON.stringify(report), { mode: 0o600 });
  const results: AgentReportResult[] = [];
  const p = reportPorts(results, []);
  const watcher = await createAgentReportWatcher({ tmpRoot: w.tmpRoot, runId: 'run-new', address: 'worker', assignment }, p.ports);
  await p.emit('create', 'worker.json');
  await watcher.finish({ code: 1, signal: null });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].event, 'agent.failed');
  assert.equal(results[0].report, undefined);
  assert.equal(await exists(join(w.tmpRoot, 'run-old', 'worker.json')), true);
});
