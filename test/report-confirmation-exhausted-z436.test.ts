import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { isAgentReportConfirmationPending, readPendingAgentReport, verifyPendingAgentReportFreshness, type AgentReport, type AgentReportRequest, type AgentReportResult, type PendingAgentReportPorts } from '../src/agent-report.ts';
import type { AssignmentVerification } from '../src/assignment.ts';
import type { PendingConfirmation } from '../src/report-confirmation-retry.ts';
import { captureReportedCommitLaunchContext } from '../src/reported-commits.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation, type TaskCheckboxPorts } from '../src/task-checkbox-report.ts';

const change = 'exhausted-confirmation';
const pathspec = `openspec/changes/${change}/tasks.md`;
const ok: AssignmentVerification = { ok: true, issues: [] };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-z436-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tasksPath = join(root, pathspec);
  await mkdir(dirname(tasksPath), { recursive: true });
  await writeFile(tasksPath, '- [ ] A.1 Assigned work\n- [ ] A.2 Foreign work\n');
  await writeFile(join(root, 'foreign.txt'), 'baseline\n');
  git('init', '-q');
  git('config', 'user.name', 'Z436 unit');
  git('config', 'user.email', 'z436@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '--', pathspec, 'foreign.txt');
  git('commit', '-qm', 'Launch assignment');
  const launchHead = git('rev-parse', 'HEAD');
  const runId = randomUUID();
  const tmpRoot = join(root, 'reports');
  const address = 'exhausted-worker';
  const reportPath = join(tmpRoot, runId, `${address}.json`);
  const reportedCommits = await captureReportedCommitLaunchContext(runId, reportPath, [root], [root]);
  await writeFile(join(root, 'executor.txt'), 'Owned result\n');
  git('add', '--', 'executor.txt');
  git('commit', '-qm', 'Executor result');
  const executorHead = git('rev-parse', 'HEAD');
  const assignment = { root, baselineArchives: [], changes: [{ id: change, items: [{ id: 'A.1', description: 'Assigned work' }] }] };
  const request: AgentReportRequest = { runId, address, tmpRoot, assignment, reportedCommits };
  const report: AgentReport = { status: 'succeeded', answer: 'Owned result committed', commits: [{ repository: root, sha: executorHead }], changes: [{ id: change, items: [{ id: 'A.1', status: 'succeeded' }] }] };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report));
  const journalPath = join(root, '.git', 'task-checkbox-operations.json');
  await writeFile(journalPath, '[]');
  const journal = async (): Promise<readonly TaskCheckboxOperation[]> => JSON.parse(await readFile(journalPath, 'utf8'));
  const verifySource = async () => ok;
  const verifyCompletion = async () => (await readFile(tasksPath, 'utf8')).split('\n').includes('- [x] A.1 Assigned work') ? ok
    : { ok: false, issues: [{ change, requestedItems: ['A.1'], reason: 'Assigned item remains open: A.1', foundItems: [], archives: [], remedy: 'Confirm the checkbox' }] };
  const checkboxPorts: TaskCheckboxPorts = { verifySourceIdentity: verifySource, verifyAssignmentCompletion: verifyCompletion,
    operations: { read: async () => journal(), write: async (_id, rows) => { await writeFile(journalPath, JSON.stringify(rows)); } } };
  const seeded = await prepareReportedTaskCheckboxes(request, report, checkboxPorts);
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  assert.ok((await journal()).every(row => row.phase === 'verified' && row.sha));
  const checkboxHead = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'foreign.txt'), 'foreign staged\n');
  git('add', '--', 'foreign.txt');
  const protocol = { timeouts: { transitionMs: 1500, pollMs: 10 } };
  const state = { accepted: [] as AgentReportResult[], rejections: [] as string[], diagnostics: [] as string[], pending: [] as PendingConfirmation[] };
  const ports: PendingAgentReportPorts = {
    fs: { readText: path => readFile(path, 'utf8'), readBytes: path => readFile(path) },
    now: () => new Date().toISOString(),
    confirmationRetry: { runner: 'codex', protocol: async () => protocol, retainPending: async value => { if (value) state.pending.push(value); } },
    isCurrentReport: async (id, path) => id === runId && path === reportPath && state.accepted.length === 0,
    verifyAssignmentSourceIdentity: verifySource, verifyAssignmentCompletion: verifyCompletion,
    confirmTaskCheckboxes: (current, candidate, _source, budget, beforeWrite) => prepareReportedTaskCheckboxes(current, candidate, { ...checkboxPorts, budget, beforeWrite }),
    acceptResult: async result => { await verifyPendingAgentReportFreshness(request, result, ports); state.accepted.push(result); },
    diagnostic: async (reason, rejection) => { state.diagnostics.push(reason); if (rejection) state.rejections.push(reason); },
  };
  const shim = join(root, 'shim');
  const log = join(root, 'git-calls.log');
  await mkdir(shim);
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await writeFile(join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  await chmod(join(shim, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${shim}${delimiter}${path}`;
  t.after(() => { process.env.PATH = path; });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { root, git, request, ports, state, launchHead, executorHead, checkboxHead, calls };
}

test('Z436 exhausted report with its checkbox already in HEAD is accepted while a foreign index.lock is held', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.git', 'index.lock'), '');
  await readPendingAgentReport(f.request, f.ports);
  assert.deepEqual(f.state.pending, [], f.state.diagnostics.join('\n'));
  assert.deepEqual(f.state.rejections, []);
  assert.equal(f.state.accepted.length, 1, f.state.diagnostics.join('\n'));
  assert.equal(f.state.accepted[0].event, 'agent.succeeded');
  assert.deepEqual(f.state.accepted[0].checkboxCommits, [{ change, item: 'A.1', sha: f.checkboxHead }]);
  assert.equal(isAgentReportConfirmationPending(f.request), false);
  assert.equal(f.git('rev-parse', 'HEAD'), f.checkboxHead, 'No second checkbox commit');
});

test('Z436 report confirmation does not re-verify reported commits with git', async t => {
  const f = await fixture(t);
  await readPendingAgentReport(f.request, f.ports);
  assert.equal(f.state.accepted.length, 1, f.state.diagnostics.join('\n'));
  const calls = await f.calls();
  const validation = calls.filter(line => /^(cat-file|merge-base|rev-parse --verify)\b/.test(line) && (line.includes(f.executorHead) || line.includes(f.launchHead)) || /--show-toplevel|--git-common-dir|--show-object-format/.test(line));
  assert.deepEqual(validation, [], 'Reported commits must not be re-validated through git during confirmation');
});

test('Z436 submitted report is accepted without re-verifying assignment source identity', async t => {
  const f = await fixture(t);
  let sourceChecks = 0;
  Object.assign(f.ports, { verifyAssignmentSourceIdentity: async () => { sourceChecks++; throw new Error('Launch task source identity changed: exhausted-confirmation/A.1: Unknown canonical project'); } });
  await readPendingAgentReport(f.request, f.ports);
  assert.deepEqual(f.state.rejections, []);
  assert.equal(f.state.accepted.length, 1, f.state.diagnostics.join('\n'));
  assert.equal(sourceChecks, 0);
});
