import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectRunnerQuotas, quotaCurrentView, readQuotaViews } from '../src/quota-collection.ts';
import type { CurrentQuota } from '../src/quota-collection.ts';
import { runnerLimitsHandler } from '../src/app-runtime.ts';
import { failureContext } from '../src/cli.ts';
import { agyReady, agyUsageMenu } from './quota-frames.ts';
import {
  creditLine, enabled, harness, measuredSnapshot, observedAt, previousQuota, protocol, quotaPanel,
} from './agy-quota-credits-fixtures.ts';
import type { CreditsSnapshot } from './agy-quota-credits-fixtures.ts';

function collect(h: ReturnType<typeof harness>, settings = protocol()) {
  return collectRunnerQuotas({ requested: ['agy'], mode: 'explicit', settings: [settings], enabled }, h.dependencies);
}

function credits(current: CurrentQuota | null | undefined) {
  return (current?.snapshot as CreditsSnapshot | null)?.credits;
}

function assertOwnedCleanup(h: ReturnType<typeof harness>) {
  const opened = h.calls.filter(call => call.operation === 'open');
  assert.equal(opened.length, 1);
  const handle = opened[0].handle;
  for (const call of h.calls.filter(call => ['capture', 'text', 'keys', 'cleanup'].includes(call.operation))) {
    assert.equal(call.handle, handle);
  }
  assert.equal(h.calls.filter(call => call.operation === 'cleanup').length, 1);
  assert.equal(h.calls.filter(call => call.operation === 'release').length, 1);
  assert.equal(h.owned.size, 0);
}

test('C1 credits reach the current store and serialized runner-limits result through the existing probe', async () => {
  const settings = protocol();
  assert.equal(Object.hasOwn(settings, 'native'), false);
  const before = structuredClone(settings);
  const h = harness();
  const result = await collect(h, settings);
  assert.equal(result.exitCode, 0);
  assert.equal(result.results[0].collected, true);
  const stored = await h.dependencies.store.read('agy');
  assert.equal(credits(stored)?.remaining, 42);
  assert.equal(credits(stored)?.usedFraction, null);
  assert.equal(credits(stored)?.unit, 'credits');
  assert.equal(credits(stored)?.source, 'statusline');
  assert.equal(credits(stored)?.reliable, true);
  assert.equal(credits(stored)?.observedAt, stored?.snapshot?.observedAt);
  const output = JSON.parse(JSON.stringify(result));
  assert.deepEqual(output.results[0].view.snapshot.credits, credits(stored));
  assert.equal(output.results[0].view.snapshot.version, '1.4.5');
  assert.equal(output.results[0].view.snapshot.runner, 'agy');
  assert.deepEqual(h.calls.filter(call => call.operation === 'text').map(call => call.text), ['/usage']);
  assert.deepEqual(settings, before, 'collection must not alter model pools or payment configuration');
  assertOwnedCleanup(h);
});

test('C1 repeated collection replaces the one current balance including a measured zero', async () => {
  const h = harness([agyReady, agyUsageMenu, quotaPanel(0)]);
  h.rows.set('agy', previousQuota(99));
  const result = await collect(h);
  assert.equal(result.exitCode, 0);
  assert.equal(h.rows.size, 1);
  assert.equal(credits(h.rows.get('agy'))?.remaining, 0);
  assert.equal(credits(h.rows.get('agy'))?.reliable, true);
  assert.equal((result.results[0].view.snapshot as CreditsSnapshot).credits?.remaining, 0);
  assert.equal(Object.hasOwn(h.rows.get('agy')!, 'history'), false);
});

test('C1 runner-limits output includes the absolute credit metric with its capture provenance', async () => {
  const h = harness();
  const handler = runnerLimitsHandler(['agy'], async runners => {
    assert.deepEqual(runners, ['agy']);
    return collect(h);
  });
  const output = JSON.parse(JSON.stringify(await handler({ runners: ['agy'] })));
  assert.equal(output.length, 1);
  assert.equal(output[0].runner, 'agy');
  assert.equal(output[0].collected, true);
  assert.equal(output[0].credits.remaining, 42);
  assert.equal(output[0].credits.usedFraction, null);
  assert.equal(output[0].credits.source, 'statusline');
  assert.equal(output[0].credits.reliable, true);
  assert.equal(output[0].credits.observedAt, output[0].observedAt);
  assert.equal(typeof output[0].ageMs, 'number');
  assert.deepEqual(output[0].pools.map((pool: { id: string }) => pool.id).sort(), ['claude_gpt', 'gemini']);
  assertOwnedCleanup(h);
});

test('C2 runner-limits failure output retains the previous balance with age and current failure reason', async () => {
  const h = harness();
  h.rows.set('agy', previousQuota(37));
  h.advance(50);
  h.failCapture();
  const handler = runnerLimitsHandler(['agy'], async () => collect(h));
  await assert.rejects(async () => handler({ runners: ['agy'] }), error => {
    const context = failureContext(error);
    assert.ok(context);
    assert.equal(context.code, 'QUOTA_COLLECTION_FAILED');
    const output = JSON.parse(JSON.stringify(context.found));
    assert.equal(output[0].collected, false);
    assert.equal(output[0].reason, 'failed');
    assert.ok(output[0].error);
    assert.equal(output[0].previous.credits.remaining, 37);
    assert.equal(output[0].previous.credits.observedAt, observedAt);
    assert.equal(output[0].previous.ageMs, 50);
    return true;
  });
  assertOwnedCleanup(h);
});

test('C2 a credits-only result persists its own metric but does not claim a complete successful collection', async () => {
  const h = harness([agyReady, agyUsageMenu, `Models & Quota\n${creditLine(17)}`]);
  const result = await collect(h);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results[0].collected, false);
  assert.equal(credits(h.rows.get('agy'))?.remaining, 17);
  assert.equal(credits(h.rows.get('agy'))?.reliable, true);
  const output = JSON.parse(JSON.stringify(result.results[0].view));
  assert.equal(output.snapshot.credits.remaining, 17);
  assert.notEqual(output.snapshot.completeness, 'complete');
  assertOwnedCleanup(h);
});

test('C2 a stale balance retains its original timestamp and age without becoming a new measurement', async () => {
  const h = harness();
  const settings = protocol();
  h.rows.set('agy', previousQuota(37));
  h.advance(settings.collection.staleAfterMs + 1);
  const views = await readQuotaViews([settings], enabled, h.dependencies);
  assert.equal(views[0].current, false);
  assert.equal(views[0].reason, 'stale');
  assert.equal(views[0].ageMs, settings.collection.staleAfterMs + 1);
  const output = JSON.parse(JSON.stringify(views[0]));
  assert.equal(output.snapshot.credits.remaining, 37);
  assert.equal(output.snapshot.credits.observedAt, observedAt);
  assert.equal(h.calls.length, 0, 'reading a previous balance must not start another probe');
});

test('C2 a failed probe retains the previous correct credits with age and the current error', async () => {
  const h = harness();
  h.rows.set('agy', previousQuota(37));
  h.advance(50);
  h.failCapture();
  const result = await collect(h);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results[0].collected, false);
  const stored = h.rows.get('agy');
  assert.deepEqual(stored?.snapshot, previousQuota(37).snapshot);
  assert.ok(stored?.error?.message.trim());
  assert.equal(stored?.lastAttemptAt, h.dependencies.now());
  const output = JSON.parse(JSON.stringify(result.results[0].view));
  assert.equal(output.current, false);
  assert.equal(output.reason, 'failed');
  assert.equal(output.ageMs, 50);
  assert.equal(output.snapshot.credits.remaining, 37);
  assert.equal(output.snapshot.credits.observedAt, observedAt);
  assert.ok(output.error);
  assertOwnedCleanup(h);
});

test('C2 missing and invalid current credits cannot be relabeled as a freshly observed previous balance', async () => {
  for (const token of [null, '-1', '12…']) {
    const h = harness([agyReady, agyUsageMenu, quotaPanel(token)]);
    h.rows.set('agy', previousQuota(37));
    h.advance(50);
    const result = await collect(h);
    const snapshot = result.results[0].view.snapshot as CreditsSnapshot;
    assert.ok(snapshot);
    if (snapshot.credits?.remaining === 37) {
      assert.equal(snapshot.credits.observedAt, observedAt, 'retained balance must keep its own capture time');
      assert.ok(snapshot.credits.issue?.trim() || result.results[0].view.error, 'retained balance must explain the failed current observation');
    } else if (token === null) assert.equal(snapshot.credits, null);
    else {
      assert.equal(snapshot.credits?.remaining, null);
      assert.equal(snapshot.credits?.reliable, false);
      assert.ok(snapshot.credits?.issue?.trim());
    }
    assertOwnedCleanup(h);
  }
});

test('C4 a contended shared quota lock cannot publish cached credits as a newly collected balance', async () => {
  const h = harness();
  h.rows.set('agy', previousQuota(37));
  h.contend();
  const result = await collect(h);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results[0].collected, false);
  assert.equal(h.calls.filter(call => call.operation === 'open').length, 0);
  assert.equal(credits(h.rows.get('agy'))?.remaining, 37);
  assert.equal(credits(h.rows.get('agy'))?.observedAt, observedAt);
  assert.equal(h.calls.filter(call => call.operation === 'acquire').length, 1);
});

test('C4 a different menu command with visible credits never receives Enter or a credits fallback', async () => {
  const wrongMenu = agyUsageMenu.replaceAll('/usage', '/credits');
  const h = harness([agyReady, `${wrongMenu}\n${creditLine(900)}`]);
  h.rows.set('agy', previousQuota(37));
  const result = await collect(h);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results[0].collected, false);
  assert.equal(h.rows.get('agy')?.error?.code, 'command_mismatch');
  assert.ok(h.calls.filter(call => call.operation === 'keys').every(call => !call.keys?.includes('Enter')));
  assert.deepEqual(h.calls.filter(call => call.operation === 'text').map(call => call.text), ['/usage']);
  assert.equal(credits(h.rows.get('agy'))?.remaining, 37);
  assertOwnedCleanup(h);
});

test('C4 loading credits are replaced by the current parsed balance using the same owned probe and deadline', async () => {
  const h = harness([
    agyReady, agyUsageMenu, `FIXTURE quota loading\n${creditLine(900)}`,
    agyUsageMenu, quotaPanel(17),
  ]);
  const result = await collect(h);
  assert.equal(result.exitCode, 0);
  assert.equal(credits(h.rows.get('agy'))?.remaining, 17);
  assert.ok(h.calls.filter(call => call.operation === 'text').every(call => call.text === '/usage'));
  const opened = h.calls.find(call => call.operation === 'open')!;
  assert.equal(opened.deadline, new Date(Date.parse(observedAt) + protocol().timeouts.overallMs).toISOString());
  assert.ok(Date.parse(h.dependencies.now()) <= Date.parse(opened.deadline!));
  assertOwnedCleanup(h);
});

test('C4 perpetual loading with credits cannot reset the common deadline or overwrite the previous balance', async () => {
  const settings = protocol();
  const h = harness([agyReady, agyUsageMenu, `FIXTURE quota loading\n${creditLine(900)}`]);
  h.rows.set('agy', previousQuota(37));
  const result = await collect(h, settings);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results[0].collected, false);
  assert.equal(credits(h.rows.get('agy'))?.remaining, 37);
  assert.equal(credits(h.rows.get('agy'))?.observedAt, observedAt);
  const elapsed = Date.parse(h.dependencies.now()) - Date.parse(observedAt);
  assert.ok(elapsed <= settings.timeouts.overallMs + settings.timeouts.pollMs, `shared budget exceeded: ${elapsed}`);
  assert.equal(h.calls.filter(call => call.operation === 'open').length, 1);
  assert.ok(h.calls.filter(call => call.operation === 'text').every(call => call.text === '/usage'));
  assertOwnedCleanup(h);
});

test('C4 cleanup failure cannot produce a successful credits collection and still releases the shared lock', async () => {
  const h = harness();
  h.rows.set('agy', previousQuota(37));
  h.failCleanup();
  const result = await collect(h);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results[0].collected, false);
  assert.equal(h.rows.get('agy')?.error?.code, 'cleanup_failed');
  assert.ok(credits(h.rows.get('agy')));
  assert.equal(credits(h.rows.get('agy'))?.usedFraction, null);
  assertOwnedCleanup(h);
});

test('C2 balance freshness never refreshes an old snapshot or clears a failed window observation', () => {
  const snapshot = measuredSnapshot(42);
  const recentCreditTime = new Date(Date.parse(observedAt) + 5000).toISOString();
  snapshot.credits!.observedAt = recentCreditTime;
  const current: CurrentQuota = { ...previousQuota(), snapshot };
  const staleView = quotaCurrentView(current, protocol(), recentCreditTime, true);
  assert.equal(staleView.current, false);
  assert.equal(staleView.reason, 'stale');
  const failed: CurrentQuota = {
    ...current, error: { code: 'incomplete', message: 'fixture missing model window', remedy: 'collect again' },
  };
  assert.equal(quotaCurrentView(failed, protocol(), observedAt, true).current, false);
});
