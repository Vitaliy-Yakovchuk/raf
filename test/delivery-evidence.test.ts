import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertPublicArtifact, configureDeliveryStand, parsePublicDeliveryEvidence } from '../scripts/qa-delivery-config.mjs';
import { deliveryDiagnostic } from '../src/delivery-diagnostic.ts';
import {
  cleanupFailedDeliveryEvidence, preserveFailedDeliveryEvidence, readFailedDeliveryEvidenceRetention,
  type DeliveryEvidencePorts, type FailedDeliveryEvidenceInput, type PrivateDeliveryEvidence,
} from '../src/delivery-evidence.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const settings = { runner: 'codex', version: '0.163.0', markers: { ready: ['Ask Codex to do anything'] }, navigation: [], native: {
  composer: '^\\s*›(?:\\s|$)', pendingPaste: { pattern: '^\\[Pasted Content (\\d+) chars\\]$', unit: 'characters' },
  identity: { pattern: 'Session:\\s*([0-9a-f-]+)', command: '/status' }, working: '^• Working',
} } as ProtocolSettings;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 24) + ms).toISOString();
const retentionMs = 4000;
test('[MRH 3.4] delivery stand scans absent failure without hiding real marker leaks', () => {
  assert.doesNotThrow(() => assertPublicArtifact(undefined, ['control-marker']));
  assert.doesNotThrow(() => assertPublicArtifact({ passed: true }, ['control-marker']));
  assert.throws(() => assertPublicArtifact({ screen: 'control-marker' }, ['control-marker']), /Control secret/);
});
test('[MRH 3.4] delivery stand reads linked diagnostic before worker stack suffix', () => {
  const evidence = { availability: 'available', reference: 'test-reference', diagnostic: { screen: 'quoted "frame"\nwith {braces}' } };
  const message = `Wrapper launch failed: Error: Unknown native input; deliveryEvidence=${JSON.stringify(evidence)}\n    at commandFailure (file:///isolated/src/cli.ts:31:17)\nNode.js v26.12.1; verify runner readiness`;
  assert.deepEqual(parsePublicDeliveryEvidence(message), evidence);
});
test('[MRH 3.4] delivery stand preserves production startup policy and configured runner timeouts', () => {
  const original = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const synthetic = { commandTiming: { emaAlpha: 0.1 }, runnerProtocols: [{ runner: 'codex', version: '0.0.1', baseArgs: [], timeouts: {} }] };
  const configured = configureDeliveryStand(synthetic, original);
  assert.deepEqual(configured.costProfile, original.costProfile);
  assert.deepEqual(configured.commandTiming, original.commandTiming);
  assert.deepEqual(configured.runnerProtocols[0].timeouts, original.runnerProtocols.find((row: { runner: string }) => row.runner === 'codex').timeouts);
  assert.deepEqual(configured.runnerProtocols[0].baseArgs, ['--sandbox', 'workspace-write']);
  assert.equal(configured.runnerProtocols[0].version, '0.0.1');
});
const primaryReason = 'RUNNER_DELIVERY_UNAVAILABLE: Unknown native input or screen during initial brief submission';
const brief = 'Synthetic confidential assignment for a private customer';
const screen = `BEGIN\u0000\u001b[31m${'аб😀\r\n'.repeat(1500)}\u001b[0m\n${brief}\nAccount: Synthetic Owner\nsynthetic@example.test\nAuthorization: Bearer synthetic-token\n/home/synthetic/customer\nEND Unknown native dialog\n› synthetic composer`;

function input(runId = 'run-a'): FailedDeliveryEvidenceInput {
  return {
    runId, generation: 'generation-a', settings, firstFailureAt: at(0),
    configuration: { retention: { failedDeliveryEvidenceMs: retentionMs } },
    primaryReason, retrySafe: false, cleanupFailures: [],
    capture: { frame: { screen, brief, phase: 'awaiting_acceptance', retried: true }, capturedAt: at(-1), method: 'tmux capture-pane -p -J -S -', limitations: [] },
  };
}

function fixture() {
  const records = new Map<string, PrivateDeliveryEvidence>();
  const calls: string[] = [];
  const denied = new Set<string>();
  let writeFailure: Error | null = null;
  let serial = 0;
  const ports: DeliveryEvidencePorts = {
    async verifyIsolation(runId) {
      calls.push(`isolate:${runId}`);
      if (denied.has(runId)) throw new Error('PRIVATE_AREA_UNAVAILABLE: agent can read evidence area');
    },
    async read(runId) { calls.push(`read:${runId}`); return structuredClone(records.get(runId) ?? null); },
    async putIfAbsent(record) {
      calls.push(`write:${record.runId}`);
      assert.ok(calls.includes(`isolate:${record.runId}`), 'private isolation must be verified before raw write');
      if (writeFailure) throw writeFailure;
      if (!records.has(record.runId)) records.set(record.runId, structuredClone(record));
      return structuredClone(records.get(record.runId)!);
    },
    async remove(runId, reference) {
      calls.push(`remove:${runId}`);
      assert.equal(records.get(runId)?.reference, reference, 'cleanup must address its own evidence');
      records.delete(runId);
    },
    newReference() { return `evidence-${++serial}`; },
  };
  return { ports, records, calls, denied, failWrite(error: Error) { writeFailure = error; } };
}

function safe(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /Synthetic Owner|synthetic@example|synthetic-token|\/home\/synthetic|synthetic composer|confidential assignment|\u001b|\u0000/);
}

test('[MRH 3.1] preserves the exact decision frame bytes privately and publishes only the linked redacted derivative', async () => {
  const f = fixture();
  const request = input();
  const result = await preserveFailedDeliveryEvidence(request, f.ports);
  const stored = f.records.get('run-a')!;
  assert.ok(stored, 'failed delivery must persist a private frame');
  assert.deepEqual(Buffer.from(stored.capture.frame.screen), Buffer.from(screen));
  assert.equal(stored.capture.frame.brief, brief);
  assert.equal(stored.capture.frame.retried, true);
  assert.equal(result.evidence.availability, 'available');
  assert.equal(result.evidence.reference, stored.reference);
  assert.deepEqual(result.evidence.diagnostic, deliveryDiagnostic(settings, (request.capture as typeof stored.capture).frame));
  assert.equal(result.evidence.diagnostic?.truncated, true);
  assert.equal(result.evidence.diagnostic?.observation, 'unknown_screen');
  assert.match(result.evidence.diagnostic!.screen, /Unknown native dialog/);
  assert.deepEqual(result.evidence.metadata, {
    runId: 'run-a', runner: 'codex', version: '0.163.0', generation: 'generation-a',
    capturedAt: at(-1), phase: 'awaiting_acceptance', method: stored.capture.method, limitations: [],
    firstFailureAt: at(0), expiresAt: at(retentionMs),
  });
  assert.equal(stored.runner, 'codex');
  assert.equal(stored.version, '0.163.0');
  assert.equal(stored.generation, 'generation-a');
  safe(result);
});

test('[MRH 3.1] records capture source limits without reconstructing missing terminal history', async () => {
  const f = fixture();
  const request = input();
  assert.ok('frame' in request.capture);
  request.capture.frame.screen = 'Only the received viewport\r\n› unknown';
  request.capture.method = 'tmux capture-pane -p';
  request.capture.limitations = ['viewport only; no scrollback supplied'];
  const result = await preserveFailedDeliveryEvidence(request, f.ports);
  assert.equal(f.records.get('run-a')!.capture.frame.screen, request.capture.frame.screen);
  assert.deepEqual(result.evidence.metadata?.limitations, request.capture.limitations);
  assert.equal(result.evidence.metadata?.method, request.capture.method);
  assert.equal(result.evidence.diagnostic?.truncated, false);
});

test('[MRH 3.1] two runs have distinct private records and evidence references', async () => {
  const f = fixture();
  const a = input('run-a');
  const b = input('run-b');
  assert.ok('frame' in b.capture);
  b.capture.frame.screen = 'Only second run\n› second input';
  const first = await preserveFailedDeliveryEvidence(a, f.ports);
  const second = await preserveFailedDeliveryEvidence(b, f.ports);
  assert.notEqual(first.evidence.reference, second.evidence.reference);
  assert.equal(f.records.get('run-a')!.capture.frame.screen, screen);
  assert.equal(f.records.get('run-b')!.capture.frame.screen, b.capture.frame.screen);
  assert.ok(f.calls.includes('isolate:run-a'));
  assert.ok(f.calls.includes('isolate:run-b'));
  assert.equal(first.evidence.metadata?.runId, 'run-a');
  assert.equal(second.evidence.metadata?.runId, 'run-b');
});

test('[MRH 3.1] refuses raw persistence when native isolation cannot exclude agents and neighbouring runs', async () => {
  const f = fixture();
  f.denied.add('run-a');
  const result = await preserveFailedDeliveryEvidence(input(), f.ports);
  assert.equal(result.evidence.availability, 'unavailable');
  assert.match(result.evidence.unavailableReason!, /PRIVATE_AREA_UNAVAILABLE/);
  assert.equal(f.records.size, 0);
  assert.ok(!f.calls.includes('write:run-a'));
  assert.ok(result.reason.startsWith(primaryReason));
  safe(result);
});

test('[MRH 3.1] capture failure is secondary to delivery failure and never claims a frame or launch success', async () => {
  const f = fixture();
  const request = input();
  request.capture = { unavailable: 'CAPTURE_FAILED: runner capture unavailable' };
  const result = await preserveFailedDeliveryEvidence(request, f.ports);
  assert.equal(result.code, 'LAUNCH_FAILED');
  assert.ok(result.reason.startsWith(primaryReason));
  assert.match(result.reason, /CAPTURE_FAILED/);
  assert.equal(result.evidence.availability, 'unavailable');
  assert.match(result.evidence.unavailableReason!, /CAPTURE_FAILED/);
  assert.equal(result.evidence.reference, null);
  assert.equal(result.evidence.metadata, null);
  assert.equal(result.evidence.diagnostic, null);
  assert.equal(f.records.size, 0);
  assert.equal(result.retrySafe, false);
});

test('[MRH 3.1] write failure keeps the primary LAUNCH_FAILED reason ahead of evidence and cleanup failures', async () => {
  const f = fixture();
  f.failWrite(new Error('EACCES: private evidence write failed /home/synthetic/customer synthetic@example.test'));
  const request = input();
  request.cleanupFailures = ['RESERVATION_CLEANUP_FAILED'];
  const result = await preserveFailedDeliveryEvidence(request, f.ports);
  assert.equal(result.code, 'LAUNCH_FAILED');
  assert.ok(result.reason.startsWith(primaryReason));
  assert.match(result.reason, /EACCES/);
  assert.match(result.reason, /RESERVATION_CLEANUP_FAILED/);
  assert.equal(result.evidence.availability, 'unavailable');
  assert.equal(result.evidence.reference, null);
  assert.equal(result.evidence.metadata, null);
  assert.equal(result.retrySafe, request.retrySafe);
  assert.equal(f.records.size, 0);
  safe(result);
});

test('[MRH 3.1] redacts every external field including primary, cleanup and capture error text', async () => {
  const f = fixture();
  const request = input();
  request.primaryReason += ' Authorization: Bearer synthetic-token';
  request.cleanupFailures = ['cleanup /home/synthetic/customer synthetic@example.test'];
  request.capture = { unavailable: 'capture Authorization: Bearer synthetic-token' };
  const result = await preserveFailedDeliveryEvidence(request, f.ports);
  assert.ok(result.reason.startsWith(primaryReason));
  assert.equal(result.code, 'LAUNCH_FAILED');
  safe(result);
});

test('[MRH 3.1] successful capture leaves delivery failure, retrySafe and secondary cleanup reason unchanged', async () => {
  const f = fixture();
  const request = input();
  request.retrySafe = true;
  request.cleanupFailures = ['RESERVATION_CLEANUP_FAILED'];
  const result = await preserveFailedDeliveryEvidence(request, f.ports);
  assert.equal(result.code, 'LAUNCH_FAILED');
  assert.equal(result.retrySafe, true);
  assert.ok(result.reason.startsWith(primaryReason));
  assert.match(result.reason, /RESERVATION_CLEANUP_FAILED/);
  assert.equal(result.evidence.availability, 'available');
  assert.equal(f.records.size, 1);
});

test('[MRH 3.1] ordinary failed-launch cleanup cannot remove evidence before configured expiry', async () => {
  const f = fixture();
  const saved = await preserveFailedDeliveryEvidence(input(), f.ports);
  for (const instant of [0, retentionMs / 2, retentionMs - 1]) {
    assert.deepEqual(await cleanupFailedDeliveryEvidence('run-a', at(instant), f.ports), { removed: false, reference: saved.evidence.reference });
    assert.equal(f.records.get('run-a')!.capture.frame.screen, screen);
    assert.equal(f.records.get('run-a')!.expiresAt, at(retentionMs));
  }
  assert.ok(!f.calls.includes('remove:run-a'));
});

test('[MRH 3.1] expiry cleanup removes only its own run and is idempotent at the retention boundary', async () => {
  const f = fixture();
  const a = await preserveFailedDeliveryEvidence(input('run-a'), f.ports);
  const b = input('run-b');
  b.firstFailureAt = at(retentionMs);
  await preserveFailedDeliveryEvidence(b, f.ports);
  assert.deepEqual(await cleanupFailedDeliveryEvidence('run-a', at(retentionMs), f.ports), { removed: true, reference: a.evidence.reference });
  assert.equal(f.records.has('run-a'), false);
  assert.equal(f.records.get('run-b')!.capture.frame.screen, screen);
  assert.deepEqual(await cleanupFailedDeliveryEvidence('run-a', at(retentionMs + 1), f.ports), { removed: false, reference: null });
  assert.deepEqual(f.calls.filter(call => call.startsWith('remove:')), ['remove:run-a']);
});

test('[MRH 3.1] capture retry and policy changes do not replace first evidence or extend retention', async () => {
  const f = fixture();
  const first = await preserveFailedDeliveryEvidence(input(), f.ports);
  const retry = input();
  retry.firstFailureAt = at(1000);
  retry.configuration = { retention: { failedDeliveryEvidenceMs: retentionMs * 10 } };
  assert.ok('frame' in retry.capture);
  retry.capture.frame.screen = 'later screen must not replace decision frame';
  const second = await preserveFailedDeliveryEvidence(retry, f.ports);
  assert.equal(second.evidence.reference, first.evidence.reference);
  assert.equal(second.evidence.metadata?.expiresAt, at(retentionMs));
  assert.equal(f.records.get('run-a')!.capture.frame.screen, screen);
  assert.deepEqual(second.evidence.diagnostic, first.evidence.diagnostic);
  assert.equal((await cleanupFailedDeliveryEvidence('run-a', at(retentionMs), f.ports)).removed, true);
});

test('[MRH 3.1] concurrent repeats retain one initial reference and the stored derivative link', async () => {
  const f = fixture();
  const results = await Promise.all([preserveFailedDeliveryEvidence(input(), f.ports), preserveFailedDeliveryEvidence(input(), f.ports)]);
  assert.equal(f.records.size, 1);
  assert.equal(results[0].evidence.reference, results[1].evidence.reference);
  assert.equal(results[0].evidence.reference, f.records.get('run-a')!.reference);
});

test('[MRH 3.1] retention is read only from the exact flow key without a hidden fallback', () => {
  assert.equal(readFailedDeliveryEvidenceRetention({ retention: { failedDeliveryEvidenceMs: retentionMs } }), retentionMs);
  assert.equal(readFailedDeliveryEvidenceRetention({ retention: { failedDeliveryEvidenceMs: retentionMs * 2 } }), retentionMs * 2);
  for (const configuration of [null, {}, { retention: {} }, { retention: { failedDeliveryEvidenceMs: -1 } }, { retention: { failedDeliveryEvidenceMs: '4000' } }, { retention: { failedDeliveryEvidenceMs: NaN } }]) {
    assert.throws(() => readFailedDeliveryEvidenceRetention(configuration), /CONFIGURATION_INVALID.*\/retention\/failedDeliveryEvidenceMs/);
  }
});
