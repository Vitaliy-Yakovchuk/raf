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
import { contextDatabase, flowConfiguration, traceFixture } from './startup-context-fixture.ts';

const finishedAt = '2026-10-22T00:00:00.000Z';
const afterFinished = (milliseconds: number): string => new Date(Date.parse(finishedAt) + milliseconds).toISOString();

function completion(runId: string, flowPath: string, overrides: Partial<StartupContextCompletion> = {}): StartupContextCompletion {
  return { runId, flowPath, phase: 'implement', trace: traceFixture(runId), finishedAt, mainAddress: 'main', ...overrides };
}

test('startup context review: configured threshold emits exactly one durable event to main with the completed runIds', t => {
  const { database, flowPath } = contextDatabase(t);
  const threshold = flowConfiguration.startupContextReview.runsPerReview;
  const runIds = Array.from({ length: threshold }, (_, index) => `run-${index}`);
  for (const runId of runIds.slice(0, -1)) assert.equal(recordStartupContextCompletion(database, completion(runId, flowPath)), null);
  assert.deepEqual(pendingStartupContextRunIds(database), runIds.slice(0, -1));
  const event = recordStartupContextCompletion(database, completion(runIds.at(-1)!, flowPath));
  assert.ok(event);
  assert.equal(event.event, 'context-review.due');
  assert.equal(event.to, 'main');
  assert.ok(event.id.length > 0);
  assert.deepEqual(event.runIds, runIds);
  assert.deepEqual(listStartupContextReviewEvents(database), [event]);
  assert.deepEqual(pendingStartupContextRunIds(database), []);
  for (const runId of runIds) assert.deepEqual(readStartupContextTrace(database, runId), traceFixture(runId));
});

test('startup context review: reset starts a new disjoint batch rather than replaying old runIds', t => {
  const { database, flowPath, writeFlow } = contextDatabase(t);
  writeFlow(2);
  assert.equal(recordStartupContextCompletion(database, completion('one', flowPath)), null);
  const first = recordStartupContextCompletion(database, completion('two', flowPath));
  assert.ok(first);
  assert.equal(recordStartupContextCompletion(database, completion('three', flowPath)), null);
  const second = recordStartupContextCompletion(database, completion('four', flowPath));
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.runIds, ['one', 'two']);
  assert.deepEqual(second.runIds, ['three', 'four']);
  assert.deepEqual(listStartupContextReviewEvents(database), [first, second]);
});

test('startup context review: merely storing a trace or finishing without a trace does not increment the counter', t => {
  const { database, flowPath } = contextDatabase(t);
  saveStartupContextTrace(database, traceFixture('still-running'));
  assert.equal(recordStartupContextCompletion(database, completion('no-trace', flowPath, { trace: null })), null);
  assert.deepEqual(pendingStartupContextRunIds(database), []);
  assert.deepEqual(listStartupContextReviewEvents(database), []);
});

test('startup context review: --phase context-review is excluded but its trace remains available', t => {
  const { database, flowPath, writeFlow } = contextDatabase(t);
  writeFlow(2);
  recordStartupContextCompletion(database, completion('normal-before', flowPath));
  assert.equal(recordStartupContextCompletion(database, completion('review', flowPath, { phase: 'context-review', trace: traceFixture('review', 'context-review') })), null);
  assert.deepEqual(pendingStartupContextRunIds(database), ['normal-before']);
  assert.deepEqual(readStartupContextTrace(database, 'review'), traceFixture('review', 'context-review'));
  const event = recordStartupContextCompletion(database, completion('normal-after', flowPath));
  assert.deepEqual(event?.runIds, ['normal-before', 'normal-after']);
});

test('startup context review: completion retry cannot increment twice or emit a duplicate event', t => {
  const { database, flowPath, writeFlow } = contextDatabase(t);
  writeFlow(2);
  const one = completion('one', flowPath);
  const two = completion('two', flowPath);
  recordStartupContextCompletion(database, one);
  recordStartupContextCompletion(database, one);
  assert.deepEqual(pendingStartupContextRunIds(database), ['one']);
  recordStartupContextCompletion(database, two);
  recordStartupContextCompletion(database, two);
  recordStartupContextCompletion(database, one);
  assert.equal(listStartupContextReviewEvents(database).length, 1);
  assert.deepEqual(listStartupContextReviewEvents(database)[0].runIds, ['one', 'two']);
  assert.deepEqual(pendingStartupContextRunIds(database), []);
});

test('startup context review: the next completion rereads conf/flow.json without restarting or caching the threshold', t => {
  const { database, flowPath, writeFlow } = contextDatabase(t);
  writeFlow(4);
  recordStartupContextCompletion(database, completion('one', flowPath));
  recordStartupContextCompletion(database, completion('two', flowPath));
  writeFlow(2);
  const event = recordStartupContextCompletion(database, completion('three', flowPath));
  assert.deepEqual(event?.runIds, ['one', 'two', 'three']);
  assert.deepEqual(pendingStartupContextRunIds(database), []);
  writeFlow(3);
  assert.equal(recordStartupContextCompletion(database, completion('four', flowPath)), null);
  assert.equal(recordStartupContextCompletion(database, completion('five', flowPath)), null);
  assert.deepEqual(recordStartupContextCompletion(database, completion('six', flowPath))?.runIds, ['four', 'five', 'six']);
});

for (const invalid of [0, -1, 1.5, '2', null]) {
  test(`startup context review: invalid runsPerReview ${JSON.stringify(invalid)} produces an explicit error with no counting side effect`, t => {
    const { database, flowPath, writeFlow } = contextDatabase(t);
    writeFlow(2);
    recordStartupContextCompletion(database, completion('existing', flowPath));
    writeFlow(invalid);
    assert.throws(() => recordStartupContextCompletion(database, completion('rejected', flowPath)), /startupContextReview.*runsPerReview/u);
    writeFlow(2);
    assert.deepEqual(pendingStartupContextRunIds(database), ['existing']);
    assert.deepEqual(listStartupContextReviewEvents(database), []);
    assert.deepEqual(recordStartupContextCompletion(database, completion('next', flowPath))?.runIds, ['existing', 'next']);
  });
}

test('startup context review: a missing policy key has no hidden fallback', t => {
  const { database, flowPath } = contextDatabase(t);
  const { startupContextReview, ...withoutReviewPolicy } = flowConfiguration;
  writeFileSync(flowPath, JSON.stringify(withoutReviewPolicy));
  assert.throws(() => recordStartupContextCompletion(database, completion('one', flowPath)), /startupContextReview|runsPerReview/u);
});

test('startup context review: accounting is shared between SQLite connections and survives reopening', t => {
  const { database, databasePath, flowPath, writeFlow } = contextDatabase(t);
  writeFlow(3);
  recordStartupContextCompletion(database, completion('first-process', flowPath));
  const peer = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(pendingStartupContextRunIds(peer), ['first-process']);
    recordStartupContextCompletion(peer, completion('second-process', flowPath));
  } finally {
    peer.close();
  }
  assert.deepEqual(pendingStartupContextRunIds(database), ['first-process', 'second-process']);
  recordStartupContextCompletion(database, completion('last-process', flowPath));
  database.close();
  const reopened = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(listStartupContextReviewEvents(reopened)[0].runIds, ['first-process', 'second-process', 'last-process']);
    assert.deepEqual(pendingStartupContextRunIds(reopened), []);
  } finally {
    reopened.close();
  }
});

test('startup context review: traces referenced by an unclaimed event remain pinned beyond normal retention', t => {
  const { database, flowPath, writeFlow } = contextDatabase(t);
  writeFlow(1);
  const event = recordStartupContextCompletion(database, completion('pinned', flowPath));
  assert.ok(event);
  assert.deepEqual(pruneStartupContextTraces(database, { now: afterFinished(flowConfiguration.retention.finishedSessionsMs + 1), flowPath }), []);
  assert.ok(readStartupContextTrace(database, 'pinned'));
});

test('startup context review: finishing the reviewer does not release traces before its session is closed', t => {
  const { database, flowPath, writeFlow } = contextDatabase(t);
  writeFlow(1);
  const event = recordStartupContextCompletion(database, completion('source', flowPath));
  assert.ok(event);
  bindStartupContextReview(database, { eventId: event.id, reviewRunId: 'reviewer', phase: 'context-review' });
  recordStartupContextCompletion(database, completion('reviewer', flowPath, { phase: 'context-review', trace: traceFixture('reviewer', 'context-review') }));
  const now = afterFinished(flowConfiguration.retention.finishedSessionsMs + 1);
  pruneStartupContextTraces(database, { now, flowPath });
  assert.ok(readStartupContextTrace(database, 'source'));
  closeStartupContextReview(database, { reviewRunId: 'reviewer', closedAt: now });
  assert.ok(pruneStartupContextTraces(database, { now, flowPath }).includes('source'));
  assert.equal(readStartupContextTrace(database, 'source'), null);
});

test('startup context review: closing one reviewer does not unpin another review batch', t => {
  const { database, flowPath, writeFlow } = contextDatabase(t);
  writeFlow(1);
  const first = recordStartupContextCompletion(database, completion('first-source', flowPath));
  const second = recordStartupContextCompletion(database, completion('second-source', flowPath));
  assert.ok(first && second);
  bindStartupContextReview(database, { eventId: first.id, reviewRunId: 'first-reviewer', phase: 'context-review' });
  bindStartupContextReview(database, { eventId: second.id, reviewRunId: 'second-reviewer', phase: 'context-review' });
  const now = afterFinished(flowConfiguration.retention.finishedSessionsMs + 1);
  closeStartupContextReview(database, { reviewRunId: 'first-reviewer', closedAt: now });
  assert.deepEqual(pruneStartupContextTraces(database, { now, flowPath }), ['first-source']);
  assert.equal(readStartupContextTrace(database, 'first-source'), null);
  assert.ok(readStartupContextTrace(database, 'second-source'));
});

test('startup context review: unpinned review traces follow finishedSessionsMs and the next cleanup rereads retention', t => {
  const { database, flowPath, writeFlow } = contextDatabase(t);
  recordStartupContextCompletion(database, completion('reviewer', flowPath, { phase: 'context-review', trace: traceFixture('reviewer', 'context-review') }));
  const retention = flowConfiguration.retention.finishedSessionsMs;
  assert.deepEqual(pruneStartupContextTraces(database, { now: afterFinished(retention - 1), flowPath }), []);
  assert.ok(readStartupContextTrace(database, 'reviewer'));
  writeFlow(flowConfiguration.startupContextReview.runsPerReview, retention * 2);
  assert.deepEqual(pruneStartupContextTraces(database, { now: afterFinished(retention + 1), flowPath }), []);
  writeFlow(flowConfiguration.startupContextReview.runsPerReview);
  assert.deepEqual(pruneStartupContextTraces(database, { now: afterFinished(retention + 1), flowPath }), ['reviewer']);
  assert.equal(readStartupContextTrace(database, 'reviewer'), null);
});
