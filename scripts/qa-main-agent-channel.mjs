// Host-only live QA. No product state, auth copies, model overrides or unit runs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configureLiveCodexTrust } from '../test/helpers/z4044-live-trust.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewed = process.argv[2];
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.equal(process.env.CODEX_HOME, '/home/dev/.codex', 'Use the existing provider selector; never copy auth');
assert.equal(process.env.LC_ALL, 'C');
process.umask(0o077);
// mkdtemp owns the entire fixture. Nothing outside this directory is cleaned up.
const stand = fs.mkdtempSync('/tmp/s64-');
const root = path.join(stand, 'root'), ev = path.join(stand, 'ev');
const main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop');
const socket = path.join(stand, 'main.sock');
for (const p of [root, ev, path.join(stand, 'commands')]) fs.mkdirSync(p, { recursive: true });
const env = { ...process.env, HOME: stand, RAF_QA_HOME: stand, TMPDIR: stand,
  XDG_CONFIG_HOME: path.join(stand, '.config'), GIT_CONFIG_GLOBAL: path.join(stand, 'gitconfig') };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL' ||
  key.startsWith('RAF_') && key !== 'RAF_QA_HOME' || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'NODE_PATH', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n name = Isolated QA\n email = qa@example.invalid\n[commit]\n gpgsign = false\n');
const atomic = (p, value) => { fs.writeFileSync(p + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(p + '.part', p); };
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const summary = { status: 'failed', stand, reviewed, startedAt: new Date().toISOString(), commands: [], switches: [],
  limitations: ['This stand tests the published agent channel with host-controlled real symlink/Git/registry fixtures. Release verification gates remain the separate 4.4 QA.', 'No unit result substitutes for native tool evidence.'] };
let seq = 0, pane = false, endpoint;
const run = (label, exe, args, cwd = root, budget = 120000) => {
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024 });
  const value = { command: [exe, ...args], cwd, cliExitCode: r.status, signal: r.signal,
    error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (label.startsWith('identity-')) { value.stdout = '[redacted]\n'; if (value.stderr) value.stderr = '[redacted]\n'; }
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(ev, label + '.' + stream), value[stream]);
  atomic(path.join(ev, label + '.json'), value); summary.commands.push({ label, cliExitCode: value.cliExitCode, signal: value.signal });
  return value;
};
const must = r => { assert.equal(r.cliExitCode, 0, r.stderr || r.error); return r.stdout.trim(); };
const git = (cwd, ...args) => must(run('git-' + (++seq), 'git', ['-C', cwd, ...args], cwd));
const wait = async (label, read, budget = 240000) => {
  const end = Date.now() + budget;
  while (Date.now() < end) { const v = read(); if (v) return v; await delay(300); }
  throw Error('Unexecuted remainder: ' + label);
};
const request = async (label, args, budget = 240000) => {
  const target = path.join(ev, label + '.json'); assert.ok(!fs.existsSync(target), 'Never retry an unknown command');
  atomic(path.join(stand, 'commands', String(++seq).padStart(5, '0') + '.json'), { label, args, budget });
  return wait(label, () => fs.existsSync(target) && JSON.parse(fs.readFileSync(target)), budget + 10000);
};
const sessions = () => {
  const db = new DatabaseSync(path.join(stand, '.raf/state.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT payload FROM sessions').all().map(x => JSON.parse(x.payload)); } finally { db.close(); }
};
const own = record => path.dirname(record.launchContext.reportPath);
const stage = (record, n) => fs.existsSync(path.join(own(record), 'sym64-stage-' + n + '.json'));
const gate = (record, n) => fs.writeFileSync(path.join(own(record), 'sym64-go-' + n), 'host');
const actors = [];
async function controls(label) {
  const response = await new Promise((resolve, reject) => {
    let data = ''; const client = connect(path.join(develop, 'qa/peer.sock'));
    client.setTimeout(5000, () => client.destroy(Error('host endpoint timeout')));
    client.on('error', reject); client.on('data', b => data += b); client.on('end', () => resolve(data));
  });
  assert.equal(response, 'sym64-host-alive');
  must(run(label + '-tmux', 'tmux', ['-S', socket, 'list-sessions']));
  const ps = await request(label + '-ps', ['agent', 'ps']); must(ps);
  const live = sessions();
  for (const a of actors) assert.equal(live.find(s => s.runId === a.runId)?.state, 'running');
  atomic(path.join(ev, label + '-controls.json'), { response, sessions: live, active: fs.realpathSync(main) });
}
function copyTranscript(record, label) {
  const target = path.join(ev, label); fs.mkdirSync(target, { recursive: true });
  // Only this run's directory and native rollout; no traversal/copy of auth or provider config.
  fs.cpSync(own(record), path.join(target, 'run'), { recursive: true, filter: p => { const s = fs.lstatSync(p); return s.isFile() || s.isDirectory(); } });
  const native = record.process?.runnerSessionId;
  assert.ok(native, 'native session ID required');
  const found = [];
  const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name); if (e.isDirectory()) walk(f);
    else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(native)) found.push(f);
  } };
  walk(path.join(env.CODEX_HOME, 'sessions'));
  assert.equal(found.length, 1, 'One exact native transcript required');
  fs.copyFileSync(found[0], path.join(target, 'native.jsonl'));
  atomic(path.join(target, 'session.json'), record);
  return path.join(target, 'native.jsonl');
}
console.log(JSON.stringify({ stand, evidence: ev, reviewed }));
try {
  assert.equal(git(source, 'rev-parse', 'HEAD'), reviewed, 'Review exact current SHA');
  summary.workspace = git(source, 'status', '--porcelain');
  for (const [exe, args] of [['node', ['--version']], ['codex', ['--version']], ['git', ['--version']], ['tmux', ['-V']], ['bwrap', ['--version']], ['uname', ['-a']]]) must(run('version-' + exe, exe, args));
  must(run('identity-author', 'git', ['var', 'GIT_AUTHOR_IDENT'], stand));
  must(run('identity-committer', 'git', ['var', 'GIT_COMMITTER_IDENT'], stand));
  fs.cpSync(path.join(path.dirname(source), 'conf'), path.join(root, 'conf'), { recursive: true });
  const projectFile = path.join(root, 'conf/projects.json'), projects = JSON.parse(fs.readFileSync(projectFile));
  projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator };
  Object.assign(projects.projects.raf, { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' }, mainCopies: ['raf-main-a', 'raf-main-b'] });
  fs.writeFileSync(projectFile, JSON.stringify(projects, null, 2) + '\n');
  const settingsFile = path.join(root, 'conf/raf.json'), settings = JSON.parse(fs.readFileSync(settingsFile));
  summary.trust = configureLiveCodexTrust(settings, root);
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  must(run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main]));
  git(main, 'checkout', '-B', 'main', reviewed);
  fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
  must(run('build', 'npm', ['run', 'build'], main));
  fs.mkdirSync(path.join(main, 'qa'), { recursive: true });
  fs.copyFileSync(path.join(source, 'scripts/qa-main-agent-channel-probe.mjs'), path.join(main, 'qa/sym64-probe.mjs'));
  // Audit the real public CLI result before it is emitted; channel implementation is untouched.
  const bin = path.join(main, 'bin/raf.ts');
  let cli = fs.readFileSync(bin, 'utf8');
  const insertion = "if (result.stdout)";
  assert.ok(cli.includes(insertion));
  cli = cli.replace(insertion, `if (process.env.SYM64_AUDIT) { const fs = await import('node:fs'); const p = await import('node:path'); fs.writeFileSync(p.join(process.env.SYM64_AUDIT, crypto.randomUUID()+'.json'), JSON.stringify({module:import.meta.url,argv:process.argv.slice(2),result})); }\n${insertion}`);
  fs.writeFileSync(bin, cli);
  git(main, 'add', '--', 'qa', 'bin/raf.ts'); git(main, 'commit', '-m', 'qa: isolated native channel fixture and exact CLI audit');
  git(root, 'init', '-b', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main'); git(root, 'submodule', 'absorbgitdirs');
  git(main, 'worktree', 'add', '-B', 'develop', develop, 'HEAD');
  git(main, 'worktree', 'add', '-b', 'hotfix', path.join(root, 'raf-hotfix'), 'HEAD');
  const change = path.join(root, 'openspec/changes/sym64-fixture'); fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nIsolated live native channel QA.\n\n## What Changes\nHost-controlled probes only.\n\n## Non-goals\nNo product implementation or unit runs.\n');
  const description = actor => `Controlled live QA actor ${actor}. Model and effort already selected by raf; never replace them. Do not implement, run tests, edit tasks, write report, archive, or retry failed/unknown commands. In native exec tool perform this exact sequence, requesting max_output_tokens 60000 for message/ps so exact outputs are retained. First execute node qa/sym64-probe.mjs 0 <exact report_path from your brief>; wait for completion. Then execute the issued raf_command agent message --to sym64-${actor === 'a' ? 'b' : 'a'} --text sym64-${actor}-after-B as ONE simple native tool command, using the original issued absolute raf_command unchanged. Next execute the issued raf_command agent ps in a separate native tool call. Next execute node qa/sym64-probe.mjs 1 <exact report_path>; wait for completion. Next repeat separate simple native message with text sym64-${actor}-after-A and agent ps using that same original prefix. Finally execute node qa/sym64-probe.mjs 2 <exact report_path> and wait. Do not acknowledge received messages with tool calls, only chat. If any expected-success command fails, stop and preserve the error. The probe helper owns allowed negative actions only inside this isolated fixture. Do not change the helper or evade its checks. After completion wait for host.`;
  fs.writeFileSync(path.join(change, 'tasks.md'), `- [ ] 1.1 ${description('a')}\n- [ ] 1.2 ${description('b')}\n- [ ] 1.3 Host keeps the fixture active.\n`);
  git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'openspec'); git(root, 'commit', '-m', 'qa: isolated orchestrator');
  const layout = await import(pathToFileURL(path.join(main, 'src/main-layout.ts')));
  await layout.ensureMainLayoutForStart({ root, projects: projects.projects });
  const A = path.join(root, 'raf-main-a'), B = path.join(root, 'raf-main-b');
  // Git worktrees do not include ignored runtime dependencies/build output.
  for (const slot of [B, develop, path.join(root, 'raf-hotfix')]) {
    for (const name of ['node_modules', 'dist']) fs.cpSync(path.join(A, name), path.join(slot, name), { recursive: true, dereference: true });
  }
  // The native runner/selection/brief/process identity are all produced by real raf.
  env.SYM64_AUDIT = path.join(ev, 'cli-audit'); fs.mkdirSync(env.SYM64_AUDIT);
  must(run('main-start', 'tmux', ['-S', socket, 'new-session', '-d', '-s', 'sym64-main', '-x', '180', '-y', '50', process.execPath, path.join(source, 'test/helpers/z4044-main-pane.mjs'), stand])); pane = true;
  must(await wait('main attach', () => fs.existsSync(path.join(stand, 'main-ready.json')) && JSON.parse(fs.readFileSync(path.join(stand, 'main-ready.json')))));
  must(await request('runner-list', ['runner', 'list'])); must(await request('runner-limits', ['runner', 'limits', '--runners', 'codex']));
  must(await request('service-start', ['service', 'start']));
  endpoint = createServer(c => c.end('sym64-host-alive'));
  await new Promise((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(path.join(develop, 'qa/peer.sock'), resolve); });
  const common = git(A, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const host = { orchestratorRoot: root, qaHome: stand, environment: env, sandboxExecutable: 'codex' };
  const hh = await import(pathToFileURL(path.join(A, 'src/hotfix-host.ts')));
  const activation = await import(pathToFileURL(path.join(A, 'src/hotfix-activation.ts')));
  const initial = await activation.acquireHotfixReader(host, 'hook'); await initial.release();
  // Snapshot registration uses the production inventory format; no transport/CLI mock.
  const register = async slot => hh.locked(host, async route => {
    const parent = path.join(route.control, 'generations', randomUUID()), target = path.join(parent, 'raf-main');
    fs.mkdirSync(parent, { recursive: true }); await hh.copyTree(slot, target);
    fs.cpSync(path.join(root, 'conf'), path.join(parent, 'conf'), { recursive: true });
    await hh.durable(path.join(parent, 'ownership.json'), { root: target, orchestratorRoot: root, repositoryIdentity: route.repositoryIdentity });
    const files = await hh.inventory(target), value = { root: target, commit: git(slot, 'rev-parse', 'HEAD'), files, fingerprint: hh.hash(JSON.stringify(files)) };
    const file = path.join(route.control, 'registry.json'), state = JSON.parse(fs.readFileSync(file));
    state.generations[target] = value; state.current = target; await hh.durable(file, state); return value;
  });
  for (const [actor, item] of [['a', '1.1'], ['b', '1.2']]) {
    must(await request('launch-' + actor, ['agent', 'run', '--id', 'sym64-' + actor, '--type', 'implement', '--project', 'raf', '--features', 'sym64-fixture', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'sym64-fixture:' + item]));
    const record = await wait('registered ' + actor, () => sessions().find(s => s.addressId === 'sym64-' + actor && s.state === 'running'));
    actors.push(record); await wait('native initial gate ' + actor, () => stage(record, 0));
  }
  summary.actors = actors.map(s => ({ runId: s.runId, address: s.addressId, process: s.process, selection: s.selection, launchContext: s.launchContext, briefSha256: hash(s.launchContext.briefPath) }));
  await controls('before');
  fs.writeFileSync(path.join(stand, '.raf/secrets.json'), 'sym64-isolated-secret-sentinel\n');
  for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'secrets.json']) assert.ok(fs.existsSync(path.join(stand, '.raf', name)), 'Host read-deny positive control: ' + name);
  for (const [index, slot] of [B, A].entries()) {
    const previous = fs.realpathSync(main), before = git(slot, 'rev-parse', 'HEAD');
    // Re-prepare the inactive physical slot from the actual development source.
    assert.notEqual(previous, slot); git(slot, 'checkout', '--detach', git(develop, 'rev-parse', 'HEAD'));
    const temporary = main + '.' + randomUUID(); fs.symlinkSync(slot, temporary); fs.renameSync(temporary, main);
    git(previous, 'checkout', '--detach'); git(slot, 'update-ref', 'refs/heads/main', git(slot, 'rev-parse', 'HEAD')); git(slot, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    for (const p of ['raf-main-a', 'raf-main-b']) git(root, 'update-index', '--force-remove', p);
    git(root, 'update-index', '--add', '--cacheinfo', '160000', git(slot, 'rev-parse', 'HEAD'), path.basename(slot));
    git(root, 'config', '-f', '.gitmodules', 'submodule.raf-main.path', path.basename(slot)); git(root, 'add', '--', '.gitmodules');
    const generation = await register(slot);
    const fingerprint = () => ({ active: fs.readlinkSync(main), a: hash(path.join(A, 'bin/raf.ts')), b: hash(path.join(B, 'bin/raf.ts')), modules: hash(path.join(root, '.gitmodules')), mainRef: git(slot, 'rev-parse', 'refs/heads/main') });
    const beforeProbe = fingerprint();
    summary.switches.push({ previous, active: fs.realpathSync(main), preparedFrom: git(develop, 'rev-parse', 'HEAD'), before, generation });
    for (const a of actors) {
      gate(a, index);
      await wait('native gate ' + (index + 1), () => stage(a, index + 1));
    }
    for (const a of actors) assert.equal(JSON.parse(fs.readFileSync(path.join(own(a), 'sym64-stage-' + (index + 1) + '.json'))).status, 'passed', 'Native probes must pass before another switch');
    assert.deepEqual(fingerprint(), beforeProbe, 'Negative probes and shared-index access cannot change main');
    await controls('after-' + index);
  }
  const current = sessions();
  summary.transcripts = actors.map(a => copyTranscript(current.find(s => s.runId === a.runId), a.addressId));
  for (const a of actors) assert.equal(hash(a.launchContext.briefPath), summary.actors.find(s => s.runId === a.runId).briefSha256, 'Issued brief must not change');
  const audits = fs.readdirSync(env.SYM64_AUDIT).map(f => JSON.parse(fs.readFileSync(path.join(env.SYM64_AUDIT, f))));
  for (const a of actors) {
    const transcript = fs.readFileSync(summary.transcripts[actors.indexOf(a)], 'utf8');
    assert.match(transcript, /exec_command|shell_command/);
    for (const suffix of ['after-B', 'after-A']) {
      const marker = 'sym64-' + a.addressId.slice(-1) + '-' + suffix;
      const matches = audits.filter(v => v.argv.includes(marker)); assert.equal(matches.length, 1, marker);
      assert.equal(matches[0].result.exitCode, 0); assert.ok(transcript.includes(marker));
    }
    for (const n of [1, 2]) {
      const probe = JSON.parse(fs.readFileSync(path.join(own(a), 'sym64-stage-' + n + '.json')));
      assert.equal(probe.status, 'passed');
    }
  }
  summary.status = 'native-completed-review-required';
  summary.nextAction = 'Inspect native tool result events against cli-audit raw exact outputs, sender receipts, generation roots and both live ps results before accepting 6.4. This status is deliberately not an automatic pass.';
} catch (error) { summary.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  // Preserve raw evidence, stop only named fixture actors/service and our own tmux server.
  if (pane) {
    for (const a of actors) {
      try { copyTranscript(sessions().find(s => s.runId === a.runId) ?? a, a.addressId + '-final'); } catch (e) { (summary.copyErrors ??= []).push(e.message); }
      try { const result = await request('cleanup-' + a.addressId, ['agent', 'close', '--id', a.addressId, '--force', '--reason', 'Host-owned isolated QA cleanup'], 60000); (summary.cleanup ??= []).push(result); } catch (e) { (summary.cleanupErrors ??= []).push(e.message); }
    }
    try { (summary.cleanup ??= []).push(await request('cleanup-service', ['service', 'stop'], 60000)); } catch (e) { (summary.cleanupErrors ??= []).push(e.message); }
    summary.agentTmuxCleanup = run('cleanup-agent-tmux', 'tmux', ['-S', path.join(stand, '.raf/tmp/tmux/server.sock'), 'kill-server']);
    summary.tmuxCleanup = run('cleanup-tmux', 'tmux', ['-S', socket, 'kill-server']);
  }
  if (endpoint) await new Promise(resolve => endpoint.close(resolve));
  summary.endedAt = new Date().toISOString(); atomic(path.join(ev, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, evidence: ev, error: summary.error?.message }));
}
