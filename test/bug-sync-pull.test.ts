import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BugStoreError } from '../src/bug-store.ts';
import { BugServerError, ClaimsError, type DetailPageRequest } from '../src/bug-sync.ts';
import {
  accessDenied,
  canonical,
  createBugHarness,
  ETCHLY,
  networkDown,
  RAMUS,
  unauthenticated,
  unavailable,
  type BugHarness,
} from './bug-sync-fixture.ts';

const seedFive = (h: BugHarness): void => {
  for (const rawId of ['101', '102', '103', '104', '105']) {
    h.server.seedBug(ETCHLY, { rawId, comments: [{ authorId: 'human', text: `коментар ${rawId}` }] });
  }
};

const keys = (h: BugHarness): string[] => h.repo.listBugs({ limit: 50 }).bugs.map((bug) => bug.key).sort();

test('initial sync takes the journal head first and follows list and detail cursors to the end', async (t) => {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, {
    rawId: '344',
    comments: [
      { authorId: 'human', text: 'перший' },
      { authorId: 'human', text: 'другий' },
      { authorId: 'human', text: 'третій' },
    ],
    attachments: [
      { id: 'a-1', bytes: 10, sha256: 'a'.repeat(64) },
      { id: 'a-2', commentIndex: 1, bytes: 20, sha256: 'b'.repeat(64) },
      { id: 'a-3', bytes: 30, sha256: 'c'.repeat(64) },
    ],
  });
  h.server.seedBug(ETCHLY, { rawId: '345' });
  h.server.seedBug(ETCHLY, { rawId: '346' });

  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.equal(outcome.errorCode, null);
  assert.equal(outcome.snapshotComplete, true);
  assert.equal(outcome.phase, 'incremental');
  const state = h.repo.syncState(ETCHLY.sectionId);
  assert.equal(state.journalCursor, h.server.head(ETCHLY));
  assert.equal(state.snapshotComplete, true);
  assert.equal(state.listCursor, null);
  assert.equal(state.lastErrorCode, null);
  assert.equal(state.consecutiveFailures, 0);
  assert.notEqual(state.lastSuccessAt, null);
  assert.equal(h.server.calls[0]?.method, 'events');
  assert.deepEqual(h.server.calls[0]?.input, { cursor: '0', limit: h.config.pageLimit });
  const firstQuery = h.server.calls.findIndex((call) => call.method === 'query');
  const lastEvents = h.server.calls.map((call) => call.method).lastIndexOf('events');
  assert.ok(lastEvents < firstQuery, 'journal head is fixed before the snapshot');
  assert.ok(h.server.callsOf('query').every((call) => (call.input as { limit: number }).limit === h.config.pageLimit));
  assert.ok(h.server.callsOf('read').some((call) => (call.input as DetailPageRequest).commentsCursor !== null));
  assert.deepEqual(keys(h), ['344', '345', '346'].map((id) => canonical(ETCHLY, id)));
  const bug = h.repo.findBug(canonical(ETCHLY, '344'));
  assert.deepEqual(bug.comments.map((comment) => comment.text), ['перший', 'другий', 'третій']);
  assert.ok(bug.comments.every((comment) => comment.origin === 'server' && comment.serverId !== null && comment.delivery === null));
  assert.equal(bug.detailComplete, true);
  assert.equal(bug.presence, 'present');
  assert.deepEqual(bug.attachments.map((attachment) => attachment.serverId).sort(), ['a-1', 'a-2', 'a-3']);
  assert.ok(bug.attachments.every((attachment) => attachment.cacheState === 'absent'));
  assert.equal(bug.attachments.find((attachment) => attachment.serverId === 'a-2')?.commentServerId, bug.comments[1]?.serverId);
});

test('a snapshot interrupted between pages resumes from the saved list cursor', async (t) => {
  const h = createBugHarness(t);
  seedFive(h);
  h.server.failNext('read', unavailable(), (key) => key?.rawId === '103');

  const failed = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.notEqual(failed.errorCode, null);
  assert.equal(failed.snapshotComplete, false);
  const partial = h.repo.syncState(ETCHLY.sectionId);
  assert.equal(partial.snapshotComplete, false);
  assert.notEqual(partial.listCursor, null);
  assert.notEqual(partial.lastErrorCode, null);
  assert.equal(partial.consecutiveFailures, 1);
  assert.deepEqual(keys(h), ['101', '102'].map((id) => canonical(ETCHLY, id)));
  assert.equal(h.repo.listBugs({ limit: 50 }).sync.find((sync) => sync.sectionId === ETCHLY.sectionId)?.snapshotComplete, false);
  const savedCursor = partial.listCursor;
  const before = h.server.calls.length;

  const resumed = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.equal(resumed.errorCode, null);
  assert.equal(resumed.snapshotComplete, true);
  const firstQuery = h.server.calls.slice(before).find((call) => call.method === 'query');
  assert.equal((firstQuery?.input as { cursor: string | null }).cursor, savedCursor);
  assert.deepEqual(keys(h), ['101', '102', '103', '104', '105'].map((id) => canonical(ETCHLY, id)));
  for (const id of ['101', '102', '103', '104', '105']) assert.deepEqual(h.visibleTexts(canonical(ETCHLY, id)), [`коментар ${id}`]);
  assert.equal(h.repo.syncState(ETCHLY.sectionId).consecutiveFailures, 0);
});

test('incremental pull applies journal changes and stores the new cursor', async (t) => {
  const h = createBugHarness(t);
  const a = h.server.seedBug(ETCHLY, { rawId: '344' });
  const b = h.server.seedBug(ETCHLY, { rawId: '345' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  h.server.addComment(a, 'human', 'нове');
  h.server.setStatus(b, 'closed');
  h.server.seedBug(ETCHLY, { rawId: '346' });
  const before = h.server.calls.length;

  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.equal(outcome.errorCode, null);
  assert.equal(h.server.calls.slice(before).filter((call) => call.method === 'query').length, 0);
  assert.deepEqual(h.visibleTexts(canonical(ETCHLY, '344')), ['нове']);
  assert.equal(h.repo.findBug(canonical(ETCHLY, '345')).status, 'closed');
  assert.equal(h.repo.findBug(canonical(ETCHLY, '345')).revision, 2);
  assert.equal(h.repo.findBug(canonical(ETCHLY, '346')).presence, 'present');
  assert.equal(h.repo.syncState(ETCHLY.sectionId).journalCursor, h.server.head(ETCHLY));
});

test('a journal page delivered again after a failure is applied without duplicates', async (t) => {
  const h = createBugHarness(t);
  const a = h.server.seedBug(ETCHLY, { rawId: '344' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  const cursor = h.repo.syncState(ETCHLY.sectionId).journalCursor;
  h.server.addComment(a, 'human', 'один');
  h.server.addComment(a, 'human', 'два');
  h.server.failNext('read', networkDown());

  const failed = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.notEqual(failed.errorCode, null);
  assert.equal(h.repo.syncState(ETCHLY.sectionId).journalCursor, cursor);
  await h.syncer.pullSection(ETCHLY.sectionId);
  await h.syncer.pullSection(ETCHLY.sectionId);
  assert.deepEqual(h.visibleTexts(canonical(ETCHLY, '344')), ['один', 'два']);

  const detail = h.server.detail(a);
  h.repo.applyPullBatch({ sectionId: ETCHLY.sectionId, details: [detail, detail], deleted: [], missing: [], position: {}, at: h.clock.iso() });
  assert.deepEqual(h.visibleTexts(canonical(ETCHLY, '344')), ['один', 'два']);
});

test('server removal of a comment or bug without pending work removes local rows', async (t) => {
  const h = createBugHarness(t);
  const a = h.server.seedBug(ETCHLY, { rawId: '344', comments: [{ authorId: 'human', text: 'прибрати' }, { authorId: 'human', text: 'лишити' }] });
  const b = h.server.seedBug(ETCHLY, { rawId: '345' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  h.server.hideComment(a, h.server.serverComments(a)[0]!.id);
  h.server.deleteBug(b);

  await h.syncer.pullSection(ETCHLY.sectionId);

  assert.deepEqual(h.visibleTexts(canonical(ETCHLY, '344')), ['лишити']);
  assert.throws(() => h.repo.findBug(canonical(ETCHLY, '345')), (error: unknown) => error instanceof BugStoreError && error.code === 'bug-not-found');
  assert.deepEqual(h.repo.conflicts(), []);
  assert.deepEqual(h.notifier.calls, []);
});

test('server deletion of a bug with a pending comment keeps the text and shows the conflict to main', async (t) => {
  const h = createBugHarness(t);
  const b = h.server.seedBug(ETCHLY, { rawId: '345' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  const key = canonical(ETCHLY, '345');
  const receipt = h.addComment(key, 'текст, який не можна втратити');
  h.server.deleteBug(b);

  await h.syncer.pullSection(ETCHLY.sectionId);

  const bug = h.repo.findBug(key);
  assert.equal(bug.presence, 'deleted');
  assert.deepEqual(bug.comments.map((comment) => comment.text), ['текст, який не можна втратити']);
  assert.equal(bug.comments[0]?.delivery?.operationId, receipt.operationId);
  assert.equal(bug.comments[0]?.delivery?.conflict, 'bug-deleted');
  assert.notEqual(bug.comments[0]?.delivery?.state, 'delivered');
  assert.ok(h.repo.outbox(receipt.operationId));
  const noticeKey = `bug-conflict:${receipt.operationId}:bug-deleted`;
  assert.deepEqual(h.repo.conflicts().map((item) => [item.kind, item.noticeKey]), [['bug-deleted', noticeKey]]);
  assert.equal(h.notifier.delivered.size, 1);
  const notice = h.notifier.delivered.get(noticeKey);
  assert.equal(notice?.bugKey, key);
  assert.equal(notice?.operationId, receipt.operationId);
  assert.equal(notice?.kind, 'bug-deleted');
  assert.equal(notice?.text, 'текст, який не можна втратити');
  assert.notEqual(h.repo.conflicts()[0]?.noticedAt, null);
  assert.equal(h.repo.listBugs({ limit: 50 }).bugs.find((item) => item.key === key)?.conflicts, 1);

  h.clock.advance(h.config.retry.maxDelayMs);
  await h.syncer.pushDue();
  await h.syncer.pullSection(ETCHLY.sectionId);

  assert.deepEqual(h.server.commentRequests, []);
  assert.equal(h.notifier.calls.length, 1);
  assert.deepEqual(h.visibleTexts(key), ['текст, який не можна втратити']);
});

test('a pending comment is never overwritten by server state', async (t) => {
  const h = createBugHarness(t);
  const a = h.server.seedBug(ETCHLY, { rawId: '344' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  const key = canonical(ETCHLY, '344');
  const receipt = h.addComment(key, 'локальний');
  h.server.addComment(a, 'human', 'серверний');
  h.server.setStatus(a, 'in_progress');

  await h.syncer.pullSection(ETCHLY.sectionId);

  const bug = h.repo.findBug(key);
  assert.equal(bug.status, 'in_progress');
  assert.deepEqual(bug.comments.map((comment) => comment.text).sort(), ['локальний', 'серверний'].sort());
  const local = bug.comments.find((comment) => comment.origin === 'local');
  assert.equal(local?.delivery?.operationId, receipt.operationId);
  assert.equal(local?.delivery?.state, 'pending');
  assert.equal(h.repo.outbox(receipt.operationId)?.requestJson, JSON.stringify({ operation_id: receipt.operationId, expected_revision: 1, text: 'локальний' }));
});

test('an invalid saved journal cursor triggers a resync that marks vanished bugs missing', async (t) => {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, { rawId: '344' });
  const gone = h.server.seedBug(ETCHLY, { rawId: '345' });
  const erased = h.server.seedBug(ETCHLY, { rawId: '346' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  const pendingKey = canonical(ETCHLY, '345');
  const receipt = h.addComment(pendingKey, 'чекає main');
  h.server.addComment(erased, 'human', 'останній');
  await h.syncer.pullSection(ETCHLY.sectionId);
  h.server.eraseBug(gone);
  h.server.eraseBug(erased);

  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.equal(outcome.errorCode, null);
  assert.equal(outcome.snapshotComplete, true);
  assert.ok(h.server.callsOf('query').length >= 2, 'resync performs a full snapshot');
  assert.equal(h.repo.findBug(canonical(ETCHLY, '344')).presence, 'present');
  assert.equal(h.repo.findBug(canonical(ETCHLY, '346')).presence, 'missing');
  const pending = h.repo.findBug(pendingKey);
  assert.equal(pending.presence, 'missing');
  assert.deepEqual(pending.comments.map((comment) => comment.text), ['чекає main']);
  assert.deepEqual(h.repo.conflicts().map((item) => [item.operationId, item.kind]), [[receipt.operationId, 'bug-missing']]);
  assert.ok(h.notifier.delivered.has(`bug-conflict:${receipt.operationId}:bug-missing`));
  assert.equal(h.repo.syncState(ETCHLY.sectionId).journalCursor, h.server.head(ETCHLY));
});

test('an invalid saved list cursor restarts the snapshot from the first page', async (t) => {
  const h = createBugHarness(t);
  seedFive(h);
  h.server.failNext('read', unavailable(), (key) => key?.rawId === '103');
  await h.syncer.pullSection(ETCHLY.sectionId);
  h.server.invalidateListCursors();
  const before = h.server.calls.length;

  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.equal(outcome.errorCode, null);
  assert.equal(outcome.snapshotComplete, true);
  const cursors = h.server.calls.slice(before).filter((call) => call.method === 'query').map((call) => (call.input as { cursor: string | null }).cursor);
  assert.ok(cursors.includes(null), 'snapshot restarted from the first page');
  assert.deepEqual(keys(h), ['101', '102', '103', '104', '105'].map((id) => canonical(ETCHLY, id)));
});

test('changed claims restart the snapshot instead of reusing a cursor signed for other claims', async (t) => {
  const h = createBugHarness(t);
  seedFive(h);
  h.server.failNext('read', unavailable(), (key) => key?.rawId === '103');
  await h.syncer.pullSection(ETCHLY.sectionId);
  h.claims.setVersion(2);
  const before = h.server.calls.length;

  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.equal(outcome.errorCode, null);
  const first = h.server.calls.slice(before).find((call) => call.method === 'query');
  assert.equal((first?.input as { cursor: string | null }).cursor, null);
  assert.equal(h.repo.syncState(ETCHLY.sectionId).listClaimsFingerprint === h.claims.fingerprint(ETCHLY, 'read') || h.repo.syncState(ETCHLY.sectionId).listCursor === null, true);
  assert.equal(keys(h).length, 5);
});

for (const [name, error] of [['401', unauthenticated()], ['403', accessDenied()]] as const) {
  test(`access error ${name} is recorded as a section failure and never as success`, async (t) => {
    const h = createBugHarness(t);
    h.server.seedBug(ETCHLY, { rawId: '344' });
    h.server.failNext('events', error);

    const outcome = await h.syncer.pullSection(ETCHLY.sectionId);

    assert.equal(outcome.errorCode, (error as BugServerError).code);
    assert.equal(outcome.snapshotComplete, false);
    const state = h.repo.syncState(ETCHLY.sectionId);
    assert.equal(state.lastErrorCode, (error as BugServerError).code);
    assert.equal(state.lastSuccessAt, null);
    assert.equal(state.consecutiveFailures, 1);
    assert.equal(state.snapshotComplete, false);
    assert.deepEqual(keys(h), []);
  });
}

test('a missing section secret stops the section before any network call', async (t) => {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, { rawId: '344' });
  h.claims.issueError = new ClaimsError('secret-missing', ETCHLY.sectionId, 'secret DASH_BUGS_PROD_ETCHLY is missing');

  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);

  assert.equal(outcome.errorCode, 'secret-missing');
  assert.deepEqual(h.server.calls, []);
  assert.equal(h.repo.syncState(ETCHLY.sectionId).lastErrorCode, 'secret-missing');
});

test('an unreadable bug detail keeps the previous copy as incomplete and other bugs continue', async (t) => {
  const h = createBugHarness(t);
  const a = h.server.seedBug(ETCHLY, { rawId: '344', comments: [{ authorId: 'human', text: 'попередній' }] });
  const b = h.server.seedBug(ETCHLY, { rawId: '345' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  h.server.addComment(a, 'human', 'завеликий');
  h.server.setStatus(b, 'closed');
  h.server.failNext('read', new BugServerError(409, 'legacy-evidence-unavailable', 'omitted'), (key) => key?.rawId === '344');

  await h.syncer.pullSection(ETCHLY.sectionId);

  const bug = h.repo.findBug(canonical(ETCHLY, '344'));
  assert.equal(bug.detailComplete, false);
  assert.equal(bug.detailErrorCode, 'legacy-evidence-unavailable');
  assert.deepEqual(bug.comments.map((comment) => comment.text), ['попередній']);
  assert.equal(h.repo.findBug(canonical(ETCHLY, '345')).status, 'closed');
});

test('sections are synchronized independently', async (t) => {
  const h = createBugHarness(t, { sections: [ETCHLY, RAMUS] });
  h.server.seedBug(ETCHLY, { rawId: '344', comments: [{ authorId: 'human', text: 'etchly' }] });
  h.server.seedBug(RAMUS, { rawId: '344', comments: [{ authorId: 'human', text: 'ramus' }] });
  h.server.failNext('events', unavailable(), () => true);

  const failed = await h.syncer.pullSection(ETCHLY.sectionId);
  const ok = await h.syncer.pullSection(RAMUS.sectionId);

  assert.notEqual(failed.errorCode, null);
  assert.equal(ok.errorCode, null);
  assert.deepEqual(h.visibleTexts(canonical(RAMUS, '344')), ['ramus']);
  assert.throws(() => h.repo.findBug(canonical(ETCHLY, '344')), (error: unknown) => error instanceof BugStoreError && error.code === 'bug-not-found');
  assert.ok(h.server.calls.every((call) => call.auth.project === call.key?.project || call.key === null));
});

test('a cycle syncs conf sections and a section without its secret fails visibly while others succeed', async (t) => {
  const h = createBugHarness(t, { sections: [ETCHLY, RAMUS] });
  h.server.seedBug(ETCHLY, { rawId: '344' });
  h.server.seedBug(RAMUS, { rawId: '345' });
  h.claims.missingSecrets.add(ETCHLY.sectionId);

  await h.syncer.runCycle();

  assert.ok(h.server.calls.length > 0);
  assert.ok(h.server.calls.every((call) => call.auth.project === RAMUS.project));
  assert.equal(h.repo.syncState(ETCHLY.sectionId).lastErrorCode, 'secret-missing');
  assert.equal(h.repo.syncState(ETCHLY.sectionId).snapshotComplete, false);
  assert.equal(h.repo.syncState(ETCHLY.sectionId).lastSuccessAt, null);
  assert.equal(h.repo.syncState(RAMUS.sectionId).snapshotComplete, true);
  assert.equal(h.repo.findBug(canonical(RAMUS, '345')).presence, 'present');
});
