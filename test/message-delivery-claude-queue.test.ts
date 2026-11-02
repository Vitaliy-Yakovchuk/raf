import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
import { commandFixture } from './reminder-fixture.ts';
import { createSessionState } from '../src/session-state.ts';
import { settleResultNotices } from '../src/reminder-cli.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const evidence = new URL('../evidence/fix-raf-main-message-delivery/', import.meta.url);
const settings: ProtocolSettings = JSON.parse(readFileSync(new URL('claude-protocol.json', evidence), 'utf8'));
const queued = readFileSync(new URL('frame-0000.txt', evidence), 'utf8');
const empty = readFileSync(new URL('frame-0455.txt', evidence), 'utf8');

function harness(frames: string[]) {
  let captures = 0, enters = 0, clock = 0;
  const pasted: string[] = [];
  const ports: MessageDeliveryPorts = {
    settings, waitForComposer: true, verify: async () => true,
    capture: async () => { captures++; return frames.length > 1 ? frames.shift()! : frames[0]; },
    paste: async text => { pasted.push(text); }, enter: async () => { enters++; },
    now: () => clock, delay: async ms => { clock += ms; },
  };
  return { ports, pasted, captures: () => captures, enters: () => enters };
}

test('main waits for the recorded Claude queue to clear before inserting another message', async () => {
  const h = harness([queued, queued, empty, empty + '\naccepted']);
  h.ports.paste = async text => {
    assert.equal(h.captures(), 3, 'The queue placeholder is occupied, even though it is a ready marker');
    h.pasted.push(text);
  };
  assert.deepEqual(await deliverCheckedMessage(h.ports, 'hello'), { accepted: true });
  assert.deepEqual(h.pasted, ['hello']);
  assert.equal(h.enters(), 0);
});

test('main accepts the recorded Claude queue after insertion without submitting it again', async () => {
  const h = harness([empty, queued, queued, empty + '\naccepted']);
  assert.deepEqual(await deliverCheckedMessage(h.ports, 'hello'), { accepted: true });
  assert.equal(h.captures(), 2, 'The recorded queue confirms acceptance before any subsequent screen change');
  assert.deepEqual(h.pasted, ['hello']);
  assert.equal(h.enters(), 0);
});

// Once Claude has queued the pasted event, a later screen transition must not
// turn that accepted delivery into a refusal and make a notice retry it.
test('queued main event stays accepted even if the next frame cannot confirm delivery', async () => {
  const h = harness([empty, queued, 'recipient screen changed']);
  assert.deepEqual(await deliverCheckedMessage(h.ports, 'agent.succeeded event-1'), { accepted: true });
  assert.equal(h.captures(), 2);
  assert.deepEqual(h.pasted, ['agent.succeeded event-1']);
  assert.equal(h.enters(), 0);
});

test('a queued result notice is completed once, releases its claim and is pruned after session cleanup', async t => {
  const f = await commandFixture(t);
  const main = f.session('main');
  const worker = f.session('worker');
  f.store.sessionRepository.transaction(tx => tx.putSession({ ...worker,
    notify: { addressId: main.addressId, runId: main.runId },
    launchContext: {
      assignment: { root: f.root, changes: [{ id: 'fix-raf-duplicate-event-delivery', items: [{ id: '1.1', description: 'Queued notice' }] }], baselineArchives: [] },
      selection: { runner: 'codex', model: 'fixture', effort: 'high', reason: 'fixture' },
      reportPath: `${f.root}/worker.json`, briefPath: `${f.root}/brief.txt`,
    },
  }));
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  assert.equal(state.acceptWorkResult(worker.runId, { status: 'succeeded', response: 'Done', proof: null }, { pending: [], domain: [] }), true);
  const pasted: string[] = [];
  const settle = (store = f.store) => settleResultNotices({ store, now: f.now,
    deliver: async request => {
      const h = harness([empty, queued, 'recipient screen changed']);
      h.ports.paste = async text => { pasted.push(text); };
      const result = await deliverCheckedMessage(h.ports, request.text);
      return result.accepted ? { accepted: true, receiptId: 'queued-receipt' } : { accepted: false, reason: result.reason! };
    },
  });
  await settle();
  await settle(f.separateProcess());
  assert.equal(pasted.length, 1, 'The same queued event must not be pasted a second time');
  assert.match(pasted[0], /raf event: agent.succeeded/);
  const notice = f.store.resultNotices.list()[0];
  assert.equal(notice.state, 'delivered');
  assert.equal(notice.attempts, 1);
  assert.equal(notice.lastError, null);
  assert.deepEqual(f.query('SELECT * FROM delivery_claims'), []);
  f.finish(f.getSession(worker.runId)!);
  state.cleanupCompleted('2100-01-01T00:00:00.000Z');
  assert.deepEqual(f.store.resultNotices.list(), []);
});
