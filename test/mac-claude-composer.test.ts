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

test('Busy Claude waits through a queued raf draft and a transient composer redraw', async () => {
  const draft = busy.replace('❯\u00a0', '❯ [raf] previous notice');
  const redraw = busy.replace('❯\u00a0\n', '');
  const h = harness([draft, redraw, draft, busy, 'accepted new notice\n' + ready]);
  let last = '', pasted = 0;
  const capture = h.ports.capture;
  h.ports.capture = async () => last = await capture();
  h.ports.paste = async () => {
    assert.equal(last, busy);
    assert.equal(h.counts().enters, 0);
    pasted++;
  };
  assert.deepEqual(await deliverCheckedMessage(h.ports, '[worker] new notice'), { accepted: true });
  assert.equal(pasted, 1);
});
test('All Claude spinner phases permit waiting for a previous raf message to clear', async () => {
  for (const spinner of ['·', '✢', '✳', '✶', '✻', '✽']) {
    const draft = busy.replace('✻', spinner).replace('❯\u00a0', '❯ [raf] previous notice');
    const h = harness([draft, busy, 'accepted new notice\n' + ready]);
    assert.deepEqual(await deliverCheckedMessage(h.ports, '[worker] new notice'), { accepted: true }, spinner);
    assert.equal(h.counts().pasted, 1);
    assert.equal(h.counts().enters, 0);
  }
});
test('Own multiline paste survives a changing queued-messages footer', async () => {
  const message = '[worker] first line\nsecond line';
  const queuedReady = ready + '\n  Press up to edit queued messages';
  for (const [before, footer] of [[queuedReady, ready.split('\n').slice(1).join('\n')], [ready, queuedReady.split('\n').slice(1).join('\n')]]) {
    const pending = '✻ Puzzling…\n❯ [worker] first line\n  second line\n' + footer;
    const h = harness([before, pending, pending, pending, 'accepted new notice\n' + ready]);
    assert.deepEqual(await deliverCheckedMessage(h.ports, message), { accepted: true });
    assert.deepEqual(h.counts(), { pasted: 1, enters: 1 });
  }
});
test('Queued footer alone never confirms acceptance and never permits foreign multiline input', async () => {
  const queued = ready + '\n  Press up to edit queued messages';
  const foreign = '✻ Puzzling…\n❯ [worker] first line\n  someone else\n' + queued.split('\n').slice(1).join('\n');
  const h = harness([queued, foreign]);
  assert.deepEqual(await deliverCheckedMessage(h.ports, '[worker] first line\nsecond line'), { accepted: false, reason: 'Recipient composer contains unrelated input' });
  assert.equal(h.counts().enters, 0);
  const stuck = harness([queued, '✻ Puzzling…\n❯ [worker] first line\n  second line\n' + queued.split('\n').slice(1).join('\n')]);
  assert.deepEqual(await deliverCheckedMessage(stuck.ports, '[worker] first line\nsecond line'), { accepted: false, reason: 'Agent acceptance is unconfirmed after bounded delivery verification' });
});

test('A composer redraw preserves identity checks and non-waiting caller refusal', async () => {
  const redraw = busy.replace('❯\u00a0\n', '');
  const h = harness([redraw]);
  h.ports.verify = async () => h.ports.now() === 0;
  assert.deepEqual(await deliverCheckedMessage(h.ports, '[worker] notice'), { accepted: false, reason: 'Recipient identity changed while waiting for composer' });
  assert.deepEqual(h.counts(), { pasted: 0, enters: 0 });
  const immediate = harness([redraw]);
  immediate.ports.waitForComposer = false;
  assert.deepEqual(await deliverCheckedMessage(immediate.ports, '[worker] notice'), { accepted: false, reason: 'Recipient has no recognized empty agent composer' });
  assert.deepEqual(immediate.counts(), { pasted: 0, enters: 0 });
});
