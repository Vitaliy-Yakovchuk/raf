import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { captureStateReadControls } from './qa-main-agent-denial.mjs';
import { createStandGeneration } from './qa-main-agent-generation.mjs';
import { configureLiveCodexTrust } from '../test/helpers/z4044-live-trust.mjs';
import { metadataTree, instrumentStandAssignment, drainStandServiceReader, normalizeStandReflog, nativeActorPlan, releaseNativeStage, captureCompletedNativeActors, nativeCompletionReceipt, instrumentStandCli, stopStandServices, prepareStandAudit, archiveStandAudit, captureStandSocketControls } from './qa-main-agent-channel-metadata.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewed = process.argv[2];
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.equal(process.env.CODEX_HOME, '/home/dev/.codex', 'Use the existing provider selector; never copy auth');
assert.equal(process.env.LC_ALL, 'C');
process.umask(0o077);
const stand = fs.mkdtempSync('/srv/dev/s64-');
const root = path.join(stand, 'root'), ev = path.join(stand, 'ev');
const main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop');
const socket = path.join(develop, 'qa/peer.sock');
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
let seq = 0, pane = false, mainRecord, protectedState, stateKeepAlive;
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
const git = (cwd, ...args) => must(run('git-' + (++seq), 'git', ['--no-optional-locks', '-C', cwd, ...args], cwd));
const wait = async (label, read, budget = 900000) => {
  const end = Date.now() + budget;
  while (Date.now() < end) { const v = await read(); if (v) return v; await delay(300); }
  throw Error('Unexecuted remainder: ' + label);
};
const request = async (label, args, budget = 900000) => {
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
  const endpoints = captureStandSocketControls(root, mainRecord, actors);
  for (const [index, endpoint] of endpoints.entries()) must(run(label + '-endpoint-' + index, 'tmux', ['-S', endpoint.path, 'list-sessions']));
  const ps = await request(label + '-ps', ['agent', 'ps']); must(ps);
  const live = sessions();
  for (const a of actors) {
    const current = live.find(s => s.runId === a.runId);
    assert.equal(current?.state, 'running');
    for (const field of ['pid', 'startedAt', 'runnerSessionId']) assert.equal(current.process?.[field], a.process?.[field], 'Native actor identity must survive host controls: ' + field);
  }
  atomic(path.join(ev, label + '-controls.json'), { endpoints, sessions: live, active: fs.realpathSync(main) });
}
function nativeTranscriptPath(record) {
  const native = record.process?.runnerSessionId;
  assert.ok(native, 'native session ID required');
  const found = [];
  const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name); if (e.isDirectory()) walk(f);
    else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(native)) found.push(f);
  } };
  walk(path.join(env.CODEX_HOME, 'sessions'));
  assert.equal(found.length, 1, 'One exact native transcript required');
  return found[0];
}
function copyTranscript(record, label) {
  const target = path.join(ev, label); fs.mkdirSync(target, { recursive: true });
  fs.cpSync(own(record), path.join(target, 'run'), { recursive: true, filter: p => { const s = fs.lstatSync(p); return s.isFile() || s.isDirectory(); } });
  fs.copyFileSync(nativeTranscriptPath(record), path.join(target, 'native.jsonl'));
  atomic(path.join(target, 'session.json'), record);
  return path.join(target, 'native.jsonl');
}
console.log(JSON.stringify({ stand, evidence: ev, reviewed }));
try {
  assert.equal(git(source, 'rev-parse', 'HEAD'), reviewed, 'Review exact current SHA');
  summary.workspace = git(source, 'status', '--porcelain');
  assert.equal(summary.workspace, '', 'Run the reviewed SHA from a clean clone');
  summary.configuration = Object.fromEntries(['raf-constants.json', 'projects.json', 'raf.json', 'flow.json', 'test-runs.json'].map(name => [name, hash(path.join(path.dirname(source), 'conf', name))]));
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
  fs.copyFileSync(path.join(source, 'scripts/qa-main-agent-denial.mjs'), path.join(main, 'qa/qa-main-agent-denial.mjs'));
  fs.copyFileSync(path.join(source, 'scripts/qa-main-agent-channel-metadata.mjs'), path.join(main, 'qa/qa-main-agent-channel-metadata.mjs'));
  for (const actor of ['a', 'b']) fs.writeFileSync(path.join(main, 'qa/sym64-instructions-' + actor + '.txt'), nativeActorPlan(actor, root).instructions + '\n');
  const sandboxFile = path.join(main, 'src/codex-sandbox.ts');
  let sandboxSource = fs.readFileSync(sandboxFile, 'utf8');
  const beforeProbe = '    const visible: string[] = [];';
  const afterProbe = '    await recordProductionSandboxProtection(request.readOnlyDirectories ?? [], join(directory, \'policy.json\'));';
  assert.equal(sandboxSource.split(beforeProbe).length, 2);
  assert.equal(sandboxSource.split(afterProbe).length, 2);
  sandboxSource = sandboxSource.replace(beforeProbe, `    const qaMetadata = await import('../qa/qa-main-agent-channel-metadata.mjs');\n    qaMetadata.capturePolicy(request.readOnlyDirectories ?? [], request.runId, 'compiled');\n${beforeProbe}`)
    .replace(afterProbe, `    qaMetadata.capturePolicy(request.readOnlyDirectories ?? [], request.runId, 'native-preflight');\n${afterProbe}`);
  fs.writeFileSync(sandboxFile, sandboxSource);
  const bin = path.join(main, 'bin/raf.ts');
  fs.writeFileSync(bin, instrumentStandCli(fs.readFileSync(bin, 'utf8')));
  const assignmentFile = path.join(main, 'src/assignment.ts');
  const originalAssignment = fs.readFileSync(assignmentFile, 'utf8');
  const instrumentedAssignment = instrumentStandAssignment(originalAssignment);
  fs.writeFileSync(assignmentFile, instrumentedAssignment);
  atomic(path.join(ev, 'brief-authorization-instrumentation.json'), { file: assignmentFile,
    originalSha256: createHash('sha256').update(originalAssignment).digest('hex'), instrumentedSha256: hash(assignmentFile),
    original: originalAssignment.slice(originalAssignment.indexOf('інших команд raf не виконуй.'), originalAssignment.indexOf('інших команд raf не виконуй.') + 'інших команд raf не виконуй.'.length),
    instrumented: instrumentedAssignment.slice(instrumentedAssignment.indexOf('Негативна CLI-перевірка стенду авторизована:'), instrumentedAssignment.indexOf('Інших команд raf не виконуй.') + 'Інших команд raf не виконуй.'.length),
    scope: 'Stand-owned copy before first launch; no product source, command grants or native sandbox changes' });
  git(main, 'add', '--', 'qa', 'bin/raf.ts', 'src/codex-sandbox.ts', 'src/assignment.ts'); git(main, 'commit', '-m', 'qa: isolated native channel fixture and exact CLI audit');
  git(root, 'init', '-b', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main'); git(root, 'submodule', 'absorbgitdirs');
  git(main, 'worktree', 'add', '-B', 'develop', develop, 'HEAD');
  git(main, 'worktree', 'add', '-b', 'hotfix', path.join(root, 'raf-hotfix'), 'HEAD');
  const change = path.join(root, 'openspec/changes/sym64-fixture'); fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nIsolated live native channel QA.\n\n## What Changes\nHost-controlled probes only.\n\n## Non-goals\nNo product implementation or unit runs.\n');

  fs.writeFileSync(path.join(change, 'tasks.md'), `- [ ] 1.1 ${nativeActorPlan('a').item}\n- [ ] 1.2 ${nativeActorPlan('b').item}\n- [ ] 1.3 Host keeps the fixture active.\n`);
  git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'openspec'); git(root, 'commit', '-m', 'qa: isolated orchestrator');
  const layout = await import(pathToFileURL(path.join(main, 'src/main-layout.ts')));
  await layout.ensureMainLayoutForStart({ root, projects: projects.projects });
  const A = path.join(root, 'raf-main-a'), B = path.join(root, 'raf-main-b');
  for (const slot of [B, develop, path.join(root, 'raf-hotfix')]) {
    for (const name of ['node_modules', 'dist']) fs.cpSync(path.join(A, name), path.join(slot, name), { recursive: true, dereference: true });
  }
  env.SYM64_AUDIT = prepareStandAudit(develop);
  must(run('main-start', 'tmux', ['-S', socket, 'new-session', '-d', '-s', 'sym64-main', '-x', '180', '-y', '50', process.execPath, path.join(source, 'test/helpers/z4044-main-pane.mjs'), stand])); pane = true;
  mainRecord = JSON.parse(must(await wait('main attach', () => fs.existsSync(path.join(stand, 'main-ready.json')) && JSON.parse(fs.readFileSync(path.join(stand, 'main-ready.json'))))));
  assert.equal(mainRecord.tmuxSocket, socket, 'Main attach must register the actual writable-tree endpoint before actor launch');
  must(await request('runner-list', ['runner', 'list'])); must(await request('runner-limits', ['runner', 'limits', '--runners', 'codex']));
  const hostService = JSON.parse(must(await request('service-start', ['service', 'start'])));
  const common = git(develop, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const control = path.join(common, 'raf-hotfix'), production = path.join(control, 'main.git');
  protectedState = { production };
  const host = { orchestratorRoot: root, qaHome: stand, environment: env, sandboxExecutable: 'codex' };
  const hh = await import(pathToFileURL(path.join(A, 'src/hotfix-host.ts')));
  const activation = await import(pathToFileURL(path.join(A, 'src/hotfix-activation.ts')));
  const initial = await activation.acquireHotfixReader(host, 'hook'); await initial.release();
  const register = async slot => hh.locked(host, async route => {
    const parent = path.join(route.control, 'generations', randomUUID()), target = path.join(parent, 'raf-main');
    fs.mkdirSync(parent, { recursive: true }); await hh.copyTree(slot, target);
    fs.cpSync(path.join(root, 'conf'), path.join(parent, 'conf'), { recursive: true });
    await hh.durable(path.join(parent, 'ownership.json'), { root: target, orchestratorRoot: root, repositoryIdentity: route.repositoryIdentity });
    const value = await createStandGeneration(target, git(slot, 'rev-parse', 'HEAD'), hh);
    const file = path.join(route.control, 'registry.json'), state = JSON.parse(fs.readFileSync(file));
    state.generations[target] = value; state.current = target; await hh.durable(file, state); return value;
  });
  git(A, 'pack-refs', '--all', '--prune');
  fs.mkdirSync(path.join(production, 'logs/refs/heads'), { recursive: true });
  assert.equal(fs.existsSync(path.join(production, 'refs/heads/main')), false, 'Packed main must have no loose ref');
  const beforeCompilation = metadataTree(production);
  atomic(path.join(ev, 'metadata-before-policy.json'), beforeCompilation);
  for (const [actor, item] of [['a', '1.1'], ['b', '1.2']]) {
    must(await request('launch-' + actor, ['agent', 'run', '--id', 'sym64-' + actor, '--type', 'implement', '--project', 'raf', '--features', 'sym64-fixture', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'sym64-fixture:' + item]));
    const record = await wait('registered ' + actor, () => sessions().find(s => s.addressId === 'sym64-' + actor && s.state === 'running'));
    actors.push(record); await wait('native initial gate ' + actor, () => stage(record, 0));
    for (const phase of ['compiled', 'native-preflight']) {
      const captured = JSON.parse(fs.readFileSync(path.join(env.SYM64_AUDIT, 'policy-' + record.runId + '-' + phase + '.json')));
      assert.deepEqual(captured.production, beforeCompilation, phase + ' cannot create host metadata mountpoints');
    }
    assert.deepEqual(metadataTree(production), beforeCompilation, 'Successful native launch cannot create metadata mountpoints');
  }
  atomic(path.join(ev, 'metadata-after-native-launch.json'), metadataTree(production));
  const unavailableProduction = path.join(control, 'native-unavailable-main.git');
  fs.renameSync(production, unavailableProduction);
  try {
    const refused = await request('missing-production-launch', ['agent', 'run', '--id', 'sym64-refused', '--type', 'implement', '--project', 'raf', '--features', 'sym64-fixture', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'sym64-fixture:1.3']);
    assert.ok(Number.isInteger(refused.cliExitCode) && refused.cliExitCode !== 0 && !refused.signal, 'Missing protected store must refuse launch');
    assert.equal(fs.existsSync(production), false, 'Refused launch cannot create missing protected store');
    const rejected = sessions().find(s => s.addressId === 'sym64-refused');
    assert.ok(!rejected?.process?.runnerSessionId, 'Missing store must refuse before native runner');
    summary.refusedLaunch = { result: refused, session: rejected ?? null };
  } finally { fs.renameSync(unavailableProduction, production); }
  assert.deepEqual(metadataTree(production), beforeCompilation, 'Refused launch cannot change existing metadata');
  atomic(path.join(ev, 'metadata-after-refused-launch.json'), metadataTree(production));
  summary.actors = actors.map(s => ({ runId: s.runId, address: s.addressId, process: s.process, selection: s.selection, launchContext: s.launchContext, briefSha256: hash(s.launchContext.briefPath) }));
  await controls('before');
  summary.hostServiceDrain = await drainStandServiceReader({ service: hostService, request, processStart: hh.processStart, alive: hh.alive, wait });
  await controls('after-host-service-drain');
  stateKeepAlive = new DatabaseSync(path.join(stand, '.raf/state.sqlite'), { readOnly: true });
  stateKeepAlive.exec('BEGIN');
  stateKeepAlive.prepare('SELECT count(*) FROM sqlite_schema').get();
  fs.writeFileSync(path.join(stand, '.raf/secrets.json'), 'sym64-isolated-secret-sentinel\n');
  for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'secrets.json']) assert.ok(fs.existsSync(path.join(stand, '.raf', name)), 'Host read-deny positive control: ' + name);
  const store = await import(pathToFileURL(path.join(A, 'src/main-production-store.ts')));
  const oldB = git(B, 'rev-parse', '--absolute-git-dir');
  const legacyB = path.join(common, 'worktrees', 'native-main-b');
  fs.cpSync(oldB, legacyB, { recursive: true, dereference: false });
  fs.writeFileSync(path.join(legacyB, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(legacyB, 'gitdir'), path.join(B, '.git') + '\n');
  fs.writeFileSync(path.join(A, '.git'), 'gitdir: ' + path.relative(A, common) + '\n');
  fs.writeFileSync(path.join(B, '.git'), 'gitdir: ' + path.relative(B, legacyB) + '\n');
  git(root, '--git-dir=' + common, 'config', 'core.worktree', A);
  normalizeStandReflog(B, git);
  fs.renameSync(production, path.join(control, 'native-retained-main.git'));
  fs.unlinkSync(path.join(control, 'main-store.json'));
  summary.liveSplit = { source: common, control, production, readersBefore: fs.readdirSync(path.join(control, 'readers')).map(name => JSON.parse(fs.readFileSync(path.join(control, 'readers', name)))) };
  const leaseFile = fs.readdirSync(path.join(control, 'readers')).map(name => path.join(control, 'readers', name))
    .find(file => file.endsWith('.json') && JSON.parse(fs.readFileSync(file)).nativeProtection);
  assert.ok(leaseFile, 'A real live pinned reader with native protection is required');
  const leaseBytes = fs.readFileSync(leaseFile), unprovenReader = JSON.parse(leaseBytes);
  delete unprovenReader.nativeProtection;
  try {
    fs.writeFileSync(leaseFile, JSON.stringify(unprovenReader));
    await assert.rejects(store.ensureProductionMainStore({ root }), /live reader has unknown protection/);
    assert.equal(fs.existsSync(production), false, 'Unproven pinned reader must hold transition before publishing P');
    summary.unprovenReaderHeld = { leaseFile, pid: unprovenReader.pid, start: unprovenReader.start, method: 'Host temporarily removed the proof from an existing live reader lease; its actual native scope remained unchanged.' };
    await controls('unproven-reader-held');
  } finally { fs.writeFileSync(leaseFile, leaseBytes); }
  const sourceBefore = git(develop, 'rev-parse', 'HEAD');
  await store.ensureProductionMainStore({ root, onCheckpoint: async checkpoint => {
    if (checkpoint !== 'store-prepared') return;
    for (const a of actors) {
      fs.writeFileSync(path.join(own(a), 'sym64-commit-0'), 'host');
      const result = await wait('native source commit during split', () => {
        const file = path.join(own(a), 'sym64-source-0.json');
        return fs.existsSync(file) && JSON.parse(fs.readFileSync(file));
      });
      assert.equal(result.status, 'passed', result.error);
    }
    summary.liveSplit.sourceDuring = git(develop, 'rev-parse', 'HEAD');
    summary.liveSplit.orchestratorDuring = git(root, 'rev-parse', 'HEAD');
    assert.notEqual(summary.liveSplit.sourceDuring, sourceBefore);
  } });
  assert.equal(git(develop, 'rev-parse', 'HEAD'), summary.liveSplit.sourceDuring, 'Migration cannot restore source refs');
  assert.equal(git(root, 'rev-parse', 'HEAD'), summary.liveSplit.orchestratorDuring, 'Migration cannot restore Orchestrator refs');
  assert.equal(git(A, 'rev-parse', '--path-format=absolute', '--git-common-dir'), production);
  assert.equal(git(B, 'rev-parse', '--path-format=absolute', '--git-common-dir'), production);
  fs.mkdirSync(path.join(production, 'logs/refs/heads'), { recursive: true });
  await controls('after-live-split');
  let rollbackCommit;
  for (const [index, slot] of [B, A, B].entries()) {
    const previous = fs.realpathSync(main), before = git(slot, 'rev-parse', 'HEAD');
    assert.notEqual(previous, slot);
    const target = index === 2 ? rollbackCommit : git(develop, 'rev-parse', 'HEAD');
    git(slot, 'fetch', '--no-tags', '--no-write-fetch-head', common, target);
    git(slot, 'checkout', '--detach', target);
    if (index === 0) rollbackCommit = target;
    const temporary = main + '.' + randomUUID(); fs.symlinkSync(slot, temporary); fs.renameSync(temporary, main);
    git(previous, 'checkout', '--detach'); git(slot, 'update-ref', 'refs/heads/main', git(slot, 'rev-parse', 'HEAD')); git(slot, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    for (const p of ['raf-main-a', 'raf-main-b']) git(root, 'update-index', '--force-remove', p);
    git(root, 'update-index', '--add', '--cacheinfo', '160000', git(slot, 'rev-parse', 'HEAD'), path.basename(slot));
    git(root, 'config', '-f', '.gitmodules', 'submodule.raf-main.path', path.basename(slot)); git(root, 'add', '--', '.gitmodules');
    const generation = await register(slot);
    if (index !== 1) git(slot, 'pack-refs', '--all', '--prune');
    assert.equal(fs.existsSync(path.join(production, 'refs/heads/main')), index === 1, 'Exercise packed and loose main explicitly');
    const hostLock = path.join(production, 'refs/heads/qa-native-host.lock');
    const descriptor = fs.openSync(hostLock, 'wx', 0o600);
    fs.writeFileSync(descriptor, target + '\n'); fs.closeSync(descriptor);
    const lawfulLock = metadataTree(hostLock);
    const fingerprint = () => ({ production: metadataTree(production), active: fs.readlinkSync(main), a: hash(path.join(A, 'bin/raf.ts')), b: hash(path.join(B, 'bin/raf.ts')), modules: hash(path.join(root, '.gitmodules')), mainRef: git(slot, 'rev-parse', 'refs/heads/main') });
    const beforeProbe = fingerprint();
    atomic(path.join(ev, 'metadata-before-probe-' + index + '.json'), beforeProbe);
    summary.switches.push({ action: index === 2 ? 'rollback' : 'switch', target, previous, active: fs.realpathSync(main), preparedFrom: git(develop, 'rev-parse', 'HEAD'), before, generation });
    const readControlsBefore = captureStateReadControls(path.join(stand, '.raf'));
    atomic(path.join(ev, 'read-controls-before-' + index + '.json'), readControlsBefore);
    const socketControlsBefore = captureStandSocketControls(root, mainRecord, actors);
    atomic(path.join(ev, 'socket-controls-before-' + index + '.json'), socketControlsBefore);
    await releaseNativeStage({ actors,
      writeControls: a => atomic(path.join(own(a), 'sym64-read-controls-' + (index + 1) + '.json'), { stage: index + 1, runId: a.runId, agentId: a.addressId, briefSha256: summary.actors.find(s => s.runId === a.runId).briefSha256, files: readControlsBefore, sockets: socketControlsBefore }),
      gate: a => gate(a, index),
      wait: a => wait('native gate ' + (index + 1), () => stage(a, index + 1)),
    });
    const socketControlsAfter = captureStandSocketControls(root, mainRecord, actors);
    atomic(path.join(ev, 'socket-controls-after-' + index + '.json'), socketControlsAfter);
    assert.deepEqual(socketControlsAfter, socketControlsBefore, 'Registered socket identities must survive native probes');
    const readControlsAfter = captureStateReadControls(path.join(stand, '.raf'));
    atomic(path.join(ev, 'read-controls-after-' + index + '.json'), readControlsAfter);
    assert.deepEqual(readControlsAfter, readControlsBefore, 'Hidden files must remain the same existing host files throughout native probes');
    for (const a of actors) assert.equal(JSON.parse(fs.readFileSync(path.join(own(a), 'sym64-stage-' + (index + 1) + '.json'))).status, 'passed', 'Native probes must pass before another switch');
    assert.deepEqual(fingerprint(), beforeProbe, 'Negative probes and shared-index access cannot change main');
    atomic(path.join(ev, 'metadata-after-probe-' + index + '.json'), fingerprint());
    assert.deepEqual(metadataTree(hostLock), lawfulLock, 'A lawful host lock must retain bytes, mode and inode');
    fs.unlinkSync(hostLock);
    git(slot, 'update-ref', 'refs/heads/qa-native-host', target);
    git(slot, 'update-ref', '-d', 'refs/heads/qa-native-host');
    const previousHead = git(previous, 'rev-parse', 'HEAD');
    git(previous, 'checkout', '--detach', previousHead);
    git(previous, 'commit', '--allow-empty', '-m', 'qa: host Git remains writable during native probes');
    const hostCommit = git(previous, 'rev-parse', 'HEAD');
    git(previous, 'checkout', '--detach', previousHead);
    (summary.hostGitControls ??= []).push({ index, hostLock, lawfulLock, hostCommit, restoredHead: previousHead, sourceHead: git(develop, 'rev-parse', 'HEAD'), orchestratorHead: git(root, 'rev-parse', 'HEAD') });
    await controls('after-' + index);
  }
  const current = sessions();
  summary.transcripts = await captureCompletedNativeActors({ actors,
    gate: a => gate(a, 3),
    wait: async a => {
      const completion = await wait('native final CLI completion ' + a.addressId, () => nativeCompletionReceipt(fs.readFileSync(nativeTranscriptPath(a), 'utf8'), a.runId), 180000);
      (summary.nativeCompletions ??= []).push(completion);
    },
    capture: () => actors.map(a => copyTranscript(current.find(s => s.runId === a.runId), a.addressId)),
  });
  summary.actorCommits = actors.flatMap(a => ['sym64-source-0.json', ...[1, 2, 3].map(n => 'sym64-stage-' + n + '.json')].flatMap(name => {
    const proof = JSON.parse(fs.readFileSync(path.join(ev, a.addressId, 'run', name)));
    return proof.results.filter(result => result.label.startsWith('own commit visible ')).map(result => {
      assert.equal(result.cliExitCode, 0);
      const oid = result.stdout.trim(); assert.match(oid, /^[a-f0-9]{40}$/);
      return { runId: a.runId, repository: result.label.slice('own commit visible '.length), oid };
    });
  }));
  for (const a of actors) assert.equal(hash(a.launchContext.briefPath), summary.actors.find(s => s.runId === a.runId).briefSha256, 'Issued brief must not change');
  const audits = fs.readdirSync(env.SYM64_AUDIT).filter(f => !f.startsWith('policy-')).map(f => JSON.parse(fs.readFileSync(path.join(env.SYM64_AUDIT, f))));
  for (const a of actors) {
    const transcript = fs.readFileSync(summary.transcripts[actors.indexOf(a)], 'utf8');
    assert.match(transcript, /exec_command|shell_command/);
    for (const suffix of ['after-B', 'after-A', 'after-rollback']) {
      const marker = 'sym64-' + a.addressId.slice(-1) + '-' + suffix;
      const matches = audits.filter(v => v.argv.includes(marker)); assert.equal(matches.length, 1, marker);
      assert.equal(matches[0].result.exitCode, 0); assert.ok(transcript.includes(marker));
    }
    for (const n of [1, 2, 3]) {
      const probe = JSON.parse(fs.readFileSync(path.join(own(a), 'sym64-stage-' + n + '.json')));
      assert.equal(probe.status, 'passed');
    }
  }
  summary.status = 'native-completed-review-required';
  protectedState.beforeExit = metadataTree(production);
  atomic(path.join(ev, 'metadata-before-exit.json'), protectedState.beforeExit);
  summary.nextAction = 'Inspect native tool result events against cli-audit raw exact outputs, sender receipts, generation roots and all three live ps results before accepting 6.4. This status is deliberately not an automatic pass.';
} catch (error) { summary.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  try {
    if (pane) {
      for (const a of actors) {
        try { copyTranscript(sessions().find(s => s.runId === a.runId) ?? a, a.addressId + '-final'); } catch (e) { (summary.copyErrors ??= []).push(e.message); }
        try { const result = await request('cleanup-' + a.addressId, ['agent', 'close', '--id', a.addressId, '--force', '--reason', 'Host-owned isolated QA cleanup'], 60000); (summary.cleanup ??= []).push(result); } catch (e) { (summary.cleanupErrors ??= []).push(e.message); }
      }
      try { const stopped = await request('cleanup-service', ['service', 'stop'], 60000); (summary.cleanup ??= []).push(stopped); must(stopped); assert.equal(JSON.parse(stopped.stdout).state, 'stopped'); } catch (e) { (summary.cleanupErrors ??= []).push(e.message); }
      const agentSocket = path.join(stand, '.raf/tmp/tmux/server.sock');
      if (!fs.existsSync(agentSocket)) summary.agentTmuxCleanup = { outcome: 'not-created-or-already-removed', command: null, cliExitCode: null };
      else {
        const inspected = run('cleanup-agent-tmux-inspect', 'tmux', ['-S', agentSocket, 'list-sessions']);
        if (inspected.cliExitCode === 0) {
          summary.agentTmuxCleanup = run('cleanup-agent-tmux', 'tmux', ['-S', agentSocket, 'kill-server']);
          if (summary.agentTmuxCleanup.cliExitCode !== 0) (summary.cleanupErrors ??= []).push('Owned agent tmux server failed to stop');
        } else if (inspected.cliExitCode === 1 && inspected.signal === null && inspected.stderr.trim() === 'no server running on ' + agentSocket) {
          summary.agentTmuxCleanup = { outcome: 'already-stopped', command: null, cliExitCode: null, verification: inspected };
        } else {
          summary.agentTmuxCleanup = { outcome: 'verification-failed', verification: inspected };
          (summary.cleanupErrors ??= []).push('Owned agent tmux server state is unknown');
        }
      }
      summary.tmuxCleanup = run('cleanup-tmux', 'tmux', ['-S', socket, 'kill-server']);
      if (summary.tmuxCleanup.cliExitCode !== 0) (summary.cleanupErrors ??= []).push('Owned main tmux server failed to stop');
    }
  } catch (error) { (summary.cleanupErrors ??= []).push(error.message); }
  finally {
    try { summary.serviceProcessCleanup = await stopStandServices(root); }
    catch (error) { (summary.cleanupErrors ??= []).push(error.message); }
  }
  for (const commit of summary.actorCommits ?? []) {
    try {
      assert.ok([develop, root].includes(commit.repository));
      git(commit.repository, 'cat-file', '-e', commit.oid + '^{commit}');
      git(commit.repository, 'merge-base', '--is-ancestor', commit.oid, 'HEAD');
      commit.verifiedAfterExit = true;
    } catch (e) { (summary.cleanupErrors ??= []).push(e.message); }
  }
  if (protectedState && fs.existsSync(protectedState.production)) {
    const afterExit = metadataTree(protectedState.production);
    atomic(path.join(ev, 'metadata-after-exit.json'), afterExit);
    if (protectedState.beforeExit) {
      try { assert.deepEqual(afterExit, protectedState.beforeExit, 'Native exit cannot change protected metadata'); }
      catch (e) { (summary.cleanupErrors ??= []).push(e.message); }
    }
  }
  if (env.SYM64_AUDIT) {
    try { summary.cliAudit = archiveStandAudit(env.SYM64_AUDIT, ev); }
    catch (error) { (summary.cleanupErrors ??= []).push('CLI audit archive failed: ' + error.message); }
  }
  if (summary.cleanupErrors?.length) { summary.status = 'failed'; process.exitCode = 1; }
  stateKeepAlive?.close();
  summary.endedAt = new Date().toISOString(); atomic(path.join(ev, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, evidence: ev, error: summary.error?.message }));
}
