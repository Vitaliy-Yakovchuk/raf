import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { readPendingAgentReport, verifyPendingAgentReportFreshness, type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import { createAssignmentIdentityAdapter } from '../src/assignment-identity.ts';
import type { AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { AssignmentVerification } from '../src/assignment.ts';
import { captureReportedCommitLaunchContext } from '../src/reported-commits.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation } from '../src/task-checkbox-report.ts';
import type { PendingConfirmation } from '../src/report-confirmation-retry.ts';

const change = 'confirmation-deadline';
const pathspec = `openspec/changes/${change}/tasks.md`;
const original = '- [ ] 1.1 Assigned work\n- [ ] 1.2 Neighbor\n';
const ok: AssignmentVerification = { ok: true, issues: [] };

async function fixture(t: TestContext, fraction: number) {
  const root = await mkdtemp(join(tmpdir(), 'raf-z39398-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tasksPath = join(root, pathspec);
  await mkdir(dirname(tasksPath), { recursive: true });
  await writeFile(tasksPath, original);
  await writeFile(join(dirname(tasksPath), 'proposal.md'), '## Why\nPreserve confirmation progress.\n');
  git('init', '-q');
  git('config', 'user.name', 'Z39398 unit');
  git('config', 'user.email', 'z39398@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '--', pathspec, `openspec/changes/${change}/proposal.md`);
  git('commit', '-qm', 'Launch assignment');
  const protocol = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
  assert.ok(protocol.timeouts.transitionMs > 0);
  const subprocessCost = protocol.timeouts.transitionMs * fraction;
  let clock = 0;
  let charge = false;
  let supported = true;
  const calls: string[][] = [];
  const execute: AdapterCommandExecutor = async command => {
    assert.equal(command.executable, 'openspec');
    if (charge) { clock += subprocessCost; calls.push([...command.args]); }
    if (command.args[0] === '--version') return { exitCode: 0, stdout: supported ? '1.14.3\n' : 'unsupported\n', stderr: '' };
    assert.deepEqual(command.args, ['instructions', 'apply', '--change', change, '--json']);
    const text = await readFile(join(command.cwd!, pathspec), 'utf8');
    const tasks = [...text.matchAll(/^- \[([ x])\] (.+)$/gm)].map((row, index) => ({ id: String(index + 1), description: row[2], done: row[1] === 'x' }));
    return { exitCode: 0, stdout: JSON.stringify({ schemaName: 'spec-driven', tasks }), stderr: '' };
  };
  const assignment = { root, baselineArchives: [], changes: [{ id: change, items: [{ id: '1.1', description: 'Assigned work' }] }] };
  const identity = createAssignmentIdentityAdapter({ raf: root }, { execute });
  const reserved = await identity.capture('raf', assignment);
  const verifySource = async (): Promise<AssignmentVerification> => {
    const rows = await createAssignmentIdentityAdapter({ raf: root }, { execute }).resolveTasks(reserved);
    return rows.every(row => row.state === 'open' || row.state === 'completed') ? ok : {
      ok: false, issues: [{ change, requestedItems: ['1.1'], reason: rows.map(row => 'reason' in row ? row.reason : row.state).join('; '), foundItems: [], archives: [], remedy: 'Restore the immutable source' }],
    };
  };
  const complete = async () => {
    if (charge) clock += protocol.timeouts.transitionMs * 0.16;
    const text = await readFile(tasksPath, 'utf8');
    return text.includes('- [x] 1.1 Assigned work') ? ok : { ok: false, issues: [{ change, requestedItems: ['1.1'], reason: 'Completion mismatch', foundItems: [], archives: [], remedy: 'Restore the committed task' }] };
  };
  const runId = randomUUID();
  const tmpRoot = join(root, 'reports');
  const reportPath = join(tmpRoot, runId, 'worker.json');
  const reportedCommits = await captureReportedCommitLaunchContext(runId, reportPath, [root], [root]);
  await writeFile(join(root, 'result.txt'), 'Owned work\n');
  git('add', '--', 'result.txt');
  git('commit', '-qm', 'Executor result');
  const executorHead = git('rev-parse', 'HEAD');
  const request: AgentReportRequest = { runId, address: 'worker', tmpRoot, assignment, reportedCommits };
  const report: AgentReport = { status: 'succeeded', answer: 'Done', commits: [{ repository: root, sha: executorHead }], changes: [{ id: change, items: [{ id: '1.1', status: 'succeeded' }] }] };
  let operations: readonly TaskCheckboxOperation[] = [];
  const checkboxPorts = { verifyAssignmentCompletion: complete, operations: {
    read: async () => operations,
    write: async (_id: string, rows: readonly TaskCheckboxOperation[]) => { operations = structuredClone(rows); },
  } };
  assert.equal((await prepareReportedTaskCheckboxes(request, report, checkboxPorts)).ok, true);
  const checkboxHead = git('rev-parse', 'HEAD');
  assert.notEqual(checkboxHead, executorHead);
  const journal = JSON.stringify(operations);
  const bytes = JSON.stringify(report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, bytes);
  const initial = await stat(reportPath, { bigint: true });
  await writeFile(join(root, 'foreign.txt'), 'staged\n');
  git('add', '--', 'foreign.txt');
  await writeFile(join(root, 'foreign.txt'), 'unstaged\n');
  const staged = git('diff', '--cached');
  const unstaged = git('diff');
  const pending: PendingConfirmation[] = [];
  const accepted: AgentReportResult[] = [];
  const rejections: string[] = [];
  const ports: AgentReportPorts = {
    fs: { mkdir: async () => {}, readText: path => readFile(path, 'utf8'), readBytes: path => readFile(path), removeTree: async () => {} },
    watch: () => () => {}, process: { onExit: () => () => {} }, now: () => new Date().toISOString(),
    confirmationRetry: { runner: 'codex', protocol: async () => protocol, retainPending: async value => { if (value) pending.push(value); } },
    isCurrentReport: async id => id === runId && accepted.length === 0,
    verifyAssignmentCompletion: complete,
    confirmTaskCheckboxes: (current, candidate, budget, beforeWrite) => prepareReportedTaskCheckboxes(current, candidate, { ...checkboxPorts, budget, beforeWrite }),
    acceptResult: async result => { await verifyPendingAgentReportFreshness(request, result, ports); accepted.push(result); },
    result: async () => {}, diagnostic: async (reason, rejection) => { if (rejection) rejections.push(reason); },
  };
  t.mock.method(performance, 'now', () => clock);
  charge = true;
  return { root, tasksPath, reportPath, request, ports, protocol, calls, pending, accepted, rejections, identity, reserved,
    unsupported() { supported = false; },
    async stable() {
      assert.equal(git('rev-parse', 'HEAD'), checkboxHead);
      assert.equal(git('diff', '--cached'), staged);
      assert.equal(git('diff'), unstaged);
      assert.equal(JSON.stringify(operations), journal);
      assert.equal(await readFile(reportPath, 'utf8'), bytes);
      const current = await stat(reportPath, { bigint: true });
      assert.equal(current.ino, initial.ino);
      assert.equal(current.mtimeNs, initial.mtimeNs);
    },
  };
}

for (const [id, cost] of [['S01', 0.10], ['S02', 0.13]] as const) {
  test(`Z39398.${id} committed checkbox progresses to acceptance with recurring OpenSpec cost ${cost}`, async t => {
    const f = await fixture(t, cost);
    for (let cycle = 0; cycle < 3 && !f.accepted.length; cycle++) await readPendingAgentReport(f.request, f.ports);
    assert.equal(f.accepted.length, 1, `Repeated full cycles must not starve final-check/accept: ${JSON.stringify(f.pending.map(row => ({ stage: row.stage, cause: row.cause })))}`);
    assert.equal(f.accepted[0].event, 'agent.succeeded');
    assert.deepEqual(f.rejections, []);
    assert.deepEqual(f.pending, [], 'Unchanged verified inputs must fit the original configured budget');
    await f.stable();
  });
}

test('Z39398.S04 changed parser inputs still require the supported OpenSpec version', async t => {
  const f = await fixture(t, 0.10);
  f.unsupported();
  await writeFile(join(dirname(f.tasksPath), 'proposal.md'), '## Why\nChanged parser input.\n');
  const rows = await f.identity.resolveTasks(f.reserved);
  assert.equal(rows[0].state, 'unknown');
  assert.match('reason' in rows[0] ? rows[0].reason : '', /Unverified OpenSpec version/);
  assert.equal(f.accepted.length, 0);
});
