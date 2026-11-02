import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noticeCandidates } from '../src/bug-store.ts';
import { canonical, createBugHarness, detailOf, ETCHLY, START } from './bug-sync-fixture.ts';

for (const status of ['rejected', 'fixed', 'verified']) {
  test(`incremental discovery of a bug already ${status} stores it without notifying main`, async (t) => {
    const h = createBugHarness(t);
    await h.syncer.runCycle();
    assert.equal(h.repo.syncState(ETCHLY.sectionId).phase, 'incremental');
    const fresh = h.server.seedBug(ETCHLY, { rawId: '345' });
    h.server.setStatus(fresh, status);

    await h.syncer.runCycle();

    assert.equal(h.repo.findBug(canonical(ETCHLY, '345')).status, status);
    assert.deepEqual(h.notifier.calls, []);
    assert.deepEqual(h.repo.pendingNotices(), []);
    h.reopen();
    await h.syncer.runCycle();
    assert.deepEqual(h.notifier.calls, []);
    assert.deepEqual(h.repo.pendingNotices(), []);
  });

  test(`a new human comment on a known ${status} bug still notifies main`, () => {
    const detail = detailOf(ETCHLY, '345', {
      problemId: 'problem-345', status,
      comments: [{ id: 'c-1', authorId: 'user:owner', authorKind: 'person', text: 'check again', replyTo: null, createdAt: START, payload: {} }],
    });
    assert.deepEqual(noticeCandidates(new Set(), detail), [
      { noticeKey: 'bug-comment:problem-345:c-1', kind: 'human-comment', commentServerId: 'c-1' },
    ]);
  });
}
