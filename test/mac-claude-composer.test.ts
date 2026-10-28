import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
import { readNativeComposer, observeRunnerScreen, isNativeWorking, type ProtocolSettings } from '../src/runner-protocols.ts';

const settings: ProtocolSettings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: ProtocolSettings) => row.runner === 'claude');
const ready = '❯\u00a0\n────────────────\n  ⏵⏵ bypass permissions on';
const busy = '✻ Puzzling… (1m 7s · ↓ 5.3k tokens · thinking)\n────────────────\n❯\u00a0\n────────────────\n  paste again to expand';
function harness(frames: string[]) {
  let clock = 0, pasted = 0, enters = 0;
  const ports: MessageDeliveryPorts = { settings, waitForComposer: true, verify: async () => true,
    capture: async () => frames.length > 1 ? frames.shift()! : frames[0],
    paste: async () => { pasted++; }, enter: async () => { enters++; },
    now: () => clock, delay: async ms => { clock += ms; } };
  return { ports, counts: () => ({ pasted, enters }) };
}
test('Native Claude icon + verb busy frame with empty composer permits checked delivery', async () => {
  for (const frame of [busy, busy.replace('✻ Puzzling…', '✶ Crunching…')]) {
    const h = harness([frame, 'accepted canary\n' + ready]);
    assert.equal(readNativeComposer(settings, frame)?.input, '');
    assert.equal(observeRunnerScreen(settings, { text: frame, version: settings.version, requestedCommand: null }).state, 'unknown_screen');
    assert.deepEqual(await deliverCheckedMessage(h.ports, '[audit] canary'), { accepted: true });
    assert.equal(h.counts().pasted, 1);
  }
});
test('Own expanded multiline paste survives known ready-footer to paste-hint transition', async () => {
  const message = '[audit] first line\nsecond line';
  const pending = 'Puzzling…\n❯ [audit] first line\n  second line\n────────────────\n  paste again to expand';
  const h = harness([ready, pending, pending, pending, 'accepted canary\n' + ready]);
  assert.equal(isNativeWorking(settings, pending), true);
  assert.deepEqual(await deliverCheckedMessage(h.ports, message), { accepted: true });
  assert.equal(h.counts().pasted, 1);
});
test('Genuinely foreign input after paste is refused without Enter retry', async () => {
  for (const [message, frame] of [
    ['[audit] canary', '❯ foreign draft\n────────────────\n  ⏵⏵ bypass permissions on'],
    ['[audit] first line\nsecond line', 'Puzzling…\n❯ [audit] first line\n  foreign draft\n────────────────\n  paste again to expand'],
    ['[audit] first line\nsecond line', 'Puzzling…\n❯ [audit] first line\n  second line\n────────────────\n  unknown footer'],
  ]) {
    const h = harness([ready, frame]);
    assert.deepEqual(await deliverCheckedMessage(h.ports, message), { accepted: false, reason: 'Recipient composer contains unrelated input' });
    assert.equal(h.counts().enters, 0);
  }
});
test('Shell and unknown empty hint are refused before paste', async () => {
  for (const frame of ['$ ', '❯\u00a0\npaste again to expand', busy.replace('✻ Puzzling…', '? Puzzling…')]) {
    const h = harness([frame]);
    assert.equal((await deliverCheckedMessage(h.ports, '[audit] canary')).accepted, false);
    assert.equal(h.counts().pasted, 0);
  }
});
