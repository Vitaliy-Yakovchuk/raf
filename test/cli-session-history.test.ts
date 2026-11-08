import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { createSessionState, type SessionRecord } from '../src/session-state.ts';
import { resultNoticeViews } from '../src/reminder-cli.ts';
import { loadFlowPolicy } from '../src/flow-policy.ts';

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

test('unchanged retention reads metadata without a writer or full session deserialization', t => {
  const f = fixture(t);
  for (let i = 0; i < 160; i++) f.insert(f.session(`history-${i}`, { finishedAt: '2099-01-01T00:00:00Z' }));
  const exec = f.db.exec.bind(f.db);
  t.mock.method(f.db, 'exec', (sql: string) => {
    assert.doesNotMatch(sql, /BEGIN IMMEDIATE/, 'No expired session requires no writer');
    return exec(sql);
  });
  const transaction = f.store.sessionRepository.transaction;
  t.mock.method(f.store.sessionRepository, 'transaction', (operation, mode) => transaction(tx => {
    tx.listSessions = () => assert.fail('Retention must not deserialize all session payloads');
    return operation(tx);
  }, mode));
  assert.equal(f.state.cleanupCompleted('2026-11-08T00:00:00Z'), 0);
});

test('retention keeps handoffs and active rows, accepts timestamp offsets, and rechecks after the read', t => {
  const f = fixture(t);
  const now = '2026-11-08T00:00:00.000Z';
  const cutoff = Date.parse(now) - loadFlowPolicy().retention.finishedSessionsMs;
  const boundary = new Date(cutoff).toISOString();
  const offset = new Date(cutoff + 3600000).toISOString().replace('Z', '+01:00');
  f.insert(f.session('boundary', { finishedAt: boundary }));
  f.insert(f.session('offset', { finishedAt: offset }));
  f.insert(f.session('newer', { finishedAt: new Date(cutoff + 1).toISOString() }));
  f.insert(f.session('invalid', { finishedAt: 'invalid' }));
  f.insert(f.session('active', { state: 'running', finishedAt: boundary }));
  f.insert(f.session('handoff', { finishedAt: boundary, modelHandoff: {} as SessionRecord['modelHandoff'] }));
  f.insert(f.session('changed', { finishedAt: boundary }));
  const transaction = f.store.sessionRepository.transaction;
  let changed = false;
  t.mock.method(f.store.sessionRepository, 'transaction', (operation, mode) => {
    if (mode !== 'read' && !changed) {
      changed = true;
      f.db.prepare("UPDATE sessions SET finished_at=?,payload=json_set(payload,'$.finishedAt',?) WHERE run_id='changed'").run(now, now);
    }
    return transaction(operation, mode);
  });
  assert.equal(f.state.cleanupCompleted(now), 2);
  assert.deepEqual(f.db.prepare('SELECT run_id FROM sessions ORDER BY run_id').all().map(row => row.run_id), ['active', 'changed', 'handoff', 'invalid', 'newer']);
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
