import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const settings = {
  runner: 'claude', version: 'fixture', navigation: [], markers: { ready: ['agent ready'] },
  native: { composer: '^❯(?:\\s|$)', pendingPaste: { pattern: '^\\[Pasted text #\\d+ \\+(\\d+) lines\\]$', unit: 'newlines' }, working: '^Working', identity: { source: 'session_start' } },
  timeouts: { transitionMs: 10000, pollMs: 100 },
} as unknown as ProtocolSettings;
const frame = (input: string, history = 'agent ready') => `${history}\n❯ ${input}\nfooter`;

for (const waiting of ['composer', 'lease'] as const) {
  test(`idle ${waiting} waits use the existing transition cadence instead of active delivery polling`, async () => {
    const delays: number[] = [];
    let clock = 0, available = false, pasted = false, released = 0;
    const ports: MessageDeliveryPorts = {
      settings, waitForComposer: true,
      verify: async () => true,
      capture: async () => frame(waiting === 'composer' && !available ? 'owner draft' : '', pasted ? 'agent ready\naccepted hello' : 'agent ready'),
      paste: async () => { pasted = true; }, enter: async () => assert.fail('Do not submit the owner draft'),
      now: () => clock,
      delay: async ms => { delays.push(ms); clock += ms; available = true; },
      ...(waiting === 'lease' ? { acquire: async () => available ? { release: async () => { released++; } } : null } : {}),
    };
    assert.deepEqual(await deliverCheckedMessage(ports, 'hello'), { accepted: true });
    assert.equal(pasted, true);
    assert.equal(released, waiting === 'lease' ? 1 : 0);
    assert.deepEqual(delays, [settings.timeouts.transitionMs]);
  });
}

test('active acceptance keeps the existing delivery polling cadence and bounded verification', async () => {
  let clock = 0, pasted = false;
  const delays: number[] = [];
  const result = await deliverCheckedMessage({
    settings, waitForComposer: true, verify: async () => true,
    capture: async () => frame(pasted ? 'hello' : ''),
    paste: async () => { pasted = true; }, enter: async () => {}, now: () => clock,
    delay: async ms => { delays.push(ms); clock += ms; },
  }, 'hello');
  assert.equal(result.accepted, false);
  assert.ok(delays.length > 0);
  assert.ok(delays.every(ms => ms === settings.timeouts.pollMs));
  assert.equal(clock, settings.timeouts.transitionMs);
});
