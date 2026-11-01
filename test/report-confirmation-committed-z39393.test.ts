import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createAgentReportWatcher, readPendingAgentReport, type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import { type AssignmentVerification } from '../src/assignment.ts';
import { captureReportedCommitLaunchContext } from '../src/reported-commits.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation, type TaskCheckboxPorts } from '../src/task-checkbox-report.ts';

const change = 'committed-confirmation';
const pathspec = `openspec/changes/${change}/tasks.md`;
const original = '- [ ] A.1 Assigned work\n- [ ] A.2 Foreign work\n';
const checked = original.replace('[ ] A.1', '[x] A.1');
const ok: AssignmentVerification = { ok: true, issues: [] };

function sqliteFailure(errcode: number, operation: string) {
  return Object.assign(new Error(`State store ${operation} failed (SQLite ${errcode}): database is locked`), {
    code: 'ERR_SQLITE_ERROR', errcode, operation,
  });
}

async function fixture(t: TestContext, commitCheckbox = true) {
  const root = await mkdtemp(join(tmpdir(), 'raf-z39393-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tasksPath = join(root, pathspec);
  await mkdir(dirname(tasksPath), { recursive: true });
  await writeFile(tasksPath, original);
  await writeFile(join(root, 'foreign.txt'), 'baseline\n');
  git('init', '-q');
  git('config', 'user.name', 'Z39393 unit');
  git('config', 'user.email', 'z39393@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '--', pathspec, 'foreign.txt');
  git('commit', '-qm', 'Launch assignment');
  const runId = randomUUID();
  const tmpRoot = join(root, 'reports');
  const address = 'committed-worker';
  const reportPath = join(tmpRoot, runId, `${address}.json`);
  const reportedCommits = await captureReportedCommitLaunchContext(runId, reportPath, [root], [root]);
  await writeFile(join(root, 'executor.txt'), 'Owned result\n');
  git('add', '--', 'executor.txt');
  git('commit', '-qm', 'Executor result');
  const executorHead = git('rev-parse', 'HEAD');
  const assignment = { root, baselineArchives: [], changes: [{ id: change, items: [{ id: 'A.1', description: 'Assigned work' }] }] };
  const request: AgentReportRequest = { runId, address, tmpRoot, assignment, reportedCommits };
  const report: AgentReport = { status: 'succeeded', answer: 'Owned result committed', commits: [{ repository: root, sha: executorHead }], changes: [{ id: change, items: [{ id: 'A.1', status: 'succeeded' }] }] };
  const bytes = JSON.stringify(report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, bytes);
  const reportStat = await stat(reportPath, { bigint: true });
  const journalPath = join(root, '.git', 'task-checkbox-operations.json');
  await writeFile(journalPath, '[]');
  const journal = async (): Promise<readonly TaskCheckboxOperation[]> => JSON.parse(await readFile(journalPath, 'utf8'));
  const issue = (reason: string): AssignmentVerification => ({ ok: false, issues: [{ change, requestedItems: ['A.1'], reason, foundItems: [], archives: [], remedy: 'Restore the exact launch assignment' }] });
  const state = { journalWrites: 0, sourceReads: 0, completionReads: 0, current: true,
    accepted: [] as AgentReportResult[], published: [] as AgentReportResult[],
    rejections: [] as string[], diagnostics: [] as string[] };
  const verifyCompletion = async () => {
    state.completionReads++;
    return /^- \[x\] A\.1 /m.test(await readFile(tasksPath, 'utf8')) ? ok : issue('Assigned item remains open: A.1');
  };
  const checkboxPorts: TaskCheckboxPorts = { verifyAssignmentCompletion: verifyCompletion,
    operations: {
      read: async id => { assert.equal(id, runId); return journal(); },
      write: async (id, rows) => { assert.equal(id, runId); state.journalWrites++; await writeFile(journalPath, JSON.stringify(rows)); },
    },
  };
  if (commitCheckbox) {
    const seeded = await prepareReportedTaskCheckboxes(request, report, checkboxPorts);
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    assert.equal(seeded.commits.length, 1);
    assert.ok((await journal()).every(row => row.runId === runId && row.phase === 'verified'));
    assert.equal(await readFile(tasksPath, 'utf8'), checked);
  }
  const checkboxHead = git('rev-parse', 'HEAD');
  const savedJournal = await readFile(journalPath, 'utf8');
  state.journalWrites = 0;
  await writeFile(join(root, 'foreign.txt'), 'foreign staged\n');
  git('add', '--', 'foreign.txt');
  await writeFile(join(root, 'foreign.txt'), 'foreign unstaged\n');
  const staged = git('diff', '--cached', '--', 'foreign.txt');
  const unstaged = git('diff', '--', 'foreign.txt');
  const configPath = new URL('../../conf/raf.json', import.meta.url);
  const configBytes = await readFile(configPath, 'utf8');
  const protocol = JSON.parse(configBytes).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
  assert.ok(protocol?.timeouts.transitionMs > 0 && protocol.timeouts.pollMs > 0);
  const ports: AgentReportPorts = {
    fs: { mkdir: path => mkdir(path, { recursive: true }).then(() => undefined), readText: path => readFile(path, 'utf8'), readBytes: path => readFile(path), removeTree: async () => {} },
    watch: () => () => {}, process: { onExit: () => () => {} }, now: () => new Date().toISOString(),
    confirmationRetry: { runner: 'codex', protocol: async () => protocol },
    isCurrentReport: async (id, path) => state.current && id === runId && path === reportPath && state.accepted.length === 0,
    verifyAssignmentCompletion: verifyCompletion,
    confirmTaskCheckboxes: (current, candidate, budget, beforeWrite) => prepareReportedTaskCheckboxes(current, candidate, { ...checkboxPorts, budget, beforeWrite }),
    acceptResult: async result => { state.accepted.push(result); },
    result: async result => { state.published.push(result); },
    diagnostic: async (reason, rejection) => { state.diagnostics.push(reason); if (rejection) state.rejections.push(reason); },
  };
  const lockPath = join(root, '.git', 'raf-task-checkbox.lock');
  const ownerBytes = JSON.stringify({ kind: 'raf-task-checkbox-lock', pid: process.pid });
  const stable = async () => {
    assert.equal(git('rev-parse', 'HEAD'), checkboxHead, 'No second checkbox commit');
    assert.equal(git('diff', '--cached', '--', 'foreign.txt'), staged, 'Preserve foreign staged bytes');
    assert.equal(git('diff', '--', 'foreign.txt'), unstaged, 'Preserve foreign unstaged bytes');
    assert.equal(git('status', '--porcelain', '--', pathspec), '');
    assert.equal(await readFile(reportPath, 'utf8'), bytes, 'No executor report rewrite');
    const current = await stat(reportPath, { bigint: true });
    assert.equal(current.ino, reportStat.ino);
    assert.equal(current.mtimeNs, reportStat.mtimeNs);
    assert.equal(await readFile(configPath, 'utf8'), configBytes);
    assert.deepEqual(report.commits, [{ repository: root, sha: executorHead }]);
  };
  const accepted = async () => {
    assert.deepEqual(state.rejections, [], state.diagnostics.join('\n'));
    assert.equal(state.accepted.length, 1, state.diagnostics.join('\n'));
    assert.equal(state.published.length, 1);
    assert.equal(state.published[0].event, 'agent.succeeded');
    assert.equal(state.accepted[0].runId, runId);
    assert.deepEqual(state.accepted[0].checkboxCommits, [{ change, item: 'A.1', sha: checkboxHead }]);
    await stable();
  };
  const watch = async () => {
    const watcher = await createAgentReportWatcher(request, ports);
    t.after(() => watcher.dispose());
    return watcher;
  };
  return { root, git, request, report, bytes, reportPath, tasksPath, journalPath, journal, savedJournal, checkboxHead,
    checkboxPorts, ports, protocol, state, lockPath, ownerBytes, stable, accepted, watch };
}

test('Z39393.S01 committed current-run checkbox is accepted while a known live foreign writer remains busy', async t => {
  const f = await fixture(t);
  await writeFile(f.lockPath, f.ownerBytes);
  const result = await prepareReportedTaskCheckboxes(f.request, f.report, f.checkboxPorts);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.commits, [{ change, item: 'A.1', sha: f.checkboxHead }]);
  assert.equal(result.transient, undefined);
  assert.equal(f.state.journalWrites, 0, 'Read-only confirmation must not rewrite the journal');
  assert.equal(await readFile(f.lockPath, 'utf8'), f.ownerBytes, 'Retain the foreign writer lock');
  await f.stable();
});

for (const [id, where] of [['S03', 'accept']] as const) {
  test(`Z39393.${id} temporary SQLITE_BUSY at ${where} after checkbox commit retries unchanged report without rejection`, async t => {
    const f = await fixture(t);
    let injected = 0;
    const accept = f.ports.acceptResult!;
    f.ports.acceptResult = async result => {
      if (injected++ === 0) throw sqliteFailure(5, 'taskReservationTransaction');
      await accept(result);
    };
    await f.watch();
    assert.ok(injected > 0, 'Exercise the structured SQLite 5 failure');
    const stop = Date.now() + f.protocol.timeouts.transitionMs;
    while (!f.state.accepted.length && Date.now() < stop) await pause(f.protocol.timeouts.pollMs);
    await f.accepted();
  });
}

test('Z39393.S11 a committed checkbox from another run cannot authorize current-run acceptance', async t => {
  const f = await fixture(t);
  const foreign = (await f.journal()).map(row => ({ ...row, runId: 'another-run' }));
  await writeFile(f.journalPath, JSON.stringify(foreign));
  const result = await prepareReportedTaskCheckboxes(f.request, f.report, f.checkboxPorts);
  assert.equal(result.ok, false);
  assert.match(result.issues.map(row => row.reason).join('\n'), /journal.*launch assignment/i);
  assert.deepEqual(f.state.accepted, []);
  await f.stable();
});

test('Z39393.S13 uncommitted checked marker cannot bypass a busy writer', async t => {
  const f = await fixture(t, false);
  await writeFile(f.tasksPath, checked);
  await writeFile(f.lockPath, f.ownerBytes);
  const result = await prepareReportedTaskCheckboxes(f.request, f.report, f.checkboxPorts);
  assert.equal(result.ok, false);
  assert.equal(result.transient, 'writer-busy');
  assert.deepEqual(result.commits, []);
  assert.deepEqual(await f.journal(), []);
  assert.equal(f.git('rev-parse', 'HEAD'), f.checkboxHead);
  assert.equal(await readFile(f.lockPath, 'utf8'), f.ownerBytes);
});

test('Z39393.S14 expired run identity cannot accept even a committed checkbox', async t => {
  const f = await fixture(t);
  f.state.current = false;
  assert.equal(await readPendingAgentReport(f.request, f.ports), null);
  assert.deepEqual(f.state.accepted, []);
  assert.deepEqual(f.state.published, []);
  await f.stable();
});

test('Z39393.S15 permanent SQLite failure remains a rejection after committed checkbox', async t => {
  const f = await fixture(t);
  let attempts = 0;
  f.ports.acceptResult = async () => { attempts++; throw sqliteFailure(11, 'taskReservationTransaction'); };
  await f.watch();
  assert.equal(attempts, 1);
  assert.deepEqual(f.state.accepted, []);
  assert.equal(f.state.rejections.length, 1);
  assert.match(f.state.rejections[0], /SQLite 11/);
  await f.stable();
});

test('Z39393.S17 temporary SQLITE_BUSY checking current run after checkbox commit cannot escape as reader failure', async t => {
  const f = await fixture(t);
  let confirmed = false;
  let injected = false;
  const confirm = f.ports.confirmTaskCheckboxes!;
  f.ports.confirmTaskCheckboxes = async (...args) => { const result = await confirm(...args); confirmed = result.ok; return result; };
  const current = f.ports.isCurrentReport!;
  f.ports.isCurrentReport = async (...args) => {
    if (confirmed && !injected) { injected = true; throw sqliteFailure(5, 'taskReservationTransaction'); }
    return current(...args);
  };
  await f.watch();
  assert.equal(injected, true);
  await f.accepted();
});
