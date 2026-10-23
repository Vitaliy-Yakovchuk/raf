import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { AgentReportResult } from '../src/agent-report.ts';
import type { PendingIntent, SessionRecord } from '../src/session-state.ts';
import { cleanupStartupContextCompleted, finalizeStartupContextRun, reserveStartupContextReview, type StartupContextLifecyclePorts } from '../src/startup-context-lifecycle.ts';
import { listStartupContextReviewEvents, pendingStartupContextRunIds, readStartupContextTrace, recordStartupContextCompletion, type StartupContextDueEvent, type StartupContextTrace } from '../src/startup-context.ts';

const finishedAt = '2026-10-22T10:00:00.000Z';
const assessment = { unnecessary: [{ source: 'brief/common', reason: 'Repeated instructions' }], missing: [{ description: 'Trace contract', foundAt: '/spec/trace.md' }] };

function seedTrace(runId: string): StartupContextTrace {
  const unknown = { value: null, reason: 'Fixture has no native measurement' };
  return {
    runId, agentType: 'implement', runner: 'codex', phase: 'implement',
    autoloaded: { systemPrompt: unknown, instructions: unknown, skills: unknown, mcpServers: unknown, memory: unknown },
    reads: [], brief: { tokens: 4, parts: [{ source: 'brief.txt', tokens: 4 }] },
    tokens: { startupInput: unknown, totalInput: unknown, cacheReadInput: unknown, cacheWriteInput: unknown },
    boundary: { kind: 'run-ended', eventIndex: 0 }, context: null,
  };
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-context-lifecycle-'));
  const flowPath = join(directory, 'flow.json');
  writeFileSync(flowPath, JSON.stringify({ startupContextReview: { runsPerReview: 2 }, retention: { finishedSessionsMs: 1000 } }));
  const database = new DatabaseSync(join(directory, 'state.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const rows = new Map<string, SessionRecord>();
  const pending = new Map<string, PendingIntent>();
  const order: string[] = [];
  const diagnostics: string[] = [];
  let filesPresent = true;
  let acceptGate: Promise<void> = Promise.resolve();
  let collectionError: Error | null = null;
  let journalMissing = false;
  let reportStatus: 'succeeded' | 'failed' = 'succeeded';
  let reportPresent = true;
  let cleanupAt: string | undefined;
  const ports: StartupContextLifecyclePorts = {
    database, flowPath, mainAddress: 'main', now: () => finishedAt,
    estimateTokens: text => text.length,
    sessions: {
      get: runId => rows.get(runId),
      async acceptReport(session) {
        order.push(`accept-start:${session.runId}`);
        await acceptGate;
        assert.ok(filesPresent);
        const result: AgentReportResult = {
          runId: session.runId, id: session.addressId, event: reportStatus === 'succeeded' ? 'agent.succeeded' : 'agent.failed', status: reportStatus, at: finishedAt,
          ...(reportPresent ? { report: { status: reportStatus, answer: 'Done', changes: [], context: assessment } } : {}),
          exit: { code: reportStatus === 'succeeded' ? 0 : 1, signal: null },
        };
        session.result = { status: result.status, response: result.report?.answer ?? 'Runner exited without a report', proof: result };
        rows.set(session.runId, session);
        order.push(`accepted:${session.runId}`);
        return result;
      },
      async finish(session, at, intents) {
        order.push(`finish:${session.runId}`);
        assert.ok(filesPresent);
        assert.ok(session.result, 'report result is accepted before committing finished');
        for (const intent of intents) pending.set(intent.id, structuredClone(intent));
        const row: SessionRecord = { ...session, state: 'finished', finishedAt: at, revision: session.revision + 1 };
        rows.set(session.runId, row);
        return row;
      },
      cleanupCompleted(now) { cleanupAt = now; return 7; },
    },
    async collectJournal(session) {
      order.push(`collect:${session.runId}`);
      assert.equal(session.state, 'exited');
      assert.equal(session.observation?.state, 'exited');
      assert.equal(session.process?.runnerSessionId, `native-${session.runId}`);
      assert.ok(order.includes(`accepted:${session.runId}`));
      assert.ok(filesPresent, 'brief/report directory must still exist during collection');
      if (collectionError) throw collectionError;
      return { events: [], unavailableReason: journalMissing ? 'Native session journal not found' : null };
    },
    async readBriefParts() {
      assert.ok(filesPresent);
      return [{ source: 'conf/briefs/common.md', text: 'common brief' }, { source: 'assignment', text: 'task brief' }];
    },
    async removeRunDirectory(session) { order.push(`remove:${session.runId}`); filesPresent = false; },
    diagnostic(reason) { diagnostics.push(reason); },
  };
  function add(runId = 'run-1', state: SessionRecord['state'] = 'exited', phase = 'implement') {
    filesPresent = true;
    const row: SessionRecord = {
      runId, addressId: `agent-${runId}`, revision: 1, state,
      activity: { type: phase === 'context-review' ? 'spec' : 'implement', project: 'raf', features: ['review-agent-startup-context'], phase, cwd: directory },
      process: { pid: 123, startedAt: '2026-10-22T09:00:00.000Z', runner: 'codex', runnerSessionId: `native-${runId}`, tmuxSession: `tmux-${runId}`, evidence: { runId } },
      observation: state === 'exited' ? { state: 'exited', observedAt: finishedAt, exitCode: 0, evidence: 'confirmed native exit' } : { state: 'alive', observedAt: finishedAt, identity: { pid: 123, startedAt: '2026-10-22T09:00:00.000Z', runner: 'codex', runnerSessionId: `native-${runId}`, tmuxSession: `tmux-${runId}`, evidence: { runId } } },
    };
    rows.set(runId, row);
    return row;
  }
  function seedBatch(prefix: string, at = finishedAt) {
    const runIds = [`${prefix}-1`, `${prefix}-2`];
    let event: StartupContextDueEvent | null = null;
    for (const runId of runIds) event = recordStartupContextCompletion(database, { runId, phase: 'implement', trace: seedTrace(runId), finishedAt: at, flowPath, mainAddress: 'main' });
    assert.ok(event);
    return { event, runIds };
  }
  return { ports, database, flowPath, rows, pending, order, diagnostics, add, seedBatch,
    get filesPresent() { return filesPresent; }, get cleanupAt() { return cleanupAt; },
    gateReports(gate: Promise<void>) { acceptGate = gate; },
    failCollection(error: Error) { collectionError = error; },
    missingJournal() { journalMissing = true; },
    failReport(withReport = true) { reportStatus = 'failed'; reportPresent = withReport; },
  };
}

test('finalize does not collect while the native runner is still alive', async t => {
  const f = fixture(t);
  f.add('alive', 'running');
  await assert.rejects(finalizeStartupContextRun('alive', f.ports), /exit|running|alive/i);
  assert.deepEqual(f.order, []);
  assert.equal(readStartupContextTrace(f.database, 'alive'), null);
});

test('finalize waits for report acceptance and collects before committing and removing the run directory', async t => {
  const f = fixture(t);
  f.add();
  let release!: () => void;
  f.gateReports(new Promise<void>(resolve => { release = resolve; }));
  const closing = finalizeStartupContextRun('run-1', f.ports);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.order, ['accept-start:run-1']);
    assert.equal(f.filesPresent, true);
  } finally { release(); }
  const row = await closing;
  assert.equal(row.state, 'finished');
  assert.deepEqual(f.order, ['accept-start:run-1', 'accepted:run-1', 'collect:run-1', 'finish:run-1', 'remove:run-1']);
  const trace = readStartupContextTrace(f.database, 'run-1');
  assert.ok(trace);
  assert.equal(trace.runId, 'run-1');
  assert.equal(trace.agentType, 'implement');
  assert.equal(trace.runner, 'codex');
  assert.equal(trace.phase, 'implement');
  assert.deepEqual(trace.context, assessment);
  assert.deepEqual(trace.brief.parts, [{ source: 'conf/briefs/common.md', tokens: 'common brief'.length }, { source: 'assignment', tokens: 'task brief'.length }]);
  assert.equal(f.filesPresent, false);
});

test('recovery uses persisted exited state with a freshly reopened SQLite connection', async t => {
  const f = fixture(t);
  f.add('recovered');
  const recoveredDatabase = new DatabaseSync(join(f.rows.get('recovered')!.activity!.cwd, 'state.sqlite'));
  t.after(() => recoveredDatabase.close());
  await finalizeStartupContextRun('recovered', { ...f.ports, database: recoveredDatabase });
  assert.equal(f.rows.get('recovered')?.state, 'finished');
  assert.ok(readStartupContextTrace(f.database, 'recovered'));
  assert.deepEqual(pendingStartupContextRunIds(f.database), ['recovered']);
  assert.ok(f.order.indexOf('collect:recovered') < f.order.indexOf('remove:recovered'));
});

test('repeated finalize and replay from exited state do not count a run twice', async t => {
  const f = fixture(t);
  f.add();
  await finalizeStartupContextRun('run-1', f.ports);
  const firstTrace = readStartupContextTrace(f.database, 'run-1');
  await finalizeStartupContextRun('run-1', f.ports);
  assert.equal(f.order.filter(step => step === 'collect:run-1').length, 1);
  assert.deepEqual(readStartupContextTrace(f.database, 'run-1'), firstTrace);
  f.add('run-1');
  await finalizeStartupContextRun('run-1', f.ports);
  assert.deepEqual(pendingStartupContextRunIds(f.database), ['run-1']);
  assert.deepEqual(listStartupContextReviewEvents(f.database), []);
});

test('missing transcript still records a completion with explained null fields and accepted report context', async t => {
  const f = fixture(t);
  f.add(); f.missingJournal();
  await finalizeStartupContextRun('run-1', f.ports);
  const trace = readStartupContextTrace(f.database, 'run-1');
  assert.ok(trace);
  assert.deepEqual(trace.reads, []);
  for (const field of [...Object.values(trace.autoloaded), ...Object.values(trace.tokens)]) {
    assert.equal(field.value, null); assert.ok(field.reason);
  }
  assert.deepEqual(trace.context, assessment);
  assert.ok(trace.brief.tokens > 0);
  assert.deepEqual(pendingStartupContextRunIds(f.database), ['run-1']);
});

test('internal collection error closes the session without counting it or leaking journal contents in diagnostics', async t => {
  const f = fixture(t);
  f.add(); f.failCollection(new Error('NATIVE_CONTENT_SECRET exception contains raw journal text'));
  const row = await finalizeStartupContextRun('run-1', f.ports);
  assert.equal(row.state, 'finished');
  assert.equal(f.filesPresent, false);
  assert.equal(readStartupContextTrace(f.database, 'run-1'), null);
  assert.deepEqual(pendingStartupContextRunIds(f.database), []);
  assert.ok(f.diagnostics.length);
  assert.match(f.diagnostics.join('\n'), /context|collect|trace/i);
  assert.equal(f.diagnostics.join('\n').includes('NATIVE_CONTENT_SECRET'), false);
  assert.equal(JSON.stringify([...f.pending.values()]).includes('NATIVE_CONTENT_SECRET'), false);
});

test('threshold stages context-review.due for main with stable package ID and runIds in pending queue', async t => {
  const f = fixture(t);
  f.add('first'); await finalizeStartupContextRun('first', f.ports);
  assert.equal([...f.pending.values()].filter(intent => intent.event === 'context-review.due').length, 0);
  f.add('second'); await finalizeStartupContextRun('second', f.ports);
  const events = listStartupContextReviewEvents(f.database);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].runIds, ['first', 'second']);
  const intents = [...f.pending.values()].filter(intent => intent.event === 'context-review.due');
  assert.equal(intents.length, 1);
  assert.equal(intents[0].id, events[0].id);
  assert.deepEqual(intents[0].payload, { to: 'main', runIds: ['first', 'second'] });
  assert.equal(JSON.stringify(intents).includes('task brief'), false);
  assert.equal(JSON.stringify(intents).includes('common brief'), false);
  const beforeRetry = structuredClone(intents);
  await finalizeStartupContextRun('second', f.ports);
  assert.deepEqual([...f.pending.values()].filter(intent => intent.event === 'context-review.due'), beforeRetry);
});

test('reservation binds the oldest unbound package and includes package ID and source runIds in the brief', t => {
  const f = fixture(t);
  const first = f.seedBatch('old', '2026-10-22T08:00:00.000Z');
  const second = f.seedBatch('new', '2026-10-22T09:00:00.000Z');
  const a = reserveStartupContextReview({ runId: 'review-a', phase: 'context-review', brief: 'Review startup context' }, f.ports);
  assert.equal(a.contextReviewId, first.event.id);
  assert.deepEqual(a.runIds, first.runIds);
  for (const identifier of [first.event.id, ...first.runIds]) assert.ok(a.brief.includes(identifier));
  assert.ok(a.brief.includes('Review startup context'));
  const b = reserveStartupContextReview({ runId: 'review-b', phase: 'context-review', brief: 'Review startup context' }, f.ports);
  assert.equal(b.contextReviewId, second.event.id);
  assert.deepEqual(b.runIds, second.runIds);
});

test('reservation refuses context-review without an open unbound package and explains why', t => {
  const f = fixture(t);
  assert.throws(() => reserveStartupContextReview({ runId: 'review', phase: 'context-review', brief: 'Review' }, f.ports), /(?:no|without|missing|unavailable).*(?:package|batch|review)|(?:package|batch|review).*(?:no|missing|unavailable)/i);
  f.seedBatch('batch');
  reserveStartupContextReview({ runId: 'review', phase: 'context-review', brief: 'Review' }, f.ports);
  assert.throws(() => reserveStartupContextReview({ runId: 'another', phase: 'context-review', brief: 'Review' }, f.ports), /package|batch|review/i);
});

test('successful reviewer finalize closes its bound package and excludes its run from the counter', async t => {
  const f = fixture(t);
  f.seedBatch('batch');
  reserveStartupContextReview({ runId: 'reviewer', phase: 'context-review', brief: 'Review' }, f.ports);
  f.add('reviewer', 'exited', 'context-review');
  await finalizeStartupContextRun('reviewer', f.ports);
  assert.ok(readStartupContextTrace(f.database, 'reviewer'));
  assert.deepEqual(pendingStartupContextRunIds(f.database), []);
  assert.equal(listStartupContextReviewEvents(f.database).length, 1);
  assert.throws(() => reserveStartupContextReview({ runId: 'next', phase: 'context-review', brief: 'Review' }, f.ports), /package|batch|review/i);
  f.add('ordinary'); await finalizeStartupContextRun('ordinary', f.ports);
  assert.deepEqual(pendingStartupContextRunIds(f.database), ['ordinary']);
});

for (const withReport of [true, false]) {
  test(`failed reviewer ${withReport ? 'with failed report' : 'without report'} releases binding and retains package for retry`, async t => {
    const f = fixture(t);
    const batch = f.seedBatch('batch');
    reserveStartupContextReview({ runId: 'reviewer', phase: 'context-review', brief: 'Review' }, f.ports);
    f.add('reviewer', 'exited', 'context-review'); f.failReport(withReport);
    const row = await finalizeStartupContextRun('reviewer', f.ports);
    assert.equal(row.state, 'finished');
    assert.equal(row.result?.status, 'failed');
    assert.equal((row.result?.proof as AgentReportResult).event, 'agent.failed');
    cleanupStartupContextCompleted('2026-10-23T10:00:00.000Z', f.ports);
    for (const runId of batch.runIds) assert.ok(readStartupContextTrace(f.database, runId));
    const retry = reserveStartupContextReview({ runId: 'retry', phase: 'context-review', brief: 'Review again' }, f.ports);
    assert.equal(retry.contextReviewId, batch.event.id);
    assert.deepEqual(retry.runIds, batch.runIds);
  });
}

test('cleanupCompleted prunes only traces of successfully closed packages with the same now', async t => {
  const f = fixture(t);
  const closed = f.seedBatch('closed');
  const open = f.seedBatch('open');
  reserveStartupContextReview({ runId: 'reviewer', phase: 'context-review', brief: 'Review' }, f.ports);
  f.add('reviewer', 'exited', 'context-review');
  await finalizeStartupContextRun('reviewer', f.ports);
  f.add('unbatched'); await finalizeStartupContextRun('unbatched', f.ports);
  const beforeExpiry = '2026-10-22T10:00:00.999Z';
  assert.equal(cleanupStartupContextCompleted(beforeExpiry, f.ports), 7);
  assert.equal(f.cleanupAt, beforeExpiry);
  for (const runId of closed.runIds) assert.ok(readStartupContextTrace(f.database, runId));
  const now = '2026-10-22T10:00:01.001Z';
  assert.equal(cleanupStartupContextCompleted(now, f.ports), 7);
  assert.equal(f.cleanupAt, now);
  for (const runId of closed.runIds) assert.equal(readStartupContextTrace(f.database, runId), null);
  for (const runId of [...open.runIds, 'unbatched']) assert.ok(readStartupContextTrace(f.database, runId));
});
