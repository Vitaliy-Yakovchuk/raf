import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpBugServer } from '../src/bug-sync.ts';
import { canonical, createBugHarness, ETCHLY_DEV, RAMUS, unavailable, type BugHarness } from './bug-sync-fixture.ts';

function expireCursor(h: BugHarness, cursor: string): void {
  const events = h.server.events.bind(h.server);
  const expired = createHttpBugServer({ fetch: async () => Response.json({ error: 'cursor-expired' }, { status: 410 }) });
  h.server.events = (auth, input) => input.cursor === cursor && auth.project === ETCHLY_DEV.project && auth.env === ETCHLY_DEV.env
    ? expired.events(auth, input)
    : events(auth, input);
}

test('HTTP cursor-expired triggers a complete section resync and subsequent incremental pulls', async (t) => {
  const h = createBugHarness(t, { sections: [ETCHLY_DEV, RAMUS] });
  const kept = h.server.seedBug(ETCHLY_DEV, { rawId: '344' });
  const gone = h.server.seedBug(ETCHLY_DEV, { rawId: '345' });
  const other = h.server.seedBug(RAMUS, { rawId: '344' });
  await h.syncer.pullSection(ETCHLY_DEV.sectionId);
  await h.syncer.pullSection(RAMUS.sectionId);
  const staleCursor = h.repo.syncState(ETCHLY_DEV.sectionId).journalCursor;
  h.server.eraseBug(gone);
  h.server.addComment(kept, 'human', 'during the gap');
  h.server.seedBug(ETCHLY_DEV, { rawId: '346' });
  h.server.seedBug(ETCHLY_DEV, { rawId: '347' });
  expireCursor(h, staleCursor);
  for (let attempt = 0; attempt < 260; attempt += 1) h.repo.recordSyncFailure(ETCHLY_DEV.sectionId, 'cursor-expired', h.clock.iso());
  h.reopen();
  const before = h.server.calls.length;

  const outcome = await h.syncer.pullSection(ETCHLY_DEV.sectionId);

  assert.equal(outcome.errorCode, null);
  assert.equal(outcome.phase, 'incremental');
  assert.equal(outcome.snapshotComplete, true);
  assert.ok(h.server.calls.slice(before).filter(call => call.method === 'query').length >= 2);
  assert.equal(h.repo.findBug(canonical(ETCHLY_DEV, '345')).presence, 'missing');
  assert.deepEqual(h.visibleTexts(canonical(ETCHLY_DEV, '344')), ['during the gap']);
  for (const id of ['346', '347']) assert.equal(h.repo.findBug(canonical(ETCHLY_DEV, id)).presence, 'present');
  const state = h.repo.syncState(ETCHLY_DEV.sectionId);
  assert.equal(state.journalCursor, h.server.head(ETCHLY_DEV));
  assert.equal(state.lastErrorCode, null);
  assert.equal(state.consecutiveFailures, 0);
  assert.deepEqual(h.repo.pendingNotices(), []);

  const next = h.server.calls.length;
  h.server.addComment(kept, 'human', 'after resync');
  h.server.addComment(other, 'human', 'other section');
  await h.syncer.runCycle();

  assert.equal(h.server.calls.slice(next).filter(call => call.method === 'query').length, 0);
  assert.deepEqual(h.visibleTexts(canonical(ETCHLY_DEV, '344')), ['during the gap', 'after resync']);
  assert.deepEqual(h.visibleTexts(canonical(RAMUS, '344')), ['other section']);
  assert.equal(h.repo.syncState(ETCHLY_DEV.sectionId).journalCursor, h.server.head(ETCHLY_DEV));
  assert.equal(h.repo.syncState(RAMUS.sectionId).lastErrorCode, null);
  assert.equal(h.notifier.calls.length, 2);
});

test('an expired persisted snapshot head restarts journal discovery and resumes a failed resync', async (t) => {
  const h = createBugHarness(t, { sections: [ETCHLY_DEV] });
  for (const rawId of ['101', '102', '103']) h.server.seedBug(ETCHLY_DEV, { rawId });
  const head = h.server.head(ETCHLY_DEV);
  h.repo.applyPullBatch({ sectionId: ETCHLY_DEV.sectionId, details: [], deleted: [], missing: [],
    position: { phase: 'resync', snapshotHead: head, snapshotComplete: false }, at: h.clock.iso() });
  h.server.seedBug(ETCHLY_DEV, { rawId: '104' });
  expireCursor(h, head);
  h.server.failNext('read', unavailable(), key => key?.rawId === '103');
  h.reopen();

  const interrupted = await h.syncer.pullSection(ETCHLY_DEV.sectionId);

  assert.equal(interrupted.errorCode, unavailable().code);
  assert.equal(interrupted.phase, 'resync');
  assert.equal(interrupted.snapshotComplete, false);
  const partial = h.repo.syncState(ETCHLY_DEV.sectionId);
  assert.equal(partial.snapshotHead, h.server.head(ETCHLY_DEV));
  assert.notEqual(partial.listCursor, null);
  h.reopen();
  const before = h.server.calls.length;

  const resumed = await h.syncer.pullSection(ETCHLY_DEV.sectionId);

  assert.equal(resumed.errorCode, null);
  assert.equal(resumed.phase, 'incremental');
  assert.equal(resumed.snapshotComplete, true);
  const firstQuery = h.server.calls.slice(before).find(call => call.method === 'query');
  assert.equal((firstQuery?.input as { cursor: string | null }).cursor, partial.listCursor);
  assert.equal(h.repo.listBugs({ limit: 50 }).bugs.length, 4);
  assert.equal(h.repo.syncState(ETCHLY_DEV.sectionId).journalCursor, h.server.head(ETCHLY_DEV));
  assert.deepEqual(h.repo.pendingNotices(), []);
});
