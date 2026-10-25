import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const script = path.resolve(import.meta.filename);
const source = path.resolve(import.meta.dirname, '..');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sql = file => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(['reminders', 'pending_intents', 'reminder_deliveries', 'result_notices', 'sessions'].map(table => [table,
      db.prepare('SELECT * FROM ' + table).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === 'payload' ? JSON.parse(value) : value])))]));
  } finally { db.close(); }
};

if (process.argv[2] === 'child') {
  const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const load = name => import(pathToFileURL(path.join(input.code, 'src', name + '.ts')).href);
  const { openStateStore } = await load('state-store');
  const store = openStateStore(input.db);
  try {
    const { createEventRegistry } = await load('event-registry');
    const { loadEventCatalog, validateEventObjectId } = await load('event-catalog');
    const catalog = JSON.parse(fs.readFileSync(path.join(input.code, 'dist/catalog.json')));
    const events = loadEventCatalog(input.root, catalog);
    const registry = createEventRegistry(events, { validateId: validateEventObjectId, transaction: operation => store.eventRepository.transaction(operation) });
    let value;
    if (input.op === 'seed') {
      store.sessionRepository.transaction(tx => { for (const session of input.sessions) tx.putSession(session); });
      value = { seeded: input.sessions.map(row => row.addressId) };
    } else if (input.op === 'enqueue') {
      registry.enqueue(input.fact);
      value = { enqueued: input.fact.key };
    } else if (input.op === 'rollback') {
      const db = store.startupContextDatabase;
      db.exec("CREATE TEMP TRIGGER qa_delete_failure BEFORE DELETE ON pending_intents BEGIN SELECT RAISE(ABORT, 'QA pending delete rollback'); END");
      try { registry.dispatch(); throw new Error('Expected injected SQL failure'); }
      catch (error) { assert.match(String(error), /QA pending delete rollback/); value = { injectedFailure: String(error) }; }
    } else if (input.op === 'lock') {
      store.startupContextDatabase.exec('BEGIN IMMEDIATE');
      fs.writeFileSync(input.ready, 'locked');
      process.send?.({ locked: true });
      await new Promise(resolve => process.once('message', resolve));
      store.startupContextDatabase.exec('ROLLBACK');
      value = { released: true };
    } else if (input.op === 'dispatch') {
      value = registry.dispatch();
    } else {
      const { createProductionServices, rafSystemCaller } = await load('production-runtime');
      const { readConfiguration } = await load('production-entry');
      const loaded = readConfiguration(input.root, catalog);
      const services = await createProductionServices(store, { catalog, models: loaded.models, commandTiming: loaded.commandTiming }, {
        orchestratorRoot: input.root, confRoot: path.join(input.root, 'conf'), artifactPath: path.join(input.code, 'dist/catalog.json'),
        statePath: input.db, tmpRoot: input.tmp, mode: 'test', commandStartedAtMs: Date.now(), resolveCaller: async () => undefined,
      });
      const { createReminderHandlers, settleCommandState } = await load('reminder-cli');
      const ports = { store, orchestratorRoot: input.root, catalog: events, now: Date.now, nextReminderId: randomUUID,
        deliver: request => services.control.message(request, rafSystemCaller) };
      const { execute } = await load('cli');
      const result = await execute(input.args, catalog, { ...createReminderHandlers(ports), 'agent ps': () => services.control.ps() });
      const settled = await settleCommandState(ports);
      process.stdout.write(JSON.stringify({ ...result, settled }) + '\n');
      process.exitCode = result.exitCode;
    }
    if (value !== undefined) process.stdout.write(JSON.stringify(value) + '\n');
  } finally { store.close(); }
  process.disconnect?.();
} else {
  const output = path.resolve(process.argv[2]);
  const selected = process.argv[3]?.split(',');
  fs.mkdirSync(output, { recursive: true });
  const base = fs.mkdtempSync('/tmp/cfc54-');
  const root = path.join(base, 'root'), code = path.join(root, 'raf-develop');
  const home = path.join(base, 'home'), db = path.join(base, 'state.sqlite'), tmp = path.join(base, 'tmp');
  for (const dir of [code, home, tmp]) fs.mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, RAF_QA_HOME: home, TMPDIR: tmp, TERM: 'xterm', TZ: 'UTC', LANG: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Event QA fixture', GIT_AUTHOR_EMAIL: 'qa@example.invalid',
    GIT_COMMITTER_NAME: 'Event QA fixture', GIT_COMMITTER_EMAIL: 'qa@example.invalid' };
  const evidence = { assignment: 'complete-raf-flow-contracts:5.4', status: 'failed', base, root, code, home, db, tmp,
    command: [process.execPath, script, output, ...(selected ? [selected.join(',')] : [])], selected: selected ?? 'all', versions: { node: process.version }, commands: [], scenarios: [], cleanup: {}, limitations: [
      'The compiled CLI parser dispatches production handlers in separate processes with a test runtime context. This is an API/CLI stand, not public bin/raf.ts provenance acceptance.',
      'The live tmux recipients are controlled stdin receivers, not an authenticated external AI provider. Native runner interrupt acceptance is reported separately.',
      'Deployment has no approved live producer or environment; fixture controls do not prove a real deployment or I7 positive acceptance.'
    ] };
  const flush = () => write(path.join(output, 'integration.json'), evidence);
  let sequence = 0, main, agent;
  const children = new Set();
  function run(label, executable, args, cwd = root, options = {}) {
    const key = String(++sequence).padStart(3, '0') + '-' + label;
    const before = fs.existsSync(db) ? sql(db) : null;
    const started = performance.now();
    const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
    fs.writeFileSync(path.join(output, key + '.stdout'), result.stdout ?? '');
    fs.writeFileSync(path.join(output, key + '.stderr'), result.stderr ?? '');
    const row = { label, command: [executable, ...args], cwd, cliExitCode: result.status, signal: result.signal,
      error: result.error?.message ?? null, durationMs: performance.now() - started, stdout: key + '.stdout', stderr: key + '.stderr',
      before, after: fs.existsSync(db) ? sql(db) : null };
    write(path.join(output, key + '.json'), row); evidence.commands.push({ ...row, before: undefined, after: undefined, detail: key + '.json' }); flush();
    return { ...row, raw: result.stdout ?? '' };
  }
  const must = row => { assert.equal(row.error, null); assert.equal(row.signal, null); assert.equal(row.cliExitCode, 0, row.label + ': ' + fs.readFileSync(path.join(output, row.stderr))); return row.raw ? JSON.parse(row.raw) : null; };
  const invoke = (label, data) => {
    const input = path.join(base, 'input-' + (++sequence) + '.json'); write(input, { code, root, db, tmp, ...data });
    return run(label, process.execPath, [script, 'child', input]);
  };
  const command = (label, args) => must(invoke(label, { args }));
  const remind = (label, kind, id, action = 'activate') => JSON.parse(command(label, ['reminder', 'add', '--to', 'main', '--at', '2099-01-01T00:00:00Z', '--text', 'CFC54 ' + label,
    '--event', kind, '--event-id', id, '--event-action', action]).stdout);
  const reminders = () => sql(db).reminders.map(row => row.payload);
  const find = item => reminders().find(row => row.id === item.id);
  const pending = () => sql(db).pending_intents.filter(row => row.payload.payload?.kind);
  const scenario = async (id, body) => {
    if (selected && !selected.includes(id)) return;
    try { const details = await body(); evidence.scenarios.push({ id, status: 'passed', details }); }
    catch (error) { evidence.scenarios.push({ id, status: 'failed', error: String(error), stack: error.stack }); }
    flush();
  };
  const fixture = (id, complete = true, archived) => {
    const directory = path.join(root, 'openspec/changes', ...(archived ? ['archive', archived] : [id]));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'proposal.md'), '## Why\nThis isolated QA fixture verifies current OpenSpec archive events using real commands.\n## What Changes\nLocal state only.\n## Impact\nNone.\n');
    fs.writeFileSync(path.join(directory, 'tasks.md'), '- [' + (complete ? 'x' : ' ') + '] 1.1 Fixture complete\n');
    fs.writeFileSync(path.join(directory, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
    return directory;
  };
  try {
    const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }); assert.equal(shaResult.status, 0); evidence.sha = shaResult.stdout.trim();
    evidence.workspace = spawnSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).stdout;
    const archive = spawnSync('git', ['archive', evidence.sha, 'src', 'bin', 'scripts', 'package.json'], { cwd: source, maxBuffer: 32 * 1024 * 1024 }); assert.equal(archive.status, 0);
    const extracted = spawnSync('tar', ['-x', '-C', code], { input: archive.stdout }); assert.equal(extracted.status, 0);
    fs.cpSync(path.join(source, '../conf'), path.join(root, 'conf'), { recursive: true });
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(code, 'node_modules'));
    evidence.configuration = Object.fromEntries(['raf.json', 'raf-constants.json', 'flow.json', 'test-runs.json', 'projects.json'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, 'conf', name))).digest('hex')]));
    assert.equal(run('build', process.execPath, ['scripts/build.ts'], code).cliExitCode, 0);
    for (const [label, executable, args] of [['tmux-version', 'tmux', ['-V']], ['openspec-version', 'openspec', ['--version']]]) {
      const result = run(label, executable, args); assert.equal(result.cliExitCode, 0); evidence.versions[label] = result.raw.trim();
    }
    evidence.versions.sqlite = new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS version').get().version;
    const { startQueueMainStand } = await import(pathToFileURL(path.join(code, 'scripts/qa-launch-queue-transport.ts')).href);
    main = await startQueueMainStand(base);
    agent = await startQueueMainStand(path.join(base, 'agent'));
    evidence.tmux = { main: main.identity, agent: agent.identity };
    const runId = agent.runId, reportPath = path.join(tmp, runId, 'worker.json'); fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const worker = { runId, addressId: 'worker', state: 'running', revision: 0, process: { ...agent.identity, runner: 'codex' },
      activity: { type: 'qa', phase: 'qa', project: 'raf', cwd: code, features: ['event-fixture'] }, launchedBy: { addressId: 'main', runId: main.runId },
      launchContext: { assignment: { root, changes: [{ id: 'event-fixture', items: [{ id: '1.1', description: 'Fixture complete' }] }] },
        reportPath, briefPath: path.join(tmp, runId, 'brief.txt'), selection: { runner: 'codex', model: 'fixture', effort: 'fixture' } } };
    const mainRecord = { runId: main.runId, addressId: 'main', state: 'running', revision: 0, process: main.identity };
    must(invoke('seed-live-sessions', { op: 'seed', sessions: [mainRecord, worker] }));
    fixture('event-fixture', false);
    let rejectedActivate, rejectedClose, foreign;
    await scenario('I1', async () => {
      rejectedActivate = remind('rejected-activate', 'agent.report-rejected', 'worker');
      rejectedClose = remind('rejected-close', 'agent.report-rejected', 'worker', 'close');
      foreign = remind('foreign-address', 'agent.report-rejected', 'other-worker');
      command('update-binding', ['reminder', 'update', '--id', rejectedClose.id, '--text', 'CFC54 updated close', '--event', 'agent.report-rejected', '--event-id', 'worker', '--event-action', 'close']);
      const count = reminders().length;
      for (const [label, kind, id] of [['unknown-event', 'not.approved', 'worker'], ['wrong-id', 'agent.closed', '%12']]) {
        const result = invoke(label, { args: ['reminder', 'add', '--to', 'main', '--at', '2099-01-01T00:00:00Z', '--text', label, '--event', kind, '--event-id', id, '--event-action', 'activate'] });
        assert.notEqual(result.cliExitCode, 0); assert.equal(result.signal, null);
      }
      assert.equal(reminders().length, count);
      fs.writeFileSync(reportPath, '{broken');
      command('reconcile-rejected-report', ['agent', 'ps']);
      assert.equal(find(rejectedActivate).state, 'active'); assert.equal(find(rejectedClose).state, 'closed'); assert.equal(find(foreign).state, 'pending');
      assert.equal(pending().length, 0);
      return { activate: rejectedActivate.id, close: rejectedClose.id, untouched: foreign.id, producer: 'production control.ps report acceptance rejects actual invalid report bytes' };
    });
    await scenario('I2', async () => {
      const binding = remind('restart-close', 'agent.failed', 'retry-worker', 'close');
      const fact = { key: 'cfc54-restart', event: { kind: 'agent.failed', id: 'retry-worker' } };
      must(invoke('enqueue-and-exit', { op: 'enqueue', fact }));
      assert.ok(pending().some(row => row.id === fact.key));
      must(invoke('rollback-delete', { op: 'rollback' }));
      assert.equal(find(binding).state, 'pending'); assert.ok(pending().some(row => row.id === fact.key));
      const input = path.join(base, 'lock.json'), ready = path.join(base, 'lock-ready'); write(input, { code, root, db, tmp, op: 'lock', ready });
      const lock = spawn(process.execPath, [script, 'child', input], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.add(lock);
      let lockOut = '', lockErr = ''; lock.stdout.on('data', data => { lockOut += data; }); lock.stderr.on('data', data => { lockErr += data; });
      const closed = new Promise(resolve => lock.on('close', (code, signal) => resolve({ code, signal })));
      try {
        for (let attempt = 0; !fs.existsSync(ready); attempt++) { assert.ok(attempt < 250); await wait(20); }
        const blocked = invoke('writer-contention', { op: 'dispatch' });
        assert.notEqual(blocked.cliExitCode, 0); assert.equal(blocked.signal, null); assert.ok(blocked.durationMs < 10000);
        assert.match(fs.readFileSync(path.join(output, blocked.stderr), 'utf8'), /SQLite|locked|busy/i);
        assert.equal(find(binding).state, 'pending'); assert.ok(pending().some(row => row.id === fact.key));
      } finally { lock.send('release'); const result = await closed; children.delete(lock); write(path.join(output, 'lock-process.json'), { command: [process.execPath, script, 'child', input], ...result, stdout: lockOut, stderr: lockErr }); assert.equal(result.code, 0); }
      command('restart-consumes-pending', ['reminder', 'list']);
      assert.equal(find(binding).state, 'closed'); assert.equal(pending().some(row => row.id === fact.key), false);
      return { binding: binding.id, restart: 'new child for every operation', rollback: 'real SQLite abort trigger', writerLock: 'separate live process' };
    });
    await scenario('I3', async () => {
      const id = 'archive-live', old = '2026-01-01-' + id;
      fixture(id, true, old);
      const active = fixture(id);
      const binding = remind('archive-current', 'openspec.archived', id, 'close');
      command('archive-baseline', ['reminder', 'list']); assert.equal(find(binding).state, 'pending');
      for (const [label, args] of [['before-active', ['list', '--json']], ['before-archived', ['list', '--archived', '--json']], ['before-show', ['show', id, '--json']]]) assert.equal(run(label, 'openspec', args).cliExitCode, 0);
      const failed = run('archive-refused', 'openspec', ['archive', 'missing-change', '--yes', '--skip-specs']); assert.notEqual(failed.cliExitCode, 0);
      command('settle-failed-archive', ['reminder', 'list']); assert.equal(find(binding).state, 'pending');
      fixture(id, false, '2026-02-01-' + id);
      command('partial-with-active', ['reminder', 'list']); assert.equal(find(binding).state, 'pending');
      fs.rmSync(active, { recursive: true });
      fixture('prefix-' + id, true, '2026-03-01-prefix-' + id);
      command('deletion-and-suffix-controls', ['reminder', 'list']); assert.equal(find(binding).state, 'pending');
      fixture(id);
      command('new-active-baseline', ['reminder', 'list']);
      assert.equal(run('archive-success', 'openspec', ['archive', id, '--yes', '--skip-specs']).cliExitCode, 0);
      for (const [label, args] of [['after-active', ['list', '--json']], ['after-archived', ['list', '--archived', '--json']]]) assert.equal(run(label, 'openspec', args).cliExitCode, 0);
      command('archive-production-settle', ['reminder', 'list']); assert.equal(find(binding).state, 'closed');
      return { id, binding: binding.id, closedAt: find(binding).closedAt };
    });
    await scenario('I4', async () => {
      const id = 'archive-race'; fixture(id);
      const binding = remind('archive-race-binding', 'openspec.archived', id, 'close'); command('race-baseline', ['reminder', 'list']);
      assert.equal(run('archive-race-success', 'openspec', ['archive', id, '--yes', '--skip-specs']).cliExitCode, 0);
      const parallel = await Promise.all([0, 1].map(index => new Promise((resolve, reject) => {
        const input = path.join(base, 'race-' + index + '.json'); write(input, { code, root, db, tmp, args: ['reminder', 'list'] });
        const child = spawn(process.execPath, [script, 'child', input], { cwd: root, env }); children.add(child);
        let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject); child.on('close', (cliExitCode, signal) => { children.delete(child); const result = { command: [process.execPath, script, 'child', input], cliExitCode, signal, stdout, stderr }; write(path.join(output, 'race-' + index + '.json'), result); resolve(result); });
      })));
      for (const result of parallel) { assert.equal(result.cliExitCode, 0, result.stderr); assert.equal(result.signal, null); }
      const closedAt = find(binding).closedAt; assert.equal(find(binding).state, 'closed');
      command('race-reopen-repeat', ['reminder', 'list']); assert.equal(find(binding).closedAt, closedAt);
      const todayArchive = path.join(root, 'openspec/changes/archive', new Date().toISOString().slice(0, 10) + '-' + id);
      fs.renameSync(todayArchive, path.join(root, 'openspec/changes/archive', '2026-04-01-' + id));
      fixture(id); const second = remind('archive-next-cycle', 'openspec.archived', id, 'close'); command('second-cycle-baseline', ['reminder', 'list']);
      assert.equal(find(second).state, 'pending');
      assert.equal(run('archive-next-cycle-success', 'openspec', ['archive', id, '--yes', '--skip-specs']).cliExitCode, 0);
      command('second-cycle-settle', ['reminder', 'list']); assert.equal(find(second).state, 'closed'); assert.equal(find(binding).closedAt, closedAt);
      assert.equal(pending().length, 0);
      return { first: binding.id, second: second.id, closedAt, after: sql(db) };
    });
    await scenario('I5', async () => {
      const binding = remind('delivery-retry', 'agent.failed', 'delivery-worker');
      must(invoke('recipient-unavailable', { op: 'seed', sessions: [{ ...mainRecord, process: { ...main.identity, evidence: { ...main.identity.evidence, tmuxSocket: path.join(base, 'unavailable.sock') } } }] }));
      must(invoke('delivery-event', { op: 'enqueue', fact: { key: 'cfc54-delivery', event: { kind: 'agent.failed', id: 'delivery-worker' } } }));
      const unavailable = command('undelivered-active', ['reminder', 'list']); assert.equal(find(binding).state, 'active'); assert.ok(unavailable.settled.undelivered.some(row => row.id === binding.id));
      assert.equal(sql(db).reminder_deliveries.some(row => row.reminder_id === binding.id), false);
      must(invoke('recipient-restored', { op: 'seed', sessions: [mainRecord] }));
      const delivered = command('deliver-real-tmux', ['reminder', 'list']); assert.ok(delivered.settled.delivered.includes(binding.id));
      await wait(150);
      const deliveredRows = sql(db).reminder_deliveries; const receipt = deliveredRows.find(row => row.reminder_id === binding.id); assert.ok(receipt);
      command('delivery-reopen-repeat', ['reminder', 'list']); await wait(100);
      assert.deepEqual(sql(db).reminder_deliveries, deliveredRows);
      const received = main.received().filter(row => row.text.includes(binding.id)); assert.equal(received.length, 1);
      write(path.join(output, 'tmux-received.json'), main.received());
      return { binding: binding.id, receipt, received };
    });
    await scenario('I6-result-and-final-close', async () => {
      const resultBinding = remind('result-failed', 'agent.failed', 'worker');
      const closeBinding = remind('final-close', 'agent.closed', 'worker', 'close');
      fs.writeFileSync(reportPath, JSON.stringify({ status: 'failed', answer: 'Controlled live-process result', changes: [{ id: 'event-fixture', items: [{ id: '1.1', status: 'failed', reason: 'Fixture result' }] }] }));
      command('accept-real-report', ['agent', 'ps']);
      assert.equal(find(resultBinding).state, 'active'); assert.equal(find(closeBinding).state, 'pending');
      const current = sql(db).sessions.find(row => row.run_id === runId).payload; assert.equal(current.state, 'running'); assert.equal(current.result.status, 'failed');
      evidence.agentCleanup = await agent.stop(); agent = null;
      command('finalize-observed-exit', ['agent', 'ps']);
      assert.equal(find(closeBinding).state, 'closed'); assert.equal(sql(db).sessions.find(row => row.run_id === runId).payload.state, 'finished');
      return { resultBinding: resultBinding.id, closeBinding: closeBinding.id, acceptedResult: current.result, reportRejectedCovered: 'I1', nativeInterrupt: 'unexecuted: controlled stdin receiver is not a native runner' };
    });
    await scenario('I7-negative-fixture-control', async () => {
      const binding = remind('deployment-no-proof', 'deployment.completed', 'fixture-deployment');
      const result = run('deployment-fixture-exit-zero', process.execPath, ['-e', 'process.exitCode=0']); assert.equal(result.cliExitCode, 0);
      command('settle-without-version-proof', ['reminder', 'list']); assert.equal(find(binding).state, 'pending');
      assert.equal(pending().some(row => row.payload.payload?.kind === 'deployment.completed'), false);
      return { binding: binding.id, eventCreated: false, positiveAcceptance: 'unexecuted: no approved real deployment producer or stand' };
    });
    evidence.status = evidence.scenarios.every(row => row.status === 'passed') ? 'partial' : 'failed';
  } catch (error) { evidence.error = String(error); evidence.stack = error.stack; }
  finally {
    for (const child of children) child.kill('SIGTERM');
    try { if (agent) evidence.agentCleanup = await agent.stop(); } catch (error) { evidence.cleanup.agentError = String(error); }
    try { if (main) evidence.mainCleanup = await main.stop(); } catch (error) { evidence.cleanup.mainError = String(error); }
    if (fs.existsSync(db)) write(path.join(output, 'final-sql.json'), sql(db));
    fs.rmSync(base, { recursive: true, force: true }); evidence.cleanup.fixtureRemoved = !fs.existsSync(base); flush();
  }
  console.log(JSON.stringify({ status: evidence.status, scenarios: evidence.scenarios.map(({ id, status, error }) => ({ id, status, error })), error: evidence.error, evidence: path.join(output, 'integration.json'), cleanup: evidence.cleanup }));
  process.exitCode = evidence.status === 'failed' ? 1 : 0;
}
