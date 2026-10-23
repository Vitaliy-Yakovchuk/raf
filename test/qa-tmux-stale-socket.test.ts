import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { alive, assertFailedLaunchCleaned, exists, until } from './agent-run-fixture.ts';
import { qaTmuxFixture } from './qa-tmux-stale-socket-fixture.ts';

type Fixture = Awaited<ReturnType<typeof qaTmuxFixture>>;

async function collectLastQuota(f: Fixture) {
  assert.equal(await exists(f.socket), false, 'quota collection starts without an existing server');
  const outcome = await f.command(['runner', 'limits', '--runners', 'claude']);
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
  assert.equal(outcome.result.exitCode, 0, JSON.stringify(outcome));
  assert.match(outcome.result.stdout, /claude/u);
  assert.equal(await fs.readFile(join(f.control, 'quota-panel.log'), 'utf8'), 'usage\n', 'the synthetic native quota panel was actually requested');
  assert.deepEqual(await f.runners(), [], 'quota collection never starts a task runner');
  assert.deepEqual(f.inspect().claims, []);
  assert.deepEqual(f.inspect().admission, []);
  await f.staleSocket();
  const argv = (await fs.readFile(join(f.control, 'tmux-argv.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.ok(argv.some(args => args.includes('new-session')), 'production created the quota tmux session');
  for (const args of argv) {
    assert.equal(args[0], '-S', JSON.stringify(args));
    assert.equal(args[1], f.socket, 'the fixture must preserve the production socket address');
    assert.equal(args.includes('-L'), false, 'a label redirect would bypass the stale socket guard');
  }
}

function assertReservationsReleased(f: Fixture) {
  const snapshot = f.inspect();
  assert.deepEqual(snapshot.claims, [], 'no task claims survive a confirmed failed launch');
  assert.deepEqual(snapshot.admission, [], 'no admission reservations survive a confirmed failed launch');
  assert.ok(snapshot.sessions.every(session => session.state === 'finished'), 'every attempted launch is terminal');
  const db = new DatabaseSync(f.statePath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT * FROM task_reservation_runs').all(), [], 'no orphan reservation-run fences remain');
    assert.deepEqual(db.prepare('SELECT * FROM delivery_claims').all(), [], 'no delivery claims remain');
  } finally { db.close(); }
}

test('[Z.352] runner limits leaves a dead socket and the next agent run reaches native working', async t => {
  const f = await qaTmuxFixture(t);
  await collectLastQuota(f);
  const outcome = await f.run('after-quota');
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
  assert.equal(outcome.result.exitCode, 0, JSON.stringify(outcome));
  const pid = Number(await fs.readFile(join(f.control, 'after-quota.brief'), 'utf8'));
  assert.equal(alive(pid), true, 'the task runner received the brief and remains working');
  const snapshot = f.inspect();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].state, 'running');
  for (const name of ['HOME', 'RAF_QA_HOME']) {
    const result = await f.tmux(['show-environment', '-g', name]);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stdout.trim(), `${name}=${f.home}`, 'the recreated server belongs to the QA HOME');
  }
});

test('[Z.352] delivery failure after quota cleanup releases reservations and allows another start on the dead socket', async t => {
  const f = await qaTmuxFixture(t, 'claude-unknown-after-enter');
  await collectLastQuota(f);
  for (const id of ['first-after-quota', 'retry-after-cleanup']) {
    const previousRunners = await f.runners();
    const outcome = await f.run(id);
    assert.equal(outcome.exitCode, 1, JSON.stringify(outcome));
    assert.match(outcome.result.stderr, /Unknown native input or screen during initial brief submission/u);
    assert.doesNotMatch(outcome.result.stderr, /STATE_CONTEXT_REFUSED|foreign HOME|foreign RAF_QA_HOME/u);
    const runners = await f.runners();
    assert.equal(runners.length, previousRunners.length + 1, 'each attempt really started a native task runner');
    await assertFailedLaunchCleaned({
      ...f,
      runners: async () => runners.filter(pid => !previousRunners.includes(pid)),
      inspect: () => ({ ...f.inspect(), sessions: f.inspect().sessions.filter(session => session.addressId === id) }),
    }, outcome, id);
    assertReservationsReleased(f);
    await f.staleSocket();
  }
});

for (const variant of [
  { name: 'foreign HOME', variable: 'HOME', missing: false },
  { name: 'foreign RAF_QA_HOME', variable: 'RAF_QA_HOME', missing: false },
  { name: 'missing HOME on a live server', variable: 'HOME', missing: true },
  { name: 'missing RAF_QA_HOME on a live server', variable: 'RAF_QA_HOME', missing: true },
]) {
  test(`[Z.352] ${variant.name} is refused without touching the live server`, async t => {
    const f = await qaTmuxFixture(t);
    const started = await f.tmux(['new-session', '-d', '-s', 'foreign-sentinel', 'sleep', '300']);
    assert.equal(started.exitCode, 0, JSON.stringify(started));
    const mutation = await f.tmux(variant.missing
      ? ['set-environment', '-gu', variant.variable]
      : ['set-environment', '-g', variant.variable, join(f.directory, 'foreign-home')]);
    assert.equal(mutation.exitCode, 0, JSON.stringify(mutation));
    const identityArgs = ['display-message', '-p', '-t', 'foreign-sentinel', '#{pid}:#{pane_pid}:#{session_id}:#{pane_id}'];
    const before = await f.tmux(identityArgs);
    assert.equal(before.exitCode, 0, JSON.stringify(before));
    const environmentBefore = await f.tmux(['show-environment', '-g']);
    assert.equal(environmentBefore.exitCode, 0);
    const outcome = await f.run('foreign-refused');
    assert.equal(outcome.exitCode, 1, JSON.stringify(outcome));
    assert.match(outcome.result.stderr, /STATE_CONTEXT_REFUSED/u);
    assert.deepEqual(await f.runners(), [], 'no native task runner starts in the foreign context');
    assert.equal(await exists(join(f.control, 'foreign-refused.brief')), false);
    assert.deepEqual(await f.tmux(identityArgs), before, 'server and sentinel identities are preserved');
    assert.deepEqual(await f.tmux(['show-environment', '-g']), environmentBefore, 'refusal never rewrites the foreign environment');
    assert.deepEqual(await f.tmuxSessions(), ['foreign-sentinel']);
    const failure = JSON.parse(outcome.result.stderr);
    assert.deepEqual(failure.details.pending, [], 'the failed launch owns no live native process');
    assert.equal(failure.details.retrySafe, true, 'only the foreign server survives the refused launch');
    await until(() => f.inspect(), snapshot => snapshot.sessions.every(session => session.state === 'finished'), 'the refused launch is finalized', f.protocol.timeouts.transitionMs);
    assertReservationsReleased(f);
    assert.deepEqual(await f.runDirectories(), [], 'the refused launch leaves no run directory');
  });
}
