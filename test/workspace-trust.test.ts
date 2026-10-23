import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import { resolveGitWriteBoundaries } from '../src/task-context.ts';
import type { RuntimeConfiguration, RuntimeLaunch } from '../src/app-runtime.ts';
import type { LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { configuration as codexConfiguration, derivedLaunch, eventually, fixture, recordLaunchRunnerPath } from './production-fixture.ts';

type Runner = 'codex' | 'claude';
type Placement = 'registered' | 'unregistered' | 'outside-symlink' | 'subdirectory';

const conf = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const z12Timeout = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8')).unitTests.timeoutMs;
assert.ok(Number.isSafeInteger(z12Timeout) && z12Timeout > 0);
const configured = (runner: Runner): ProtocolSettings => {
  const rows = conf.runnerProtocols.filter((row: ProtocolSettings) => row.runner === runner);
  assert.equal(rows.length, 1, `conf/raf.json must define exactly one ${runner} protocol`);
  return structuredClone(rows[0]);
};
const configuration: RuntimeConfiguration = {
  ...codexConfiguration,
  models: {
    ...codexConfiguration.models,
    runners: [...codexConfiguration.models.runners, { id: 'claude', initialEnabled: true }],
    models: [...codexConfiguration.models.models, { id: 'claude-opus', version: 'cli', runner: 'claude', effort: 'high', complexity: 'decision', enabled: true }],
  },
};
const selections = { codex: { runner: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' }, claude: { runner: 'claude' as const, model: 'claude-opus', effort: 'high' } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const stub = (runner: Runner, settings: ProtocolSettings, paths: { pid: string; input: string; accepted: string }, sticky: boolean, sandboxExecutable: string | null) => String.raw`#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const runner = ${JSON.stringify(runner)};
const sticky = ${JSON.stringify(sticky)};
if (process.argv.includes('--version')) { console.log(runner === 'claude' ? ${JSON.stringify(`${settings.version} (Claude Code)`)} : ${JSON.stringify(`codex-cli ${settings.version}`)}); process.exit(0); }
const argv = process.argv.slice(2);
if (runner === 'codex' && argv[0] === 'sandbox') {
  const result = spawnSync(${JSON.stringify(sandboxExecutable)}, argv, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exit(result.status ?? 1);
}
writeFileSync(${JSON.stringify(paths.pid)}, String(process.pid));
const sessionFlag = argv.indexOf('--session-id');
const nativeId = runner === 'claude' ? argv[sessionFlag + 1] : randomUUID();
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
const render = text => process.stdout.write('\x1b[2J\x1b[H\x1b[?2004h' + text.replaceAll('\n', '\r\n'));
const claudeHeader = '[Screen Reader Mode: on via flag]\nClaude Code v${settings.version}\nOpus 5.5 with high effort · Claude Max\n' + process.cwd();
const claudeFooter = "don't ask on (shift+tab to cycle)";
const codexHeader = 'OpenAI Codex (v${settings.version})';
const codexFooter = 'GPT-6.1-Sol high · ' + process.cwd();
let status = false;
const ready = (input = '') => runner === 'claude'
  ? render(claudeHeader + '\n' + claudeFooter + '\n$' + (input ? '\u00a0' + input : ''))
  : render(codexHeader + (status ? '\nSession: ' + nativeId : '') + '\n› ' + (input || 'Ask Codex to do anything') + '\n' + codexFooter);
const trustScreen = runner === 'claude'
  ? '[Screen Reader Mode: on via flag]\nPermission Required: Accessing workspace:\n' + process.cwd() + '\nQuick safety check: Is this a project you created or one you trust?\ny. Yes, I trust this folder\nn. No, exit\nEnter y/n:\nEnter to confirm · Esc to cancel'
  : '  Folder access\n  ' + process.cwd() + '\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit';
let trusting = true;
let answer = '';
render(trustScreen);
let typed = '';
let paste = null;
let pasted = null;
let panel = false;
process.stdin.on('data', data => {
  appendFileSync(${JSON.stringify(paths.input)}, JSON.stringify({ data, trusting }) + '\n');
  let rest = data;
  while (rest.length) {
    if (trusting) {
      const key = rest[0];
      rest = rest.slice(1);
      if (runner === 'claude' && key !== '\r') { answer += key; continue; }
      if (key !== '\r') process.exit(93);
      if (runner === 'claude' && answer !== 'y') process.exit(94);
      if (sticky) { answer = ''; render(trustScreen); continue; }
      trusting = false;
      ready();
      continue;
    }
    if (paste !== null) {
      const end = rest.indexOf('\x1b[201~');
      if (end < 0) { paste += rest; rest = ''; break; }
      paste += rest.slice(0, end);
      rest = rest.slice(end + 6);
      pasted = paste;
      paste = null;
      if (runner === 'claude') render(claudeHeader + '\npaste again to expand\n' + claudeFooter + '\n$\u00a0[Pasted text #1 +' + (pasted.match(/[\r\n]/g) ?? []).length + ' lines]');
      else ready('[Pasted Content ' + [...pasted.replaceAll('\r', '\n')].length + ' chars]');
      continue;
    }
    if (rest.startsWith('\x1b[200~')) { paste = ''; rest = rest.slice(6); continue; }
    if (rest.startsWith('\x1b')) { rest = rest.slice(1); if (panel) { panel = false; ready(); } continue; }
    const key = rest[0];
    rest = rest.slice(1);
    if (key !== '\r' && key !== '\n') { typed += key; if (pasted === null) ready(typed); continue; }
    if (pasted !== null) {
      writeFileSync(${JSON.stringify(paths.accepted)}, JSON.stringify({ brief: pasted.replaceAll('\r', '\n') }));
      if (runner === 'claude') render(claudeHeader + '\nyou: ' + pasted.split(/[\r\n]/)[0] + '\n' + claudeFooter + '  ·  esc to interrupt\n$');
      else render('Session: ' + nativeId + '\n• Working (0s • esc to interrupt)\n› ');
      pasted = null;
      continue;
    }
    if (typed === '/status') {
      typed = '';
      status = true;
      if (runner === 'claude') { panel = true; render(claudeHeader + '\nyou: /status\nVersion: ${settings.version}\nSession ID: ' + nativeId + '\nSession kind: interactive\nEsc to cancel'); }
      else ready();
      continue;
    }
    typed = '';
  }
});
setTimeout(() => process.exit(91), 20000);
`;

async function trustFixture(t: TestContext, runner: Runner, placement: Placement, sticky = false, rootTask?: 'spec' | 'design') {
  const f = await fixture(t, { productionQa: true, externalHome: rootTask !== undefined });
  const parameters = rootTask ? { ...f.params, type: rootTask, phase: rootTask, project: 'orchestrator' } : f.params;
  if (rootTask) {
    assert.equal(dirname(f.home), dirname(f.root), 'root trust fixtures require sibling HOME and Orchestrator directories');
    assert.notEqual(f.home, f.root);
    assert.equal(f.statePath, join(f.home, '.raf', 'isolated.sqlite'));
    assert.equal(f.tmpRoot, join(f.home, '.raf', 'tmp'));
    const initialized = spawnSync('git', ['init', '--quiet', '--initial-branch=main', f.root], { encoding: 'utf8' });
    assert.ifError(initialized.error);
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(join(f.root, 'z12-root-sentinel.txt'), 'Root fixture baseline\n');
    for (const args of [['add', '--', 'z12-root-sentinel.txt'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Z12 root baseline']]) {
      const committed = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' });
      assert.ifError(committed.error);
      assert.equal(committed.status, 0, committed.stderr);
    }
    const projectsPath = join(f.confRoot, 'projects.json');
    const projects = JSON.parse(await readFile(projectsPath, 'utf8'));
    projects.projects.orchestrator = { path: '.', profile: 'orchestrator' };
    projects.profiles.orchestrator = { development: 'main', integration: 'main', production: 'main' };
    await writeFile(projectsPath, JSON.stringify(projects));
    const questions = join(f.root, 'questions', 'projects', 'orchestrator', 'questions.md');
    await mkdir(dirname(questions), { recursive: true });
    await writeFile(questions, '# Fixture questions\n');
  }
  const base = configured(runner);
  const settings: ProtocolSettings = { ...base, timeouts: { ...base.timeouts, startupMs: 5000, transitionMs: 5000, overallMs: 15000, pollMs: 30 } };
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify({ version: 1, state: { fileName: 'isolated.sqlite' }, commandTiming: configuration.commandTiming, runnerProtocols: [settings] }));
  await writeFile(join(f.confRoot, 'models.json'), JSON.stringify(configuration.models));
  f.store.initializeRunners(configuration.models.runners);
  const cliConfigs = { [join(f.home, '.claude.json')]: '{"projects":{}}\n', [join(f.home, '.codex', 'config.toml')]: '# fixture codex config\n' };
  for (const [path, content] of Object.entries(cliConfigs)) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  const registeredCwd = rootTask ? f.root : f.cwd;
  let cwd = registeredCwd;
  if (placement === 'unregistered') {
    cwd = join(f.root, 'other-develop');
    assert.equal(spawnSync('git', ['init', '--quiet', '--initial-branch=develop', cwd], { encoding: 'utf8' }).status, 0);
  } else if (placement === 'subdirectory') {
    cwd = join(registeredCwd, 'nested');
    await mkdir(cwd);
  } else if (placement === 'outside-symlink') {
    cwd = join(dirname(f.root), `${basename(f.root)}-link`);
    await symlink(registeredCwd, cwd);
    t.after(() => rm(cwd, { force: true }));
  }
  const paths = { pid: join(f.root, `${runner}.pid`), input: join(f.root, `${runner}-input.jsonl`), accepted: join(f.root, `${runner}-accepted.json`) };
  f.trackPidFile(paths.pid);
  const executable = join(f.binRoot, runner);
  let sandboxExecutable: string | null = null;
  if (runner === 'codex') {
    const lookup = spawnSync('which', ['codex'], { encoding: 'utf8' });
    assert.ifError(lookup.error);
    assert.equal(lookup.status, 0, lookup.stderr);
    sandboxExecutable = lookup.stdout.trim();
    assert.ok(sandboxExecutable.startsWith('/') && !sandboxExecutable.startsWith(f.binRoot + '/'));
  }
  await writeFile(executable, stub(runner, settings, paths, sticky, sandboxExecutable), { mode: 0o700 });
  await chmod(executable, 0o700);
  const runId = `trust-${runner}-${placement}${rootTask ? `-${rootTask}` : ''}`;
  const address = f.params.id;
  const tmuxSession = `raf-trust-${runner}`;
  const selection = selections[runner];
  const brief = ['WORKSPACE_TRUST_QA', ...Array.from({ length: 12 }, (_, index) => `Рядок доручення ${index}`), 'BRIEF_END'].join('\n');
  const runtimeLaunch: RuntimeLaunch = { runId, addressId: address, tmuxSession, activity: { type: parameters.type, project: parameters.project, features: parameters.features, phase: parameters.phase, cwd }, assignment: f.assignment, selection: { status: 'selected', ...selection, reason: 'synthetic workspace trust fixture only', quota: 'unknown' }, statePath: f.statePath, tmpRoot: f.tmpRoot };
  const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute, loadAverage1m: () => 0 });
  const { task, launch: derived } = await derivedLaunch(services, f, runtimeLaunch, parameters);
  if (rootTask) derived.writeBoundaries = [...new Set([...derived.writeBoundaries!, ...await resolveGitWriteBoundaries(cwd, f.root, derived.writeBoundaries)])];
  const prepared = await services.prepareReport(derived);
  const reservation = await services.reserve({ ...derived, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
  assert.equal(reservation.admitted, true, 'reason' in reservation ? reservation.reason : 'admitted');
  await recordLaunchRunnerPath(f.tmpRoot, runId, executable);
  const session = () => f.store.sessionRepository.transaction(tx => tx.getSession(runId));
  const reportedCommits = session()?.launchContext?.reportedCommits;
  assert.ok(reportedCommits, 'workspace trust fixture must carry the reserved launch commit contract');
  const request: LaunchWrapperRequest = { tmpRoot: f.tmpRoot, runId, address, assignment: f.assignment, statePath: f.statePath, cwd, tmuxSession, selection, brief, readinessTimeoutMs: settings.timeouts.startupMs, reportedCommits };
  await writeFile(session()!.launchContext!.briefPath, brief);
  const wrapperPidPath = join(f.root, 'wrapper.pid');
  f.trackPidFile(wrapperPidPath);
  const launch = async () => {
    const started = await launchPersistentWrapper(request, { timeoutMs: settings.timeouts.overallMs, workerCommand: { executable: process.execPath, args: ['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; import { runProductionWorker } from ${JSON.stringify(f.runtimeUrl)}; writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid)); process.env.PATH = ${JSON.stringify(f.binRoot + delimiter)} + (process.env.PATH ?? ''); process.env.HOME = ${JSON.stringify(f.home)}; await runProductionWorker();`] } });
    f.trackProcess(started.wrapperPid);
    f.trackProcess(started.identity.pid);
    return started;
  };
  const inputs = async () => (await readFile(paths.input, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { data: string; trusting: boolean });
  const configsUnchanged = async () => {
    for (const [path, content] of Object.entries(cliConfigs)) assert.equal(await readFile(path, 'utf8'), content, `raf must not edit CLI configuration ${path}`);
  };
  return { ...f, cwd, settings, request, runtimeLaunch, services, session, launch, inputs, paths, configsUnchanged, runId, task, derived };
}

for (const runner of ['codex', 'claude'] as const) {
  for (const type of ['spec', 'design'] as const) {
    test(`[workspace-trust] Z.12 ${runner}/${type}: verified Orchestrator main root is trusted once without expanding write scope`, { timeout: z12Timeout }, async t => {
      const f = await trustFixture(t, runner, 'registered', false, type);
      assert.equal(f.task.branch, 'main');
      assert.equal(f.task.workspaceWritable, false);
      assert.equal(f.derived.activity.cwd, f.root);
      const route = await f.services.route({ root: f.root, project: 'orchestrator', branch: f.task.branch });
      assert.deepEqual(route, { ok: true, project: 'orchestrator', branch: 'main', cwd: f.root });
      const before = { conf: await readFile(join(f.confRoot, 'projects.json'), 'utf8'), head: await readFile(join(f.root, '.git', 'HEAD'), 'utf8'), boundaries: [...f.derived.writeBoundaries!] };
      await f.launch();
      const navigation = f.settings.navigation.find(row => row.state === 'workspace_trust_required');
      assert.ok(navigation);
      const answered = (await f.inputs()).filter(row => row.trusting).map(row => row.data).join('');
      assert.equal(answered, navigation.keys.map(key => key === 'Enter' ? '\r' : key).join(''));
      assert.equal(JSON.parse(await readFile(f.paths.accepted, 'utf8')).brief, f.request.brief);
      assert.equal(f.session()?.state, 'running');
      assert.deepEqual(f.derived.writeBoundaries, before.boundaries);
      assert.deepEqual([...(f.session()?.launchContext?.writeBoundaries ?? [])].sort(), [...before.boundaries].sort(), 'durable worker scope must preserve the prepared document scope');
      for (const denied of [f.root, f.confRoot, f.cwd + '/raf-develop', join(f.root, 'raf-develop/.git'), join(f.root, 'openspec/changes')]) assert.ok(!before.boundaries.includes(denied), denied);
      assert.ok(before.boundaries.includes(join(f.root, 'openspec/changes/fixture-launch')));
      assert.ok(before.boundaries.includes(join(f.root, '.git')), 'Z.11 document Git access is preserved');
      assert.equal(await readFile(join(f.confRoot, 'projects.json'), 'utf8'), before.conf);
      assert.equal(await readFile(join(f.root, '.git', 'HEAD'), 'utf8'), before.head);
      await f.configsUnchanged();
    });

    test(`[workspace-trust] Z.12 ${runner}/${type}: sticky root prompt receives only one navigation answer`, { timeout: z12Timeout }, async t => {
      const f = await trustFixture(t, runner, 'registered', true, type);
      await assert.rejects(f.launch(), /RUNNER_WORKSPACE_UNTRUSTED/);
      const navigation = f.settings.navigation.find(row => row.state === 'workspace_trust_required');
      assert.ok(navigation);
      assert.equal((await f.inputs()).map(row => row.data).join(''), navigation.keys.map(key => key === 'Enter' ? '\r' : key).join(''));
      assert.equal(await readFile(f.paths.accepted, 'utf8').catch(() => null), null);
      await f.configsUnchanged();
    });

    for (const placement of ['unregistered', 'subdirectory', 'outside-symlink'] as const) {
      test(`[workspace-trust] Z.12 ${runner}/${type}: root exception rejects ${placement} without answering`, { timeout: z12Timeout }, async t => {
        const f = await trustFixture(t, runner, placement, false, type);
        await assert.rejects(f.launch(), /RUNNER_WORKSPACE_UNTRUSTED/);
        assert.deepEqual(await f.inputs(), []);
        assert.equal(await readFile(f.paths.accepted, 'utf8').catch(() => null), null);
        await f.configsUnchanged();
      });
    }

    for (const defect of ['changed-branch', 'detached-head', 'missing-navigation', 'unregistered-root'] as const) {
      test(`[workspace-trust] Z.12 ${runner}/${type}: ${defect} at worker readiness cannot reuse an earlier trust decision`, { timeout: z12Timeout }, async t => {
        const f = await trustFixture(t, runner, 'registered', false, type);
        if (defect === 'changed-branch' || defect === 'detached-head') {
          const args = defect === 'changed-branch' ? ['symbolic-ref', 'HEAD', 'refs/heads/other'] : ['checkout', '-q', '--detach'];
          const changed = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' });
          assert.ifError(changed.error);
          assert.equal(changed.status, 0, changed.stderr);
        } else if (defect === 'unregistered-root') {
          const projectsPath = join(f.confRoot, 'projects.json');
          const projects = JSON.parse(await readFile(projectsPath, 'utf8'));
          delete projects.projects.orchestrator;
          await writeFile(projectsPath, JSON.stringify(projects));
        } else {
          const settingsPath = join(f.confRoot, 'raf.json');
          const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
          settings.runnerProtocols[0].navigation = settings.runnerProtocols[0].navigation.filter((row: { state: string }) => row.state !== 'workspace_trust_required');
          await writeFile(settingsPath, JSON.stringify(settings));
        }
        await assert.rejects(f.launch(), /RUNNER_WORKSPACE_UNTRUSTED/);
        assert.deepEqual(await f.inputs(), []);
        assert.equal(await readFile(f.paths.accepted, 'utf8').catch(() => null), null);
        await f.configsUnchanged();
      });
    }
  }
}

for (const runner of ['codex', 'claude'] as const) {
  test(`[workspace-trust] ${runner}: registered branch directory — raf confirms the trust prompt with protocol navigation keys and the launch continues`, async t => {
    const f = await trustFixture(t, runner, 'registered');
    const started = await f.launch();
    const answered = (await f.inputs()).filter(row => row.trusting).map(row => row.data).join('');
    const navigation = f.settings.navigation.find(item => item.state === 'workspace_trust_required');
    assert.ok(navigation, `conf/raf.json#/runnerProtocols/${runner}/navigation must define the workspace_trust_required confirmation`);
    const expected = navigation.keys.map(key => key === 'Enter' ? '\r' : key).join('');
    assert.equal(answered, expected, 'trust confirmation must be exactly the configured navigation keys');
    const accepted = JSON.parse(await readFile(f.paths.accepted, 'utf8'));
    assert.equal(accepted.brief, f.request.brief);
    assert.equal(started.identity.pid, Number(await readFile(f.paths.pid, 'utf8')));
    assert.equal(f.session()?.state, 'running');
    await f.configsUnchanged();
  });

  test(`[workspace-trust] ${runner}: trust prompt that stays after the confirmation keys — RUNNER_WORKSPACE_UNTRUSTED without a second answer`, async t => {
    const f = await trustFixture(t, runner, 'registered', true);
    const failure = await f.launch().then(() => assert.fail('a trust prompt that does not go away must fail'), (error: unknown) => error as Error);
    assert.match(String(failure.message), /RUNNER_WORKSPACE_UNTRUSTED/);
    const navigation = f.settings.navigation.find(item => item.state === 'workspace_trust_required');
    assert.ok(navigation);
    const answered = (await f.inputs()).map(row => row.data).join('');
    assert.equal(answered, navigation.keys.map(key => key === 'Enter' ? '\r' : key).join(''), 'confirmation is sent exactly once');
    assert.equal(await readFile(f.paths.accepted, 'utf8').catch(() => null), null);
    await f.configsUnchanged();
  });

  for (const placement of ['unregistered', 'outside-symlink', 'subdirectory'] as const) {
    test(`[workspace-trust] ${runner}: ${placement} workspace — RUNNER_WORKSPACE_UNTRUSTED without answering the prompt`, async t => {
      const f = await trustFixture(t, runner, placement);
      const begun = Date.now();
      const failure = await f.launch().then(() => assert.fail('launch must refuse the workspace trust prompt'), (error: unknown) => error as Error);
      assert.match(String(failure.message), /RUNNER_WORKSPACE_UNTRUSTED/);
      assert.ok(Date.now() - begun < f.settings.timeouts.startupMs, 'refusal must happen before the readiness deadline');
      assert.deepEqual(await f.inputs(), [], 'raf must not answer the trust prompt outside registered branch directories');
      const runnerPid = Number(await readFile(f.paths.pid, 'utf8'));
      await eventually(() => alive(runnerPid), value => value === false, 'runner on the refused trust prompt stopped');
      await f.services.compensate(f.runtimeLaunch, failure);
      await f.services.abortLaunch(f.runId, failure.message);
      assert.deepEqual(listTaskReservations(f.store), []);
      await f.configsUnchanged();
    });
  }
}
