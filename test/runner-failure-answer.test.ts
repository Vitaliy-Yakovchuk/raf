import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { runnerResultAnswer, resultNoticeText } from '../src/launcher-notice.ts';

const exit = { code: null, signal: null };
const failed = { status: 'failed' as const, exit };

test('runner stderr before a report reaches agent.failed Answer', async () => {
  const message = 'error: invalid model selection (--model "gemini-4-argon-high"): model gemini-4-argon-high is not recognized';
  const runner = spawnSync(process.execPath, ['-e', 'process.stderr.write(process.argv[1]); process.exit(1)', message], { encoding: 'utf8' });
  assert.equal(runner.status, 1);
  const answer = await runnerResultAnswer(failed, async () => runner.stderr);
  const notice = resultNoticeText({ address: 'fixture', status: 'failed', items: ['change:1.1'], reportPath: '/tmp/absent.json', answer, reason: null });
  assert.ok(notice.includes(message), notice);
  assert.match(notice, /Answer: процес завершився без валідного звіту/);
});

test('a valid report supplies its answer without reading runner output', async () => {
  assert.equal(await runnerResultAnswer({ ...failed, report: { answer: 'Reported failure' } }, async () => { throw new Error('must not capture'); }), 'Reported failure');
});

test('absent or unavailable output preserves exit diagnostics', async () => {
  for (const capture of [async () => '', async () => { throw new Error('pane vanished'); }]) {
    assert.equal(await runnerResultAnswer(failed, capture), 'процес завершився без валідного звіту: {"code":null,"signal":null}');
  }
});
