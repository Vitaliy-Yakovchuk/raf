import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const evidence = import.meta.dirname;
const m = JSON.parse(fs.readFileSync(path.join(evidence, 'stand-I6.json')));
const base = m.I6Base ?? path.join(m.base, 'I6-fixed');
const liveHome = m.I6Home ?? path.join(base, 'home');
const main = path.join(m.root, 'raf-main');
const socket = path.join(base, 'main.sock');
const state = path.join(liveHome, '.raf/state.sqlite');
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RAF_') && !['TMUX', 'TMUX_PANE'].includes(k)));
Object.assign(env, { HOME: liveHome, RAF_QA_HOME: liveHome, RAF_ORCHESTRATOR_ROOT: m.root,
  CODEX_HOME: path.join(base, 'codex'), TMPDIR: path.join(base, 'tmp'), GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
function run(exe, args, cwd = m.root, timeout = 120000) {
  return spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
}
function must(exe, args, cwd) { const r = run(exe, args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function rows() {
  if (!fs.existsSync(state)) return null;
  const db = new DatabaseSync(state, { readOnly: true });
  try { return { timings: db.prepare('SELECT * FROM command_timings ORDER BY command').all(),
    sessions: db.prepare('SELECT payload FROM sessions').all().map(r => JSON.parse(r.payload)) }; } finally { db.close(); }
}
function command(label, args) {
  const before = rows(), started = performance.now();
  const argv = [path.join(main, 'bin/raf.ts'), ...args];
  const r = spawnSync(process.execPath, argv, { cwd: main, env: process.env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(evidence, label + '.stdout'), r.stdout ?? '');
  fs.writeFileSync(path.join(evidence, label + '.stderr'), r.stderr ?? '');
  const value = { command: [process.execPath, ...argv], cwd: main, cliExitCode: r.status, signal: r.signal,
    error: r.error?.message ?? null, wallMs: performance.now() - started, before, after: rows(), childExitCode: null };
  atomic(path.join(evidence, label + '.json'), value);
  return value;
}
if (process.argv[2] === 'actor') {
  const directory = path.dirname(process.argv[3]);
  atomic(path.join(directory, 'cfc44-ready.json'), { pid: process.pid, at: new Date().toISOString() });
  const gate = path.join(directory, 'cfc44-release');
  await new Promise(resolve => { const watcher = fs.watch(directory, () => { if (fs.existsSync(gate)) { watcher.close(); resolve(); } }); });
} else if (process.argv[2] === 'pane') {
  process.stdin.setRawMode?.(true); process.stdin.resume();
  atomic(path.join(base, 'ready.json'), command('I6-main-attach', ['main', 'attach']));
  setInterval(() => {
    const request = path.join(base, 'request.json');
    if (!fs.existsSync(request)) return;
    const value = JSON.parse(fs.readFileSync(request)); fs.renameSync(request, request + '.running');
    command(value.label, value.args); fs.renameSync(request + '.running', request + '.done');
  }, 100);
} else {
  const result = { status: 'unexecuted', productSha: m.sha, base, state, socket, notes: [
    'Separate HOME, CODEX_HOME and explicit tmux socket. Inherited runtime authentication variables retained without inspection or copying credentials.',
    'Native runner/model/effort selected by raf configuration; no payload emulator or model override.',
    'Integration readiness deadline is independent of unit timeout policy.'
  ] };
  let server = false;
  try {
    for (const directory of ['home', 'codex', 'tmp']) fs.mkdirSync(path.join(base, directory), { recursive: true });
    fs.mkdirSync(liveHome, { recursive: true });
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n name = CFC44 QA\n email = qa@example.invalid\n[commit]\n gpgsign = false\n');
    if (process.argv[2] !== 'resume') {
    must('git', ['worktree', 'add', '--detach', '--no-checkout', main, m.sha], m.code);
    must('git', ['sparse-checkout', 'init', '--no-cone'], main);
    must('git', ['sparse-checkout', 'set', '/bin/', '/src/', '/scripts/', '/package.json', '/tsconfig.json'], main);
    must('git', ['checkout', '-B', 'main', m.sha], main);
    must('git', ['checkout', '-B', 'develop', m.sha], m.code);
    for (const directory of ['node_modules', 'dist']) fs.cpSync(path.join(m.code, directory), path.join(main, directory), { recursive: true });
    fs.mkdirSync(path.join(m.code, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(m.code, 'qa/cfc44-actor.mjs'), "import fs from 'node:fs';import path from 'node:path';const dir=path.dirname(process.argv[2]);fs.writeFileSync(path.join(dir,'cfc44-ready.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await new Promise(resolve=>{const w=fs.watch(dir,()=>{if(fs.existsSync(path.join(dir,'cfc44-release'))){w.close();resolve();}})});\n");
    must('git', ['add', '--', 'qa/cfc44-actor.mjs'], m.code);
    must('git', ['commit', '-m', 'qa: isolated long-lived timing actor'], m.code);
    result.fixtureCommit = must('git', ['rev-parse', 'HEAD'], m.code);
    const settingsPath = path.join(m.root, 'conf/raf.json'), settings = JSON.parse(fs.readFileSync(settingsPath));
    const protocol = settings.runnerProtocols.find(p => p.runner === 'codex');
    const roots = [m.root, main, m.code, path.join(m.root, 'raf-hotfix')];
    const override = 'projects={' + roots.map(p => `${JSON.stringify(p)}={trust_level="trusted"}`).join(',') + '}';
    protocol.baseArgs.push('-c', override); protocol.quota.args.push('-c', override, '-C', main);
    result.fixtureTrustOverride = override;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const change = path.join(m.root, 'openspec/changes/cfc44-live'); fs.mkdirSync(change, { recursive: true });
    fs.writeFileSync(path.join(m.root, 'openspec/config.yaml'), 'schema: spec-driven\n');
    fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
    fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nOwned command timing QA.\n\n## What Changes\nLong-lived payload fixture.\n\n## Non-goals\nNo product changes.\n');
    fs.writeFileSync(path.join(change, 'tasks.md'), '- [ ] 1.1 [implement] Execute exactly one shell command: node qa/cfc44-actor.mjs <exact report_path from your brief>. Wait for it to return. Do not change files, run tests, write a report, commit, archive, or send messages. Preserve raf-selected model and effort. Host checks launch EMA while this payload is alive.\n- [ ] 1.2 Host keeps fixture active.\n');
    must('git', ['init', '-b', 'main']);
    must('git', ['add', '--', 'conf', 'openspec']);
    must('git', ['commit', '-m', 'qa: isolated live timing orchestrator']);
    result.rootFixtureCommit = must('git', ['rev-parse', 'HEAD']);
    }
    result.runnerVersion = run('codex', ['--version']).stdout.trim();
    must('tmux', ['-S', socket, 'new-session', '-d', '-s', 'cfc44-main', '-x', '180', '-y', '50', process.execPath, import.meta.filename, 'pane']); server = true;
    const wait = async (label, read, milliseconds = 120000) => {
      const end = Date.now() + milliseconds;
      while (Date.now() < end) { const value = read(); if (value) return value; await delay(100); }
      throw Error(label + ': integration readiness deadline exceeded (' + milliseconds + 'ms)');
    };
    result.attach = await wait('main attach', () => fs.existsSync(path.join(base, 'ready.json')) && JSON.parse(fs.readFileSync(path.join(base, 'ready.json'))));
    assert.equal(result.attach.cliExitCode, 0, fs.readFileSync(path.join(evidence, 'I6-main-attach.stderr'), 'utf8'));
    const args = ['agent', 'run', '--id', 'cfc44-actor', '--type', 'implement', '--project', 'raf', '--features', 'cfc44-live', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'cfc44-live:1.1'];
    atomic(path.join(base, 'request.json'), { label: 'I6-agent-run', args });
    result.launch = await wait('agent run', () => fs.existsSync(path.join(evidence, 'I6-agent-run.json')) && JSON.parse(fs.readFileSync(path.join(evidence, 'I6-agent-run.json'))));
    assert.equal(result.launch.cliExitCode, 0, fs.readFileSync(path.join(evidence, 'I6-agent-run.stderr'), 'utf8'));
    const actor = await wait('native long-lived payload', () => rows()?.sessions.find(s => s.addressId === 'cfc44-actor' && s.state === 'running' && s.launchContext?.reportPath && fs.existsSync(path.join(path.dirname(s.launchContext.reportPath), 'cfc44-ready.json'))));
    result.live = { at: new Date().toISOString(), runId: actor.runId, process: actor.process, selection: actor.selection, snapshot: rows(), marker: JSON.parse(fs.readFileSync(path.join(path.dirname(actor.launchContext.reportPath), 'cfc44-ready.json'))) };
    await delay(5000);
    result.stillLive = { at: new Date().toISOString(), snapshot: rows() };
    assert.equal(result.stillLive.snapshot.sessions.find(s => s.runId === actor.runId)?.state, 'running');
    assert.deepEqual(result.stillLive.snapshot.timings.find(r => r.command === 'agent run'), result.live.snapshot.timings.find(r => r.command === 'agent run'));
    fs.writeFileSync(path.join(path.dirname(actor.launchContext.reportPath), 'cfc44-release'), 'release\n');
    result.status = 'passed';
  } catch (error) { result.reason = error.message; }
  finally {
    result.finalSnapshot = rows();
    if (server) {
      const capture = run('tmux', ['-S', socket, 'capture-pane', '-p', '-S', '-200', '-t', 'cfc44-main']);
      fs.writeFileSync(path.join(evidence, 'I6-pane.txt'), capture.stdout ?? '');
      const cleanup = run('tmux', ['-S', socket, 'kill-server']); result.cleanup = { cliExitCode: cleanup.status, stderr: cleanup.stderr, socket };
    }
    atomic(path.join(evidence, 'I6.json'), result);
    console.log(JSON.stringify({ status: result.status, reason: result.reason ?? null, cleanup: result.cleanup ?? null }));
  }
}
