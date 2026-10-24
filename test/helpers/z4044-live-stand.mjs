import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const driverFile = fileURLToPath(import.meta.url);
const here = path.dirname(driverFile);
const source = path.resolve(here, '../..'), sourceRoot = path.dirname(source);
const sourceSha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw Error('Pass the exact reviewed raf-develop SHA');
const outerHome = process.argv[3];
assert.ok(outerHome && path.isAbsolute(outerHome) && outerHome === process.env.RAF_QA_HOME && outerHome === process.env.HOME && outerHome === process.env.TMPDIR, 'own isolated parent HOME required');
const standPrefix = path.join(outerHome, 'z4044-long-stand-');
const plannedStand = standPrefix + 'XXXXXX';
const minimumProbePath = path.join(plannedStand, '.raf/tmp', '00000000-0000-0000-0000-000000000000', '.codex-sandbox-probe-1.sock');
assert.ok(Buffer.byteLength(minimumProbePath) > 107, 'The absolute preflight socket must exceed Linux sun_path (107 pathname bytes)');
for (const socket of [path.join(plannedStand, 'main.sock'), path.join(plannedStand, '.raf/tmp/tmux/server.sock')]) {
  assert.ok(Buffer.byteLength(socket) <= 107, 'The stand control sockets must fit sun_path: ' + socket);
}
const stand = fs.mkdtempSync(standPrefix);
fs.chmodSync(stand, 0o700);
const root = path.join(stand, 'root'), main = path.join(root, 'raf-main'), hotfix = path.join(root, 'raf-hotfix'), develop = path.join(root, 'raf-develop');
const ev = path.join(stand, 'ev'), mainSocket = path.join(stand, 'main.sock');
for (const directory of [root, ev, path.join(stand, 'commands')]) fs.mkdirSync(directory, { recursive: true });
const codeHome = process.env.CODEX_HOME;
assert.ok(codeHome && path.isAbsolute(codeHome), 'explicit existing CODEX_HOME selector required; no auth copy');
const gitConfig = path.join(stand, 'gitconfig');
fs.writeFileSync(gitConfig, '[user]\n name = Z4044 QA\n email = z4044@example.invalid\n');
const env = { ...process.env, HOME: stand, RAF_QA_HOME: stand, TMPDIR: stand, CODEX_HOME: codeHome, GIT_CONFIG_GLOBAL: gitConfig, XDG_CONFIG_HOME: path.join(stand, '.config') };
for (const name of ['TMUX', 'TMUX_PANE', 'CLAUDE_CONFIG_DIR', 'RAF_ORCHESTRATOR_ROOT', 'RAF_STATE_DIRECTORY', 'RAF_SOCKET_PATH', 'ALLOW_MIGRATIONS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
const deadline = Date.now() + 1500000;
const summary = { status: 'failed', stand, standPrefix, sourceSha, driverSha256: createHash('sha256').update(fs.readFileSync(driverFile)).digest('hex'), longPathPreflight: [], startedAt: new Date().toISOString(), scenarios: {}, commands: [], cleanup: [], unitRuns: [], limitations: ['Host watchdog is not a unit timeout or a pass criterion.', 'Atomic activation belongs to Z.334.', 'No access to the working ~/.raf; live state schema is not inspected.'] };
let paneStarted = false, syntaxOriginal, fixtureMergeTarget;
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const hash = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const command = (label, exe, args, cwd = root, budget = 120000) => {
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: budget, maxBuffer: 32 * 1024 * 1024 });
  const result = { command: [exe, ...args], cwd, cliExitCode: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (label === 'git-author' || label === 'git-committer') {
    result.stdout = '[redacted]\n';
    result.stderr = result.stderr ? '[redacted]\n' : '';
  }
  fs.writeFileSync(path.join(ev, label + '.stdout'), result.stdout);
  fs.writeFileSync(path.join(ev, label + '.stderr'), result.stderr);
  atomic(path.join(ev, label + '.json'), result);
  summary.commands.push({ label, cliExitCode: result.cliExitCode, signal: result.signal });
  return result;
};
const must = result => { assert.equal(result.cliExitCode, 0, result.stderr || result.error); return result.stdout.trim(); };
let seq = 0;
const git = (cwd, ...args) => must(command(`git-${++seq}`, 'git', ['-C', cwd, ...args], cwd));
const wait = async (description, read, budget = 240000) => {
  const end = description.startsWith('cleanup-') ? Date.now() + budget : Math.min(deadline, Date.now() + budget);
  while (Date.now() < end) { const result = read(); if (result) return result; await delay(400); }
  throw Error('Unexecuted remainder: waiting for ' + description);
};
const request = async (label, args, budget = 240000) => {
  const resultFile = path.join(ev, label + '.json');
  assert.ok(!fs.existsSync(resultFile), 'Do not replay an unknown CLI result');
  atomic(path.join(stand, 'commands', `${String(++seq).padStart(4, '0')}.json`), { label, args, budget });
  const r = await wait(label, () => fs.existsSync(resultFile) && JSON.parse(fs.readFileSync(resultFile, 'utf8')), budget + 10000);
  summary.commands.push({ label, cliExitCode: r.cliExitCode, signal: r.signal });
  return r;
};
const state = label => {
  const dbPath = path.join(stand, '.raf/state.sqlite');
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
    const sessions = tables.includes('sessions') ? db.prepare('SELECT payload FROM sessions').all().map(x => JSON.parse(x.payload)) : [];
    if (label) {
      const data = { userVersion: db.prepare('PRAGMA user_version').get(), sessions };
      for (const table of ['result_notices', 'pending_events', 'pending_intents', 'domain_events']) if (tables.includes(table)) data[table] = db.prepare(`SELECT * FROM ${table}`).all();
      atomic(path.join(ev, label + '.json'), data);
    }
    return sessions;
  } finally { db.close(); }
};
const session = actor => state().find(x => x.addressId === `z331-${actor}` && x.state !== 'finished');
const copyRun = (actor, record) => {
  const directory = path.join(stand, '.raf/tmp', record.runId), destination = path.join(ev, `run-${actor}`);
  fs.mkdirSync(destination, { recursive: true });
  const copy = (from, to) => {
    try {
      if (!fs.existsSync(from)) return;
      if (fs.existsSync(to) && hash(from) === hash(to)) return;
      const target = fs.existsSync(to) ? to + '.snapshot-' + (++seq) : to;
      fs.copyFileSync(from, target);
    } catch (error) {
      (summary.evidenceCopyErrors ??= []).push({ from, to, code: error.code, message: error.message });
    }
  };
  for (const name of [`z331-${actor}.json`, 'probe.json', 'commit-result.json', 'worker-ready.json', 'hotfix-commit.mjs', 'brief.md']) copy(path.join(directory, name), path.join(destination, name));
  if (record.launchContext?.briefPath) copy(record.launchContext.briefPath, path.join(destination, 'delivered-brief.md'));
  atomic(path.join(destination, 'session.json'), record);
};
const recordLongPreflight = record => {
  const runDirectory = path.dirname(record.launchContext.reportPath);
  const minimumAbsoluteSocket = path.join(runDirectory, '.codex-sandbox-probe-1.sock');
  const evidence = { runId: record.runId, runDirectory, minimumAbsoluteSocket, minimumAbsoluteSocketBytes: Buffer.byteLength(minimumAbsoluteSocket), sunPathMaximumPathnameBytes: 107, launchSucceeded: true, workerProbeReached: true };
  assert.ok(runDirectory.startsWith(stand + path.sep), 'Preflight must use this long stand');
  assert.ok(evidence.minimumAbsoluteSocketBytes > 107, 'No shortened runDirectory is accepted');
  summary.longPathPreflight.push(evidence);
};
const gate = (record, name) => fs.writeFileSync(path.join(stand, '.raf/tmp', record.runId, name), name);
const actorArgs = (actor, item) => ['agent', 'run', '--id', `z331-${actor}`, '--type', 'hotfix', '--project', 'raf', '--features', 'z331-live-fixture', '--phase', 'hotfix', '--complexity', 'mechanical', '--tasks', `z331-live-fixture:${item}`];
const ownerSnapshot = () => ({ source: { head: must(command(`owner-source-${++seq}`, 'git', ['-C', source, 'rev-parse', 'HEAD'], source)), sourceHash: hash(path.join(source, 'src/production-runtime.ts')) } });
console.log(JSON.stringify({ stand, evidence: ev, sourceSha }));
try {
  assert.ok(path.isAbsolute(gitConfig) && fs.existsSync(gitConfig), 'Existing absolute Git identity selector required');
  summary.ownerBefore = ownerSnapshot();
  summary.codexConfigBefore = hash(path.join(codeHome, 'config.toml'));
  for (const [exe, args] of [['node', ['--version']], ['git', ['--version']], ['tmux', ['-V']], ['codex', ['--version']]]) must(command('version-' + exe, exe, args));
  must(command('version-os', 'uname', ['-a']));
  must(command('git-author', 'git', ['var', 'GIT_AUTHOR_IDENT'], stand));
  must(command('git-committer', 'git', ['var', 'GIT_COMMITTER_IDENT'], stand));
  fs.cpSync(path.join(sourceRoot, 'conf'), path.join(root, 'conf'), { recursive: true });
  const projectsPath = path.join(root, 'conf/projects.json'), projects = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
  projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator };
  projects.projects.raf.path = 'raf-main';
  projects.projects.raf.branchPaths = { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' };
  fs.writeFileSync(projectsPath, JSON.stringify(projects, null, 2) + '\n');
  summary.modelConfHash = hash(path.join(root, 'conf/models.json'));
  summary.flowConfHash = hash(path.join(root, 'conf/flow.json'));
  must(command('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main]));
  git(main, 'checkout', '-B', 'main', sourceSha);
  if (fs.existsSync(path.join(source, 'node_modules'))) fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
  must(command('build', 'npm', ['run', 'build'], main));
  fs.mkdirSync(path.join(main, 'qa'), { recursive: true });
  fs.copyFileSync(path.join(here, 'z4044-live-worker.mjs'), path.join(main, 'qa/z331-worker.mjs'));
  fs.writeFileSync(path.join(main, 'qa/conflict.txt'), 'baseline\n');
  git(main, 'add', '--', 'qa'); git(main, 'commit', '-m', 'qa: prepare Z331 isolated worker');
  git(root, 'init', '-b', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main');
  git(root, 'submodule', 'absorbgitdirs');
  const base = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', '-B', 'develop', develop, base);
  git(main, 'worktree', 'add', '-b', 'hotfix', hotfix, base);
  fs.writeFileSync(path.join(main, 'qa/main-refresh.txt'), 'new main before A\n');
  git(main, 'add', '--', 'qa/main-refresh.txt'); git(main, 'commit', '-m', 'qa: advance isolated main before launch');
  const refreshTarget = git(main, 'rev-parse', 'HEAD');
  const change = path.join(root, 'openspec/changes/z331-live-fixture'); fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nLive QA of shared hotfix.\n\n## What Changes\nTwo isolated worker commits and reports.\n\n## Non-goals\nNo product fixes or atomic activation.\n');
  const description = actor => `Isolated live QA worker ${actor}. This is a controlled fixture, no product implementation or unit runs. Execute only node qa/z331-worker.mjs ${actor} <the exact report_path from your brief> in your assigned cwd using the tool. The versioned helper probes only this isolated clone, invokes your assigned trusted commit port for your own qa/own-${actor}.json, waits host gates, then atomically writes your report. Do not write the report yourself, change tasks, archive, fix the helper or product, switch model/effort, run tests or git config/push. If the helper fails or times out, report the exact error in chat and wait for host; do not retry or bypass the commit port. Acknowledge messages in chat only. Model and effort are already chosen by raf.`;
  fs.writeFileSync(path.join(change, 'tasks.md'), `- [ ] 1.1 ${description('a')}\n- [ ] 1.2 ${description('b')}\n- [ ] 1.3 Host dirty/conflict refusal fixture; do not execute if unexpectedly launched.\n- [ ] 1.4 Keep fixture active; host owns cleanup.\n`);
  git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'openspec'); git(root, 'commit', '-m', 'qa: isolated Z331 orchestrator fixture');
  must(command('tmux-main-start', 'tmux', ['-S', mainSocket, 'new-session', '-d', '-s', 'z331-main', '-x', '180', '-y', '50', process.execPath, path.join(here, 'z4044-main-pane.mjs'), stand]));
  paneStarted = true;
  const attached = await wait('main attached', () => fs.existsSync(path.join(stand, 'main-ready.json')) && JSON.parse(fs.readFileSync(path.join(stand, 'main-ready.json'), 'utf8')));
  must(attached);
  must(await request('runner-list', ['runner', 'list']));
  must(await request('runner-limits', ['runner', 'limits', '--runners', 'codex']));
  must(await request('service-start', ['service', 'start']));
  const launchA = await request('launch-a', actorArgs('a', '1.1')); must(launchA);
  const a = await wait('session A', () => session('a'));
  await wait('worker A probe', () => fs.existsSync(path.join(stand, '.raf/tmp', a.runId, 'probe.json')));
  recordLongPreflight(a);
  summary.scenarios.refresh = { base, refreshTarget, hotfixHead: git(hotfix, 'rev-parse', 'HEAD'), included: command('refresh-ancestor', 'git', ['-C', hotfix, 'merge-base', '--is-ancestor', refreshTarget, 'HEAD']).cliExitCode === 0 };
  assert.equal(summary.scenarios.refresh.included, true);
  const ownAHash = hash(path.join(hotfix, 'qa/own-a.json')), headBeforeB = git(hotfix, 'rev-parse', 'HEAD');
  must(await request('launch-b', actorArgs('b', '1.2')));
  const b = await wait('session B', () => session('b'));
  await wait('worker B probe', () => fs.existsSync(path.join(stand, '.raf/tmp', b.runId, 'probe.json')));
  recordLongPreflight(b);
  summary.scenarios.parallel = { a, b, sameCwd: a.activity?.cwd === b.activity?.cwd && a.activity.cwd === hotfix, distinctRunIds: a.runId !== b.runId, distinctSessions: a.process?.runnerSessionId !== b.process?.runnerSessionId, distinctReports: a.launchContext?.reportPath !== b.launchContext?.reportPath };
  summary.scenarios.noop = { headBeforeB, headAfterB: git(hotfix, 'rev-parse', 'HEAD'), ownAUnchanged: ownAHash === hash(path.join(hotfix, 'qa/own-a.json')) };
  state('both-probes');
  for (const [actor, record] of [['a', a], ['b', b]]) {
    gate(record, 'commit-go');
    await wait('worker commit ' + actor, () => fs.existsSync(path.join(stand, '.raf/tmp', record.runId, 'worker-ready.json')));
    copyRun(actor, record);
  }
  syntaxOriginal = fs.readFileSync(path.join(hotfix, 'src/production-runtime.ts'));
  fs.writeFileSync(path.join(hotfix, 'src/production-runtime.ts'), 'export const broken = ;\n');
  const syntaxCheck = command('hotfix-syntax-error', process.execPath, ['--input-type=module', '--eval', 'await import(process.argv[1])', path.join(hotfix, 'src/production-runtime.ts')], hotfix);
  assert.equal(syntaxCheck.cliExitCode, 1);
  assert.match(syntaxCheck.stderr, /SyntaxError/, 'A setup failure is not the intended SyntaxError');
  summary.scenarios.syntaxIsolation = { syntaxCode: syntaxCheck.cliExitCode, liveMessage: (await request('syntax-message', ['agent', 'message', '--to', 'z331-b', '--text', 'Z331 isolation probe: acknowledge only; leave helper running.'])).cliExitCode, livePs: (await request('syntax-ps', ['agent', 'ps'])).cliExitCode, liveService: (await request('syntax-service', ['service', 'status'])).cliExitCode };
  fs.writeFileSync(path.join(hotfix, 'src/production-runtime.ts'), syntaxOriginal); syntaxOriginal = undefined;
  for (const [actor, record] of [['a', a], ['b', b]]) {
    gate(record, 'report-go');
    await wait('accepted report ' + actor, () => { const s = session(actor); return s?.result && s.reportAcceptance ? s : undefined; });
    const accepted = session(actor); copyRun(actor, accepted); state('accepted-' + actor);
    assert.equal(accepted.result.status, 'succeeded');
    assert.equal(accepted.reportAcceptance.status, 'succeeded');
    must(await request('close-' + actor, ['agent', 'close', '--id', 'z331-' + actor]));
    if (actor === 'a') {
      summary.scenarios.closeOne = { treeRetained: fs.existsSync(hotfix), registration: git(main, 'worktree', 'list', '--porcelain'), otherStillRunning: session('b')?.state === 'running', ownAHash: hash(path.join(hotfix, 'qa/own-a.json')), ownBHash: hash(path.join(hotfix, 'qa/own-b.json')) };
      assert.equal(summary.scenarios.closeOne.treeRetained && summary.scenarios.closeOne.otherStillRunning, true);
    }
  }
  fs.writeFileSync(path.join(main, 'qa/conflict.txt'), 'main-side\n'); git(main, 'add', '--', 'qa/conflict.txt'); git(main, 'commit', '-m', 'qa: main conflict side');
  fs.writeFileSync(path.join(hotfix, 'qa/dirty.txt'), 'foreign dirty must survive\n');
  const beforeDirty = git(hotfix, 'rev-parse', 'HEAD'), dirtyHash = hash(path.join(hotfix, 'qa/dirty.txt'));
  const dirty = await request('dirty-refusal', actorArgs('dirty', '1.3'));
  summary.scenarios.dirty = { cliExitCode: dirty.cliExitCode, headUnchanged: beforeDirty === git(hotfix, 'rev-parse', 'HEAD'), fileUnchanged: dirtyHash === hash(path.join(hotfix, 'qa/dirty.txt')), sessions: state('dirty-state') };
  assert.ok(dirty.cliExitCode !== 0 && dirty.cliExitCode !== null); assert.ok(summary.scenarios.dirty.headUnchanged && summary.scenarios.dirty.fileUnchanged);
  assert.match(dirty.stdout + dirty.stderr, /Dirty hotfix workspace\/index/i, 'A setup/quota refusal is not proof of the dirty guard');
  assert.ok(!summary.scenarios.dirty.sessions.find(x => x.addressId === 'z331-dirty')?.process, 'Dirty refusal must precede runner launch');
  fs.unlinkSync(path.join(hotfix, 'qa/dirty.txt'));
  for (const actor of ['a', 'b']) {
    const marker = path.join(hotfix, `qa/own-${actor}.json`);
    if (fs.existsSync(marker) && command(`tracked-${actor}`, 'git', ['-C', hotfix, 'ls-files', '--error-unmatch', `qa/own-${actor}.json`]).cliExitCode !== 0) {
      fs.copyFileSync(marker, path.join(ev, `uncommitted-own-${actor}.json`)); fs.unlinkSync(marker);
    }
  }
  assert.equal(git(hotfix, 'status', '--porcelain'), '', 'Do not hide unrelated dirty files for conflict case');
  fs.writeFileSync(path.join(hotfix, 'qa/conflict.txt'), 'hotfix-side\n'); git(hotfix, 'add', '--', 'qa/conflict.txt'); git(hotfix, 'commit', '-m', 'qa: hotfix conflict side');
  const beforeConflict = git(hotfix, 'rev-parse', 'HEAD');
  fixtureMergeTarget = git(main, 'rev-parse', 'HEAD');
  const conflict = await request('merge-conflict-refusal', actorArgs('conflict', '1.3'));
  summary.scenarios.conflict = { cliExitCode: conflict.cliExitCode, beforeConflict, afterConflict: git(hotfix, 'rev-parse', 'HEAD'), status: git(hotfix, 'status', '--porcelain'), mergeHead: git(hotfix, 'rev-parse', 'MERGE_HEAD'), unmerged: git(hotfix, 'ls-files', '--unmerged'), sessions: state('conflict-state') };
  assert.ok(conflict.cliExitCode !== 0 && conflict.cliExitCode !== null); assert.equal(summary.scenarios.conflict.afterConflict, beforeConflict);
  assert.equal(summary.scenarios.conflict.mergeHead, fixtureMergeTarget, 'The merge must target the current isolated main');
  const conflictStages = summary.scenarios.conflict.unmerged.trim().split('\n').map(line => /^(\d+) ([a-f0-9]{40}) ([123])\tqa\/conflict\.txt$/.exec(line));
  assert.equal(conflictStages.length, 3);
  assert.ok(conflictStages.every(Boolean), 'A setup/quota refusal is not proof of an unmerged Git index');
  assert.deepEqual(conflictStages.map(row => row[3]).sort(), ['1', '2', '3']);
  assert.ok(!summary.scenarios.conflict.sessions.find(x => x.addressId === 'z331-conflict')?.process, 'Conflict refusal must precede runner launch');
  git(hotfix, 'merge', '--abort'); fixtureMergeTarget = undefined;
  const ready = ['a', 'b'].map(actor => JSON.parse(fs.readFileSync(path.join(ev, `run-${actor}/worker-ready.json`), 'utf8')));
  assert.ok(ready.every(x => x.ok), 'Live workers did not prove successful own commits and enforced Git boundaries');
  assert.ok(Object.values(summary.scenarios.parallel).filter(x => typeof x === 'boolean').every(Boolean));
  assert.equal(summary.scenarios.noop.headBeforeB, summary.scenarios.noop.headAfterB); assert.ok(summary.scenarios.noop.ownAUnchanged);
  assert.ok(Object.entries(summary.scenarios.syntaxIsolation).filter(([k]) => k !== 'syntaxCode').every(([, v]) => v === 0));
  summary.status = 'succeeded';
} catch (error) {
  summary.error = error.stack || String(error);
  console.error(summary.error);
} finally {
  if (syntaxOriginal) fs.writeFileSync(path.join(hotfix, 'src/production-runtime.ts'), syntaxOriginal);
  if (fixtureMergeTarget) {
    const pending = command('cleanup-fixture-merge-head', 'git', ['-C', hotfix, 'rev-parse', '--verify', 'MERGE_HEAD']);
    if (pending.cliExitCode === 0 && pending.stdout.trim() === fixtureMergeTarget) {
      summary.cleanup.push({ step: 'abort-own-fixture-merge', cliExitCode: command('cleanup-fixture-merge-abort', 'git', ['-C', hotfix, 'merge', '--abort']).cliExitCode });
    }
  }
  try { state('before-cleanup'); } catch (error) { summary.cleanup.push({ step: 'snapshot', error: String(error) }); }
  if (paneStarted) {
    for (const record of state().filter(x => x.addressId !== 'main' && x.state !== 'finished')) {
      const actor = record.addressId.replace('z331-', '');
      try { copyRun(actor, record); }
      catch (error) { summary.cleanup.push({ step: 'copy-run', address: record.addressId, error: String(error) }); }
      try {
        const result = await request('cleanup-close-' + actor, ['agent', 'close', '--id', record.addressId, '--force', '--reason', 'Z331 isolated host cleanup; evidence saved before removal'], 60000);
        summary.cleanup.push({ step: 'close', address: record.addressId, cliExitCode: result.cliExitCode });
      } catch (error) { summary.cleanup.push({ step: 'close', address: record.addressId, error: String(error) }); }
    }
    try { summary.cleanup.push({ step: 'service-stop', cliExitCode: (await request('cleanup-service-stop', ['service', 'stop'], 60000)).cliExitCode }); } catch (error) { summary.cleanup.push({ step: 'service-stop', error: String(error) }); }
    summary.cleanup.push({ step: 'kill-agent-tmux', result: command('cleanup-agent-tmux', 'tmux', ['-S', path.join(stand, '.raf/tmp/tmux/server.sock'), 'kill-server']) });
    summary.cleanup.push({ step: 'kill-main-tmux', result: command('cleanup-main-tmux', 'tmux', ['-S', mainSocket, 'kill-server']) });
  }
  try { state('after-cleanup'); } catch (error) { summary.cleanup.push({ step: 'final-state', error: String(error) }); }
  summary.codexConfigAfter = hash(path.join(codeHome, 'config.toml'));
  summary.codexConfigChanged = summary.codexConfigAfter !== summary.codexConfigBefore;
  try { summary.ownerAfter = ownerSnapshot(); } catch (error) { summary.ownerSnapshotError = String(error); }
  summary.finishedAt = new Date().toISOString();
  summary.cleanup.push({ step: 'retain-isolated-clone-and-evidence', stand, hotfixExists: fs.existsSync(hotfix) });
  atomic(path.join(ev, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, stand, evidence: path.join(ev, 'summary.json'), error: summary.error ?? null }));
  process.exitCode = summary.status === 'succeeded' ? 0 : 1;
}
