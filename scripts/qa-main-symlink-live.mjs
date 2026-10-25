import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configureLiveCodexTrust } from '../test/helpers/z4044-live-trust.mjs';
import { createStandGeneration } from './qa-main-agent-generation.mjs';
import { instrumentStandCli, stopStandServices, archiveStandAudit } from './qa-main-agent-channel-metadata.mjs';

const source = path.resolve(import.meta.dirname, '..'), reviewed = process.argv[2];
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.equal(process.env.CODEX_HOME, '/home/dev/.codex');
assert.equal(process.env.LC_ALL, 'C');
process.umask(0o077);
const stand = fs.mkdtempSync('/srv/dev/s72-'), root = path.join(stand, 'root'), ev = path.join(stand, 'ev');
const main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop'), hotfix = path.join(root, 'raf-hotfix');
const socket = path.join(develop, 'node_modules/.sym72/peer.sock');
for (const p of [root, ev, path.join(stand, 'commands')]) fs.mkdirSync(p, { recursive: true });
const env = { ...process.env, HOME: stand, RAF_QA_HOME: stand, TMPDIR: stand,
  XDG_CONFIG_HOME: path.join(stand, '.config'), GIT_CONFIG_GLOBAL: path.join(stand, 'gitconfig') };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL' ||
  key.startsWith('RAF_') && key !== 'RAF_QA_HOME' || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'NODE_PATH', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n name = Isolated QA\n email = qa@example.invalid\n[commit]\n gpgsign = false\n');
const atomic = (p, value) => { fs.writeFileSync(p + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(p + '.part', p); };
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const summary = { status: 'failed', reviewed, stand, command: [process.execPath, ...process.argv.slice(1)], startedAt: new Date().toISOString(),
  commands: [], scenarios: [], completed: [], pending: ['actual-start', 'develop-main', 'hotfix-main-develop', 'rollback', 'native-channel', 'pending-report-message', 'handover', 'repeat-start'],
  scope: 'Host executes real production start, native provider and shared release gates on a fresh isolated Git stand. No mocked runner, synthetic report acceptance, always-true compatibility/handover, unit execution or production HOME writes.', cleanup: { complete: false } };
let sequence = 0, publicationNumber = 0, pane = false, actor, mainRecord, hh, activation, storage, currentService, handedOver = true;
const run = (label, exe, args, cwd = root, budget = 120000) => {
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024 });
  const value = { command: [exe, ...args], cwd, cliExitCode: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(ev, label + '.' + stream), value[stream]);
  atomic(path.join(ev, label + '.json'), value); summary.commands.push({ label, cliExitCode: value.cliExitCode, signal: value.signal }); return value;
};
const must = r => { assert.equal(r.error, null); assert.equal(r.signal, null); assert.equal(r.cliExitCode, 0, r.stderr); return r.stdout.trim(); };
const git = (cwd, ...args) => must(run('git-' + (++sequence), 'git', ['--no-optional-locks', '-C', cwd, ...args], cwd));
const wait = async (label, check, budget = 1200000) => {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(300); }
  throw Error('Unexecuted remainder: ' + label);
};
const request = async (label, args, budget = 1200000) => {
  const target = path.join(ev, label + '.json'); assert.ok(!fs.existsSync(target), 'Never repeat an unknown invocation');
  atomic(path.join(stand, 'commands', String(++sequence).padStart(5, '0') + '.json'), { label, args, budget });
  return wait(label, () => fs.existsSync(target) && read(target), budget + 10000);
};
const database = operation => {
  const db = new DatabaseSync(path.join(stand, '.raf/state.sqlite')); db.exec('PRAGMA busy_timeout=10000');
  try { return operation(db); } finally { db.close(); }
};
const sessions = () => database(db => db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload)));
const own = () => path.dirname(actor.launchContext.reportPath);
const ready = n => fs.existsSync(path.join(own(), `sym72-ready-${n}.json`));
const gate = n => fs.writeFileSync(path.join(own(), `sym72-go-${n}`), 'host');
const complete = name => { summary.completed.push(name); summary.pending = summary.pending.filter(x => x !== name); atomic(path.join(ev, 'summary.json'), summary); };
const identity = pid => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { pid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
};
const dirty = cwd => ({ head: git(cwd, 'rev-parse', 'HEAD'), status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
  index: hash(git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index')),
  staged: git(cwd, 'diff', '--cached', '--binary'), unstaged: git(cwd, 'diff', '--binary'),
  files: Object.fromEntries(['staged.txt', 'unstaged.txt', 'untracked.txt'].map(name => [name, hash(path.join(cwd, 'qa', name))])) });
const controls = async label => {
  must(await request(label + '-ps', ['agent', 'ps']));
  const latest = sessions().find(s => s.runId === actor.runId); assert.ok(latest);
  for (const field of ['pid', 'startedAt', 'runnerSessionId']) assert.equal(latest.process?.[field], actor.process[field], field);
  assert.deepEqual(identity(actor.process.pid), summary.actorIdentity);
  assert.equal(hash(actor.launchContext.briefPath), summary.actorBriefSha256);
  assert.ok(fs.existsSync(actor.launchContext.reportPath) || fs.existsSync(own()));
  atomic(path.join(ev, label + '-native.json'), { session: latest, identity: identity(actor.process.pid), readlink: fs.readlinkSync(main) });
};
const slotInfo = async slot => {
  const cwd = path.join(root, 'raf-main-' + slot), commit = git(cwd, 'rev-parse', 'HEAD'), tree = git(cwd, 'rev-parse', 'HEAD^{tree}');
  return { root: cwd, commit, fingerprint: hh.hash(JSON.stringify({ commit, tree, files: await hh.inventory(cwd),
    configuration: (await hh.inventory(path.join(root, 'conf'), new Set())).map(file => ({ ...file, path: path.join('conf', file.path) })) })) };
};
const foreign = () => git(root, 'ls-files', '--stage').split('\n').filter(line => !/\t(?:raf-main(?:-[ab])?|\.gitmodules)$/.test(line));
async function snapshot(label) {
  const value = { ...(await storage.inspect()), readlink: fs.readlinkSync(main), rootStatus: git(root, 'status', '--porcelain'),
    mainStatus: git(main, 'status', '--porcelain'), staged: git(root, 'ls-files', '--stage'), gitmodules: fs.readFileSync(path.join(root, '.gitmodules'), 'utf8'),
    state: database(db => ({ user_version: db.prepare('PRAGMA user_version').get().user_version, data: db.prepare('SELECT * FROM qa_sym72_data ORDER BY marker').all() })), sessions: sessions() };
  atomic(path.join(ev, label + '.json'), value); return value;
}
async function archiveNative(label) {
  if (!actor) return;
  const target = path.join(ev, label); fs.mkdirSync(target, { recursive: true });
  if (fs.existsSync(own())) fs.cpSync(own(), path.join(target, 'run'), { recursive: true, filter: p => { const s = fs.lstatSync(p); return s.isFile() || s.isDirectory(); } });
  const found = [];
  const walk = directory => { for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
    const p = path.join(directory, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(actor.process.runnerSessionId)) found.push(p);
  } };
  walk(path.join(env.CODEX_HOME, 'sessions')); assert.equal(found.length, 1, 'Require exact original native transcript');
  fs.copyFileSync(found[0], path.join(target, 'native.jsonl')); atomic(path.join(target, 'session.json'), sessions().find(s => s.runId === actor.runId));
}
console.log(JSON.stringify({ stand, evidence: ev, reviewed }));
try {
  assert.equal(git(source, 'rev-parse', 'HEAD'), reviewed); assert.equal(git(source, 'status', '--porcelain'), '', 'Clean reviewed clone required');
  for (const [exe, args] of [['node', ['--version']], ['codex', ['--version']], ['git', ['--version']], ['tmux', ['-V']], ['bwrap', ['--version']], ['uname', ['-a']]]) must(run('version-' + exe, exe, args));
  fs.cpSync(path.join(path.dirname(source), 'conf'), path.join(root, 'conf'), { recursive: true });
  const projects = read(path.join(root, 'conf/projects.json'));
  projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator };
  Object.assign(projects.projects.raf, { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' }, mainCopies: ['raf-main-a', 'raf-main-b'] });
  atomic(path.join(root, 'conf/projects.json'), projects);
  const settings = read(path.join(root, 'conf/raf.json')); summary.trust = configureLiveCodexTrust(settings, root); atomic(path.join(root, 'conf/raf.json'), settings);
  must(run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main])); git(main, 'checkout', '-B', 'main', reviewed);
  fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
  fs.mkdirSync(path.join(main, 'qa'));
  for (const name of ['staged.txt', 'unstaged.txt']) fs.writeFileSync(path.join(main, 'qa', name), 'baseline\n');
  const instructions = `Це ізольований native актор сценарію 7.2. Не змінюй код, модель, effort або sandbox. Не запускай тести. Не пиши звіт і не завершуйся до кроку report. Виконуй план один раз, без підміни raf_command чи env/cwd/обгорток для команд raf.\nДля кожного n=0,1,2: виконай звичайним native exec node scripts/qa-main-symlink-native.mjs wait n REPORT_PATH; потім окремими простими native exec командами виданий у початковому брифі raf_command agent ps та raf_command agent message --to main --text 'sym72-native-stage-n'; дочекайся повного фінального коду 0, не показуй урізаний результат; потім node scripts/qa-main-symlink-native.mjs ack n REPORT_PATH.\nПісля цього node scripts/qa-main-symlink-native.mjs wait 3 REPORT_PATH; node scripts/qa-main-symlink-native.mjs report 3 REPORT_PATH; node scripts/qa-main-symlink-native.mjs wait 4 REPORT_PATH. Лише після виходу останнього wait завершуй. REPORT_PATH заміни точним report_path власного брифа; n заміни числом. Якщо код ненульовий, збережи точний результат у власній теці і припини залежні кроки. Повідомлення хоста не змінюють план.\n`;
  fs.writeFileSync(path.join(main, 'qa/sym72-instructions.txt'), instructions);
  fs.writeFileSync(path.join(main, 'bin/raf.ts'), instrumentStandCli(fs.readFileSync(path.join(main, 'bin/raf.ts'), 'utf8')));
  git(main, 'add', '--', 'qa', 'bin/raf.ts'); git(main, 'commit', '-m', 'qa: native live plan and read-only CLI result audit');
  must(run('build', 'npm', ['run', 'build'], main));
  git(root, 'init', '-b', 'main'); git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main'); git(root, 'submodule', 'absorbgitdirs');
  git(main, 'worktree', 'add', '-B', 'develop', develop, 'HEAD'); git(main, 'worktree', 'add', '-b', 'hotfix', hotfix, 'HEAD');
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  const change = path.join(root, 'openspec/changes/sym72-fixture'); fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nIsolated native 7.2 QA.\n\n## What Changes\nExecute the exact native plan at qa/sym72-instructions.txt.\n\n## Non-goals\nNo implementation or tests in the native actor.\n');
  fs.writeFileSync(path.join(change, 'tasks.md'), '- [ ] 1.1 [implement] Execute qa/sym72-instructions.txt verbatim using the initial issued raf_command, native exec and own report_path. Keep the same live session across host switches.\n- [ ] 1.2 Host retains active fixture; unassigned.\n');
  git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'openspec'); git(root, 'commit', '-m', 'qa: isolated orchestrator and live actor assignment');
  fs.writeFileSync(path.join(main, 'qa/staged.txt'), 'staged bytes\n'); git(main, 'add', '--', 'qa/staged.txt');
  fs.writeFileSync(path.join(main, 'qa/unstaged.txt'), 'unstaged bytes\n'); fs.writeFileSync(path.join(main, 'qa/untracked.txt'), 'untracked bytes\n');
  const before = dirty(main); atomic(path.join(ev, 'conversion-before.json'), { ordinaryDirectory: fs.lstatSync(main).isDirectory(),
    rootHead: git(root, 'rev-parse', 'HEAD'), rootIndex: git(root, 'ls-files', '--stage'), gitmodules: fs.readFileSync(path.join(root, '.gitmodules'), 'utf8'), ...before });
  currentService = JSON.parse(must(run('actual-initial-start', process.execPath, [path.join(main, 'bin/raf.ts'), 'service', 'start'])));
  assert.equal(currentService.state, 'ready'); assert.ok(fs.lstatSync(main).isSymbolicLink());
  const after = dirty(main); atomic(path.join(ev, 'conversion-after.json'), { readlink: fs.readlinkSync(main), realpath: fs.realpathSync(main),
    rootHead: git(root, 'rev-parse', 'HEAD'), rootIndex: git(root, 'ls-files', '--stage'), gitmodules: fs.readFileSync(path.join(root, '.gitmodules'), 'utf8'), ...after });
  assert.deepEqual(after, before, 'Actual start must preserve exact dirty Git/index/file state'); complete('actual-start');
  git(main, 'add', '--', 'qa/staged.txt', 'qa/unstaged.txt', 'qa/untracked.txt'); git(main, 'commit', '-m', 'qa: retain conversion sentinels as release baseline');
  const baseline = git(main, 'rev-parse', 'HEAD');
  git(root, 'update-index', '--add', '--cacheinfo', '160000', baseline, 'raf-main-a');
  for (const cwd of [develop, hotfix]) { git(cwd, 'fetch', '--no-tags', main, baseline); git(cwd, 'merge', '--ff-only', baseline); }
  const A = path.join(root, 'raf-main-a'), B = path.join(root, 'raf-main-b');
  for (const cwd of [B, develop, hotfix]) for (const name of ['node_modules', 'dist']) fs.cpSync(path.join(A, name), path.join(cwd, name), { recursive: true, dereference: true });
  const paneSource = fs.readFileSync(path.join(source, 'test/helpers/z4044-main-pane.mjs'), 'utf8');
  fs.writeFileSync(path.join(stand, 'main-pane.mjs'), paneSource);
  env.SYM64_AUDIT = path.join(develop, 'node_modules/.sym72/audit'); fs.mkdirSync(env.SYM64_AUDIT, { recursive: true });
  must(run('main-pane', 'tmux', ['-S', socket, 'new-session', '-d', '-s', 'sym72-main', '-x', '180', '-y', '50', process.execPath, path.join(stand, 'main-pane.mjs'), stand])); pane = true;
  mainRecord = JSON.parse(must(await wait('main attach', () => fs.existsSync(path.join(stand, 'main-ready.json')) && read(path.join(stand, 'main-ready.json')))));
  assert.equal(mainRecord.tmuxSocket, socket);
  must(await request('runner-list', ['runner', 'list'])); must(await request('runner-limits', ['runner', 'limits', '--runners', 'codex']));
  hh = await import(pathToFileURL(path.join(A, 'src/hotfix-host.ts'))); activation = await import(pathToFileURL(path.join(A, 'src/hotfix-activation.ts')));
  const host = { orchestratorRoot: root, qaHome: stand, environment: env, sandboxExecutable: 'codex' };
  const reader = await activation.acquireHotfixReader(host, 'hook'); await reader.release();
  const register = async cwd => hh.locked(host, async route => {
    const parent = path.join(route.control, 'generations', randomUUID()), target = path.join(parent, 'raf-main');
    fs.mkdirSync(parent, { recursive: true }); await hh.copyTree(cwd, target);
    fs.cpSync(path.join(root, 'conf'), path.join(parent, 'conf'), { recursive: true });
    await hh.durable(path.join(parent, 'ownership.json'), { root: target, orchestratorRoot: root, repositoryIdentity: route.repositoryIdentity });
    const value = await createStandGeneration(target, git(cwd, 'rev-parse', 'HEAD'), hh);
    const registryFile = path.join(route.control, 'registry.json'), registry = read(registryFile);
    registry.generations[target] = value; registry.current = target; await hh.durable(registryFile, registry); return value;
  });
  await register(A);
  must(await request('launch', ['agent', 'run', '--id', 'sym72-native', '--type', 'implement', '--project', 'raf', '--features', 'sym72-fixture', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'sym72-fixture:1.1']));
  actor = await wait('native registration', () => sessions().find(s => s.addressId === 'sym72-native' && s.state === 'running'));
  assert.equal(actor.launchContext.selection.runner, 'codex', 'Existing configuration must select native codex');
  await wait('native initial barrier', () => ready(0));
  summary.actor = actor; summary.actorIdentity = identity(actor.process.pid); summary.actorBriefSha256 = hash(actor.launchContext.briefPath);
  gate(0); await wait('native original-prefix commands before switch', () => fs.existsSync(path.join(own(), 'sym72-ack-0.json')));
  database(db => { db.exec('CREATE TABLE qa_sym72_data (marker TEXT PRIMARY KEY)'); db.prepare('INSERT INTO qa_sym72_data VALUES (?)').run('A-before'); });
  const common = git(develop, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  summary.configuration = Object.fromEntries(['raf-constants.json', 'projects.json', 'raf.json', 'flow.json', 'test-runs.json'].map(name => [name, hash(path.join(root, 'conf', name))]));
  const intentPath = path.join(stand, 'publication-intent.json'), publishedPath = path.join(stand, 'published.json');
  const active = () => fs.realpathSync(main) === A ? 'a' : 'b';
  storage = {
    logicalPath: main,
    async inspect() {
      const slot = active(), slots = { a: await slotInfo('a'), b: await slotInfo('b') };
      const line = git(root, 'ls-files', '--stage').split('\n').find(line => /^160000 /.test(line)); assert.ok(line);
      return { active: slot, slots, head: slots[slot].commit, mainRef: git(main, 'rev-parse', 'refs/heads/main'), indexTree: git(root, 'write-tree'),
        gitlink: { path: line.split('\t')[1], commit: line.split(' ')[1], repository: common },
        gitmodules: { path: git(root, 'config', '-f', '.gitmodules', '--get', 'submodule.raf-main.path'), repository: common },
        foreignIndexFingerprint: hh.hash(JSON.stringify(foreign())), activationComplete: !fs.existsSync(intentPath), handoverComplete: handedOver,
        readers: Object.fromEntries(['a', 'b'].map(key => [key, fs.readdirSync(path.join(common, 'raf-hotfix/readers')).flatMap(name => {
          const lease = read(path.join(common, 'raf-hotfix/readers', name));
          return lease.root === slots[key].root ? [name] : [];
        })])) };
    },
    async withPublicationLock(operation) {
      const lock = path.join(stand, 'publication.lock'); fs.mkdirSync(lock);
      try { return await operation(); } finally { fs.rmSync(lock, { recursive: true }); }
    },
    async prepareInactive(releaseSource, destination) {
      const cwd = path.join(root, 'raf-main-' + destination), commit = git(releaseSource.workspace.cwd, 'rev-parse', 'HEAD');
      git(cwd, 'fetch', '--no-tags', '--no-write-fetch-head', releaseSource.workspace.cwd, commit); git(cwd, 'checkout', '--detach', commit);
      return { ...releaseSource.workspace, cwd, gitDirectory: fs.realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir')),
        commonDirectory: fs.realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')) };
    },
    async assertSnapshot(candidate) { const info = await slotInfo(candidate.workspace.cwd === A ? 'a' : 'b'); assert.equal(info.commit, candidate.commit); assert.equal(info.fingerprint, candidate.fingerprint); },
    async readIntent() { return fs.existsSync(intentPath) ? read(intentPath) : undefined; },
    async writeIntent(intent) { atomic(intentPath, intent); },
    async probeRename() {
      const probe = path.join(root, '.rename-' + randomUUID()); fs.symlinkSync(A, probe);
      try { fs.renameSync(probe, probe + '.done'); return { supported: true, sameDevice: fs.statSync(A).dev === fs.statSync(B).dev && fs.statSync(root).dev === fs.statSync(A).dev }; }
      finally { fs.rmSync(probe, { force: true }); fs.rmSync(probe + '.done', { force: true }); }
    },
    async createTemporarySymlink(target) { const p = main + '.' + randomUUID(); fs.symlinkSync(target, p); return p; },
    async renameSymlink(temporary, logical) { fs.renameSync(temporary, logical); handedOver = false; },
    async removeTemporarySymlink(p) { fs.rmSync(p, { force: true }); },
    async reconcileGit(intent, slot) {
      const cwd = path.join(root, 'raf-main-' + slot), other = slot === 'a' ? B : A, preserved = foreign();
      const commit = git(cwd, 'rev-parse', 'HEAD');
      if (git(other, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main') git(other, 'checkout', '--detach');
      git(cwd, 'update-ref', 'refs/heads/main', commit); git(cwd, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      for (const p of ['raf-main-a', 'raf-main-b']) git(root, 'update-index', '--force-remove', p);
      git(root, 'update-index', '--add', '--cacheinfo', '160000', commit, 'raf-main-' + slot);
      git(root, 'config', '-f', '.gitmodules', 'submodule.raf-main.path', 'raf-main-' + slot); git(root, 'add', '--', '.gitmodules');
      assert.deepEqual(foreign(), preserved);
      const published = fs.existsSync(publishedPath) ? read(publishedPath) : {}; published[slot] = intent.candidate; atomic(publishedPath, published);
      summary.registeredGeneration = await register(cwd);
    },
    async clearIntent(id) { assert.equal(read(intentPath).id, id); fs.unlinkSync(intentPath); },
    async resolvePublished(cwd, fingerprint) { return fs.existsSync(publishedPath) && Object.values(read(publishedPath)).some(value => value.workspace.cwd === cwd && value.fingerprint === fingerprint); },
    async loadPublished(slot) { return read(publishedPath)[slot]; }
  };
  const { createMainSymlinkRelease } = await import(pathToFileURL(path.join(A, 'src/main-symlink-release.ts')));
  const { MainVersionCompatibility } = await import(pathToFileURL(path.join(A, 'src/main-version-compatibility.ts')));
  const compatible = async (previous, candidate) => {
    const version = database(db => db.prepare('PRAGMA user_version').get().user_version);
    const client = id => ({ contract: { id, schemaVersions: [version], readableFormats: [1], requiredColumns: ['sessions.payload', 'qa_sym72_data.marker'] },
      probe(db) { for (const row of db.prepare('SELECT payload FROM sessions').all()) JSON.parse(row.payload); db.prepare('INSERT INTO qa_sym72_data VALUES (?)').run('probe-' + id); } });
    const result = new MainVersionCompatibility().checkRelease({ path: path.join(stand, '.raf/state.sqlite'), context: { kind: 'isolated-qa', home: stand, codeRoot: A }, current: client(previous.head), candidate: client(candidate.commit) });
    atomic(path.join(ev, 'compatibility-' + (++sequence) + '.json'), result); return { compatible: result.compatible, reason: result.reasonCodes.join(',') };
  };
  const release = createMainSymlinkRelease({ host, storage, shared: { verify: activation.verifyHotfixCandidate, activate: activation.activateHotfix, recover: activation.recoverHotfixActivation }, compatibility: compatible,
    async confirmHandover(slot) {
      publicationNumber++;
      if (publicationNumber === 2) {
        summary.reportBoundary = { slot, publicationNumber, beganAt: new Date().toISOString() };
        gate(2); await wait('native commands during second handover', () => fs.existsSync(path.join(own(), 'sym72-ack-2.json')));
        await wait('native report boundary', () => ready(3));
        must(await request('pending-message', ['agent', 'message', '--to', actor.addressId, '--text', 'sym72-host-pending-message']));
        gate(3); await wait('native atomic report during handover', () => fs.existsSync(actor.launchContext.reportPath));
        summary.reportBoundary.writtenAt = new Date().toISOString();
        atomic(path.join(ev, 'native-written-report.json'), read(actor.launchContext.reportPath));
        atomic(path.join(ev, 'handover-pending-before.json'), database(db => ({ sessions: sessions(), pending: db.prepare('SELECT * FROM pending_intents').all(), notices: db.prepare('SELECT * FROM result_notices').all() })));
      }
      const result = await request('handover-start-' + (++sequence), ['service', 'start']);
      const status = JSON.parse(must(result)); const registry = read(path.join(common, 'raf-hotfix/registry.json'));
      const expected = registry.current;
      const proof = { slot, before: currentService, after: status, expected, nativeIdentity: identity(actor.process.pid), nativeUnchanged: JSON.stringify(identity(actor.process.pid)) === JSON.stringify(summary.actorIdentity),
        ready: status.state === 'ready' && status.mainPath === expected && status.resourceWaitReady === true };
      atomic(path.join(ev, 'handover-' + (++sequence) + '.json'), proof);
      if (publicationNumber === 2) summary.reportBoundary.confirmedAt = new Date().toISOString();
      handedOver = proof.ready && proof.nativeUnchanged; currentService = status; return handedOver;
    } });
  const requestRelease = async (kind, marker) => {
    const cwd = kind === 'develop' ? develop : hotfix, baseCommit = git(main, 'rev-parse', 'HEAD');
    git(cwd, 'fetch', '--no-tags', main, baseCommit); git(cwd, 'merge', '--no-edit', baseCommit);
    fs.writeFileSync(path.join(cwd, 'qa/release-marker.txt'), marker + '\n'); git(cwd, 'add', '--', 'qa/release-marker.txt'); git(cwd, 'commit', '-m', marker);
    const runId = randomUUID();
    const workspace = { runId, orchestratorRoot: root, project: 'raf', targetBranch: 'main', cwd, baseCommit, repositoryIdentity: common,
      gitDirectory: fs.realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir')), commonDirectory: common, ownershipPath: path.join(root, '.raf-hotfix/runs', runId, 'ownership.json') };
    const before = await snapshot(marker + '-before');
    const prepared = await release.prepare({ source: { kind, workspace }, regression: { executable: process.execPath, args: ['--input-type=module', '-e', "import fs from 'node:fs';if(!fs.readFileSync('qa/release-marker.txt','utf8').trim())throw Error('Missing release marker');await import('./src/production-entry.ts');"] }, mainAddress: 'main', message: 'sym72-gate-' + marker });
    atomic(path.join(ev, marker + '-prepared.json'), prepared);
    fs.cpSync(path.dirname(prepared.candidate.evidencePath), path.join(ev, marker + '-gates'), { recursive: true, filter: p => path.basename(p) !== 'stand' });
    const result = await release.publish(prepared); atomic(path.join(ev, marker + '-result.json'), result);
    const after = await snapshot(marker + '-after'); assert.notEqual(before.active, after.active); await controls(marker);
    summary.scenarios.push({ name: marker, status: 'succeeded', before: marker + '-before.json', after: marker + '-after.json' }); return prepared;
  };
  const first = await requestRelease('develop', 'develop-main'); complete('develop-main');
  gate(1); await wait('native original-prefix commands after first switch', () => fs.existsSync(path.join(own(), 'sym72-ack-1.json')));
  const second = await requestRelease('hotfix', 'hotfix-main');
  const hotfixCommit = git(main, 'rev-parse', 'HEAD'); git(develop, 'fetch', '--no-tags', main, hotfixCommit); git(develop, 'merge', '--no-edit', hotfixCommit);
  git(develop, 'merge-base', '--is-ancestor', hotfixCommit, 'HEAD'); complete('hotfix-main-develop');
  assert.ok(summary.reportBoundary?.writtenAt); complete('native-channel');
  database(db => db.prepare('INSERT INTO qa_sym72_data VALUES (?)').run('new-release-write'));
  const rollbackBefore = await snapshot('rollback-before'); const rollbackResult = await release.rollback(second); atomic(path.join(ev, 'rollback-result.json'), rollbackResult);
  const rollbackAfter = await snapshot('rollback-after'); assert.notEqual(rollbackBefore.active, rollbackAfter.active);
  assert.ok(rollbackAfter.state.data.some(row => row.marker === 'new-release-write')); assert.equal(rollbackAfter.state.user_version, rollbackBefore.state.user_version); complete('rollback');
  const accepted = await wait('production accepts exact native JSON', () => sessions().find(s => s.runId === actor.runId && s.reportAcceptance));
  atomic(path.join(ev, 'accepted-session.json'), accepted); assert.equal(accepted.result?.status, 'succeeded');
  const facts = database(db => ({ pending: db.prepare('SELECT * FROM pending_intents').all(), notices: db.prepare('SELECT * FROM result_notices').all() })); atomic(path.join(ev, 'pending-report-message.json'), facts);
  assert.equal(accepted.runId, actor.runId); assert.deepEqual(identity(actor.process.pid), summary.actorIdentity);
  assert.equal(facts.notices.filter(row => row.run_id === actor.runId && !String(row.id).includes('report-rejected')).length, 1);
  complete('pending-report-message'); complete('handover');
  const repeatedBefore = await snapshot('repeat-before'); const repeated = JSON.parse(must(await request('repeat-start', ['service', 'start']))); const repeatedAfter = await snapshot('repeat-after');
  for (const key of ['active', 'slots', 'readlink', 'gitlink', 'gitmodules', 'mainRef', 'head']) assert.deepEqual(repeatedAfter[key], repeatedBefore[key]);
  assert.equal(repeated.state, 'ready'); await controls('repeat'); complete('repeat-start');
  await archiveNative('native-completed'); gate(4);
  assert.deepEqual(summary.pending, []); summary.status = 'succeeded';
} catch (error) {
  summary.error = { message: error.message, stack: error.stack, code: error.code ?? null };
  summary.scenarios.push({ name: summary.pending[0] ?? 'final-verification', status: 'failed', reason: error.message });
  process.stderr.write(error.stack + '\n'); process.exitCode = 1;
} finally {
  try { await archiveNative('native-final'); } catch (error) { summary.archiveError = String(error); summary.status = 'failed'; process.exitCode = 1; }
  if (env.SYM64_AUDIT) try { summary.cliAudit = archiveStandAudit(env.SYM64_AUDIT, ev); } catch (error) { summary.auditError = String(error); summary.status = 'failed'; process.exitCode = 1; }
  if (pane) {
    if (actor) try { const latest = sessions().find(s => s.runId === actor.runId); if (latest?.state !== 'finished') must(await request('cleanup-actor', ['agent', 'close', '--id', actor.addressId, '--force'], 120000)); } catch (error) { summary.cleanup.actorError = String(error); }
    try { must(await request('cleanup-service', ['service', 'stop'], 120000)); } catch (error) { summary.cleanup.serviceError = String(error); }
    run('cleanup-main', 'tmux', ['-S', socket, 'kill-server']);
  }
  const services = await stopStandServices(root); summary.cleanup.services = services;
  if (actor?.process?.evidence?.tmuxSocket) run('cleanup-runner-tmux', 'tmux', ['-S', actor.process.evidence.tmuxSocket, 'kill-server']);
  summary.cleanup.complete = services.complete && !summary.cleanup.actorError && !summary.cleanup.serviceError;
  if (!summary.cleanup.complete) { summary.status = 'failed'; process.exitCode = 1; }
  summary.finishedAt = new Date().toISOString(); atomic(path.join(ev, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, evidence: ev, completed: summary.completed, pending: summary.pending, cleanup: summary.cleanup }));
}
