import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
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

test('main waits through the recorded Claude queue after insertion without submitting it again', async () => {
  const h = harness([empty, queued, queued, empty + '\naccepted']);
  assert.deepEqual(await deliverCheckedMessage(h.ports, 'hello'), { accepted: true });
  assert.equal(h.captures(), 4, 'Queueing is still in flight until the composer clears');
  assert.deepEqual(h.pasted, ['hello']);
  assert.equal(h.enters(), 0);
});
