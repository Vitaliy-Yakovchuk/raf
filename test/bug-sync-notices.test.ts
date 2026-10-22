import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { noticeCandidates, noticeKey, type ServerBugKey, type ServerComment } from '../src/bug-store.ts';
import {
  ACTOR,
  canonical,
  CLAIM_OWNER,
  createBugHarness,
  detailOf,
  ETCHLY,
  serverKey,
  START,
  type BugHarness,
} from './bug-sync-fixture.ts';

const HUMAN = 'user:owner';

const comment = (id: string, authorId: string, authorKind: string): ServerComment => ({
  id, authorId, authorKind, text: `коментар ${id}`, replyTo: null, createdAt: START, payload: { id },
});

const problemOf = (h: BugHarness, key: ServerBugKey): string => h.server.state(key).problemId;
const bugNoticeKey = (h: BugHarness, key: ServerBugKey): string => `bug-new:${problemOf(h, key)}`;
const commentNoticeKey = (h: BugHarness, key: ServerBugKey, id: string): string => `bug-comment:${problemOf(h, key)}:${id}`;
const deliveredKeys = (h: BugHarness): string[] => [...h.notifier.delivered.keys()].sort();
const pendingKeys = (h: BugHarness): string[] => h.repo.pendingNotices().map((notice) => notice.noticeKey).sort();

async function synced(t: TestContext): Promise<{ h: BugHarness; known: ServerBugKey }> {
  const h = createBugHarness(t);
  const known = h.server.seedBug(ETCHLY, { rawId: '344', comments: [{ authorId: HUMAN, text: 'початковий' }] });
  await h.syncer.runCycle();
  assert.equal(h.repo.syncState(ETCHLY.sectionId).phase, 'incremental');
  assert.deepEqual(h.notifier.calls, []);
  return { h, known };
}

test('notice keys follow the bug and comment key format', () => {
  assert.equal(noticeKey('new-bug', 'problem-344', null), 'bug-new:problem-344');
  assert.equal(noticeKey('human-comment', 'problem-344', 'srv-c-7'), 'bug-comment:problem-344:srv-c-7');
});

test('notice candidates cover an unknown bug and only new comments of people', () => {
  const detail = detailOf(ETCHLY, '344', {
    problemId: 'problem-344',
    comments: [
      comment('c-1', HUMAN, 'person'),
      comment('c-2', 'user:qa', 'person'),
      comment('c-3', ACTOR, 'agent'),
      comment('c-4', CLAIM_OWNER, 'agent'),
      comment('c-5', 'dash', 'system'),
    ],
  });

  assert.deepEqual(noticeCandidates(new Set(['c-1']), detail), [
    { noticeKey: 'bug-comment:problem-344:c-2', kind: 'human-comment', commentServerId: 'c-2' },
  ]);
  assert.deepEqual(noticeCandidates(new Set(['c-1', 'c-2', 'c-3', 'c-4', 'c-5']), detail), []);
  assert.deepEqual(noticeCandidates(null, detailOf(ETCHLY, '345', { problemId: 'problem-345' })), [
    { noticeKey: 'bug-new:problem-345', kind: 'new-bug', commentServerId: null },
  ]);
});

test('incremental pull with a new bug and a new human comment sends one keyed notice for each', async (t) => {
  const { h, known } = await synced(t);
  const fresh = h.server.seedBug(ETCHLY, { rawId: '345' });
  const human = h.server.addComment(known, HUMAN, 'досі відтворюється');

  await h.syncer.runCycle();

  const bugKey = bugNoticeKey(h, fresh);
  const commentKey = commentNoticeKey(h, known, human.id);
  assert.deepEqual(deliveredKeys(h), [bugKey, commentKey].sort());
  assert.equal(h.notifier.calls.length, 2);
  assert.deepEqual(h.notifier.delivered.get(bugKey), { noticeKey: bugKey, kind: 'new-bug', bugKey: canonical(ETCHLY, '345'), commentId: null });
  assert.deepEqual(h.notifier.delivered.get(commentKey), {
    noticeKey: commentKey, kind: 'human-comment', bugKey: canonical(ETCHLY, '344'), commentId: human.id,
  });
  assert.deepEqual(h.repo.pendingNotices(), []);
});

test('a repeated pull batch does not create or deliver a second notice', async (t) => {
  const { h, known } = await synced(t);
  const fresh = h.server.seedBug(ETCHLY, { rawId: '345' });
  const human = h.server.addComment(known, HUMAN, 'новий');
  const expected = [bugNoticeKey(h, fresh), commentNoticeKey(h, known, human.id)].sort();
  const replay = (): void => {
    h.repo.applyPullBatch({
      sectionId: ETCHLY.sectionId, details: [h.server.detail(fresh), h.server.detail(known)], deleted: [], missing: [], position: {}, at: h.clock.iso(),
    });
  };

  replay();
  replay();
  assert.deepEqual(pendingKeys(h), expected);

  await h.syncer.runCycle();
  assert.deepEqual(deliveredKeys(h), expected);
  assert.equal(h.notifier.calls.length, 2);

  replay();
  await h.syncer.runCycle();
  assert.equal(h.notifier.calls.length, 2);
  assert.deepEqual(h.repo.pendingNotices(), []);
});

test('comments of the raf actor and of other agents do not notify main', async (t) => {
  const { h, known } = await synced(t);
  await h.writer.addComment({ bugKey: canonical(ETCHLY, '344'), text: 'синхронний коментар raf' });
  h.server.addComment(known, ACTOR, 'коментар raf з іншого процесу');
  h.server.addComment(known, CLAIM_OWNER, 'коментар іншого агента', 'agent');
  h.server.addComment(known, 'dash', 'системний запис', 'system');
  const human = h.server.addComment(known, HUMAN, 'коментар людини');

  await h.syncer.runCycle();

  assert.deepEqual(deliveredKeys(h), [commentNoticeKey(h, known, human.id)]);
  assert.equal(h.notifier.calls.length, 1);
});

test('initial sync, resync and changes without new bugs or human comments do not notify main', async (t) => {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, { rawId: '344', comments: [{ authorId: HUMAN, text: 'перший' }, { authorId: 'user:qa', text: 'другий' }] });
  h.server.seedBug(ETCHLY, { rawId: '345' });
  const erased = h.server.seedBug(ETCHLY, { rawId: '348' });

  await h.syncer.runCycle();
  assert.equal(h.repo.syncState(ETCHLY.sectionId).phase, 'incremental');
  assert.deepEqual(h.repo.pendingNotices(), []);

  const queries = h.server.callsOf('query').length;
  h.server.eraseBug(erased);
  h.server.seedBug(ETCHLY, { rawId: '346', comments: [{ authorId: HUMAN, text: 'під час resync' }] });
  h.server.addComment(serverKey(ETCHLY, '344'), HUMAN, 'теж під час resync');
  await h.syncer.runCycle();
  assert.ok(h.server.callsOf('query').length > queries, 'resync performed a snapshot');
  assert.equal(h.repo.findBug(canonical(ETCHLY, '346')).presence, 'present');
  assert.equal(h.repo.findBug(canonical(ETCHLY, '348')).presence, 'missing');
  assert.equal(h.repo.syncState(ETCHLY.sectionId).phase, 'incremental');
  assert.deepEqual(h.repo.pendingNotices(), []);

  h.server.setStatus(serverKey(ETCHLY, '345'), 'closed');
  await h.syncer.runCycle();
  assert.equal(h.repo.findBug(canonical(ETCHLY, '345')).status, 'closed');
  assert.deepEqual(h.notifier.calls, []);

  const fresh = h.server.seedBug(ETCHLY, { rawId: '347' });
  await h.syncer.runCycle();
  assert.deepEqual(deliveredKeys(h), [bugNoticeKey(h, fresh)]);
  assert.equal(h.notifier.calls.length, 1);
});

test('a refused delivery leaves the notice undelivered and the next cycle repeats it', async (t) => {
  const { h, known } = await synced(t);
  const fresh = h.server.seedBug(ETCHLY, { rawId: '345' });
  const human = h.server.addComment(known, HUMAN, 'новий');
  const expected = [bugNoticeKey(h, fresh), commentNoticeKey(h, known, human.id)].sort();
  h.notifier.failNext(2);

  await h.syncer.runCycle();
  assert.equal(h.notifier.calls.length, 2);
  assert.equal(h.notifier.delivered.size, 0);
  const pending = h.repo.pendingNotices();
  assert.deepEqual(pending.map((notice) => notice.noticeKey).sort(), expected);
  assert.ok(pending.every((notice) => notice.noticedAt === null));

  h.clock.advance(h.config.pollIntervalMs);
  await h.syncer.runCycle();
  assert.deepEqual(deliveredKeys(h), expected);
  assert.equal(h.notifier.calls.length, 4);
  assert.deepEqual(h.repo.pendingNotices(), []);

  await h.syncer.runCycle();
  assert.equal(h.notifier.calls.length, 4);
});

test('a service restart neither loses an undelivered notice nor repeats a delivered one', async (t) => {
  const { h, known } = await synced(t);
  const fresh = h.server.seedBug(ETCHLY, { rawId: '345' });
  const human = h.server.addComment(known, HUMAN, 'новий');
  const expected = [bugNoticeKey(h, fresh), commentNoticeKey(h, known, human.id)].sort();
  h.notifier.failNext(2);
  await h.syncer.runCycle();
  assert.deepEqual(pendingKeys(h), expected);

  h.reopen();
  await h.syncer.runCycle();
  assert.deepEqual(deliveredKeys(h), expected);
  assert.equal(h.notifier.calls.length, 4);

  h.reopen();
  await h.syncer.runCycle();
  assert.equal(h.notifier.calls.length, 4);
  assert.deepEqual(h.repo.pendingNotices(), []);
});
