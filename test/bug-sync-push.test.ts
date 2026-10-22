import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  accessDenied,
  ACTOR,
  canonical,
  CLAIM_OWNER,
  conflict,
  createBugHarness,
  ETCHLY,
  networkDown,
  unauthenticated,
  unavailable,
  type BugHarness,
} from './bug-sync-fixture.ts';
import type { ServerBugKey } from '../src/bug-store.ts';

const KEY = canonical(ETCHLY, '344');

const ready = async (t: TestContext): Promise<{ h: BugHarness; server: ServerBugKey }> => {
  const h = createBugHarness(t);
  const server = h.server.seedBug(ETCHLY, { rawId: '344', comments: [{ authorId: 'human', text: 'опис' }] });
  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);
  assert.equal(outcome.errorCode, null);
  return { h, server };
};

const actorComments = (h: BugHarness, key: ServerBugKey, text: string) =>
  h.server.serverComments(key).filter((comment) => comment.authorId === ACTOR && comment.text === text);

test('a comment is accepted locally while offline and stays queued with its text', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'без мережі');
  h.server.failNext('comment', networkDown());

  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.operationId, receipt.operationId);
  assert.equal(outcome?.state, 'unknown');
  const op = h.repo.outbox(receipt.operationId)!;
  assert.equal(op.state, 'unknown');
  assert.equal(op.attempts, 1);
  assert.equal(op.lastErrorCode, 'network');
  assert.equal(op.nextAttemptAt, new Date(Date.parse(h.clock.iso()) + h.config.retry.initialDelayMs).toISOString());
  assert.deepEqual(h.visibleTexts(KEY), ['опис', 'без мережі']);
  assert.equal(h.repo.findBug(KEY).comments[1]?.delivery?.state, 'unknown');
  assert.deepEqual(actorComments(h, server, 'без мережі'), []);
});

test('a retry waits for backoff from conf and sends the identical request', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'повтор');
  const requestJson = h.repo.outbox(receipt.operationId)!.requestJson;
  h.server.failNext('comment', unavailable());
  await h.syncer.pushDue();

  assert.deepEqual(await h.syncer.pushDue(), []);
  assert.equal(h.server.commentRequests.length, 1);

  h.clock.advance(h.config.retry.initialDelayMs);
  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.state, 'confirmed');
  assert.equal(h.server.commentRequests.length, 2);
  assert.ok(h.server.commentRequests.every((request) => request.raw === requestJson));
  assert.ok(h.server.commentRequests.every((request) => request.body.operation_id === receipt.operationId));
  const [created] = actorComments(h, server, 'повтор');
  assert.ok(created);
  const local = h.repo.findBug(KEY).comments.filter((comment) => comment.text === 'повтор');
  assert.equal(local.length, 1);
  assert.equal(local[0]?.serverId, created.id);
  assert.equal(local[0]?.delivery, null);
  assert.equal(h.repo.outbox(receipt.operationId), undefined);
});

test('a lost response is replayed with the same operation and creates no duplicate', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'відповідь втрачено');
  h.server.loseNextResponse();

  const [lost] = await h.syncer.pushDue();

  assert.equal(lost?.state, 'unknown');
  assert.equal(h.server.mutations, 1);
  h.clock.advance(h.config.retry.initialDelayMs);
  const [replayed] = await h.syncer.pushDue();

  assert.equal(replayed?.state, 'confirmed');
  assert.equal(h.server.mutations, 1);
  assert.equal(h.server.commentRequests.length, 2);
  assert.equal(h.server.commentRequests[0]?.raw, h.server.commentRequests[1]?.raw);
  assert.equal(actorComments(h, server, 'відповідь втрачено').length, 1);
  const local = h.repo.findBug(KEY).comments.filter((comment) => comment.text === 'відповідь втрачено');
  assert.equal(local.length, 1);
  assert.equal(local[0]?.serverId, actorComments(h, server, 'відповідь втрачено')[0]?.id);
  assert.equal(h.repo.outbox(receipt.operationId), undefined);
});

test('a send interrupted by restart is recovered as unknown and replayed with the same operation', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'після рестарту');
  const requestJson = h.repo.outbox(receipt.operationId)!.requestJson;
  assert.equal(h.repo.markSending(receipt.operationId, h.clock.iso()), true);

  h.reopen();
  assert.equal(h.syncer.recover(), 1);
  assert.equal(h.repo.outbox(receipt.operationId)?.state, 'unknown');
  h.clock.advance(h.config.retry.maxDelayMs);
  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.state, 'confirmed');
  assert.deepEqual(h.server.commentRequests.map((request) => request.raw), [requestJson]);
  assert.equal(actorComments(h, server, 'після рестарту').length, 1);
});

test('concurrent push cycles deliver an operation once and a delivered operation is not sent again', async (t) => {
  const { h } = await ready(t);
  h.addComment(KEY, 'один раз');
  const release = h.server.pauseComments();

  const both = Promise.all([h.syncer.pushDue(), h.syncer.pushDue()]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await both;

  assert.equal(h.server.commentRequests.length, 1);
  h.clock.advance(h.config.retry.maxDelayMs);
  assert.deepEqual(await h.syncer.pushDue(), []);
  assert.equal(h.server.commentRequests.length, 1);
  assert.deepEqual(h.repo.listOutbox(), []);
});

test('delivery whose response does not identify the comment stays unresolved without a duplicate', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'без ідентифікатора');
  h.server.appendAfterNextComment('human', 'одразу після');

  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.state, 'delivered');
  const op = h.repo.outbox(receipt.operationId)!;
  assert.equal(op.state, 'delivered');
  assert.equal(op.serverCommentId, null);
  const delivery = h.repo.findBug(KEY).comments.find((comment) => comment.text === 'без ідентифікатора')?.delivery;
  assert.equal(delivery?.state, 'delivered');
  assert.equal(delivery?.linkResolved, false);

  await h.syncer.pullSection(ETCHLY.sectionId);

  assert.equal(actorComments(h, server, 'без ідентифікатора').length, 1);
  assert.deepEqual(h.visibleTexts(KEY).filter((text) => text === 'без ідентифікатора'), ['без ідентифікатора']);
  assert.ok(h.visibleTexts(KEY).includes('одразу після'));
  h.clock.advance(h.config.retry.maxDelayMs);
  await h.syncer.pushDue();
  assert.equal(h.server.commentRequests.length, 1);
});

test('a pull that sees the comment before the send result hides the candidate and replays at once', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'гонка');
  h.server.loseNextResponse();
  await h.syncer.pushDue();

  await h.syncer.pullSection(ETCHLY.sectionId);

  assert.deepEqual(h.visibleTexts(KEY).filter((text) => text === 'гонка'), ['гонка']);
  assert.ok(h.repo.outbox(receipt.operationId));
  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.state, 'confirmed');
  assert.equal(h.server.commentRequests.length, 2);
  assert.equal(h.server.mutations, 1);
  const [created] = actorComments(h, server, 'гонка');
  const local = h.repo.findBug(KEY).comments.filter((comment) => comment.text === 'гонка');
  assert.equal(local.length, 1);
  assert.equal(local[0]?.serverId, created?.id);
  assert.equal(local[0]?.delivery, null);
  assert.equal(h.repo.outbox(receipt.operationId), undefined);
});

test('a 409 on the race replay releases the candidate without deleting either record', async (t) => {
  const { h } = await ready(t);
  const receipt = h.addComment(KEY, 'спірний');
  h.server.loseNextResponse();
  await h.syncer.pushDue();
  await h.syncer.pullSection(ETCHLY.sectionId);
  h.server.failNext('comment', conflict());

  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.state, 'conflict');
  assert.equal(outcome?.conflict, 'conflict-409');
  const comments = h.repo.findBug(KEY).comments.filter((comment) => comment.text === 'спірний');
  assert.equal(comments.length, 2);
  assert.ok(comments.some((comment) => comment.origin === 'server' && comment.serverId !== null));
  assert.equal(comments.find((comment) => comment.origin === 'local')?.delivery?.conflict, 'conflict-409');
  assert.ok(h.repo.outbox(receipt.operationId));
});

test('a revision conflict goes to main without an automatic rebase or retry', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'застаріла ревізія');
  const requestJson = h.repo.outbox(receipt.operationId)!.requestJson;
  h.server.setStatus(server, 'in_progress');

  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.state, 'conflict');
  assert.equal(outcome?.status, 409);
  assert.equal(outcome?.conflict, 'conflict-409');
  const op = h.repo.outbox(receipt.operationId)!;
  assert.equal(op.state, 'conflict');
  assert.equal(op.requestJson, requestJson);
  assert.equal(op.lastStatus, 409);
  const noticeKey = `bug-conflict:${receipt.operationId}:conflict-409`;
  assert.equal(h.notifier.delivered.get(noticeKey)?.text, 'застаріла ревізія');
  assert.deepEqual(h.visibleTexts(KEY).filter((text) => text === 'застаріла ревізія'), ['застаріла ревізія']);

  h.clock.advance(h.config.retry.maxDelayMs * 4);
  await h.syncer.pushDue();
  await h.syncer.pullSection(ETCHLY.sectionId);
  await h.syncer.pushDue();

  assert.equal(h.server.commentRequests.length, 1);
  assert.equal(h.repo.outbox(receipt.operationId)?.requestJson, requestJson);
  assert.equal(h.notifier.calls.length, 1);
});

test('a 404 on send marks the operation bug-missing and keeps the text', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'жука вже немає');
  h.server.eraseBug(server);

  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.conflict, 'bug-missing');
  assert.equal(h.repo.outbox(receipt.operationId)?.lastStatus, 404);
  assert.deepEqual(h.repo.conflicts().map((item) => item.kind), ['bug-missing']);
  assert.ok(h.notifier.delivered.has(`bug-conflict:${receipt.operationId}:bug-missing`));
  assert.ok(h.visibleTexts(KEY).includes('жука вже немає'));
});

for (const [status, error] of [[401, unauthenticated()], [403, accessDenied()]] as const) {
  test(`a ${status} on send keeps the operation as an access conflict`, async (t) => {
    const { h } = await ready(t);
    const receipt = h.addComment(KEY, `доступ ${status}`);
    const requestJson = h.repo.outbox(receipt.operationId)!.requestJson;
    h.server.failNext('comment', error);

    const [outcome] = await h.syncer.pushDue();

    assert.equal(outcome?.conflict, 'access');
    assert.notEqual(outcome?.state, 'confirmed');
    const op = h.repo.outbox(receipt.operationId)!;
    assert.equal(op.lastStatus, status);
    assert.equal(op.requestJson, requestJson);
    assert.notEqual(op.state, 'delivered');
    assert.ok(h.notifier.delivered.has(`bug-conflict:${receipt.operationId}:access`));
    assert.ok(h.visibleTexts(KEY).includes(`доступ ${status}`));
  });
}

test('changed claims become a conflict without a request or a new operation id', async (t) => {
  const { h } = await ready(t);
  const receipt = h.addComment(KEY, 'інші claims');
  const requestJson = h.repo.outbox(receipt.operationId)!.requestJson;
  h.claims.setVersion(2);

  const [outcome] = await h.syncer.pushDue();

  assert.equal(outcome?.conflict, 'claims-changed');
  assert.deepEqual(h.server.commentRequests, []);
  assert.deepEqual(h.repo.listOutbox().map((op) => [op.operationId, op.requestJson]), [[receipt.operationId, requestJson]]);
  assert.ok(h.notifier.delivered.has(`bug-conflict:${receipt.operationId}:claims-changed`));
});

test('a comment to a bug claimed by another owner is sent as a reply to the claim owner without a status change', async (t) => {
  const h = createBugHarness(t);
  const server = h.server.seedBug(ETCHLY, {
    rawId: '344',
    status: 'in_progress',
    claimedBy: CLAIM_OWNER,
    comments: [
      { authorId: CLAIM_OWNER, text: 'беру в роботу' },
      { authorId: 'human', text: 'питання' },
      { authorId: CLAIM_OWNER, text: 'проміжний звіт' },
    ],
  });
  await h.syncer.pullSection(ETCHLY.sectionId);
  const ownerComment = h.server.serverComments(server).filter((comment) => comment.authorId === CLAIM_OWNER).at(-1)!;

  const receipt = h.addComment(KEY, 'відповідь власнику claim');

  assert.equal(receipt.replyTo, ownerComment.id);
  assert.equal(JSON.parse(h.repo.outbox(receipt.operationId)!.requestJson).reply_to, ownerComment.id);
  const [outcome] = await h.syncer.pushDue();
  assert.equal(outcome?.state, 'confirmed');
  assert.equal(h.server.commentRequests[0]?.body.reply_to, ownerComment.id);
  assert.equal(actorComments(h, server, 'відповідь власнику claim')[0]?.replyTo, ownerComment.id);
  await h.syncer.pullSection(ETCHLY.sectionId);
  const bug = h.repo.findBug(KEY);
  assert.equal(bug.status, 'in_progress');
  assert.equal(bug.claimedBy, CLAIM_OWNER);
  assert.equal(bug.comments.find((comment) => comment.text === 'відповідь власнику claim')?.replyTo, ownerComment.id);
});

test('a comment to an unclaimed bug is not a reply', async (t) => {
  const { h } = await ready(t);
  const receipt = h.addComment(KEY, 'звичайний');

  assert.equal(receipt.replyTo, null);
  assert.equal('reply_to' in JSON.parse(h.repo.outbox(receipt.operationId)!.requestJson), false);
});

test('main notices are retried after a failed delivery and shown once', async (t) => {
  const { h, server } = await ready(t);
  const receipt = h.addComment(KEY, 'повідомити main');
  h.server.setStatus(server, 'closed');
  h.notifier.failNext();

  await h.syncer.pushDue();

  const noticeKey = `bug-conflict:${receipt.operationId}:conflict-409`;
  assert.equal(h.notifier.delivered.size, 0);
  assert.equal(h.repo.conflicts()[0]?.noticedAt, null);
  assert.deepEqual(h.repo.pendingNotices().map((notice) => notice.noticeKey), [noticeKey]);

  assert.equal(await h.syncer.deliverNotices(), 1);
  assert.equal(await h.syncer.deliverNotices(), 0);

  assert.deepEqual(h.notifier.calls.map((notice) => notice.noticeKey), [noticeKey, noticeKey]);
  assert.equal(h.notifier.delivered.size, 1);
  assert.notEqual(h.repo.conflicts()[0]?.noticedAt, null);
});
