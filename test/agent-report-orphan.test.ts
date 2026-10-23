import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agentRunFixture as fixture, alive, exists, until, type AgentRunFixture } from './agent-run-fixture.ts';
import type { SessionRecord } from '../src/session-state.ts';
import type { PsSessionView } from '../src/launcher-notice.ts';

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
  await f.git('add', '--', `openspec/changes/${change}/tasks.md`);
  await f.git('commit', '-qm', 'fixture previously completed exact item');
  return { repository: join(f.directory, 'orchestrator'), sha: (await f.git('rev-parse', 'HEAD')).trim() };
}

async function writeReport(reportPath: string, report: unknown) {
  const staging = join(dirname(reportPath), `.late-${process.pid}.tmp`);
  await fs.writeFile(staging, JSON.stringify(report), { mode: 0o600 });
  await fs.rename(staging, reportPath);
}

const succeeded = { status: 'succeeded', answer, changes: [{ id: change, items: [{ id: '1.1', status: 'succeeded' }] }], commits: [] };

async function closeAsAgent(f: AgentRunFixture, id: string, options: readonly string[] = []) {
  await fs.writeFile(join(f.control, `${id}.close`), JSON.stringify(options));
  const code = await until(async () => await exists(join(f.control, `${id}.close.code`)) ? (await fs.readFile(join(f.control, `${id}.close.code`), 'utf8')).trim() : null, value => value !== null, `${id} agent close finished`);
  const printed = await fs.readFile(join(f.control, `${id}.close.out`), 'utf8');
  const diagnostics = await fs.readFile(join(f.control, `${id}.close.err`), 'utf8');
  assert.equal(code, '0', `${printed}\n${diagnostics}`);
  return JSON.parse(JSON.parse(printed).stdout) as { closed: boolean; unfinished: unknown[]; result?: string; forcedClose?: { reason: string } };
}

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
  const f = await fixture(t, 'orphan-ps', timeouts, 'codex', { productionQa: true, tasks: 2, commands: ['agent ps'] });
  const { runId, reportPath } = await launchOrphan(f, 'orphan-agent');
  const watchers = seedResultWatchers(f, 'orphan-agent');
  const before = (await f.git('rev-parse', 'HEAD')).trim();
  await writeReport(reportPath, succeeded);
  await delay(500);
  assert.equal(f.inspect().sessions.find(row => row.runId === runId)?.result, undefined, 'no live watcher: nothing accepts the report on its own');
  const row = psRow(await f.command(['agent', 'ps']), 'orphan-agent');
  assert.equal(row?.state, 'running', 'the runner is still open until closure');
  assert.equal(row?.result?.status, 'succeeded', JSON.stringify(row));
  assert.equal(row?.result?.response, answer, 'the accepted answer is visible in ps before closure');
  const tasksPath = `openspec/changes/${change}/tasks.md`;
  const confirmedTasks = await f.git('show', `HEAD:${tasksPath}`);
  assert.match(confirmedTasks, /- \[x\] 1\.1 /, 'raf committed the exact assigned checkbox');
  assert.match(confirmedTasks, /- \[ \] 1\.2 /, 'another open item keeps archive outside this assignment');
  assert.equal((await f.git('rev-list', '--count', `${before}..HEAD`)).trim(), '1');
  assert.equal((await f.git('show', '--format=', '--name-only', 'HEAD')).trim(), tasksPath);
  const commitMessage = await f.git('show', '-s', '--format=%B', 'HEAD');
  assert.ok(commitMessage.includes(runId), 'the checkbox commit identifies the run');
  assert.ok(commitMessage.includes(`${change}:1.1`), 'the checkbox commit identifies the exact assignment');
  const confirmedHead = await f.git('rev-parse', 'HEAD');
  assertResultEventsSettled(f, runId);
  assert.equal(reminder(f, watchers.succeeded).state, 'active', 'agent.succeeded was emitted for the address');
  const closedOnce = reminder(f, watchers.succeededClose);
  assert.equal(closedOnce.state, 'closed', 'agent.succeeded closes the bound reminder');
  assert.equal(reminder(f, watchers.failed).state, 'pending', 'no agent.failed over the valid report');
  const again = psRow(await f.command(['agent', 'ps']), 'orphan-agent');
  assert.deepEqual(again?.result, row?.result, 'the second read does not accept the same report again');
  assert.equal(await f.git('rev-parse', 'HEAD'), confirmedHead, 'reconciliation creates no duplicate checkbox commit');
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
  const f = await fixture(t, 'orphan-close', timeouts, 'codex', { productionQa: true, tasks: 2, commands: ['agent ps'] });
  const { runId, reportPath } = await launchOrphan(f, 'orphan-close');
  const watchers = seedResultWatchers(f, 'orphan-close');
  const commit = await completeTask(f);
  const completedHead = await f.git('rev-parse', 'HEAD');
  await writeReport(reportPath, { ...succeeded, commits: [commit] });
  const closed = await closeAsAgent(f, 'orphan-close');
  assert.equal(closed.closed, true);
  assert.equal(closed.result, 'succeeded');
  assert.equal(await f.git('rev-parse', 'HEAD'), completedHead, 'a committed exact checkbox needs no empty commit');
  assertClosedClean(f, runId, 'succeeded');
  assertResultEventsSettled(f, runId);
  assert.equal(reminder(f, watchers.succeeded).state, 'active', 'agent.succeeded was emitted by close');
  assert.equal(reminder(f, watchers.succeededClose).state, 'closed');
  assert.equal(reminder(f, watchers.failed).state, 'pending', 'no failure is invented over the valid report');
  assert.deepEqual((await f.runners()).filter(alive), []);
  assert.deepEqual(await f.runDirectories(), []);
});

test('[report-orphan] after the watcher dies, an unverified report keeps the live runner open until forced close records failure', { timeout: 180_000 }, async t => {
  const f = await fixture(t, 'orphan-invalid', timeouts, 'codex', { productionQa: true, commands: ['agent ps'] });
  const { runId, runner, reportPath } = await launchOrphan(f, 'orphan-invalid');
  const watchers = seedResultWatchers(f, 'orphan-invalid');
  const tasks = join(f.directory, 'orchestrator', 'openspec', 'changes', change, 'tasks.md');
  await fs.writeFile(tasks, (await fs.readFile(tasks, 'utf8')).replace('- [ ] 1.1 ', '- [x] 1.1 '));
  const head = await f.git('rev-parse', 'HEAD');
  const conflictingTasks = await fs.readFile(tasks, 'utf8');
  await writeReport(reportPath, succeeded);
  const listed = await f.command(['agent', 'ps']);
  const row = psRow(listed, 'orphan-invalid');
  assert.equal(row?.notify, undefined, 'the orphan fixture has no saved notify identity');
  assert.equal(row?.launchedBy, undefined, 'the orphan fixture has no saved launcher identity');
  assert.equal(row?.delegatedBy, undefined, 'the orphan fixture has no saved delegated launcher identity');
  assert.equal(row?.state, 'running');
  assert.equal(row?.result, undefined, 'an uncommitted checkbox with no raf ownership proof is a conflict');
  assert.equal(await f.git('rev-parse', 'HEAD'), head, 'the foreign marker is never committed');
  assert.equal(await fs.readFile(tasks, 'utf8'), conflictingTasks, 'the conflicting marker is preserved');
  assert.equal(listed.stderr, '', 'the refusal goes to the event addressee, without a task dump in CLI stderr');
  const diagnostic = (row as PsSessionView).resultNotice;
  assert.equal(diagnostic?.recipient, '', 'missing launcher identity must not fall back to main');
  assert.equal(diagnostic?.state, 'pending', 'unknown addressee keeps the diagnostic undelivered');
  assert.ok(diagnostic?.lastError, 'ps explains the unavailable addressee');
  assert.ok(typeof diagnostic?.id === 'string' && diagnostic.id.length > 0, 'a rejected snapshot has a durable diagnostic identity');
  const repeated = await f.command(['agent', 'ps']);
  assert.equal(repeated.stderr, '', 'later commands do not repeat the diagnostic in stderr');
  assert.equal((psRow(repeated, 'orphan-invalid') as PsSessionView).resultNotice?.id, diagnostic?.id, 'reconciliation reuses the durable diagnostic');
  const whitespacePath = join(dirname(reportPath), `.whitespace-${process.pid}.tmp`);
  await fs.writeFile(whitespacePath, JSON.stringify(succeeded, null, 2), { mode: 0o600 });
  await fs.rename(whitespacePath, reportPath);
  const reformatted = await f.command(['agent', 'ps']);
  assert.equal(reformatted.stderr, '');
  const reformattedRow = psRow(reformatted, 'orphan-invalid') as PsSessionView;
  assert.equal(reformattedRow.result, undefined, 'whitespace does not resolve the conflicting checkbox');
  assert.ok(reformattedRow.resultNotice?.id);
  assert.notEqual(reformattedRow.resultNotice.id, diagnostic.id, 'changed raw bytes with the same report and refusal have a new identity');
  const repeatedWhitespace = await f.command(['agent', 'ps']);
  assert.equal(repeatedWhitespace.stderr, '');
  assert.equal((psRow(repeatedWhitespace, 'orphan-invalid') as PsSessionView).resultNotice?.id, reformattedRow.resultNotice.id, 'repeated raw bytes and refusal reuse the new identity');
  await writeReport(reportPath, { ...succeeded, changes: [{ id: 'other-change', items: [{ id: '1.1', status: 'succeeded' }] }] });
  const mismatched = await f.command(['agent', 'ps']);
  assert.equal(psRow(mismatched, 'orphan-invalid')?.result, undefined, 'assignment mismatch is not accepted');
  assert.equal(mismatched.stderr, '');
  const mismatchNotice = (psRow(mismatched, 'orphan-invalid') as PsSessionView).resultNotice;
  assert.equal(mismatchNotice?.recipient, '', 'a new rejection must not acquire a fallback main');
  assert.equal(mismatchNotice?.state, 'pending');
  assert.ok(mismatchNotice?.lastError);
  assert.notEqual(mismatchNotice?.id, diagnostic?.id, 'a changed refusal reason has its own addressed diagnostic');
  assert.equal(reminder(f, watchers.succeeded).state, 'pending', 'no agent.succeeded for a refused report');
  assert.equal(reminder(f, watchers.succeededClose).state, 'active');
  assert.ok(alive(runner), 'losing the report watcher is not a runner crash under session-recovery');
  const beforeClose = f.inspect();
  const directories = await f.runDirectories();
  const refusedReport = await fs.readFile(reportPath, 'utf8');
  const denied = await f.as('orphan-invalid', ['agent', 'close', '--id', 'orphan-invalid']);
  assert.equal(denied.exitCode, 1, JSON.stringify(denied));
  const failure = JSON.parse(denied.result.stderr);
  assert.equal(failure.code, 'AGENT_RESULT_PENDING');
  assert.deepEqual(failure.details.received, { id: 'orphan-invalid', runId });
  const afterDenial = f.inspect();
  const pendingSession = afterDenial.sessions.find(session => session.runId === runId);
  assert.equal(pendingSession?.state, 'running');
  assert.equal(pendingSession?.result, undefined, 'denied close does not invent a failed result');
  assert.ok(alive(runner), 'ordinary close leaves the runner and its command channel alive');
  assert.deepEqual(afterDenial.claims, beforeClose.claims, 'denied close retains task reservations');
  assert.deepEqual(afterDenial.admission, beforeClose.admission, 'denied close retains admission');
  assert.deepEqual(await f.runDirectories(), directories, 'denied close leaves the run directory available');
  assert.equal(await fs.readFile(reportPath, 'utf8'), refusedReport, 'denied close preserves the report');
  assert.equal(reminder(f, watchers.failed).state, 'pending', 'denied close emits no agent.failed');
  assert.equal(reminder(f, watchers.succeeded).state, 'pending');
  assert.equal(reminder(f, watchers.succeededClose).state, 'active');
  const reason = 'Звіт осиротілого запуску не підтверджено; завершити живий runner';
  const closed = await closeAsAgent(f, 'orphan-invalid', ['--force', '--reason', reason]);
  assert.equal(closed.closed, true);
  assert.equal(closed.result, 'failed');
  assert.deepEqual(closed.forcedClose, { reason });
  const finished = assertClosedClean(f, runId, 'failed');
  assert.deepEqual(finished.sessions.find(session => session.runId === runId)?.result?.forcedClose, { reason }, 'the exact force reason survives finalization and a reopened store');
  assertResultEventsSettled(f, runId);
  assert.equal(reminder(f, watchers.failed).state, 'active', 'close emits agent.failed');
  assert.equal(reminder(f, watchers.succeeded).state, 'pending', 'the refused report never becomes agent.succeeded');
  assert.equal(reminder(f, watchers.succeededClose).state, 'active');
  assert.equal(await f.git('rev-parse', 'HEAD'), head, 'force does not commit the foreign checkbox');
  assert.equal(await fs.readFile(tasks, 'utf8'), conflictingTasks, 'force preserves the conflicting checkbox');
  assert.deepEqual((await f.runners()).filter(alive), []);
  assert.deepEqual(await f.runDirectories(), [], 'the run directory is removed after the failed closure');
});
