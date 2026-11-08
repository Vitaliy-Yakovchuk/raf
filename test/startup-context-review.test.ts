import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  bindStartupContextReview, closeStartupContextReview, listStartupContextReviewEvents,
  pendingStartupContextRunIds, pruneStartupContextTraces, readStartupContextTrace,
  recordStartupContextCompletion, saveStartupContextTrace,
} from '../src/startup-context.ts';
import type { StartupContextCompletion } from '../src/startup-context.ts';
import { contextDatabase, traceFixture } from './startup-context-fixture.ts';

const finishedAt = '2026-10-22T00:00:00.000Z';
const afterFinished = (milliseconds: number): string => new Date(Date.parse(finishedAt) + milliseconds).toISOString();

function completion(runId: string, flowPath: string, overrides: Partial<StartupContextCompletion> = {}): StartupContextCompletion {
  return { runId, flowPath, phase: 'implement', trace: traceFixture(runId), finishedAt, mainAddress: 'main', ...overrides };
}

test('startup context review: a completed trace is available without a policy count', t => {
  const { database, flowPath } = contextDatabase(t);
  writeFileSync(flowPath, '{}');
  const event = recordStartupContextCompletion(database, completion('one', flowPath));
  assert.ok(event);
  assert.equal(event.event, 'context-review.due');
  assert.equal(event.to, 'main');
  assert.deepEqual(event.runIds, ['one']);
  assert.deepEqual(pendingStartupContextRunIds(database), []);
  assert.deepEqual(listStartupContextReviewEvents(database), [event]);
});

test('startup context review: repeated closure preserves the package and does not duplicate delivery', t => {
  const { database, flowPath } = contextDatabase(t);
  const request = completion('one', flowPath);
  const event = recordStartupContextCompletion(database, request);
  assert.ok(event);
  assert.equal(recordStartupContextCompletion(database, request), null);
  assert.deepEqual(listStartupContextReviewEvents(database), [event]);
});

test('startup context review: a bound package stays stable and new traces enter the next package', t => {
  const { database, databasePath, flowPath } = contextDatabase(t);
  const first = recordStartupContextCompletion(database, completion('first', flowPath));
  assert.ok(first);
  bindStartupContextReview(database, { eventId: first.id, reviewRunId: 'reviewer', phase: 'context-review' });
  const peer = new DatabaseSync(databasePath);
  try {
    const second = recordStartupContextCompletion(peer, completion('second', flowPath));
    assert.ok(second);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.runIds, ['second']);
    assert.deepEqual(listStartupContextReviewEvents(peer), [first, second]);
  } finally { peer.close(); }
  assert.deepEqual(listStartupContextReviewEvents(database)[0], first);
});

test('startup context review: storing an unfinished trace or finishing without one creates no event', t => {
  const { database, flowPath } = contextDatabase(t);
  saveStartupContextTrace(database, traceFixture('running'));
  assert.equal(recordStartupContextCompletion(database, completion('missing', flowPath, { trace: null })), null);
  assert.deepEqual(listStartupContextReviewEvents(database), []);
  assert.deepEqual(pruneStartupContextTraces(database, { now: finishedAt, flowPath }), []);
  assert.ok(readStartupContextTrace(database, 'running'));
});

test('startup context review: context-review is excluded from its own analysis event', t => {
  const { database, flowPath } = contextDatabase(t);
  assert.equal(recordStartupContextCompletion(database, completion('reviewer', flowPath, {
    phase: 'context-review', trace: traceFixture('reviewer', 'context-review'),
  })), null);
  assert.deepEqual(listStartupContextReviewEvents(database), []);
});

test('startup context review: successful analysis cleans its package immediately and preserves an unfinished neighbour after reopen', t => {
  const { database, databasePath, flowPath } = contextDatabase(t);
  const first = recordStartupContextCompletion(database, completion('first', flowPath));
  const second = recordStartupContextCompletion(database, completion('second', flowPath));
  assert.ok(first && second);
  bindStartupContextReview(database, { eventId: first.id, reviewRunId: 'reviewer', phase: 'context-review' });
  assert.deepEqual(pruneStartupContextTraces(database, { now: afterFinished(999999999), flowPath }), []);
  closeStartupContextReview(database, { reviewRunId: 'reviewer', closedAt: finishedAt });
  const peer = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(pruneStartupContextTraces(peer, { now: finishedAt, flowPath }), ['first']);
    assert.deepEqual(pruneStartupContextTraces(peer, { now: finishedAt, flowPath }), []);
    assert.equal(readStartupContextTrace(peer, 'first'), null);
    assert.ok(readStartupContextTrace(peer, 'second'));
    assert.deepEqual(listStartupContextReviewEvents(peer), [second]);
    assert.equal(peer.prepare('SELECT count(*) AS n FROM startup_context_completions WHERE run_id=?').get('first')?.n, 0);
  } finally { peer.close(); }
});

test('startup context review: a closed package waits for its addressed delivery before cleanup', t => {
  const { database, databasePath, flowPath } = contextDatabase(t);
  const event = recordStartupContextCompletion(database, completion('source', flowPath));
  assert.ok(event);
  database.exec('CREATE TABLE pending_intents(id TEXT PRIMARY KEY, run_id TEXT, payload TEXT)');
  const intent = { id: event.id, runId: 'source', payload: { mainDelivered: false } };
  database.prepare('INSERT INTO pending_intents VALUES(?,?,?)').run(intent.id, intent.runId, JSON.stringify(intent));
  bindStartupContextReview(database, { eventId: event.id, reviewRunId: 'reviewer', phase: 'context-review' });
  closeStartupContextReview(database, { reviewRunId: 'reviewer', closedAt: finishedAt });
  const peer = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(pruneStartupContextTraces(peer, { now: finishedAt, flowPath }), []);
    assert.ok(readStartupContextTrace(peer, 'source'));
    peer.prepare('UPDATE pending_intents SET payload=? WHERE id=?').run(JSON.stringify({ ...intent, payload: { mainDelivered: true } }), event.id);
    assert.deepEqual(pruneStartupContextTraces(peer, { now: finishedAt, flowPath }), ['source']);
    assert.deepEqual(listStartupContextReviewEvents(peer), []);
    assert.equal(peer.prepare('SELECT count(*) AS n FROM pending_intents').get()?.n, 0);
  } finally { peer.close(); }
});

test('startup context review: cleanup returns between package roots and resumes without replay', t => {
  const { database, flowPath } = contextDatabase(t);
  const first = recordStartupContextCompletion(database, completion('first', flowPath));
  const second = recordStartupContextCompletion(database, completion('second', flowPath));
  assert.ok(first && second);
  for (const [event, reviewer] of [[first, 'review-first'], [second, 'review-second']] as const) {
    bindStartupContextReview(database, { eventId: event.id, reviewRunId: reviewer, phase: 'context-review' });
    closeStartupContextReview(database, { reviewRunId: reviewer, closedAt: finishedAt });
  }
  const removed = pruneStartupContextTraces(database, { now: finishedAt, flowPath });
  assert.equal(removed.length, 1);
  assert.equal(listStartupContextReviewEvents(database).length, 1);
  assert.equal(pruneStartupContextTraces(database, { now: finishedAt, flowPath }).length, 1);
  assert.deepEqual(pruneStartupContextTraces(database, { now: finishedAt, flowPath }), []);
});
