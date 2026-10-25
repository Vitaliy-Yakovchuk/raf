import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { configureForcedCloseStand, forcedCloseStandPrefix, prepareForcedCloseMain } from './qa-forced-close-config.mjs';

const source = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'absolute evidence directory argument required');
assert.equal(output, process.argv[2]);
await fs.mkdir(output, { recursive: true });
const write = (name, value) => fs.writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const json = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.argv[3] !== '--isolated') {
  const base = await fs.mkdtemp(forcedCloseStandPrefix());
  const home = join(base, 'home');
  const tmp = join(base, 'tmp');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(tmp, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, RAF_QA_HOME: home, TMPDIR: tmp, TMUX_TMPDIR: tmp,
    LANG: 'C.UTF-8', TZ: 'UTC', TERM: 'xterm-256color', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const child = spawn(process.execPath, [import.meta.filename, output, '--isolated'], { env, cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 600000);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  clearTimeout(guard);
  await fs.writeFile(join(output, 'host.stdout'), stdout);
  await fs.writeFile(join(output, 'host.stderr'), stderr);
  await write('host-exit.json', { executable: process.execPath, argv: [import.meta.filename, output], code, timedOut, base });
  if (!timedOut && code === 0) await fs.rm(base, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ code, timedOut, evidence: output }) + '\n');
  process.exitCode = code === 0 && !timedOut ? 0 : 1;
} else {
  const cleanups = [];
  const children = new Set();
  const evidence = { assignment: 'monitor-raf-health:5.4', outcome: 'failed', invocations: [], assertions: [],
    limitations: ['Real production CLI, watcher, Git checkbox writer, SQLite and tmux processes; terminal payload is synthetic and makes no model or network calls.',
      'Existing agentRunFixture relaxes isolated resource admission thresholds. This stand does not test resource admission or a real AI provider.',
      'Restart replaces the isolated main caller and all command runtimes reopen SQLite; no production service is restarted.',
      'Retention boundaries use the real cleanup operation with a future observation time from unchanged finishedSessionsMs, without waiting a day.'] };
  let f, cfg, env, writer, mainSequence = 0;
  const sync = (executable, args, cwd = source) => {
    const r = spawnSync(executable, args, { cwd, encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const until = async (read, predicate, label, limit) => {
    const deadline = Date.now() + limit;
    let last;
    do { last = await read(); if (predicate(last)) return last; await delay(50); } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(last)}`);
  };
  const record = async (label, argv, outcome) => {
    await write(`${label}.transport.json`, outcome);
    if (outcome.result) {
      await fs.writeFile(join(output, `${label}.stdout`), outcome.result.stdout);
      await fs.writeFile(join(output, `${label}.stderr`), outcome.result.stderr);
    }
    evidence.invocations.push({ label, argv, cliExitCode: outcome.exitCode,
      resultExitCode: outcome.result?.exitCode ?? null, transportStderr: outcome.stderr,
      evidence: `${label}.transport.json` });
    assert.ok(outcome.result, `${label}: missing ExecutionResult`);
    assert.equal(outcome.exitCode, outcome.result.exitCode, label);
    return outcome;
  };
  try {
    evidence.environment = { sha: sync('git', ['rev-parse', 'HEAD']), dirty: sync('git', ['status', '--porcelain']),
      node: process.version, os: release(), platform: process.platform,
      git: sync('git', ['--version']), tmux: sync('tmux', ['-V']), openspec: sync('openspec', ['--version']) };
    const originalRaf = await json(join(source, '../conf/raf.json'));
    const protocol = originalRaf.runnerProtocols.find(row => row.runner === 'codex');
    const timeouts = protocol.timeouts;
    const limit = timeouts.overallMs * 4;
    const { agentRunFixture, exists } = await import('../test/agent-run-fixture.ts');
    f = await agentRunFixture({ after: action => cleanups.unshift(action) }, 'live', timeouts, 'codex', {
      tasks: 3, productionQa: true, commands: ['main attach', 'command stats'],
    });
    const marker = join(f.directory, 'fixture.json');
    cfg = await json(marker);
    env = { ...process.env, HOME: cfg.home, RAF_QA_HOME: cfg.home, RAF_AGENT_RUN_FIXTURE: marker,
      PATH: join(f.directory, 'bin') + ':' + process.env.PATH, TMPDIR: f.directory, TMUX_TMPDIR: f.directory };
    delete env.TMUX; delete env.TMUX_PANE;
    const rafPath = join(cfg.root, 'conf/raf.json');
    const raf = configureForcedCloseStand(await json(rafPath), originalRaf);
    await fs.writeFile(rafPath, JSON.stringify(raf));
    const flow = await json(join(cfg.root, 'conf/flow.json'));
    evidence.stand = { directory: f.directory, root: cfg.root, home: cfg.home, tmpRoot: f.tmpRoot, statePath: cfg.statePath,
      timeouts, retention: flow.retention, syntheticRunnerVersion: raf.runnerProtocols[0].version,
      sourceRafHash: hash(await fs.readFile(join(source, '../conf/raf.json'))), fixtureRafHash: hash(await fs.readFile(rafPath)),
      costProfileUnchanged: JSON.stringify(raf.costProfile) === JSON.stringify(originalRaf.costProfile),
      retentionUnchanged: JSON.stringify(flow.retention) === JSON.stringify((await json(join(source, '../conf/flow.json'))).retention) };
    assert.equal(evidence.stand.costProfileUnchanged, true);
    assert.equal(evidence.stand.retentionUnchanged, true);
    evidence.stand.mainRoot = prepareForcedCloseMain(cfg.root, await json(join(cfg.root, 'conf/projects.json')));
    const { mainRoute } = await import(pathToFileURL(join(cfg.sourceRoot, 'src/hotfix-host.ts')));
    evidence.stand.mainRoute = await mainRoute({ orchestratorRoot: cfg.root, qaHome: cfg.home, environment: {}, sandboxExecutable: 'codex' });
    const started = await record('auto-launch', f.runArgs('auto-worker'), await f.run('auto-worker'));
    assert.equal(started.exitCode, 0);
    const session = id => f.inspect().sessions.find(row => row.addressId === id);
    const auto = await until(() => session('auto-worker'), row => row?.state === 'running' && !!row.process,
      'registered auto runner', limit);
    await until(() => exists(join(f.control, 'auto-worker.brief')), Boolean, 'runner accepted brief', limit);
    const mainScript = join(f.directory, 'main-caller.mjs');
    await fs.writeFile(mainScript, `import {readFile,readdir,writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const marker=process.argv[2],c=JSON.parse(await readFile(marker,'utf8')),started=new Set();
setInterval(async()=>{for(const name of await readdir(c.control)){
if(!/^main-command-\\d+\\.json$/.test(name)||started.has(name))continue;started.add(name);
const prefix=c.control+'/'+name.slice(0,-5),argv=JSON.parse(await readFile(prefix+'.json','utf8'));
const child=spawn(process.execPath,[c.commandPath,marker,JSON.stringify(argv)],{cwd:c.root,env:process.env,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
child.on('close',async exitCode=>{let result=null;try{result=stdout.trim()?JSON.parse(stdout):null;}catch{}await writeFile(prefix+'.done.tmp',JSON.stringify({exitCode,result,stderr,rawStdout:stdout}));await rename(prefix+'.done.tmp',prefix+'.done');});}},20);
`);
    const tmux = async (label, args) => {
      const r = spawnSync(cfg.tmux, ['-L', cfg.tmuxLabel, ...args], { env, encoding: 'utf8' });
      await write(`${label}.json`, { command: [cfg.tmux, '-L', cfg.tmuxLabel, ...args], code: r.status, stdout: r.stdout, stderr: r.stderr });
      assert.equal(r.status, 0, r.stderr);
    };
    const attach = async suffix => {
      await tmux(`main-start-${suffix}`, ['new-session', '-d', '-s', 'main', '-c', cfg.root, process.execPath, mainScript, marker]);
      const attached = await command(`main-attach-${suffix}`, ['main', 'attach']);
      assert.equal(attached.exitCode, 0);
    };
    const command = async (label, argv) => {
      const prefix = join(f.control, `main-command-${++mainSequence}`);
      await fs.writeFile(prefix + '.json.tmp', JSON.stringify(argv));
      await fs.rename(prefix + '.json.tmp', prefix + '.json');
      await until(() => exists(prefix + '.done'), Boolean, label, limit);
      return record(label, argv, await json(prefix + '.done'));
    };
    const metrics = async label => {
      const before = Date.now();
      const r = await command(label, ['command', 'stats']);
      assert.equal(r.exitCode, 0);
      const value = JSON.parse(r.result.stdout).health.forcedClose;
      assert.equal(value.unavailableReason, null);
      assert.ok(value.since);
      const readAt = Date.parse(value.readAt);
      assert.ok(readAt >= before && readAt <= Date.now(), `Expected current UTC readAt, got ${value.readAt}`);
      assert.ok(Date.parse(value.since) <= readAt, `Accounting start exceeds readAt: ${value.since}`);
      return value;
    };
    await attach('initial');
    const baseline = await metrics('stats-before');
    assert.equal(baseline.completed, 0);
    const lockPath = join(cfg.root, '.git/raf-task-checkbox.lock');
    const writerScript = join(f.directory, 'writer.mjs');
    await fs.writeFile(writerScript, `import{writeFile,rm}from'node:fs/promises';
const path=process.argv[2];await writeFile(path,JSON.stringify({kind:'raf-task-checkbox-lock',pid:process.pid}),{flag:'wx',mode:0o600});
process.send({ready:true,pid:process.pid});process.on('message',async message=>{if(message==='release'){await rm(path);process.exit(0);}});
`);
    writer = spawn(process.execPath, [writerScript, lockPath], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(writer);
    await new Promise((done, reject) => { writer.once('message', done); writer.once('error', reject); writer.once('exit', code => reject(new Error(`writer exited ${code}`))); });
    evidence.writer = { pid: writer.pid, lockPath, owner: await json(lockPath) };
    const report = { status: 'succeeded', answer: 'Unchanged report under a real live writer', commits: [], context: { unnecessary: [], missing: [] },
      changes: [{ id: 'launch-failure-fixture', items: [{ id: '1.1', status: 'succeeded' }] }] };
    const bytes = JSON.stringify(report) + '\n';
    const reportPath = auto.launchContext.reportPath;
    const beforeHead = (await f.git('rev-parse', 'HEAD')).trim();
    await fs.writeFile(reportPath + '.new', bytes);
    await fs.rename(reportPath + '.new', reportPath);
    const beforeStat = await fs.stat(reportPath);
    const pendingPath = join(dirname(reportPath), 'report-confirmation-pending.json');
    const pending = await until(async () => exists(pendingPath).then(ok => ok ? json(pendingPath) : null),
      value => value?.exhausted === true, 'watcher exhausted one bounded contention cycle', limit);
    await write('confirmation-pending.json', pending);
    assert.equal(session('auto-worker').result, undefined);
    assert.equal((await metrics('stats-while-busy')).completed, 0);
    writer.send('release');
    await new Promise(done => writer.exitCode !== null ? done() : writer.once('exit', done));
    children.delete(writer);
    const accepted = await until(() => session('auto-worker'), row => row?.result?.status === 'succeeded',
      'watcher accepts unchanged report without command reconciliation or force', limit);
    const afterStat = await fs.stat(reportPath);
    assert.equal(await fs.readFile(reportPath, 'utf8'), bytes);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(accepted.result.forcedClose, undefined);
    const checkboxCommits = (await f.git('rev-list', beforeHead + '..HEAD')).trim().split('\n').filter(Boolean);
    assert.equal(checkboxCommits.length, 1);
    assert.match(await f.git('show', '--format=%B', '--no-patch', checkboxCommits[0]), /1\.1/);
    evidence.auto = { runId: auto.runId, pending, reportPath, reportSha256: hash(bytes),
      before: { ino: beforeStat.ino, mtimeMs: beforeStat.mtimeMs }, after: { ino: afterStat.ino, mtimeMs: afterStat.mtimeMs }, accepted, checkboxCommits };
    evidence.assertions.push('Live writer caused a bounded pending cycle; automatic watcher accepted the same inode, mtime and bytes after release without force or a reconciliation CLI call.');
    const normal = await command('normal-close', ['agent', 'close', '--id', 'auto-worker']);
    assert.equal(normal.exitCode, 0);
    await until(() => session('auto-worker'), row => row?.state === 'finished', 'normal close finalized', limit);
    assert.equal((await metrics('stats-after-normal')).completed, 0);
    const forcedLaunch = await record('force-launch', f.runArgs('force-worker', 'implement', ['1.2']), await f.run('force-worker', 'implement', ['1.2']));
    assert.equal(forcedLaunch.exitCode, 0);
    const force = await until(() => session('force-worker'), row => row?.state === 'running' && !!row.process, 'force runner registered', limit);
    await until(() => exists(join(f.control, 'force-worker.brief')), Boolean, 'force runner accepted brief', limit);
    const refused = await command('normal-close-pending', ['agent', 'close', '--id', 'force-worker']);
    assert.notEqual(refused.exitCode, 0);
    assert.equal(JSON.parse(refused.result.stderr).code, 'AGENT_RESULT_PENDING');
    const noReason = await command('force-no-reason', ['agent', 'close', '--id', 'force-worker', '--force']);
    assert.notEqual(noReason.exitCode, 0);
    assert.match(noReason.result.stderr, /reason/);
    assert.equal((await metrics('stats-after-refusals')).completed, 0);
    const reason = 'Controlled QA force for monitor-raf-health:5.4';
    const forced = await command('force-close', ['agent', 'close', '--id', 'force-worker', '--force', '--reason', reason]);
    assert.equal(forced.exitCode, 0);
    const finished = await until(() => session('force-worker'), row => row?.state === 'finished', 'forced close finalized', limit);
    assert.deepEqual(finished.result.forcedClose, { reason });
    assert.equal(finished.result.status, 'failed');
    const afterForce = await metrics('stats-after-force');
    assert.equal(afterForce.completed, 1);
    const repeated = await command('force-repeat', ['agent', 'close', '--id', 'force-worker', '--force', '--reason', 'Repeat must not replace reason']);
    evidence.repeat = { exitCode: repeated.exitCode, diagnostic: repeated.result.stderr };
    assert.equal((await metrics('stats-after-repeat')).completed, 1);
    assert.equal(session('force-worker').finishedAt, finished.finishedAt);
    assert.deepEqual(session('force-worker').result.forcedClose, { reason });
    evidence.force = { runId: force.runId, reason, finished, baseline, afterForce, refusal: JSON.parse(noReason.result.stderr) };
    await tmux('main-stop', ['kill-session', '-t', '=main']);
    await attach('restart');
    const afterRestart = await metrics('stats-after-restart');
    assert.equal(afterRestart.completed, 1);
    assert.equal(afterRestart.since, afterForce.since);
    assert.deepEqual(session('force-worker').result.forcedClose, { reason });
    for (const row of [auto, force]) await fs.rm(dirname(row.launchContext.reportPath), { recursive: true, force: true });
    assert.deepEqual(session('force-worker').result.forcedClose, { reason });
    const { openStateStore } = await import(pathToFileURL(join(cfg.sourceRoot, 'src/state-store.ts')));
    const { createSessionState } = await import(pathToFileURL(join(cfg.sourceRoot, 'src/session-state.ts')));
    const store = openStateStore(cfg.statePath);
    try {
      const state = createSessionState({ repository: store.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => false });
      const boundary = Date.parse(finished.finishedAt) + flow.retention.finishedSessionsMs;
      state.cleanupCompleted(new Date(boundary - 1).toISOString());
      assert.deepEqual(store.sessionRepository.transaction(tx => tx.getSession(force.runId), 'read').result.forcedClose, { reason });
      const removed = state.cleanupCompleted(new Date(boundary).toISOString());
      assert.ok(removed >= 1);
      assert.equal(store.sessionRepository.transaction(tx => tx.getSession(force.runId), 'read'), undefined);
      evidence.retention = { boundary: new Date(boundary).toISOString(), removed, reasonRetainedBeforeBoundary: true, sessionRemovedAtBoundary: true };
    } finally { store.close(); }
    const afterCleanup = await metrics('stats-after-retention');
    assert.equal(afterCleanup.completed, 1);
    assert.equal(afterCleanup.since, afterForce.since);
    assert.equal(JSON.stringify(afterCleanup).includes(reason), false);
    evidence.assertions.push('Normal close and refused commands add no completed force; a separate allowed force adds exactly one, preserves its first reason and finishedAt on repeat.');
    evidence.assertions.push('Fresh main/runtime and SQLite reopen preserve one contribution and reason; tmp cleanup retains reason until configured retention, then session cleanup removes reason while retaining aggregate.');
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.error = { name: error.name, message: error.message, stack: error.stack };
    if (f) await write('failure-state.json', f.inspect()).catch(() => {});
    process.exitCode = 1;
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    for (const cleanup of cleanups) {
      try { await cleanup(); } catch (error) { evidence.cleanupError = String(error); evidence.outcome = 'failed'; process.exitCode = 1; }
    }
    evidence.cleanup = { complete: !evidence.cleanupError, fixtureRemoved: f ? !await fs.stat(f.directory).catch(() => null) : null };
    await write('summary.json', evidence);
    process.stdout.write(JSON.stringify({ outcome: evidence.outcome, assertions: evidence.assertions, error: evidence.error, cleanup: evidence.cleanup }) + '\n');
  }
}
