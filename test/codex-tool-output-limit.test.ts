import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildRunnerInvocation, type ProtocolSettings } from '../src/runner-protocols.ts';

const { runnerProtocols } = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const protocols = runnerProtocols as ProtocolSettings[];

test('Codex launches receive the measured tool output budget before the literal prompt', () => {
  const settings = structuredClone(protocols.find(protocol => protocol.runner === 'codex')!);
  const before = structuredClone(settings);
  for (const prompt of [undefined, 'task\n$(literal)']) {
    const invocation = buildRunnerInvocation(settings, { model: 'gpt-6.1-sol', effort: 'high', prompt });
    const budgetIndex = invocation.args.indexOf('tool_output_token_limit=4000');
    assert.ok(budgetIndex > 0, 'Codex must receive tool_output_token_limit=4000');
    assert.equal(invocation.args[budgetIndex - 1], '-c');
    assert.equal(invocation.args.filter(arg => arg.startsWith('tool_output_token_limit=')).length, 1);
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
    if (prompt !== undefined) {
      assert.equal(invocation.args.at(-1), prompt);
      assert.ok(budgetIndex < invocation.args.length - 1);
    }
  }
  assert.deepEqual(settings, before);
});

test('other runners retain their invocation without a Codex tool output budget', () => {
  for (const settings of protocols.filter(protocol => protocol.runner !== 'codex')) {
    const invocation = buildRunnerInvocation(settings, { model: 'synthetic-model', effort: 'high', prompt: 'task' });
    assert.equal(invocation.args.some(arg => arg.startsWith('tool_output_token_limit=')), false);
    assert.equal(invocation.args.at(-1), 'task');
  }
});
