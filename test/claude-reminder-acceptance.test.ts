import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { deliverCheckedMessage } from '../src/message-delivery.ts';
import { settleCommandState } from '../src/reminder-cli.ts';
import { commandFixture } from './reminder-fixture.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { CommandStatePorts } from '../src/reminder-cli.ts';

const configuration = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const settings: ProtocolSettings = configuration.runnerProtocols.find((row: ProtocolSettings) => row.runner === 'claude');
const ready = "don't ask on (shift+tab to cycle)\n$";
const incident = JSON.parse(readFileSync(new URL('../evidence/fix-raf-sandbox-agent-message-lock/1.2/mac-f7ae8a9e.json', import.meta.url), 'utf8'));
const incidentReminder = JSON.parse(incident.tables.reminders.rows[0].payload);

for (const accepted of [
  "don't ask on (shift+tab to cycle)\n$ Press up to edit queued messages",
  'Slithering…\npaste again to expand\n$',
  'Baked for 6s · done 12:06 PM\npaste again to expand\n$',
]) {
  test(`Claude reminder receipt persists across settlement: ${accepted.split('\n')[0]}`, async t => {
    const fixture = await commandFixture(t);
    const recipient = fixture.session('recipient');
    fixture.store.sessionRepository.transaction(tx => tx.putSession({
      ...recipient, process: { ...recipient.process!, runner: 'claude' },
    }));
    const reminder = fixture.reminders.add({
      to: recipient.addressId, at: new Date(fixture.now() - 1000).toISOString(), text: incidentReminder.text,
    });
    let pastes = 0;
    const settle = (store = fixture.store) => settleCommandState({
      store, now: fixture.now, nextReminderId: () => 'unused', catalog: fixture.catalog,
      deliver: async request => {
        const frames = [ready, accepted];
        const result = await deliverCheckedMessage({
          settings, observeDelivery: request.observeDelivery, verify: async () => true,
          capture: async () => frames.shift() ?? accepted,
          paste: async () => { pastes++; },
          enter: async () => assert.fail('An accepted message needs no Enter retry'),
          now: fixture.now, delay: async () => assert.fail('Acceptance should already be visible'),
        }, request.text);
        return result.accepted
          ? { accepted: true, receiptId: 'claude-receipt' }
          : { accepted: false, reason: result.reason! };
      },
    });
    const first = await settle();
    assert.deepEqual(first.undelivered, []);
    assert.deepEqual(first.delivered, [reminder.id]);
    assert.equal(fixture.store.reminderDeliveries.get(reminder.id)?.receiptId, 'claude-receipt');
    assert.deepEqual(fixture.query("SELECT name FROM sqlite_master WHERE name='reminder_delivery_attempts'").map(row => row.name), ['reminder_delivery_attempts']);
    const attempts = fixture.query('SELECT payload FROM reminder_delivery_attempts');
    assert.equal(attempts.length, 1);
    const diagnostic = JSON.parse(String(attempts[0].payload));
    assert.equal(diagnostic.reminderId, reminder.id);
    assert.equal(diagnostic.accepted, true);
    assert.equal(diagnostic.markWritten, true);
    assert.equal(diagnostic.reason, null);
    assert.equal(diagnostic.transport.accepted, true);
    assert.equal(diagnostic.transport.paneBeforeHash, createHash('sha256').update(ready).digest('hex'));
    assert.equal(diagnostic.transport.paneAfterHash, createHash('sha256').update(accepted).digest('hex'));
    assert.equal(JSON.stringify(diagnostic).includes(incidentReminder.text), false);
    await settle(fixture.separateProcess());
    await settle(fixture.separateProcess());
    assert.equal(pastes, 1);
    assert.equal(fixture.query('SELECT payload FROM reminder_delivery_attempts').length, 1);
  });
}

async function diagnosticAttempt(t: TestContext, deliver: CommandStatePorts['deliver'], confirm?: () => boolean) {
  const fixture = await commandFixture(t);
  fixture.session('recipient');
  const reminder = fixture.reminders.add({
    to: 'recipient', at: new Date(fixture.now() - 1000).toISOString(), text: 'Один раз',
  });
  if (confirm) fixture.store.reminderDeliveries.confirm = confirm;
  await settleCommandState({
    store: fixture.store, now: fixture.now, nextReminderId: () => 'unused', catalog: fixture.catalog,
    deliver: async (request, sender) => {
      const pending = fixture.query('SELECT payload FROM reminder_delivery_attempts');
      assert.equal(pending.length, 1);
      assert.equal(JSON.parse(String(pending[0].payload)).completedAt, null);
      return deliver(request, sender);
    },
  });
  const rows = fixture.query('SELECT payload FROM reminder_delivery_attempts');
  assert.equal(rows.length, 1);
  return { fixture, reminder, attempt: JSON.parse(String(rows[0].payload)) };
}

test('reminder diagnostics distinguish accepted transport from a later control failure', async t => {
  const { fixture, reminder, attempt } = await diagnosticAttempt(t, async request => {
    request.observeDelivery?.({ accepted: true, reason: null, paneBeforeHash: 'before', paneAfterHash: 'after' });
    throw new Error('Recipient is not confirmed alive: recipient');
  });
  assert.equal(attempt.transport.accepted, true);
  assert.equal(attempt.accepted, false);
  assert.equal(attempt.markWritten, false);
  assert.match(attempt.reason, /not confirmed alive/);
  assert.equal(fixture.store.reminderDeliveries.get(reminder.id), undefined);
  assert.notEqual(attempt.completedAt, null);
});

test('reminder diagnostics retain the refusal and frame hashes after manual close', async t => {
  let captures = 0;
  const { fixture, reminder, attempt } = await diagnosticAttempt(t, async request => {
    const result = await deliverCheckedMessage({
      settings, observeDelivery: request.observeDelivery, verify: async () => true,
      capture: async () => captures++ === 0 ? ready : 'unrecognized after paste',
      paste: async () => {}, enter: async () => assert.fail('No retry'),
      now: () => 0, delay: async () => assert.fail('No wait'),
    }, request.text);
    return { accepted: false, reason: result.reason! };
  });
  assert.equal(attempt.accepted, false);
  assert.equal(attempt.transport.accepted, false);
  assert.equal(attempt.reason, 'Recipient screen cannot confirm agent acceptance');
  assert.equal(attempt.markWritten, false);
  assert.equal(attempt.transport.paneAfterHash, createHash('sha256').update('unrecognized after paste').digest('hex'));
  fixture.reminders.close(reminder.id, 'manual');
  assert.equal(fixture.query('SELECT payload FROM reminder_delivery_attempts').length, 1);
});

test('reminder diagnostics expose an accepted receipt whose mark was not written', async t => {
  const { attempt } = await diagnosticAttempt(t, async () => ({ accepted: true, receiptId: 'accepted' }), () => false);
  assert.equal(attempt.accepted, true);
  assert.equal(attempt.receiptId, 'accepted');
  assert.equal(attempt.markWritten, false);
});

test('unavailable diagnostic storage does not change delivery acceptance or its mark', async t => {
  const fixture = await commandFixture(t);
  fixture.session('recipient');
  const reminder = fixture.reminders.add({
    to: 'recipient', at: new Date(fixture.now() - 1000).toISOString(), text: 'Один раз',
  });
  fixture.store.reminderDeliveries.recordAttempt = () => { throw new Error('diagnostic storage unavailable'); };
  const report = await settleCommandState({
    store: fixture.store, now: fixture.now, nextReminderId: () => 'unused', catalog: fixture.catalog,
    deliver: async request => {
      request.observeDelivery?.({ accepted: true, reason: null, paneBeforeHash: 'before', paneAfterHash: 'after' });
      return { accepted: true, receiptId: 'accepted' };
    },
  });
  assert.deepEqual(report.delivered, [reminder.id]);
  assert.equal(fixture.store.reminderDeliveries.get(reminder.id)?.receiptId, 'accepted');
});
