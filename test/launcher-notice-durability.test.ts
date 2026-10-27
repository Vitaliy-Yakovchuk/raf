import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { commandFixture } from './reminder-fixture.ts';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { fixture as migrationFixture, seedMain10 } from './state-migration-fixture.ts';
import { createSessionState } from '../src/session-state.ts';
import { resultNoticeViews } from '../src/reminder-cli.ts';

async function setup(t: Parameters<typeof commandFixture>[0]) {
  const f = await commandFixture(t);
  const recipient = f.session('observer');
  const worker = f.session('worker');
  const reportPath = `${f.root}/tmp/${worker.runId}/worker.json`;
  f.store.sessionRepository.transaction(tx => tx.putSession({ ...worker,
    notify: { addressId: recipient.addressId, runId: recipient.runId },
    launchContext: {
      assignment: { root: f.root, changes: [{ id: 'notice-durability', items: [{ id: '2.3', description: 'Implement notice' }] }], baselineArchives: [] },
      selection: { runner: 'codex', model: 'fixture', effort: 'high', reason: 'fixture' },
      reportPath, briefPath: `${f.root}/brief.txt`,
    },
  }));
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  const accept = () => state.acceptWorkResult(worker.runId, { status: 'succeeded', response: 'Durable answer', proof: null }, { pending: [], domain: [] });
  return { f, state, recipient, worker, reportPath, accept };
}

test('[result-notice-durability] concurrent delivery owners confirm one notice and never resend it', async t => {
  const { f, accept, reportPath } = await setup(t);
  assert.equal(accept(), true);
  f.delayDelivery(25);
  await Promise.all([f.settle(), f.settle(f.separateProcess())]);
  await f.settle(f.separateProcess());
  assert.equal(f.deliveries.filter(row => row.text.includes(reportPath)).length, 1);
  assert.equal(f.store.resultNotices.list()[0].state, 'delivered');
});

test('[result-notice-durability] an address reused by a new run cannot receive an old result', async t => {
  const { f, accept, recipient, reportPath } = await setup(t);
  assert.equal(accept(), true);
  f.finish(recipient);
  f.session(recipient.addressId);
  await f.settle(f.separateProcess());
  const notice = f.store.resultNotices.list()[0];
  assert.equal(notice.state, 'undelivered');
  assert.equal(notice.recipientRunId, recipient.runId);
  assert.match(notice.lastError ?? '', /not active/);
  assert.equal(f.deliveries.filter(row => row.text.includes(reportPath)).length, 0);
});

test('[result-notice-durability] pending content and ps visibility survive closure and session retention cleanup', async t => {
  const { f, state, accept, worker, reportPath } = await setup(t);
  assert.equal(accept(), true);
  f.accept(() => false);
  await f.settle();
  f.finish(f.getSession(worker.runId)!);
  state.cleanupCompleted('2100-01-01T00:00:00.000Z');
  assert.equal(f.getSession(worker.runId), undefined);
  const view = resultNoticeViews(f.store, []).find(row => row.runId === worker.runId);
  assert.equal(view?.state, 'finished');
  assert.equal(view?.resultNotice?.state, 'pending');
  assert.equal(view?.resultNotice?.recipient, 'observer');
  f.accept(() => true);
  await f.settle(f.separateProcess());
  const delivery = f.deliveries.find(row => row.accepted && row.text.includes(reportPath));
  assert.ok(delivery?.text.includes('Durable answer'));
});

test('[result-notice-durability] a rejected result transaction does not leave a notification behind', async t => {
  const { f, accept, worker } = await setup(t);
  f.sql("CREATE TRIGGER reject_notice_effect BEFORE INSERT ON pending_intents BEGIN SELECT RAISE(ABORT, 'reject effect'); END");
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  assert.throws(() => state.acceptWorkResult(worker.runId, { status: 'succeeded', response: 'Rolled back', proof: null }, {
    pending: [{ id: 'reject', runId: worker.runId, event: 'agent.succeeded', payload: {} }], domain: [],
  }), { errcode: 1811 });
  assert.equal(f.getSession(worker.runId)?.result, undefined);
  assert.deepEqual(f.store.resultNotices.list(), []);
  assert.equal(accept(), true);
  await f.settle();
  assert.equal(f.store.resultNotices.list()[0].state, 'delivered');
});

test('[result-notice-durability] migration from the prior database preserves sessions and accepts new notices', async t => {
  const { f, worker } = await setup(t);
  const legacy = migrationFixture(t);
  seedMain10(legacy, legacy.qaStatePath);
  const database = new DatabaseSync(legacy.qaStatePath);
  try {
    // Schema 10 adds only result_notices to schema 9; retain the historical tables.
    database.exec('DROP TABLE result_notices; PRAGMA user_version = 9');
    database.prepare('INSERT INTO sessions(run_id, address_id, state, finished_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run(worker.runId, worker.addressId, worker.state, null, JSON.stringify(f.getSession(worker.runId)));
  } finally { database.close(); }
  const handle = openStateStore(legacy.qaStatePath, { context: resolveStateContext(legacy.request()),
    transfer: { statePath: legacy.qaStatePath, fromVersion: 9, toVersion: STATE_SCHEMA_VERSION } });
  try {
    assert.deepEqual(handle.sessionRepository.transaction(tx => tx.getSession(worker.runId)), f.getSession(worker.runId));
    const state = createSessionState({ repository: handle.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
    assert.equal(state.acceptWorkResult(worker.runId, { status: 'failed', response: 'After migration', proof: null }, { pending: [], domain: [] }), true);
    assert.equal(handle.resultNotices.list().length, 1);
    assert.ok(handle.resultNotices.list()[0].text.includes('After migration'));
  } finally { handle.close(); }
});
