import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runTestRun } from '../src/test-runs.ts';
import { openStateStore } from '../src/state-store.ts';
import { createTestRunResourcePort } from '../src/test-run-resource-runtime.ts';
import { testWrapperIdentity } from '../src/test-run-resource-process.ts';
import type { TestRunResourceClaim } from '../src/test-run-reservations.ts';
import {
  readTestRunState, applyTestRunStateSnapshot, recoverTestRun, cleanupDeliveredTestRunGroups,
  encodeStateRecoveryReply, decodeStateRecoveryReply,
  type StateRead, type StateRecoveryResult, type RecoveryReply, type RecoveryGroup,
} from '../src/test-run-state-recovery.ts';
import {
  fixture, group, result, legacyResult, key, originalRunId, otherRunId,
  controlPath, unitPath, red, remainder, unknown, processIdentity, unitEntryFixture,
} from './helpers/state-recovery-fixture.ts';

const input = { key, authorized: true, nowMs: 6000 };
function preserved(r: StateRecoveryResult) {
  assert.equal(r.runId, originalRunId);
  assert.deepEqual(r.knownRed, red);
  assert.deepEqual(r.unexecuted, remainder);
  assert.deepEqual(r.unknown, unknown);
  assert.equal(r.timeoutCount, 1);
}
function envelope(r = result()): RecoveryReply {
  return {
    result: r, stderr: 'original stderr', cliCode: 1,
    delivery: { runId: originalRunId, pending: true, receiptId: null, returned: false, forwardedToMain: false },
    recovery: { runId: originalRunId, processIdentity, deadlineMs: 11000, reason: 'owner-lost', needsMain: true },
  };
}

for (const store of ['control', 'unit'] as const) {
  for (const sqliteCode of [14, null]) {
    test(`S01 ${store} failed open preserves role/path and SQLite ${sqliteCode}`, async () => {
      const f = fixture();
      const before = f.stored;
      const path = store === 'control' ? controlPath : unitPath;
      f.open.open = async (role, attemptedPath) => {
        f.calls.opens.push(`${role}:${attemptedPath}`);
        throw Object.assign(new Error('State store open failed'), {
          code: 'ERR_SQLITE_ERROR', ...(sqliteCode === null ? {} : { errcode: sqliteCode }),
          cause: new Error('unable to open database file'),
        });
      };
      const read = await readTestRunState({ store, path, key }, f.open);
      assert.equal(read.errorCode, 'ERR_SQLITE_ERROR');
      assert.deepEqual({ ...read.stateAccess, message: '' }, { store, operation: 'open', path, errorCode: 'ERR_SQLITE_ERROR', sqliteCode, message: '' });
      assert.match(read.stateAccess!.message, /unable to open|unavailable/i);
      assert.equal(read.groupSnapshot, 'unavailable');
      assert.equal(read.groupState, null);
      assert.equal(read.timeoutCount, null);
      assert.equal(read.group, null);
      assert.deepEqual(f.calls.guards, [`${store}:${path}`]);
      assert.deepEqual(f.calls.opens, [`${store}:${path}`]);
      assert.equal(f.writes, 0);
      assert.deepEqual(f.stored, before);
      const external = applyTestRunStateSnapshot(legacyResult(), read);
      assert.equal(external.exitCode, null);
      assert.equal(external.timedOut, false);
      assert.equal(external.outcome, 'refused');
      assert.equal(external.errorCode, 'ERR_SQLITE_ERROR');
      assert.equal(external.nextAction, 'reconcile');
      assert.equal(external.cleanup.complete, true);
      assert.equal(external.timeoutCount, null);
      assert.equal(external.groupState, null);
      assert.deepEqual(external.stateAccess, read.stateAccess);
    });
  }
}

test('S02 control open with an empty table cannot prove unit aggregate absent', async () => {
  const f = fixture(null);
  const read = await readTestRunState({ store: 'control', path: controlPath, key }, f.open);
  assert.equal(read.groupSnapshot, 'unavailable');
  assert.equal(read.groupState, null);
  assert.equal(read.timeoutCount, null);
  assert.equal(read.stateAccess, null);
  assert.equal(f.writes, 0);
});

test('S02 absent requires a successful read of this exact unit key', async () => {
  const f = fixture(null);
  const read = await readTestRunState({ store: 'unit', path: unitPath, key }, f.open);
  assert.equal(read.groupSnapshot, 'absent');
  assert.equal(read.groupState, 'idle');
  assert.equal(read.timeoutCount, 0);
  assert.equal(read.stateAccess, null);
  assert.equal(f.writes, 0);
});

test('S02 loaded snapshot keeps running/count=1/inFlight and does not reserve', async () => {
  const f = fixture();
  const before = f.stored;
  const read = await readTestRunState({ store: 'unit', path: unitPath, key }, f.open);
  assert.equal(read.groupSnapshot, 'loaded');
  assert.equal(read.groupState, 'running');
  assert.equal(read.timeoutCount, 1);
  assert.deepEqual(read.group, before);
  assert.equal(f.writes, 0);
  assert.deepEqual(f.stored, before);
});

test('S02 an open database without successful unit group read is unavailable', async () => {
  const f = fixture();
  f.open.open = async () => ({ async transaction() { throw Object.assign(new Error('read unavailable'), { code: 'STATE_READ_FAILED' }); } });
  const read = await readTestRunState({ store: 'unit', path: unitPath, key }, f.open);
  assert.equal(read.groupSnapshot, 'unavailable');
  assert.equal(read.timeoutCount, null);
  assert.equal(read.groupState, null);
  assert.equal(read.stateAccess, null);
});

test('S02 another workspace/group is absent, never a loaded snapshot of our running group', async () => {
  const f = fixture();
  const read = await readTestRunState({ store: 'unit', path: unitPath, key: { ...key, workspace: '/qa/other-workspace' } }, f.open);
  assert.equal(read.groupSnapshot, 'absent');
  assert.equal(read.timeoutCount, 0);
  assert.equal(f.stored!.timeoutCount, 1);
});

for (const code of ['STATE_ORIGIN_MISMATCH', 'STATE_SCHEMA_UNSUPPORTED', 'CONFIGURATION_INVALID']) {
  test(`S03 ${code} guard runs before open with no fallback`, async () => {
    const f = fixture();
    f.open.guard = async () => { throw Object.assign(new Error('guard denied'), { code }); };
    const read = await readTestRunState({ store: 'unit', path: unitPath, key }, f.open);
    assert.equal(read.errorCode, code);
    assert.equal(read.stateAccess, null);
    assert.equal(read.groupSnapshot, 'unavailable');
    assert.equal(read.timeoutCount, null);
    assert.deepEqual(f.calls.opens, []);
    assert.equal(f.writes, 0);
  });
}

test('S03 canary/native Error properties are redacted while exact trusted path survives quotas', async () => {
  const f = fixture();
  f.open.open = async () => {
    const cause = Object.assign(new Error('authorization: Bearer CANARY_BEARER\npassword=CANARY_PASSWORD https://user:CANARY_URL@example.invalid/?token=CANARY_QUERY\u001b[31m ' + 'é'.repeat(5000)), {
      stack: 'Error CANARY_STACK\n at /private/secret-file:1:2', env: { secret: 'CANARY_ENV' },
    });
    throw Object.assign(new Error('State store open failed'), { code: 'ERR_SQLITE_ERROR', errcode: 14, cause, arbitrary: 'CANARY_PROPERTY' });
  };
  const read = await readTestRunState({ store: 'unit', path: unitPath, key }, f.open);
  assert.equal(read.stateAccess!.path, unitPath);
  assert.equal(read.stateAccess!.store, 'unit');
  assert.equal(read.stateAccess!.sqliteCode, 14);
  assert.ok(Buffer.byteLength(read.stateAccess!.message) <= f.open.limits.maxMessageBytes);
  const r = applyTestRunStateSnapshot(legacyResult(), read);
  const encoded = encodeStateRecoveryReply(envelope(r));
  assert.doesNotMatch(encoded, /CANARY_|\u001b|CANARY_ENV|CANARY_PROPERTY|user:/);
  assert.equal(decodeStateRecoveryReply(JSON.parse(encoded)).result!.stateAccess!.path, unitPath);
  assert.ok(r.diagnosticSummary.redacted);
});

test('S03 absent native cause has explicit unavailable details without raw error serialization', async () => {
  const f = fixture();
  f.open.open = async () => { throw Object.assign(new Error('State store open failed'), { code: 'ERR_SQLITE_ERROR', privateObject: { secret: 'CANARY_PRIVATE' } }); };
  const read = await readTestRunState({ store: 'unit', path: unitPath, key }, f.open);
  assert.match(read.stateAccess!.message, /unavailable|not available|відсут|недоступ/i);
  assert.equal(read.stateAccess!.sqliteCode, null);
  assert.doesNotMatch(JSON.stringify(read), /CANARY_PRIVATE|privateObject/);
});

test('S03 nullable snapshots roundtrip formatter/transport without coercion or green', () => {
  const unavailable: StateRead = { group: null, errorCode: 'ERR_SQLITE_ERROR', stateAccess: { store: 'unit', operation: 'open', path: unitPath, errorCode: 'ERR_SQLITE_ERROR', sqliteCode: 14, message: 'unavailable' }, groupSnapshot: 'unavailable', groupState: null, timeoutCount: null };
  const r = applyTestRunStateSnapshot(legacyResult(), unavailable);
  const parsed = decodeStateRecoveryReply(JSON.parse(encodeStateRecoveryReply(envelope(r))));
  assert.equal(parsed.result!.timeoutCount, null);
  assert.equal(parsed.result!.groupState, null);
  assert.equal(parsed.result!.groupSnapshot, 'unavailable');
  assert.notEqual(parsed.result!.outcome, 'passed');
  assert.notEqual(parsed.cliCode, 0);
});

for (const bad of [
  result({ groupSnapshot: 'unavailable', timeoutCount: 0, groupState: 'idle' }),
  result({ groupSnapshot: 'loaded', timeoutCount: null }),
  result({ groupSnapshot: 'absent', timeoutCount: 1 }),
  result({ groupSnapshot: 'unavailable', timeoutCount: null, groupState: null, outcome: 'passed' }),
]) {
  test(`S03 validator refuses inconsistent snapshot ${JSON.stringify([bad.groupSnapshot, bad.timeoutCount, bad.outcome])}`, () => {
    assert.throws(() => decodeStateRecoveryReply(envelope(bad)), /snapshot|group|unavailable|invalid/i);
  });
}

test('S03 legacy external result lacking snapshot cannot silently become green', () => {
  const legacy: Record<string, unknown> = { ...result({ outcome: 'passed' }) };
  delete legacy.groupSnapshot;
  delete legacy.stateAccess;
  assert.throws(() => decodeStateRecoveryReply({ ...envelope(), result: legacy }), /snapshot|legacy|invalid/i);
});

test('S04 lastResult is returned byte-for-byte with original runId/phase/command, no process work', async () => {
  const saved = result();
  const f = fixture(group({ lastResult: saved }));
  const reply = await recoverTestRun(input, f.ports);
  assert.deepEqual(reply.result, saved);
  assert.notEqual(reply.cliCode, 0);
  assert.deepEqual(f.stored!.lastResult, saved);
  assert.deepEqual(f.calls.cleanup, []);
  assert.deepEqual(f.calls.release, []);
  assert.equal(f.stored!.timeoutCount, 1);
  assert.deepEqual(f.calls.returned, [saved]);
});

test('S04 previous lastResult of a different runId cannot replace lost protocol of original', async () => {
  const f = fixture(group({ lastResult: result({ runId: otherRunId, outcome: 'passed', exitCode: 0 }) }));
  const reply = await recoverTestRun(input, f.ports);
  assert.equal(reply.result!.runId, originalRunId);
  assert.equal(reply.result!.outcome, 'setup-failed');
  assert.equal(reply.result!.exitCode, null);
  preserved(reply.result!);
});

test('S04 pending already-completed run is returned without requiring inFlight', async () => {
  const saved = result();
  const pending = envelope().delivery;
  const f = fixture(group({ inFlight: null, lastResult: saved, delivery: pending }));
  assert.deepEqual((await recoverTestRun(input, f.ports)).result, saved);
  assert.deepEqual(f.calls.cleanup, []);
  assert.equal(f.stored!.timeoutCount, 1);
});

test('S04 unauthorized caller cannot read/recover/deliver a result', async () => {
  const f = fixture();
  f.ports.state.transaction = async () => { assert.fail('unauthorized state read'); };
  await assert.rejects(recoverTestRun({ ...input, authorized: false }, f.ports), /authoriz|CALLER_UNAUTHORIZED/i);
  assert.deepEqual(f.calls.messages, []);
});

test('S05 alive tree before original deadline retains inFlight/resources and explicitly names main action', async () => {
  const f = fixture();
  f.observation.tree = 'alive';
  f.observation.finishedAtMs = null;
  const before = f.stored;
  const reply = await recoverTestRun(input, f.ports);
  assert.equal(reply.result, null);
  assert.equal(reply.recovery.runId, originalRunId);
  assert.equal(reply.recovery.processIdentity, processIdentity);
  assert.equal(reply.recovery.deadlineMs, 11000);
  assert.equal(reply.recovery.needsMain, true);
  assert.match(reply.recovery.reason, /alive|running|result/i);
  assert.notEqual(reply.cliCode, 0);
  assert.deepEqual(f.stored!.inFlight, before!.inFlight);
  assert.equal(f.stored!.timeoutCount, 1);
  assert.deepEqual(f.calls.cleanup, []);
  assert.deepEqual(f.calls.release, []);
  assert.equal(f.calls.messages.length, 1);
});

for (const mode of ['owner-unknown', 'owner-alive', 'tree-unknown', 'pid-reused', 'legacy-identity'] as const) {
  test(`S05 ${mode} never kills/releases an unverified identity even after deadline`, async () => {
    const f = fixture();
    f.observation.finishedAtMs = null;
    if (mode === 'owner-unknown') f.observation.owner = 'unknown';
    if (mode === 'owner-alive') f.observation.owner = 'alive';
    if (mode === 'tree-unknown') f.observation.tree = 'unknown';
    if (mode === 'pid-reused') { f.observation.tree = 'pid-reused'; f.observation.identity = 'other-start-same-pid'; }
    if (mode === 'legacy-identity') { const g = f.stored!; g.inFlight!.processIdentity = null; g.inFlight!.ownerIdentity = null; f.replace(g); f.observation.identity = null; }
    const reply = await recoverTestRun({ ...input, nowMs: 20000 }, f.ports);
    assert.deepEqual(f.calls.cleanup, []);
    assert.deepEqual(f.calls.release, []);
    assert.ok(f.stored!.inFlight);
    assert.equal(f.stored!.timeoutCount, 1);
    assert.notEqual(reply.result?.outcome, 'passed');
    assert.notEqual(reply.result?.outcome, 'timed-out');
    assert.notEqual(reply.cliCode, 0);
  });
}

for (const finishedAtMs of [5000, null]) {
  for (const nowMs of [6000, 20000]) {
    test(`S06 dead tree finishedAt=${finishedAtMs}, reconcile now=${nowMs}: lost protocol never consumes second timeout`, async () => {
      const f = fixture();
      f.observation.finishedAtMs = finishedAtMs;
      const reply = await recoverTestRun({ ...input, nowMs }, f.ports);
      const recovered = reply.result!;
      assert.equal(recovered.outcome, 'setup-failed');
      assert.equal(recovered.exitCode, null);
      assert.equal(recovered.timedOut, false);
      assert.equal(recovered.nextAction, 'reconcile');
      assert.equal(recovered.groupState, 'reconcile');
      assert.ok(recovered.diagnostics.some(d => Boolean(d.unavailableReason)));
      assert.notEqual(reply.cliCode, 0);
      preserved(recovered);
      assert.deepEqual(recovered.selection, group().inFlight!.selection);
      assert.deepEqual(recovered.command, group().inFlight!.command);
      assert.equal(recovered.phase, 'red');
      assert.equal(recovered.startedAt, group().inFlight!.startedAt);
      assert.equal(f.stored!.timeoutCount, 1);
      assert.deepEqual(f.stored!.lastResult, recovered);
      const again = await recoverTestRun({ ...input, nowMs: 40000 }, f.ports);
      assert.deepEqual(again.result, recovered);
      assert.equal(f.stored!.timeoutCount, 1);
      assert.equal(f.calls.release.length, 1);
      assert.equal(f.stored!.inFlight, null);
    });
  }
}

test('S06 persisted early finishedAt survives a later observation with unknown exit time', async () => {
  const g = group();
  g.inFlight!.finishedAtMs = 5000;
  const f = fixture(g);
  f.observation.finishedAtMs = null;
  const reply = await recoverTestRun({ ...input, nowMs: 20000 }, f.ports);
  assert.equal(reply.result!.outcome, 'setup-failed');
  assert.equal(reply.result!.timedOut, false);
  assert.equal(f.stored!.timeoutCount, 1);
});

for (const outcome of ['interrupted', 'setup-failed', 'timed-out'] as const) {
  test(`S07 recorded ${outcome} cannot be reclassified by later clock`, async () => {
    const saved = result({ outcome, timedOut: outcome === 'timed-out', timeoutCount: outcome === 'timed-out' ? 2 : 1 });
    const f = fixture(group({ lastResult: saved, timeoutCount: saved.timeoutCount! }));
    const reply = await recoverTestRun({ ...input, nowMs: 99999 }, f.ports);
    assert.deepEqual(reply.result, saved);
    assert.equal(f.stored!.timeoutCount, saved.timeoutCount);
    assert.deepEqual(f.calls.cleanup, []);
    assert.deepEqual(f.calls.release, []);
  });
}

test('S07 confirmed alive on deadline uses saved policy, counts timeout once across concurrent/repeated reconcile', async () => {
  const f = fixture();
  f.observation.tree = 'alive';
  f.observation.finishedAtMs = null;
  f.observation.deadlineObservedAtMs = 11000;
  const replies = await Promise.all([
    recoverTestRun({ ...input, nowMs: 12000 }, f.ports),
    recoverTestRun({ ...input, nowMs: 12000 }, f.ports),
  ]);
  for (const reply of replies) {
    assert.equal(reply.result!.runId, originalRunId);
    assert.equal(reply.result!.outcome, 'timed-out');
    assert.equal(reply.result!.timedOut, true);
    assert.equal(reply.result!.timeoutCount, 2);
    assert.deepEqual(reply.result!.timeoutPolicy, group().inFlight!.timeoutPolicy);
    assert.deepEqual(reply.result!.knownRed, red);
    assert.deepEqual(reply.result!.unexecuted, remainder);
    assert.deepEqual(reply.result!.unknown, unknown);
  }
  assert.equal(f.calls.cleanup.length, 1);
  assert.deepEqual(f.calls.release, [originalRunId]);
  assert.equal(f.stored!.timeoutCount, 2);
  await recoverTestRun({ ...input, nowMs: 30000 }, f.ports);
  assert.equal(f.stored!.timeoutCount, 2);
  assert.equal(f.calls.cleanup.length, 1);
  assert.equal(f.calls.release.length, 1);
});

test('S07 saved deadline observation proves timeout after tree is gone', async () => {
  const g = group();
  g.inFlight!.deadlineObservedAtMs = 11000;
  const f = fixture(g);
  f.observation.finishedAtMs = null;
  const reply = await recoverTestRun({ ...input, nowMs: 20000 }, f.ports);
  assert.equal(reply.result!.outcome, 'timed-out');
  assert.equal(f.stored!.timeoutCount, 2);
});

test('S07 incomplete cleanup retains inFlight/resource claim and cannot claim complete', async () => {
  const f = fixture();
  f.observation.tree = 'alive'; f.observation.finishedAtMs = null;
  f.observation.deadlineObservedAtMs = 11000;
  f.ports.cleanup = async () => ({ complete: false, remainingPids: [42001] });
  const reply = await recoverTestRun({ ...input, nowMs: 12000 }, f.ports);
  assert.equal(reply.result!.cleanup.complete, false);
  assert.deepEqual(reply.result!.cleanup.remainingPids, [42001]);
  assert.ok(f.stored!.inFlight);
  assert.deepEqual(f.calls.release, []);
  assert.equal(reply.result!.nextAction, 'reconcile');
  assert.notEqual(reply.cliCode, 0);
});

test('S07 fence rejection cannot remove inFlight or pretend capacity released', async () => {
  const f = fixture();
  f.ports.release = async () => false;
  const reply = await recoverTestRun(input, f.ports);
  assert.ok(f.stored!.inFlight);
  assert.equal(reply.recovery.needsMain, true);
  assert.notEqual(reply.cliCode, 0);
});

test('S07 runId changed during observation prevents overwriting another run', async () => {
  const f = fixture();
  const replacement = group(); replacement.inFlight!.runId = otherRunId;
  f.ports.observe = async () => { f.replace(replacement); return { ...f.observation }; };
  await recoverTestRun(input, f.ports);
  assert.equal(f.stored!.inFlight!.runId, otherRunId);
  assert.equal(f.stored!.lastResult, null);
  assert.equal(f.stored!.timeoutCount, 1);
  assert.deepEqual(f.calls.release, []);
});

test('S08 final result is committed before either return or message attempt', async () => {
  const f = fixture();
  f.ports.returnResult = async r => { assert.deepEqual(f.stored!.lastResult, r); assert.equal(f.stored!.delivery!.pending, true); throw new Error('transport closed'); };
  f.ports.messageMain = async reply => { assert.deepEqual(f.stored!.lastResult, reply.result); throw new Error('main unavailable'); };
  const reply = await recoverTestRun(input, f.ports);
  preserved(reply.result!);
  assert.equal(f.stored!.delivery!.pending, true);
  assert.equal(f.stored!.delivery!.runId, originalRunId);
});

test('S08 accepted receipt is durable but not delivered; restart retries same runId without budget change', async () => {
  const f = fixture();
  f.ports.messageMain = async () => ({ accepted: true, receiptId: 'existing-message-receipt', forwarded: false });
  const first = await recoverTestRun(input, f.ports);
  assert.equal(first.delivery!.pending, true);
  assert.equal(first.delivery!.receiptId, 'existing-message-receipt');
  assert.equal(first.delivery!.forwardedToMain, false);
  const restarted = fixture(f.stored);
  restarted.ports.messageMain = async reply => {
    assert.equal(reply.delivery!.receiptId, 'existing-message-receipt');
    return { accepted: true, receiptId: 'existing-message-receipt', forwarded: false };
  };
  const second = await recoverTestRun({ ...input, nowMs: 90000 }, restarted.ports);
  assert.deepEqual(second.result, first.result);
  assert.equal(restarted.stored!.timeoutCount, 1);
  assert.equal(restarted.stored!.delivery!.pending, true);
  assert.deepEqual(restarted.calls.cleanup, []);
  assert.deepEqual(restarted.calls.release, []);
});

test('S08 ambiguous transport exception keeps pending result and its existing receipt', async () => {
  const f = fixture(group({ lastResult: result(), inFlight: null, delivery: { ...envelope().delivery!, receiptId: 'retained-receipt' } }));
  f.ports.returnResult = async () => { throw new Error('return status unknown'); };
  f.ports.messageMain = async () => { throw new Error('message status unknown'); };
  await recoverTestRun(input, f.ports);
  assert.equal(f.stored!.delivery!.pending, true);
  assert.equal(f.stored!.delivery!.receiptId, 'retained-receipt');
  assert.equal(f.stored!.lastResult!.runId, originalRunId);
});

test('S08 closed-change cleanup and new request cannot evict pending lastResult', async () => {
  const f = fixture(group({ lastResult: result(), inFlight: null, delivery: envelope().delivery }));
  await cleanupDeliveredTestRunGroups([], key, f.ports);
  assert.equal(f.stored!.lastResult!.runId, originalRunId);
  const reply = await recoverTestRun(input, f.ports);
  assert.equal(reply.result!.runId, originalRunId);
  assert.equal(f.stored!.delivery!.pending, true);
  assert.deepEqual(f.calls.cleanup, []);
});

for (const destination of ['return', 'main'] as const) {
  test(`S08 confirmed ${destination} permits ordinary closed-group retention cleanup`, async () => {
    const f = fixture(group({ lastResult: result(), inFlight: null, delivery: envelope().delivery }));
    if (destination === 'return') f.ports.returnResult = async () => ({ returned: true });
    else f.ports.messageMain = async () => ({ accepted: true, receiptId: 'existing-message-receipt', forwarded: true });
    await recoverTestRun(input, f.ports);
    assert.equal(f.stored!.delivery!.pending, false);
    assert.equal(f.stored!.delivery!.returned, destination === 'return');
    assert.equal(f.stored!.delivery!.forwardedToMain, destination === 'main');
    await cleanupDeliveredTestRunGroups([], key, f.ports);
    assert.ok(f.stored === null || f.stored.delivery?.pending === false);
  });
}

test('S08 unavailable state fails closed before observation/cleanup/delivery', async () => {
  const f = fixture();
  f.ports.state.transaction = async () => { throw Object.assign(new Error('open unavailable'), { code: 'ERR_SQLITE_ERROR', errcode: 14 }); };
  f.ports.observe = async () => { assert.fail('no fallback observation'); };
  await assert.rejects(recoverTestRun(input, f.ports), /unavailable|SQLITE|open/i);
  assert.deepEqual(f.calls.cleanup, []);
  assert.deepEqual(f.calls.messages, []);
});

test('S10 no owner-lost/no active run is an ordinary no-recovery decision', async () => {
  const f = fixture(null);
  const reply = await recoverTestRun(input, f.ports);
  assert.equal(reply.result, null);
  assert.equal(reply.recovery.needsMain, false);
  assert.equal(f.writes, 0);
  assert.deepEqual(f.calls.messages, []);
  assert.deepEqual(f.calls.release, []);
});

test('S10 delivered normal green remains green through external snapshot and transport', () => {
  const good = result({ outcome: 'passed', exitCode: 0, failureKinds: [], knownRed: [], unexecuted: [], unknown: [], groupState: 'complete', nextAction: 'complete', timeoutCount: 0 });
  const read: StateRead = { group: group({ state: 'complete', timeoutCount: 0, lastResult: good, inFlight: null }), errorCode: null, stateAccess: null, groupSnapshot: 'loaded', groupState: 'complete', timeoutCount: 0 };
  const external = applyTestRunStateSnapshot({ ...good, groupState: 'complete', timeoutCount: 0 }, read);
  const reply = envelope(external); reply.cliCode = 0; reply.delivery!.pending = false; reply.delivery!.returned = true;
  assert.deepEqual(decodeStateRecoveryReply(JSON.parse(encodeStateRecoveryReply(reply))), reply);
});

test('S10 integration lost protocol is incomplete with its saved separate policy, no unit exception', async () => {
  const g = group({ testKind: 'integration', profileId: 'node-integration' });
  g.inFlight!.testKind = 'integration';
  g.inFlight!.phase = 'integration';
  g.inFlight!.callerPhase = 'qa';
  g.inFlight!.timeoutPolicy = { source: 'conf/flow.json#/integrationTests/timeoutMs', timeoutMs: 10000 };
  const f = fixture(g);
  const reply = await recoverTestRun({ ...input, nowMs: 20000 }, f.ports);
  assert.equal(reply.result!.testKind, 'integration');
  assert.equal(reply.result!.phase, 'integration');
  assert.equal(reply.result!.callerPhase, 'qa');
  assert.equal(reply.result!.groupState, 'incomplete');
  assert.equal(reply.result!.nextAction, 'complete-integration');
  assert.equal(reply.result!.timeoutCount, 1);
  assert.equal(reply.result!.timeoutPolicy!.source, 'conf/flow.json#/integrationTests/timeoutMs');
  assert.notEqual(reply.result!.outcome, 'unverified-remainder');
  assert.notEqual(reply.cliCode, 0);
});

test('S04 existing runTestRun entrypoint returns pending original result with zero new spawns', async () => {
  const saved = result();
  const e = unitEntryFixture(group({ inFlight: null, lastResult: saved, delivery: envelope().delivery }));
  const returned = await runTestRun(e.request, e.config, e.policy, e.context, e.ports);
  assert.deepEqual(returned, saved);
  assert.equal(e.spawns, 0);
  assert.equal(e.f.stored!.timeoutCount, 1);
  assert.equal(e.f.stored!.lastResult!.runId, originalRunId);
});

test('S10 existing runTestRun ordinary green still spawns exactly one tree', async () => {
  const e = unitEntryFixture();
  const returned = await runTestRun(e.request, e.config, e.policy, e.context, e.ports);
  assert.equal(returned.outcome, 'passed');
  assert.equal(returned.exitCode, 0);
  assert.equal(returned.runId, otherRunId);
  assert.equal(e.spawns, 1);
  assert.equal(returned.timeoutCount, 0);
  assert.equal(returned.cleanup.complete, true);
  assert.equal((returned as StateRecoveryResult).stateAccess, null);
  assert.equal((returned as StateRecoveryResult).groupSnapshot, 'loaded');
});

test('S10 existing runTestRun unsafe selection refuses before spawn and preserves running group', async () => {
  const e = unitEntryFixture(group());
  const before = e.f.stored;
  const returned = await runTestRun({ ...e.request, files: ['../escape.test.ts'] }, e.config, e.policy, e.context, e.ports);
  assert.equal(returned.outcome, 'refused');
  assert.equal(returned.exitCode, null);
  assert.equal(returned.timedOut, false);
  assert.equal(e.spawns, 0);
  assert.deepEqual(e.f.stored, before);
  assert.equal((returned as StateRecoveryResult).stateAccess, null);
});

test('S06 confirmed interruption is preserved through late reconcile without timeout increment', async () => {
  const f = fixture();
  f.observation.interrupted = true;
  const reply = await recoverTestRun({ ...input, nowMs: 20000 }, f.ports);
  assert.equal(reply.result!.outcome, 'interrupted');
  assert.equal(reply.result!.timedOut, false);
  assert.equal(reply.result!.timeoutCount, 1);
  const again = await recoverTestRun({ ...input, nowMs: 90000 }, f.ports);
  assert.deepEqual(again.result, reply.result);
  assert.equal(f.stored!.timeoutCount, 1);
});

const deadlineMs = 11000;
const expired = { key, authorized: true, nowMs: deadlineMs + 36_000_000 };
const deadOwner = JSON.stringify({ pid: 4242, start: '99', boot: 'previous-boot' });

function unspawned(owner: 'explicit' | 'legacy' = 'explicit', recorded = false): RecoveryGroup {
  const initial = group();
  initial.inFlight = { ...initial.inFlight!, processIdentity: null, deadlineMs, finishedAtMs: null, deadlineObservedAtMs: null };
  if (owner === 'legacy') { delete (initial.inFlight as any).ownerIdentity; delete (initial.inFlight as any).wrapperIdentity; }
  else Object.assign(initial.inFlight!, { ownerIdentity: deadOwner, wrapperIdentity: deadOwner });
  if (recorded) initial.lastResult = result({ outcome: 'setup-failed', failureKinds: ['setup'], exitCode: null, cleanup: { complete: false, remainingPids: [] }, groupState: 'reconcile', nextAction: 'reconcile' });
  return initial;
}

function unspawnedFixture(owner: 'explicit' | 'legacy' = 'explicit', recorded = false) {
  const f = fixture(unspawned(owner, recorded));
  f.observation.owner = owner === 'legacy' ? 'unknown' : 'lost';
  f.observation.tree = 'unknown';
  f.observation.identity = null;
  f.observation.finishedAtMs = null;
  return f;
}

function budgetPreserved(stored: RecoveryGroup | null) {
  assert.ok(stored);
  assert.equal(stored.timeoutCount, 1);
  assert.deepEqual(stored.knownRed, red);
  assert.deepEqual(stored.unexecuted, remainder);
  assert.deepEqual(stored.unknown, unknown);
}

for (const owner of ['explicit', 'legacy'] as const) {
  for (const recorded of [false, true]) {
    test(`6.7.1 expired ${owner}-owner hold without process${recorded ? ' and recorded setup failure' : ''} is released without touching the budget`, async () => {
      const f = unspawnedFixture(owner, recorded);
      const before = f.stored!;
      const reply = await recoverTestRun(expired, f.ports);
      assert.equal(reply.result, null, 'an unspawned hold has no child result to deliver');
      assert.equal(reply.recovery.needsMain, false, reply.recovery.reason);
      assert.equal(reply.recovery.runId, originalRunId);
      assert.equal(f.stored!.inFlight, null, 'the expired hold without a process must be released');
      assert.notEqual(f.stored!.state, 'running');
      budgetPreserved(f.stored);
      assert.deepEqual(f.stored!.lastResult, before.lastResult);
      assert.deepEqual(f.stored!.delivery, before.delivery);
      assert.deepEqual(f.calls.release, [originalRunId]);
    });
  }
}

test('6.7.1 next run of the 6.7 shaped group reconciles the hold and starts with the preserved budget', async () => {
  const e = unitEntryFixture(unspawned('explicit', true));
  Object.assign(e.f.observation, { owner: 'lost', tree: 'unknown', identity: null, finishedAtMs: null });
  e.ports.clock.now = () => expired.nowMs;
  e.ports.recoverGroup = async groupKey => (await recoverTestRun({ ...expired, key: groupKey }, e.f.ports)).result;
  const spawn = e.ports.spawn;
  let atSpawn: RecoveryGroup | null = null;
  e.ports.spawn = async (command, onEvent) => { atSpawn = e.f.stored; return spawn(command, onEvent); };
  const run = await runTestRun(e.request, e.config, e.policy, e.context, e.ports);
  assert.notEqual(run.errorCode, 'GROUP_IN_FLIGHT', JSON.stringify(run.diagnostics));
  assert.equal(e.spawns, 1, 'the new run must start after the stale hold is released');
  assert.equal(run.runId, otherRunId);
  assert.equal(run.timeoutCount, 1);
  const started = atSpawn as RecoveryGroup | null;
  assert.equal(started?.inFlight?.runId, otherRunId);
  budgetPreserved(started);
});

for (const scenario of [
  { name: 'alive explicit owner after deadline', owner: 'alive', nowMs: expired.nowMs, release: true },
  { name: 'unobservable explicit owner after deadline', owner: 'unknown', nowMs: expired.nowMs, release: true },
  { name: 'lost owner before deadline', owner: 'lost', nowMs: deadlineMs - 1, release: true },
  { name: 'resource claim with a live or unverified child', owner: 'lost', nowMs: expired.nowMs, release: false },
] as const) {
  test(`6.7.1 hold without group process identity is kept for ${scenario.name}`, async () => {
    const f = unspawnedFixture('explicit');
    f.observation.owner = scenario.owner;
    if (!scenario.release) f.ports.release = async runId => { f.calls.release.push(runId); return false; };
    const reply = await recoverTestRun({ ...expired, nowMs: scenario.nowMs }, f.ports);
    assert.equal(reply.result, null);
    assert.equal(reply.recovery.needsMain, true);
    assert.equal(f.stored!.inFlight?.runId, originalRunId);
    budgetPreserved(f.stored);
    if (scenario.release) assert.deepEqual(f.calls.release, []);
  });
}

test('6.7.1 hold with a live process is not released and the next run does not start', async () => {
  const initial = group();
  const e = unitEntryFixture(initial);
  Object.assign(e.f.observation, { owner: 'lost', tree: 'alive', identity: processIdentity, finishedAtMs: null });
  e.ports.clock.now = () => deadlineMs - 1;
  e.ports.recoverGroup = async groupKey => (await recoverTestRun({ ...expired, key: groupKey, nowMs: deadlineMs - 1 }, e.f.ports)).result;
  const refused = await runTestRun(e.request, e.config, e.policy, e.context, e.ports);
  assert.equal(refused.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(e.spawns, 0);
  assert.equal(e.f.stored!.inFlight?.runId, originalRunId);
  assert.equal(e.f.stored!.inFlight?.processIdentity, processIdentity);
  assert.deepEqual(e.f.calls.release, []);
});

type ReleasePorts = {
  list(machineId: string): Promise<TestRunResourceClaim[]>;
  observeTree(claim: TestRunResourceClaim): Promise<{ state: 'dead' | 'alive' | 'unknown'; processIdentity: string | null; consumed: null; unboundOwner?: 'dead' | 'alive' | 'unknown' }>;
  release(claim: TestRunResourceClaim): Promise<boolean>;
};

async function releaseHelper() {
  const module: Record<string, unknown> = await import('../src/test-run-state-recovery.ts');
  assert.equal(typeof module.releaseRecoveredTestRunClaims, 'function', 'recovery needs an exported claim release check');
  return module.releaseRecoveredTestRunClaims as (runId: string, identity: string | null, resources: ReleasePorts, machineId: string) => Promise<boolean>;
}

function claim(identity: string | null): TestRunResourceClaim {
  return { machineId: 'qa-machine', testRunId: originalRunId, fence: 'fence', groupKey: key, deadlineMs, processIdentity: identity };
}

for (const scenario of [
  { name: 'unbound claim of a dead owner', claim: null, state: 'unknown', unboundOwner: 'dead', expected: true },
  { name: 'unbound claim of a living owner', claim: null, state: 'unknown', unboundOwner: 'alive', expected: false },
  { name: 'unbound claim of an unobservable owner', claim: null, state: 'unknown', unboundOwner: 'unknown', expected: false },
  { name: 'claim bound to a living child', claim: processIdentity, state: 'alive', unboundOwner: undefined, expected: false },
  { name: 'claim bound to a dead child', claim: processIdentity, state: 'dead', unboundOwner: undefined, expected: true },
] as const) {
  test(`6.7.1 release check for a hold without group identity: ${scenario.name}`, async () => {
    const releaseRecoveredTestRunClaims = await releaseHelper();
    const released: string[] = [];
    const ports: ReleasePorts = {
      list: async () => [claim(scenario.claim)],
      observeTree: async () => ({ state: scenario.state, processIdentity: scenario.claim, consumed: null, ...(scenario.unboundOwner ? { unboundOwner: scenario.unboundOwner } : {}) }),
      release: async value => { released.push(value.testRunId); return true; },
    };
    assert.equal(await releaseRecoveredTestRunClaims(originalRunId, null, ports, 'qa-machine'), scenario.expected);
    assert.deepEqual(released, scenario.expected ? [originalRunId] : []);
  });
}

test('6.7.1 release check keeps the bound-identity contract for holds with a process', async () => {
  const releaseRecoveredTestRunClaims = await releaseHelper();
  const released: string[] = [];
  const ports: ReleasePorts = {
    list: async () => [claim(null)],
    observeTree: async () => ({ state: 'unknown', processIdentity: null, consumed: null, unboundOwner: 'dead' }),
    release: async value => { released.push(value.testRunId); return true; },
  };
  assert.equal(await releaseRecoveredTestRunClaims(originalRunId, processIdentity, ports, 'qa-machine'), false);
  assert.deepEqual(released, []);
});

for (const owner of ['dead', 'alive'] as const) {
  test(`6.7.1 resource port reports the ${owner} owner of a claim left spawning without a process`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'raf-671-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = openStateStore(join(directory, 'state.sqlite'));
    t.after(() => store.close());
    const saved = claim(null);
    store.sessionRepository.transaction(tx => tx.putReservation({ runId: originalRunId, resource: 'test-run', amount: 1,
      testRun: { claim: saved, committed: true, spawning: true, ownerIdentity: owner === 'dead' ? deadOwner : testWrapperIdentity() } } as any));
    const port = createTestRunResourcePort(store, { root: directory, workspace: directory, home: directory, machineId: 'qa-machine', config: {} });
    return port.observeTree(saved).then(observed => {
      assert.equal(observed.state, 'unknown', 'a spawning claim never proves its tree dead by itself');
      assert.equal(observed.processIdentity, null);
      assert.equal((observed as any).unboundOwner, owner);
    });
  });
}
