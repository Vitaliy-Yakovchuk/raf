import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
import { commandFixture } from './reminder-fixture.ts';
import { createSessionState } from '../src/session-state.ts';
import { settleResultNotices } from '../src/reminder-cli.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const evidence = new URL('../evidence/fix-raf-main-event-duplicate-delivery/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, evidence), 'utf8');
const settings: ProtocolSettings = JSON.parse(read('claude-protocol.json'));
const mainBefore = read('main-before.txt');
const mainPending = read('main-pending.txt');
const mainQueued = read('main-queued.txt');
const mainMessage = read('main-message.txt');
const idleBefore = read('main-idle-before.txt');
const idlePasted = read('main-idle-pasted.txt');
const idleSubmitted = read('main-idle-submitted.txt');
const agentBefore = read('agent-before.txt');
const agentQueued = read('agent-queued.txt');
const agentMessage = read('agent-message.txt');

function harness(frames: string[], waitForComposer = true) {
  let captures = 0, enters = 0, clock = 0;
  const pasted: string[] = [];
  const ports: MessageDeliveryPorts = {
    settings, waitForComposer, verify: async () => true,
    capture: async () => { captures++; return frames.length > 1 ? frames.shift()! : frames[0]; },
    paste: async text => { pasted.push(text); }, enter: async () => { enters++; },
    now: () => clock, delay: async ms => { clock += ms; },
  };
  return { ports, pasted, captures: () => captures, enters: () => enters };
}

function inlinePending(before: string, text: string): string {
  const lines = before.split('\n');
  const composer = lines.findLastIndex(line => /^❯\s*$/u.test(line));
  assert.ok(composer >= 0, 'recorded frame has an empty main composer');
  const body = text.split('\n');
  const inserted = [`❯ ${body[0]}`, ...body.slice(1).map(line => `  ${line}`)];
  const next = [...lines.slice(0, composer), ...inserted, ...lines.slice(composer + 1)].map(line => line.replace(' · esc to interrupt', ''));
  return next.slice(next.length - lines.length).join('\n');
}

function collapsedPending(before: string, text: string): string {
  const lines = before.split('\n');
  const composer = lines.findLastIndex(line => /^❯\s*$/u.test(line));
  assert.ok(composer >= 0, 'recorded frame has an empty main composer');
  const mode = lines.findLastIndex(line => line.includes('⏵⏵ bypass permissions on'));
  assert.ok(mode > composer, 'recorded frame has a mode line below the composer');
  const next = [...lines];
  next[composer] = `❯ [Pasted text #1 +${text.split('\n').length - 1} lines]`;
  next[mode] = '  paste again to expand';
  return next.join('\n');
}

const event = '[raf] raf event: agent.succeeded\nAgent: worker-1\nResult: succeeded\nItems: change:1.1\nReport: /tmp/report.json\nAnswer: Done';

test('idle main accepts a collapsed raf event whose paste hint replaces the mode line', async () => {
  const h = harness([idleBefore, idlePasted, idleSubmitted], false);
  assert.deepEqual(await deliverCheckedMessage(h.ports, event), { accepted: true });
  assert.deepEqual(h.pasted, [event]);
  assert.equal(h.enters(), 0);
  assert.equal(h.captures(), 3);
});

test('busy main accepts a collapsed raf event under the paste hint before it is queued', async () => {
  const h = harness([mainBefore, collapsedPending(mainBefore, event), mainQueued], false);
  assert.deepEqual(await deliverCheckedMessage(h.ports, event), { accepted: true });
  assert.deepEqual(h.pasted, [event]);
  assert.equal(h.enters(), 0);
});

test('busy main still refuses a collapsed paste of a different length under the paste hint', async () => {
  const h = harness([mainBefore, collapsedPending(mainBefore, `${event}\nextra line`)], false);
  assert.deepEqual(await deliverCheckedMessage(h.ports, event), { accepted: false, reason: 'Recipient composer contains unrelated input' });
  assert.equal(h.enters(), 0);
});

test('busy main accepts its own wrapped agent message while it is still in the composer', async () => {
  const h = harness([mainBefore, mainPending, mainQueued]);
  assert.deepEqual(await deliverCheckedMessage(h.ports, mainMessage), { accepted: true });
  assert.deepEqual(h.pasted, [mainMessage]);
  assert.equal(h.enters(), 0, 'The queue placeholder confirms acceptance without another Enter');
  assert.equal(h.captures(), 3);
});

test('busy main accepts its own multi-line raf event while it is still in the composer', async () => {
  const text = '[raf] raf event: agent.succeeded\nAgent: worker-1\nResult: succeeded\nItems: change:1.1\nReport: /tmp/report.json\nAnswer: Done';
  const h = harness([mainBefore, inlinePending(mainBefore, text), mainQueued], false);
  assert.deepEqual(await deliverCheckedMessage(h.ports, text), { accepted: true });
  assert.deepEqual(h.pasted, [text]);
  assert.equal(h.enters(), 0);
});

test('busy main still refuses a foreign draft shown with the same mode line', async () => {
  const h = harness([mainBefore, inlinePending(mainBefore, '[owner] unfinished draft\nsecond line')], false);
  assert.deepEqual(await deliverCheckedMessage(h.ports, '[raf] raf event: agent.succeeded\nAgent: worker-1'), { accepted: false, reason: 'Recipient composer contains unrelated input' });
  assert.equal(h.enters(), 0);
});

test('busy screen-reader agent queues the event above its spinner with an empty composer', async () => {
  const h = harness([agentBefore, agentQueued], false);
  assert.deepEqual(await deliverCheckedMessage(h.ports, agentMessage), { accepted: true });
  assert.deepEqual(h.pasted, [agentMessage]);
  assert.equal(h.enters(), 0);
});

for (const [layout, frames] of [
  ['busy main', (message: string) => [mainBefore, inlinePending(mainBefore, message), mainQueued]],
  ['idle main', () => [idleBefore, idlePasted, idleSubmitted]],
] as const) test(`a raf event accepted by ${layout} is pasted once across settles`, async t => {
  const f = await commandFixture(t);
  const main = f.session('main');
  const worker = f.session('worker');
  f.store.sessionRepository.transaction(tx => tx.putSession({ ...worker,
    notify: { addressId: main.addressId, runId: main.runId },
    launchContext: {
      assignment: { root: f.root, changes: [{ id: 'fix-raf-main-event-duplicate-delivery', items: [{ id: '1.1', description: 'Busy main' }] }], baselineArchives: [] },
      selection: { runner: 'claude', model: 'fixture', effort: 'high', reason: 'fixture' },
      reportPath: `${f.root}/worker.json`, briefPath: `${f.root}/brief.txt`,
    },
  }));
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  assert.equal(state.acceptWorkResult(worker.runId, { status: 'succeeded', response: 'Done', proof: null }, { pending: [], domain: [] }), true);
  const pasted: string[] = [];
  const settle = (store = f.store) => settleResultNotices({ store, now: f.now,
    deliver: async request => {
      const message = `[raf] ${request.text}`;
      const h = harness(frames(message), false);
      h.ports.paste = async text => { pasted.push(text); };
      const result = await deliverCheckedMessage(h.ports, message);
      return result.accepted ? { accepted: true, receiptId: 'queued-receipt' } : { accepted: false, reason: result.reason! };
    },
  });
  await settle();
  await settle(f.separateProcess());
  assert.equal(pasted.length, 1, 'The event accepted by the busy main queue must not be pasted again');
  assert.match(pasted[0], /^\[raf\] raf event: agent.succeeded/);
  const notice = f.store.resultNotices.list()[0];
  assert.equal(notice.state, 'delivered');
  assert.equal(notice.attempts, 1);
  assert.equal(notice.lastError, null);
});
