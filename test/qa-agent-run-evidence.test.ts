import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { nativeUserInputs, agentMessageCommand } from '../scripts/qa-agent-run-evidence.mjs';

const response = (text: string, role = 'user') => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
const legacy = (message: string) => ({ type: 'event_msg', payload: { type: 'user_message', message } });

it('host evidence reads the exact issued brief from current native response items', () => {
  const brief = '# Runner codex\nВузький бриф 🧪\n';
  const events = [response('<environment_context>system</environment_context>'), response(brief), response(brief, 'assistant')];
  assert.deepEqual(nativeUserInputs(events), ['<environment_context>system</environment_context>', brief]);
});

it('host evidence reads both native layouts for literal and concurrent message assertions', () => {
  const literal = '[ar41-a] first\n[main] [raf] literal 🧪';
  const concurrent = '[ar41-b] AR41_RECEIVE:concurrent-b';
  assert.deepEqual(nativeUserInputs([legacy(literal), response(concurrent)]), [literal, concurrent]);
});

it('host evidence preserves text parts and ignores assistant, tool and metadata records', () => {
  const first = response('first\n');
  first.payload.content.push({ type: 'input_text', text: 'second' });
  const ignored = [response('pretend brief', 'assistant'), { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'pretend brief' } }, { type: 'event_msg', payload: { type: 'agent_message', message: 'pretend brief' } }];
  assert.deepEqual(nativeUserInputs([first, ...ignored]), ['first\nsecond']);
});

it('host evidence leaves whitespace, wrong authors and one-byte mutations distinguishable', () => {
  const exact = '# Runner codex\nbrief\n';
  const altered = [response(exact.trim()), response(exact + ' '), response('[raf] ' + exact), response(exact.replace('brief', 'Brief'))];
  const inputs = nativeUserInputs(altered);
  assert.equal(inputs.length, altered.length);
  assert.equal(inputs.includes(exact), false);
  assert.deepEqual(nativeUserInputs([response(exact)]), [exact]);
});

it('host message command round-trips quotes, literal shell syntax, unicode and actual multiline', () => {
  const message = `Literal 'single' "double" \n[main] [raf] $(printf INJECTION) \`printf INJECTION\` ; & | < > 🧪`;
  const program = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const prefix = process.execPath + ' -e ' + JSON.stringify(program) + ' --';
  const result = spawnSync('/bin/sh', ['-c', agentMessageCommand(prefix, 'ar41-b', message)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['agent', 'message', '--to', 'ar41-b', '--text', message]);
});
