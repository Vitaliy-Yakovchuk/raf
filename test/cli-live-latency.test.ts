import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { createProductionServices } from '../src/production-runtime.ts';
import { createReminderHandlers, settleCommandState } from '../src/reminder-cli.ts';
import { loadCompiledCatalog } from '../src/compiled-catalog.ts';
import { loadEventCatalog } from '../src/event-catalog.ts';
import { deliverStartupContextEvents } from '../src/startup-context-delivery.ts';
import { listTaskReservations, reconcileTaskReservations } from '../src/task-reservations.ts';
import type { AdapterCommandExecutor } from '../src/agent-adapters.ts';
import { executeCommand, readMachineBootIdentity } from '../src/os-runtime.ts';
import { RafCostRuntime } from '../src/raf-cost-runtime.ts';

const size = { sessions: 406, running: 7, reminders: 227, notices: 486, pending: 115, intents: 300, processes: 260 };
const start = 'Fri Nov  6 00:00:00 2026';
const startedAt = new Date(start).toISOString();

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-live-budget-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.raf'), { recursive: true });
  cpSync(new URL('../../conf', import.meta.url), join(root, 'conf'), { recursive: true });
  const store = openStateStore(join(home, '.raf/state.sqlite'));
  const db = store.startupContextDatabase;
  const insertSession = db.prepare('INSERT INTO sessions(run_id,address_id,state,payload) VALUES(?,?,?,?)');
  const insertNotice = db.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES(?,?,?)');
  const insertReminder = db.prepare('INSERT INTO reminders(id,created_for,assigned_to,at,state,closed_at,payload) VALUES(?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < size.sessions; i++) {
    const row = { runId: `run-${i}`, addressId: i ? `worker-${i}` : 'main', revision: 1,
      state: i < size.running ? 'running' : 'finished', history: 'x'.repeat(18000),
      ...(i < size.running ? { process: { pid: 10000 + i, startedAt, runner: i ? 'codex' : 'main', runnerSessionId: `native-${i}`,
        tmuxSession: `session-${i}`, evidence: { command: `runner-${i}`, tmuxSocket: join(root, 'tmux.sock'), tmuxPane: `%${i}` } } } : {}) };
    insertSession.run(row.runId, row.addressId, row.state, JSON.stringify(row));
  }
  for (let i = 0; i < size.notices; i++) {
    const row = { id: `run-${i}:report-rejected:fixture`, runId: `run-${i % size.sessions}`, recipient: '', recipientRunId: null,
      source: { runId: `run-${i % size.sessions}`, addressId: `worker-${i}`, revision: 1, state: 'finished' },
      state: i < size.pending ? 'pending' : i < size.notices - 2 ? 'delivered' : 'undelivered', attempts: 1,
      text: 'x'.repeat(2400), lastError: 'Recipient session is not active:  (unresolved run)' };
    insertNotice.run(row.id, row.runId, JSON.stringify(row));
  }
  for (let i = 0; i < size.reminders; i++) {
    const row = { id: `reminder-${i}`, createdFor: 'main', assignedTo: 'main', text: 'fixture', at: '2099-01-01T00:00:00.000Z',
      binding: null, state: 'pending', closedAt: null, closeReason: null };
    insertReminder.run(row.id, row.createdFor, row.assignedTo, row.at, row.state, null, JSON.stringify(row));
  }
  const insertIntent = db.prepare('INSERT INTO pending_intents(id,run_id,payload) VALUES(?,?,?)');
  for (let i = 0; i < size.intents; i++) insertIntent.run(`intent-${i}`, null, JSON.stringify({ id: `intent-${i}`, runId: null, event: 'fixture.unknown', payload: {} }));
  db.exec('COMMIT');
  for (const statement of [insertSession, insertNotice, insertReminder, insertIntent]) statement.close();
  const ports = { store, now: Date.now, nextReminderId: () => 'unused', catalog: loadEventCatalog(root),
    deliver: async () => assert.fail('No eligible delivery exists') };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, home, store, db, ports };
}

test('reminder list has no writer transaction for unchanged ineligible deliveries at live cardinalities', async t => {
  const f = fixture(t);
  const exec = f.db.exec.bind(f.db);
  const writers: string[] = [];
  t.mock.method(f.db, 'exec', (sql: string) => { if (/BEGIN IMMEDIATE/.test(sql)) writers.push(sql); return exec(sql); });
  const at = performance.now();
  const reminders = await createReminderHandlers(f.ports)['reminder list']({});
  await settleCommandState(f.ports);
  const wallMs = performance.now() - at;
  t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', message: JSON.stringify({ size, command: 'reminder list', wallMs, budgetMs: 500, writers: writers.length }), location: null, stack: [], redacted: false, truncated: false }], evidence: [] }));
  assert.equal((reminders as unknown[]).length, size.reminders);
  assert.equal(writers.length, 0, 'No changes or eligible deliveries must not acquire a SQLite writer');
  assert.ok(wallMs < 500, `reminder list took ${wallMs}ms`);
  assert.equal(f.store.resultNotices.list().filter(row => row.state === 'pending').length, size.pending);
});

test('command startup reads existing runner defaults without acquiring a writer', t => {
  const f = fixture(t);
  const runners = [{ id: 'codex', initialEnabled: true }, { id: 'claude', initialEnabled: false }];
  f.store.initializeRunners(runners);
  f.store.setRunnerEnabled('codex', false);
  const exec = f.db.exec.bind(f.db);
  let writers = 0;
  t.mock.method(f.db, 'exec', (sql: string) => { if (/BEGIN IMMEDIATE/.test(sql)) writers++; return exec(sql); });
  f.store.initializeRunners(runners);
  assert.equal(writers, 0, 'An unchanged command startup must not acquire a SQLite writer');
  f.store.initializeRunners([...runners, { id: 'grok', initialEnabled: true }]);
  assert.equal(writers, 1, 'A newly configured runner is inserted in one transaction');
  assert.equal(f.store.getRunnerEnabled('codex'), false, 'Initialization preserves an explicitly disabled runner');
  assert.equal(f.store.getRunnerEnabled('claude'), false);
  assert.equal(f.store.getRunnerEnabled('grok'), true);
});

test('command cost finalization batches coverage writes at live health CPU cardinality', t => {
  const f = fixture(t);
  const state = JSON.parse(String(f.db.prepare('SELECT payload FROM raf_health_cpu WHERE singleton=1').get()!.payload));
  state.open = Object.fromEntries(Array.from({ length: 2646 }, (_, i) => [`historical-${i}`, '2026-11-07T00:00:00.000Z']));
  f.db.prepare('UPDATE raf_health_cpu SET payload=? WHERE singleton=1').run(JSON.stringify(state));
  const cost = new RafCostRuntime(f.store, { scope: 'command', command: 'reminder list' }, f.root, 'handler');
  cost.stage('reconciliation');
  cost.stage('finalization');
  const prepare = f.db.prepare.bind(f.db);
  let coverageWrites = 0;
  t.mock.method(f.db, 'prepare', (sql: string) => {
    if (sql.startsWith('UPDATE raf_health_cpu SET payload=')) coverageWrites++;
    return prepare(sql);
  });
  cost.finish();
  const after = JSON.parse(String(f.db.prepare('SELECT payload FROM raf_health_cpu WHERE singleton=1').get()!.payload));
  const rows = f.store.readCostProfile().rows;
  assert.ok(rows.length >= 4, 'Preserve every command stage contribution');
  assert.deepEqual(after.open, state.open, 'Finalization removes only its own open interval');
  for (const row of rows) {
    assert.equal(after.samples[JSON.stringify([row.scope, row.command, row.stage, row.executor])], row.samples);
  }
  assert.equal(coverageWrites, 2, 'Persist coverage once for the contribution batch and once when closing its interval');
});

test('settlement reads previously delivered context reviews and uncertain health summaries without no-op writes', async t => {
  const f = fixture(t);
  f.db.exec('DELETE FROM pending_intents');
  f.db.exec('CREATE TABLE startup_context_reviews (id TEXT PRIMARY KEY, payload TEXT NOT NULL, review_run_id TEXT, closed_at TEXT) STRICT');
  for (let i = 0; i < 300; i++) {
    const event = i < 266 ? 'raf.health-summary' : i < 299 ? 'context-review.due' : 'fixture.unknown';
    const id = `intent-${i}`;
    const payload = event === 'raf.health-summary' ? { mainDelivery: { recipientRunId: 'run-0' } } : { mainDelivered: true };
    f.db.prepare('INSERT INTO pending_intents(id,run_id,payload) VALUES(?,NULL,?)').run(id, JSON.stringify({ id, runId: null, event, payload }));
    if (event === 'context-review.due') f.db.prepare('INSERT INTO startup_context_reviews(id,payload,review_run_id,closed_at) VALUES(?,?,NULL,NULL)')
      .run(id, JSON.stringify({ to: 'main', mainDelivery: { state: 'delivered' } }));
  }
  const exec = f.db.exec.bind(f.db);
  let writers = 0;
  t.mock.method(f.db, 'exec', (sql: string) => { if (/BEGIN IMMEDIATE/.test(sql)) writers++; return exec(sql); });
  const at = performance.now();
  await deliverStartupContextEvents(f.store, () => new Date().toISOString(), async () => assert.fail('Existing delivery must not repeat'));
  await settleCommandState({ ...f.ports, orchestratorRoot: f.root, homeDirectory: process.env.RAF_QA_HOME });
  const wallMs = performance.now() - at;
  t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', message: JSON.stringify({ command: 'settlement', wallMs, writers }), location: null, stack: [], redacted: false, truncated: false }], evidence: [] }));
  assert.equal(writers, 0, 'Delivered and uncertain outbox rows require only reading');
  assert.ok(wallMs < 500, `Unchanged settlement took ${wallMs}ms`);
});

test('unchanged native composer refusals are read once per recipient before claiming pending notices', async t => {
  const f = fixture(t);
  f.db.prepare("UPDATE result_notices SET payload=json_set(payload,'$.recipient','main','$.recipientRunId','run-0','$.lastError','Message delivery failed: Recipient has no recognized empty agent composer') WHERE rowid<=29").run();
  const exec = f.db.exec.bind(f.db);
  let writers = 0;
  let reads = 0;
  t.mock.method(f.db, 'exec', (sql: string) => { if (/BEGIN IMMEDIATE/.test(sql)) writers++; return exec(sql); });
  await settleCommandState({ ...f.ports, deliveryReady: async () => { reads++; return false; } });
  assert.equal(writers, 0, 'Unchanged unavailable composer cannot require claims or completions');
  assert.equal(reads, 1, 'One recipient screen suffices for the unchanged pending notices');
  assert.ok(f.store.resultNotices.list().filter(row => row.recipient === 'main').every(row => row.attempts === 1));
  let delivered = 0;
  await settleCommandState({ ...f.ports, deliveryReady: async () => true,
    deliver: async () => { delivered++; return { accepted: true, receiptId: 'recovered' }; } });
  assert.equal(delivered, 29, 'The next command retries every eligible notice after the composer recovers');
  assert.ok(f.store.resultNotices.list().filter(row => row.recipient === 'main').every(row => row.state === 'delivered' && row.attempts === 2));
});

test('agent ps shares one process and pane snapshot across active agents at live cardinalities', async t => {
  const f = fixture(t);
  const calls: { executable: string; args: readonly string[] }[] = [];
  const own = await executeCommand({ executable: 'ps', args: ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='] });
  assert.equal(own.exitCode, 0);
  const ownRow = own.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
  f.db.prepare("UPDATE sessions SET payload=json_set(payload,'$.process.pid',?,'$.process.startedAt',?,'$.process.evidence.command',?) WHERE run_id='run-1'")
    .run(process.pid, new Date(ownRow[1]).toISOString(), ownRow[2]);
  const pidFor = (index: number) => index === 1 ? process.pid : 10000 + index;
  const processes = Array.from({ length: size.processes }, (_, index) => ({
    pid: pidFor(index),
    start: index === 1 ? ownRow[1] : start,
    command: index === 1 ? ownRow[2] : `runner-${index}`,
  }));
  const modal = 'Approaching rate limits\nSwitch to gpt-mini for lower credit usage?\n2. Keep current model\n';
  let modalScreens: string[] = [];
  let modalReads = 0;
  const execute: AdapterCommandExecutor = async command => {
    calls.push(command);
    if (command.executable === 'ps') {
      const parents = command.args.at(-1)?.includes('ppid');
      const selected = command.args.includes('-p') ? command.args[command.args.indexOf('-p') + 1].split(',').map(Number) : null;
      const rows = processes.filter(row => !selected || selected.includes(row.pid))
        .map(row => `${row.pid} ${parents ? '1 ' : ''}${row.start} ${row.command}`);
      return { exitCode: 0, stdout: rows.join('\n') + '\n', stderr: '' };
    }
    if (command.executable === 'tmux') {
      if (command.args.includes('list-panes')) return { exitCode: 0, stdout: Array.from({ length: size.running }, (_, i) => `session-${i}|0|0|${pidFor(i)}|%${i}`).join('\n') + '\n', stderr: '' };
      const target = command.args[command.args.indexOf('-t') + 1] ?? '';
      if (command.args.includes('capture-pane') && target === '%1' && modalScreens.length) {
        modalReads++;
        if (modalReads === 2) assert.ok(existsSync(join(f.home, '.raf/tmp/message-locks')), 'Recheck the modal after acquiring its lease');
        return { exitCode: 0, stdout: modalScreens.shift()!, stderr: '' };
      }
      const i = Number(target.match(/session-(\d+)/)?.[1] ?? target.match(/%(\d+)/)?.[1]);
      const format = command.args.at(-1);
      return { exitCode: 0, stdout: format === '#{pane_id}' ? `%${i}\n` : format === '#{pane_pid}' ? `${pidFor(i)}\n` : 'Unrecognized fixture composer\n', stderr: '' };
    }
    throw new Error(`Unexpected fixture command: ${command.executable}`);
  };
  const catalog = loadCompiledCatalog();
  const services = await createProductionServices(f.store, { catalog, models: catalog.models, commandTiming: { emaAlpha: 0.1 } }, {
    orchestratorRoot: f.root, confRoot: join(f.root, 'conf'), artifactPath: join(f.root, 'catalog.json'),
    statePath: join(f.home, '.raf/state.sqlite'), tmpRoot: join(f.home, '.raf/tmp'), mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  }, { execute });
  const at = performance.now();
  const rows = await services.control.ps();
  const wallMs = performance.now() - at;
  const ps = calls.filter(call => call.executable === 'ps');
  const panes = calls.filter(call => call.executable === 'tmux' && !call.args.includes('capture-pane'));
  t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', message: JSON.stringify({ size, command: 'agent ps', wallMs, budgetMs: 1000, ps: ps.length, paneReads: panes.length }), location: null, stack: [], redacted: false, truncated: false }], evidence: [] }));
  assert.equal(rows.filter(row => row.state === 'running').length, size.running);
  assert.equal(ps.length, 1, 'Ancestry and identity checks share one process scan');
  assert.equal(panes.length, 1, 'Active pane identities share one tmux enumeration');
  assert.ok(wallMs < 1000, `agent ps took ${wallMs}ms`);
  assert.equal(existsSync(join(f.home, '.raf/tmp/message-locks')), false,
    'An unchanged Codex screen must not create message locks or spawn Python lease helpers');
  await services.control.ps();
  assert.equal(calls.filter(call => call.executable === 'ps').length, 2, 'A new command observes a fresh process snapshot');
  assert.equal(calls.filter(call => call.executable === 'tmux' && !call.args.includes('capture-pane')).length, 2);
  modalScreens = [modal, '› User is composing a message\n'];
  await services.control.ps();
  assert.equal(modalReads, 2, 'A modal detected before the lease must be read again under the lease');
  assert.equal(calls.filter(call => call.args.includes('send-keys')).length, 0, 'Do not send dismissal keys after the modal disappears');
  modalReads = 0;
  modalScreens = [modal, modal];
  await services.control.ps();
  const sent = calls.filter(call => call.args.includes('send-keys'));
  assert.equal(modalReads, 2);
  assert.equal(sent.length, 1, 'A confirmed modal is still dismissed');
  assert.deepEqual(sent[0].args.slice(-3), ['-t', '%1', '2']);
});


test('reading and reconciling unchanged task reservations never acquires a writer', async t => {
  const f = fixture(t);
  const exec = f.db.exec.bind(f.db);
  let writers = 0;
  t.mock.method(f.db, 'exec', (sql: string) => { if (/BEGIN IMMEDIATE/.test(sql)) writers++; return exec(sql); });
  assert.deepEqual(listTaskReservations(f.store), []);
  assert.deepEqual(await reconcileTaskReservations({ store: f.store,
    currentBoot: async () => ({ machineId: 'fixture-machine', bootId: 'fixture-boot' }),
    observe: async () => assert.fail('There is no reservation owner to observe'),
    resolveTasks: async () => [], newFence: () => 'unused',
  }), { retained: [], released: [] });
  assert.equal(writers, 0, 'Listing and unchanged reconciliation must use read transactions');
  const boot = { machineId: 'fixture-machine', bootId: 'fixture-boot' };
  const session = f.store.sessionRepository.transaction(tx => tx.getSession('run-0'), 'read')!;
  const identity = { ...session.process!, evidence: { ...session.process!.evidence, ...boot, runId: session.runId } };
  const lease = { owner: { runId: session.runId, addressId: session.addressId, fence: 'fixture-fence' }, revision: 1 };
  f.store.taskReservationRepository.transaction(tx => tx.putTaskReservation({ lease, tasks: [], boot, stage: 'starting', starter: identity }));
  writers = 0;
  assert.equal(listTaskReservations(f.store).length, 1);
  assert.deepEqual(await reconcileTaskReservations({ store: f.store, currentBoot: async () => boot,
    observe: async observed => ({ state: 'alive', identity: observed, observedAt: new Date().toISOString() }),
    resolveTasks: async () => [], newFence: () => 'unused',
  }), { retained: [lease], released: [] });
  assert.equal(writers, 0, 'Live reservations retain their leases without no-op writes');
});

test('launch admission shares one process snapshot across existing reservation owners', async t => {
  const f = fixture(t);
  const boot = await readMachineBootIdentity();
  const observed = await executeCommand({ executable: 'ps', args: ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='] });
  assert.equal(observed.exitCode, 0);
  const row = observed.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
  for (let i = 0; i < size.running; i++) {
    const runId = `run-${i}`;
    const addressId = i ? `worker-${i}` : 'main';
    const starter = { pid: process.pid, startedAt: new Date(row[1]).toISOString(), runner: 'codex',
      runnerSessionId: `starter-${i}`, tmuxSession: `starter-${i}`, evidence: { ...boot, runId, command: row[2] } };
    const lease = { owner: { runId, addressId, fence: `fence-${i}` }, revision: 1 };
    f.store.taskReservationRepository.transaction(tx => tx.putTaskReservation({ lease, tasks: [], boot, stage: 'starting', starter }));
  }
  let processScans = 0;
  const execute: AdapterCommandExecutor = async command => {
    if (command.executable === 'ps') {
      processScans++;
      const parent = command.args.at(-1)?.includes('ppid') ? '1 ' : '';
      return { exitCode: 0, stdout: `${process.pid} ${parent}${row[1]} ${row[2]}\n`, stderr: '' };
    }
    if (command.executable === 'df') return { exitCode: 1, stdout: '', stderr: 'Fixture disk measurement unavailable' };
    throw new Error(`Unexpected admission fixture command: ${command.executable}`);
  };
  const catalog = loadCompiledCatalog();
  const services = await createProductionServices(f.store, { catalog, models: catalog.models, commandTiming: { emaAlpha: 0.1 } }, {
    orchestratorRoot: f.root, confRoot: join(f.root, 'conf'), artifactPath: join(f.root, 'catalog.json'),
    statePath: join(f.home, '.raf/state.sqlite'), tmpRoot: join(f.home, '.raf/tmp'), mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  }, { execute });
  const request = { runId: 'admission-candidate', addressId: 'admission-candidate', tmuxSession: 'admission-candidate',
    activity: { type: 'qa', project: 'raf', features: [], phase: 'qa', cwd: f.root },
    assignment: { root: f.root, changes: [] },
    selection: { status: 'selected' as const, runner: 'codex', model: 'fixture', effort: 'low', reason: 'fixture', quota: 'available' as const },
    statePath: join(f.home, '.raf/state.sqlite'), tmpRoot: join(f.home, '.raf/tmp'), reportPath: join(f.root, 'unused-report.json'),
    requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [],
  };
  assert.equal((await services.reserve(request)).admitted, false, 'Unavailable disk evidence still refuses admission');
  assert.equal(listTaskReservations(f.store).length, size.running, 'Every live owner retains its reservation');
  assert.equal(processScans, 1, 'One admission pass scans existing owners once');
  await services.reserve(request);
  assert.equal(processScans, 2, 'The next admission obtains a fresh process snapshot');
});
