import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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
import { ACTOR, canonical, createBugHarness, detailOf, ETCHLY, ETCHLY_DEV, RAMUS, START, type BugHarness } from './bug-sync-fixture.ts';
import { createV1BugDatabase } from './bug-store-v1-fixture.ts';

const BUG_TABLES = ['attachments', 'bugs', 'comments', 'notices', 'sections', 'sync_state'];
const REMOVED_TABLES = ['conflicts', 'outbox'];

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

  assert.equal(BUG_STORE_SCHEMA_VERSION, 2);
  assert.equal(h.repo.schemaVersion(), BUG_STORE_SCHEMA_VERSION);
  assert.equal(h.repo.path, h.path);
  assert.equal((h.repo.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal((h.repo.database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 2);
  const attached = (h.repo.database.prepare('PRAGMA database_list').all() as { name: string }[]).map((row) => row.name).filter((name) => name !== 'main' && name !== 'temp');
  assert.deepEqual(attached, []);

  const bugs = new DatabaseSync(h.path, { readOnly: true });
  const stateDb = new DatabaseSync(join(h.dir, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal((bugs.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    assert.equal((bugs.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.deepEqual(tables(bugs).filter((name) => BUG_TABLES.includes(name)), BUG_TABLES);
    assert.deepEqual(tables(bugs).filter((name) => REMOVED_TABLES.includes(name)), []);
    assert.deepEqual(tables(stateDb).filter((name) => [...BUG_TABLES, ...REMOVED_TABLES].includes(name)), []);
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

test('comments hold only server comments without outbox columns', (t) => {
  const h = createBugHarness(t);
  const columns = (h.repo.database.prepare('PRAGMA table_info(comments)').all() as { name: string; notnull: number }[]);
  const names = columns.map((column) => column.name);
  for (const removed of ['origin', 'operation_id', 'link_candidate_operation_id']) assert.ok(!names.includes(removed), `comments.${removed}`);
  assert.equal(columns.find((column) => column.name === 'server_id')?.notnull, 1);
  const triggers = h.repo.database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[];
  assert.deepEqual(triggers.filter((row) => row.name === 'outbox_request_immutable'), []);
});

const removeDatabase = (path: string): void => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
};

const V1_SEED = { sectionId: ETCHLY.sectionId, project: ETCHLY.project, env: ETCHLY.env, canonicalProject: ETCHLY.canonicalProject, rawId: '344', claimToken: 'v1-claim-token', at: START };

const dumpFile = (path: string): string => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify({ rows: tables(db).map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]), version: db.prepare('PRAGMA user_version').get() });
  } finally {
    db.close();
  }
};

test('a version 1 base with only delivered comments migrates to version 2 without losing server data', (t) => {
  const h = createBugHarness(t);
  h.close();
  removeDatabase(h.path);
  createV1BugDatabase(h.path, V1_SEED, [{ operationId: 'op-delivered', text: 'доставлений', state: 'delivered', serverId: 'srv-c-2' }]);

  h.reopen();

  assert.equal(h.repo.schemaVersion(), 2);
  assert.deepEqual(tables(h.repo.database).filter((name) => REMOVED_TABLES.includes(name)), []);
  assert.ok(tables(h.repo.database).includes('notices'));
  const bug = h.repo.findBug(canonical(ETCHLY, '344'));
  assert.equal(bug.revision, 4);
  assert.equal(bug.status, 'in_progress');
  assert.deepEqual(bug.comments.map((comment) => [comment.serverId, comment.text]), [['srv-c-1', 'серверний'], ['srv-c-2', 'доставлений']]);
  const stored = JSON.stringify(h.repo.database.prepare('SELECT payload FROM bugs').all()) + JSON.stringify(h.repo.database.prepare('SELECT payload FROM comments').all());
  assert.ok(!stored.includes('v1-claim-token'), 'claim_token is cut from stored payloads');
  const state = h.repo.syncState(ETCHLY.sectionId);
  assert.equal(state.journalCursor, '7');
  assert.equal(state.snapshotComplete, true);
});

for (const local of [
  { operationId: 'op-pending', text: 'ще не доставлено', state: 'pending' as const, serverId: null },
  { operationId: 'op-unknown', text: 'результат невідомий', state: 'unknown' as const, serverId: null },
  { operationId: 'op-conflict', text: 'конфлікт', state: 'conflict' as const, serverId: null },
]) {
  test(`migration refuses a version 1 base with an undelivered ${local.state} comment and changes nothing`, (t) => {
    const h = createBugHarness(t);
    h.close();
    removeDatabase(h.path);
    createV1BugDatabase(h.path, V1_SEED, [local]);
    const before = dumpFile(h.path);

    assert.throws(() => openBugStore(h.path), (error: unknown) => {
      assert.ok(error instanceof BugStoreError);
      assert.equal(error.code, 'undelivered-local-comments');
      const items = error.details.comments as { bugKey: string; text: string }[];
      assert.deepEqual(items.map((item) => [item.bugKey, item.text]), [[canonical(ETCHLY, '344'), local.text]]);
      return true;
    });
    assert.equal(dumpFile(h.path), before);
    removeDatabase(h.path);
    h.reopen();
  });
}

function writeHeader(revision: number, overrides: Record<string, unknown> = {}) {
  const detail = detailOf(ETCHLY, '344', { revision });
  return {
    key: detail.key, problemId: detail.problemId, revision, status: 'open', state: 'new', createdAt: START, claimedBy: null,
    payload: { description: 'bug 344', claim_token: 'secret-claim' }, ...overrides,
  };
}

const agentComment = (id: string, text: string) => ({ id, authorId: ACTOR, authorKind: 'agent', text, replyTo: null, createdAt: START, payload: { id, author_id: ACTOR, text } });
const humanComment = (id: string, text: string) => ({ id, authorId: 'human', authorKind: 'human', text, replyTo: null, createdAt: START, payload: { id } });

const storedPayloads = (h: BugHarness): string => JSON.stringify(h.repo.database.prepare('SELECT payload FROM bugs').all()) + JSON.stringify(h.repo.database.prepare('SELECT payload FROM comments').all());

test('a write receipt stores the server comment and bug state in one step without the claim token', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344', 3);
  const key = canonical(ETCHLY, '344');

  const view = h.repo.applyWriteReceipt({ bugKey: key, bug: writeHeader(4, { status: 'in_progress', claimedBy: ACTOR }), comment: agentComment('srv-c-9', 'від raf'), at: START });

  assert.equal(view.key, key);
  assert.equal(view.revision, 4);
  assert.equal(view.status, 'in_progress');
  assert.equal(view.claimedBy, ACTOR);
  assert.deepEqual(view.comments.map((comment) => [comment.serverId, comment.text, comment.authorId]), [['srv-c-9', 'від raf', ACTOR]]);
  assert.deepEqual(h.repo.findBug(key), view);
  assert.ok(!storedPayloads(h).includes('secret-claim'));
});

test('a status receipt without a comment updates only the bug state', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344', 3);
  const key = canonical(ETCHLY, '344');

  const view = h.repo.applyWriteReceipt({ bugKey: key, bug: writeHeader(4, { status: 'closed' }), comment: null, at: START });

  assert.equal(view.status, 'closed');
  assert.equal(view.revision, 4);
  assert.deepEqual(view.comments, []);
});

test('a receipt older than the local revision keeps the newer bug state but adds its comment once', (t) => {
  const h = createBugHarness(t);
  const key = canonical(ETCHLY, '344');
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detailOf(ETCHLY, '344', { revision: 6, status: 'closed', comments: [agentComment('srv-c-9', 'від raf'), humanComment('srv-c-10', 'пізніше')] })], deleted: [], missing: [], position: {}, at: START });

  const view = h.repo.applyWriteReceipt({ bugKey: key, bug: writeHeader(5, { status: 'in_progress' }), comment: agentComment('srv-c-9', 'від raf'), at: START });

  assert.equal(view.revision, 6);
  assert.equal(view.status, 'closed');
  assert.deepEqual(view.comments.map((comment) => comment.serverId), ['srv-c-9', 'srv-c-10']);
});

test('a receipt for a bug missing locally fails without writing', (t) => {
  const h = createBugHarness(t);
  seed(h.repo, '344', 3);

  assert.throws(() => h.repo.applyWriteReceipt({ bugKey: canonical(ETCHLY, '999'), bug: writeHeader(4), comment: agentComment('srv-c-9', 'нікуди'), at: START }), storeError('bug-not-found'));

  assert.deepEqual(h.repo.database.prepare('SELECT * FROM comments').all(), []);
  assert.equal(h.repo.findBug(canonical(ETCHLY, '344')).revision, 3);
});

test('a pulled detail older than the local revision does not roll back the bug, comments or attachments', (t) => {
  const h = createBugHarness(t);
  const key = canonical(ETCHLY, '344');
  const attachment = { id: 'a-1', commentId: null, kind: 'file', mime: 'text/plain', bytes: 10, sha256: 'a'.repeat(64) };
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detailOf(ETCHLY, '344', { revision: 5, status: 'closed', comments: [humanComment('srv-c-1', 'новий')], attachments: [attachment] })], deleted: [], missing: [], position: {}, at: START });
  const before = h.repo.findBug(key);

  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detailOf(ETCHLY, '344', { revision: 4, status: 'open' })], deleted: [], missing: [], position: { journalCursor: '9' }, at: START });

  const after = h.repo.findBug(key);
  assert.equal(after.revision, 5);
  assert.equal(after.status, 'closed');
  assert.deepEqual(after.comments, before.comments);
  assert.deepEqual(after.attachments, before.attachments);
  assert.equal(h.repo.syncState(ETCHLY.sectionId).journalCursor, '9', 'the journal cursor still advances');
});

test('a pulled detail with the same revision is idempotent and a newer one replaces the local state', (t) => {
  const h = createBugHarness(t);
  const key = canonical(ETCHLY, '344');
  const first = detailOf(ETCHLY, '344', { revision: 5, comments: [humanComment('srv-c-1', 'перший'), humanComment('srv-c-2', 'другий')] });
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [first], deleted: [], missing: [], position: {}, at: START });
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [first], deleted: [], missing: [], position: {}, at: START });
  assert.deepEqual(h.visibleTexts(key), ['перший', 'другий']);

  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detailOf(ETCHLY, '344', { revision: 6, status: 'closed', comments: [humanComment('srv-c-2', 'другий')] })], deleted: [], missing: [], position: {}, at: START });

  assert.deepEqual(h.visibleTexts(key), ['другий']);
  assert.equal(h.repo.findBug(key).status, 'closed');
  assert.equal(h.repo.findBug(key).revision, 6);
});

test('a stale pull applied after a write receipt keeps the written comment until a newer pull', (t) => {
  const h = createBugHarness(t);
  const key = canonical(ETCHLY, '344');
  const stale = detailOf(ETCHLY, '344', { revision: 3, comments: [humanComment('srv-c-1', 'людина')] });
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [stale], deleted: [], missing: [], position: {}, at: START });
  h.repo.applyWriteReceipt({ bugKey: key, bug: writeHeader(4), comment: agentComment('srv-c-2', 'від raf'), at: START });

  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [stale], deleted: [], missing: [], position: {}, at: START });

  assert.equal(h.repo.findBug(key).revision, 4);
  assert.deepEqual(h.visibleTexts(key), ['людина', 'від raf']);
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detailOf(ETCHLY, '344', { revision: 4, comments: [humanComment('srv-c-1', 'людина'), agentComment('srv-c-2', 'від raf')] })], deleted: [], missing: [], position: {}, at: START });
  assert.deepEqual(h.visibleTexts(key), ['людина', 'від raf']);
  assert.equal(h.repo.database.prepare('SELECT COUNT(*) AS n FROM comments').get()!.n, 2);
});
