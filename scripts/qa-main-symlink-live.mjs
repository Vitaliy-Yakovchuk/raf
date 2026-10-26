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
import { prepareStandService } from './qa-main-service-handover.mjs';
import { instrumentStandCli, stopStandServices, archiveStandAudit } from './qa-main-agent-channel-metadata.mjs';
import { prepareLegacyLiveProjects, prepareLiveProjects, prepareFailedNativeClose, prepareLiveReleaseCandidate, copyLiveReleaseArtifacts, archiveFailedLiveReport, describeFailedLiveAttempt, liveControlLabel, handoverLiveService, parseLiveMainRecord, prepareLiveVerificationHost, retainLiveCommandEvidence, guardLiveNativeWait, stopLiveServiceOwner } from './qa-main-symlink-fixture.ts';

const source = path.resolve(import.meta.dirname, '..'), reviewed = process.argv[2];
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
const resumeAfterRetainedCaptures = process.argv[3] === '--resume-after-retained-captures';
const resumeAfterVerificationHome = process.argv[3] === '--resume-after-verification-home' || resumeAfterRetainedCaptures;
const resumeAfterServiceRecord = process.argv[3] === '--resume-after-service-record' || resumeAfterVerificationHome;
const resumeAfterServiceOwnership = process.argv[3] === '--resume-after-service-ownership' || resumeAfterServiceRecord;
const resumeAfterGenerationActorFailure = process.argv[3] === '--resume-after-generation-actor-failure';
const resumeAfterGenerationInventory = process.argv[3] === '--resume-after-generation-inventory' || resumeAfterGenerationActorFailure || resumeAfterServiceOwnership;
const resumeAfterControlLabel = process.argv[3] === '--resume-after-control-label' || resumeAfterGenerationInventory;
const resumeAfterInstructionCommit = process.argv[3] === '--resume-after-instruction-commit' || resumeAfterControlLabel;
const resumeAfterArchivedClose = process.argv[3] === '--resume-after-report-close' || resumeAfterInstructionCommit;
const resumeAfterWaitReport = process.argv[3] === '--resume-after-native-wait-report' || resumeAfterArchivedClose;
const resumeAfterCatalog = process.argv[3] === '--resume-after-catalog-build' || resumeAfterWaitReport;
const resumeAfterClose = process.argv[3] === '--resume-after-close-refusal' || resumeAfterCatalog;
const resumeAfterOnboarding = process.argv[3] === '--resume-after-main-onboarding' || resumeAfterClose;
const resumeAfterVersion = process.argv[3] === '--resume-after-version-check' || resumeAfterOnboarding;
const resume = process.argv[3] === '--resume-after-start' || resumeAfterVersion;
assert.ok(process.argv.length === 3 || resume && process.argv.length === 5);
for (const key of ['CODEX_HOME', 'HOME']) assert.ok(path.isAbsolute(process.env[key] ?? ''), key + ' must be an existing absolute host selector');
if (process.env.CLAUDE_CONFIG_DIR !== undefined) assert.ok(path.isAbsolute(process.env.CLAUDE_CONFIG_DIR), 'CLAUDE_CONFIG_DIR must be an absolute host selector when set');
assert.equal(process.env.LC_ALL, 'C');
process.umask(0o077);
const stand = resume ? fs.realpathSync(process.argv[4]) : fs.mkdtempSync('/srv/dev/s72-');
assert.match(stand, /^\/srv\/dev\/s72-[A-Za-z0-9]+$/);
const root = path.join(stand, 'root'), ev = path.join(stand, resumeAfterRetainedCaptures ? 'ev-native-retained-captures' : resumeAfterVerificationHome ? 'ev-native-verification-home' : resumeAfterServiceRecord ? 'ev-native-service-record' : resumeAfterServiceOwnership ? 'ev-native-service-ownership' : resumeAfterGenerationActorFailure ? 'ev-native-generation-actor-failure' : resumeAfterGenerationInventory ? 'ev-native-generation-inventory' : resumeAfterControlLabel ? 'ev-native-control-label' : resumeAfterInstructionCommit ? 'ev-native-instruction-commit' : resumeAfterArchivedClose ? 'ev-native-report-close' : resumeAfterWaitReport ? 'ev-native-wait-report' : resumeAfterCatalog ? 'ev-native-catalog-build' : resumeAfterClose ? 'ev-native-close-reason' : resumeAfterOnboarding ? 'ev-native-main-home' : resumeAfterVersion ? 'ev-native-main-version' : resume ? 'ev-native-main' : 'ev');
const commands = path.join(stand, resumeAfterRetainedCaptures ? 'commands-native-retained-captures' : resumeAfterVerificationHome ? 'commands-native-verification-home' : resumeAfterServiceRecord ? 'commands-native-service-record' : resumeAfterServiceOwnership ? 'commands-native-service-ownership' : resumeAfterGenerationActorFailure ? 'commands-native-generation-actor-failure' : resumeAfterGenerationInventory ? 'commands-native-generation-inventory' : resumeAfterControlLabel ? 'commands-native-control-label' : resumeAfterInstructionCommit ? 'commands-native-instruction-commit' : resumeAfterArchivedClose ? 'commands-native-report-close' : resumeAfterWaitReport ? 'commands-native-wait-report' : resumeAfterCatalog ? 'commands-native-catalog-build' : resumeAfterClose ? 'commands-native-close-reason' : resumeAfterOnboarding ? 'commands-native-main-home' : resumeAfterVersion ? 'commands-native-main-version' : resume ? 'commands-native-main' : 'commands');
const controlEv = resumeAfterClose ? path.join(stand, 'ev-native-main-home') : ev;
const controlCommands = resumeAfterClose ? path.join(stand, 'commands-native-main-home') : commands;
const main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop'), hotfix = path.join(root, 'raf-hotfix');
const socket = path.join(develop, 'node_modules/.sym72/peer.sock');
if (!resume) fs.mkdirSync(root);
for (const p of [ev, commands]) fs.mkdirSync(p);
const env = { ...process.env, HOME: stand, RAF_QA_HOME: stand, TMPDIR: stand, SYM72_CLAUDE_HOME: process.env.HOME,
  XDG_CONFIG_HOME: path.join(stand, '.config'), GIT_CONFIG_GLOBAL: path.join(stand, 'gitconfig') };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL' ||
  key.startsWith('RAF_') && key !== 'RAF_QA_HOME' || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
if (!resume) fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n name = Isolated QA\n email = qa@example.invalid\n[commit]\n gpgsign = false\n');
const atomic = (p, value) => { fs.writeFileSync(p + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(p + '.part', p); };
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const summary = { status: 'failed', reviewed, stand, command: [process.execPath, ...process.argv.slice(1)], startedAt: new Date().toISOString(),
  commands: [], scenarios: [], completed: [], pending: ['actual-start', 'develop-main', 'hotfix-main-develop', 'rollback', 'native-channel', 'pending-report-message', 'handover', 'repeat-start'],
  scope: 'Host executes real production start, native provider and shared release gates on a fresh isolated Git stand. No mocked runner, synthetic report acceptance, always-true compatibility/handover, unit execution or production HOME writes.', cleanup: { complete: false } };
let sequence = 0, publicationNumber = 0, pane = false, actor, mainRecord, hh, activation, storage, currentService, nativeCompletion, handedOver = true, replacementAfterServiceRecord = false;
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
  while (Date.now() < deadline) {
    const value = await check(); if (value) return value;
    if (actor) {
      guardLiveNativeWait(label, nativeCompletion ?? { released: false, pending: summary.pending, actorRunId: actor.runId }, () => {
      const latest = sessions().find(s => s.runId === actor.runId);
      if (latest?.result?.status === 'failed' || latest?.state === 'failed') throw Error('Native actor failed before ' + label + '; inspect exact report ' + actor.launchContext.reportPath);
      try { assert.deepEqual(identity(actor.process.pid), summary.actorIdentity ?? identity(actor.process.pid)); }
      catch { throw Error('Native process lost before ' + label + '; no dependent retry'); }
      });
    }
    await delay(300);
  }
  throw Error('Unexecuted remainder: ' + label);
};
const request = async (label, args, budget = 1200000) => {
  const target = path.join(ev, label + '.json'); assert.ok(!fs.existsSync(target), 'Never repeat an unknown invocation');
  const controlPrefix = resumeAfterRetainedCaptures ? 'retained-captures-resume-' : resumeAfterVerificationHome ? 'verification-home-resume-' : resumeAfterServiceRecord ? 'service-record-resume-' : resumeAfterServiceOwnership ? 'service-ownership-resume-' : resumeAfterGenerationActorFailure ? 'generation-actor-resume-' : resumeAfterGenerationInventory ? 'generation-inventory-resume-' : resumeAfterControlLabel ? 'control-label-resume-' : resumeAfterInstructionCommit ? 'instruction-resume-' : resumeAfterArchivedClose ? 'report-close-resume-' : resumeAfterWaitReport ? 'wait-resume-' : resumeAfterCatalog ? 'catalog-resume-' : resumeAfterClose ? 'close-resume-' : '';
  const controlLabel = liveControlLabel(controlPrefix, label), controlTarget = path.join(controlEv, controlLabel + '.json');
  assert.ok(!fs.existsSync(controlTarget), 'No previous result may be mistaken for a new invocation');
  const filename = controlPrefix + String(++sequence).padStart(5,  '0') + '.json';
  const invocation = { label: controlLabel, args, budget };
  atomic(path.join(commands, filename), invocation);
  if (resumeAfterClose) atomic(path.join(controlCommands, filename), invocation);
  const result = await wait(label, () => fs.existsSync(controlTarget) && read(controlTarget), budget + 10000);
  if (resumeAfterClose) for (const extension of ['json', 'stdout', 'stderr']) fs.copyFileSync(path.join(controlEv, controlLabel + '.' + extension), path.join(ev, label + '.' + extension));
  return result;
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
  for (const [exe, args] of [['node', ['--version']], ['codex', ['--version']], ['claude', ['--version']], ['git', ['--version']], ['tmux', ['-V']], ['bwrap', ['--version']], ['uname', ['-a']]]) must(run('version-' + exe, exe, args));
  const A = path.join(root, 'raf-main-a'), B = path.join(root, 'raf-main-b');
  if (!resume) {
  fs.cpSync(path.join(path.dirname(source), 'conf'), path.join(root, 'conf'), { recursive: true });
  const projects = prepareLiveProjects(read(path.join(root, 'conf/projects.json')));
  atomic(path.join(root, 'conf/projects.json'), prepareLegacyLiveProjects(projects));
  const settings = read(path.join(root, 'conf/raf.json')); summary.trust = configureLiveCodexTrust(settings, root); atomic(path.join(root, 'conf/raf.json'), settings);
  must(run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main])); git(main, 'checkout', '-B', 'main', reviewed);
  fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
  fs.mkdirSync(path.join(main, 'qa'));
  for (const name of ['staged.txt', 'unstaged.txt']) fs.writeFileSync(path.join(main, 'qa', name), 'baseline\n');
  const instructions = `Це ізольований native актор сценарію 7.2. Не змінюй код, модель, effort або sandbox. Не запускай тести. Не пиши звіт і не завершуйся до кроку report. Виконуй план один раз, без підміни raf_command чи env/cwd/обгорток для команд raf.\nДля кожного n=0,1,2: виконай звичайним native exec node scripts/qa-main-symlink-native.mjs wait n REPORT_PATH; потім окремими простими native exec командами виданий у початковому брифі raf_command agent ps та raf_command agent message --to main --text 'sym72-native-stage-n'; дочекайся повного фінального коду 0, не показуй урізаний результат; для кожного exec, включно з усіма wait 0..4, session_id або Script running with cell ID означає видачу керування, а не фінальний результат і не unknown. Продовжуй той самий процес через write_stdin для session_id або wait для cell ID до exit_code. Не повторюй exec і не пиши failed через сам факт видачі керування; потім node scripts/qa-main-symlink-native.mjs ack n REPORT_PATH.\nПісля цього node scripts/qa-main-symlink-native.mjs wait 3 REPORT_PATH; node scripts/qa-main-symlink-native.mjs report 3 REPORT_PATH; node scripts/qa-main-symlink-native.mjs wait 4 REPORT_PATH. Лише після виходу останнього wait завершуй. REPORT_PATH заміни точним report_path власного брифа; n заміни числом. Якщо код ненульовий, збережи точний результат у власній теці і припини залежні кроки. Повідомлення хоста не змінюють план.\n`;
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
  const legacyService = JSON.parse(must(run('legacy-clean-start', process.execPath, [path.join(main, 'bin/raf.ts'), 'service', 'start'])));
  assert.equal(legacyService.state, 'ready');
  assert.ok(fs.lstatSync(main).isDirectory(), 'legacy bootstrap must retain the ordinary main directory');
  atomic(path.join(ev, 'legacy-clean-ready.json'), legacyService);
  atomic(path.join(root, 'conf/projects.json'), projects);
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
  for (const cwd of [B, develop, hotfix]) for (const name of ['node_modules', 'dist']) fs.cpSync(path.join(A, name), path.join(cwd, name), { recursive: true, dereference: true });
  } else if (resumeAfterVerificationHome) {
    if (resumeAfterRetainedCaptures) {
      const refusal = read(path.join(stand, 'ev-native-verification-home/summary.json'));
      assert.equal(refusal.reviewed, 'a2dfc7ea66a2430a3362ba1db72c89d25eee3b10');
      assert.equal(refusal.status, 'failed'); assert.equal(refusal.error.code, 'ENOENT');
      assert.equal(refusal.error.message, "ENOENT: no such file or directory, open '/srv/dev/s72-bDaBYe/ev-native-verification-home/runner-list.json'");
      assert.deepEqual(refusal.completed, ['actual-start', 'develop-main']);
      assert.equal(fs.readdirSync(path.join(stand, 'commands-native-verification-home')).length, 0);
    }
    const priorDirectory = path.join(stand, 'ev-native-service-record'), prior = read(path.join(priorDirectory, 'summary.json'));
    assert.equal(prior.reviewed, '19521201504b6b2ce42e4fa1ba47a2c9ffa6410c');
    assert.equal(prior.status, 'failed'); assert.deepEqual(prior.completed, ['actual-start', 'develop-main']);
    assert.equal(prior.error.code, 'ERR_ASSERTION'); assert.match(prior.error.message, /'stopped' !== 'ready'/);
    assert.equal(fs.existsSync(path.join(stand, 'publication-intent.json')), false);
    assert.equal(fs.realpathSync(main), A); assert.equal(git(A, 'rev-parse', 'HEAD'), '30d9ff89787f587319c2f216eeed28fe01e176f4');
    assert.equal(git(B, 'rev-parse', 'HEAD'), 'cc6fe687bbfab393fbd8f2b45b6ba1a2848e1be9');
    const candidate = read(path.join(priorDirectory, 'hotfix-main-prepared.json')).candidate;
    assert.deepEqual(read(path.join(stand, 'published.json')).a, candidate);
    actor = sessions().find(session => session.runId === '36182376-28f6-46b4-88ec-66d72f53a0d3');
    assert.equal(actor?.addressId, 'sym72-native-5'); assert.equal(actor.state, 'running');
    summary.actor = actor; summary.actorIdentity = prior.actorIdentity; summary.actorBriefSha256 = prior.actorBriefSha256;
    assert.deepEqual(identity(actor.process.pid), summary.actorIdentity);
    assert.equal(actor.process.runnerSessionId, '01a17697-59c8-7b50-af1f-528651b72634');
    assert.equal(hash(actor.launchContext.briefPath), summary.actorBriefSha256);
    atomic(path.join(ev, 'retained-actor-session.json'), actor);
    if (fs.existsSync(actor.launchContext.reportPath)) fs.copyFileSync(actor.launchContext.reportPath, path.join(ev, 'retained-actor-report.json'));
    fs.copyFileSync(path.join(priorDirectory, 'native-written-report.json'), path.join(ev, 'original-native-written-report.json'));
    assert.equal(actor.result?.status === 'failed', false, 'Preserve an expired actor as failed; never replace its report with the earlier success');
    const retainedReport = read(actor.launchContext.reportPath);
    if (retainedReport.status === 'failed') {
      assert.equal(resumeAfterRetainedCaptures, true);
      assert.deepEqual(actor.reportAcceptance, { runId: actor.runId, status: 'succeeded', event: 'agent.succeeded' });
      assert.equal(actor.result.status, 'succeeded'); assert.equal(actor.result.proof.runId, actor.runId);
      assert.equal(actor.result.proof.at, '2026-10-26T05:12:14.059Z');
      assert.equal(actor.result.response, read(path.join(priorDirectory, 'native-written-report.json')).answer);
      assert.match(JSON.stringify(retainedReport), /Host stage timed out/);
      summary.postAcceptanceFailure = { acceptedAt: actor.result.proof.at, acceptedRunId: actor.runId, originalAcceptedReport: 'original-native-written-report.json', failedReport: 'retained-actor-report.json', boundary: 'Later wait4 failure is preserved unchanged. Stored original success acceptance is verified independently; no failed report is overwritten or promoted.' };
    } else assert.equal(retainedReport.status, 'succeeded', 'Never overwrite a failed or missing actor report');
    const native = read(path.join(controlEv, 'native-main-identity.json'));
    mainRecord = parseLiveMainRecord(read(path.join(controlEv, 'main-ready.json')));
    assert.equal(identity(native.pid).pid, 4193219); assert.equal(identity(mainRecord.pid).pid, 4193184);
    retainLiveCommandEvidence(priorDirectory, ev, ['runner-list', 'runner-limits', 'launch']);
    for (const label of ['develop-main-prepared', 'develop-main-before', 'hotfix-main-prepared', 'hotfix-main-before']) fs.copyFileSync(path.join(priorDirectory, label + '.json'), path.join(ev, label + '.json'));
    summary.reportBoundary = prior.reportBoundary; publicationNumber = 2;
    summary.resumedFrom = { verificationHome: { summary: path.join(priorDirectory, 'summary.json'), publicationReplayed: false, registrationReplayed: false, actorReplayed: false, pendingMessageReplayed: false, reportRewritten: false } };
    pane = true; handedOver = false; complete('actual-start'); complete('develop-main');
  } else if (resumeAfterServiceOwnership) {
    if (resumeAfterServiceRecord) {
      const refusal = read(path.join(stand, 'ev-native-service-ownership/summary.json'));
      assert.equal(refusal.reviewed, '93fd8e40e5ed9df6ea36c010d7e52e48311c5471');
      assert.equal(refusal.status, 'failed'); assert.equal(refusal.error.code, 'ENOENT');
      assert.equal(refusal.error.message, "ENOENT: no such file or directory, open '/proc/undefined/stat'");
      assert.deepEqual(refusal.completed, []); assert.deepEqual(refusal.pending, summary.pending);
      assert.ok(fs.readdirSync(path.join(stand, 'commands-native-service-ownership')).length === 0);
    }
    const priorDirectory = path.join(stand, 'ev-native-generation-actor-failure');
    const prior = read(path.join(priorDirectory, 'summary.json'));
    assert.equal(prior.reviewed, '86a5ffe93dde3e0185a9132bb8efbbfa4503801c');
    assert.equal(prior.status, 'failed'); assert.equal(prior.error.code, 'ERR_ASSERTION');
    assert.deepEqual(prior.completed, ['actual-start']);
    const recovery = read(path.join(priorDirectory, 'develop-main-recovery.json'));
    assert.equal(recovery.status, 'recovered'); assert.equal(recovery.pending, true);
    assert.equal(recovery.commit, 'cc6fe687bbfab393fbd8f2b45b6ba1a2848e1be9');
    assert.equal(fs.existsSync(path.join(stand, 'publication-intent.json')), false);
    assert.equal(fs.realpathSync(main), B); assert.equal(git(B, 'rev-parse', 'HEAD'), recovery.commit);
    const generationRoot = path.join(root, '.git/modules/raf-main/raf-hotfix/generations/8c28cb3b-4297-4cae-ae3f-c06c64884625/raf-main');
    assert.equal(read(path.join(root, '.git/modules/raf-main/raf-hotfix/registry.json')).current, generationRoot);
    actor = sessions().find(session => session.runId === 'af419281-901e-4dd9-b93c-0c1cc693a007');
    assert.equal(actor?.addressId, 'sym72-native-4'); assert.equal(actor.state, 'running');
    if (resumeAfterServiceRecord && actor.result?.status === 'failed') {
      assert.deepEqual(actor.reportAcceptance, { runId: actor.runId, status: 'failed', event: 'agent.failed' });
      assert.equal(actor.result.proof.runId, actor.runId);
      assert.match(actor.result.response, /Host stage timed out/);
    } else {
      assert.equal(actor.result, undefined, 'An accepted failure cannot become a new successful actor');
      assert.deepEqual(identity(actor.process.pid), prior.actorIdentity);
    }
    assert.equal(actor.process.runnerSessionId, '01a17678-3fd7-7e73-bca3-0440ff631d30');
    assert.equal(hash(actor.launchContext.briefPath), prior.actorBriefSha256);
    assert.ok(ready(1)); assert.equal(fs.existsSync(path.join(own(), 'sym72-go-1')), false);
    const native = read(path.join(controlEv, 'native-main-identity.json'));
    mainRecord = parseLiveMainRecord(read(path.join(controlEv, 'main-ready.json')));
    assert.equal(mainRecord.pid, native.coordinatorPid); assert.equal(mainRecord.tmuxSocket, socket);
    assert.equal(identity(native.pid).pid, 4193219); assert.equal(identity(mainRecord.pid).pid, 4193184);
    assert.ok(fs.readFileSync(`/proc/${native.pid}/cmdline`, 'utf8').split('\0').includes(native.nativeId));
    for (const argument of [stand, controlEv, controlCommands]) assert.ok(fs.readFileSync(`/proc/${mainRecord.pid}/cmdline`, 'utf8').split('\0').includes(argument));
    summary.actor = actor; summary.actorIdentity = prior.actorIdentity; summary.actorBriefSha256 = prior.actorBriefSha256;
    summary.resumedFrom = { ...prior.resumedFrom, serviceOwnership: { summary: path.join(priorDirectory, 'summary.json'), recovery, publicationReplayed: false, registrationReplayed: false, actorReplayed: false } };
    for (const label of ['runner-list', 'runner-limits', 'launch', 'develop-main-prepared', 'develop-main-before']) {
      fs.copyFileSync(path.join(priorDirectory, label + '.json'), path.join(ev, (label === 'launch' && actor.result?.status === 'failed' ? 'original-actor-launch' : label) + '.json'));
      if (['runner-list', 'runner-limits', 'launch'].includes(label)) for (const extension of ['stdout', 'stderr']) fs.copyFileSync(path.join(priorDirectory, label + '.' + extension), path.join(ev, (label === 'launch' && actor.result?.status === 'failed' ? 'original-actor-launch' : label) + '.' + extension));
    }
    currentService = JSON.parse(read(path.join(priorDirectory, 'handover-start-43.json')).stdout);
    handedOver = false; pane = true; complete('actual-start');
    if (resumeAfterServiceRecord && actor.result?.status === 'failed') {
      assert.ok(!sessions().some(session => session.addressId === 'sym72-native-5'), 'No unknown replacement launch');
      const failedActor = actor;
      atomic(path.join(ev, 'original-actor-failed-session.json'), failedActor);
      const preserved = await archiveFailedLiveReport(failedActor.launchContext.reportPath, path.join(ev, 'original-actor-failed-report.json'), async () => {
        await archiveNative('original-actor-failed'); actor = undefined;
        delete summary.actor; delete summary.actorIdentity; delete summary.actorBriefSha256;
        must(await request('close-accepted-service-wait-report', ['agent', 'close', '--id', failedActor.addressId, '--force', '--reason',
          'QA 7.2: preserve accepted failed actor af419281-901e-4dd9-b93c-0c1cc693a007 whose wait expired while the coordinator-record fixture was repaired. Archive before close; replacement covers remaining hotfix and rollback switches only, without replaying publication or registration.']));
      });
      assert.equal(sessions().find(session => session.runId === failedActor.runId)?.state, 'finished');
      summary.resumedFrom.serviceRecord = { failedReport: preserved, failedRunId: failedActor.runId, originalStatus: 'failed', replacementCoversFirstSwitch: false };
      replacementAfterServiceRecord = true;
    }
  } else if (resumeAfterGenerationInventory) {
    const priorDirectory = path.join(stand, 'ev-native-control-label'), prior = read(path.join(priorDirectory, 'summary.json'));
    assert.equal(prior.reviewed, 'd4d160784cd5e72fc89cd5c392b548ec33b59c31'); assert.equal(prior.status, 'failed');
    assert.equal(prior.error.message, 'Runtime inventory completeness refused: unproved library API boundary src/hotfix-runtime-inventory.ts -> node_modules/typescript/lib/typescript.js');
    assert.deepEqual(prior.completed, ['actual-start']); assert.deepEqual(prior.pending, summary.pending.slice(1));
    assert.equal(fs.realpathSync(main), B); assert.equal(git(A, 'rev-parse', 'HEAD'), '68cc68a3576b5be854ea33183abe3af6b131dcfe');
    const prepared = read(path.join(priorDirectory, 'develop-main-prepared.json')), intent = read(path.join(stand, 'publication-intent.json'));
    assert.equal(intent.id, 'c0869d36-896b-4b77-9039-ad4dc2c2ff8d'); assert.equal(intent.destination, 'b');
    assert.deepEqual(intent.candidate, prepared.candidate); assert.deepEqual(read(path.join(stand, 'published.json')), { b: prepared.candidate });
    assert.equal(git(B, 'rev-parse', 'HEAD'), prepared.candidate.commit); assert.equal(prepared.candidate.commit, 'cc6fe687bbfab393fbd8f2b45b6ba1a2848e1be9');
    for (const cwd of [B, develop]) assert.equal(git(cwd, 'status', '--porcelain'), '');
    for (const name of ['develop-main-result.json', 'develop-main-after.json']) assert.equal(fs.existsSync(path.join(priorDirectory, name)), false);
    actor = sessions().find(session => session.runId === prior.actor.runId);
    assert.equal(actor?.addressId, 'sym72-native-3'); assert.equal(actor.runId, '5f791ffc-7602-4dfe-b982-aba9c45238f8');
    assert.equal(actor.state, 'running');
    if (resumeAfterGenerationActorFailure) {
      const refusal = read(path.join(stand, 'ev-native-generation-inventory/summary.json'));
      assert.equal(refusal.reviewed, 'b6d97f4e314a002ac4e808510869f4a268b76260'); assert.equal(refusal.status, 'failed');
      assert.equal(refusal.error.code, 'ERR_ASSERTION'); assert.match(refusal.error.stack, /qa-main-symlink-live.mjs:198:50/);
      assert.deepEqual(refusal.completed, []); assert.deepEqual(refusal.pending, summary.pending);
      assert.equal(actor.result?.status, 'failed'); assert.equal(actor.result.proof.runId, actor.runId);
      assert.equal(actor.result.proof.at, '2026-10-26T04:19:54.464Z'); assert.match(actor.result.response, /Host stage timed out; no retry or fabricated result/);
      assert.deepEqual(actor.reportAcceptance, { runId: actor.runId, status: 'failed', event: 'agent.failed' });
      assert.ok(!sessions().some(session => session.addressId === 'sym72-native-4'), 'No unknown replacement launch');
    } else { assert.equal(actor.result, undefined); assert.equal(actor.reportAcceptance, undefined); }
    for (const field of ['pid', 'startedAt', 'runnerSessionId']) assert.equal(actor.process[field], prior.actor.process[field]);
    assert.deepEqual(identity(actor.process.pid), prior.actorIdentity); assert.equal(hash(actor.launchContext.briefPath), prior.actorBriefSha256);
    assert.equal(read(path.join(own(), 'sym72-ready-1.json')).runId, actor.runId); assert.ok(fs.existsSync(path.join(own(), 'sym72-ack-0.json')));
    for (const name of ['sym72-go-1', 'sym72-ack-1.json', 'sym72-go-2']) assert.equal(fs.existsSync(path.join(own(), name)), false);
    assert.equal(fs.existsSync(actor.launchContext.reportPath), resumeAfterGenerationActorFailure);
    assert.ok(fs.readdirSync(controlCommands).every(name => name.endsWith('.json.done')), 'No unknown coordinator invocation');
    mainRecord = JSON.parse(must(read(path.join(controlEv, 'main-ready.json'))));
    const native = read(path.join(controlEv, 'native-main-identity.json'));
    assert.equal(native.confirmedThroughNativeStatus, true); assert.equal(mainRecord.pid, native.coordinatorPid);
    assert.equal(mainRecord.tmuxSocket, socket); assert.equal(native.socket, socket); assert.equal(mainRecord.tmuxPane, native.pane);
    assert.ok(fs.readFileSync(`/proc/${native.pid}/cmdline`, 'utf8').split('\0').includes(native.nativeId));
    const coordinatorCommand = fs.readFileSync(`/proc/${mainRecord.pid}/cmdline`, 'utf8').split('\0');
    for (const argument of [stand, controlEv, controlCommands]) assert.ok(coordinatorCommand.includes(argument));
    assert.equal(identity(native.pid).bootId, mainRecord.bootId); assert.equal(identity(mainRecord.pid).bootId, mainRecord.bootId);
    must(run('inspect-retained-main-fixture', 'tmux', ['-S', socket, 'has-session', '-t', 'sym72-main']));
    atomic(path.join(ev, 'retained-native-main.json'), { native, mainRecord, nativeIdentity: identity(native.pid), coordinatorIdentity: identity(mainRecord.pid), controlEv, controlCommands });
    summary.actor = actor; summary.actorIdentity = prior.actorIdentity; summary.actorBriefSha256 = prior.actorBriefSha256;
    summary.resumedFrom = { ...prior.resumedFrom, generationInventory: { summary: path.join(priorDirectory, 'summary.json'), intentId: intent.id, recoveryRequired: true, actorReplayed: false, publicationReplayed: false } };
    for (const label of ['runner-list', 'runner-limits', 'launch']) for (const extension of ['json', 'stdout', 'stderr']) fs.copyFileSync(path.join(priorDirectory, label + '.' + extension), path.join(ev, (resumeAfterGenerationActorFailure && label === 'launch' ? 'original-actor-launch' : label) + '.' + extension));
    fs.copyFileSync(path.join(priorDirectory, 'develop-main-prepared.json'), path.join(ev, 'develop-main-prepared.json'));
    fs.copyFileSync(path.join(priorDirectory, 'develop-main-before.json'), path.join(ev, 'develop-main-before.json'));
    currentService = JSON.parse(read(path.join(stand, 'ev/actual-initial-start.json')).stdout);
    handedOver = false; pane = true; complete('actual-start');
    if (resumeAfterGenerationActorFailure) {
      const failedActor = actor;
      atomic(path.join(ev, 'original-actor-failed-session.json'), failedActor);
      const preserved = await archiveFailedLiveReport(failedActor.launchContext.reportPath, path.join(ev, 'original-actor-failed-report.json'), async () => {
        await archiveNative('original-actor-failed'); actor = undefined;
        delete summary.actor; delete summary.actorIdentity; delete summary.actorBriefSha256;
        must(await request('close-accepted-generation-wait-report', ['agent', 'close', '--id', failedActor.addressId, '--force', '--reason',
          'QA 7.2: archive accepted failed run 5f791ffc-7602-4dfe-b982-aba9c45238f8 before close. Its stage1 wait expired while the inventory fixture was repaired. Preserve the first switch proof; do not replay publication. A separate actor will cover only the remaining live steps.']));
      });
      assert.equal(sessions().find(session => session.runId === failedActor.runId)?.state, 'finished');
      summary.resumedFrom.generationActorFailure = { report: preserved, runId: failedActor.runId, identityAtFirstSwitch: prior.actorIdentity,
        runnerSessionAtFirstSwitch: failedActor.process.runnerSessionId, originalStatus: 'failed', replacementCoversFirstSwitch: false };
    }
  } else {
    const previous = read(path.join(stand, 'ev/summary.json'));
    assert.equal(previous.reviewed, 'da07afe4a1bd13a2cc56389bd56d03eb7502b4d4');
    assert.deepEqual(previous.completed, ['actual-start']);
    assert.deepEqual(previous.pending, summary.pending.slice(1));
    assert.equal(fs.realpathSync(main), A);
    for (const name of ['publication-intent.json', 'published.json', 'ev-native-main/launch.json']) assert.equal(fs.existsSync(path.join(stand, name)), false, 'No previous publication or unknown continuation');
    assert.equal(git(main, 'status', '--porcelain'), '');
    summary.resumedFrom = { stand, summary: path.join(stand, 'ev/summary.json'), reviewed: previous.reviewed, conversionBefore: path.join(stand, 'ev/conversion-before.json'), conversionAfter: path.join(stand, 'ev/conversion-after.json'), productHead: git(A, 'rev-parse', 'HEAD') };
    if (resumeAfterVersion) {
      const failedDirectory = path.join(stand, 'ev-native-main'), failed = read(path.join(failedDirectory, 'summary.json'));
      assert.equal(failed.reviewed, 'ae1d7cce7a8f572eb0e01d50c5b16a0d2c1334ed');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error?.message, 'Use the configured native protocol version');
      assert.deepEqual(failed.completed, ['actual-start']);
      assert.deepEqual(failed.pending, summary.pending.slice(1));
      assert.equal(read(path.join(failedDirectory, 'native-main-error.json')).message, failed.error.message);
      for (const name of ['native-main-identity.json', 'main-ready.json', 'launch.json']) assert.equal(fs.existsSync(path.join(failedDirectory, name)), false, 'Version preflight must precede native readiness and launch');
      summary.resumedFrom.versionPreflight = { summary: path.join(failedDirectory, 'summary.json'), error: failed.error.message, completed: failed.completed, pending: failed.pending };
    }
    if (resumeAfterOnboarding) {
      assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, 'Use the confirmed default host Claude profile for this addressed continuation');
      const failedDirectory = path.join(stand, 'ev-native-main-version'), failed = read(path.join(failedDirectory, 'summary.json'));
      assert.equal(failed.reviewed, '9652907463e32d1b4026d15bf0f7a835de51229b');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error?.message, 'Native Claude has no verified empty composer: native-main-startup');
      assert.deepEqual(failed.completed, ['actual-start']);
      assert.deepEqual(failed.pending, summary.pending.slice(1));
      assert.equal(read(path.join(failedDirectory, 'native-main-version.json')).available, true);
      assert.match(fs.readFileSync(path.join(failedDirectory, 'native-main-startup.txt'), 'utf8'), /Choose the text style/);
      for (const name of ['native-main-identity.json', 'main-ready.json', 'launch.json']) assert.equal(fs.existsSync(path.join(failedDirectory, name)), false, 'Onboarding failure must precede native readiness and launch');
      summary.resumedFrom.mainOnboarding = { summary: path.join(failedDirectory, 'summary.json'), error: failed.error.message, completed: failed.completed, pending: failed.pending };
    }
    if (resumeAfterClose) {
      const failed = read(path.join(controlEv, 'summary.json')), close = read(path.join(controlEv, 'close-failed-native-attempt.json'));
      assert.equal(failed.reviewed, 'c2c294699fc9abc13ec7237731289d24299f5cb8'); assert.equal(failed.status, 'failed');
      assert.deepEqual(failed.completed, ['actual-start']); assert.deepEqual(failed.pending, summary.pending.slice(1));
      assert.equal(close.cliExitCode, 1); assert.equal(close.error, null); assert.equal(close.signal, null);
      assert.deepEqual(close.command.slice(-5), ['agent', 'close', '--id', 'sym72-native', '--force']);
      const refusal = JSON.parse(close.stderr); assert.equal(refusal.code, 'INVALID_VALUE'); assert.equal(refusal.details.stage, 'arguments');
      assert.ok(failed.error.message.startsWith(close.stderr.trim()), 'The reviewed driver stopped at this exact argument refusal');
      assert.equal(refusal.details.retrySafe, true); assert.deepEqual(refusal.details.completed, []); assert.deepEqual(refusal.details.pending, []);
      assert.ok(fs.readdirSync(controlCommands).every(name => name.endsWith('.json.done')), 'No unknown queued or running native command');
      if (!resumeAfterCatalog) for (const name of ['launch.json', 'close-resume-close-failed-native-attempt.json']) assert.equal(fs.existsSync(path.join(controlEv, name)), false);
      mainRecord = JSON.parse(must(read(path.join(controlEv, 'main-ready.json'))));
      const native = read(path.join(controlEv, 'native-main-identity.json'));
      assert.equal(native.confirmedThroughNativeStatus, true); assert.equal(mainRecord.pid, native.coordinatorPid);
      assert.equal(mainRecord.tmuxSocket, socket); assert.equal(native.socket, socket); assert.equal(mainRecord.tmuxPane, native.pane);
      const commandLine = fs.readFileSync(`/proc/${native.pid}/cmdline`, 'utf8').split('\0'); assert.ok(commandLine.includes(native.nativeId), 'Keep the exact already verified native session');
      const coordinatorCommand = fs.readFileSync(`/proc/${mainRecord.pid}/cmdline`, 'utf8').split('\0');
      for (const argument of [stand, controlEv, controlCommands]) assert.ok(coordinatorCommand.includes(argument), 'Keep the existing stand command coordinator');
      assert.equal(identity(native.pid).bootId, mainRecord.bootId); assert.equal(identity(mainRecord.pid).bootId, mainRecord.bootId);
      must(run('inspect-retained-main-fixture', 'tmux', ['-S', socket, 'has-session', '-t', 'sym72-main']));
      atomic(path.join(ev, 'retained-native-main.json'), { native, mainRecord, nativeIdentity: identity(native.pid), coordinatorIdentity: identity(mainRecord.pid), controlEv, controlCommands });
      summary.resumedFrom.failedClose = { summary: path.join(controlEv, 'summary.json'), result: path.join(controlEv, 'close-failed-native-attempt.json'), nativeId: native.nativeId, coordinatorPid: native.coordinatorPid };
      pane = true;
      if (resumeAfterCatalog) {
        const failedDirectory = path.join(stand, 'ev-native-close-reason'), failed = read(path.join(failedDirectory, 'summary.json'));
        assert.equal(failed.reviewed, 'd193d87c3ccf9cc72c5373de4af8fd68945f704c'); assert.equal(failed.status, 'failed');
        assert.equal(failed.error.message, 'Hotfix gate build failed: Error: Hotfix snapshot fingerprint changed');
        assert.deepEqual(failed.completed, ['actual-start']); assert.deepEqual(failed.pending, summary.pending.slice(1));
        const previousActor = failed.actor;
        assert.equal(previousActor.addressId, 'sym72-native-2'); assert.equal(previousActor.runId, 'f1d4c6ce-6be9-4662-abe6-b38ed61f174d');
        actor = sessions().find(session => session.runId === previousActor.runId);
        assert.ok(actor);
        const closedActor = resumeAfterArchivedClose ? actor : undefined;
        if (resumeAfterArchivedClose) {
          assert.equal(closedActor.state, 'finished'); assert.equal(closedActor.result?.status, 'failed');
          actor = read(path.join(stand, 'ev-native-wait-report/original-actor-failed/session.json'));
          assert.equal(actor.state, 'running'); assert.equal(actor.addressId, closedActor.addressId); assert.equal(actor.runId, closedActor.runId);
          assert.deepEqual(actor.process, closedActor.process);
        }
        for (const field of ['pid', 'startedAt', 'runnerSessionId']) assert.equal(actor.process[field], previousActor.process[field]);
        assert.equal(read(path.join(failedDirectory, 'launch.json')).cliExitCode, 0);
        assert.deepEqual(database(db => db.prepare('SELECT marker FROM qa_sym72_data ORDER BY marker').all()).map(row => row.marker), ['A-before']);
        assert.equal(git(develop, 'rev-parse', 'HEAD'), resumeAfterInstructionCommit ? 'cc6fe687bbfab393fbd8f2b45b6ba1a2848e1be9' : '9618f4a0695ba8c581ee8f1d4c3ff2e2d2f89319');
        assert.equal(git(A, 'rev-parse', 'HEAD'), '68cc68a3576b5be854ea33183abe3af6b131dcfe');
        summary.resumedFrom.catalogBuild = { summary: path.join(failedDirectory, 'summary.json'), runId: actor.runId, identity: failed.actorIdentity,
          alreadyCompleted: ['native registration', 'native initial barrier', 'native stage-0 ps/message/ACK', 'A-before SQLite insertion'], publicationStarted: false };
        if (!resumeAfterArchivedClose) {
          assert.equal(actor.state, 'running');
          if (!resumeAfterWaitReport) assert.equal(actor.result, undefined);
          assert.deepEqual(identity(actor.process.pid), failed.actorIdentity); assert.equal(hash(actor.launchContext.briefPath), failed.actorBriefSha256);
          assert.ok(ready(0)); assert.ok(fs.existsSync(path.join(own(), 'sym72-ack-0.json')));
          const waiting = read(path.join(own(), 'sym72-ready-1.json'));
          assert.equal(waiting.stage, 1); assert.equal(waiting.runId, actor.runId);
          atomic(path.join(ev, 'retained-native-wait.json'), { waiting, pidNamespace: 'The native helper PID belongs to the sandbox namespace; it is not a verified host PID.' });
          for (const name of ['sym72-go-1', 'sym72-ack-1.json', 'sym72-go-2']) assert.equal(fs.existsSync(path.join(own(), name)), false);
          if (!resumeAfterWaitReport) assert.equal(fs.existsSync(actor.launchContext.reportPath), false);
          summary.actor = actor; summary.actorIdentity = failed.actorIdentity; summary.actorBriefSha256 = failed.actorBriefSha256;
        }
        if (resumeAfterWaitReport) {
          const expectedReportSha256 = '7e455c2a4fe355ba6dac017b3e880ccf4fb7853d8c04f4153c2395bf3f1bbda3';
          assert.equal(actor.result?.status, 'failed');
          assert.deepEqual(actor.reportAcceptance, { runId: actor.runId, status: 'failed', event: 'agent.failed' });
          assert.match(actor.result.response, /30 секунд без exit_code/);
          const failedActor = actor;
          let preserved;
          if (resumeAfterArchivedClose) {
            const priorDirectory = path.join(stand, 'ev-native-wait-report');
            const prior = read(path.join(priorDirectory, 'summary.json'));
            assert.equal(prior.reviewed, '830994e0ad8db01dcc84715a95ec823db6e6d44a'); assert.equal(prior.status, 'failed');
            assert.equal(prior.error.code, 'ENOENT');
            assert.equal(prior.error.message, "ENOENT: no such file or directory, open '" + failedActor.launchContext.reportPath + "'");
            assert.deepEqual(prior.completed, []); assert.deepEqual(prior.pending, summary.pending);
            const closed = read(path.join(priorDirectory, 'close-accepted-wait-report.json'));
            must(closed);
            assert.deepEqual(closed.command.slice(2, -1), ['agent', 'close', '--id', failedActor.addressId, '--force', '--reason']);
            assert.match(closed.command.at(-1), /preserve accepted failed run f1d4c6ce/);
            const closeResult = JSON.parse(closed.stdout); assert.equal(closeResult.closed, true); assert.equal(closeResult.result, 'failed'); assert.deepEqual(closeResult.unfinished, []);
            assert.equal(closedActor.state, 'finished');
            assert.equal(closedActor.result.response, ''); assert.equal(closedActor.result.proof, null);
            assert.deepEqual(closedActor.result.forcedClose, closeResult.forcedClose);
            const archivedSession = read(path.join(priorDirectory, 'original-actor-failed-session.json'));
            assert.equal(archivedSession.state, 'running');
            for (const field of ['addressId', 'runId', 'result', 'reportAcceptance']) assert.deepEqual(archivedSession[field], failedActor[field]);
            const archivedReport = path.join(priorDirectory, 'original-actor-failed-report.json');
            assert.equal(hash(archivedReport), expectedReportSha256); assert.equal(read(archivedReport).status, 'failed');
            assert.equal(fs.existsSync(path.dirname(failedActor.launchContext.reportPath)), false, 'The successful close removed its run tmp; never recreate it');
            assert.ok(!sessions().some(session => session.addressId === 'sym72-native-3'), 'No unknown next actor launch');
            fs.copyFileSync(archivedReport, path.join(ev, 'original-actor-failed-report.json'));
            fs.copyFileSync(path.join(priorDirectory, 'original-actor-failed-session.json'), path.join(ev, 'original-actor-failed-session.json'));
            preserved = { archivePath: path.join(ev, 'original-actor-failed-report.json'), sha256: hash(archivedReport) };
            summary.resumedFrom.reportClose = { summary: path.join(priorDirectory, 'summary.json'), close: path.join(priorDirectory, 'close-accepted-wait-report.json'), state: closedActor.state, closeReplayed: false };
            actor = undefined;
          } else {
            assert.equal(hash(failedActor.launchContext.reportPath), expectedReportSha256); assert.equal(read(failedActor.launchContext.reportPath).status, 'failed');
            atomic(path.join(ev, 'original-actor-failed-session.json'), { addressId: failedActor.addressId, runId: failedActor.runId, state: failedActor.state, result: failedActor.result, reportAcceptance: failedActor.reportAcceptance });
            preserved = await archiveFailedLiveReport(failedActor.launchContext.reportPath, path.join(ev, 'original-actor-failed-report.json'), async () => {
              await archiveNative('original-actor-failed');
              actor = undefined;
              delete summary.actor; delete summary.actorIdentity; delete summary.actorBriefSha256;
              must(await request('close-accepted-wait-report', ['agent', 'close', '--id', failedActor.addressId, '--force', '--reason',
                'QA 7.2: preserve accepted failed run f1d4c6ce-6be9-4662-abe6-b38ed61f174d; fixture instructions did not explain polling a yielded native exec. No release was published. Close only this failed attempt before the corrected pending chain.']));
            });
            assert.equal(sessions().find(session => session.runId === failedActor.runId)?.state, 'finished');
          }
          assert.equal(preserved.sha256, expectedReportSha256);
          assert.equal(hash(preserved.archivePath), expectedReportSha256);
          delete summary.actor; delete summary.actorIdentity; delete summary.actorBriefSha256;
          const instructionPath = path.join(develop, 'qa/sym72-instructions.txt');
          assert.equal(git(develop, 'status', '--porcelain'), '');
          const original = fs.readFileSync(instructionPath, 'utf8');
          if (resumeAfterInstructionCommit) {
            const priorDirectory = path.join(stand, 'ev-native-report-close'), prior = read(path.join(priorDirectory, 'summary.json'));
            assert.equal(prior.reviewed, '90631f2d97ff880dca04029a791c66a676f77b0f'); assert.equal(prior.status, 'failed');
            assert.equal(prior.error.message, "Cannot read properties of undefined (reading 'reportPath')");
            assert.deepEqual(prior.completed, ['actual-start']); assert.deepEqual(prior.pending, summary.pending.slice(1));
            assert.equal(prior.resumedFrom.nativeWaitReport.instructionCommit, git(develop, 'rev-parse', 'HEAD'));
            assert.equal(prior.resumedFrom.nativeWaitReport.originalReportSha256, expectedReportSha256);
            assert.equal(prior.resumedFrom.reportClose.closeReplayed, false);
            assert.equal(hash(path.join(priorDirectory, 'original-actor-failed-report.json')), expectedReportSha256);
            assert.ok(original.includes('Продовжуй той самий процес через write_stdin для session_id або wait для cell ID до exit_code.'));
            assert.ok(!fs.existsSync(path.join(priorDirectory, 'launch.json')));
            summary.resumedFrom.instructionCommit = { summary: path.join(priorDirectory, 'summary.json'), commit: git(develop, 'rev-parse', 'HEAD'), patchReplayed: false };
          } else {
          const anchor = 'дочекайся повного фінального коду 0, не показуй урізаний результат; потім';
          assert.equal(original.split(anchor).length, 2, 'Patch only the exact known fixture instruction');
          const guidance = 'дочекайся повного фінального коду 0, не показуй урізаний результат; для кожного exec, включно з усіма wait 0..4, session_id або Script running with cell ID означає видачу керування, а не фінальний результат і не unknown. Продовжуй той самий процес через write_stdin для session_id або wait для cell ID до exit_code. Не повторюй exec і не пиши failed через сам факт видачі керування; потім';
          fs.writeFileSync(instructionPath, original.replace(anchor, guidance));
          git(develop, 'add', '--', 'qa/sym72-instructions.txt');
          git(develop, 'commit', '-m', 'qa: explain polling yielded native waits');
          }
          summary.resumedFrom.nativeWaitReport = { runId: failedActor.runId, report: failedActor.launchContext.reportPath, acceptedStatus: 'failed', archivedReport: preserved.archivePath, originalReportSha256: preserved.sha256, instructionCommit: git(develop, 'rev-parse', 'HEAD'), nativeGreenPending: true };
        }

      }
    }
    currentService = JSON.parse(read(path.join(stand, 'ev/actual-initial-start.json')).stdout);
    complete('actual-start');
    if (!resumeAfterClose) {
    const oldPane = run('inspect-previous-main-fixture', 'tmux', ['-S', socket, 'has-session', '-t', 'sym72-main']);
    assert.equal(oldPane.error, null); assert.equal(oldPane.signal, null);
    if (oldPane.cliExitCode === 0) must(run('replace-invalid-main-fixture', 'tmux', ['-S', socket, 'kill-session', '-t', 'sym72-main']));
    else { assert.equal(oldPane.cliExitCode, 1); assert.match(oldPane.stderr, /can't find session|no server running|no such file or directory/i); }
    }
  }
  env.SYM64_AUDIT = path.join(develop, 'node_modules/.sym72/audit'); fs.mkdirSync(env.SYM64_AUDIT, { recursive: true });
  if (!resumeAfterClose) {
  must(run('main-pane', 'tmux', ['-S', socket, 'new-session', '-d', '-s', 'sym72-main', '-x', '180', '-y', '50',
    ...['CODEX_HOME', 'SYM72_CLAUDE_HOME', 'SYM64_AUDIT'].flatMap(key => ['-e', key + '=' + env[key]]),
    ...(env.CLAUDE_CONFIG_DIR !== undefined ? ['-e', 'CLAUDE_CONFIG_DIR=' + env.CLAUDE_CONFIG_DIR] : []),
    ...(env.CLAUDE_CONFIG_DIR === undefined ? ['env', '-u', 'CLAUDE_CONFIG_DIR'] : []),
    process.execPath, path.join(source, 'scripts/qa-main-symlink-pane.mjs'), stand, ev, commands])); pane = true;
  mainRecord = JSON.parse(must(await wait('main attach', () => {
    if (fs.existsSync(path.join(ev, 'native-main-error.json'))) throw Error(read(path.join(ev, 'native-main-error.json')).message);
    return fs.existsSync(path.join(ev, 'main-ready.json')) && read(path.join(ev, 'main-ready.json'));
  }, 180000)));
  assert.equal(mainRecord.tmuxSocket, socket);
  }
  if (resume && !resumeAfterGenerationInventory) {
    const old = sessions().find(s => s.addressId === 'sym72-native');
    assert.equal(old?.runId, '566b52f3-80eb-4193-8140-e38e2bcb64e1');
    assert.equal(old.result?.status, 'failed', 'Only the accepted failed initial attempt may be cleaned up');
    if (old.state !== 'finished') must(await request('close-failed-native-attempt', prepareFailedNativeClose(old)));
    summary.closedFailedNativeAttempt = describeFailedLiveAttempt(old);
  }
  if (resumeAfterGenerationInventory) {
    for (const label of ['runner-list', 'runner-limits', ...(resumeAfterGenerationActorFailure || replacementAfterServiceRecord ? [] : ['launch'])]) must(read(path.join(ev, label + '.json')));
  } else if (resumeAfterControlLabel) {
    const priorDirectory = path.join(stand, 'ev-native-instruction-commit'), prior = read(path.join(priorDirectory, 'summary.json'));
    assert.equal(prior.reviewed, '0f385f81db004148fe57dc2da61a01b4c9ebaea7'); assert.equal(prior.status, 'failed');
    assert.equal(prior.error.message, 'No previous result may be mistaken for a new invocation'); assert.equal(prior.error.code, 'ERR_ASSERTION');
    assert.deepEqual(prior.completed, ['actual-start']); assert.deepEqual(prior.pending, summary.pending);
    assert.deepEqual(prior.closedFailedNativeAttempt, summary.closedFailedNativeAttempt);
    assert.equal(prior.resumedFrom.instructionCommit.patchReplayed, false);
    const commandDirectory = path.join(stand, 'commands-native-instruction-commit');
    assert.deepEqual(fs.readdirSync(commandDirectory), ['instruction-resume-00011.json']);
    const invocation = read(path.join(commandDirectory, 'instruction-resume-00011.json'));
    assert.equal(invocation.label, 'instruction-resume-'); assert.deepEqual(invocation.args, ['runner', 'list']);
    const previous = read(path.join(priorDirectory, 'runner-list.json')); must(previous);
    assert.deepEqual(previous.command.slice(-2), ['runner', 'list']);
    assert.deepEqual(read(path.join(controlEv, 'instruction-resume-.json')), previous);
    for (const name of ['runner-limits.json', 'launch.json']) assert.equal(fs.existsSync(path.join(priorDirectory, name)), false);
    for (const extension of ['json', 'stdout', 'stderr']) fs.copyFileSync(path.join(priorDirectory, 'runner-list.' + extension), path.join(ev, 'runner-list.' + extension));
    summary.resumedFrom.controlLabel = { summary: path.join(priorDirectory, 'summary.json'), runnerList: path.join(priorDirectory, 'runner-list.json'), runnerListReplayed: false };
  } else must(await request('runner-list', ['runner', 'list']));
  if (!resumeAfterGenerationInventory) must(await request('runner-limits', ['runner', 'limits', '--runners', 'codex']));
  hh = await import(pathToFileURL(path.join(A, 'src/hotfix-host.ts'))); activation = await import(pathToFileURL(path.join(A, 'src/hotfix-activation.ts')));
  const host = { orchestratorRoot: root, qaHome: stand, environment: env, sandboxExecutable: 'codex' };
  const { openStateStore } = await import(pathToFileURL(path.join(A, 'src/state-store.ts')));
  const { productionStateContext } = await import(pathToFileURL(path.join(A, 'src/state-migration-guard.ts')));
  const mainSession = sessions().find(session => session.addressId === 'main' && session.state === 'running' && session.process.pid === mainRecord.pid);
  assert.ok(mainSession, 'Require the actual registered native main, never a fixture identity');
  const verificationHost = prepareLiveVerificationHost(host, path.join(stand, 'verification-home-' + randomUUID()), mainSession, isolated =>
    openStateStore(path.join(isolated.qaHome, '.raf/state.sqlite'), { context: productionStateContext(root, path.join(A, 'src/state-store.ts'), isolated.qaHome, 'cli', isolated.environment) }));
  atomic(path.join(ev, 'verification-home.json'), { liveHome: stand, verificationHome: verificationHost.qaHome, copiedMainRunId: mainSession.runId, copiedActors: [], copiedReports: [], copiedPending: [], boundary: 'Only actual main registration is bootstrapped for the mandatory candidate smoke; native actors and production report acceptance remain in live HOME.' });
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
  if (!resume) await register(A);
  if (replacementAfterServiceRecord || resumeAfterGenerationActorFailure || !resumeAfterGenerationInventory && (!resumeAfterCatalog || resumeAfterWaitReport)) {
  const actorId = replacementAfterServiceRecord ? 'sym72-native-5' : resumeAfterGenerationActorFailure ? 'sym72-native-4' : resumeAfterWaitReport ? 'sym72-native-3' : resume ? 'sym72-native-2' : 'sym72-native';
  must(await request('launch', ['agent', 'run', '--id', actorId, '--type', 'implement', '--project', 'raf', '--features', 'sym72-fixture', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'sym72-fixture:1.1']));
  actor = await wait('native registration', () => sessions().find(s => s.addressId === actorId && s.state === 'running'));
  assert.equal(actor.launchContext.selection.runner, 'codex', 'Existing configuration must select native codex');
  await wait('native initial barrier', () => ready(0));
  summary.actor = actor; summary.actorIdentity = identity(actor.process.pid); summary.actorBriefSha256 = hash(actor.launchContext.briefPath);
  gate(0); await wait('native original-prefix commands before switch', () => fs.existsSync(path.join(own(), 'sym72-ack-0.json')));
  if (!resumeAfterWaitReport) database(db => { db.exec('CREATE TABLE qa_sym72_data (marker TEXT PRIMARY KEY)'); db.prepare('INSERT INTO qa_sym72_data VALUES (?)').run('A-before'); });
  }
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
      copyLiveReleaseArtifacts(releaseSource.workspace.cwd, cwd);
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
  let finishHandover;
  const releasePorts = { host: verificationHost, storage, shared: { verify: activation.verifyHotfixCandidate, activate: activation.activateHotfix, recover: activation.recoverHotfixActivation }, compatibility: compatible,
    confirmHandover: finishHandover = async slot => {
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
      const registry = read(path.join(common, 'raf-hotfix/registry.json')), expected = registry.current;
      let standby;
      const status = await handoverLiveService(expected, {
        current: async () => JSON.parse(must(await request('handover-current-' + (++sequence), ['service', 'status']))),
        prepare: async generation => {
          standby = prepareStandService({ generation, root, home: stand, environment: env, evidencePath: path.join(ev, 'service-standby-' + (++sequence)) });
          const proof = await standby.prepare();
          assert.deepEqual(identity(actor.process.pid), summary.actorIdentity);
          atomic(path.join(ev, 'service-prepared-' + (++sequence) + '.json'), { ...proof, identity: identity(proof.pid), at: new Date().toISOString(), oldServiceStillAlive: identity(currentService.pid) });
          return proof;
        },
        stop: async () => JSON.parse(must(await request('handover-retire-' + (++sequence), ['service', 'stop']))),
        activate: async () => {
          await standby.activate();
          return JSON.parse(must(await request('handover-ready-' + (++sequence), ['service', 'status'])));
        },
      });
      const proof = { slot, before: currentService, after: status, expected, nativeIdentity: identity(actor.process.pid), nativeUnchanged: JSON.stringify(identity(actor.process.pid)) === JSON.stringify(summary.actorIdentity),
        ready: status.state === 'ready' && status.mainPath === expected && status.resourceWaitReady === true };
      atomic(path.join(ev, 'handover-' + (++sequence) + '.json'), proof);
      if (publicationNumber === 2) summary.reportBoundary.confirmedAt = new Date().toISOString();
      handedOver = proof.ready && proof.nativeUnchanged; currentService = status; return handedOver;
    } };
  const release = createMainSymlinkRelease(releasePorts);
  const historicalRollback = resumeAfterVerificationHome ? createMainSymlinkRelease({ ...releasePorts, host }) : release;
  const requestRelease = async (kind, marker) => {
    const cwd = kind === 'develop' ? develop : hotfix, baseCommit = git(main, 'rev-parse', 'HEAD');
    if (!(resumeAfterCatalog && marker === 'develop-main')) {
    git(cwd, 'fetch', '--no-tags', main, baseCommit); git(cwd, 'merge', '--no-edit', baseCommit);
    fs.writeFileSync(path.join(cwd, 'qa/release-marker.txt'), marker + '\n'); git(cwd, 'add', '--', 'qa/release-marker.txt'); git(cwd, 'commit', '-m', marker);
    } else {
      assert.equal(fs.readFileSync(path.join(cwd, 'qa/release-marker.txt'), 'utf8'), marker + '\n');
      assert.equal(git(cwd, 'status', '--porcelain'), '');
    }
    const runId = randomUUID();
    const workspace = { runId, orchestratorRoot: root, project: 'raf', targetBranch: 'main', cwd, baseCommit, repositoryIdentity: common,
      gitDirectory: fs.realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir')), commonDirectory: common, ownershipPath: path.join(root, '.raf-hotfix/runs', runId, 'ownership.json') };
    const before = await snapshot(marker + '-before');
    const prepared = await prepareLiveReleaseCandidate(() => { must(run(marker + '-source-build', 'npm', ['run', 'build'], cwd)); }, () => release.prepare({ source: { kind, workspace }, regression: { executable: process.execPath, args: ['--input-type=module', '-e', "import fs from 'node:fs';if(!fs.readFileSync('qa/release-marker.txt','utf8').trim())throw Error('Missing release marker');await import('./src/production-entry.ts');"] }, mainAddress: 'main', message: 'sym72-gate-' + marker }));
    atomic(path.join(ev, marker + '-prepared.json'), prepared);
    fs.cpSync(path.dirname(prepared.candidate.evidencePath), path.join(ev, marker + '-gates'), { recursive: true, filter: p => path.basename(p) !== 'stand' });
    const result = await release.publish(prepared); atomic(path.join(ev, marker + '-result.json'), result);
    const after = await snapshot(marker + '-after'); assert.notEqual(before.active, after.active); await controls(marker);
    summary.scenarios.push({ name: marker, status: 'succeeded', before: marker + '-before.json', after: marker + '-after.json' }); return prepared;
  };
  let first;
  if (resumeAfterVerificationHome) {
    first = read(path.join(ev, 'develop-main-prepared.json'));
  } else if (resumeAfterGenerationInventory) {
    first = read(path.join(ev, 'develop-main-prepared.json'));
    const before = read(path.join(ev, 'develop-main-before.json'));
    if (resumeAfterServiceOwnership) {
      assert.equal(await finishHandover('b'), true);
    } else {
      const recovered = await release.recover(); atomic(path.join(ev, 'develop-main-recovery.json'), recovered);
      assert.equal(recovered.status, 'recovered'); assert.equal(recovered.pending, false); assert.equal(recovered.commit, first.candidate.commit);
    }
    assert.equal(fs.existsSync(intentPath), false); assert.equal(active(), 'b');
    const after = await snapshot('develop-main-after'); assert.notEqual(before.active, after.active); await controls('develop-main');
    summary.scenarios.push({ name: 'develop-main', status: 'succeeded', before: path.join(stand, 'ev-native-control-label/develop-main-before.json'), after: 'develop-main-after.json', recovery: 'develop-main-recovery.json', publicationReplayed: false });
  } else first = await requestRelease('develop', 'develop-main');
  if (!resumeAfterVerificationHome) complete('develop-main');
  if (!resumeAfterVerificationHome) { gate(1); await wait('native original-prefix commands after first switch', () => fs.existsSync(path.join(own(), 'sym72-ack-1.json')));
  }
  let second;
  if (resumeAfterVerificationHome) {
    second = read(path.join(ev, 'hotfix-main-prepared.json'));
    const stopped = JSON.parse(must(await request('fixture-stopped-service', ['service', 'status'])));
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.pid, null); assert.equal(stopped.stopReason, 'Service stopped normally');
    const expected = read(path.join(common, 'raf-hotfix/registry.json')).current;
    assert.equal(expected, path.join(common, 'raf-hotfix/generations/2671ca81-f680-49ca-a5cc-c0546daf5c09/raf-main'));
    const standby = prepareStandService({ generation: expected, root, home: stand, environment: env, evidencePath: path.join(ev, 'fixture-recovery-standby') });
    const restored = await standby.prepare(); assert.equal(restored.restored, true); assert.equal(restored.mainPath, expected);
    atomic(path.join(ev, 'fixture-recovery-prepared.json'), restored);
    await standby.activate();
    currentService = JSON.parse(must(await request('fixture-restored-service', ['service', 'status'])));
    assert.equal(currentService.state, 'ready'); assert.equal(currentService.mainPath, expected); assert.equal(currentService.pid, restored.pid); assert.equal(currentService.resourceWaitReady, true);
    handedOver = true;
    atomic(path.join(ev, 'fixture-recovery-service.json'), { stopped, restored: currentService, actorIdentity: identity(actor.process.pid), boundary: 'Recovery of the owner stopped by the invalid live-HOME fixture. This is not evidence that the failed second handover prepared a new owner before retiring the previous one.' });
    await controls('hotfix-main-recovered'); await snapshot('hotfix-main-after');
    const verificationRunId = randomUUID(), verificationBase = git(A, 'rev-parse', 'HEAD');
    const refreshedSource = { ...second.source.workspace, runId: verificationRunId, baseCommit: verificationBase, ownershipPath: path.join(root, '.raf-hotfix/runs', verificationRunId, 'ownership.json') };
    const refreshedWorkspace = { ...second.candidate.workspace, runId: verificationRunId, baseCommit: verificationBase, ownershipPath: refreshedSource.ownershipPath };
    const liveBeforeSmoke = { service: currentService, actor: identity(actor.process.pid) };
    const isolatedProof = await activation.verifyHotfixCandidate(verificationHost, { workspace: refreshedWorkspace, source: 'hotfix', sourceWorkspace: refreshedSource,
      regression: { executable: process.execPath, args: ['--input-type=module', '-e', "import fs from 'node:fs';if(!fs.readFileSync('qa/release-marker.txt','utf8').trim())throw Error('Missing release marker');await import('./src/production-entry.ts');"] },
      mainAddress: 'main', message: 'sym72-isolated-home-regression' });
    atomic(path.join(ev, 'isolated-home-exact-candidate.json'), isolatedProof);
    assert.equal(isolatedProof.commit, second.candidate.commit); assert.equal(isolatedProof.fingerprint, second.candidate.fingerprint);
    fs.cpSync(path.dirname(isolatedProof.evidencePath), path.join(ev, 'isolated-home-gates'), { recursive: true, filter: p => path.basename(p) !== 'stand' });
    const liveAfterSmoke = { service: JSON.parse(must(await request('live-after-isolated-smoke', ['service', 'status']))), actor: identity(actor.process.pid) };
    assert.equal(liveAfterSmoke.service.state, 'ready'); assert.equal(liveAfterSmoke.service.pid, liveBeforeSmoke.service.pid);
    assert.equal(liveAfterSmoke.service.serviceEpoch, liveBeforeSmoke.service.serviceEpoch); assert.deepEqual(liveAfterSmoke.actor, liveBeforeSmoke.actor);
    atomic(path.join(ev, 'isolated-home-live-unchanged.json'), { before: liveBeforeSmoke, after: liveAfterSmoke, publicationReplayed: false, actorReplayed: false, historicalGatesRewritten: false });
  } else second = await requestRelease('hotfix', 'hotfix-main');
  const hotfixCommit = git(main, 'rev-parse', 'HEAD'); git(develop, 'fetch', '--no-tags', main, hotfixCommit); git(develop, 'merge', '--no-edit', hotfixCommit);
  git(develop, 'merge-base', '--is-ancestor', hotfixCommit, 'HEAD'); complete('hotfix-main-develop');
  assert.ok(summary.reportBoundary?.writtenAt); complete('native-channel');
  database(db => db.prepare('INSERT INTO qa_sym72_data VALUES (?)').run('new-release-write'));
  const rollbackBefore = await snapshot('rollback-before'); const rollbackResult = await historicalRollback.rollback(second); atomic(path.join(ev, 'rollback-result.json'), rollbackResult);
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
  assert.deepEqual(summary.pending, []);
  nativeCompletion = { released: true, pending: [...summary.pending], actorRunId: actor.runId, acceptedRunId: accepted.reportAcceptance.runId, acceptedStatus: accepted.result.status };
  await archiveNative('native-completed'); atomic(path.join(ev, 'native-completion-release.json'), nativeCompletion); gate(4);
  summary.status = 'succeeded';
} catch (error) {
  summary.error = { message: error.message, stack: error.stack, code: error.code ?? null };
  summary.scenarios.push({ name: summary.pending[0] ?? 'final-verification', status: 'failed', reason: error.message });
  process.stderr.write(error.stack + '\n'); process.exitCode = 1;
} finally {
  try { await archiveNative('native-final'); } catch (error) { summary.archiveError = String(error); summary.status = 'failed'; process.exitCode = 1; }
  if (env.SYM64_AUDIT) try { summary.cliAudit = archiveStandAudit(env.SYM64_AUDIT, ev); } catch (error) { summary.auditError = String(error); summary.status = 'failed'; process.exitCode = 1; }
  if (summary.status === 'succeeded' && pane) {
    if (actor) try { const latest = sessions().find(s => s.runId === actor.runId); if (latest?.state !== 'finished') must(await request('cleanup-actor', ['agent', 'close', '--id', actor.addressId, '--force', '--reason', 'QA 7.2 completed: close this stand actor after preserving its accepted result and native identity evidence.'], 120000)); } catch (error) { summary.cleanup.actorError = String(error); }
    try {
      const { createBackgroundRuntime } = await import(pathToFileURL(path.join(currentService.mainPath, 'src/background-runtime.ts')).href);
      const runtime = createBackgroundRuntime({ stateDirectory: path.join(stand, '.raf'), socketPath: path.join(stand, '.raf/service.sock'), entryRelativePath: 'bin/service.ts', readinessTimeoutMs: 30000 }, {
        resolveMainPath: async () => { throw Error('Cleanup must never resolve or start another owner'); },
        validateMainSnapshot: async () => false, spawn: () => { throw Error('Cleanup must never spawn'); },
      });
      summary.cleanup.service = await stopLiveServiceOwner(currentService, runtime);
      atomic(path.join(ev, 'cleanup-service-normal.json'), summary.cleanup.service);
    } catch (error) { summary.cleanup.serviceError = String(error); }
    run('cleanup-main', 'tmux', ['-S', socket, 'kill-server']);
  }
  if (summary.status === 'succeeded') {
    const services = await stopStandServices(root); summary.cleanup.services = services;
    if (actor?.process?.evidence?.tmuxSocket) run('cleanup-runner-tmux', 'tmux', ['-S', actor.process.evidence.tmuxSocket, 'kill-server']);
    summary.cleanup.complete = services.complete && !summary.cleanup.actorError && !summary.cleanup.serviceError;
    if (!summary.cleanup.complete) { summary.status = 'failed'; process.exitCode = 1; }
  } else {
    summary.cleanup = { complete: false, retained: true, stand, reason: 'Preserve the exact failed boundary and live identities for addressed continuation; do not replay completed scenarios or manually restart services.' };
  }
  summary.finishedAt = new Date().toISOString(); atomic(path.join(ev, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, evidence: ev, completed: summary.completed, pending: summary.pending, cleanup: summary.cleanup }));
}
