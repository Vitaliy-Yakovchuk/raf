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
assert.ok(path.isAbsolute(process.env.CODEX_HOME ?? ''), 'Existing CODEX_HOME auth selector required');
assert.ok(path.isAbsolute(process.env.GIT_CONFIG_GLOBAL ?? ''), 'Existing GIT_CONFIG_GLOBAL selector required');
process.umask(0o077);
const stand = fs.mkdtempSync('/srv/dev/mr105-');
const root = path.join(stand, 'root'), ev = path.join(stand, 'ev');
const main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop');
const mainSocket = path.join(stand, 'main.sock');
for (const file of [root, ev, path.join(stand, 'commands')]) fs.mkdirSync(file, { recursive: true });
const env = { ...process.env, HOME: stand, RAF_QA_HOME: stand, TMPDIR: stand, TMUX_TMPDIR: stand,
  XDG_CONFIG_HOME: path.join(stand, '.config'), LC_ALL: 'C', LANG: 'C.UTF-8' };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL' ||
  key.startsWith('RAF_') && key !== 'RAF_QA_HOME' || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
const summary = { assignment: 'complete-raf-flow-contracts:10.5', reviewed, stand, evidence: ev,
  startedAt: new Date().toISOString(), status: 'failed', checks: [], commands: [],
  limitations: ['Actual installed CLIs only; no mocks, auth copies, quota exhaustion or model-policy changes.',
    'HOME/XDG state is isolated. Existing explicit auth selectors are inherited; missing auth is an unexecuted prerequisite.',
    'One launch per runner; failed/unknown launches are never repeated. Sequential launches do not prove automatic model handoff.',
    'This script does not prove I5 atomic report negative cases or L4 automatic handoff after a genuine limit.'],
  unexecuted: ['L4: requires a genuine limit/refusal and an available alternative with a confirmed predecessor exit; no synthetic exhaustion.'],
  cleanup: { complete: false, errors: [] } };
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const json = file => JSON.parse(fs.readFileSync(file));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let seq = 0, mainStarted = false;
const run = (label, exe, args, cwd = root, budget = 120000, environment = env) => {
  const startedAt = new Date().toISOString();
  const r = spawnSync(exe, args, { cwd, env: environment, encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024 });
  const result = { command: [exe, ...args], cwd, startedAt, endedAt: new Date().toISOString(), cliExitCode: r.status,
    signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (label.startsWith('identity-')) result.stdout = '[identity verified; private value omitted]\n';
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(ev, label + '.' + stream), result[stream]);
  atomic(path.join(ev, label + '.json'), result); summary.commands.push({ label, cliExitCode: r.status, signal: r.signal });
  return result;
};
const must = r => { assert.equal(r.error, null); assert.equal(r.signal, null); assert.equal(r.cliExitCode, 0, r.stderr); return r.stdout.trim(); };
const git = (cwd, ...args) => must(run('git-' + (++seq), 'git', ['--no-optional-locks', '-C', cwd, ...args], cwd));
const wait = async (label, read, budget = 600000) => {
  const end = Date.now() + budget;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(500); }
  throw Error('Unexecuted: ' + label);
};
const request = async (label, args, budget = 600000) => {
  const target = path.join(ev, label + '.json'); assert.ok(!fs.existsSync(target), 'Never repeat an unknown command');
  atomic(path.join(stand, 'commands', String(++seq).padStart(5, '0') + '.json'), { label, args, budget });
  return wait(label, () => fs.existsSync(target) && json(target), budget + 10000);
};
const sessions = () => {
  const file = path.join(stand, '.raf/state.sqlite'); if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload)); } finally { db.close(); }
};
const own = actor => path.dirname(actor.launchContext.reportPath);
const pidIdentity = actor => {
  const stat = fs.readFileSync('/proc/' + actor.process.pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  assert.ok(!['Z', 'X'].includes(fields[0]), 'Native actor must be alive');
  return { pid: actor.process.pid, startTicks: fields[19], bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
};
const close = async actor => must(await request('close-' + actor.addressId + '-' + (++seq), ['agent', 'close', '--id', actor.addressId, '--force', '--reason', 'Own isolated model routing QA cleanup'], 60000));
console.log(JSON.stringify({ stand, evidence: ev, reviewed }));
try {
  for (const field of ['user.name', 'user.email']) {
    const checked = run('identity-' + field.replace('.', '-'), 'git', ['config', '--get', field], '/tmp', 30000, process.env);
    assert.equal(checked.cliExitCode, 0); assert.equal(checked.error, null);
  }
  assert.equal(git(source, 'rev-parse', reviewed + '^{commit}'), reviewed);
  summary.versions = Object.fromEntries(['node', 'git', 'tmux', 'codex', 'grok', 'agy', 'claude'].map(exe => {
    const r = run('version-' + exe, exe, [exe === 'tmux' ? '-V' : '--version']);
    return [exe, { cliExitCode: r.cliExitCode, stdout: r.stdout, stderr: r.stderr, error: r.error }];
  }));
  summary.configuration = Object.fromEntries(['raf-constants.json', 'raf.json', 'projects.json', 'flow.json', 'models.json', 'test-runs.json'].map(file => [file, hash(path.join(source, '../conf', file))]));
  fs.cpSync(path.join(source, '../conf'), path.join(root, 'conf'), { recursive: true });
  const projectFile = path.join(root, 'conf/projects.json'), projects = json(projectFile);
  Object.assign(projects.projects.raf, { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' }, mainCopies: ['raf-main-a', 'raf-main-b'] });
  atomic(projectFile, projects);
  const settingsFile = path.join(root, 'conf/raf.json'), settings = json(settingsFile);
  summary.trust = configureLiveCodexTrust(settings, root); atomic(settingsFile, settings);
  summary.modelRoutingUnchanged = hash(path.join(root, 'conf/models.json')) === summary.configuration['models.json'];
  must(run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main]));
  git(main, 'checkout', '-B', 'main', reviewed);
  fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
  must(run('build', 'npm', ['run', 'build'], main));
  git(root, 'init', '-b', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main');
  git(root, 'submodule', 'absorbgitdirs');
  git(main, 'worktree', 'add', '-B', 'develop', develop, 'HEAD');
  git(main, 'worktree', 'add', '-b', 'hotfix', path.join(root, 'raf-hotfix'), 'HEAD');
  const change = path.join(root, 'openspec/changes/mr105-fixture'); fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nControlled native model routing QA.\n\n## What Changes\nIsolated fixture markers.\n\n## Non-goals\nNo operational task or routing changes.\n');
  const runners = ['codex', 'grok', 'agy', 'claude'];
  fs.writeFileSync(path.join(change, 'tasks.md'), runners.map((runner, i) => `- [ ] 1.${i + 1} Controlled live QA actor. Execute exactly one native sandbox tool command: node scripts/qa-model-routing-actor.mjs ${runner} <your exact report_path>. The reviewed helper is authorized to wait for the host release, create and commit one fixture marker in raf-develop, and atomically write your final report. Do not edit the helper, tasks, configuration, model or effort; do not run tests, archive or invoke raf. Preserve failure evidence. Keep the native session alive after completion for host observation.\n`).join('') + '- [ ] 1.5 Keep fixture active for host cleanup.\n');
  git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'openspec');
  git(root, 'commit', '-m', 'qa: isolated native model routing stand');
  const layout = await import(pathToFileURL(path.join(main, 'src/main-layout.ts')));
  await layout.ensureMainLayoutForStart({ root, projects: { raf: projects.projects.raf } });
  for (const slot of [path.join(root, 'raf-main-b'), develop, path.join(root, 'raf-hotfix')]) for (const file of ['node_modules', 'dist']) fs.cpSync(path.join(main, file), path.join(slot, file), { recursive: true, dereference: true });
  for (const endpoint of [mainSocket, path.join(stand, '.raf/service.sock'), path.join(stand, '.raf/tmp/tmux/server.sock')]) assert.ok(Buffer.byteLength(endpoint) <= 107);
  must(run('main-start', 'tmux', ['-u', '-S', mainSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'mr105-main', '-x', '180', '-y', '50', process.execPath, path.join(main, 'scripts/qa-model-routing-main.mjs'), stand]));
  mainStarted = true;
  must(await wait('main attach', () => fs.existsSync(path.join(stand, 'main-ready.json')) && json(path.join(stand, 'main-ready.json')), 60000));
  must(await request('runner-list-initial', ['runner', 'list']));
  must(await request('service-start', ['service', 'start']));
  for (const [index, runner] of runners.entries()) {
    const check = { runner, status: 'failed', prerequisite: 'unknown', evidence: [] }; summary.checks.push(check);
    try {
      for (const other of runners) must(await request('disable-' + runner + '-' + other, ['runner', 'disable', '--runner', other]));
      must(await request('enable-' + runner, ['runner', 'enable', '--runner', runner]));
      const limits = await request('limits-' + runner, ['runner', 'limits', '--runners', runner], 120000);
      check.evidence.push('limits-' + runner + '.json');
      check.prerequisite = limits.cliExitCode === 0 ? 'quota-collected; inspect individual pools' : 'auth/quota prerequisite not confirmed; inspect exact refusal';
      const launched = await request('launch-' + runner, ['agent', 'run', '--id', 'mr105-' + runner, '--type', 'implement', '--project', 'raf', '--features', 'mr105-fixture', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'mr105-fixture:1.' + (index + 1)]);
      check.evidence.push('launch-' + runner + '.json'); must(launched);
      const actor = await wait('registered ' + runner, () => sessions().find(row => row.addressId === 'mr105-' + runner && row.state === 'running'), 30000);
      atomic(path.join(ev, runner + '-session.json'), actor);
      assert.equal(actor.launchContext.selection.runner, runner); assert.ok(actor.launchContext.selection.model && actor.launchContext.selection.effort);
      assert.ok(actor.process.runnerSessionId && actor.process.evidence.tmuxSocket && actor.process.evidence.tmuxPane);
      const briefHash = hash(actor.launchContext.briefPath);
      await wait('native helper ' + runner, () => fs.existsSync(path.join(own(actor), 'mr105-ready.json')));
      const before = sessions().find(row => row.runId === actor.runId), identity = pidIdentity(actor);
      must(await request('disable-live-' + runner, ['runner', 'disable', '--runner', runner]));
      const afterDisable = sessions().find(row => row.runId === actor.runId);
      for (const key of ['runId', 'addressId', 'state', 'process', 'launchContext', 'activity']) assert.deepEqual(afterDisable[key], before[key]);
      assert.deepEqual(pidIdentity(actor), identity);
      assert.equal(hash(actor.launchContext.briefPath), briefHash);
      const blocked = await request('blocked-' + runner, ['agent', 'run', '--id', 'mr105-blocked-' + runner, '--type', 'implement', '--project', 'raf', '--features', 'mr105-fixture', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'mr105-fixture:1.' + (index + 1)]);
      assert.equal(blocked.signal, null); assert.ok(Number.isInteger(blocked.cliExitCode) && blocked.cliExitCode !== 0);
      assert.ok(!sessions().some(row => row.addressId === 'mr105-blocked-' + runner));
      atomic(path.join(ev, runner + '-disable-observation.json'), { runId: actor.runId, identity, before, after: sessions().find(row => row.runId === actor.runId), briefHash, blocked: 'blocked-' + runner + '.json' });
      atomic(path.join(own(actor), 'mr105-release.json'), { release: true });
      await wait('report ' + runner, () => fs.existsSync(actor.launchContext.reportPath));
      const accepted = await wait('report acceptance ' + runner, async () => {
        must(await request('accept-' + runner + '-' + (++seq), ['agent', 'ps'], 120000));
        const row = sessions().find(row => row.runId === actor.runId);
        if (row?.result?.status === 'failed') throw Error('Report rejected: inspect session');
        return row?.reportAcceptance?.status === 'succeeded' && row;
      }, 120000);
      atomic(path.join(ev, runner + '-accepted.json'), accepted);
      fs.cpSync(own(actor), path.join(ev, runner + '-run'), { recursive: true, filter: file => { const s = fs.lstatSync(file); return s.isDirectory() || s.isFile(); } });
      check.status = 'passed'; check.runId = actor.runId; check.selection = actor.launchContext.selection;
      check.evidence.push(runner + '-session.json', runner + '-disable-observation.json', runner + '-accepted.json', runner + '-run');
    } catch (error) { check.error = error.stack; }
    finally {
      for (const actor of sessions().filter(row => row.addressId.startsWith('mr105-') && row.state !== 'finished')) await close(actor);
      atomic(path.join(ev, 'progress.json'), summary);
    }
  }
} catch (error) { summary.error = error.stack; }
finally {
  if (mainStarted) {
    for (const actor of sessions().filter(row => row.addressId.startsWith('mr105-') && row.state !== 'finished')) {
      try { await close(actor); } catch (error) { summary.cleanup.errors.push(error.message); }
    }
    try { must(await request('cleanup-service', ['service', 'stop'], 60000)); } catch (error) { summary.cleanup.errors.push(error.message); }
  }
  try { summary.cleanup.services = await stopStandServices(root); } catch (error) { summary.cleanup.errors.push(error.message); }
  for (const socket of [mainSocket, path.join(stand, '.raf/tmp/tmux/server.sock')]) {
    try {
      if (!fs.existsSync(socket)) continue;
      const identity = fs.lstatSync(socket); assert.ok(identity.isSocket());
      run('cleanup-kill-' + (++seq), 'tmux', ['-S', socket, 'kill-server']);
      const inspected = await wait('owned tmux exit', () => { const r = run('cleanup-inspect-' + (++seq), 'tmux', ['-S', socket, 'list-sessions']); return r.cliExitCode !== 0 && r; }, 15000);
      assert.match(inspected.stderr, /no server running|No such file/);
      if (fs.existsSync(socket)) { const current = fs.lstatSync(socket); assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev); fs.unlinkSync(socket); }
    } catch (error) { summary.cleanup.errors.push(error.message); }
  }
  summary.cleanup.complete = summary.cleanup.errors.length === 0;
  summary.unexecuted.push(...['codex', 'grok', 'agy', 'claude'].filter(runner => !summary.checks.some(check => check.runner === runner && check.status === 'passed')).map(runner => 'L1/L2 native completion: ' + runner));
  summary.status = !summary.error && summary.cleanup.complete && !summary.unexecuted.length ? 'passed' : 'failed';
  summary.endedAt = new Date().toISOString(); atomic(path.join(ev, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, stand, evidence: ev, error: summary.error ?? null, cleanup: summary.cleanup, unexecuted: summary.unexecuted }));
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}
