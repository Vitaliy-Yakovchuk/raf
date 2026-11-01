import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildRunnerInvocation, nextRunnerAction, observeRunnerScreen } from '../src/runner-protocols.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const raf = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const protocol = (runner: string): ProtocolSettings => {
  const rows = raf.runnerProtocols.filter((row: ProtocolSettings) => row.runner === runner);
  assert.equal(rows.length, 1, `conf/raf.json must define exactly one ${runner} protocol`);
  return structuredClone(rows[0]);
};
const updateOverride = 'check_for_update_on_startup=false';
const updateScreen = [
  'Update available · 0.163.0 → 0.164.0',
  'Update now',
  'Skip',
  'Skip until next version',
].join('\n');

function updateOverrides(args: readonly string[]): string[] {
  return args.filter((arg, index) => (args[index - 1] === '-c' || args[index - 1] === '--config') && arg === updateOverride);
}

test('pinned Codex launch disables the interactive update check without rewriting protocol or owner config', () => {
  const codex = protocol('codex');
  const before = structuredClone(codex);
  const prompt = 'line one\n$(touch forbidden)';
  const invocation = buildRunnerInvocation(codex, { model: 'gpt-6.1-sol', effort: 'high', prompt });
  assert.equal(codex.version, '0.163.0');
  assert.equal(codex.liveTaskVerified, before.liveTaskVerified);
  assert.deepEqual(codex.baseArgs, before.baseArgs);
  assert.deepEqual(codex, before);
  assert.equal(invocation.executable, 'codex');
  assert.equal(invocation.liveTaskVerified, codex.liveTaskVerified);
  assert.equal(invocation.args.at(-1), prompt);
  assert.deepEqual(updateOverrides(invocation.args), [updateOverride]);
  assert.ok(invocation.args.indexOf(updateOverride) < invocation.args.length - 1);
  assert.equal(invocation.args.includes('--no-daemon'), true);
  assert.equal(invocation.args.includes('model_reasoning_effort="high"'), true);
  assert.equal(invocation.args.some(arg => /config\.toml|version\.json|dismissed_version|0\.164\.0/.test(arg)), false);
});

test('an explicit Codex update override in baseArgs is kept once and still precedes the prompt', () => {
  const codex = protocol('codex');
  codex.baseArgs = [...codex.baseArgs, '-c', updateOverride];
  const invocation = buildRunnerInvocation(codex, { model: 'gpt-6.1-sol', effort: 'high', prompt: 'task' });
  assert.deepEqual(updateOverrides(invocation.args), [updateOverride]);
  assert.equal(invocation.args.at(-1), 'task');
  assert.deepEqual(codex.baseArgs.slice(-2), ['-c', updateOverride]);
});

test('Claude, Grok and AGY launches do not receive the Codex update override', () => {
  const launches = [
    buildRunnerInvocation(protocol('claude'), { model: 'claude-sonnet', effort: 'high' }),
    buildRunnerInvocation(protocol('grok'), { model: 'grok-4.7', effort: 'high' }),
    buildRunnerInvocation(protocol('agy'), { model: 'gemini-4-argon-high', effort: 'high' }),
  ];
  for (const invocation of launches) assert.deepEqual(updateOverrides(invocation.args), []);
});

test('Codex update screen stays unknown and does not confirm Update now or dismiss the next version', () => {
  const codex = protocol('codex');
  const observation = observeRunnerScreen(codex, { text: updateScreen, version: codex.version, requestedCommand: null });
  assert.equal(observation.state, 'unknown_screen');
  assert.equal(observation.matchedNavigation, null);
  assert.deepEqual(nextRunnerAction(codex, observation), { kind: 'stop', reason: 'unknown_screen' });
  assert.equal(codex.version, '0.163.0');
});
