import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agentRunFixture as fixture, alive, exists, until, type AgentRunFixture } from './agent-run-fixture.ts';
import type { SessionRecord } from '../src/session-state.ts';

const change = 'launch-failure-fixture';
const timeouts = { startupMs: 20000, transitionMs: 5000, overallMs: 30000 };
const answer = 'Пункт 1.1 виконано після зникнення обгортки';

async function launchOrphan(f: AgentRunFixture, id: string) {
  const launched = await f.run(id);
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const runId: string = JSON.parse(launched.result.stdout).runId;
  await until(() => exists(join(f.control, `${id}.brief`)), Boolean, `${id} received its brief`);
  const runner = Number(await fs.readFile(join(f.control, `${id}.brief`), 'utf8'));
  const snapshot = f.inspect();
  const session = snapshot.sessions.find(row => row.runId === runId)!;
  const wrapper = session.launchContext?.wrapper ?? snapshot.claims.find(set => set.lease.owner.runId === runId)?.wrapper;
  assert.ok(wrapper && wrapper.pid !== runner, 'the launch has a separate worker (report watcher) identity');
  assert.ok(alive(wrapper.pid), 'worker watches the report before it is killed');
  process.kill(wrapper.pid, 'SIGKILL');
  await until(() => alive(wrapper.pid), value => !value, 'worker is gone', 5000);
  assert.ok(alive(runner), 'the interactive runner outlives its worker in tmux');
  return { runId, runner, reportPath: session.launchContext!.reportPath };
}

async function completeTask(f: AgentRunFixture) {
  const tasks = join(f.directory, 'orchestrator', 'openspec', 'changes', change, 'tasks.md');
  await fs.writeFile(tasks, (await fs.readFile(tasks, 'utf8')).replace('- [ ] 1.1 ', '- [x] 1.1 '));
}

async function writeReport(reportPath: string, report: unknown) {
  const staging = join(dirname(reportPath), `.late-${process.pid}.tmp`);
  await fs.writeFile(staging, JSON.stringify(report), { mode: 0o600 });
  await fs.rename(staging, reportPath);
}

const succeeded = { status: 'succeeded', answer, changes: [{ id: change, items: [{ id: '1.1', status: 'succeeded' }] }] };

async function closeAsAgent(f: AgentRunFixture, id: string) {
  await fs.writeFile(join(f.control, `${id}.close`), 'close');
  const code = await until(async () => await exists(join(f.control, `${id}.close.code`)) ? (await fs.readFile(join(f.control, `${id}.close.code`), 'utf8')).trim() : null, value => value !== null, `${id} agent close finished`);
  const printed = await fs.readFile(join(f.control, `${id}.close.out`), 'utf8');
  const diagnostics = await fs.readFile(join(f.control, `${id}.close.err`), 'utf8');
  assert.equal(code, '0', `${printed}\n${diagnostics}`);
  return JSON.parse(JSON.parse(printed).stdout) as { closed: boolean; unfinished: unknown[]; result?: string };
}

// The result event is observed through its effect on bound reminders (event-registry «Активація і закриття окремі»):
// processed facts are removed from pending, so pending is not a journal of handled events.
function seedResultWatchers(f: AgentRunFixture, address: string) {
  const base = { createdFor: 'main', assignedTo: 'main', at: '2099-01-01T00:00:00.000Z', closedAt: null, closeReason: null };
  const watchers = {
    succeeded: `${address}-on-succeeded`,
    succeededClose: `${address}-closed-by-succeeded`,
    failed: `${address}-on-failed`,
  };
  f.seedReminder({ ...base, id: watchers.succeeded, text: `${address} succeeded`, binding: { kind: 'agent.succeeded', id: address, action: 'activate' }, state: 'pending' });
  f.seedReminder({ ...base, id: watchers.succeededClose, text: `waiting for ${address}`, binding: { kind: 'agent.succeeded', id: address, action: 'close' }, state: 'active' });
  f.seedReminder({ ...base, id: watchers.failed, text: `${address} failed`, binding: { kind: 'agent.failed', id: address, action: 'activate' }, state: 'pending' });
  return watchers;
}

function reminder(f: AgentRunFixture, id: string) {
  const found = f.inspect().reminders.find(row => row.id === id);
  assert.ok(found, `reminder ${id} exists`);
  return found;
}

function assertResultEventsSettled(f: AgentRunFixture, runId: string) {
  const left = f.inspect().pending.filter(intent => intent.runId === runId && /^agent\.(succeeded|failed)$/.test(intent.event));
  assert.deepEqual(left, [], 'the result fact is processed by the command, not left pending');
}

function assertClosedClean(f: AgentRunFixture, runId: string, status: string) {
  const snapshot = f.inspect();
  const session = snapshot.sessions.find(row => row.runId === runId);
  assert.equal(session?.state, 'finished');
  assert.equal(session?.result?.status, status);
  assert.ok(!session?.result?.response, 'the finished-session record keeps no dialog (state-store «Добова історія завершених сесій»)');
  assert.deepEqual(snapshot.claims, [], 'task reservations released');
  assert.deepEqual(snapshot.admission, [], 'admission released');
  return snapshot;
}

function psRow(listed: Awaited<ReturnType<AgentRunFixture['command']>>, address: string) {
  assert.equal(listed.exitCode, 0, JSON.stringify(listed));
  return (JSON.parse(listed.result.stdout) as SessionRecord[]).find(candidate => candidate.addressId === address);
}

test('[report-orphan] after the worker is killed, a later valid report is accepted by agent ps, and agent close closes with it', { timeout: 180_000 }, async t => {
  const f = await fixture(t, 'orphan-ps', timeouts, 'codex', { commands: ['agent ps'] });
  const { runId, reportPath } = await launchOrphan(f, 'orphan-agent');
  const watchers = seedResultWatchers(f, 'orphan-agent');
  await completeTask(f);
  await writeReport(reportPath, succeeded);
  await delay(500);
  assert.equal(f.inspect().sessions.find(row => row.runId === runId)?.result, undefined, 'no live watcher: nothing accepts the report on its own');
  const row = psRow(await f.command(['agent', 'ps']), 'orphan-agent');
  assert.equal(row?.state, 'running', 'the runner is still open until closure');
  assert.equal(row?.result?.status, 'succeeded', JSON.stringify(row));
  assert.equal(row?.result?.response, answer, 'the accepted answer is visible in ps before closure');
  assertResultEventsSettled(f, runId);
  assert.equal(reminder(f, watchers.succeeded).state, 'active', 'agent.succeeded was emitted for the address');
  const closedOnce = reminder(f, watchers.succeededClose);
  assert.equal(closedOnce.state, 'closed', 'agent.succeeded closes the bound reminder');
  assert.equal(reminder(f, watchers.failed).state, 'pending', 'no agent.failed over the valid report');
  const again = psRow(await f.command(['agent', 'ps']), 'orphan-agent');
  assert.deepEqual(again?.result, row?.result, 'the second read does not accept the same report again');
  assert.equal(reminder(f, watchers.succeededClose).closedAt, closedOnce.closedAt, 'a repeated fact does not renew the closing time');
  assert.equal(reminder(f, watchers.failed).state, 'pending');
  const closed = await closeAsAgent(f, 'orphan-agent');
  assert.equal(closed.closed, true);
  assert.equal(closed.result, 'succeeded');
  assertClosedClean(f, runId, 'succeeded');
  assert.equal(reminder(f, watchers.failed).state, 'pending', 'closure does not turn the accepted result into agent.failed');
  assert.deepEqual((await f.runners()).filter(alive), []);
  assert.deepEqual(await f.runDirectories(), [], 'the orphaned run directory is removed at closure');
});

test('[report-orphan] agent close alone accepts a valid report left after the worker died', { timeout: 180_000 }, async t => {
  const f = await fixture(t, 'orphan-close', timeouts, 'codex', { commands: ['agent ps'] });
  const { runId, reportPath } = await launchOrphan(f, 'orphan-close');
  const watchers = seedResultWatchers(f, 'orphan-close');
  await completeTask(f);
  await writeReport(reportPath, succeeded);
  const closed = await closeAsAgent(f, 'orphan-close');
  assert.equal(closed.closed, true);
  assert.equal(closed.result, 'succeeded');
  assertClosedClean(f, runId, 'succeeded');
  assertResultEventsSettled(f, runId);
  assert.equal(reminder(f, watchers.succeeded).state, 'active', 'agent.succeeded was emitted by close');
  assert.equal(reminder(f, watchers.succeededClose).state, 'closed');
  assert.equal(reminder(f, watchers.failed).state, 'pending', 'no failure is invented over the valid report');
  assert.deepEqual((await f.runners()).filter(alive), []);
  assert.deepEqual(await f.runDirectories(), []);
});

test('[report-orphan] an invalid or unverified report left after the worker died is not accepted; close records failure', { timeout: 180_000 }, async t => {
  const f = await fixture(t, 'orphan-invalid', timeouts, 'codex', { commands: ['agent ps'] });
  const { runId, reportPath } = await launchOrphan(f, 'orphan-invalid');
  const watchers = seedResultWatchers(f, 'orphan-invalid');
  await writeReport(reportPath, succeeded);
  const listed = await f.command(['agent', 'ps']);
  const row = psRow(listed, 'orphan-invalid');
  assert.equal(row?.state, 'running');
  assert.equal(row?.result, undefined, 'succeeded without the OpenSpec checkbox is not confirmed');
  assert.match(listed.stderr, new RegExp(runId), 'the reason of the refusal reaches the coordinator');
  await writeReport(reportPath, { ...succeeded, changes: [{ id: 'other-change', items: [{ id: '1.1', status: 'succeeded' }] }] });
  const mismatched = await f.command(['agent', 'ps']);
  assert.equal(psRow(mismatched, 'orphan-invalid')?.result, undefined, 'assignment mismatch is not accepted');
  assert.match(mismatched.stderr, new RegExp(runId), 'the mismatch is diagnosed');
  assert.equal(reminder(f, watchers.succeeded).state, 'pending', 'no agent.succeeded for a refused report');
  assert.equal(reminder(f, watchers.succeededClose).state, 'active');
  const closed = await closeAsAgent(f, 'orphan-invalid');
  assert.equal(closed.closed, true);
  assert.equal(closed.result, 'failed');
  assertClosedClean(f, runId, 'failed');
  assertResultEventsSettled(f, runId);
  assert.equal(reminder(f, watchers.failed).state, 'active', 'close emits agent.failed');
  assert.equal(reminder(f, watchers.succeeded).state, 'pending', 'the refused report never becomes agent.succeeded');
  assert.deepEqual((await f.runners()).filter(alive), []);
  assert.deepEqual(await f.runDirectories(), [], 'the run directory is removed after the failed closure');
});
