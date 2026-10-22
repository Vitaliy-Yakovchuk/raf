import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { commandFixture, type CommandFixture, type Delivery } from './reminder-fixture.ts';
import { createSessionState, type SessionRecord, type WorkResult } from '../src/session-state.ts';
import { LAUNCHER_FALLBACK, NO_REPORT_REASON, launcherNoticeText, launcherRecipient, type PsSessionView } from '../src/launcher-notice.ts';

const change = 'notify-fixture';
const itemIds = ['2.1', '2.2'];
const items = itemIds.map(id => `${change}:${id}`);

type Launcher = { addressId: string; runId: string };
type Setup = { delegatedBy?: Launcher; launchedBy?: Launcher };

function launched(f: CommandFixture, address: string, setup: Setup = {}): SessionRecord & { reportPath: string } {
  const base = f.session(address);
  const reportPath = join(f.root, 'tmp', base.runId, `${address}.json`);
  const record: SessionRecord = {
    ...base,
    revision: base.revision + 1,
    launchContext: {
      assignment: { root: f.root, changes: [{ id: change, items: itemIds.map(id => ({ id, description: `Пункт ${id}` })) }], baselineArchives: [] },
      selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reason: 'fixture' },
      briefPath: join(f.root, 'tmp', base.runId, 'brief.md'),
      reportPath,
    },
    ...(setup.delegatedBy ? { delegatedBy: { ...setup.delegatedBy, fence: `fence-${setup.delegatedBy.runId}` } } : {}),
    ...(setup.launchedBy ? { launchedBy: setup.launchedBy } : {}),
  };
  f.store.sessionRepository.transaction(tx => tx.putSession(record));
  return { ...record, reportPath };
}

function accept(f: CommandFixture, session: SessionRecord & { reportPath: string }, status: 'succeeded' | 'failed', answer: string) {
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  const report = { status, answer, changes: [{ id: change, items: itemIds.map(id => ({ id, status })) }] };
  const result: WorkResult = { status, response: answer, proof: { reportPath: session.reportPath, report } };
  assert.equal(state.acceptWorkResult(session.runId, result, { pending: [], domain: [] }), true, 'fixture report must be accepted');
}

const of = (f: CommandFixture, session: { reportPath: string }) => f.deliveries.filter(item => item.text.includes(session.reportPath));
const accepted = (deliveries: Delivery[], to: string) => deliveries.filter(item => item.accepted && item.to === to);

function assertNotice(delivery: Delivery | undefined, session: { addressId: string; reportPath: string }, status: string, extra: readonly string[]) {
  assert.ok(delivery, `launcher notice for ${session.addressId} must be delivered`);
  assert.deepEqual(delivery.sender, { kind: 'system' }, 'launcher notice is a raf event, not a message of another agent');
  for (const part of [session.addressId, status, session.reportPath, ...items, ...extra]) assert.ok(delivery.text.includes(part), `notice must contain ${part}: ${delivery.text}`);
}

function row(rows: SessionRecord[], runId: string): PsSessionView {
  const found = rows.find(item => item.runId === runId);
  assert.ok(found, `agent ps must list ${runId}`);
  return found as PsSessionView;
}

test('[launcher-notice] recipient is main without a launcher, the live coordinator by delegatedBy or launchedBy, and main once that run is gone', () => {
  const at = (runId: string, addressId: string, state: SessionRecord['state']): SessionRecord => ({ runId, addressId, revision: 1, state });
  const coord = at('run-coord', 'coord', 'running');
  const child = (setup: Partial<SessionRecord>): SessionRecord => ({ ...at('run-child', 'child', 'running'), ...setup });
  assert.equal(LAUNCHER_FALLBACK, 'main');
  assert.equal(launcherRecipient(child({}), [coord]), 'main');
  assert.equal(launcherRecipient(child({ delegatedBy: { addressId: 'coord', runId: 'run-coord', fence: 'f' } }), [coord]), 'coord');
  assert.equal(launcherRecipient(child({ launchedBy: { addressId: 'coord', runId: 'run-coord' } }), [coord]), 'coord');
  assert.equal(launcherRecipient(child({ launchedBy: { addressId: 'coord', runId: 'run-coord' } }), [at('run-coord', 'coord', 'finished')]), 'main');
  assert.equal(launcherRecipient(child({ launchedBy: { addressId: 'coord', runId: 'run-coord' } }), []), 'main');
  assert.equal(launcherRecipient(child({ delegatedBy: { addressId: 'coord', runId: 'run-coord', fence: 'f' } }), [at('run-coord', 'coord', 'finished'), at('run-coord-2', 'coord', 'running')]), 'main');
});

test('[launcher-notice] notice text carries the agent ID, result, items, report path, answer and reason', () => {
  const answer = 'Тести готові, червоні через відсутню поведінку';
  const success = launcherNoticeText({ address: 'worker', status: 'succeeded', items, reportPath: '/tmp/run/worker.json', answer, reason: null });
  for (const part of ['worker', 'succeeded', ...items, '/tmp/run/worker.json', answer]) assert.ok(success.includes(part), `${part}: ${success}`);
  const crash = launcherNoticeText({ address: 'worker', status: 'failed', items, reportPath: '/tmp/run/worker.json', answer: '', reason: NO_REPORT_REASON });
  for (const part of ['worker', 'failed', ...items, '/tmp/run/worker.json', NO_REPORT_REASON]) assert.ok(crash.includes(part), `${part}: ${crash}`);
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`[launcher-notice] accepted ${status} report of a main-launched agent reaches main once while the agent stays open and peers hear nothing`, async t => {
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
    assert.equal(notices.length, 1, `exactly one launcher notice attempt: ${JSON.stringify(notices)}`);
    assertNotice(accepted(notices, 'main')[0], worker, status, [answer]);
    assert.deepEqual(f.deliveries.filter(item => item.to === 'reviewer'), [], 'Q48: peers are notified only after closure');
    assert.equal(f.getSession(worker.runId)?.state, 'running', 'the agent stays open until closure');
  });
}

test('[launcher-notice] accepted report of a delegated or launched child reaches its live coordinator, not main', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const coord = f.session('coord');
  const delegated = launched(f, 'delegated', { delegatedBy: { addressId: 'coord', runId: coord.runId } });
  const child = launched(f, 'child', { launchedBy: { addressId: 'coord', runId: coord.runId } });
  accept(f, delegated, 'succeeded', 'Делеговані пункти виконано');
  accept(f, child, 'failed', 'Пункт суперечить специфікації');
  await f.settle();
  await f.agentPs();
  for (const [session, status, answer] of [[delegated, 'succeeded', 'Делеговані пункти виконано'], [child, 'failed', 'Пункт суперечить специфікації']] as const) {
    const notices = of(f, session);
    assert.equal(notices.length, 1, `${session.addressId}: ${JSON.stringify(notices)}`);
    assertNotice(accepted(notices, 'coord')[0], session, status, [answer]);
    assert.deepEqual(accepted(notices, 'main'), []);
  }
});

test('[launcher-notice] child of a closed coordinator notifies main', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const coord = f.session('coord');
  const child = launched(f, 'child', { launchedBy: { addressId: 'coord', runId: coord.runId } });
  f.finish(coord);
  f.kill(coord.process);
  accept(f, child, 'succeeded', 'Готово після закриття координатора');
  await f.settle();
  await f.agentPs();
  const notices = of(f, child);
  assert.equal(accepted(notices, 'main').length, 1, JSON.stringify(notices));
  assertNotice(accepted(notices, 'main')[0], child, 'succeeded', ['Готово після закриття координатора']);
  assert.deepEqual(accepted(notices, 'coord'), []);
});

test('[launcher-notice] unconfirmed delivery to the coordinator falls back to main', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const coord = f.session('coord');
  const child = launched(f, 'child', { delegatedBy: { addressId: 'coord', runId: coord.runId } });
  f.accept(request => request.to !== 'coord');
  accept(f, child, 'succeeded', 'Координатор не підтвердив доставку');
  await f.settle();
  await f.agentPs();
  const notices = of(f, child);
  assert.deepEqual(accepted(notices, 'coord'), []);
  assert.equal(accepted(notices, 'main').length, 1, JSON.stringify(notices));
  assertNotice(accepted(notices, 'main')[0], child, 'succeeded', ['Координатор не підтвердив доставку']);
});

test('[launcher-notice] unconfirmed delivery to main stays visible in agent ps and is retried until confirmed once', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const worker = launched(f, 'worker');
  f.accept(request => request.to !== 'main');
  accept(f, worker, 'succeeded', 'Звіт до недоступного main');
  await f.settle();
  const pending = row(await f.agentPs(), worker.runId).launcherNotice;
  assert.ok(pending, 'agent ps shows the launcher notice of the worker');
  assert.equal(pending.state, 'pending');
  assert.equal(pending.recipient, 'main');
  assert.ok(pending.attempts >= 1, JSON.stringify(pending));
  assert.ok(typeof pending.lastError === 'string' && pending.lastError.length > 0, JSON.stringify(pending));
  assert.deepEqual(accepted(of(f, worker), 'main'), []);
  const attempts = of(f, worker).length;
  f.advance(61 * 60_000);
  await f.agentPs();
  assert.ok(of(f, worker).length > attempts, 'the hourly agent ps check retries the unconfirmed notice');
  f.accept(() => true);
  f.advance(61 * 60_000);
  await f.settle(f.separateProcess());
  const rows = await f.agentPs();
  assert.equal(accepted(of(f, worker), 'main').length, 1);
  assertNotice(accepted(of(f, worker), 'main')[0], worker, 'succeeded', ['Звіт до недоступного main']);
  assert.notEqual(row(rows, worker.runId).launcherNotice?.state, 'pending', 'confirmed notice is no longer pending');
  await f.settle(f.separateProcess());
  assert.equal(accepted(of(f, worker), 'main').length, 1, 'confirmed notice is never repeated');
});

test('[launcher-notice] crash without a report notifies the launcher once with failed and the reason; Q48 peers get only the closure notice', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const reviewer = f.session('reviewer');
  const coord = f.session('coord');
  const worker = launched(f, 'worker');
  const child = launched(f, 'child', { delegatedBy: { addressId: 'coord', runId: coord.runId } });
  f.kill(worker.process);
  f.kill(child.process);
  await f.agentPs();
  await f.agentPs();
  await f.settle(f.separateProcess());
  for (const [session, recipient] of [[worker, 'main'], [child, 'coord']] as const) {
    const notices = of(f, session);
    assert.equal(notices.length, 1, `${session.addressId}: ${JSON.stringify(notices)}`);
    assertNotice(accepted(notices, recipient)[0], session, 'failed', [NO_REPORT_REASON]);
  }
  const peer = accepted(f.deliveries, reviewer.addressId);
  assert.ok(peer.some(item => item.text.includes('worker')) && peer.some(item => item.text.includes('child')), `Q48 closure notices reach peers: ${JSON.stringify(peer)}`);
  assert.equal(peer.filter(item => item.text.includes(worker.reportPath) || item.text.includes(child.reportPath)).length, 0, 'peers never get the launcher notice');
});
