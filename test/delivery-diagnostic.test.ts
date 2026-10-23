import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryDiagnostic } from '../src/delivery-diagnostic.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const settings = { runner: 'codex', version: '0.163.0', markers: { ready: ['Ask Codex to do anything'] }, navigation: [], native: {
  composer: '^\\s*›(?:\\s|$)', pendingPaste: { pattern: '^\\[Pasted Content (\\d+) chars\\]$', unit: 'characters' },
  identity: { pattern: 'Session:\\s*([0-9a-f-]+)', command: '/status' }, working: '^• Working',
} } as ProtocolSettings;

test('[Z.356] diagnostic redacts wrapped brief echoes, input, account, paths and credentials before bounding the last frame', () => {
  const brief = 'The confidential assignment belongs to the private customer and must never appear in persisted diagnostics.';
  const screen = `Session: 11111111-1111-4111-8111-111111111111\nAccount: Private Owner\nprivate@example.test https://example.test/?secret=value\n/home/private/customer ~/sensitive\n${brief.slice(0, 50)}\n${brief.slice(50)}\napi_key=raw-key Authorization: Bearer raw-bearer\nUnknown native transition\n› private input`;
  const diagnostic = deliveryDiagnostic(settings, { screen, brief, phase: 'awaiting_acceptance', retried: false });
  assert.equal(diagnostic.phase, 'awaiting_acceptance');
  assert.equal(diagnostic.observation, 'unknown_screen');
  assert.equal(diagnostic.composer, 'other');
  assert.equal(diagnostic.pending, 'mismatch');
  assert.equal(diagnostic.retried, false);
  assert.match(diagnostic.screen, /Unknown native transition/);
  assert.doesNotMatch(JSON.stringify(diagnostic), /Private Owner|private@|example\.test|sensitive|customer|confidential|raw-key|raw-bearer|private input|11111111/);
});

test('[Z.356] diagnostics distinguish missing composer, mismatched paste and a submitted retry without retaining the brief', () => {
  const brief = 'one\ntwo';
  const missing = deliveryDiagnostic(settings, { screen: 'Unknown dialog', brief, phase: 'before_submission', retried: false });
  assert.equal(missing.composer, 'missing');
  assert.equal(missing.pending, 'none');
  const mismatch = deliveryDiagnostic(settings, { screen: '› [Pasted Content 999 chars]', brief, phase: 'awaiting_acceptance', retried: true });
  assert.equal(mismatch.composer, 'paste');
  assert.equal(mismatch.pending, 'mismatch');
  assert.equal(mismatch.retried, true);
  const pending = deliveryDiagnostic(settings, { screen: '› [Pasted Content 7 chars]', brief, phase: 'awaiting_acceptance', retried: false });
  assert.equal(pending.pending, 'pending');
});

test('[Z.356] long frame keeps its tail and diagnostic fits the existing durable reason limit', () => {
  const diagnostic = deliveryDiagnostic(settings, { screen: 'x'.repeat(20000) + '\nUnknown final dialog', brief: 'private assignment', phase: 'awaiting_acceptance', retried: false });
  assert.ok(JSON.stringify(diagnostic).length < 3000);
  assert.match(diagnostic.screen, /Unknown final dialog$/);
  assert.equal(diagnostic.truncated, true);
});
