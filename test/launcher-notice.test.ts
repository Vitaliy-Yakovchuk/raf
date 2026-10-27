import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { commandFixture, type CommandFixture, type Delivery } from './reminder-fixture.ts';
import { createSessionState, type SessionRecord, type WorkResult } from '../src/session-state.ts';
import { DEFAULT_LAUNCHER, NO_REPORT_REASON, resultAddressee, resultNoticeText, type NotifyTarget, type PsSessionView, type SessionNotify } from '../src/launcher-notice.ts';

const change = 'notify-fixture';
const itemIds = ['2.1', '2.2'];
const items = itemIds.map(id => `${change}:${id}`);

type Setup = { delegatedBy?: NotifyTarget; launchedBy?: NotifyTarget; notify?: NotifyTarget };
type Launched = SessionRecord & SessionNotify & { reportPath: string };

function launched(f: CommandFixture, address: string, setup: Setup = {}): Launched {
  const base = f.session(address);
  const reportPath = join(dirname(f.statePath), 'tmp', base.runId, `${address}.json`);
  const record: SessionRecord & SessionNotify = {
    ...base,
    revision: base.revision + 1,
    launchContext: {
      assignment: { root: f.root, changes: [{ id: change, items: itemIds.map(id => ({ id, description: `Пункт ${id}` })) }], baselineArchives: [] },
      selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reason: 'fixture' },
      briefPath: join(dirname(f.statePath), 'tmp', base.runId, 'brief.txt'),
      reportPath,
    },
    ...(setup.delegatedBy ? { delegatedBy: { ...setup.delegatedBy, fence: `fence-${setup.delegatedBy.runId}` } } : {}),
    ...(setup.launchedBy ? { launchedBy: setup.launchedBy } : {}),
    ...(setup.notify ? { notify: setup.notify } : {}),
  };
  f.store.sessionRepository.transaction(tx => tx.putSession(record));
  return { ...record, reportPath };
}

const target = (session: SessionRecord): NotifyTarget => ({ addressId: session.addressId, runId: session.runId });

function accept(f: CommandFixture, session: Launched, status: 'succeeded' | 'failed', answer: string) {
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  const report = { status, answer, changes: [{ id: change, items: itemIds.map(id => ({ id, status })) }] };
  const result: WorkResult = { status, response: answer, proof: { reportPath: session.reportPath, report } };
  assert.equal(state.acceptWorkResult(session.runId, result, { pending: [], domain: [] }), true, 'fixture report must be accepted');
}

const of = (f: CommandFixture, session: { reportPath: string }) => f.deliveries.filter(item => item.text.includes(session.reportPath));
const accepted = (deliveries: Delivery[], to: string) => deliveries.filter(item => item.accepted && item.to === to);
const others = (deliveries: Delivery[], to: string) => deliveries.filter(item => item.to !== to);

function assertNotice(delivery: Delivery | undefined, session: { addressId: string; reportPath: string }, status: string, extra: readonly string[]) {
  assert.ok(delivery, `result notice for ${session.addressId} must be delivered`);
  assert.deepEqual(delivery.sender, { kind: 'system' }, 'result notice is a raf event, not a message of another agent');
  for (const part of [session.addressId, status, session.reportPath, ...items, ...extra]) assert.ok(delivery.text.includes(part), `notice must contain ${part}: ${delivery.text}`);
}

function row(rows: SessionRecord[], runId: string): PsSessionView {
  const found = rows.find(item => item.runId === runId);
  assert.ok(found, `agent ps must list ${runId}`);
  return found as PsSessionView;
}

test('[result-notice] addressee is the --notify agent, otherwise the launcher by delegatedBy or launchedBy, otherwise main; liveness never redirects', () => {
  const at = (runId: string, addressId: string): SessionRecord => ({ runId, addressId, revision: 1, state: 'running' });
  const child = (setup: Partial<SessionRecord & SessionNotify>): SessionRecord & SessionNotify => ({ ...at('run-child', 'child'), ...setup });
  const coord = { addressId: 'coord', runId: 'run-coord' };
  const observer = { addressId: 'observer', runId: 'run-observer' };
  assert.equal(DEFAULT_LAUNCHER, 'main');
  assert.equal(resultAddressee(child({})).addressId, 'main');
  assert.deepEqual(resultAddressee(child({ delegatedBy: { ...coord, fence: 'f' } })), coord);
  assert.deepEqual(resultAddressee(child({ launchedBy: coord })), coord);
  assert.deepEqual(resultAddressee(child({ launchedBy: coord, notify: observer })), observer);
  assert.deepEqual(resultAddressee(child({ delegatedBy: { ...coord, fence: 'f' }, launchedBy: coord, notify: observer })), observer);
  assert.deepEqual(resultAddressee(child({ notify: observer })), observer);
});

test('[result-notice] notice text carries the agent ID, result, items, report path, answer and reason', () => {
  const answer = 'Тести готові, червоні через відсутню поведінку';
  const success = resultNoticeText({ address: 'worker', status: 'succeeded', items, reportPath: '/tmp/run/worker.json', answer, reason: null });
  for (const part of ['worker', 'succeeded', ...items, '/tmp/run/worker.json', answer]) assert.ok(success.includes(part), `${part}: ${success}`);
  const crash = resultNoticeText({ address: 'worker', status: 'failed', items, reportPath: '/tmp/run/worker.json', answer: '', reason: NO_REPORT_REASON });
  for (const part of ['worker', 'failed', ...items, '/tmp/run/worker.json', NO_REPORT_REASON]) assert.ok(crash.includes(part), `${part}: ${crash}`);
});

test('[Z.125] first durable failure notice keeps the launch cause when exit precedes result acceptance', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const worker = launched(f, 'worker');
  const cause = 'State store sessionTransaction failed (SQLite 5)';
  f.store.sessionRepository.transaction(tx => tx.putSession({ ...worker, abortReason: cause, state: 'exited',
    observation: { state: 'exited', observedAt: '2026-10-23T04:45:26.000Z', exitCode: null, evidence: cause } }));
  const first = f.store.resultNotices.list().find(notice => notice.runId === worker.runId)!;
  assert.match(first.text, /Reason: State store sessionTransaction failed \(SQLite 5\)/);
  assert.ok(!first.text.includes(NO_REPORT_REASON));
  accept(f, worker, 'failed', cause);
  assert.equal(f.store.resultNotices.list().find(notice => notice.runId === worker.runId)?.text, first.text);
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`[result-notice] accepted ${status} report of an agent launched by main reaches main once while the agent stays open and peers hear nothing`, async t => {
    const f = await commandFixture(t);
    f.session('main', { project: 'orchestrator' });
    f.session('reviewer');
    const worker = launched(f, 'worker');
    const answer = `Відповідь звіту ${status}`;
    accept(f, worker, status, answer);
    await f.settle();
    await f.settle(f.separateProcess());
    await f.agentPs();
    const notices = of(f, worker);
    assert.equal(notices.length, 1, `exactly one result notice attempt: ${JSON.stringify(notices)}`);
    assertNotice(accepted(notices, 'main')[0], worker, status, [answer]);
    assert.deepEqual(f.deliveries.filter(item => item.to === 'reviewer'), [], 'Q48: peers are notified only after closure');
    assert.equal(f.getSession(worker.runId)?.state, 'running', 'the agent stays open until closure');
  });
}

test('[result-notice] accepted report of a delegated or launched child reaches its coordinator, not main', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const coord = f.session('coord');
  const delegated = launched(f, 'delegated', { delegatedBy: target(coord) });
  const child = launched(f, 'child', { launchedBy: target(coord) });
  accept(f, delegated, 'succeeded', 'Делеговані пункти виконано');
  accept(f, child, 'failed', 'Пункт суперечить специфікації');
  await f.settle();
  await f.agentPs();
  for (const [session, status, answer] of [[delegated, 'succeeded', 'Делеговані пункти виконано'], [child, 'failed', 'Пункт суперечить специфікації']] as const) {
    const notices = of(f, session);
    assert.equal(notices.length, 1, `${session.addressId}: ${JSON.stringify(notices)}`);
    assertNotice(accepted(notices, 'coord')[0], session, status, [answer]);
    assert.deepEqual(others(notices, 'coord'), []);
  }
});

test('[result-notice] --notify addressee gets the result instead of the launcher', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const coord = f.session('coord');
  const observer = f.session('observer');
  const byCoord = launched(f, 'by-coord', { launchedBy: target(coord), notify: target(observer) });
  const byMain = launched(f, 'by-main', { notify: target(observer) });
  accept(f, byCoord, 'succeeded', 'Результат для observer від дитини coord');
  accept(f, byMain, 'failed', 'Результат для observer від агента main');
  await f.settle();
  await f.agentPs();
  for (const [session, status, answer] of [[byCoord, 'succeeded', 'Результат для observer від дитини coord'], [byMain, 'failed', 'Результат для observer від агента main']] as const) {
    const notices = of(f, session);
    assert.equal(notices.length, 1, `${session.addressId}: ${JSON.stringify(notices)}`);
    assertNotice(accepted(notices, 'observer')[0], session, status, [answer]);
    assert.deepEqual(others(notices, 'observer'), [], 'the launcher and main do not get the result of a --notify launch');
  }
});

test('[result-notice] closed addressee leaves the notice undelivered in agent ps with addressee and reason, never redirected to main', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const coord = f.session('coord');
  const child = launched(f, 'child', { launchedBy: target(coord) });
  f.finish(coord);
  f.kill(coord.process);
  accept(f, child, 'succeeded', 'Готово після закриття координатора');
  await f.settle();
  const first = row(await f.agentPs(), child.runId).resultNotice;
  f.advance(61 * 60_000);
  await f.settle(f.separateProcess());
  const later = row(await f.agentPs(), child.runId).resultNotice;
  for (const view of [first, later]) {
    assert.ok(view, 'agent ps shows the undelivered result notice');
    assert.equal(view.state, 'undelivered');
    assert.equal(view.recipient, 'coord');
    assert.ok(typeof view.lastError === 'string' && view.lastError.length > 0, JSON.stringify(view));
  }
  assert.deepEqual(accepted(of(f, child), 'main'), [], 'no redirect to main');
  assert.deepEqual(others(of(f, child), 'coord'), [], 'no attempt to any other agent');
});

test('[result-notice] unconfirmed delivery to a live coordinator is visible in agent ps, retried and not redirected to main', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const coord = f.session('coord');
  const child = launched(f, 'child', { delegatedBy: target(coord) });
  f.accept(request => request.to !== 'coord');
  accept(f, child, 'succeeded', 'Координатор не підтвердив доставку');
  await f.settle();
  const pending = row(await f.agentPs(), child.runId).resultNotice;
  assert.ok(pending, 'agent ps shows the unconfirmed result notice');
  assert.equal(pending.state, 'pending');
  assert.equal(pending.recipient, 'coord');
  assert.ok(pending.attempts >= 1, JSON.stringify(pending));
  assert.ok(typeof pending.lastError === 'string' && pending.lastError.length > 0, JSON.stringify(pending));
  const attempts = of(f, child).length;
  f.advance(61 * 60_000);
  await f.agentPs();
  assert.ok(of(f, child).length > attempts, 'the hourly agent ps check retries the unconfirmed notice');
  assert.deepEqual(others(of(f, child), 'coord'), [], 'no redirect to main or anyone else');
  f.accept(() => true);
  f.advance(61 * 60_000);
  await f.settle(f.separateProcess());
  const rows = await f.agentPs();
  assert.equal(accepted(of(f, child), 'coord').length, 1);
  assertNotice(accepted(of(f, child), 'coord')[0], child, 'succeeded', ['Координатор не підтвердив доставку']);
  assert.notEqual(row(rows, child.runId).resultNotice?.state, 'pending', 'confirmed notice is no longer pending');
  await f.settle(f.separateProcess());
  assert.equal(accepted(of(f, child), 'coord').length, 1, 'confirmed notice is never repeated');
  assert.deepEqual(others(of(f, child), 'coord'), []);
});

test('[result-notice] unconfirmed delivery to main is retried until confirmed once', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const worker = launched(f, 'worker');
  f.accept(request => request.to !== 'main');
  accept(f, worker, 'succeeded', 'Звіт до недоступного main');
  await f.settle();
  const pending = row(await f.agentPs(), worker.runId).resultNotice;
  assert.equal(pending?.state, 'pending');
  assert.equal(pending?.recipient, 'main');
  const attempts = of(f, worker).length;
  f.advance(61 * 60_000);
  await f.agentPs();
  assert.ok(of(f, worker).length > attempts, 'retried');
  f.accept(() => true);
  f.advance(61 * 60_000);
  await f.settle(f.separateProcess());
  await f.agentPs();
  assert.equal(accepted(of(f, worker), 'main').length, 1);
  assertNotice(accepted(of(f, worker), 'main')[0], worker, 'succeeded', ['Звіт до недоступного main']);
});

test('[result-notice] crash without a report notifies the addressee once with failed and the reason; Q48 peers get only the closure notice', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const reviewer = f.session('reviewer');
  const coord = f.session('coord');
  const observer = f.session('observer');
  const worker = launched(f, 'worker');
  const child = launched(f, 'child', { delegatedBy: target(coord) });
  const watched = launched(f, 'watched', { launchedBy: target(coord), notify: target(observer) });
  for (const session of [worker, child, watched]) f.kill(session.process);
  await f.agentPs();
  await f.agentPs();
  await f.settle(f.separateProcess());
  for (const [session, recipient] of [[worker, 'main'], [child, 'coord'], [watched, 'observer']] as const) {
    const notices = of(f, session);
    assert.equal(notices.length, 1, `${session.addressId}: ${JSON.stringify(notices)}`);
    assertNotice(accepted(notices, recipient)[0], session, 'failed', [NO_REPORT_REASON]);
  }
  const peer = accepted(f.deliveries, reviewer.addressId);
  assert.ok(['worker', 'child', 'watched'].every(address => peer.some(item => item.text.includes(address))), `Q48 closure notices reach peers: ${JSON.stringify(peer)}`);
  assert.equal(peer.filter(item => [worker, child, watched].some(session => item.text.includes(session.reportPath))).length, 0, 'peers never get the result notice');
});
