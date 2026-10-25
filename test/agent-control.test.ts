import assert from 'node:assert/strict';
import { test, before, after, mock } from 'node:test';
import { AgentControlService } from '../src/agent-control.ts';
import { commandFailure } from '../src/cli-contract.ts';
import type { ActivityEvent, AgentControlDependencies, DeliveryReceipt, VerifiedSender } from '../src/agent-control.ts';
import type { ProcessIdentity, ProcessObservation, SessionRecord, WorkResult } from '../src/session-state.ts';
import type { SessionCloseCheck, SessionEnd } from '../src/reminders.ts';

const time = '2026-10-21T10:00:00.000Z';
let externalRequests: ReturnType<typeof mock.method>;
before(() => { externalRequests = mock.method(globalThis, 'fetch', async () => { assert.fail('Unit agent control must not call external APIs or models'); }); });
after(() => { assert.equal(externalRequests.mock.callCount(), 0); externalRequests.mock.restore(); });
function session(addressId: string, project = 'raf'): SessionRecord {
  return { runId: `run-${addressId}`, addressId, revision: 1, state: 'running',
    activity: { type: addressId === 'main' ? 'main' : 'implement', project, features: ['messages'], phase: 'implement', cwd: '/workspace' },
    process: { pid: addressId === 'main' ? 100 : addressId.charCodeAt(0), startedAt: time, runner: 'codex', runnerSessionId: `cli-${addressId}`, tmuxSession: `tmux-${addressId}`, evidence: { token: addressId } } };
}

function fixture() {
  const records = new Map(['A', 'B', 'main'].map(id => { const row = session(id); return [row.runId, row]; }));
  const observations = new Map<string, ProcessObservation>();
  const scans: string[] = [];
  const deliveries: { target: ProcessIdentity; text: string }[] = [];
  const closed: ProcessIdentity[] = [];
  const interrupted: ProcessIdentity[] = [];
  const events: ActivityEvent[] = [];
  const ends: SessionEnd[] = [];
  const observed: ProcessObservation[] = [];
  const pendingChecks: string[] = [];
  const pendingReports = new Map<string, WorkResult>();
  let identity: VerifiedSender = { kind: 'agent', runId: 'run-A' };
  let receipt: DeliveryReceipt = { accepted: true, receiptId: 'receipt-1' };
  let closeCheck: SessionCloseCheck = { allowed: true, unfinished: [] };
  const trustedCaller = Object.freeze({ parentProcess: 700 });
  const dependencies: AgentControlDependencies = {
    repository: { transaction(operation) { return operation({
      getSession: id => structuredClone(records.get(id)), listSessions: () => structuredClone([...records.values()]),
      putSession: row => { records.set(row.runId, structuredClone(row)); }, deleteSession: id => { records.delete(id); },
      putReservation: () => {}, deleteReservation: () => {}, putPending: () => {}, deletePending: () => {}, listPending: () => [], applyEffects: () => {},
    }); } },
    coordinator: {
      async prepareClose(row) { return row; },
      async observe(row, observation) {
        observed.push(observation);
        const next = { ...row, observation, state: observation.state === 'exited' ? 'exited' as const : row.state };
        records.set(row.runId, next);
        return next;
      },
      async updateActivity(row, update, changes) {
        const next = { ...row, activity: { ...row.activity!, ...update } };
        records.set(row.runId, next);
        events.push(...changes);
        return next;
      },
      async finalize(row, changes) {
        const next = { ...row, state: 'finished' as const };
        records.set(row.runId, next);
        events.push(...changes);
        return next;
      },
      async publish(changes) { events.push(...changes); },
      async acceptPendingReport(row) {
        pendingChecks.push(row.runId);
        const result = pendingReports.get(row.runId);
        if (!result || row.result) return row;
        const next = { ...row, revision: row.revision + 1, result };
        records.set(row.runId, next);
        return next;
      },
    },
    scanner: { async inspect(process) {
      scans.push(process.runnerSessionId);
      return observations.get(process.runnerSessionId) ?? { state: 'alive', observedAt: time, identity: process };
    } },
    authority: { async resolve(caller) {
      assert.equal(caller, trustedCaller);
      return identity;
    } },
    transport: {
      async deliver(target, text) { deliveries.push({ target, text }); return receipt; },
      async close(target) { closed.push(target); },
      async interrupt(target) { interrupted.push(target); },
    },
    reminders: { sessionEnded(input) { ends.push(input); return closeCheck; } },
    projects: ['raf', 'other'], agentTypes: ['main', 'implement', 'review'],
  };
  const service = new AgentControlService(dependencies);
  return { service, dependencies, records, observations, scans, deliveries, closed, interrupted, events, ends, observed, trustedCaller, pendingChecks, pendingReports,
    sender(value: VerifiedSender) { identity = value; }, receipt(value: DeliveryReceipt) { receipt = value; },
    closeCheck(value: SessionCloseCheck) { closeCheck = value; } };
}

test('ps scans registered process identities and lists address IDs with activity, excluding finished and reserved sessions', async () => {
  const f = fixture();
  f.records.set('old', { ...session('old'), runId: 'old', state: 'finished' });
  f.records.set('reserved', { runId: 'reserved', addressId: 'reserved', revision: 0, state: 'reserved' });
  const rows = await f.service.ps();
  assert.deepEqual(rows.map(row => row.addressId).sort(), ['A', 'B', 'main']);
  assert.equal(rows[0].activity?.project, 'raf');
  assert.deepEqual(new Set(f.scans), new Set(['cli-A', 'cli-B', 'cli-main']));
});

test('empty ps succeeds', async () => {
  const f = fixture();
  f.records.clear();
  assert.deepEqual(await f.service.ps(), []);
});

test('worker-exit: ps lists a pending worker and other agents without finalizing or controlling it', async () => {
  const f = fixture();
  const before = structuredClone(f.records.get('run-A'));
  f.observations.set('cli-A', { state: 'exited', observedAt: time, exitCode: null, evidence: 'runner gone' });
  const observe = f.dependencies.coordinator.observe;
  f.dependencies.coordinator.observe = async (row, observation) => {
    if (row.runId === 'run-A') throw commandFailure({ code: 'WORKER_RESULT_PENDING', message: 'Worker still processing run-A', reason: 'Worker still processing run-A', stage: 'production-runtime', source: 'production-runtime', sourceCode: null, received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true, remediation: [] });
    return observe(row, observation);
  };
  const rows = await f.service.ps();
  assert.deepEqual(rows.map(row => row.addressId).sort(), ['A', 'B', 'main']);
  const pending = rows.find(row => row.addressId === 'A') as any;
  assert.deepEqual(pending.reconciliation, { code: 'WORKER_RESULT_PENDING', reason: 'Worker still processing run-A' });
  assert.equal(pending.observation.state, 'exited');
  assert.deepEqual(f.records.get('run-A'), before, 'ps must retain the worker reservation and durable session');
  assert.deepEqual(f.closed, []);
  assert.deepEqual(f.events, []);
});

test('worker-exit: ps does not swallow unrelated reconciliation failures', async () => {
  const f = fixture();
  f.dependencies.coordinator.observe = async () => { throw new Error('unexpected database failure'); };
  await assert.rejects(f.service.ps(), /unexpected database failure/);
});

for (const state of ['running', 'exited'] as const) for (const force of [false, true]) {
  test(`worker-exit: close finalizes a dead ${state} session with force=${force} after its worker is gone`, async () => {
    const f = fixture();
    f.records.get('run-A')!.state = state;
    f.observations.set('cli-A', { state: 'exited', observedAt: time, exitCode: null, evidence: 'runner and worker gone' });
    f.records.get('run-A')!.result = { status: 'failed', response: 'retained failed report', proof: { runId: 'run-A' } };
    const before = structuredClone(f.records.get('run-A')!.result);
    assert.deepEqual(await f.service.close('A', force ? { force: true, reason: 'recover dead worker' } : {}), { closed: true, unfinished: [], result: 'failed' });
    assert.equal(f.records.get('run-A')?.state, 'finished');
    assert.deepEqual(f.records.get('run-A')?.result, before);
    assert.deepEqual(f.closed, [], 'already dead processes need no tmux transport');
    assert.deepEqual(f.events.map(event => event.kind), ['ended']);
  });
}

test('confirmed process death delegates observation and final closure before ps returns', async () => {
  const f = fixture();
  f.observations.set('cli-A', { state: 'exited', observedAt: time, exitCode: 1, evidence: 'process absent' });
  assert.equal((await f.service.ps()).some(row => row.addressId === 'A'), false);
  assert.equal(f.records.get('run-A')?.state, 'finished');
  assert.deepEqual(f.ends, []);
  assert.deepEqual(f.events.map(event => [event.kind, event.session.addressId]), [['ended', 'A']]);
  await f.service.ps();
  assert.equal(f.events.length, 1);
  assert.equal(f.ends.length, 0);
});

test('unknown scan is an explicit uncertainty and never process death or a close', async () => {
  const f = fixture();
  f.observations.set('cli-B', { state: 'unknown', observedAt: time, error: 'permission denied' });
  await assert.rejects(() => f.service.message({ to: 'B', text: 'hello' }, f.trustedCaller));
  assert.equal(f.records.get('run-B')?.state, 'running');
  assert.deepEqual(f.ends, []);
  assert.deepEqual(f.deliveries, []);
  assert.deepEqual(f.events, []);
});

test('reused PID with different launch identity cannot receive a message', async () => {
  const f = fixture();
  const original = f.records.get('run-B')!.process!;
  f.observations.set('cli-B', { state: 'alive', observedAt: time, identity: { ...original, startedAt: '2026-10-21T11:00:00.000Z', runnerSessionId: 'unrelated' } });
  await assert.rejects(() => f.service.message({ to: 'B', text: 'hello' }, f.trustedCaller));
  assert.deepEqual(f.deliveries, []);
  assert.equal(f.records.get('run-B')?.state, 'finished');
});

test('message uses trusted caller identity and preserves shell text while stripping terminal controls', async () => {
  const f = fixture();
  const body = '[main] $(touch /tmp/should-not-exist) `id`\nsecond line';
  const receipt = await f.service.message({ to: 'main', text: `\u001b[31m${body}\u001b[0m`, from: 'raf' } as { to: string; text: string }, f.trustedCaller);
  assert.equal(receipt.accepted, true);
  assert.equal(f.deliveries[0].text, `[A] ${body}`);
  assert.equal(f.deliveries[0].target.runnerSessionId, 'cli-main');
  assert.ok(f.scans.includes('cli-A'));
  assert.ok(f.scans.includes('cli-main'));
});

for (const sender of [{ kind: 'agent', runId: 'run-main' }, { kind: 'system' }] as const) {
  test(`verified ${sender.kind === 'system' ? 'raf' : 'main'} sender receives reserved prefix`, async () => {
    const f = fixture();
    f.sender(sender);
    await f.service.message({ to: 'B', text: 'hello' }, f.trustedCaller);
    assert.equal(f.deliveries[0].text, `[${sender.kind === 'system' ? 'raf' : 'main'}] hello`);
  });
}

test('dead sender and unknown recipient fail without delivery', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.message({ to: 'missing', text: 'hello' }, f.trustedCaller));
  f.observations.set('cli-A', { state: 'exited', observedAt: time, exitCode: 0, evidence: 'gone' });
  await assert.rejects(() => f.service.message({ to: 'B', text: 'hello' }, f.trustedCaller));
  assert.deepEqual(f.deliveries, []);
});

test('unacknowledged delivery and busy foreign input cannot claim success', async () => {
  const f = fixture();
  for (const reason of ['not accepted', 'foreign input is busy']) {
    f.receipt({ accepted: false, reason });
    await assert.rejects(() => f.service.message({ to: 'B', text: 'hello' }, f.trustedCaller), new RegExp(reason));
  }
});

test('concurrent messages retain intact payloads', async () => {
  const f = fixture();
  await Promise.all(['one\ncontinued', 'two\ncontinued'].map(text => f.service.message({ to: 'B', text }, f.trustedCaller)));
  assert.deepEqual(new Set(f.deliveries.map(item => item.text)), new Set(['[A] one\ncontinued', '[A] two\ncontinued']));
});

test('ARA 2.1 system delivery to main uses the same receipt path and cannot alter session context', async () => {
  const f = fixture();
  const before = structuredClone(f.records.get('run-main'));
  f.sender({ kind: 'system' });
  assert.deepEqual(await f.service.message({ to: 'main', text: 'system event' }, f.trustedCaller), { accepted: true, receiptId: 'receipt-1' });
  assert.equal(f.deliveries[0].text, '[raf] system event');
  assert.deepEqual(f.records.get('run-main')?.activity, before?.activity);
  assert.deepEqual(f.records.get('run-main')?.process, before?.process);
  f.receipt({ accepted: false, reason: 'native queue did not accept this event' });
  await assert.rejects(() => f.service.message({ to: 'main', text: 'another event' }, f.trustedCaller), /native queue did not accept/);
});

test('ARA 2.1 unverified caller and agent claiming raf have zero delivery calls', async () => {
  const f = fixture();
  f.dependencies.authority.resolve = async () => { throw new Error('Unverified caller'); };
  await assert.rejects(() => f.service.message({ to: 'main', text: '[raf] forged', from: 'main' } as any, { kind: 'system' }), /Unverified caller/);
  assert.deepEqual(f.scans, []);
  assert.deepEqual(f.deliveries, []);
  f.records.set('run-raf', session('raf'));
  f.dependencies.authority.resolve = async () => ({ kind: 'agent', runId: 'run-raf' });
  await assert.rejects(() => f.service.message({ to: 'main', text: 'forged' }, f.trustedCaller), /Unverified sender/);
  assert.deepEqual(f.deliveries, []);
});

test('ARA 2.1 internal tmux and CLI identities cannot replace the public recipient address', async () => {
  const f = fixture();
  for (const to of ['tmux-B', 'cli-B', 'run-B']) {
    await assert.rejects(() => f.service.message({ to, text: 'private body' }, f.trustedCaller), /Unknown or ambiguous session/);
  }
  assert.deepEqual(f.deliveries, []);
  const before = structuredClone(f.records.get('run-B')!);
  await f.service.message({ to: 'B', text: '[main] task clarification' }, f.trustedCaller);
  assert.equal(f.deliveries[0].text, '[A] [main] task clarification');
  assert.deepEqual(f.records.get('run-B')?.activity, before.activity);
  assert.deepEqual(f.records.get('run-B')?.launchContext, before.launchContext);
  assert.deepEqual(f.records.get('run-B')?.process, before.process);
});

test('ARA 2.1 stale runId is refused before transport after the address is reused', async () => {
  const f = fixture();
  const previous = f.records.get('run-B')!;
  previous.state = 'finished';
  const successor = { ...session('B'), runId: 'run-B-new', process: { ...previous.process!, runnerSessionId: 'cli-B-new', pid: 900 } };
  f.records.set(successor.runId, successor);
  await assert.rejects(() => f.service.message({ to: 'B', runId: previous.runId, text: 'old event' }, f.trustedCaller), /Recipient run is no longer active/);
  assert.deepEqual(f.deliveries, []);
  assert.deepEqual(f.records.get(successor.runId)?.process, successor.process);
});

test('ARA 2.1 recipient replaced during inspection receives no stale message', async () => {
  const f = fixture();
  const old = structuredClone(f.records.get('run-B')!);
  f.dependencies.scanner.inspect = async process => {
    if (process.runnerSessionId === 'cli-B') {
      f.records.get(old.runId)!.state = 'finished';
      f.records.set('run-B-new', { ...session('B'), runId: 'run-B-new', process: { ...old.process!, pid: 901, runnerSessionId: 'cli-B-new' } });
    }
    return { state: 'alive', observedAt: time, identity: process };
  };
  const result = await Promise.allSettled([f.service.message({ to: 'B', text: 'for old B' }, f.trustedCaller)]);
  assert.deepEqual(f.deliveries, [], 'an identity snapshot cannot authorize delivery after the active run changed');
  assert.equal(result[0].status, 'rejected', 'a replaced recipient must not produce accepted:true');
});

test('ARA 2.1 recipient replaced before receipt cannot acknowledge the old run or redirect to successor', async () => {
  const f = fixture();
  const old = structuredClone(f.records.get('run-B')!);
  const successor = { ...session('B'), runId: 'run-B-new', process: { ...old.process!, pid: 902, runnerSessionId: 'cli-B-new' } };
  f.dependencies.transport.deliver = async (target, text) => {
    f.deliveries.push({ target, text });
    f.records.get(old.runId)!.state = 'finished';
    f.records.set(successor.runId, structuredClone(successor));
    return { accepted: true, receiptId: 'receipt-for-old-run' };
  };
  const result = await Promise.allSettled([f.service.message({ to: 'B', text: 'do not forward' }, f.trustedCaller)]);
  assert.deepEqual(f.deliveries.map(value => value.target.runnerSessionId), ['cli-B']);
  assert.deepEqual(f.records.get(successor.runId), successor, 'successor input and context stay untouched');
  assert.equal(result[0].status, 'rejected', 'transport receipt cannot replace a current runId check');
});

test('ARA 2.1 delivery propagates structured failure facts without retrying the literal body', async () => {
  const f = fixture();
  const error = commandFailure({ code: 'DELIVERY_UNCONFIRMED', message: 'native acceptance unknown', reason: 'composer retained text', stage: 'delivery', source: 'adapter', sourceCode: null, received: null, expected: null, found: null, completed: ['inserted'], pending: ['acceptance'], retrySafe: false, remediation: ['inspect the original run'] });
  let attempts = 0;
  f.dependencies.transport.deliver = async () => { attempts++; throw error; };
  await assert.rejects(() => f.service.message({ to: 'B', text: 'literal $(no-execution)' }, f.trustedCaller), value => value === error);
  assert.equal(attempts, 1, 'unconfirmed acceptance cannot cause automatic reinsertion');
});

test('update changes only activity and creates old-project end and new-project start events', async () => {
  const f = fixture();
  const initial = { ...f.records.get('run-A')!, brief: 'original brief', assignment: ['change:1'], reportPath: '/reports/A.json' };
  f.records.set('run-A', initial);
  const changed = await f.service.update('A', { project: 'other', features: ['control'], phase: 'review' });
  assert.deepEqual(changed.activity, { ...initial.activity, project: 'other', features: ['control'], phase: 'review' });
  const stored = f.records.get('run-A') as typeof initial;
  assert.equal(stored.brief, initial.brief);
  assert.deepEqual(stored.assignment, initial.assignment);
  assert.equal(stored.reportPath, initial.reportPath);
  assert.equal(stored.runId, initial.runId);
  assert.deepEqual(f.events.map(event => [event.kind, event.project]), [['ended', 'raf'], ['started', 'other']]);
  assert.equal(changed.activity?.type, 'implement');
});

test('same-project feature or phase change publishes one activity update', async () => {
  const f = fixture();
  await f.service.update('A', { project: 'raf', features: ['control'], phase: 'review' });
  assert.deepEqual(f.events.map(event => [event.kind, event.project]), [['updated', 'raf']]);
});

test('invalid project, empty features, and phase outside shared vocabulary do not mutate activity', async () => {
  const f = fixture();
  const before = structuredClone(f.records.get('run-A')?.activity);
  for (const update of [
    { project: 'unknown', features: ['x'], phase: 'review' },
    { project: 'raf', features: [], phase: 'review' },
    { project: 'raf', features: [' '], phase: 'review' },
    { project: 'raf', features: ['x'], phase: 'invented-phase' },
  ]) await assert.rejects(() => f.service.update('A', update));
  assert.deepEqual(f.records.get('run-A')?.activity, before);
  assert.deepEqual(f.events, []);
});

test('started hook publishes verified system activity for a running session only', async () => {
  const f = fixture();
  await f.service.started('run-A');
  assert.deepEqual(f.events.map(event => [event.kind, event.project, event.session.addressId]), [['started', 'raf', 'A']]);
  await assert.rejects(() => f.service.started('missing'));
});

test('main is protected from ordinary close and interrupt', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.close('main'));
  await assert.rejects(() => f.service.interrupt('main'));
  assert.deepEqual(f.closed, []);
  assert.deepEqual(f.interrupted, []);
  assert.deepEqual(f.ends, []);
});

test('pending reminders block close and are delivered without a final end event', async () => {
  const f = fixture();
  const reminder = { id: 'r1', createdFor: 'A', assignedTo: 'A', text: 'Handle this', at: '2026-10-22T10:00:00.000Z', binding: null, state: 'pending' as const, closedAt: null, closeReason: null };
  f.closeCheck({ allowed: false, unfinished: [reminder] });
  assert.deepEqual(await f.service.close('A'), { closed: false, unfinished: [reminder] });
  assert.equal(f.closed.length, 0);
  assert.equal(f.events.length, 0);
  assert.ok(f.deliveries.some(item => item.text.startsWith('[raf]') && item.text.includes('Handle this')));
  assert.equal(f.records.get('run-A')?.state, 'running');
});

test('accepted work success is supplied to reminders before orderly closure', async () => {
  const f = fixture();
  f.records.get('run-A')!.result = { status: 'succeeded', response: 'done', proof: { verified: true } };
  const result = await f.service.close('A');
  assert.equal(result.closed, true);
  assert.deepEqual(f.ends, [{ address: 'A', crashed: false, confirmedSucceeded: true }]);
  assert.equal(f.closed.length, 1);
  assert.ok(f.scans.includes('cli-A'));
  assert.equal(f.records.get('run-A')?.state, 'finished');
  assert.deepEqual(f.events.map(event => event.kind), ['ended']);
});

test('interrupt preserves session identity, result and reminders without final events', async () => {
  const f = fixture();
  const before = structuredClone(f.records.get('run-A'));
  await f.service.interrupt('A');
  assert.equal(f.interrupted[0].runnerSessionId, 'cli-A');
  assert.equal(f.records.get('run-A')?.state, 'running');
  assert.deepEqual(f.records.get('run-A')?.process, before?.process);
  assert.deepEqual(f.ends, []);
  assert.deepEqual(f.events, []);
});

test('ps retains a session with unknown scan evidence without claiming process death', async () => {
  const f = fixture();
  const observation: ProcessObservation = { state: 'unknown', observedAt: time, error: 'scanner unavailable' };
  f.observations.set('cli-A', observation);
  const row = (await f.service.ps()).find(value => value.addressId === 'A');
  assert.equal(row?.state, 'running');
  assert.deepEqual(row?.observation, observation);
  assert.deepEqual(f.ends, []);
  assert.deepEqual(f.events, []);
});

for (const command of ['close', 'interrupt'] as const) {
  test(`${command} never controls an unrelated process with a reused PID`, async () => {
    const f = fixture();
    const original = f.records.get('run-A')!.process!;
    f.observations.set('cli-A', { state: 'alive', observedAt: time, identity: { ...original, evidence: { token: 'foreign' } } });
    await f.service[command]('A').catch(() => {});
    assert.deepEqual(f.closed, []);
    assert.deepEqual(f.interrupted, []);
    assert.ok(f.scans.includes('cli-A'));
    assert.equal(f.records.get('run-A')?.state, 'finished');
  });
}

const reported = (row: SessionRecord): SessionRecord => ({ ...row, launchContext: {
  assignment: { root: '/workspace', baselineArchives: [], changes: [{ id: 'messages', items: [{ id: '1.1', description: 'Deliver' }] }] },
  selection: { runner: 'codex', model: 'gpt', effort: 'high', reason: 'test' }, briefPath: `/tmp/${row.runId}/brief.txt`, reportPath: `/tmp/${row.runId}/${row.addressId}.json`,
} });
const succeeded: WorkResult = { status: 'succeeded', response: 'Done after the watcher died', proof: { runId: 'run-A', at: time } };

test('[pending-report] ps accepts a pending report of a running session without result and lists it with that result', async () => {
  const f = fixture();
  f.records.set('run-A', reported(session('A')));
  f.pendingReports.set('run-A', succeeded);
  const rows = await f.service.ps();
  const row = rows.find(candidate => candidate.addressId === 'A');
  assert.equal(row?.state, 'running', 'the interactive runner stays open until closure');
  assert.deepEqual(row?.result, succeeded);
  assert.deepEqual(f.records.get('run-A')?.result, succeeded);
  assert.ok(f.pendingChecks.includes('run-A'));
});

test('[pending-report] ps asks only sessions that have a report path and no result yet', async () => {
  const f = fixture();
  f.records.set('run-A', { ...reported(session('A')), result: succeeded });
  f.records.set('run-B', reported(session('B')));
  await f.service.ps();
  assert.deepEqual(f.pendingChecks, ['run-B'], 'A already has a result; main has no report path');
  assert.deepEqual(f.records.get('run-A')?.result, succeeded);
  assert.equal(f.records.get('run-B')?.result, undefined, 'no report, no result');
});

test('[pending-report] a report written before the runner exited is accepted before final closure instead of a failed result', async () => {
  const f = fixture();
  f.records.set('run-A', reported(session('A')));
  f.pendingReports.set('run-A', succeeded);
  f.observations.set('cli-A', { state: 'exited', observedAt: time, exitCode: 0, evidence: 'process absent' });
  await f.service.ps();
  assert.equal(f.records.get('run-A')?.state, 'finished');
  assert.deepEqual(f.records.get('run-A')?.result, succeeded);
});

test('[pending-report] close accepts a pending report and closes with its result', async () => {
  const f = fixture();
  f.records.set('run-A', reported(session('A')));
  f.pendingReports.set('run-A', succeeded);
  const closed = await f.service.close('A');
  assert.deepEqual(closed, { closed: true, unfinished: [], result: 'succeeded' });
  assert.deepEqual(f.ends.map(end => end.confirmedSucceeded), [true], 'reminder closure sees the accepted success');
  assert.equal(f.closed.length, 1);
  assert.deepEqual(f.records.get('run-A')?.result, succeeded);
});
