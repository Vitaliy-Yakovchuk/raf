import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { settleResultNotices } from '../src/reminder-cli.ts';
import test from 'node:test';
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const settings: ProtocolSettings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: ProtocolSettings) => row.runner === 'claude');
const ready = '❯ \n' + settings.markers.ready![0];
const pending = readFileSync(new URL('./fixtures/mac-claude-notice/pending.txt', import.meta.url), 'utf8');
const message = ['RAF_NOTICE_PENDING_PROBE', ...Array.from({ length: 12 }, (_, i) => `Probe line ${i}`)].join('\n');

function harness(frames: string[]) {
  let clock = 0;
  let pasted = 0;
  let enters = 0;
  const ports: MessageDeliveryPorts = {
    settings, verify: async () => true,
    capture: async () => frames.length > 1 ? frames.shift()! : frames[0],
    paste: async () => { pasted++; }, enter: async () => { enters++; },
    now: () => clock, delay: async ms => { clock += ms; },
  };
  return { ports, pasted: () => pasted, enters: () => enters };
}

test('Mac Claude 2.1.312 pending paste hint waits for confirmed acceptance without pasting again', async () => {
  const h = harness([ready, pending, pending, pending, 'accepted turn\n' + ready]);
  assert.deepEqual(await deliverCheckedMessage(h.ports, message), { accepted: true });
  assert.equal(h.pasted(), 1);
  assert.equal(h.enters(), 1);
});

test('Mac Claude paste hint does not confirm an empty unknown screen or authorize foreign input', async () => {
  for (const screen of [pending.replace('+12', '+13'), pending.replace('[Pasted text #1 +12 lines]', 'foreign draft'), '❯ \npaste again to expand', 'Permission Required:\n' + pending]) {
    const h = harness([ready, screen]);
    assert.equal((await deliverCheckedMessage(h.ports, message)).accepted, false);
    assert.equal(h.enters(), 0);
  }
});

test('Mac Claude a persistent pending paste is not a receipt and identity is checked before acceptance', async () => {
  const h = harness([ready, pending]);
  assert.equal((await deliverCheckedMessage(h.ports, message)).accepted, false);
  assert.equal(h.enters(), 1);
  const replaced = harness([ready, pending, 'accepted turn\n' + ready]);
  let checks = 0;
  replaced.ports.verify = async () => ++checks < 5;
  assert.equal((await deliverCheckedMessage(replaced.ports, message)).accepted, false);
});

test('Mac Claude confirmed result notice remains delivered across settlement and store reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mac-notice-'));
  const path = join(root, 'state.sqlite');
  let store = openStateStore(path);
  try {
    store.sessionRepository.transaction(tx => {
      tx.putSession({ runId: 'main-run', addressId: 'main', revision: 1, state: 'running' });
      tx.putSession({ runId: 'worker-run', addressId: 'worker', revision: 1, state: 'exited',
        notify: { addressId: 'main', runId: 'main-run' }, result: { status: 'succeeded', response: 'done', proof: null },
        launchContext: { assignment: { root, changes: [], baselineArchives: [] },
          selection: { runner: 'claude', model: 'fixture', effort: 'low', reason: 'fixture' },
          briefPath: join(root, 'brief.txt'), reportPath: join(root, 'report.json') } });
    });
    let deliveries = 0;
    const settle = () => settleResultNotices({ store, now: Date.now, deliver: async request => {
      deliveries++;
      const nativePending = pending.replace('+12', `+${request.text.split('\n').length - 1}`);
      const h = harness([ready, nativePending, 'accepted turn\n' + ready]);
      const result = await deliverCheckedMessage(h.ports, request.text);
      return result.accepted ? { accepted: true, receiptId: 'native-confirmed' } : { accepted: false, reason: result.reason! };
    } });
    await settle();
    assert.equal(store.resultNotices.list()[0].state, 'delivered');
    store.close();
    store = openStateStore(path);
    await settle();
    await settle();
    assert.equal(deliveries, 1);
    assert.equal(store.resultNotices.list()[0].attempts, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
