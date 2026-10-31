import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { latestQuotaBlock, nextQuotaProbeAction, parseQuotaReset, parseQuotaScreen, poolQuotaStatus, quotaProbeInvocation, routingQuotaEntries, validateQuotaProtocol } from '../src/quota-screens.ts';
import type { QuotaProtocol, ScreenQuotaSnapshot, ScreenQuotaView } from '../src/quota-screens.ts';
import { listModelAvailability } from '../src/model-routing.ts';
import * as frames from './quota-frames.ts';

const conf = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));

const expectedQuota = {
  codex: {
    version: '0.163.0', quotaCommand: '/status', quotaParser: 'codex_status', quotaReliable: true,
    modelPools: { 'gpt-6-luna': 'shared', 'gpt-6.1-sol': 'shared' },
    quota: {
      args: ['--no-daemon', '--no-alt-screen', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"', '--sandbox', 'read-only', '--ask-for-approval', 'never'],
      env: { TZ: 'UTC' }, submitWhen: '^› /status$', panel: ['Visit https://chatgpt.com/settings/usage'], loading: ['refresh requested; run /status again shortly.'], dismissKeys: ['Escape'],
    },
  },
  claude: {
    version: '2.1.308', quotaCommand: '/usage', quotaParser: 'claude_usage', quotaReliable: true,
    modelPools: { 'claude-sonnet': 'all_models', 'claude-opus': 'all_models' },
    quota: {
      args: ['--ax-screen-reader', '--permission-mode', 'dontAsk', '--model', 'sonnet', '--effort', 'low'],
      env: { TZ: 'UTC' }, submitWhen: '^\\$\\s+/usage$', panel: ['Current week (all models)'], loading: [], dismissKeys: ['Escape'],
    },
  },
  grok: {
    version: '1.0.70', quotaCommand: '/usage', quotaParser: 'grok_usage', quotaReliable: true,
    modelPools: { 'grok-4.7': 'shared' },
    quota: {
      args: ['--no-alt-screen', '--model', 'grok-4.7', '--reasoning-effort', 'high', '--leader-socket', '{probeDirectory}/leader.sock'],
      env: { TZ: 'UTC' }, submitWhen: '^❯ /usage\\s+View usage$', panel: ['Usage limit', 'Resets:'], loading: [], dismissKeys: ['Escape'],
    },
  },
  agy: {
    version: '1.4.7', quotaCommand: '/usage', quotaParser: 'agy_usage', quotaReliable: true,
    modelPools: { 'gemini-4-argon-high': 'gemini', 'gemini-3.8-flash-high': 'gemini', 'claude-opus-5-5-high': 'claude_gpt', 'claude-sonnet-5-5-high': 'claude_gpt', 'gpt-oss-120b-medium': 'claude_gpt' },
    quota: {
      args: ['--model', 'gemini-4-argon-high', '--effort', 'high'],
      env: { TZ: 'UTC' }, submitWhen: '^> /usage\\s+View model quota usage$', panel: ['Models & Quota'], loading: [], dismissKeys: ['Escape'],
    },
  },
} as const;
type Runner = keyof typeof expectedQuota;

function protocol(runner: Runner): QuotaProtocol {
  const expected = expectedQuota[runner];
  return {
    runner, executable: runner, version: expected.version, baseArgs: [], modelFlag: '--model', effortFlag: '--effort', effortFormat: 'literal', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null,
    quotaCommand: expected.quotaCommand, navigation: [],
    markers: {
      ready: { codex: ['Ask Codex to do anything'], claude: ["don't ask on (shift+tab to cycle)"], grok: ['Shift+Tab:mode'], agy: ['? for shortcuts'] }[runner],
      workspace_trust_required: ['Yes, I trust this folder', 'Trust this folder?'], permission_required: ['Permission Required:'],
    },
    quotaParser: expected.quotaParser, modelPools: { ...expected.modelPools }, quotaReliable: true, liveTaskVerified: false,
    timeouts: { startupMs: 10000, transitionMs: 10000, overallMs: 30000, pollMs: 100 }, collection: { intervalMs: 300000, failureBackoffMs: 60000, staleAfterMs: 60000 },
    quota: { ...expected.quota, args: [...expected.quota.args], env: { ...expected.quota.env }, panel: [...expected.quota.panel], loading: [...expected.quota.loading], dismissKeys: [...expected.quota.dismissKeys] },
  };
}
const round = (value: number | null) => value === null ? null : Math.round(value * 10000) / 10000;
function windows(snapshot: ScreenQuotaSnapshot, pool: string) {
  const found = snapshot.pools.find(value => value.id === pool);
  assert.ok(found, `missing pool ${pool}: ${JSON.stringify(snapshot.pools.map(value => value.id))}`);
  return found.windows.map(window => ({ ...window, used: round(window.used), remaining: round(window.remaining) }));
}
function view(snapshot: ScreenQuotaSnapshot | null, current = true): ScreenQuotaView {
  return { runner: snapshot?.runner ?? 'codex', snapshot, ageMs: 0, current, reason: current ? 'fresh' : 'stale', error: null };
}

test('conf/raf.json declares the live-verified quota probe settings for all four runners', () => {
  for (const runner of Object.keys(expectedQuota) as Runner[]) {
    const rows = conf.runnerProtocols.filter((row: { runner: string }) => row.runner === runner);
    assert.equal(rows.length, 1, `runnerProtocols row for ${runner}`);
    const row = rows[0];
    const expected = expectedQuota[runner];
    for (const key of ['version', 'quotaCommand', 'quotaParser', 'quotaReliable'] as const) assert.deepEqual(row[key], expected[key], `${runner}.${key}`);
    assert.deepEqual(row.modelPools, expected.modelPools, `${runner}.modelPools`);
    assert.deepEqual(row.quota, expected.quota, `${runner}.quota`);
    for (const key of ['startupMs', 'transitionMs', 'overallMs', 'pollMs']) assert.ok(Number.isFinite(row.timeouts?.[key]) && row.timeouts[key] > 0, `${runner}.timeouts.${key}`);
    for (const key of ['staleAfterMs']) assert.ok(Number.isFinite(row.collection?.[key]) && row.collection[key] > 0, `${runner}.collection.${key}`);
    const validated = validateQuotaProtocol(row);
    assert.equal(validated.runner, runner);
    assert.deepEqual(validated.quota, expected.quota);
  }
});

test('every catalog model maps to a quota pool its runner screen names', () => {
  for (const model of models.models) {
    const pools = expectedQuota[model.runner as Runner].modelPools as Record<string, string>;
    assert.ok(Object.hasOwn(pools, model.quotaPool ?? model.id), `model ${model.id} on ${model.runner} has a pool mapping`);
  }
});

test('quota protocol validation rejects rows without quota probe settings and does not require a native dialect', () => {
  const row = { ...protocol('grok') } as Record<string, unknown>;
  assert.equal(validateQuotaProtocol(row).runner, 'grok');
  const { quota, ...withoutQuota } = row;
  assert.ok(quota);
  assert.throws(() => validateQuotaProtocol(withoutQuota));
  assert.throws(() => validateQuotaProtocol({ ...row, quota: { ...(row.quota as object), env: 'UTC' } }));
  assert.throws(() => validateQuotaProtocol({ ...row, quota: { ...(row.quota as object), submitWhen: '(' } }));
  assert.throws(() => validateQuotaProtocol({ ...row, timeouts: { startupMs: 0, transitionMs: 1, overallMs: 1, pollMs: 1 } }));
});

test('S.5 quota protocols need freshness without background interval or failure backoff', () => {
  for (const runner of Object.keys(expectedQuota) as Runner[]) {
    const row = { ...protocol(runner), collection: { staleAfterMs: 60000 } };
    const validated = validateQuotaProtocol(row);
    assert.equal(validated.runner, runner);
    assert.deepEqual(validated.collection, { staleAfterMs: 60000 });
    assert.deepEqual(validated.quota, row.quota);
  }
});

test('S.5 removing background scheduling keeps freshness validation', () => {
  for (const staleAfterMs of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000']) {
    assert.throws(() => validateQuotaProtocol({ ...protocol('codex'), collection: { staleAfterMs } }), /collection/);
  }
});

test('probe invocation uses only conf quota args and env, with the owned probe directory substituted', () => {
  const grok = quotaProbeInvocation(protocol('grok'), '/owned/probe-1');
  assert.deepEqual(grok, { executable: 'grok', args: ['--no-alt-screen', '--model', 'grok-4.7', '--reasoning-effort', 'high', '--leader-socket', '/owned/probe-1/leader.sock'], env: { TZ: 'UTC' } });
  const codex = quotaProbeInvocation(protocol('codex'), '/owned/probe-2');
  assert.deepEqual(codex.args, expectedQuota.codex.quota.args);
  assert.ok(!codex.args.includes('workspace-write'));
});

test('codex /status: types the command, submits only the exact composer line and reissues after a loading block', () => {
  const settings = protocol('codex');
  const base = { submitted: false, reissuedAtMs: null, elapsedMs: 600, typedAtMs: null };
  assert.deepEqual(nextQuotaProbeAction(settings, { ...base, text: frames.codexReady, typed: null }), { kind: 'type', text: '/status' });
  assert.deepEqual(nextQuotaProbeAction(settings, { ...base, text: frames.codexStatusTyped, typed: '/status', typedAtMs: 550 }), { kind: 'submit' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.codexStatusLoading, typed: '/status', typedAtMs: 500, submitted: true, reissuedAtMs: null, elapsedMs: 2400 }), { kind: 'wait' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.codexStatusLoading, typed: '/status', typedAtMs: 500, submitted: true, reissuedAtMs: null, elapsedMs: 2400 + settings.timeouts.transitionMs }), { kind: 'reissue', text: '/status' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.codexStatusLimits, typed: '/status', typedAtMs: 500, submitted: true, reissuedAtMs: 12000, elapsedMs: 14000 }), { kind: 'parse' });
});

test('codex parser reads only the latest /status block', () => {
  const settings = protocol('codex');
  const latest = latestQuotaBlock(settings, frames.codexStatusLimits);
  assert.ok(latest?.includes('Weekly limit:'));
  assert.ok(!latest?.includes('refresh requested'));
  const reversed = latestQuotaBlock(settings, frames.codexStatusLoading);
  assert.ok(reversed?.includes('refresh requested'));
  const loading = parseQuotaScreen(settings, { text: frames.codexStatusLoading, observedAt: '2026-10-22T12:43:40.000Z', version: '0.163.0', truncated: false });
  assert.equal(loading.completeness, 'unknown');
  assert.deepEqual(loading.pools.flatMap(pool => pool.windows.filter(window => window.state === 'measured')), []);
});

test('codex weekly window: percent left is remaining and reset is UTC under the probe TZ', () => {
  const snapshot = parseQuotaScreen(protocol('codex'), { text: frames.codexStatusLimits, observedAt: '2026-10-22T12:43:52.000Z', version: '0.163.0', truncated: false });
  assert.equal(snapshot.runner, 'codex');
  assert.equal(snapshot.reliable, true);
  assert.equal(snapshot.completeness, 'complete');
  assert.deepEqual(windows(snapshot, 'shared'), [{ name: 'weekly', label: 'Weekly limit', state: 'measured', used: 1, remaining: 0, resetAt: '2026-10-27T06:51:00.000Z', resetUncertaintyMs: 60000, explanation: null }]);
});

test('reset without an established time zone stays unknown and never becomes a guessed UTC instant', () => {
  const settings = protocol('codex');
  settings.quota.env = {};
  const snapshot = parseQuotaScreen(settings, { text: frames.codexStatusLimits, observedAt: '2026-10-22T12:43:52.000Z', version: '0.163.0', truncated: false });
  const [weekly] = windows(snapshot, 'shared');
  assert.equal(weekly.remaining, 0);
  assert.equal(weekly.resetAt, null);
  assert.ok(snapshot.issues.some(issue => /time zone/i.test(issue)));
});

test('absolute resets without a year resolve to the next occurrence after the observation', () => {
  assert.deepEqual(parseQuotaReset('codex_status', 'resets 6:51 AM on 2 Jan', '2026-12-30T00:00:00.000Z', 'UTC'), { resetAt: '2027-01-02T06:51:00.000Z', resetUncertaintyMs: 60000 });
  assert.deepEqual(parseQuotaReset('codex_status', 'resets 6:51 AM on 27 Oct', '2026-10-22T12:43:52.000Z', 'UTC'), { resetAt: '2026-10-27T06:51:00.000Z', resetUncertaintyMs: 60000 });
  assert.deepEqual(parseQuotaReset('claude_usage', 'Resets 4:59pm (UTC)', '2026-10-22T12:44:13.000Z', 'UTC'), { resetAt: '2026-10-22T16:59:00.000Z', resetUncertaintyMs: 60000 });
  assert.deepEqual(parseQuotaReset('claude_usage', 'Resets 4:59pm (UTC)', '2026-10-22T17:10:00.000Z', 'UTC'), { resetAt: '2026-10-23T16:59:00.000Z', resetUncertaintyMs: 60000 });
  assert.deepEqual(parseQuotaReset('claude_usage', 'Resets Oct 22, 3pm (UTC)', '2026-10-22T12:44:13.000Z', 'UTC'), { resetAt: '2026-10-22T15:00:00.000Z', resetUncertaintyMs: 3600000 });
  assert.equal(parseQuotaReset('claude_usage', 'Resets 4:59pm (Europe/Kyiv)', '2026-10-22T12:44:13.000Z', 'UTC'), null);
  assert.deepEqual(parseQuotaReset('grok_usage', 'Resets: October 24, 16:58', '2026-10-22T12:45:01.000Z', 'UTC'), { resetAt: '2026-10-24T16:58:00.000Z', resetUncertaintyMs: 60000 });
  assert.equal(parseQuotaReset('grok_usage', 'Resets: October 24, 16:58', '2026-10-22T12:45:01.000Z', undefined), null);
  assert.deepEqual(parseQuotaReset('agy_usage', 'Refreshes in 37h 47m', '2026-10-22T12:47:34.000Z', 'UTC'), { resetAt: '2026-10-24T02:34:34.000Z', resetUncertaintyMs: 60000 });
});

test('claude /usage: session and all-model weekly windows are used percentages, Fable stays its own pool and credits stay separate', () => {
  const snapshot = parseQuotaScreen(protocol('claude'), { text: frames.claudeUsagePanel, observedAt: '2026-10-22T12:44:13.000Z', version: '2.1.308', truncated: false });
  assert.equal(snapshot.completeness, 'complete');
  assert.deepEqual(windows(snapshot, 'all_models'), [
    { name: 'session', label: 'Current session', state: 'measured', used: 0.14, remaining: 0.86, resetAt: '2026-10-22T16:59:00.000Z', resetUncertaintyMs: 60000, explanation: null },
    { name: 'weekly', label: 'Current week (all models)', state: 'measured', used: 0.78, remaining: 0.22, resetAt: '2026-10-22T14:59:00.000Z', resetUncertaintyMs: 60000, explanation: null },
  ]);
  assert.deepEqual(windows(snapshot, 'fable'), [
    { name: 'weekly', label: 'Current week (Fable)', state: 'measured', used: 0, remaining: 1, resetAt: '2026-10-22T15:00:00.000Z', resetUncertaintyMs: 3600000, explanation: null },
  ]);
  assert.deepEqual(snapshot.credits, { usedFraction: 0.45, label: 'Usage credits' });
  assert.ok(!snapshot.pools.some(pool => pool.windows.some(window => window.label === 'Usage credits')));
});

test('claude panel that has not loaded the all-model window is partial, not zero', () => {
  const cut = frames.claudeUsagePanel.slice(0, frames.claudeUsagePanel.indexOf('Current week (all models)'));
  const snapshot = parseQuotaScreen(protocol('claude'), { text: cut, observedAt: '2026-10-22T12:44:13.000Z', version: '2.1.308', truncated: false });
  assert.notEqual(snapshot.completeness, 'complete');
  assert.ok(!snapshot.pools.some(pool => pool.windows.some(window => window.name === 'weekly' && window.state === 'measured')));
});

test('claude /usage typed: submit only when the composer holds exactly /usage', () => {
  const settings = protocol('claude');
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.claudeUsageTyped, typed: '/usage', typedAtMs: 500, submitted: false, reissuedAtMs: null, elapsedMs: 4000 }), { kind: 'submit' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.claudeUsagePanel, typed: '/usage', typedAtMs: 500, submitted: true, reissuedAtMs: null, elapsedMs: 5300 }), { kind: 'parse' });
  const other = frames.claudeUsageTyped.replace(/ \/usage$/, ' /usage-credits');
  assert.deepEqual(nextQuotaProbeAction(settings, { text: other, typed: '/usage', typedAtMs: 3800, submitted: false, reissuedAtMs: null, elapsedMs: 4000 }), { kind: 'wait' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: other, typed: '/usage', typedAtMs: 3800, submitted: false, reissuedAtMs: null, elapsedMs: 3800 + settings.timeouts.transitionMs }), { kind: 'stop', reason: 'command_mismatch' });
});

test('claude trust prompt in a quota probe: protocol keys once only for a registered directory, otherwise stop without input', () => {
  const settings = validateQuotaProtocol(conf.runnerProtocols.find((row: { runner: string }) => row.runner === 'claude'));
  const trustScreen = ['[Screen Reader Mode: on via flag]', 'Permission Required: Accessing workspace:', '/srv/dev/work/orchestrator/raf-main', 'Quick safety check: Is this a project you created or one you trust?', 'y. Yes, I trust this folder', 'n. No, exit', 'Enter y/n:', 'Enter to confirm · Esc to cancel'].join('\n');
  const stop = { kind: 'stop', reason: 'workspace_trust_required' };
  const base = { text: trustScreen, typed: null, typedAtMs: null, submitted: false, reissuedAtMs: null, elapsedMs: 400 };
  assert.deepEqual(nextQuotaProbeAction(settings, base), stop);
  assert.deepEqual(nextQuotaProbeAction(settings, { ...base, trustWorkspace: false }), stop);
  assert.deepEqual(nextQuotaProbeAction(settings, { ...base, trustWorkspace: true, trustAnsweredAtMs: null }), { kind: 'trust', keys: ['y', 'Enter'] });
  assert.deepEqual(nextQuotaProbeAction(settings, { ...base, trustWorkspace: true, trustAnsweredAtMs: 400, elapsedMs: 450 }), { kind: 'wait' });
  assert.deepEqual(nextQuotaProbeAction(settings, { ...base, trustWorkspace: true, trustAnsweredAtMs: 400, elapsedMs: 400 + settings.timeouts.transitionMs }), stop);
  assert.deepEqual(nextQuotaProbeAction({ ...settings, navigation: [] }, { ...base, trustWorkspace: true }), stop);
  assert.deepEqual(nextQuotaProbeAction(settings, { ...base, text: frames.claudeReady, trustWorkspace: true, trustAnsweredAtMs: 400, elapsedMs: 900 }), { kind: 'type', text: '/usage' });
});

test('grok /usage modal percentage is used and must agree with the footer remaining', () => {
  const settings = protocol('grok');
  const snapshot = parseQuotaScreen(settings, { text: frames.grokUsageModal, observedAt: '2026-10-22T12:45:01.000Z', version: '1.0.67', truncated: false });
  assert.equal(snapshot.completeness, 'complete');
  assert.deepEqual(windows(snapshot, 'shared'), [
    { name: 'weekly', label: 'Weekly limit (SuperGrok Heavy)', state: 'measured', used: 1, remaining: 0, resetAt: '2026-10-24T16:58:00.000Z', resetUncertaintyMs: 60000, explanation: null },
  ]);
  const disagreeing = frames.grokUsageModal.replace('Weekly limit left: 0%', 'Weekly limit left: 40%');
  const conflict = parseQuotaScreen(settings, { text: disagreeing, observedAt: '2026-10-22T12:45:01.000Z', version: '1.0.67', truncated: false });
  const [weekly] = windows(conflict, 'shared');
  assert.equal(weekly.state, 'unknown');
  assert.equal(weekly.used, null);
  assert.equal(weekly.remaining, null);
  assert.notEqual(conflict.completeness, 'complete');
});

test('grok 1.0.70 live /usage measures weekly quota without a remaining footer', () => {
  const text = readFileSync(new URL('../evidence/fix-raf-grok-quota-screen/grok-1.0.70-usage.txt', import.meta.url), 'utf8');
  const snapshot = parseQuotaScreen(protocol('grok'), { text, observedAt: '2026-10-31T17:20:37.000Z', version: '1.0.70', truncated: false });
  assert.equal(snapshot.completeness, 'complete');
  assert.equal(snapshot.reliable, true);
  assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(windows(snapshot, 'shared'), [
    { name: 'weekly', label: 'Weekly limit (SuperGrok Heavy)', state: 'measured', used: 0, remaining: 1, resetAt: '2026-11-07T16:58:00.000Z', resetUncertaintyMs: 60000, explanation: null },
  ]);
  for (const [used, remaining] of [[100, 0], [37.5, 0.625]]) {
    const variant = parseQuotaScreen(protocol('grok'), { text: text.replace(' 0%', ` ${used}%`), observedAt: snapshot.observedAt, version: '1.0.70', truncated: false });
    const [weekly] = windows(variant, 'shared');
    assert.equal(variant.completeness, 'complete');
    assert.equal(weekly.used, used / 100);
    assert.equal(weekly.remaining, remaining);
    assert.equal(weekly.resetAt, '2026-11-07T16:58:00.000Z');
    assert.equal(poolQuotaStatus(variant.pools[0], view(variant), snapshot.observedAt), remaining === 0 ? 'exhausted' : 'available');
  }
});

test('grok menu: Enter only on the exact /usage item; an autocompleted different command is never submitted', () => {
  const settings = protocol('grok');
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.grokReady, typed: null, typedAtMs: null, submitted: false, reissuedAtMs: null, elapsedMs: 600 }), { kind: 'type', text: '/usage' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.grokUsageMenu, typed: '/usage', typedAtMs: 500, submitted: false, reissuedAtMs: null, elapsedMs: 1500 }), { kind: 'submit' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.grokStatusAutocompleted, typed: '/usage', typedAtMs: 1000, submitted: false, reissuedAtMs: null, elapsedMs: 1500 }), { kind: 'wait' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.grokStatusAutocompleted, typed: '/usage', typedAtMs: 1000, submitted: false, reissuedAtMs: null, elapsedMs: 1000 + settings.timeouts.transitionMs }), { kind: 'stop', reason: 'command_mismatch' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.grokUsageModal, typed: '/usage', typedAtMs: 500, submitted: true, reissuedAtMs: null, elapsedMs: 2400 }), { kind: 'parse' });
});

test('agy /usage: menu item submit, remaining percentages, relative refresh and disabled five-hour windows per pool', () => {
  const settings = protocol('agy');
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.agyUsageMenu, typed: '/usage', typedAtMs: 500, submitted: false, reissuedAtMs: null, elapsedMs: 2400 }), { kind: 'submit' });
  assert.deepEqual(nextQuotaProbeAction(settings, { text: frames.agyUsagePanel, typed: '/usage', typedAtMs: 500, submitted: true, reissuedAtMs: null, elapsedMs: 2900 }), { kind: 'parse' });
  const snapshot = parseQuotaScreen(settings, { text: frames.agyUsagePanel, observedAt: '2026-10-22T12:47:34.000Z', version: '1.4.5', truncated: false });
  assert.equal(snapshot.completeness, 'complete');
  for (const [pool, label, resetAt] of [['gemini', 'GEMINI MODELS', '2026-10-24T02:34:34.000Z'], ['claude_gpt', 'CLAUDE AND GPT MODELS', '2026-10-26T16:17:34.000Z']] as const) {
    assert.equal(snapshot.pools.find(value => value.id === pool)?.label, label);
    const [weekly, fiveHour] = windows(snapshot, pool);
    assert.deepEqual(weekly, { name: 'weekly', label: 'Weekly Limit Remaining', state: 'measured', used: 1, remaining: 0, resetAt, resetUncertaintyMs: 60000, explanation: null });
    assert.equal(fiveHour.name, 'five_hour');
    assert.equal(fiveHour.state, 'disabled');
    assert.equal(fiveHour.used, null);
    assert.equal(fiveHour.remaining, null);
    assert.match(fiveHour.explanation ?? '', /^You have hit your weekly limit/);
  }
});

test('a different version warns while a truncated screen never yields a complete snapshot', () => {
  const wrongVersion = parseQuotaScreen(protocol('agy'), { text: frames.agyUsagePanel, observedAt: '2026-10-22T12:47:34.000Z', version: '1.4.3', truncated: false });
  assert.equal(wrongVersion.reliable, true);
  assert.equal(wrongVersion.completeness, 'complete');
  assert.ok(wrongVersion.issues.includes('версія 1.4.3 не збігається з перевіреною 1.4.7, протокол не перевірено'));
  const truncated = parseQuotaScreen(protocol('agy'), { text: frames.agyUsagePanel, observedAt: '2026-10-22T12:47:34.000Z', version: '1.4.5', truncated: true });
  assert.equal(truncated.completeness, 'partial');
});

test('pool status: zero remaining before reset is exhausted; reset passed, stale or missing data is unknown', () => {
  const codex = parseQuotaScreen(protocol('codex'), { text: frames.codexStatusLimits, observedAt: '2026-10-22T12:43:52.000Z', version: '0.163.0', truncated: false });
  const pool = codex.pools.find(value => value.id === 'shared') ?? null;
  assert.equal(poolQuotaStatus(pool, view(codex), '2026-10-22T13:00:00.000Z'), 'exhausted');
  assert.equal(poolQuotaStatus(pool, view(codex), '2026-10-27T07:00:00.000Z'), 'unknown');
  assert.equal(poolQuotaStatus(pool, view(codex, false), '2026-10-22T13:00:00.000Z'), 'unknown');
  assert.equal(poolQuotaStatus(null, view(codex), '2026-10-22T13:00:00.000Z'), 'unknown');
  const claude = parseQuotaScreen(protocol('claude'), { text: frames.claudeUsagePanel, observedAt: '2026-10-22T12:44:13.000Z', version: '2.1.308', truncated: false });
  assert.equal(poolQuotaStatus(claude.pools.find(value => value.id === 'all_models') ?? null, view(claude), '2026-10-22T12:45:00.000Z'), 'available');
  const agy = parseQuotaScreen(protocol('agy'), { text: frames.agyUsagePanel, observedAt: '2026-10-22T12:47:34.000Z', version: '1.4.5', truncated: false });
  assert.equal(poolQuotaStatus(agy.pools.find(value => value.id === 'claude_gpt') ?? null, view(agy), '2026-10-22T13:00:00.000Z'), 'exhausted');
});

test('routing entries carry each model its own pool status and an exhausted pool makes the model unavailable', () => {
  const now = '2026-10-22T13:00:00.000Z';
  const protocols = (['codex', 'claude', 'grok', 'agy'] as const).map(protocol);
  const snapshots = {
    codex: parseQuotaScreen(protocols[0], { text: frames.codexStatusLimits, observedAt: '2026-10-22T12:43:52.000Z', version: '0.163.0', truncated: false }),
    claude: parseQuotaScreen(protocols[1], { text: frames.claudeUsagePanel, observedAt: '2026-10-22T12:44:13.000Z', version: '2.1.308', truncated: false }),
    grok: parseQuotaScreen(protocols[2], { text: frames.grokUsageModal, observedAt: '2026-10-22T12:45:01.000Z', version: '1.0.67', truncated: false }),
    agy: parseQuotaScreen(protocols[3], { text: frames.agyUsagePanel, observedAt: '2026-10-22T12:47:34.000Z', version: '1.4.5', truncated: false }),
  };
  const views = Object.values(snapshots).map(snapshot => view(snapshot));
  const entries = routingQuotaEntries(protocols, views, models.models, now);
  const status = (model: string) => entries.find(entry => entry.pool === model)?.status;
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'grok-4.7', 'gemini-4-argon-high', 'claude-opus-5-5-high', 'claude-sonnet-5-5-high', 'gpt-oss-120b-medium']) assert.equal(status(model), 'exhausted', model);
  for (const model of ['claude-sonnet', 'claude-opus']) assert.equal(status(model), 'available', model);
  const list = listModelAvailability(models, { runnerEnabled: { codex: true, grok: true, agy: true, claude: true }, cliAvailable: { codex: true, grok: true, agy: true, claude: true }, quotas: entries });
  for (const row of list.filter(row => row.runner === 'codex')) {
    assert.equal(row.quota, 'exhausted');
    assert.equal(row.available, false);
    assert.ok(row.reasons.includes('Quota exhausted'));
  }
  const stale = routingQuotaEntries(protocols, [view(snapshots.codex, false)], models.models, now);
  assert.ok(!stale.some(entry => entry.runner === 'codex' && entry.status !== 'unknown'));
});
