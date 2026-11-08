import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { createSessionState, type SessionRecord } from '../src/session-state.ts';
import { resultNoticeViews } from '../src/reminder-cli.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-session-history-'));
  const store = openStateStore(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const db = store.startupContextDatabase;
  const insert = (row: SessionRecord) => db.prepare('INSERT INTO sessions(run_id,address_id,state,finished_at,payload) VALUES(?,?,?,?,?)')
    .run(row.runId, row.addressId, row.state, row.finishedAt ?? null, JSON.stringify(row));
  const session = (runId: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({ runId, addressId: runId, state: 'finished', revision: 1, ...extra });
  const state = createSessionState({ repository: store.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => false });
  return { store, db, insert, session, state };
}

test('notice projection reads only referenced sessions and preserves stored order and fallback sources', t => {
  const f = fixture(t);
  for (let i = 0; i < 160; i++) f.insert(f.session(`history-${i}`));
  const first = f.session('first', { revision: 7 });
  const second = f.session('second', { state: 'running' });
  f.insert(first); f.insert(second);
  const source = f.session('missing');
  for (const [id, row] of [['second', second], ['first', first], ['missing', source]] as const) {
    const notice = { id: `${id}:result-notice`, runId: id, source: { ...row, revision: 0 }, recipient: 'main', recipientRunId: null, state: 'pending', attempts: 0, text: 'result' };
    f.db.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES(?,?,?)').run(notice.id, id, JSON.stringify(notice));
  }
  const transaction = f.store.sessionRepository.transaction;
  t.mock.method(f.store.sessionRepository, 'transaction', (operation, mode) => transaction(tx => {
    tx.listSessions = () => assert.fail('Notice projection must not deserialize unrelated session history');
    return operation(tx);
  }, mode));
  const rows = resultNoticeViews(f.store, []);
  assert.deepEqual(rows.map(row => [row.runId, row.revision, row.resultNotice?.state]), [['first', 7, 'pending'], ['second', 1, 'pending'], ['missing', 0, 'pending']]);
  const visible = resultNoticeViews(f.store, [second]);
  assert.deepEqual(visible.map(row => row.runId), ['second', 'first', 'missing']);
});

test('no completed roots requires no writer or full session deserialization', t => {
  const f = fixture(t);
  for (let i = 0; i < 160; i++) f.insert(f.session(`active-${i}`, { state: 'running' }));
  const exec = f.db.exec.bind(f.db);
  t.mock.method(f.db, 'exec', (sql: string) => {
    assert.doesNotMatch(sql, /BEGIN IMMEDIATE/, 'No completed root requires no writer');
    return exec(sql);
  });
  const transaction = f.store.sessionRepository.transaction;
  t.mock.method(f.store.sessionRepository, 'transaction', (operation, mode) => transaction(tx => {
    tx.listSessions = () => assert.fail('Cleanup must not deserialize all session payloads');
    return operation(tx);
  }, mode));
  assert.equal(f.state.cleanupCompleted('2026-11-08T00:00:00Z'), 0);
});

test('cleanup rechecks a root under the writer and returns between completed roots', t => {
  const f = fixture(t);
  const now = '2026-11-08T00:00:00.000Z';
  for (const runId of ['changed', 'first', 'second']) f.insert(f.session(runId, { finishedAt: now }));
  f.insert(f.session('active', { state: 'running' }));
  f.insert(f.session('handoff', { finishedAt: now, modelHandoff: {} as SessionRecord['modelHandoff'] }));
  const transaction = f.store.sessionRepository.transaction;
  let changed = false;
  t.mock.method(f.store.sessionRepository, 'transaction', (operation, mode) => {
    if (mode !== 'read' && !changed) {
      changed = true;
      f.db.prepare("UPDATE sessions SET state='running',payload=json_set(payload,'$.state','running') WHERE run_id='changed'").run();
    }
    return transaction(tx => {
      tx.listSessions = () => assert.fail('Cleanup must select addressed roots');
      return operation(tx);
    }, mode);
  });
  assert.equal(f.state.cleanupCompleted(now), 1);
  assert.ok(f.store.sessionRepository.transaction(tx => tx.getSession('second'), 'read'));
  assert.equal(f.state.cleanupCompleted(now), 1);
  assert.equal(f.state.cleanupCompleted(now), 0);
  assert.deepEqual(f.db.prepare('SELECT run_id FROM sessions ORDER BY run_id').all().map(row => row.run_id), ['active', 'changed', 'handoff']);
});

test('addressed session reads cover every page and ignore duplicate and missing IDs', t => {
  const f = fixture(t);
  for (let i = 0; i < 160; i++) f.insert(f.session(`run-${i}`));
  const ids = Array.from({ length: 121 }, (_, i) => `run-${120-i}`);
  const rows = f.store.sessionRepository.transaction(tx => {
    assert.equal(typeof tx.listSessionsByRunIds, 'function');
    return tx.listSessionsByRunIds!([...ids, 'missing', 'run-0']);
  }, 'read');
  assert.deepEqual(rows.map(row => row.runId), [...ids].reverse());
});
