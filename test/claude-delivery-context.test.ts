import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { matchPendingBrief, nativeDeliveryContext, observeRunnerScreen, readNativeComposer } from '../src/runner-protocols.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const conf = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const claude: ProtocolSettings = conf.runnerProtocols.find((row: ProtocolSettings) => row.runner === 'claude');
const context = (screen: string) => {
  const lines = screen.split('\n');
  return nativeDeliveryContext(claude, lines, readNativeComposer(claude, screen)!.line);
};
const head = ['[Screen Reader Mode: on via flag]', 'Claude Code v2.1.308', 'Sonnet 5.5 with high effort · Claude Max', '/tmp/rqa/orch/raf-develop', 'you: /status', 'Settings dialog dismissed'];
const tail = ["tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and", 'reattach for focus tracking'];
const brief = Array.from({ length: 119 }, (_, index) => `line ${index}`).join('\n');
const pasted = [...head, 'paste again to expand', ...tail, '$  [Pasted text #1 +118 lines]', ''].join('\n');

test('[claude-delivery-context] рядок режиму з ready-маркером і доповненням CLI рівноцінний підказці вставки (живий кадр t4-10)', () => {
  const before = [...head, "don't ask on (shift+tab to cycle)  ·  gh auth login for PR status", ...tail, '$', ''].join('\n');
  assert.equal(observeRunnerScreen(claude, { text: before, version: claude.version, requestedCommand: '/status' }).state, 'ready');
  assert.equal(matchPendingBrief(claude, readNativeComposer(claude, pasted)!.input, brief), 'pending');
  assert.deepEqual(context(pasted), context(before));
});

test('[claude-delivery-context] інші відмінності контексту не прощаються', () => {
  const before = [...head, "don't ask on (shift+tab to cycle)", ...tail, '$', ''].join('\n');
  assert.deepEqual(context(pasted), context(before));
  const changed = pasted.replace('Settings dialog dismissed', 'Unknown dialog');
  assert.notDeepEqual(context(changed), context(before));
  const footer = pasted.replace('$  [Pasted text #1 +118 lines]\n', '$  [Pasted text #1 +118 lines]\nPermission Required: x\n');
  assert.notDeepEqual(context(footer), context(before));
});
