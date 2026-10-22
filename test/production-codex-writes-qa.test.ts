import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { listTaskReservations } from '../src/task-reservations.ts';
import { configuration, eventually, fixture } from './production-fixture.ts';

const runtimeUrl = pathToFileURL(fileURLToPath(new URL('../src/production-runtime.ts', import.meta.url))).href;
const appRuntimeUrl = new URL('../src/app-runtime.ts', import.meta.url).href;
const storeUrl = new URL('../src/state-store.ts', import.meta.url).href;

async function linkedWorktree(root: string, cwd: string) {
  const init = spawnSync('git', ['init', '--quiet', '--initial-branch=main', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const common = join(root, '.git', 'modules', 'raf');
  const linked = join(common, 'worktrees', 'raf-develop');
  await mkdir(dirname(common), { recursive: true });
  await rename(join(cwd, '.git'), common);
  await mkdir(linked, { recursive: true });
  await writeFile(join(linked, 'HEAD'), 'ref: refs/heads/develop\n');
  await writeFile(join(linked, 'commondir'), '../..\n');
  await writeFile(join(linked, 'gitdir'), `${join(cwd, '.git')}\n`);
  await writeFile(join(cwd, '.git'), `gitdir: ${linked}\n`);
  const probe = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const directories = [await realpath(linked), await realpath(common), await realpath(join(root, '.git'))];
  assert.deepEqual(await Promise.all(probe.stdout.trim().split('\n').map(path => realpath(path))), [await realpath(cwd), directories[0], directories[1]]);
  return directories;
}

async function scopedFixture(t: TestContext, metadata: boolean, worktree = false) {
  const f = await fixture(t);
  const gitDirectories = worktree ? await linkedWorktree(f.root, f.cwd) : [];
  const catalog = JSON.parse(await readFile(new URL('../dist/catalog.json', import.meta.url), 'utf8'));
  const configured = { ...configuration, catalog };
  const runId = 'writes-run-1';
  const reportPath = join(f.tmpRoot, runId, `${f.params.id}.json`);
  const metadataDirectory = f.changeRoot;
  const params = metadata ? f.params : { ...f.params, type: 'spec', phase: 'spec' };
  const documentPath = join(metadataDirectory, 'new-document.md');
  const targets = metadata ? [documentPath, f.questionsPath, join(f.cwd, 'local.txt'), ...gitDirectories.map(directory => join(directory, 'raf-write-probe'))] : [];
  const boundaries = metadata ? [f.cwd, metadataDirectory, f.questionsPath] : [metadataDirectory, f.questionsPath];
  await mkdir(dirname(f.legacyTaskContextPath), { recursive: true, mode: 0o700 });
  await writeFile(f.legacyTaskContextPath, JSON.stringify({ version: 1, parameters: params, assignment: f.assignment, context: { branch: 'develop', outcome: 'FOREIGN', writeBoundaries: [join(f.root, 'foreign-directory'), f.root], sources: [], requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [], reportSchema: { type: 'object' } } }), { mode: 0o600 });
  const pidPath = join(f.root, 'runner.pid');
  const argvPath = join(f.root, 'runner-argv.json');
  const releasePath = join(f.root, 'write-and-report');
  const exitGate = join(f.root, 'runner-exit');
  const writeEvidence = join(f.root, 'write-evidence.json');
  const nativeId = '11111111-1111-4111-8111-111111111111';
  f.trackPidFile(pidPath);
  const executable = join(f.binRoot, 'codex');
  await writeFile(executable, String.raw`#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args));
const nativeId = ${JSON.stringify(nativeId)};
const targets = ${JSON.stringify(targets)};
const metadata = ${JSON.stringify(metadata)};
const render = text => process.stdout.write('\x1b[2J\x1b[H' + text);
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
render('Ask Codex to do anything\r\n› Ask Codex to do anything');
let input = '', assignment, reported = false;
process.stdin.on('data', data => {
  input += data.replace(/\r/g, '\n');
  if (input.includes('/status')) {
    input = '';
    render('Session: ' + nativeId + '\r\nAsk Codex to do anything\r\n› Ask Codex to do anything');
    return;
  }
  if (assignment) return;
  const offset = input.search(/\{\s*"project"\s*:/);
  if (offset < 0) return;
  let candidate;
  try { candidate = JSON.parse(input.slice(offset).trim()); } catch { return; }
  if (!/[\r\n]\s*$/.test(input)) return;
  assignment = candidate;
  render('Session: ' + nativeId + '\r\n• Working (0s • esc to interrupt)\r\n› ');
});
const within = (path, root) => { const suffix = relative(root, path); return suffix === '' || !suffix.startsWith('..' + '/') && suffix !== '..' && !isAbsolute(suffix); };
const timer = setInterval(() => {
  if (!assignment) return;
  if (!reported && existsSync(${JSON.stringify(releasePath)})) {
    const roots = [realpathSync(process.cwd()), ...args.flatMap((arg, index) => arg === '--add-dir' ? [realpathSync(args[index + 1])] : [])];
    const allows = path => roots.some(root => within(resolve(realpathSync(dirname(path)), path.split('/').at(-1)), root));
    const allowed = [...targets, assignment.report_path].map(path => ({ path, allowed: existsSync(dirname(path)) && allows(path) }));
    writeFileSync(${JSON.stringify(writeEvidence)}, JSON.stringify(allowed));
    if (!allowed.every(row => row.allowed)) { reported = true; return; }
    for (const target of targets) writeFileSync(target, 'approved synthetic write');
    if (metadata) {
      const task = ${JSON.stringify(join(metadataDirectory, 'tasks.md'))};
      writeFileSync(task, readFileSync(task, 'utf8').replace('- [ ] 2.1 ', '- [x] 2.1 '));
    }
    const report = { status: metadata ? 'succeeded' : 'failed', answer: 'Scoped synthetic writes', changes: assignment.assignments.map(change => ({ id: change.id, items: change.items.map(item => ({ id: item.id, status: metadata ? 'succeeded' : 'failed', ...(metadata ? {} : { reason: 'Synthetic report-only scope keeps task unfinished' }) })) })) };
    writeFileSync(assignment.report_path, JSON.stringify(report));
    reported = true;
  }
  if (existsSync(${JSON.stringify(exitGate)})) { clearInterval(timer); process.exit(17); }
}, 30);
`, { mode: 0o700 });
  const syntax = spawnSync(process.execPath, ['--check', executable], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify({ version: 1, runnerProtocols: [{
    runner: 'codex', executable: 'codex', version: '0.160.0', baseArgs: ['--no-daemon', '--no-alt-screen', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null,
    quotaCommand: '/status', navigation: [], markers: { ready: ['Ask Codex to do anything'] }, quotaParser: 'codex_status', modelPools: {}, quotaReliable: false, liveTaskVerified: false,
    timeouts: { startupMs: 5000, transitionMs: 5000, overallMs: 15000, pollMs: 30 }, collection: { intervalMs: 60000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  }] }));
  const command = join(f.root, 'writes-command.mjs');
  await writeFile(command, `import { createAppRuntime } from ${JSON.stringify(appRuntimeUrl)};
import { createProductionServices } from ${JSON.stringify(runtimeUrl)};
import { openStateStore } from ${JSON.stringify(storeUrl)};
const context = { ...${JSON.stringify(f.context)}, resolveCaller: async () => undefined };
const app = createAppRuntime(context, { loadConfiguration: async () => (${JSON.stringify(configured)}), openStore: async path => openStateStore(path), createServices: createProductionServices, nextRunIdentity: () => ({runId:${JSON.stringify(runId)},tmuxSession:'raf-writes-synthetic'}), now: Date.now });
try { console.log(JSON.stringify(await app.handlers['agent run'](${JSON.stringify(params)}))); } finally { await app.close(); }
`);
  const syntaxCommand = spawnSync(process.execPath, ['--check', command], { encoding: 'utf8' });
  assert.equal(syntaxCommand.status, 0, syntaxCommand.stderr);
  const launch = () => {
    const child = spawnSync(process.execPath, [command], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: f.binRoot + delimiter + (process.env.PATH ?? ''), HOME: f.home } });
    assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stderr}\n${child.stdout}`);
    const started = JSON.parse(child.stdout.trim());
    f.trackProcess(started.process.pid);
    const wrapper = f.store.sessionRepository.transaction(tx => tx.getSession(runId))?.launchContext?.wrapper;
    if (wrapper) f.trackProcess(wrapper.pid);
    return started;
  };
  const session = () => f.store.sessionRepository.transaction(tx => tx.getSession(runId));
  return { ...f, runId, reportPath, metadataDirectory, documentPath, targets, boundaries, gitDirectories, argvPath, releasePath, exitGate, writeEvidence, nativeId, launch, session };
}

for (const [metadata, worktree] of [[true, false], [false, false], [true, true], [false, true]] as const) {
  test(`[production-codex-writes-qa] ${metadata ? 'implement: derived change, questions and workspace boundaries' : 'spec: derived boundaries without workspace'}${worktree ? ' in a linked worktree: git-dir, common-dir and Orchestrator root git directory are writable roots only for a type with a write boundary' : ''} persist scoped native writes after parent exit`, async t => {
    const f = await scopedFixture(t, metadata, worktree);
    const started = f.launch();
    assert.equal(started.status, 'running');
    assert.equal(started.selection.quota, 'unknown');
    assert.equal(started.process.runnerSessionId, f.nativeId);
    const args: string[] = JSON.parse(await readFile(f.argvPath, 'utf8'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
    const directories = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
    const expected = [await realpath(dirname(f.reportPath))];
    expected.push(await realpath(f.metadataDirectory), await realpath(dirname(f.questionsPath)));
    if (metadata) expected.push(...f.gitDirectories);
    assert.deepEqual(directories.sort(), [...new Set(expected)].sort(), 'actual native argv must grant only declared outside-cwd parents plus own report directory');
    assert.equal(directories.includes(await realpath(f.root)), false);
    assert.equal(directories.includes(await realpath(f.home)), false);
    assert.equal(directories.includes(await realpath(dirname(f.statePath))), false);
    if (metadata && worktree) {
      const durable = await Promise.all((f.session()?.launchContext?.writeBoundaries ?? []).map(path => realpath(path).catch(() => path)));
      assert.deepEqual(durable.sort(), (await Promise.all([...f.boundaries, ...f.gitDirectories].map(path => realpath(path)))).sort());
    } else assert.deepEqual(f.session()?.launchContext?.writeBoundaries, f.boundaries);
    assert.equal(listTaskReservations(f.store).length, 1);
    await writeFile(f.releasePath, 'go');
    const accepted = await eventually(f.session, row => row?.result?.status === (metadata ? 'succeeded' : 'failed'), 'worker writes exact report path and accepts report after parent exited');
    assert.equal(accepted?.state, 'running');
    assert.equal(accepted?.result?.response, 'Scoped synthetic writes');
    const writes = JSON.parse(await readFile(f.writeEvidence, 'utf8'));
    assert.ok(writes.every((row: { allowed: boolean }) => row.allowed));
    for (const path of f.targets) assert.equal(await readFile(path, 'utf8'), 'approved synthetic write');
    assert.equal(JSON.parse(await readFile(f.reportPath, 'utf8')).status, metadata ? 'succeeded' : 'failed');
    await writeFile(f.exitGate, 'exit');
    const done = await eventually(f.session, row => row?.state === 'finished', 'owned worker finalizes after native exit');
    assert.equal(done?.result?.status, metadata ? 'succeeded' : 'failed');
    assert.equal(done?.result?.response, '');
    assert.equal(done?.launchContext, undefined);
    assert.deepEqual(listTaskReservations(f.store), []);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  });
}
