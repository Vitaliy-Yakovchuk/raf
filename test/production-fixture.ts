import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { createProductionServices } from '../src/production-runtime.ts';
import { executeCommand } from '../src/os-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import { bindWorkspaceBoundaries } from '../src/task-context.ts';
import type { RuntimeConfiguration, RuntimeContext, RuntimeLaunch, RuntimeRunParameters, RuntimeServices } from '../src/app-runtime.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { AssignmentSnapshot } from '../src/assignment.ts';

export const configuration: RuntimeConfiguration = {
  catalog: { commands: [], reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }] },
  models: {
    version: 1,
    runners: [{ id: 'codex', initialEnabled: true }],
    models: [{ id: 'gpt-6.1-sol', version: '6.1', runner: 'codex', effort: 'high', complexity: 'decision', enabled: true }],
    routing: { complexityOrder: ['decision'], taskClassification: {}, runnerPreferences: [], modelTransitions: [], roleModelBindings: {} },
  },
  commandTiming: { emaAlpha: 0.1 },
};

export const realFlow = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
export const fixtureResources = { normal: { ...realFlow.resources.normal, minRamBytes: 1024, minDiskBytes: 1024 }, hotfix: { ...realFlow.resources.hotfix, minRamBytes: 1024, minDiskBytes: 1024 } };
export const taskDescription = 'Виконати лише synthetic fixture';

export async function eventually<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 12000;
  let last: T;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`${description}: ${JSON.stringify(last)}`);
}

export async function fixture(t: TestContext, options: { tmpRootInHome?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'raf-prod-'));
  const confRoot = join(root, 'conf');
  const home = join(root, 'home');
  const tmpRoot = options.tmpRootInHome ? join(home, '.raf', 'tmp') : join(root, 'tmp');
  const cwd = join(root, 'raf-develop');
  const statePath = join(home, '.raf', 'isolated.sqlite');
  const binRoot = join(root, 'bin');
  const socket = join(root, 'tmux.sock');
  const questionsPath = join(root, 'questions', 'projects', 'raf', 'questions.md');
  await Promise.all([mkdir(confRoot), mkdir(dirname(statePath), { recursive: true }), mkdir(tmpRoot, { recursive: true }), mkdir(cwd), mkdir(binRoot), mkdir(dirname(questionsPath), { recursive: true })]);
  await writeFile(questionsPath, '# Питання\n');
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
  const flowPath = join(confRoot, 'flow.json');
  const writeFlowResources = (resources: unknown) => writeFile(flowPath, JSON.stringify({ ...realFlow, resources }));
  await writeFlowResources(fixtureResources);
  await writeFile(join(confRoot, 'raf-constants.json'), JSON.stringify({
    version: 1,
    agentTypes: [{ id: 'main', launchableByRaf: false }, { id: 'implement', launchableByRaf: true }, { id: 'spec', launchableByRaf: true }],
    reportStatuses: [{ id: 'succeeded', event: 'agent.succeeded' }, { id: 'failed', event: 'agent.failed' }],
    eventIdKinds: { agentAddress: 'Fixture agent address', reminderId: 'Fixture reminder ID' },
    events: ['agent.started', 'agent.activity-changed', 'agent.interrupted', 'agent.closed', 'agent.succeeded', 'agent.failed', 'reminder.activated', 'reminder.closed'].map(id => ({ id, idKind: id.startsWith('reminder.') ? 'reminderId' : 'agentAddress' })),
  }));
  const templates = join(confRoot, 'briefs');
  await Promise.all([mkdir(join(templates, 'runners'), { recursive: true }), mkdir(join(templates, 'tasks'), { recursive: true })]);
  await Promise.all([
    writeFile(join(templates, 'runners', 'codex.md'), 'FIXTURE_CODEX_RUNNER'),
    writeFile(join(templates, 'tasks', 'implement.md'), 'FIXTURE_IMPLEMENT_STAGE'),
    writeFile(join(templates, 'tasks', 'spec.md'), 'FIXTURE_SPEC_STAGE'),
    writeFile(join(templates, 'completion.md'), 'FIXTURE_COMPLETION'),
  ]);
  const changeRoot = join(root, 'openspec', 'changes', 'fixture-launch');
  const specRoot = join(changeRoot, 'specs', 'projects', 'raf', 'agent-run');
  await mkdir(specRoot, { recursive: true });
  const tasksPath = join(changeRoot, 'tasks.md');
  await Promise.all([
    writeFile(tasksPath, `## 2. Fixture\n\n- [ ] 2.1 ${taskDescription}\n`),
    writeFile(join(changeRoot, 'proposal.md'), '# Fixture launch\n\n## Why\n\nVerify isolated production composition.\n\n## What Changes\n\nRun a synthetic executable only.\n'),
    writeFile(join(changeRoot, 'design.md'), '# Fixture design\n\nUse the production composition with an isolated home and owned tmux socket.\n'),
    writeFile(join(specRoot, 'spec.md'), '## ADDED Requirements\n\n### Requirement: Synthetic execution\n\nThe fixture SHALL run only its synthetic executable.\n\n#### Scenario: Owned launch\n\n- **WHEN** the fixture starts\n- **THEN** its report belongs to the reserved run\n'),
  ]);
  const params: RuntimeRunParameters = { id: 'worker-fixture', type: 'implement', project: 'raf', features: ['fixture-launch'], phase: 'implement', complexity: 'decision', tasks: ['fixture-launch:2.1'] };
  const legacyTaskContextPath = join(tmpRoot, 'task-context', `${params.id}.json`);
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
  const completeAssignment = async () => {
    const current = await readFile(tasksPath, 'utf8');
    const pending = `- [ ] 2.1 ${taskDescription}`;
    assert.equal(current.split(pending).length, 2);
    const completed = current.replace(pending, `- [x] 2.1 ${taskDescription}`);
    const staging = join(changeRoot, 'tasks.next.md');
    await writeFile(staging, completed, { mode: 0o600, flag: 'wx' });
    await rename(staging, tasksPath);
    assert.equal(await readFile(tasksPath, 'utf8'), completed);
  };
  return { root, confRoot, home, cwd, tmpRoot, statePath, binRoot, context, store, assignment, params, changeRoot, tasksPath, questionsPath, flowPath, writeFlowResources, legacyTaskContextPath, execute, calls, completeAssignment, cliCalls, openspecPath, socket, realTmuxPath, realOpenSpecPath, trackProcess, trackPidFile };
}

export type ProductionFixture = Awaited<ReturnType<typeof fixture>>;

export async function derivedLaunch(services: RuntimeServices, f: Pick<ProductionFixture, 'params' | 'assignment'>, launch: RuntimeLaunch, parameters: RuntimeRunParameters = f.params) {
  const task = await services.resolveTask(parameters, launch.assignment);
  return { task, launch: { ...launch, writeBoundaries: bindWorkspaceBoundaries(task, launch.activity.cwd), taskContext: { parameters, context: task } } satisfies RuntimeLaunch };
}

export async function recordLaunchRunnerPath(tmpRoot: string, runId: string, runnerPath: string) {
  const manifestPath = join(tmpRoot, runId, 'runtime.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(`${manifestPath}.fixture.tmp`, JSON.stringify({ ...manifest, runnerPath }), { mode: 0o600, flag: 'wx' });
  await rename(`${manifestPath}.fixture.tmp`, manifestPath);
}
