import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const source = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2] && output === process.argv[2] && output.startsWith('/srv/dev/'), 'Absolute /srv/dev evidence directory required');
await fs.mkdir(output, { recursive: true });
const write = (name, value) => fs.writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const json = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.argv[3] !== '--isolated') {
  const base = await fs.mkdtemp('/srv/dev/mrh74-');
  const home = join(base, 'home'), tmp = join(base, 'tmp');
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
  const evidence = { assignment: 'monitor-raf-health:7.4', runId: randomUUID(), outcome: 'failed', invocations: [], assertions: [],
    limitations: ['Real production CLI, worker, SQLite, main attachment and tmux transport. Terminal runner is synthetic; no provider calls or credentials.',
      'Fixture summary interval is 30000 ms; CPU policy, costProfile and production runner timeouts are preserved. No production conf is written.',
      'Existing agentRunFixture relaxes isolated admission thresholds; this is not a resource admission test.',
      'SQLite audit triggers observe facts and accepted transport receipts before normal outbox pruning; observer reads never settle runtime.'] };
  let f, cfg, env, store, mainSequence = 0;
  const sync = (executable, args, cwd = source) => {
    const r = spawnSync(executable, args, { cwd, encoding: 'utf8', env: process.env });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const until = async (read, predicate, label, limit = 45000) => {
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
    evidence.invocations.push({ label, argv, cliExitCode: outcome.exitCode, childExitCode: outcome.result?.exitCode ?? null,
      transportStderr: outcome.stderr, evidence: `${label}.transport.json` });
    assert.ok(outcome.result, `${label}: missing ExecutionResult`);
    assert.equal(outcome.exitCode, outcome.result.exitCode, label);
    return outcome;
  };
  try {
    evidence.environment = { sha: sync('git', ['rev-parse', 'HEAD']), dirty: sync('git', ['status', '--porcelain']),
      node: process.version, versions: process.versions, os: release(), platform: process.platform,
      git: sync('git', ['--version']), tmux: sync('tmux', ['-V']), openspec: sync('openspec', ['--version']) };
    assert.equal(sync('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Clean committed source required');
    const originalRaf = await json(join(source, '../conf/raf.json'));
    const timeouts = originalRaf.runnerProtocols.find(row => row.runner === 'codex').timeouts;
    const limit = timeouts.overallMs * 4;
    const { agentRunFixture, exists } = await import('../test/agent-run-fixture.ts');
    f = await agentRunFixture({ after: action => cleanups.unshift(action) }, 'live', timeouts, 'codex', {
      tasks: 1, productionQa: true, commands: ['main attach', 'command stats', 'service status'],
    });
    const marker = join(f.directory, 'fixture.json');
    cfg = await json(marker);
    env = { ...process.env, HOME: cfg.home, RAF_QA_HOME: cfg.home, RAF_AGENT_RUN_FIXTURE: marker,
      PATH: join(f.directory, 'bin') + ':' + process.env.PATH, TMPDIR: f.directory, TMUX_TMPDIR: f.directory };
    delete env.TMUX; delete env.TMUX_PANE;
    const rafPath = join(cfg.root, 'conf/raf.json');
    const raf = await json(rafPath);
    raf.costProfile = originalRaf.costProfile;
    raf.commandTiming = originalRaf.commandTiming;
    raf.health = originalRaf.health;
    raf.runnerProtocols[0].timeouts = timeouts;
    await fs.writeFile(rafPath, JSON.stringify(raf));
    const projects = await json(join(cfg.root, 'conf/projects.json'));
    const mainRoot = join(cfg.root, projects.projects.raf.branchPaths.main);
    for (const [key, value] of Object.entries({ 'user.name': 'Summary QA', 'user.email': 'qa@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null' })) sync('git', ['-C', mainRoot, 'config', key, value]);
    const { openStateStore } = await import(pathToFileURL(join(cfg.sourceRoot, 'src/state-store.ts')));
    store = openStateStore(cfg.statePath);
    const db = store.startupContextDatabase;
    db.exec(`CREATE TABLE qa_summary_facts(payload TEXT NOT NULL);
      CREATE TABLE qa_summary_receipts(payload TEXT NOT NULL);
      CREATE TRIGGER qa_summary_fact AFTER INSERT ON pending_intents
      WHEN json_extract(NEW.payload,'$.event')='raf.health-summary'
      BEGIN INSERT INTO qa_summary_facts VALUES(NEW.payload); END;
      CREATE TRIGGER qa_summary_receipt AFTER UPDATE ON pending_intents
      WHEN json_extract(NEW.payload,'$.event')='raf.health-summary'
      AND json_extract(NEW.payload,'$.payload.mainDelivered')=1
      AND COALESCE(json_extract(OLD.payload,'$.payload.mainDelivered'),0)<>1
      BEGIN INSERT INTO qa_summary_receipts VALUES(NEW.payload); END;`);
    const rows = table => db.prepare(`SELECT payload FROM ${table}`).all().map(row => JSON.parse(String(row.payload)));
    const facts = () => rows('qa_summary_facts');
    const receipts = () => rows('qa_summary_receipts');
    const state = () => store.healthSummary.transaction(tx => structuredClone(tx.state));
    const pending = () => store.sessionRepository.transaction(tx => tx.listPending().filter(row => row.event === 'raf.health-summary'), 'read');
    const mainScript = join(f.directory, 'main-caller.mjs');
    const mainInput = join(f.control, 'main-input.log');
    await fs.writeFile(mainScript, `import {readFile,readdir,writeFile,rename,appendFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const marker=process.argv[2],c=JSON.parse(await readFile(marker,'utf8')),started=new Set(),floor=Number(process.argv[3]);
process.stdin.setEncoding('utf8');if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',text=>appendFile(c.control+'/main-input.log',text));
setInterval(async()=>{for(const name of await readdir(c.control)){
if(!/^main-command-\\d+\\.json$/.test(name)||Number(name.match(/\\d+/)[0])<=floor||started.has(name))continue;started.add(name);
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
    const command = async (label, argv) => {
      const prefix = join(f.control, `main-command-${++mainSequence}`);
      await fs.writeFile(prefix + '.json.tmp', JSON.stringify(argv));
      await fs.rename(prefix + '.json.tmp', prefix + '.json');
      await until(() => exists(prefix + '.done'), Boolean, label, limit);
      return record(label, argv, await json(prefix + '.done'));
    };
    const attach = async suffix => {
      await tmux(`main-start-${suffix}`, ['new-session', '-d', '-s', 'main', '-c', cfg.root, process.execPath, mainScript, marker, String(mainSequence)]);
      const result = await command(`main-attach-${suffix}`, ['main', 'attach']);
      assert.equal(result.exitCode, 0, result.result.stderr);
      return JSON.parse(result.result.stdout);
    };
    await attach('initial');
    const off = await command('service-off-initial', ['service', 'status']);
    assert.equal(off.exitCode, 0, off.result.stderr);
    assert.equal(JSON.parse(off.result.stdout).state, 'stopped');
    await tmux('main-offline', ['kill-session', '-t', '=main']);
    const reconciled = await record('offline-reconcile', ['agent', 'ps'], await f.command(['agent', 'ps']));
    assert.equal(reconciled.exitCode, 0, reconciled.result.stderr);
    assert.ok(!f.inspect().sessions.some(row => row.addressId === 'main' && row.state === 'running'));
    raf.health = { ...originalRaf.health, summaryIntervalMs: 30000 };
    await fs.writeFile(rafPath, JSON.stringify(raf));
    store.healthSummary.transaction(tx => { tx.state.boundary = new Date().toISOString(); });
    const baseline = state();
    assert.equal(facts().length, 0);
    evidence.stand = { directory: f.directory, root: cfg.root, home: cfg.home, statePath: cfg.statePath,
      sourceHealth: originalRaf.health, standHealth: raf.health, timeouts, baseline, confHashes: {},
      costProfileUnchanged: JSON.stringify(raf.costProfile) === JSON.stringify(originalRaf.costProfile) };
    for (const name of ['raf.json', 'raf-constants.json', 'projects.json', 'models.json', 'flow.json', 'test-runs.json']) evidence.stand.confHashes[name] = hash(await fs.readFile(join(cfg.root, 'conf', name)));
    const launch = await record('worker-launch', f.runArgs('summary-worker'), await f.run('summary-worker'));
    assert.equal(launch.exitCode, 0, launch.result.stderr);
    const session = () => f.inspect().sessions.find(row => row.addressId === 'summary-worker');
    const worker = await until(session, row => row?.state === 'running' && !!row.process, 'live worker', limit);
    await until(() => exists(join(f.control, 'summary-worker.brief')), Boolean, 'worker accepted brief', limit);
    const workerAlive = () => { process.kill(worker.launchContext.wrapper.pid, 0); process.kill(worker.process.pid, 0); };
    workerAlive();
    const firstRows = await until(facts, items => items.length > 0, 'worker timer creates due fact without runtime commands', limit);
    assert.equal(firstRows.length, 1);
    const first = firstRows[0].payload.data;
    assert.equal(first.startedAt, baseline.boundary);
    assert.equal(first.scheduledAt, new Date(Date.parse(baseline.boundary) + raf.health.summaryIntervalMs).toISOString());
    assert.ok(Date.parse(first.completedAt) >= Date.parse(first.scheduledAt));
    await delay(700);
    workerAlive();
    assert.equal(facts().length, 1);
    assert.equal(receipts().length, 0);
    assert.equal(pending().length, 1);
    assert.equal(state().lastSummary.delivery, 'pending');
    await write('offline-pending.json', { first, state: state(), pending: pending(), worker });
    evidence.assertions.push('Live worker produces exactly one due fact with service stopped and no main; it stays pending without a receipt.');
    const returned = await attach('returned');
    await until(receipts, items => items.length === 1, 'returning main accepts pending summary', limit);
    await until(() => fs.readFile(mainInput, 'utf8').catch(() => ''), text => text.includes(first.factKey.replaceAll('"', '\\"')) || text.includes('raf.health-summary'), 'main receives actual tmux text');
    const stats = await command('stats-returned', ['command', 'stats']);
    assert.equal(stats.exitCode, 0, stats.result.stderr);
    const view = JSON.parse(stats.result.stdout);
    assert.ok(Array.isArray(view.commands));
    assert.ok(Array.isArray(view.profile.rows));
    assert.equal(view.health.summary.delivery, 'delivered');
    assert.equal(facts().length, 1);
    assert.equal(receipts().length, 1);
    assert.equal(pending().length, 0);
    assert.equal((await fs.readFile(mainInput, 'utf8')).split('[raf] {"type":"raf.health-summary"').length - 1, 1);
    const workerInput = await f.input(worker.process.pid);
    assert.ok(!workerInput.includes('raf.health-summary'));
    await write('returned-delivery.json', { returned, state: state(), receipts: receipts(), mainInput: await fs.readFile(mainInput, 'utf8'), workerInput });
    evidence.assertions.push('Only attached current main receives the pending fact once; another command preserves accepted delivery and commands/profile.');
    await tmux('stop-worker-runner', ['kill-session', '-t', '=' + worker.process.tmuxSession]);
    await until(session, row => row?.state === 'finished', 'worker finishes after owned runner exit', limit);
    await until(() => { try { process.kill(worker.launchContext.wrapper.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, Boolean, 'worker process exits', limit);
    const beforeSilence = { at: new Date().toISOString(), state: state(), facts: facts(), receipts: receipts() };
    assert.equal(beforeSilence.facts.length, 1);
    const silentUntil = Date.parse(beforeSilence.state.boundary) + 3 * raf.health.summaryIntervalMs + 250;
    while (Date.now() < silentUntil) await delay(Math.min(500, silentUntil - Date.now()));
    assert.equal(facts().length, 1, 'No service/background timer fabricates summaries without worker or runtime commands');
    assert.equal(receipts().length, 1);
    const beforeCatchup = Date.now();
    const catchup = await command('stats-delayed-catchup', ['command', 'stats']);
    const afterCatchup = Date.now();
    assert.equal(catchup.exitCode, 0, catchup.result.stderr);
    assert.equal(facts().length, 2);
    const delayed = facts()[1].payload.data;
    assert.equal(delayed.startedAt, first.completedAt);
    assert.equal(delayed.scheduledAt, new Date(Date.parse(first.completedAt) + raf.health.summaryIntervalMs).toISOString());
    assert.equal(delayed.delayed, true);
    assert.ok(Date.parse(delayed.completedAt) >= beforeCatchup && Date.parse(delayed.completedAt) <= afterCatchup);
    assert.equal(receipts().length, 2);
    const repeated = await Promise.all(['repeat-a', 'repeat-b'].map(label => command(label, ['command', 'stats'])));
    for (const item of repeated) assert.equal(item.exitCode, 0, item.result.stderr);
    assert.equal(facts().length, 2);
    assert.equal(receipts().length, 2);
    assert.equal(pending().length, 0);
    await write('delayed-catchup.json', { beforeSilence, silentUntil: new Date(silentUntil).toISOString(), beforeCatchup, afterCatchup, delayed, facts: facts(), receipts: receipts(), state: state() });
    evidence.assertions.push('Three real intervals without a worker or runtime commands produce no facts; next CLI creates one delayed actual period and concurrent retries create no storm.');
    const refused = await command('missing-recipient', ['agent', 'message', '--to', 'missing-summary-qa', '--text', 'SUMMARY_QA_NON_SECRET_CANARY']);
    assert.notEqual(refused.exitCode, 0);
    const refusal = JSON.parse(refused.result.stderr);
    assert.equal(refusal.code, 'HANDLER_FAILED');
    assert.match(refusal.reason ?? refusal.message, /Unknown or ambiguous session: missing-summary-qa/);
    evidence.expectedRefusal = refusal;
    const valid = await fs.readFile(rafPath, 'utf8');
    try {
      const invalid = JSON.parse(valid);
      delete invalid.health.summaryIntervalMs;
      await fs.writeFile(rafPath, JSON.stringify(invalid));
      const result = await command('invalid-summary-policy', ['command', 'stats']);
      assert.equal(result.exitCode, 0, result.result.stderr);
      const body = JSON.parse(result.result.stdout);
      assert.equal(body.health.error.code, 'CONFIGURATION_INVALID');
      assert.equal(body.health.error.pointer, 'conf/raf.json#/health/summaryIntervalMs');
      assert.ok(Array.isArray(body.commands) && Array.isArray(body.profile.rows));
    } finally { await fs.writeFile(rafPath, valid); }
    const finalOff = await command('service-off-final', ['service', 'status']);
    assert.equal(finalOff.exitCode, 0, finalOff.result.stderr);
    assert.equal(JSON.parse(finalOff.result.stdout).state, 'stopped');
    const input = await fs.readFile(mainInput, 'utf8');
    assert.equal(input.split('[raf] {"type":"raf.health-summary"').length - 1, 2);
    await fs.writeFile(join(output, 'main-input.log'), input);
    await write('final-state.json', { state: state(), facts: facts(), receipts: receipts(), sessions: f.inspect().sessions });
    evidence.assertions.push('Expected missing recipient refuses with a nonzero code and exact cause; invalid summary policy preserves CLI success and reports its precise pointer. Service remains stopped.');
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.error = { name: error.name, message: error.message, stack: error.stack };
    if (f) await write('failure-state.json', f.inspect()).catch(() => {});
    process.exitCode = 1;
  } finally {
    store?.close();
    for (const cleanup of cleanups) {
      try { await cleanup(); } catch (error) { evidence.cleanupError = String(error); evidence.outcome = 'failed'; process.exitCode = 1; }
    }
    evidence.cleanup = { complete: !evidence.cleanupError, fixtureRemoved: f ? !await fs.stat(f.directory).catch(() => null) : null };
    await write('summary.json', evidence);
    process.stdout.write(JSON.stringify({ outcome: evidence.outcome, runId: evidence.runId, assertions: evidence.assertions, error: evidence.error, cleanup: evidence.cleanup }) + '\n');
  }
}
