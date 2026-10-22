import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  BUG_STORE_SCHEMA_VERSION,
  BugStoreError,
  formatCanonicalBugKey,
  openBugStore,
  parseCanonicalBugKey,
  resolveBugStorePath,
  type BugRepository,
} from '../src/bug-store.ts';
import { openStateStore } from '../src/state-store.ts';
import { canonical, createBugHarness, detailOf, ETCHLY, ETCHLY_DEV, RAMUS, START } from './bug-sync-fixture.ts';

const BUG_TABLES = ['attachments', 'bugs', 'comments', 'conflicts', 'outbox', 'sections', 'sync_state'];

const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);

const seed = (repo: BugRepository, rawId: string, revision = 3): void => {
  repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detailOf(ETCHLY, rawId, { revision })], deleted: [], missing: [], position: {}, at: START });
};

const storeError = (code: string) => (error: unknown): boolean => error instanceof BugStoreError && error.code === code;

test('bugs.sqlite is a separate database with its own schema version and pragmas', (t) => {
  const h = createBugHarness(t);
  const state = openStateStore(join(h.dir, 'state.sqlite'));
  state.close();

  assert.equal(BUG_STORE_SCHEMA_VERSION, 1);
  assert.equal(h.repo.schemaVersion(), BUG_STORE_SCHEMA_VERSION);
  assert.equal(h.repo.path, h.path);
  assert.equal((h.repo.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal((h.repo.database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 2);
  const attached = (h.repo.database.prepare('PRAGMA database_list').all() as { name: string }[]).map((row) => row.name).filter((name) => name !== 'main' && name !== 'temp');
  assert.deepEqual(attached, []);

  const bugs = new DatabaseSync(h.path, { readOnly: true });
  const stateDb = new DatabaseSync(join(h.dir, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal((bugs.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    assert.equal((bugs.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.deepEqual(tables(bugs).filter((name) => BUG_TABLES.includes(name)), BUG_TABLES);
    assert.deepEqual(tables(stateDb).filter((name) => BUG_TABLES.includes(name)), []);
  } finally {
    bugs.close();
    stateDb.close();
  }
});

test('attachments schema holds metadata and cache index without bytes', (t) => {
  const h = createBugHarness(t);
  const columns = (h.repo.database.prepare('PRAGMA table_info(attachments)').all() as { name: string }[]).map((row) => row.name);
  for (const column of ['attachment_pk', 'bug_pk', 'comment_pk', 'server_id', 'kind', 'mime', 'bytes', 'sha256', 'presence', 'cache_state', 'cache_file', 'cache_bytes', 'cache_sha256', 'last_read_at', 'fetch_owner', 'fetch_started_at']) {
    assert.ok(columns.includes(column), `attachments.${column}`);
  }
});

test('opening a bugs.sqlite with a newer schema version fails without changing it', (t) => {
  const h = createBugHarness(t);
  h.close();
  const raw = new DatabaseSync(h.path);
  raw.exec(`PRAGMA user_version = ${BUG_STORE_SCHEMA_VERSION + 1}`);
  raw.close();

  assert.throws(() => openBugStore(h.path), storeError('unsupported-version'));
  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, BUG_STORE_SCHEMA_VERSION + 1);
  } finally {
    check.close();
  }
  const restored = new DatabaseSync(h.path);
  restored.exec(`PRAGMA user_version = ${BUG_STORE_SCHEMA_VERSION}`);
  restored.close();
  h.reopen();
});

test('reopening bugs.sqlite keeps sections and sync state', (t) => {
  const h = createBugHarness(t, { sections: [ETCHLY, RAMUS] });
  h.repo.recordSyncFailure(ETCHLY.sectionId, 'unavailable', START);
  h.reopen();

  assert.deepEqual(h.repo.sections().map((section) => section.sectionId).sort(), [ETCHLY.sectionId, RAMUS.sectionId].sort());
  const state = h.repo.syncState(ETCHLY.sectionId);
  assert.equal(state.lastErrorCode, 'unavailable');
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.snapshotComplete, false);
  assert.equal(state.journalCursor, '0');
});

test('bug store path stays inside raf home', () => {
  assert.equal(resolveBugStorePath('/home/u/.raf', 'bugs.sqlite'), join('/home/u/.raf', 'bugs.sqlite'));
  for (const unsafe of ['', '../bugs.sqlite', '/etc/bugs.sqlite', 'a/../../bugs.sqlite']) {
    assert.throws(() => resolveBugStorePath('/home/u/.raf', unsafe), storeError('unsafe-path'), unsafe);
  }
});

test('canonical bug keys round-trip and reject malformed input', () => {
  assert.deepEqual(parseCanonicalBugKey('projects/etchly/bug#344'), { canonicalProject: 'projects/etchly', rawId: '344' });
  assert.equal(formatCanonicalBugKey({ canonicalProject: 'projects/etchly', rawId: '344' }), 'projects/etchly/bug#344');
  for (const bad of ['etchly#344', 'projects/etchly/bug#', 'projects/etchly/344', '']) {
    assert.throws(() => parseCanonicalBugKey(bad), storeError('invalid-bug-key'), bad);
  }
});

test('the same raw id in two projects keeps distinct keys and comments', (t) => {
  const h = createBugHarness(t, { sections: [ETCHLY, RAMUS] });
  const comment = (id: string, text: string) => ({ id, authorId: 'human', authorKind: 'human', text, replyTo: null, createdAt: START, payload: {} });
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detailOf(ETCHLY, '344', { comments: [comment('c-1', 'etchly text')] })], deleted: [], missing: [], position: {}, at: START });
  h.repo.applyPullBatch({ sectionId: RAMUS.sectionId, details: [detailOf(RAMUS, '344', { comments: [comment('c-1', 'ramus text')] })], deleted: [], missing: [], position: {}, at: START });

  assert.deepEqual(h.visibleTexts(canonical(ETCHLY, '344')), ['etchly text']);
  assert.deepEqual(h.visibleTexts(canonical(RAMUS, '344')), ['ramus text']);
  assert.equal(h.repo.findBug(canonical(ETCHLY, '344')).sectionId, ETCHLY.sectionId);
});

test('a raw id shared by two sections of one project is ambiguous', (t) => {
  const h = createBugHarness(t, { sections: [ETCHLY, ETCHLY_DEV] });
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detailOf(ETCHLY, '7')], deleted: [], missing: [], position: {}, at: START });
  h.repo.applyPullBatch({ sectionId: ETCHLY_DEV.sectionId, details: [detailOf(ETCHLY_DEV, '7')], deleted: [], missing: [], position: {}, at: START });

  assert.throws(() => h.repo.findBug('projects/etchly/bug#7'), (error: unknown) => {
    assert.ok(error instanceof BugStoreError);
    assert.equal(error.code, 'ambiguous-bug');
    assert.equal((error.details.candidates as unknown[]).length, 2);
    return true;
  });
  assert.throws(() => h.repo.findBug('projects/etchly/bug#8'), storeError('bug-not-found'));
});

test('a local comment and its outbox operation are committed together', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344', 3);
  const key = canonical(ETCHLY, '344');

  const receipt = h.addComment(key, 'Перевірено локально');

  assert.equal(receipt.state, 'pending');
  assert.equal(receipt.delivered, false);
  assert.equal(receipt.bugKey, key);
  assert.equal(receipt.expectedRevision, 3);
  assert.match(receipt.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const outbox = h.repo.outbox(receipt.operationId);
  assert.ok(outbox);
  assert.equal(outbox.state, 'pending');
  assert.equal(outbox.kind, 'comment.add');
  assert.equal(outbox.commentPk, receipt.commentPk);
  assert.equal(outbox.claimsFingerprint, h.claims.fingerprint(ETCHLY, 'write'));
  assert.deepEqual(JSON.parse(outbox.requestJson), { operation_id: receipt.operationId, expected_revision: 3, text: 'Перевірено локально' });
  const [comment] = h.repo.findBug(key).comments;
  assert.ok(comment);
  assert.equal(comment.origin, 'local');
  assert.equal(comment.serverId, null);
  assert.equal(comment.text, 'Перевірено локально');
  assert.equal(comment.delivery?.operationId, receipt.operationId);
  assert.equal(comment.delivery?.state, 'pending');
  const summary = h.repo.listBugs({ limit: 10 }).bugs.find((bug) => bug.key === key);
  assert.equal(summary?.pendingOperations, 1);
});

test('a failure before the outbox insert leaves neither comment nor operation', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344');
  h.reopen({
    beforeOutboxInsert: () => {
      throw new Error('disk full');
    },
  });
  const key = canonical(ETCHLY, '344');

  assert.throws(() => h.addComment(key, 'не має залишитись'), /disk full/);

  h.reopen();
  assert.deepEqual(h.visibleTexts(key), []);
  assert.deepEqual(h.repo.listOutbox(), []);
});

test('comments are rejected for unknown bugs and empty text without writing rows', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344');

  assert.throws(() => h.addComment(canonical(ETCHLY, '999'), 'text'), storeError('bug-not-found'));
  assert.throws(() => h.addComment(canonical(ETCHLY, '344'), '   '), storeError('invalid-comment'));
  assert.deepEqual(h.repo.listOutbox(), []);
  assert.deepEqual(h.visibleTexts(canonical(ETCHLY, '344')), []);
});

test('a pending comment survives restart and an interrupted send becomes unknown', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344');
  const key = canonical(ETCHLY, '344');
  const receipt = h.addComment(key, 'переживе рестарт');
  const before = h.repo.outbox(receipt.operationId)!;
  assert.equal(h.repo.markSending(receipt.operationId, START), true);

  h.reopen();

  assert.equal(h.repo.outbox(receipt.operationId)?.state, 'sending');
  assert.equal(h.repo.recoverInterruptedSends(START), 1);
  const after = h.repo.outbox(receipt.operationId)!;
  assert.equal(after.state, 'unknown');
  assert.equal(after.operationId, before.operationId);
  assert.equal(after.requestJson, before.requestJson);
  assert.deepEqual(h.visibleTexts(key), ['переживе рестарт']);
  assert.ok(existsSync(h.path));
});

test('an operation can be claimed for sending only once', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344');
  const receipt = h.addComment(canonical(ETCHLY, '344'), 'один раз');

  assert.equal(h.repo.markSending(receipt.operationId, START), true);
  assert.equal(h.repo.markSending(receipt.operationId, START), false);
  assert.throws(() => h.repo.markSending('00000000-0000-4000-8000-000000000000', START), storeError('operation-not-found'));
});

test('due operations follow next attempt time and skip conflicts and in-flight sends', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344');
  seed(h.repo, '345');
  seed(h.repo, '346');
  const later = h.addComment(canonical(ETCHLY, '344'), 'пізніше');
  const conflicted = h.addComment(canonical(ETCHLY, '345'), 'конфлікт');
  const inFlight = h.addComment(canonical(ETCHLY, '346'), 'в дорозі');
  h.repo.markSending(later.operationId, START);
  h.repo.markUnknown(later.operationId, { status: null, code: 'network', nextAttemptAt: '2026-10-22T10:00:05.000Z', at: START });
  h.repo.markConflict(conflicted.operationId, { kind: 'conflict-409', observed: { revision: 9 }, status: 409, at: START });
  h.repo.markSending(inFlight.operationId, START);

  assert.deepEqual(h.repo.dueOperations(START).map((op) => op.operationId), []);
  assert.deepEqual(h.repo.dueOperations('2026-10-22T10:00:05.000Z').map((op) => op.operationId), [later.operationId]);
  assert.equal(h.repo.outbox(later.operationId)?.attempts, 1);
  assert.equal(h.repo.outbox(later.operationId)?.lastErrorCode, 'network');
  assert.equal(h.repo.outbox(conflicted.operationId)?.state, 'conflict');
});

test('a conflict keeps the text and operation and gets an idempotent notice key', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344');
  const key = canonical(ETCHLY, '344');
  const receipt = h.addComment(key, 'збережи мене');

  const first = h.repo.markConflict(receipt.operationId, { kind: 'bug-deleted', observed: { deleted: true }, status: null, at: START });
  const again = h.repo.markConflict(receipt.operationId, { kind: 'bug-deleted', observed: { deleted: true }, status: null, at: START });

  assert.equal(first.noticeKey, `bug-conflict:${receipt.operationId}:bug-deleted`);
  assert.equal(again.noticeKey, first.noticeKey);
  assert.equal(h.repo.conflicts().length, 1);
  assert.deepEqual(h.repo.pendingNotices().map((notice) => notice.noticeKey), [first.noticeKey]);
  h.repo.markNoticed(first.noticeKey, START);
  assert.deepEqual(h.repo.pendingNotices(), []);
  assert.equal(h.repo.conflicts()[0]?.noticedAt, START);
  assert.deepEqual(h.visibleTexts(key), ['збережи мене']);
  assert.equal(h.repo.findBug(key).comments[0]?.delivery?.conflict, 'bug-deleted');
  assert.ok(h.repo.outbox(receipt.operationId));
});
