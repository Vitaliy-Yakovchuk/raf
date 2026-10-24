import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentReportWatcher, readPendingAgentReport, type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import { type AssignmentVerification } from '../src/assignment.ts';
import { reconcileReportedCommitIndex } from '../src/report-commit-index.ts';
import { type PendingConfirmation } from '../src/report-confirmation-retry.ts';
import { captureReportedCommitLaunchContext } from '../src/reported-commits.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation, type TaskCheckboxPorts } from '../src/task-checkbox-report.ts';

const change = 'checkbox-lock-race';
const pathspec = `openspec/changes/${change}/tasks.md`;
const tasks = '- [ ] A.1 Assigned result\n- [ ] A.2 Second result\n- [ ] A.3 Another owner\n';
const ok: AssignmentVerification = { ok: true, issues: [] };
const configurationPath = new URL('../../conf/raf.json', import.meta.url);

async function fixture(t: TestContext, selected = ['A.1']) {
  const root = await mkdtemp(join(tmpdir(), 'raf-z3939-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  await mkdir(dirname(join(root, pathspec)), { recursive: true });
  await writeFile(join(root, pathspec), tasks);
  await writeFile(join(root, 'foreign.txt'), 'baseline\n');
  git('init', '-q');
  git('config', 'user.name', 'Lock race fixture');
  git('config', 'user.email', 'lock-race@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '--', pathspec, 'foreign.txt');
  git('commit', '-qm', 'Launch assignment');
  const runId = randomUUID();
  const tmpRoot = join(root, 'reports');
  const address = 'lock-race-author';
  const reportPath = join(tmpRoot, runId, `${address}.json`);
  const reportedCommits = await captureReportedCommitLaunchContext(runId, reportPath, [root], [root]);
  await writeFile(join(root, 'executor-result.txt'), 'Owned result\n');
  git('add', '--', 'executor-result.txt');
  git('commit', '-qm', 'Executor result');
  const executorHead = git('rev-parse', 'HEAD').trim();
  const descriptions: Record<string, string> = { 'A.1': 'Assigned result', 'A.2': 'Second result' };
  const assignment = { root, baselineArchives: [], changes: [{ id: change, items: selected.map(id => ({ id, description: descriptions[id] })) }] };
  const request: AgentReportRequest = { runId, address, tmpRoot, assignment, reportedCommits };
  const report: AgentReport = { status: 'succeeded', answer: 'Committed result', commits: [{ repository: root, sha: executorHead }], changes: [{ id: change, items: selected.map(id => ({ id, status: 'succeeded' })) }] };
  const reportBytes = JSON.stringify(report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, reportBytes);
  const reportStat = await stat(reportPath, { bigint: true });
  const sourceStat = await lstat(dirname(join(root, pathspec)), { bigint: true });
  const journalPath = join(root, '.git', 'checkbox-operations.json');
  const journal = async (): Promise<readonly TaskCheckboxOperation[]> => JSON.parse(await readFile(journalPath, 'utf8'));
  await writeFile(journalPath, '[]');
  let sourceChecks = 0;
  let completionChecks = 0;
  let journalWrites = 0;
  const issue = (reason: string): AssignmentVerification => ({ ok: false, issues: [{ change, requestedItems: selected, reason, foundItems: [], archives: [], remedy: 'Restore the original assignment' }] });
  const verifySource = async (): Promise<AssignmentVerification> => {
    sourceChecks += 1;
    const current = await lstat(dirname(join(root, pathspec)), { bigint: true });
    if (current.isSymbolicLink() || current.ino !== sourceStat.ino || current.dev !== sourceStat.dev || current.birthtimeNs !== sourceStat.birthtimeNs) return issue('Task source instance changed');
    const text = await readFile(join(root, pathspec), 'utf8');
    return selected.every(id => text.split('\n').filter(line => new RegExp(`^- \\[[ x]\\] ${id.replaceAll('.', '\\.')} `).test(line)).length === 1
      && text.split('\n').some(line => line === `- [ ] ${id} ${descriptions[id]}` || line === `- [x] ${id} ${descriptions[id]}`)) ? ok : issue('Assigned task description changed');
  };
  const verifyCompletion = async (): Promise<AssignmentVerification> => {
    completionChecks += 1;
    const identity = await verifySource();
    if (!identity.ok) return identity;
    const text = await readFile(join(root, pathspec), 'utf8');
    return selected.every(id => text.split('\n').includes(`- [x] ${id} ${descriptions[id]}`)) ? ok : issue('Assigned item is still open');
  };
  const checkboxPorts: TaskCheckboxPorts = {
    verifySourceIdentity: verifySource,
    verifyAssignmentCompletion: verifyCompletion,
    operations: {
      read: async id => { assert.equal(id, runId); return journal(); },
      write: async (id, operations) => { assert.equal(id, runId); journalWrites += 1; await writeFile(journalPath, JSON.stringify(operations)); },
    },
  };
  const configuration = await readFile(configurationPath, 'utf8');
  const protocol = JSON.parse(configuration).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
  assert.ok(protocol?.timeouts.transitionMs > 0 && protocol.timeouts.pollMs > 0);
  const rejections: string[] = [];
  const diagnostics: string[] = [];
  const pending: PendingConfirmation[] = [];
  const accepted: AgentReportResult[] = [];
  const published: AgentReportResult[] = [];
  const ports: AgentReportPorts = {
    fs: {
      mkdir: path => mkdir(path, { recursive: true }).then(() => undefined),
      readText: path => readFile(path, 'utf8'),
      readBytes: path => readFile(path),
      removeTree: path => rm(path, { recursive: true, force: true }),
    },
    watch: () => () => {},
    process: { onExit: () => () => {} },
    now: () => new Date().toISOString(),
    confirmationRetry: { runner: 'codex', protocol: async () => protocol, retainPending: async value => { if (value) pending.push(value); } },
    isCurrentReport: async (id, path) => id === runId && path === reportPath && accepted.length === 0,
    verifyAssignmentSourceIdentity: verifySource,
    verifyAssignmentCompletion: verifyCompletion,
    readTaskCheckboxCommits: async () => (await journal()).flatMap(row => row.sha ? [{ change: row.change, item: row.item, sha: row.sha }] : []),
    reconcileReportedCommitIndex: (input, budget, beforeWrite) => reconcileReportedCommitIndex(input, budget ? { deadline: budget.deadline, pollMs: protocol.timeouts.pollMs, beforeWrite } : undefined),
    confirmTaskCheckboxes: (currentRequest, currentReport, _source, budget, beforeWrite) => prepareReportedTaskCheckboxes(currentRequest, currentReport, { ...checkboxPorts, budget, beforeWrite }),
    acceptResult: async result => { accepted.push(result); },
    result: async result => { published.push(result); },
    diagnostic: async (reason, rejection) => { diagnostics.push(reason); if (rejection) rejections.push(reason); },
  };
  const lockPath = join(root, '.git', 'raf-task-checkbox.lock');
  const owner = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) { const stopped = once(owner, 'exit'); owner.kill(); await stopped; } });
  await once(owner, 'message');
  assert.ok(owner.pid && owner.pid !== process.pid);
  const ownerBytes = JSON.stringify({ kind: 'raf-task-checkbox-lock', pid: owner.pid });
  const hold = () => writeFile(lockPath, ownerBytes, { mode: 0o600, flag: 'wx' });
  const confirm = () => prepareReportedTaskCheckboxes(request, report, checkboxPorts);
  const seedCommitted = async () => {
    const result = await confirm();
    assert.equal(result.ok, true, `Fixture must commit before the lock race: ${JSON.stringify(result)}`);
    assert.equal(result.commits.length, selected.length);
    assert.ok((await journal()).every(row => row.phase === 'verified'));
    return git('rev-parse', 'HEAD');
  };
  const probe = (transition: (attempt: number) => void) => {
    let probes = 0;
    const kill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      const result = kill(pid, signal);
      if (pid === owner.pid && signal === 0) transition(++probes);
      return result;
    });
    return () => probes;
  };
  const assertStable = async (head: string, expectedCount = selected.length) => {
    assert.equal(git('rev-parse', 'HEAD'), head, 'Acceptance must not create another checkbox commit');
    assert.equal(Number(git('rev-list', '--count', `${executorHead}..HEAD`)), expectedCount);
    assert.equal(git('status', '--porcelain', '--', pathspec), '', 'No reverse checkbox may be staged');
    assert.equal(await readFile(reportPath, 'utf8'), reportBytes);
    const current = await stat(reportPath, { bigint: true });
    assert.equal(current.ino, reportStat.ino);
    assert.equal(current.mtimeNs, reportStat.mtimeNs);
    assert.deepEqual(report.commits, [{ repository: root, sha: executorHead }]);
    assert.equal(await readFile(configurationPath, 'utf8'), configuration);
  };
  return { root, git, executorHead, request, report, reportPath, reportBytes, journal, lockPath, ownerBytes, checkboxPorts, ports, protocol, rejections, diagnostics, pending, accepted, published, hold, confirm, seedCommitted, probe, assertStable, checks: () => ({ sourceChecks, completionChecks, journalWrites }) };
}

for (const transition of ['removed', 'replaced', 'metadata-changed'] as const) {
  test(`Z3939.S0${['removed', 'replaced', 'metadata-changed'].indexOf(transition) + 1} committed checkbox survives writer lock ${transition} during live-owner probe`, async t => {
    const f = await fixture(t);
    const head = await f.seedCommitted();
    await f.hold();
    const before = f.checks();
    const probes = f.probe(attempt => {
      if (attempt > 1 || transition === 'removed') { unlinkSync(f.lockPath); return; }
      if (transition === 'replaced') {
        writeFileSync(f.lockPath + '.next', f.ownerBytes, { mode: 0o600 });
        renameSync(f.lockPath + '.next', f.lockPath);
      } else {
        utimesSync(f.lockPath, new Date(0), new Date(0));
      }
    });
    const result = await readPendingAgentReport(f.request, { ...f.ports, acceptResult: undefined });
    assert.ok(probes() > 0, 'Exercise the real EEXIST/live-owner probe path');
    assert.deepEqual(f.rejections, [], `Lock turnover is temporary: ${f.rejections.join('\n')}`);
    assert.equal(result?.status, 'succeeded', `The unchanged committed report must be accepted: ${f.diagnostics.join('\n')}`);
    assert.deepEqual(result?.checkboxCommits, (await f.journal()).map(row => ({ change: row.change, item: row.item, sha: row.sha })));
    assert.ok(f.checks().sourceChecks > before.sourceChecks && f.checks().completionChecks > before.completionChecks, 'Replay must repeat source identity and completion checks');
    await f.assertStable(head);
  });
}

test('Z3939.S04 lock disappearing during probe before any checkbox permits guarded retry without duplicate writes', async t => {
  const f = await fixture(t);
  await f.hold();
  const probes = f.probe(() => unlinkSync(f.lockPath));
  const first = await f.confirm();
  assert.equal(probes(), 1);
  assert.ok(first.ok || first.transient === 'writer-busy' || first.transient === 'source-read-race', `Expected guarded success or typed contention, received ${JSON.stringify(first)}`);
  if (!first.ok) {
    assert.equal(f.git('rev-parse', 'HEAD').trim(), f.executorHead);
    assert.equal(await readFile(join(f.root, pathspec), 'utf8'), tasks);
    assert.deepEqual(await f.journal(), []);
  }
  const result = await f.confirm();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.commits.length, 1);
  assert.equal(Number(f.git('rev-list', '--count', `${f.executorHead}..HEAD`)), 1);
  assert.ok((await f.journal()).every(row => row.phase === 'verified'));
});

test('Z3939.S05 watcher automatically resumes a committed journal after busy exhaustion without another file event or rejection', async t => {
  const f = await fixture(t);
  const head = await f.seedCommitted();
  await f.hold();
  let clock = performance.now();
  t.mock.method(performance, 'now', () => clock);
  const confirm = f.ports.confirmTaskCheckboxes!;
  let busy = 0;
  f.ports.confirmTaskCheckboxes = async (...args) => {
    const result = await confirm(...args);
    if (result.transient === 'writer-busy') { busy += 1; clock = args[3]!.deadline; }
    return result;
  };
  f.ports.confirmationRetry!.retainPending = async diagnostic => {
    if (!diagnostic) return;
    f.pending.push(diagnostic);
    assert.equal(await readFile(f.lockPath, 'utf8'), f.ownerBytes, 'The waiting reader must retain the live foreign lock');
    await rm(f.lockPath);
  };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  try {
    assert.equal(busy, 1);
    assert.equal(f.pending.length, 1);
    assert.equal(f.pending[0].candidateBytes, f.reportBytes);
    assert.equal(f.pending[0].cause, 'writer-busy');
    assert.equal(f.pending[0].exhausted, true);
    assert.deepEqual(f.rejections, [], 'Budget exhaustion is pending, not report-rejected');
    const stop = Date.now() + f.protocol.timeouts.transitionMs;
    while (f.published.length === 0 && Date.now() < stop) await delay(f.protocol.timeouts.pollMs);
    assert.equal(f.accepted.length, 1, f.diagnostics.join('\n'));
    assert.equal(f.published.length, 1);
    assert.equal(f.published[0].event, 'agent.succeeded');
    assert.equal(f.published[0].runId, f.request.runId);
    assert.deepEqual(f.rejections, []);
    await f.assertStable(head);
  } finally { await watcher.dispose(); }
});

test('Z3939.S06 an unknown writer remains a real refusal even when the checkbox is already committed', async t => {
  const f = await fixture(t);
  const head = await f.seedCommitted();
  const foreign = JSON.stringify({ kind: 'unknown-writer', pid: process.pid });
  await writeFile(f.lockPath, foreign);
  const result = await readPendingAgentReport(f.request, { ...f.ports, acceptResult: undefined });
  assert.equal(result, null);
  assert.equal(f.rejections.length, 1);
  assert.match(f.rejections[0], /unknown ownership/);
  assert.deepEqual(f.pending, []);
  assert.equal(await readFile(f.lockPath, 'utf8'), foreign);
  await f.assertStable(head);
});

test('Z3939.S07 a committed journal does not bypass a stable assigned description mismatch', async t => {
  const f = await fixture(t);
  const head = await f.seedCommitted();
  const altered = tasks.replace('[ ] A.1 Assigned result', '[x] A.1 Changed description');
  await writeFile(join(f.root, pathspec), altered);
  const result = await readPendingAgentReport(f.request, { ...f.ports, acceptResult: undefined });
  assert.equal(result, null);
  assert.equal(f.rejections.length, 1);
  assert.match(f.rejections[0], /description changed/);
  assert.match(f.rejections[0], /A\.1/);
  assert.deepEqual(f.pending, []);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(f.root, pathspec), 'utf8'), altered);
});

test('Z3939.S08 a partial committed journal resumes every assigned item after lock turnover and preserves foreign index hunks', async t => {
  const f = await fixture(t, ['A.1', 'A.2']);
  const interruption = new Error('Fixture interruption after the first committed checkbox');
  f.checkboxPorts.checkpoint = async phase => { if (phase === 'after-commit') throw interruption; };
  await assert.rejects(f.confirm(), error => error === interruption);
  delete f.checkboxPorts.checkpoint;
  assert.equal((await f.journal()).length, 1);
  assert.equal((await f.journal())[0].phase, 'committed');
  const firstCheckbox = f.git('rev-parse', 'HEAD').trim();
  await writeFile(join(f.root, 'foreign.txt'), 'foreign staged\n');
  f.git('add', '--', 'foreign.txt');
  await writeFile(join(f.root, 'foreign.txt'), 'foreign unstaged\n');
  const staged = f.git('diff', '--cached', '--', 'foreign.txt');
  const unstaged = f.git('diff', '--', 'foreign.txt');
  await f.hold();
  const probes = f.probe(() => unlinkSync(f.lockPath));
  const result = await readPendingAgentReport(f.request, { ...f.ports, acceptResult: undefined });
  assert.ok(probes() > 0);
  assert.deepEqual(f.rejections, [], f.diagnostics.join('\n'));
  assert.equal(result?.status, 'succeeded');
  assert.equal(result.checkboxCommits?.length, 2);
  assert.ok(result.checkboxCommits?.some(row => row.sha === firstCheckbox));
  assert.equal(f.git('diff', '--cached', '--', 'foreign.txt'), staged);
  assert.equal(f.git('diff', '--', 'foreign.txt'), unstaged);
  assert.equal(await readFile(join(f.root, pathspec), 'utf8'), tasks.replace('[ ] A.1', '[x] A.1').replace('[ ] A.2', '[x] A.2'));
  assert.ok((await f.journal()).every(row => row.phase === 'verified'));
  await f.assertStable(f.git('rev-parse', 'HEAD'), 2);
});
