import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateAssignment } from '../src/assignment.ts';
import { openStateStore } from '../src/state-store.ts';
import { observeDatabaseReads } from '../src/database-read-limit.ts';
import { settleArchiveEvents } from '../src/archive-events-runtime.ts';
import { settleResultNotices } from '../src/reminder-cli.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-cli-latency-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.raf'), { recursive: true });
  cpSync(new URL('../../conf', import.meta.url), join(root, 'conf'), { recursive: true });
  for (let i = 0; i < 120; i++) {
    const change = join(root, 'openspec/changes', `fixture-${i}`);
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, 'proposal.md'), '# Fixture\n');
    writeFileSync(join(change, 'tasks.md'), '- [ ] 1.1 Fixture\n');
  }
  mkdirSync(join(root, 'raf-main'));
  const config = JSON.parse(readFileSync(join(root, 'conf/projects.json'), 'utf8'));
  config.projects.raf.path = 'raf-main';
  config.projects.raf.branchPaths.main = 'raf-main';
  delete config.projects.raf.mainCopies;
  writeFileSync(join(root, 'conf/projects.json'), JSON.stringify(config));
  const state = join(home, '.raf/state.sqlite');
  const store = openStateStore(state);
  const db = store.startupContextDatabase;
  const session = db.prepare('INSERT INTO sessions(run_id,address_id,state,payload) VALUES(?,?,?,?)');
  const notice = db.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES(?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < 335; i++) {
    const source = { runId: `history-${i}`, addressId: `worker-${i}`, state: 'finished', revision: 1,
      launchContext: { brief: 'x'.repeat(64 * 1024) } };
    session.run(source.runId, source.addressId, source.state, JSON.stringify(source));
    if (i < 40) {
      const n = { id: `notice-${i}`, runId: source.runId, source, recipient: 'inactive', recipientRunId: null,
        state: 'pending', attempts: 0, text: 'Result', lastError: null };
      notice.run(n.id, n.runId, JSON.stringify(n));
    }
  }
  db.exec('COMMIT'); session.close(); notice.close();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, home, store };
}

test('pending notice settlement uses addressed recipient reads on a production-sized state', async t => {
  const f = fixture(t);
  let scans = 0;
  const repository = f.store.sessionRepository;
  const transaction = repository.transaction.bind(repository);
  t.mock.method(repository, 'transaction', (action, mode) => transaction(tx => action(new Proxy(tx, {
    get(target, name, receiver) {
      if (name === 'listSessions' || name === 'listActiveSessions') return (...args: unknown[]) => {
        scans++; return Reflect.apply(Reflect.get(target, name), target, args);
      };
      return Reflect.get(target, name, receiver);
    },
  })), mode));
  const start = performance.now();
  await settleResultNotices({ store: f.store, now: Date.now, deliver: async () => assert.fail('Inactive recipient must not receive a delivery') });
  t.diagnostic(JSON.stringify({ settlementMs: performance.now() - start, scans }));
  const notices = f.store.resultNotices.list();
  assert.equal(notices.length, 40);
  for (const notice of notices) {
    assert.equal(notice.attempts, 1);
    assert.equal(notice.state, 'pending');
    assert.equal(notice.lastError, 'Recipient session is not active: inactive (unresolved run)');
  }
  assert.equal(scans, 0, 'A claim already identifies the exact recipient run; history must not be scanned for each notice');
});

for (const [args, budgetMs] of [[['reminder', 'list'], 500], [['agent', 'ps'], 1000]] as const) {
  test(`${args.join(' ')} stays below ${budgetMs}ms with 335 sessions, 40 pending notices and 120 changes`, t => {
    const f = fixture(t);
    const environment = { ...process.env, HOME: f.home, RAF_QA_HOME: f.home, RAF_ORCHESTRATOR_ROOT: f.root };
    for (const name of Object.keys(environment)) if (name.startsWith('RAF_') && !['RAF_QA_HOME', 'RAF_ORCHESTRATOR_ROOT'].includes(name) || ['TMUX', 'TMUX_PANE'].includes(name)) delete environment[name];
    const at = performance.now();
    const result = spawnSync(process.execPath, [new URL('../bin/raf.ts', import.meta.url).pathname, ...args], {
      env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    const wallMs = performance.now() - at;
    t.diagnostic(JSON.stringify({ command: args.join(' '), wallMs, budgetMs }));
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(Array.isArray(output));
    assert.equal(output.length, args[0] === 'agent' ? 40 : 0);
    assert.ok(wallMs < budgetMs, `${args.join(' ')} took ${wallMs}ms; budget ${budgetMs}ms`);
  });
}


test('active session reads skip finished history and preserve insertion order across bounded pages', t => {
  const f = fixture(t);
  const db = f.store.startupContextDatabase;
  const expected = [];
  for (let i = 0; i < 155; i++) {
    const row = { runId: `active-${i}`, addressId: `active-${154 - i}`, revision: 1,
      state: ['running', 'reserved', 'exited'][i % 3] };
    db.prepare('INSERT INTO sessions(run_id,address_id,state,payload) VALUES(?,?,?,?)')
      .run(row.runId, row.addressId, row.state, JSON.stringify(row));
    expected.push(row);
  }
  let rowsRead = 0;
  const actual = observeDatabaseReads(() => f.store.sessionRepository.transaction(tx => tx.listActiveSessions!(), 'read'),
    query => { rowsRead += query.rowsRead; });
  assert.deepEqual(actual, expected);
  assert.ok(rowsRead <= expected.length + 4, `Active lookup read ${rowsRead} rows for ${expected.length} active sessions`);
});

test('archive observation does not clone the complete snapshot for each still-active change', async t => {
  const f = fixture(t);
  const clone = globalThis.structuredClone;
  let copies = 0;
  t.mock.method(globalThis, 'structuredClone', (...args: Parameters<typeof structuredClone>) => {
    copies++; return clone(...args);
  });
  await settleArchiveEvents(f.store, f.root, { events: [] });
  await settleArchiveEvents(f.store, f.root, { events: [] });
  const row = f.store.startupContextDatabase.prepare("SELECT payload FROM pending_intents WHERE id='openspec:archive-observation'").get()!;
  const observation = JSON.parse(String(row.payload)).payload;
  assert.equal(observation.active.length, 120);
  assert.equal(observation.cycles.length, 120);
  assert.equal(copies, 0, 'A still-active change cannot emit an archive event');
});

test('assignment archive names preserve exact missing-change diagnostics without reading historical contents', async () => {
  let active = true;
  const ports = {
    fs: {
      readText: async () => { throw new Error('Historical contents are irrelevant to launch validation'); },
      listDirectories: async () => ['2026-10-01-selected', '2026-10-01-selected-other', '.draft'],
    },
    cli: { exec: async (args: readonly string[]) => {
      const key = args.join(' ');
      assert.ok(!args.includes('--archived'), 'Historical task progress must not be read at launch');
      const data = key === 'list --json'
        ? { changes: active ? [{ name: 'selected', completedTasks: 0, totalTasks: 1 }] : [] }
        : { tasks: [{ id: '1.1', description: 'Selected work', done: false }] };
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: '' };
    } },
  };
  const request = { root: '/work/project', selections: [{ change: 'selected', items: [{ id: '1.1' }] }] };
  const valid = await validateAssignment(request, ports);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.snapshot.baselineArchives, ['2026-10-01-selected', '2026-10-01-selected-other']);
  active = false;
  const missing = await validateAssignment(request, ports);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.kind, 'invalid-assignment');
    assert.deepEqual(missing.issues[0].archives, ['2026-10-01-selected']);
  }
});
