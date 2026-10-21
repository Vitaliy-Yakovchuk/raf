import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRunnerInvocation, nextRunnerAction, observeRunnerScreen, parseRunnerQuota, quotaForModel } from '../src/runner-protocols.ts';
import type { ProtocolSettings, RunnerId } from '../src/runner-protocols.ts';

function settings(runner: RunnerId): ProtocolSettings {
  return {
    runner, executable: runner, version: runner === 'agy' ? '1.4.3' : '0.160.0', baseArgs: [],
    modelFlag: '--model', effortFlag: runner === 'codex' ? '-c' : runner === 'grok' ? '--reasoning-effort' : '--effort',
    effortFormat: runner === 'codex' ? 'codex_config' : 'literal', modelAliases: { 'claude-opus': 'opus', 'claude-sonnet': 'sonnet' },
    promptTransport: runner === 'agy' ? 'prompt_interactive' : 'positional', sessionIdFlag: runner === 'grok' || runner === 'claude' ? '--session-id' : null,
    quotaCommand: runner === 'agy' ? '/usage' : runner === 'codex' ? '/status' : null,
    navigation: [{ state: 'known_navigation', match: '/usage', keys: ['Enter'] }],
    markers: { ready: ['Ask Codex to do anything'], known_navigation: ['↑/↓ Navigate · enter Select · tab Complete'], auth_required: ['Waiting for browser sign-in'], permission_required: ['Approve permission?'] },
    quotaParser: runner === 'agy' ? 'agy_usage' : runner === 'codex' ? 'codex_status' : 'unknown',
    modelPools: { 'gemini-4-argon-high': 'gemini', 'claude-opus-5-5-high': 'claude_gpt' },
    quotaReliable: runner === 'agy', liveTaskVerified: false,
    timeouts: { startupMs: 20, transitionMs: 20, overallMs: 80, pollMs: 5 },
    collection: { intervalMs: 100, failureBackoffMs: 200, staleAfterMs: 1000 },
  };
}
const observedAt = '2030-12-31T23:30:00.000Z';
const panel = `Models & Quota
GEMINI MODELS
Gemini Flash / Gemini Pro
Weekly Limit Remaining 75%
Refreshes in 1h 0m
Five Hour Limit Remaining 40%
Refreshes in 0h 45m
CLAUDE AND GPT MODELS
Claude Opus / Claude Sonnet / GPT-OSS
Weekly Limit Remaining 20%
Refreshes in 2h 0m
Five Hour Limit Remaining
Disabled: synthetic plan restriction`;
function parse(runner: RunnerId, text: string, truncated = false) {
  const config = settings(runner);
  return parseRunnerQuota(config, { text, observedAt, truncated, version: config.version });
}

test('interactive argv preserves literal task text and explicit configured effort without shell interpretation', () => {
  const prompt = 'line one\n$(touch forbidden); `literal`';
  for (const runner of ['codex', 'grok', 'agy', 'claude'] as const) {
    const result = buildRunnerInvocation(settings(runner), { model: runner === 'claude' ? 'claude-opus' : 'synthetic-model', effort: 'high', prompt });
    assert.equal(result.executable, runner);
    assert.ok(result.args.includes(prompt));
    assert.ok(result.args.includes(runner === 'claude' ? 'opus' : 'synthetic-model'));
    assert.ok(result.args.includes(runner === 'codex' ? 'model_reasoning_effort="high"' : 'high'));
    assert.equal(result.liveTaskVerified, false);
    assert.ok(!result.args.includes('--prompt-file'));
    assert.ok(!result.args.includes('--print'));
    if (runner === 'agy') assert.equal(result.args[result.args.indexOf('--prompt-interactive') + 1], prompt);
  }
});
test('session identifiers are explicit argv only where supported', () => {
  const result = buildRunnerInvocation(settings('grok'), { model: 'grok-4.7', effort: 'high', sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(result.args[result.args.indexOf('--session-id') + 1], '11111111-1111-4111-8111-111111111111');
});
test('agy keeps independent remaining pools, disabled windows and relative reset rollover', () => {
  const result = parse('agy', panel);
  const gemini = quotaForModel(settings('agy'), result, 'gemini-4-argon-high');
  const claude = quotaForModel(settings('agy'), result, 'claude-opus-5-5-high');
  assert.equal(gemini?.windows[0].remaining, 0.75);
  assert.equal(gemini?.windows[0].used, 0.25);
  assert.equal(gemini?.windows[0].resetAt, '2031-01-01T00:30:00.000Z');
  assert.ok((gemini?.windows[0].resetUncertaintyMs ?? 0) > 0);
  assert.equal(claude?.windows[0].remaining, 0.2);
  assert.equal(claude?.windows[1].state, 'disabled');
  assert.equal(claude?.windows[1].remaining, null);
  assert.equal(claude?.windows[1].used, null);
  assert.equal(claude?.windows[1].resetAt, null);
  assert.equal(quotaForModel(settings('agy'), result, 'unmapped-model'), null);
});
test('truncated or missing agy sections cannot claim complete quota', () => {
  assert.equal(parse('agy', panel, true).completeness, 'partial');
  assert.notEqual(parse('agy', panel.split('CLAUDE AND GPT MODELS')[0]).completeness, 'complete');
});
test('Codex remaining and credits stay separate and ambiguous reset stays unknown and untrusted', () => {
  const result = parse('codex', 'Weekly limit: 60% left (resets 12:00 on 01 Jan)\nCredits: 12');
  const weekly = result.pools.flatMap(pool => pool.windows).find(window => window.name === 'weekly');
  assert.equal(weekly?.remaining, 0.6);
  assert.equal(weekly?.used, 0.4);
  assert.equal(weekly?.resetAt, null);
  assert.equal(result.credits, 12);
  assert.equal(result.reliable, false);
  assert.ok(!result.pools.flatMap(pool => pool.windows).some(window => window.name === 'five_hour' && window.remaining !== null));
});
test('unknown runner quota shapes never manufacture capacity', () => {
  for (const runner of ['grok', 'claude'] as const) {
    const result = parse(runner, 'Synthetic unverified quota screen');
    assert.equal(result.completeness, 'unknown');
    assert.equal(result.reliable, false);
    assert.deepEqual(result.pools, []);
  }
});
test('navigation only confirms the exact requested command on recognized menu', () => {
  const config = settings('agy');
  const observation = observeRunnerScreen(config, { text: '/usage\n↑/↓ Navigate · enter Select · tab Complete', version: config.version, requestedCommand: '/usage' });
  assert.equal(observation.state, 'known_navigation');
  assert.deepEqual(nextRunnerAction(config, observation), { kind: 'keys', keys: ['Enter'] });
  const unrelated = observeRunnerScreen(config, { text: '/exit\n↑/↓ Navigate · enter Select · tab Complete', version: config.version, requestedCommand: '/usage' });
  assert.equal(nextRunnerAction(config, unrelated).kind, 'stop');
});
test('unknown, permission and auth screens stop without confirmation and incompatible versions do not send commands', () => {
  for (const [text, expected] of [['mystery menu', 'unknown_screen'], ['Approve permission?', 'permission_required'], ['Waiting for browser sign-in', 'auth_required']] as const) {
    const config = settings('grok');
    const observation = observeRunnerScreen(config, { text, version: config.version, requestedCommand: null });
    assert.equal(observation.state, expected);
    assert.deepEqual(nextRunnerAction(config, observation), { kind: 'stop', reason: expected });
  }
  const config = settings('codex');
  const observation = observeRunnerScreen(config, { text: 'Ask Codex to do anything', version: 'unverified-version', requestedCommand: null });
  assert.equal(nextRunnerAction(config, observation).kind, 'stop');
});
test('ready state sends configured command as text before a later observed submission', () => {
  assert.deepEqual(nextRunnerAction(settings('codex'), { state: 'ready', requestedCommand: null, matchedNavigation: null }), { kind: 'text', text: '/status' });
});
