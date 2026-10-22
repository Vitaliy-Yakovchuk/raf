import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { agentRunFixture as fixture, exists, until, type AgentRunFixture } from './agent-run-fixture.ts';
import { openStateStore } from '../src/state-store.ts';
import { NOTIFY_TARGET_INVALID, type PsSessionView } from '../src/launcher-notice.ts';

const change = 'launch-failure-fixture';
const timeouts = { startupMs: 20000, transitionMs: 5000, overallMs: 30000 };

async function runnerPid(f: AgentRunFixture, id: string) {
  await until(() => exists(join(f.control, `${id}.brief`)), Boolean, `${id} received its brief`);
  return Number(await fs.readFile(join(f.control, `${id}.brief`), 'utf8'));
}

const live = (f: AgentRunFixture, id: string) => {
  const found = f.inspect().sessions.find(session => session.addressId === id && session.state !== 'finished');
  assert.ok(found, `${id} has a live session`);
  return found as PsSessionView;
};

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

test('[result-notice-run] agent run rejects --notify with an unknown or closed agent ID before creating a session', { timeout: 120_000 }, async t => {
  const f = await fixture(t, 'notify-invalid', timeouts, 'codex', { tasks: 2 });
  const store = openStateStore(join(f.directory, 'home', '.raf', 'state.sqlite'));
  try {
    store.sessionRepository.transaction(tx => tx.putSession({
      runId: 'run-gone', addressId: 'gone', revision: 1, state: 'finished', finishedAt: '2026-10-22T00:00:00.000Z',
      activity: { type: 'implement', project: 'raf', features: [change], phase: 'implement', cwd: f.directory },
    }));
  } finally { store.close(); }
  for (const addressee of ['ghost', 'gone']) {
    const id = `worker-${addressee}`;
    const outcome = await f.command([...f.runArgs(id, 'implement', ['1.1']), '--notify', addressee]);
    assert.notEqual(outcome.exitCode, 0, JSON.stringify(outcome));
    const failure = JSON.parse(outcome.result.stderr);
    assert.equal(failure.code, NOTIFY_TARGET_INVALID, outcome.result.stderr);
    assert.ok(outcome.result.stderr.includes(addressee), outcome.result.stderr);
    const state = f.inspect();
    assert.deepEqual(state.sessions.filter(session => session.addressId === id), [], 'no session for a rejected launch');
    assert.deepEqual(state.claims, [], 'no task reservation for a rejected launch');
  }
  assert.deepEqual(await f.runners(), [], 'no runner started for a rejected launch');
});

test('[result-notice-run] accepted report of a --notify launch reaches only the named live agent without polling', { timeout: 180_000 }, async t => {
  const f = await fixture(t, 'notify-result', timeouts, 'codex', { tasks: 3 });
  for (const [id, task] of [['observer', '1.1'], ['bystander', '1.2']] as const) {
    const outcome = await f.run(id, 'implement', [task]);
    assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
  }
  const observerPid = await runnerPid(f, 'observer');
  const bystanderPid = await runnerPid(f, 'bystander');
  const launched = await f.command([...f.runArgs('worker', 'implement', ['1.3']), '--notify', 'observer']);
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  await runnerPid(f, 'worker');
  const observer = live(f, 'observer');
  const worker = live(f, 'worker');
  assert.deepEqual(worker.notify, { addressId: 'observer', runId: observer.runId }, 'the session keeps the resolved --notify addressee');
  const reportPath = worker.launchContext?.reportPath ?? '';
  assert.ok(reportPath, 'worker has a report path');
  const answer = 'Пункт 1.3 відхилено: суперечить специфікації';
  const report = { status: 'failed', answer, changes: [{ id: change, items: [{ id: '1.3', status: 'failed', reason: 'суперечить специфікації' }] }] };
  const staging = join(dirname(reportPath), `.worker-${process.pid}.tmp`);
  await fs.writeFile(staging, JSON.stringify(report), { mode: 0o600 });
  await fs.rename(staging, reportPath);
  const received = await until(() => f.input(observerPid), text => text.includes(reportPath), 'observer received the result notice');
  for (const part of ['worker', 'failed', `${change}:1.3`, reportPath, answer]) assert.ok(received.includes(part), `notice must contain ${part}`);
  await delay(1500);
  assert.equal(occurrences(await f.input(observerPid), reportPath), 1, 'exactly one notice');
  assert.equal((await f.input(bystanderPid)).includes(reportPath), false, 'other agents do not get the result');
  const after = live(f, 'worker');
  assert.equal(after.result?.status, 'failed');
  assert.equal(after.state, 'running', 'the agent stays open until closure');
});
