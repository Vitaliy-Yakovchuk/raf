import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuotaCredits } from '../src/quota-credits.ts';
import { parseQuotaScreen, poolQuotaStatus, routingQuotaEntries, validateQuotaProtocol } from '../src/quota-screens.ts';
import type { ScreenQuotaView } from '../src/quota-screens.ts';
import { creditLine, creditSettings, observedAt, protocol, quotaPanel } from './agy-quota-credits-fixtures.ts';
import type { CreditsSnapshot } from './agy-quota-credits-fixtures.ts';

function parse(text: string, options: { truncated?: boolean; reliable?: boolean } = {}) {
  return parseQuotaCredits(creditSettings, { text, observedAt, truncated: false, reliable: true, ...options });
}

function screen(text: string, options: { truncated?: boolean; version?: string } = {}): CreditsSnapshot {
  return parseQuotaScreen(protocol(), { text, observedAt, version: '1.4.5', truncated: false, ...options }) as CreditsSnapshot;
}

function view(snapshot: CreditsSnapshot): ScreenQuotaView {
  return { runner: 'agy', snapshot, current: true, reason: 'fresh', ageMs: 0, error: null };
}

for (const remaining of [0, 42, 12.5]) {
  test(`C1 absolute agy balance ${remaining} has its own provenance and no percentage`, () => {
    const credits = parse(creditLine(remaining));
    assert.ok(credits);
    assert.equal(credits.remaining, remaining);
    assert.equal(credits.usedFraction, null);
    assert.equal(credits.unit, 'credits');
    assert.equal(credits.source, 'statusline');
    assert.equal(credits.observedAt, observedAt);
    assert.equal(credits.reliable, true);
    assert.ok(credits.label.includes(String(remaining)));
    assert.equal(Object.hasOwn(credits, 'remainingFraction'), false);
    assert.equal(Object.hasOwn(credits, 'resetAt'), false);
  });
}

test('C2 missing or unconfigured credit indicator is null rather than a fabricated zero', () => {
  assert.equal(parse('Models & Quota\nWeekly Limit Remaining 75%'), null);
  assert.equal(parseQuotaCredits(null, { text: creditLine(42), observedAt, truncated: false, reliable: true }), null);
});

test('C1 an explicitly configured credits panel preserves its own source without inventing percentages', () => {
  const settings = { source: 'credits_panel' as const, pattern: '^FIXTURE Credits Panel: ([^\\s|]+) \\| END-FIXTURE$' };
  const credits = parseQuotaCredits(settings, {
    text: `${creditLine(900)}\nFIXTURE Credits Panel: 17 | END-FIXTURE`,
    observedAt, truncated: false, reliable: true,
  });
  assert.equal(credits?.remaining, 17);
  assert.equal(credits?.source, 'credits_panel');
  assert.equal(credits?.usedFraction, null);
  assert.equal(credits?.observedAt, observedAt);
});

for (const token of ['-1', 'NaN', 'Infinity', '12…', '12oops', '9'.repeat(400)]) {
  test(`C2 invalid or incomplete absolute token ${token.slice(0, 20)} stays unknown with an issue`, () => {
    const credits = parse(creditLine(token));
    assert.ok(credits, 'a present invalid indicator must explain its own unknown value');
    assert.equal(credits.remaining, null);
    assert.equal(credits.usedFraction, null);
    assert.equal(credits.reliable, false);
    assert.equal(credits.observedAt, observedAt);
    assert.ok(credits.issue?.trim());
  });
}

test('C2 two conflicting balances in one current source are ambiguous rather than last-number-wins', () => {
  const credits = parse(`${creditLine(12)}\n${creditLine(99)}`);
  assert.ok(credits);
  assert.equal(credits.remaining, null);
  assert.equal(credits.reliable, false);
  assert.ok(credits.issue?.trim());
});

test('C2 truncated and unverified captures cannot become reliable credit observations', () => {
  for (const options of [{ truncated: true }, { reliable: false }]) {
    const credits = parse(creditLine(42), options);
    assert.ok(credits);
    assert.equal(credits.reliable, false);
    assert.ok(credits.issue?.trim());
    if (options.truncated) assert.equal(credits.remaining, null);
  }
});

test('C1 quota protocol retains configured credit source and pattern without requiring a native dialect', () => {
  const row = protocol();
  assert.equal(Object.hasOwn(row, 'native'), false);
  const validated = validateQuotaProtocol(row) as ReturnType<typeof protocol>;
  assert.deepEqual(validated.quota.credits, creditSettings);
  assert.deepEqual(validated.modelPools, row.modelPools);
});

for (const credits of [
  { source: 'statusline', pattern: '(' },
  { source: 'statusline', pattern: '^FIXTURE AI Credits: [0-9]+$' },
  { source: 'statusline', pattern: '^([0-9]+) ([0-9]+)$' },
  { source: 'scrollback', pattern: creditSettings.pattern },
]) {
  test(`C1 quota credit configuration rejects an invalid source or capture contract ${JSON.stringify(credits)}`, () => {
    const row = protocol();
    assert.throws(() => validateQuotaProtocol({ ...row, quota: { ...row.quota, credits } }));
  });
}

test('C1 existing screen pipeline exposes absolute credits while preserving both measured pools', () => {
  const baseline = screen(quotaPanel(null));
  const snapshot = screen(quotaPanel(42));
  assert.ok(snapshot.credits);
  assert.equal(snapshot.credits.remaining, 42);
  assert.equal(snapshot.credits.usedFraction, null);
  assert.equal(snapshot.credits.source, 'statusline');
  assert.equal(snapshot.credits.observedAt, snapshot.observedAt);
  assert.equal(snapshot.credits.reliable, true);
  assert.equal(snapshot.version, '1.4.5');
  assert.equal(snapshot.runner, 'agy');
  assert.deepEqual(snapshot.pools, baseline.pools);
  assert.deepEqual(snapshot.pools.map(pool => pool.id).sort(), ['claude_gpt', 'gemini']);
  assert.equal(snapshot.completeness, baseline.completeness);
  assert.equal(snapshot.reliable, baseline.reliable);
  assert.equal(snapshot.completeness, 'complete');
});

test('C2 credit validity is independent of the validity and completeness of measured windows', () => {
  const baseline = screen(quotaPanel(null));
  for (const token of ['-1', 'NaN', '12…']) {
    const snapshot = screen(quotaPanel(token));
    assert.equal(snapshot.credits?.remaining, null);
    assert.equal(snapshot.credits?.reliable, false);
    assert.ok(snapshot.credits?.issue?.trim());
    assert.deepEqual(snapshot.pools, baseline.pools);
    assert.equal(snapshot.reliable, baseline.reliable);
    assert.equal(snapshot.completeness, baseline.completeness);
  }
});

test('C4 an unconfigured credit source is not inferred from a binary label or unrelated frame numbers', () => {
  const settings = protocol();
  delete settings.quota.credits;
  const snapshot = parseQuotaScreen(settings, {
    text: `${quotaPanel(42)}\nAI Credits: 900\nOther account: 777`,
    observedAt, version: settings.version, truncated: false,
  });
  assert.equal(snapshot.credits, null);
});

test('C2 current frame selection never borrows a credit line from a previous quota block', () => {
  const latest = screen(`${quotaPanel(987)}\n${quotaPanel(null)}`);
  assert.equal(latest.credits, null);
  const current = screen(`${quotaPanel(987)}\n${quotaPanel(12)}`);
  assert.equal(current.credits?.remaining, 12);
});

test('C2 unsupported version and truncated panel do not authenticate an absolute balance', () => {
  for (const options of [{ version: 'unverified-version' }, { truncated: true }]) {
    const snapshot = screen(quotaPanel(42), options);
    assert.notEqual(snapshot.credits?.reliable, true);
  }
});

test('C2 credits-only capture exposes a balance but cannot create complete window observations', () => {
  for (const remaining of [0, 42]) {
    const snapshot = screen(`Models & Quota\n${creditLine(remaining)}`);
    assert.equal(snapshot.credits?.remaining, remaining);
    assert.equal(snapshot.credits?.usedFraction, null);
    assert.equal(snapshot.credits?.reliable, true);
    assert.notEqual(snapshot.completeness, 'complete');
    for (const pool of snapshot.pools) assert.equal(poolQuotaStatus(pool, view(snapshot), observedAt), 'unknown');
    const entries = routingQuotaEntries([protocol()], [view(snapshot)], [
      { id: 'fixture-gemini', runner: 'agy' }, { id: 'fixture-claude', runner: 'agy' },
    ], observedAt);
    assert.equal(entries.length, 2);
    assert.ok(entries.every(entry => entry.status === 'unknown'));
  }
});

test('C3 positive credits cannot rescue an exhausted window or cross model-pool boundaries', () => {
  const settings = protocol();
  const snapshot = screen(quotaPanel(900));
  assert.equal(snapshot.credits?.remaining, 900);
  const entries = routingQuotaEntries([settings], [view(snapshot)], [
    { id: 'fixture-gemini', runner: 'agy' }, { id: 'fixture-claude', runner: 'agy' },
    { id: 'fixture-gemini', runner: 'codex' },
  ], observedAt);
  assert.equal(entries.filter(entry => entry.runner === 'agy').length, 2);
  assert.ok(entries.filter(entry => entry.runner === 'agy').every(entry => entry.status === 'exhausted'));
  assert.ok(entries.filter(entry => entry.runner === 'codex').every(entry => entry.status === 'unknown'));
  assert.deepEqual(settings.modelPools, protocol().modelPools);
});

test('C1 zero credits do not exhaust otherwise available measured windows', () => {
  const availablePanel = quotaPanel(0).replaceAll('0.00%', '50.00%');
  const snapshot = screen(availablePanel);
  assert.equal(snapshot.credits?.remaining, 0);
  const entries = routingQuotaEntries([protocol()], [view(snapshot)], [
    { id: 'fixture-gemini', runner: 'agy' }, { id: 'fixture-claude', runner: 'agy' },
  ], observedAt);
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.status === 'available'));
});
