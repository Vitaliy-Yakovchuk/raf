import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readPendingAgentReport, verifyPendingAgentReportFreshness, type AgentReport, type AgentReportRequest, type PendingAgentReportPorts } from '../src/agent-report.ts';
import { captureReportedCommitLaunchContext } from '../src/reported-commits.ts';

async function fixture(t: TestContext, status: 'succeeded' | 'failed' = 'succeeded') {
  const root = await mkdtemp(join(tmpdir(), 'raf-report-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  await mkdir(repository);
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Freshness fixture', '-c', 'user.email=freshness@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: repository, env: environment, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  await writeFile(join(repository, 'work.txt'), 'baseline\n');
  git('add', '--', 'work.txt');
  git('commit', '--quiet', '-m', 'launch baseline');
  const path = join(root, 'run', 'worker.json');
  const reportedCommits = await captureReportedCommitLaunchContext('run', path, [repository], [repository]);
  await writeFile(join(repository, 'work.txt'), 'executor result\n');
  git('commit', '--quiet', '-am', 'executor result');
  const sha = git('rev-parse', 'HEAD');
  const request: AgentReportRequest = { tmpRoot: root, runId: 'run', address: 'worker', reportedCommits, assignment: { root: repository, baselineArchives: [], changes: [{ id: 'change', items: [{ id: '1.1', description: 'Assigned work' }] }] } };
  const report: AgentReport = { status, answer: 'Result', commits: [{ repository, sha }], changes: [{ id: 'change', items: [{ id: '1.1', status, ...(status === 'failed' ? { reason: 'Incomplete work' } : {}) }] }] };
  await mkdir(join(root, 'run'));
  await writeFile(path, JSON.stringify(report));
  const good = { ok: true, issues: [] } as const;
  const calls = { checkbox: 0, completion: 0 };
  let current = true;
  const ports: PendingAgentReportPorts = {
    fs: { readText: path => readFile(path, 'utf8') },
    now: () => '2026-10-23T00:00:00.000Z',
    diagnostic: async () => {},
    isCurrentReport: async () => current,
    confirmTaskCheckboxes: async () => {
      calls.checkbox++;
      return { ...good, commits: [] };
    },
    verifyAssignmentCompletion: async () => { calls.completion++; return good; },
  };
  const pending = () => readPendingAgentReport(request, ports);
  return { request, report, path, ports, calls, pending, setCurrent: (value: boolean) => { current = value; } };
}

for (const status of ['succeeded', 'failed'] as const) {
  test(`[report-freshness] ${status} is accepted without source re-verification and no repeated completion`, async t => {
    const f = await fixture(t, status);
    const result = await f.pending();
    assert.ok(result);
    assert.deepEqual(f.calls, { checkbox: status === 'succeeded' ? 1 : 0, completion: status === 'succeeded' ? 1 : 0 });
    const initialCalls = { ...f.calls };
    await verifyPendingAgentReportFreshness(f.request, result, f.ports);
    assert.deepEqual(f.calls, initialCalls);
  });
}

test('[report-freshness] byte changes require full rereading even when JSON is equivalent', async t => {
  const f = await fixture(t);
  const result = await f.pending();
  assert.ok(result);
  await writeFile(f.path, JSON.stringify(f.report) + '\n');
  await assert.rejects(verifyPendingAgentReportFreshness(f.request, result, f.ports), /snapshot changed/);
  const fresh = await f.pending();
  assert.ok(fresh);
  await verifyPendingAgentReportFreshness(f.request, fresh, f.ports);
});

test('[report-freshness] copied and mutated results cannot supply process-local verification', async t => {
  const f = await fixture(t);
  const result = await f.pending();
  assert.ok(result);
  await assert.rejects(verifyPendingAgentReportFreshness(f.request, { ...result }, f.ports), /no verified snapshot/);
  await assert.rejects(verifyPendingAgentReportFreshness({ ...f.request }, result, f.ports), /no verified snapshot/);
  Object.assign(result, { status: 'failed' });
  await assert.rejects(verifyPendingAgentReportFreshness(f.request, result, f.ports), /no verified snapshot/);
});

test('[report-freshness] a stale run is refused before durable acceptance', async t => {
  const f = await fixture(t);
  const result = await f.pending();
  assert.ok(result);
  f.setCurrent(false);
  await assert.rejects(verifyPendingAgentReportFreshness(f.request, result, f.ports), /current run\/report path/);
});
