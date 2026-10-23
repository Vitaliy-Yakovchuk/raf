import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  createAppRuntime, type RuntimeConfiguration, type RuntimeContext, type RuntimeLaunch,
  type RuntimeRunParameters, type RuntimeServices, type RuntimeTaskContext,
} from '../src/app-runtime.ts';
import { composeAssignmentBrief, type AssignmentBriefContext, type AssignmentSnapshot } from '../src/assignment.ts';
import { compileCatalog } from '../src/catalog.ts';
import { failureContext } from '../src/cli-contract.ts';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';
import { buildRunnerInvocation, nativeWriteScopeArgs, type ProtocolSettings } from '../src/runner-protocols.ts';
import { openStateStore } from '../src/state-store.ts';
import { deriveTaskContext, type TaskContextConfiguration } from '../src/task-context.ts';

const conf = new URL('../../conf/', import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, conf), 'utf8'));
const constants = json('raf-constants.json');
const models = json('models.json');
const projects = json('projects.json');
const flow = json('flow.json');
const timeout = flow.unitTests.timeoutMs;
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
const configuration: RuntimeConfiguration = {
  catalog: compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects),
  models, commandTiming: json('raf.json').commandTiming,
};
const protocols: ProtocolSettings[] = json('raf.json').runnerProtocols;
const gitEnvironment = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
  cwd, env: gitEnvironment, encoding: 'utf8',
}).trim();
const unexpected = async (): Promise<never> => { throw new Error('Unexpected external dependency in Z.111 fixture'); };

async function fixture(t: TestContext, linkedOrchestrator = false) {
  const scratch = realpathSync(process.env.RAF_TEST_SCRATCH_ROOT ?? userInfo().homedir);
  assert.ok(scratch !== '/tmp' && !scratch.startsWith('/tmp/'), 'sandbox fixture scratch must be outside globally hidden /tmp');
  const base = await mkdtemp(join(scratch, '.raf-z111-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const primary = join(base, 'primary');
  await mkdir(primary);
  git(primary, 'init', '-q', '-b', 'main');
  await writeFile(join(primary, 'README.md'), '# Fixture\n');
  git(primary, 'add', '--', 'README.md');
  git(primary, 'commit', '-q', '-m', 'Root baseline');
  const root = linkedOrchestrator ? join(base, 'orchestrator-develop') : primary;
  if (linkedOrchestrator) git(primary, 'worktree', 'add', '-q', '-b', 'develop', root);
  const [rootGitDir, rootCommonDir] = git(root, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')
    .split('\n').map(path => realpathSync(path));
  const modulePrimary = join(root, 'raf-main');
  const moduleCommon = join(rootCommonDir, 'modules', 'raf');
  await mkdir(dirname(moduleCommon), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', '--separate-git-dir', moduleCommon, modulePrimary);
  await writeFile(join(modulePrimary, 'code.ts'), 'export const value = 1;\n');
  git(modulePrimary, 'add', '--', 'code.ts');
  git(modulePrimary, 'commit', '-q', '-m', 'Code baseline');
  const cwd = join(root, 'raf-develop');
  git(modulePrimary, 'worktree', 'add', '-q', '-b', 'develop', cwd);
  const [moduleGitDir, moduleCommonDir] = git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')
    .split('\n').map(path => realpathSync(path));
  const change = join(root, 'openspec', 'changes', 'document-only');
  const questions = join(root, 'questions', 'projects', 'raf', 'questions.md');
  const spec = join(change, 'specs', 'projects', 'raf', 'agent-adapters', 'spec.md');
  const confRoot = join(root, 'conf');
  const home = join(base, 'home');
  const tmpRoot = join(home, '.raf', 'tmp');
  await Promise.all([change, dirname(questions), dirname(spec), confRoot, tmpRoot].map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(join(change, 'proposal.md'), '# Document only\n'),
    writeFile(join(change, 'design.md'), '# Document design\n'),
    writeFile(join(change, 'tasks.md'), '- [ ] 1.1 Write assigned documents\n'),
    writeFile(spec, '## ADDED Requirements\n'),
    writeFile(questions, '# Questions\n'),
  ]);
  git(root, 'add', '--', 'openspec/changes/document-only', 'questions/projects/raf/questions.md');
  git(root, 'commit', '-q', '-m', 'Document baseline');
  await writeFile(join(root, 'README.md'), '# Foreign uncommitted edit\n');
  const rootHead = git(root, 'rev-parse', 'HEAD');
  const moduleHead = git(cwd, 'rev-parse', 'HEAD');
  const taskConfiguration: TaskContextConfiguration = {
    projects: {
      ...projects,
      projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' }, usesSharedLibs: false } },
    },
    reportStatuses: constants.reportStatuses, resources: flow.resources,
  };
  const assignment: AssignmentSnapshot = {
    root, changes: [{ id: 'document-only', items: [{ id: '1.1', description: 'Write assigned documents' }] }], baselineArchives: [],
  };
  const parameters = (type: string): RuntimeRunParameters => ({
    id: `fixture-${type}`, type, project: 'raf', features: ['document-only'], phase: type,
    complexity: models.routing.complexityOrder[0], tasks: ['document-only:1.1'],
  });
  const descriptor = (type: string) => deriveTaskContext({ root, parameters: parameters(type), assignment, configuration: taskConfiguration });
  return { base, root, cwd, home, confRoot, tmpRoot, change, questions, spec, assignment, parameters, descriptor,
    rootGitDir, rootCommonDir, moduleGitDir, moduleCommonDir, rootHead, moduleHead };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function captureLaunch(t: TestContext, f: Fixture, type: string, runner: 'codex' | 'claude', override?: Pick<RuntimeTaskContext, 'writeBoundaries'>) {
  const store = openStateStore(join(f.home, '.raf', 'fixture.sqlite'));
  const prepared: RuntimeLaunch[] = [];
  const reserved: Parameters<RuntimeServices['reserve']>[0][] = [];
  const composed: { context: AssignmentBriefContext; brief: string }[] = [];
  const context: RuntimeContext = {
    orchestratorRoot: f.root, confRoot: f.confRoot, artifactPath: join(f.base, 'catalog.json'),
    statePath: join(f.home, '.raf', 'fixture.sqlite'), tmpRoot: f.tmpRoot, mode: 'test', commandStartedAtMs: 0,
    resolveCaller: async () => undefined,
  };
  const services: RuntimeServices = {
    assignment: {
      validate: async () => ({ ok: true, snapshot: f.assignment }),
      compose: async (snapshot, briefContext) => {
        const brief = await composeAssignmentBrief(snapshot, briefContext, { readText: async () => 'FIXTURE TEMPLATE' });
        composed.push({ context: structuredClone(briefContext), brief });
        return brief;
      },
    },
    resolveTask: async () => {
      const { estimate, ...task } = await f.descriptor(type);
      assert.equal(estimate.status, 'KNOWN', 'fixture uses valid configured resource thresholds');
      return { ...task, ...override, reportSchema: { ...task.reportSchema }, requested: { ramBytes: flow.resources.normal.minRamBytes, diskBytes: {} }, requiredFileSystemIds: [] };
    },
    route: async () => ({ ok: true, project: 'raf', branch: 'develop', cwd: f.cwd }),
    routingSnapshot: async () => ({ runnerEnabled: { [runner]: true }, cliAvailable: { [runner]: true }, quotas: [] }),
    selectModel: () => ({ status: 'selected', runner, model: 'fixture-model', effort: 'fixture-effort', reason: 'fixture', quota: 'unknown' }),
    listModels: () => [],
    prepareReport: async launch => {
      prepared.push(structuredClone(launch));
      const directory = join(f.tmpRoot, launch.runId);
      await mkdir(directory, { recursive: true });
      return { reportPath: join(directory, `${launch.tmuxSession}.json`), reportWrapper: { wrap: command => command }, cleanupUnstarted: async () => {} };
    },
    reserve: async launch => { reserved.push(structuredClone(launch)); return { admitted: false, reason: 'Z.111 fixture stops before runner' }; },
    adapter: { start: unexpected }, verifyStarted: unexpected, commitStarted: unexpected,
    compensate: unexpected, abortLaunch: unexpected, authorizeMain: async () => {},
    control: { ps: unexpected, update: unexpected, message: unexpected, close: unexpected, interrupt: unexpected, attachMain: unexpected },
  };
  const runtime = createAppRuntime(context, {
    loadConfiguration: async () => configuration, openStore: async () => store, createServices: async () => services,
    nextRunIdentity: () => ({ runId: `z111-${type}-${runner}`, tmuxSession: `z111-${type}-${runner}` }), now: () => Date.now(),
    additionalHandlers: Object.fromEntries(configuration.catalog.commands
      .filter(command => !['help', 'agent run', 'agent ps', 'agent update', 'agent message', 'agent close', 'agent interrupt', 'main attach', 'runner list', 'runner enable', 'runner disable', 'command stats'].includes(command.handlerName))
      .map(command => [command.handlerName, unexpected])),
  });
  t.after(() => runtime.close());
  await assert.rejects(Promise.resolve().then(() => runtime.handlers['agent run'](f.parameters(type) as unknown as Record<string, unknown>)), error =>
    `${error instanceof Error ? error.message : error} ${JSON.stringify(failureContext(error))}`.includes('Z.111 fixture stops before runner'));
  assert.equal(prepared.length, 1);
  assert.equal(composed.length, 1);
  assert.equal(reserved.length, 1);
  const section = composed[0].brief.slice(composed[0].brief.indexOf('# Конкретне доручення'));
  const jsonIndex = section.indexOf('{');
  assert.ok(jsonIndex >= 0);
  const payload = JSON.parse(section.slice(jsonIndex));
  return { prepared: prepared[0], reserved: reserved[0], context: composed[0].context, brief: composed[0].brief, duty: section.slice(0, jsonIndex), payload };
}

function documentBoundaries(f: Fixture): string[] {
  return [...new Set([f.change, f.questions, f.rootGitDir, f.rootCommonDir])].sort();
}

for (const type of ['spec', 'design']) {
  for (const runner of ['codex', 'claude'] as const) {
    for (const linked of [false, true]) {
      test(`Z.111 ${type}/${runner}: production brief and repository boundaries, Orchestrator ${linked ? 'linked' : 'ordinary'}`, { timeout }, async t => {
        const f = await fixture(t, linked);
        const task = await f.descriptor(type);
        assert.equal(task.workspaceWritable, false);
        assert.deepEqual([...task.writeBoundaries].sort(), [f.change, f.questions].sort());
        const captured = await captureLaunch(t, f, type, runner);
        assert.equal(captured.context.commitOwnWork, true, 'документи репозиторію вимагають власного коміту');
        for (const boundaries of [captured.prepared.writeBoundaries, captured.reserved.writeBoundaries, captured.context.writeBoundaries, captured.payload.write_boundaries]) {
          assert.deepEqual([...boundaries!].sort(), documentBoundaries(f));
          for (const denied of [f.root, f.cwd, f.moduleGitDir, f.moduleCommonDir]) assert.equal(boundaries!.includes(denied), false, denied);
        }
        assert.equal(captured.prepared.taskContext?.context.workspaceWritable, false);
        assert.equal(captured.reserved.taskContext?.context.workspaceWritable, false);
        assert.match(captured.duty, /закоміт/i);
        assert.ok(captured.duty.includes('parallel-development'));
        assert.ok(captured.duty.includes('commits'));
        assert.match(captured.duty, /push[^\n]*(?:не |без |лише )|(?:не |без )[^\n]*push/i);
        assert.match(captured.duty, /Orchestrator|orchestrator/i, 'репозиторій документів названо явно');
        assert.match(captured.duty, /read.only|лише для читання|тільки для читання/i, 'бриф прямо зберігає read-only код');
        assert.match(captured.duty, /перевір/i);
        assert.match(captured.duty, /до[^\n]*(?:звіт|JSON)|перед[^\n]*(?:звіт|JSON)/i, 'коміт має передувати звіту');
        assert.ok(captured.brief.includes(f.change));
        assert.ok(captured.brief.includes(f.questions));
        assert.ok(captured.brief.includes('tasks.md'), 'обовʼязок власної галочки названо');
        assert.equal(captured.payload.root, f.root);
        assert.deepEqual(captured.payload.raf_subcommands, ['agent message', 'agent ps']);
        assert.doesNotMatch(captured.duty, /raf_command agent (?:run|close)/);
        const settings = protocols.find(protocol => protocol.runner === runner);
        if (!settings) throw new Error(`Missing ${runner} protocol fixture`);
        const args = nativeWriteScopeArgs(settings, captured.reserved.writeBoundaries!, []);
        for (const directory of new Set([f.rootGitDir, f.rootCommonDir])) {
          const index = args.indexOf(runner === 'claude' ? '--add-dir' : settings.native!.writeScope.directoryFlag);
          assert.ok(index >= 0);
          assert.ok(args.includes(directory), `runner отримав git-каталог Orchestrator ${directory}`);
          if (runner === 'claude') assert.ok(args.includes(`Edit(/${directory}/**)`));
        }
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.rootHead, 'підготовка не комітить за агента');
        assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.moduleHead);
        assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), '# Foreign uncommitted edit\n');
      });
    }
  }
  test(`Z.111 ${type}: tmp/report самі не дають git-прав чи обовʼязку коміту`, { timeout }, async t => {
    const f = await fixture(t);
    const scratch = join(f.tmpRoot, 'scratch');
    await mkdir(scratch);
    const captured = await captureLaunch(t, f, type, 'codex', { writeBoundaries: [scratch] });
    assert.notEqual(captured.context.commitOwnWork, true);
    for (const boundaries of [captured.prepared.writeBoundaries, captured.reserved.writeBoundaries, captured.context.writeBoundaries, captured.payload.write_boundaries]) {
      assert.deepEqual([...boundaries!], [scratch]);
    }
    assert.doesNotMatch(captured.duty, /закоміт/i);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.rootHead);
    assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.moduleHead);
  });
}

test('Z.111 implement regression: linked code worktree keeps its git-dir/common-dir and commit duty', { timeout }, async t => {
  const f = await fixture(t);
  const captured = await captureLaunch(t, f, 'implement', 'codex');
  assert.equal(captured.context.commitOwnWork, true);
  for (const path of [f.cwd, f.moduleGitDir, f.moduleCommonDir, f.rootGitDir, f.rootCommonDir]) {
    assert.ok(captured.reserved.writeBoundaries?.includes(path), path);
  }
  assert.match(captured.duty, /закоміт/i);
  assert.ok(captured.duty.includes('commits'));
});

for (const type of ['spec', 'design']) {
  test(`Z.111 ${type}: real Codex sandbox commits only Orchestrator documents; nested code git remains read-only`, { timeout }, async t => {
    const f = await fixture(t);
    const captured = await captureLaunch(t, f, type, 'codex');
    const runDirectory = join(f.tmpRoot, `sandbox-${type}`);
    await mkdir(runDirectory);
    const settings = protocols.find(protocol => protocol.runner === 'codex');
    if (!settings) throw new Error('Missing codex protocol fixture');
    const model = models.models.find((entry: { runner: string; enabled: boolean }) => entry.runner === 'codex' && entry.enabled);
    assert.ok(model);
    const writableDirectories = [...captured.reserved.writeBoundaries!, runDirectory];
    const baseInvocation = buildRunnerInvocation(settings, { model: model.id, effort: model.effort });
    const invocation = { ...baseInvocation, args: [...baseInvocation.args, ...nativeWriteScopeArgs(settings, writableDirectories, [])] };
    const prepared = await prepareCodexSandbox({
      runId: `sandbox-${type}`, invocation, cwd: f.cwd, runDirectory, writableDirectories,
      environment: { ...gitEnvironment, HOME: f.home }, timeoutMs: timeout,
      scope: { hidden: [join(f.home, '.raf')], readable: [runDirectory], tmuxDirectory: runDirectory, excludedCommands: [] },
    });
    t.after(() => prepared.cleanup());
    const script = `
      import assert from 'node:assert/strict';
      import { readFile, writeFile } from 'node:fs/promises';
      import { spawnSync } from 'node:child_process';
      const f = JSON.parse(process.argv[1]);
      assert.equal(await readFile(f.code, 'utf8'), 'export const value = 1;\\n');
      for (const path of f.denied) await assert.rejects(writeFile(path, 'forbidden'), path);
      await writeFile(f.design, '# Own verified design\\n');
      await writeFile(f.spec, '## MODIFIED Requirements\\n');
      await writeFile(f.questions, '# Own question\\n');
      await writeFile(f.tasks, '- [x] 1.1 Write assigned documents\\n');
      const git = args => { const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-C', f.root, ...args], {encoding:'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
      git(['add', '--', ...f.own]);
      git(['commit', '-q', '-m', 'Own verified documents', '--', ...f.own]);
      const commit = git(['rev-parse', 'HEAD']);
      await writeFile(f.report + '.tmp', JSON.stringify({status:'succeeded', commits:[commit]}));
      const { rename } = await import('node:fs/promises');
      await rename(f.report + '.tmp', f.report);
      process.stdout.write(JSON.stringify({commit}));
    `;
    const own = ['openspec/changes/document-only/design.md', 'openspec/changes/document-only/tasks.md', 'openspec/changes/document-only/specs/projects/raf/agent-adapters/spec.md', 'questions/projects/raf/questions.md'];
    const report = join(runDirectory, 'report.json');
    const denied = [join(f.cwd, 'code.ts'), join(f.root, 'README.md'), join(f.moduleGitDir, 'z111-probe'), join(f.moduleCommonDir, 'z111-probe')];
    const input = { root: f.root, code: join(f.cwd, 'code.ts'), denied, own,
      design: join(f.change, 'design.md'), spec: f.spec, tasks: join(f.change, 'tasks.md'), questions: f.questions, report };
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(prepared.toolSandbox.executable, [...prepared.toolSandbox.args, process.execPath, '--input-type=module', '-e', script, JSON.stringify(input)], {
        cwd: f.cwd, env: { ...prepared.environment }, stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL',
      });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
      child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    const { commit } = JSON.parse(result.stdout);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), commit);
    assert.equal(git(f.root, 'rev-parse', 'HEAD~1'), f.rootHead);
    assert.deepEqual(git(f.root, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort(), [...own].sort());
    assert.deepEqual(JSON.parse(await readFile(report, 'utf8')).commits, [commit]);
    assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.moduleHead);
    assert.equal(git(f.root, 'diff', '--cached', '--name-only'), '');
    assert.equal(await readFile(join(f.cwd, 'code.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), '# Foreign uncommitted edit\n');
  });
}
