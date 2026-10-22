import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { agentRunFixture as fixture, assertFailedLaunchCleaned, exists, until } from './agent-run-fixture.ts';

const failureBudget = { startupMs: 20000, transitionMs: 5000, overallMs: 30000 };

test('[launch-failure-cleanup] trust prompt: LAUNCH_FAILED stops own runner and tmux session, removes launch directory, releases claims', async t => {
  const f = await fixture(t, 'trust', failureBudget);
  await assertFailedLaunchCleaned(f, await f.run('trust-agent'), 'trust');
});

test('[launch-failure-cleanup] silent runner: worker readiness timeout cleans its own launch', async t => {
  const f = await fixture(t, 'silent', { ...failureBudget, startupMs: 1500 });
  await assertFailedLaunchCleaned(f, await f.run('silent-agent'), 'silent');
});

test('[launch-failure-cleanup] parent handshake timeout terminates own worker and its tmux session', async t => {
  const f = await fixture(t, 'parent-timeout', { ...failureBudget, overallMs: 3000 });
  await assertFailedLaunchCleaned(f, await f.run('timeout-agent'), 'parent-timeout');
});

test('[launch-failure-cleanup] brief delivery failure cleans its own launch', async t => {
  const f = await fixture(t, 'delivery', failureBudget);
  await assertFailedLaunchCleaned(f, await f.run('delivery-agent'), 'delivery');
});

test('[launch-failure-cleanup] agent close without report exits 0 after confirmed closure and reports failed result', async t => {
  const f = await fixture(t, 'close', failureBudget);
  const launched = await f.run('close-agent');
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const runId = JSON.parse(launched.result.stdout).runId;
  await until(() => exists(join(f.control, 'close-agent.brief')), Boolean, 'runner received brief');
  await fs.writeFile(join(f.control, 'close-agent.close'), 'close');
  const code = await until(async () => await exists(join(f.control, 'close-agent.close.code')) ? (await fs.readFile(join(f.control, 'close-agent.close.code'), 'utf8')).trim() : null, value => value !== null, 'agent close finished');
  const printed = await fs.readFile(join(f.control, 'close-agent.close.out'), 'utf8');
  assert.equal(code, '0', printed);
  const result = JSON.parse(printed);
  const output = JSON.parse(result.stdout);
  assert.equal(output.closed, true, printed);
  assert.equal(output.result, 'failed', printed);
  assert.deepEqual(output.unfinished, []);
  const snapshot = f.inspect();
  const session = snapshot.sessions.find(row => row.runId === runId)!;
  assert.equal(session.state, 'finished');
  assert.equal(session.result?.status, 'failed');
  assert.deepEqual(snapshot.claims, []);
  assert.deepEqual(snapshot.admission, []);
  assert.ok(snapshot.pending.some(row => row.runId === runId && row.event === 'agent.failed'), JSON.stringify(snapshot.pending));
  assert.deepEqual(await f.runDirectories(), []);
  assert.deepEqual(await f.tmuxSessions(), []);
  await until(f.owned, pids => pids.length === 0, 'no fixture process remains after close', 5000);
});
