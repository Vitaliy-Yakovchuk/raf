import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configureLiveCodexTrust } from '../test/helpers/z4044-live-trust.mjs';
import { stopStandServices } from './qa-main-agent-channel-metadata.mjs';

const source = path.resolve(import.meta.dirname, '..');
const reviewed = process.argv[2];
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.ok(path.isAbsolute(process.env.CODEX_HOME ?? ''), 'Existing CODEX_HOME auth selector required; no credential copying');
process.umask(0o077);
const stand = fs.mkdtempSync('/srv/dev/cfc97-');
const root = path.join(stand, 'root'), ev = path.join(stand, 'ev');
const main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop');
const product = path.join(root, 'etchly-develop'), library = path.join(root, 'shared-libs-develop');
const mainSocket = path.join(stand, 'main.sock');
for (const p of [root, ev, path.join(stand, 'commands')]) fs.mkdirSync(p, { recursive: true });
const gitConfig = path.join(stand, 'gitconfig');
fs.writeFileSync(gitConfig, '[user]\n name = CFC97 QA\n email = cfc97@example.invalid\n');
const env = { ...process.env, HOME: stand, RAF_QA_HOME: stand, TMPDIR: stand, TMUX_TMPDIR: stand,
  XDG_CONFIG_HOME: path.join(stand, '.config'), GIT_CONFIG_GLOBAL: gitConfig, LC_ALL: 'C', LANG: 'C.UTF-8' };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL' ||
  key.startsWith('RAF_') && key !== 'RAF_QA_HOME' || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'NODE_PATH', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
const summary = { assignment: 'complete-raf-flow-contracts:9.7', status: 'failed', reviewed, stand, evidence: ev,
  startedAt: new Date().toISOString(), checks: [], commands: [], cleanup: { complete: false, errors: [] },
  limitations: ['Native runner, model and effort are selected by unchanged production model routing. No mock runner or auth files are copied.',
    'Only isolated fixture repositories/tasks/state are changed. This stand does not test real product behavior or resource pressure.'] };
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const json = file => JSON.parse(fs.readFileSync(file));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let seq = 0, mainStarted = false;
const actors = [];
const run = (label, exe, args, cwd = root, budget = 120000) => {
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024 });
  const result = { command: [exe, ...args], cwd, cliExitCode: r.status, signal: r.signal,
    error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(ev, label + '.' + stream), result[stream]);
  atomic(path.join(ev, label + '.json'), result); summary.commands.push({ label, cliExitCode: r.status, signal: r.signal });
  return result;
};
const must = r => { assert.equal(r.error, null); assert.equal(r.signal, null); assert.equal(r.cliExitCode, 0, r.stderr); return r.stdout.trim(); };
const git = (cwd, ...args) => must(run('git-' + (++seq), 'git', ['--no-optional-locks', '-C', cwd, ...args], cwd));
const wait = async (label, read, budget = 900000) => {
  const end = Date.now() + budget;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(500); }
  throw Error('Unexecuted: ' + label);
};
const request = async (label, args, budget = 900000) => {
  const target = path.join(ev, label + '.json'); assert.ok(!fs.existsSync(target), 'Never repeat an unknown command');
  atomic(path.join(stand, 'commands', String(++seq).padStart(5, '0') + '.json'), { label, args, budget });
  const result = await wait(label, () => fs.existsSync(target) && json(target), budget + 10000);
  summary.commands.push({ label, cliExitCode: result.cliExitCode, signal: result.signal }); return result;
};
const sessions = () => {
  const file = path.join(stand, '.raf/state.sqlite'); if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload)); } finally { db.close(); }
};
const own = actor => path.dirname(actor.launchContext.reportPath);
const item = mode => `Controlled live QA actor for shared-libs ${mode}. Execute exactly one native sandbox tool command: node qa/cfc97-actor.mjs ${mode} <your exact report_path>. The reviewed helper is authorized to create one fixture marker and commit it only in ${mode === 'dependent' ? 'shared-libs-develop' : 'etchly-develop'}, write probe evidence and your final JSON report. For independent it additionally attempts four writes expected to be denied in the existing shared-libs tree and Git directories; never grant permissions or retry. Do not edit the helper, run tests, change tasks, archive, change model/effort or invoke raf. Preserve the helper exit/output. After it completes keep the session alive for host acceptance and cleanup. If it fails stop and preserve evidence; do not invent a succeeded report.`;
console.log(JSON.stringify({ stand, evidence: ev, reviewed }));
try {
  assert.equal(git(source, 'rev-parse', 'HEAD'), reviewed);
  assert.equal(git(source, 'status', '--porcelain'), '', 'Use a clean clone at the reviewed SHA');
  summary.versions = Object.fromEntries([['node', ['--version']], ['git', ['--version']], ['tmux', ['-V']], ['codex', ['--version']], ['bwrap', ['--version']], ['uname', ['-a']]].map(([exe, args]) => [exe, must(run('version-' + exe, exe, args))]));
  summary.configuration = Object.fromEntries(['raf-constants.json', 'raf.json', 'projects.json', 'flow.json', 'models.json', 'test-runs.json'].map(file => [file, hash(path.join(source, '../conf', file))]));
  fs.cpSync(path.join(source, '../conf'), path.join(root, 'conf'), { recursive: true });
  const projectFile = path.join(root, 'conf/projects.json'), projects = json(projectFile);
  for (const name of ['raf', 'etchly', 'shared-libs']) Object.assign(projects.projects[name], {
    path: name + '-main', branchPaths: { main: name + '-main', develop: name + '-develop', ...(name === 'raf' ? { hotfix: 'raf-hotfix' } : {}) },
    usesSharedLibs: name === 'etchly', ...(name === 'raf' ? { mainCopies: ['raf-main-a', 'raf-main-b'] } : {}) });
  atomic(projectFile, projects);
  const settingsFile = path.join(root, 'conf/raf.json'), settings = json(settingsFile);
  summary.trust = configureLiveCodexTrust(settings, root);
  const protocol = settings.runnerProtocols.find(row => row.runner === 'codex');
  const extraTrust = 'projects={' + [...summary.trust.gitRoots, product, library].map(directory => `${JSON.stringify(directory)}={trust_level="trusted"}`).join(',') + '}';
  assert.equal(protocol.baseArgs.at(-1), summary.trust.overrides[0]);
  protocol.baseArgs[protocol.baseArgs.length - 1] = extraTrust; atomic(settingsFile, settings);
  summary.fixtureConfiguration = { projects: projects.projects.etchly, extraTrust, resourcePolicyUnchanged: true, modelRoutingUnchanged: true };
  must(run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main]));
  git(main, 'checkout', '-B', 'main', reviewed);
  fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
  must(run('build', 'npm', ['run', 'build'], main));
  git(root, 'init', '-b', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main');
  git(root, 'submodule', 'absorbgitdirs');
  git(main, 'worktree', 'add', '-B', 'develop', develop, 'HEAD');
  git(main, 'worktree', 'add', '-b', 'hotfix', path.join(root, 'raf-hotfix'), 'HEAD');
  for (const name of ['etchly', 'shared-libs']) {
    const repository = path.join(root, name + '-main'); fs.mkdirSync(repository);
    git(repository, 'init', '-b', 'main'); fs.writeFileSync(path.join(repository, 'fixture.txt'), name + '\n');
    if (name === 'etchly') {
      fs.mkdirSync(path.join(repository, 'qa')); fs.copyFileSync(path.join(source, 'scripts/qa-shared-libs-actor.mjs'), path.join(repository, 'qa/cfc97-actor.mjs'));
      fs.symlinkSync('../shared-libs-develop', path.join(repository, 'shared-libs'));
    }
    git(repository, 'add', '--', 'fixture.txt', ...(name === 'etchly' ? ['qa/cfc97-actor.mjs', 'shared-libs'] : []));
    git(repository, 'commit', '-m', 'qa: isolated shared-libs repository');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './' + name + '-main', name + '-main');
    git(root, 'submodule', 'absorbgitdirs');
    git(repository, 'worktree', 'add', '-b', 'develop', path.join(root, name + '-develop'), 'HEAD');
  }
  const change = path.join(root, 'openspec/changes/cfc97-fixture'); fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nControlled shared-libs sandbox QA.\n\n## What Changes\nIsolated fixture markers.\n\n## Non-goals\nNo real product changes.\n');
  fs.writeFileSync(path.join(change, 'tasks.md'), `- [ ] 1.1 ${item('dependent')}\n- [ ] 1.2 ${item('independent')}\n- [ ] 1.3 Keep stand active for host cleanup.\n`);
  git(root, 'add', '--', '.gitmodules', 'raf-main', 'etchly-main', 'shared-libs-main', 'conf', 'openspec');
  git(root, 'commit', '-m', 'qa: isolated shared-libs orchestrator');
  const layout = await import(pathToFileURL(path.join(main, 'src/main-layout.ts')));
  await layout.ensureMainLayoutForStart({ root, projects: { raf: projects.projects.raf } });
  for (const slot of [path.join(root, 'raf-main-b'), develop, path.join(root, 'raf-hotfix')]) for (const file of ['node_modules', 'dist']) fs.cpSync(path.join(main, file), path.join(slot, file), { recursive: true, dereference: true });
  summary.layout = { main: fs.realpathSync(main), develop, product, library, libraryGit: git(library, 'rev-parse', '--absolute-git-dir'), libraryCommon: git(library, 'rev-parse', '--path-format=absolute', '--git-common-dir') };
  for (const endpoint of [mainSocket, path.join(stand, '.raf/service.sock'), path.join(stand, '.raf/tmp/tmux/server.sock')]) assert.ok(Buffer.byteLength(endpoint) <= 107);
  must(run('main-start', 'tmux', ['-u', '-S', mainSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'cfc97-main', '-x', '180', '-y', '50', process.execPath, path.join(source, 'scripts/qa-shared-libs-main.mjs'), stand]));
  mainStarted = true;
  must(await wait('main attach', () => fs.existsSync(path.join(stand, 'main-ready.json')) && json(path.join(stand, 'main-ready.json'))));
  must(await request('runner-list', ['runner', 'list']));
  must(await request('runner-limits', ['runner', 'limits', '--runners', 'codex']));
  must(await request('service-start', ['service', 'start']));
  for (const [mode, taskId, dependent] of [['dependent', '1.1', true], ['independent', '1.2', false]]) {
    if (!dependent) {
      projects.projects.etchly.usesSharedLibs = false; atomic(projectFile, projects);
      git(root, 'add', '--', 'conf/projects.json'); git(root, 'commit', '-m', 'qa: independent etchly fixture');
    }
    const beforeLibrary = git(library, 'rev-parse', 'HEAD');
    const launched = await request('launch-' + mode, ['agent', 'run', '--id', 'cfc97-' + mode, '--type', 'implement', '--project', 'etchly', '--features', 'cfc97-fixture', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'cfc97-fixture:' + taskId]);
    must(launched);
    const actor = await wait('registered ' + mode, () => sessions().find(row => row.addressId === 'cfc97-' + mode && row.state === 'running'));
    actors.push(actor); atomic(path.join(ev, mode + '-session.json'), actor);
    assert.equal(actor.activity.cwd, product);
    assert.ok(actor.process?.runnerSessionId && actor.process.pid, 'Real native identity required');
    const contract = actor.reportedCommits;
    assert.ok(contract?.repositories); assert.equal(contract.repositories.some(row => row.repositoryRoot === library), dependent);
    for (const directory of [library, summary.layout.libraryGit, summary.layout.libraryCommon]) assert.equal(contract.writeBoundaries.includes(directory), dependent, directory);
    const probeFile = path.join(own(actor), 'cfc97-probe.json');
    const probe = await wait('sandbox probe ' + mode, () => fs.existsSync(probeFile) && json(probeFile));
    atomic(path.join(ev, mode + '-probe.json'), probe); assert.equal(probe.status, 'passed', probe.error);
    assert.equal(probe.commit.repository, dependent ? library : product);
    const accepted = await wait('reported commit acceptance ' + mode, async () => {
      const row = sessions().find(row => row.runId === actor.runId);
      if (row?.result?.status === 'failed') throw Error(JSON.stringify(row.result));
      if (row?.reportAcceptance?.status === 'succeeded') return row;
      must(await request('accept-' + mode + '-' + (++seq), ['agent', 'ps'], 120000));
      return false;
    });
    atomic(path.join(ev, mode + '-accepted.json'), accepted);
    assert.deepEqual(accepted.result.report.commits, [probe.commit]);
    assert.ok(accepted.result.checkboxCommits?.length, 'Raf checkbox commit required');
    assert.match(fs.readFileSync(path.join(change, 'tasks.md'), 'utf8'), new RegExp('^- \\[x\\] ' + taskId.replace('.', '\\.') + ' ', 'm'));
    assert.equal(git(probe.commit.repository, 'show', '--format=', '--name-only', probe.commit.sha), 'qa-cfc97-' + mode + '.txt');
    if (!dependent) assert.equal(git(library, 'rev-parse', 'HEAD'), beforeLibrary);
    fs.cpSync(own(actor), path.join(ev, mode + '-run'), { recursive: true, filter: file => { const stat = fs.lstatSync(file); return stat.isDirectory() || stat.isFile(); } });
    summary.checks.push({ id: mode, status: 'passed', runId: actor.runId, process: actor.process,
      reportedCommit: probe.commit, reportAcceptance: accepted.reportAcceptance, checkboxCommits: accepted.result.checkboxCommits, denials: probe.denials });
    atomic(path.join(ev, 'progress.json'), summary);
    must(await request('close-' + mode, ['agent', 'close', '--id', actor.addressId, '--force', '--reason', 'Own isolated shared-libs QA actor completed']));
  }
} catch (error) { summary.error = error.stack; }
finally {
  if (mainStarted) {
    for (const actor of sessions().filter(row => row.addressId.startsWith('cfc97-') && row.state !== 'finished')) {
      if (!actors.some(row => row.runId === actor.runId)) actors.push(actor);
      try { must(await request('cleanup-' + actor.addressId, ['agent', 'close', '--id', actor.addressId, '--force', '--reason', 'Own isolated shared-libs QA cleanup'], 60000)); }
      catch (error) { summary.cleanup.errors.push(error.message); }
    }
    try { must(await request('cleanup-service', ['service', 'stop'], 60000)); } catch (error) { summary.cleanup.errors.push(error.message); }
  }
  try { summary.cleanup.services = await stopStandServices(root); } catch (error) { summary.cleanup.errors.push(error.message); }
  for (const socket of new Set([mainSocket, path.join(stand, '.raf/tmp/tmux/server.sock'), ...actors.map(row => row.process?.evidence?.tmuxSocket).filter(Boolean)])) {
    try {
      assert.ok(socket.startsWith(stand + '/'));
      const inspected = run('cleanup-inspect-' + (++seq), 'tmux', ['-S', socket, 'list-sessions']);
      if (inspected.cliExitCode === 0) must(run('cleanup-socket-' + (++seq), 'tmux', ['-S', socket, 'kill-server']));
      else assert.match(inspected.stderr, /no server running|No such file/);
    } catch (error) { summary.cleanup.errors.push(error.message); }
  }
  for (const actor of actors) if (actor.process?.pid) try {
    await wait('cleanup-pid-' + actor.process.pid, () => {
      try { return /\) [ZX] /.test(fs.readFileSync('/proc/' + actor.process.pid + '/stat', 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    }, 15000);
  } catch (error) { summary.cleanup.errors.push(error.message); }
  summary.cleanup.complete = summary.cleanup.errors.length === 0;
  summary.unexecuted = ['dependent', 'independent'].filter(id => !summary.checks.some(row => row.id === id));
  summary.status = !summary.error && summary.cleanup.complete && !summary.unexecuted.length ? 'passed' : 'failed';
  summary.endedAt = new Date().toISOString(); atomic(path.join(ev, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, stand, evidence: ev, error: summary.error ?? null, cleanup: summary.cleanup, unexecuted: summary.unexecuted }));
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}
