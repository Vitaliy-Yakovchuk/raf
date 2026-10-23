import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { agentRunFixture as fixture, assertFailedLaunchCleaned, exists, until } from './agent-run-fixture.ts';

const failureBudget = { startupMs: 20000, transitionMs: 5000, overallMs: 30000 };

test('[launch-failure-cleanup] trust prompt: LAUNCH_FAILED stops own runner and tmux session, removes launch directory, releases claims', async t => {
  const f = await fixture(t, 'trust', failureBudget, 'codex', { productionQa: true });
  await assertFailedLaunchCleaned(f, await f.run('trust-agent'), 'trust');
});

test('[launch-failure-cleanup] silent runner: worker readiness timeout cleans its own launch', async t => {
  const f = await fixture(t, 'silent', { ...failureBudget, startupMs: 1500 }, 'codex', { productionQa: true });
  await assertFailedLaunchCleaned(f, await f.run('silent-agent'), 'silent');
});

test('[launch-failure-cleanup] parent handshake timeout terminates own worker and its tmux session', async t => {
  const f = await fixture(t, 'parent-timeout', { ...failureBudget, overallMs: 3000 }, 'codex', { productionQa: true });
  await assertFailedLaunchCleaned(f, await f.run('timeout-agent'), 'parent-timeout');
});

test('[launch-failure-cleanup] brief delivery failure cleans its own launch', async t => {
  const f = await fixture(t, 'delivery', failureBudget, 'codex', { productionQa: true });
  await assertFailedLaunchCleaned(f, await f.run('delivery-agent'), 'delivery');
});

test('[Z.125] delivery failure survives directory cleanup in the durable session and closed failures do not warn in ps', async t => {
  const f = await fixture(t, 'delivery', failureBudget, 'codex', { productionQa: true, commands: ['agent ps'] });
  const outcome = await f.run('cause-agent');
  await assertFailedLaunchCleaned(f, outcome, 'delivery');
  const session = f.inspect().sessions[0];
  assert.match(session.abortReason ?? '', /Unknown native input or screen during initial brief submission/);
  const before = JSON.stringify(session);
  for (let index = 0; index < 2; index++) {
    const ps = await f.command(['agent', 'ps']);
    assert.equal(ps.exitCode, 0, JSON.stringify(ps));
    assert.doesNotMatch(ps.stderr, /Assignment completion is not confirmed/);
    assert.doesNotMatch(ps.result.stderr, /Assignment completion is not confirmed/);
  }
  assert.equal(JSON.stringify(f.inspect().sessions[0]), before);
});

test('[launch-failure-cleanup] agent close without report exits 0 after confirmed closure and reports failed result', async t => {
  const f = await fixture(t, 'close', failureBudget, 'codex', { productionQa: true });
  const launched = await f.run('close-agent');
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const runId = JSON.parse(launched.result.stdout).runId;
  await until(() => exists(join(f.control, 'close-agent.brief')), Boolean, 'runner received brief');
  const watcher = { id: 'watch-close-agent', createdFor: 'main', assignedTo: 'main', text: 'close-agent failed', at: '2099-01-01T00:00:00.000Z',
    binding: { kind: 'agent.failed', id: 'close-agent', action: 'activate' as const }, state: 'pending' as const, closedAt: null, closeReason: null };
  f.seedReminder(watcher);
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
  assert.equal(snapshot.reminders.find(row => row.id === watcher.id)?.state, 'active', JSON.stringify(snapshot.reminders));
  assert.ok(!snapshot.pending.some(row => row.event === 'agent.failed'), JSON.stringify(snapshot.pending));
  assert.deepEqual(await f.runDirectories(), []);
  assert.deepEqual(await f.tmuxSessions(), []);
  await until(f.owned, pids => pids.length === 0, 'no fixture process remains after close', 5000);
});

test('[launch-failure-cleanup] claude screen failure after Enter: the delivery cause leads the error, a runner that exits after its hangup delay is confirmed dead and claims are released', async t => {
  const f = await fixture(t, 'claude-unknown-after-enter', failureBudget, 'claude', { productionQa: true });
  const outcome = await f.run('claude-screen-agent');
  const failure = JSON.parse(outcome.result.stderr);
  const message = String(failure.message);
  const primary = message.indexOf('Unknown native input or screen during initial brief submission');
  assert.ok(primary >= 0, `the screen failure must be the reported cause: ${message}`);
  const secondary = message.indexOf('Task reservation cannot be released');
  assert.ok(secondary < 0 || secondary > primary, `a cleanup failure may only follow the real cause: ${message}`);
  await assertFailedLaunchCleaned(f, outcome, 'claude-unknown-after-enter');
});
