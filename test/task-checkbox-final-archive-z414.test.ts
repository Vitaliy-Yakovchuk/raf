import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createAssignmentIdentityAdapter } from '../src/assignment-identity.ts';
import { readPendingAgentReport, type AgentReport, type AgentReportRequest } from '../src/agent-report.ts';
import type { AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { RuntimeContext } from '../src/app-runtime.ts';
import { verifyAssignmentCompletion } from '../src/assignment.ts';
import { executeCommand } from '../src/os-runtime.ts';
import { confirmReportedTasks } from '../src/production-runtime.ts';
import { captureReportedCommitLaunchContext } from '../src/reported-commits.ts';
import { openStateStore } from '../src/state-store.ts';
import type { TaskCheckboxOperation } from '../src/task-checkbox-report.ts';

const change = 'final-checkbox-source';
const archive = `2026-10-25-${change}`;
const oldArchive = `2026-10-24-${change}`;
const pathspec = `openspec/changes/${change}/tasks.md`;
const original = '# Tasks\n\n- [ ] 5.1 Finish assigned work\n';
const checked = original.replace('[ ]', '[x]');

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-z414-'));
  const confRoot = join(root, 'conf');
  const source = join(root, dirname(pathspec));
  const archived = join(root, 'openspec/changes/archive', archive);
  await mkdir(source, { recursive: true });
  await mkdir(confRoot);
  await writeFile(join(confRoot, 'projects.json'), JSON.stringify({ projects: { raf: {} } }));
  await writeFile(join(root, pathspec), original);
  await mkdir(join(root, 'openspec/changes/archive', oldArchive), { recursive: true });
  await writeFile(join(root, 'openspec/changes/archive', oldArchive, 'tasks.md'), checked);
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete environment[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Z414 unit');
  git('config', 'user.email', 'z414@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '--', 'openspec');
  git('commit', '-qm', 'Launch source');
  const runId = 'same-final-executor';
  const tmpRoot = join(root, 'reports');
  const reportPath = join(tmpRoot, runId, 'executor.json');
  const launch = await captureReportedCommitLaunchContext(runId, reportPath, [root], [root]);
  await writeFile(join(root, 'result.txt'), 'Executor result\n');
  git('add', '--', 'result.txt');
  git('commit', '-qm', 'Executor result');
  const executor = git('rev-parse', 'HEAD');
  const assignment = { root, baselineArchives: [oldArchive], changes: [{ id: change, items: [{ id: '5.1', description: 'Finish assigned work' }] }] };
  const execute: AdapterCommandExecutor = async command => {
    if (command.executable !== 'openspec') return executeCommand({ ...command, environment: { ...environment, ...command.environment } });
    if (command.args[0] === '--version') return { exitCode: 0, stdout: '1.14.3\n', stderr: '' };
    let data: unknown;
    if (command.args[0] === 'list') {
      const parent = join(root, 'openspec/changes', ...(command.args.includes('--archived') ? ['archive'] : []));
      const names = await readdir(parent).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const changes = [];
      for (const name of names.filter(name => name !== 'archive')) {
        const text = await readFile(join(parent, name, 'tasks.md'), 'utf8');
        changes.push({ name, totalTasks: 1, completedTasks: text.includes('[x]') ? 1 : 0 });
      }
      data = { changes };
    } else {
      assert.deepEqual(command.args, ['instructions', 'apply', '--change', change, '--json']);
      const text = await readFile(join(command.cwd!, pathspec), 'utf8');
      data = { tasks: [...text.matchAll(/^\s*- \[([ xX])\] (\S+) (.+)$/gm)].map(row => ({ id: row[2], description: row[3], done: row[1].toLowerCase() === 'x' })) };
    }
    return { exitCode: 0, stdout: JSON.stringify(data), stderr: '' };
  };
  const identity = createAssignmentIdentityAdapter({ raf: root }, { execute });
  const tasks = await identity.capture('raf', assignment);
  const store = openStateStore(join(root, 'isolated.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const boot = { machineId: 'fixture', bootId: 'fixture' };
  const starter = { pid: process.pid, startedAt: new Date().toISOString(), runner: 'codex', runnerSessionId: runId, tmuxSession: runId, evidence: boot };
  store.sessionRepository.transaction(tx => tx.putSession({ runId, addressId: 'executor', revision: 0, state: 'running', activity: { type: 'hotfix', project: 'raf', features: [change], phase: 'hotfix', cwd: root } }));
  store.taskReservationRepository.transaction(tx => tx.putTaskReservation({ lease: { owner: { runId, addressId: 'executor', fence: 'fixture' }, revision: 0 }, tasks, boot, stage: 'running', starter }));
  const context: RuntimeContext = { orchestratorRoot: root, confRoot, artifactPath: join(root, 'catalog.json'), statePath: join(root, 'isolated.sqlite'), tmpRoot, mode: 'test', commandStartedAtMs: Date.now(), resolveCaller: async () => undefined };
  const request: AgentReportRequest = { tmpRoot, runId, address: 'executor', assignment, reportedCommits: launch };
  let report: AgentReport = { status: 'succeeded', answer: 'Completed', commits: [{ repository: root, sha: executor }], changes: [{ id: change, items: [{ id: '5.1', status: 'succeeded' }] }] };
  const protocol = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
  const confirm = (value = report) => confirmReportedTasks(store, context, execute, request, value, protocol.timeouts, execute);
  const first = await confirm();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.awaitingArchive, true);
  assert.equal(first.commits.length, 1);
  assert.equal(await readFile(join(root, pathspec), 'utf8'), checked);
  const checkbox = git('rev-parse', 'HEAD');
  const journal = async (): Promise<TaskCheckboxOperation[]> => JSON.parse(await readFile(join(tmpRoot, runId, 'task-checkbox-operations.json'), 'utf8'));
  const completion = (claims: Readonly<Record<string, string>>) => verifyAssignmentCompletion(assignment, { cli: { exec: (args, cwd) => execute({ executable: 'openspec', args, cwd }) }, fs: { readText: path => readFile(path, 'utf8') } }, claims);
  const diagnostics: string[] = [];
  const read = () => readPendingAgentReport(request, {
    fs: { readText: async () => JSON.stringify(report) }, now: () => new Date().toISOString(),
    confirmationRetry: { runner: 'codex', protocol: async () => protocol },
    diagnostic: async reason => { diagnostics.push(reason); },
    isCurrentReport: async () => true,
    confirmTaskCheckboxes: (_request, value) => confirm(value),
    verifyAssignmentCompletion: (_assignment, claims = {}) => completion(claims),
  });
  const move = async () => {
    await mkdir(dirname(archived), { recursive: true });
    await rename(source, archived);
    git('add', '-A', '--', 'openspec');
    git('commit', '-qm', 'Executor sync and archive');
    const sha = git('rev-parse', 'HEAD');
    report = { ...report, commits: [...report.commits!, { repository: root, sha }], changes: [{ ...report.changes[0], archive }] };
    return sha;
  };
  return { root, source, archived, git, request, report: () => report, confirm, first, checkbox, journal, read, diagnostics, move,
    withoutClaim: () => ({ ...report, changes: [{ id: change, items: report.changes[0].items }] }) };
}

test('Z414 committed final report follows the same checked source into its exact archive', async t => {
  const f = await fixture(t);
  const head = await f.move();
  const result = await f.read();
  assert.equal(result?.status, 'succeeded', f.diagnostics.join('\n'));
  assert.deepEqual(result.checkboxCommits, f.first.commits);
  assert.equal(result.report?.changes[0].archive, archive);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('status', '--porcelain', '--', 'openspec'), '');
});

test('Z414 archive move before the final JSON preserves checkbox provenance while awaiting the exact claim', async t => {
  const f = await fixture(t);
  const head = await f.move();
  const pending = await f.confirm(f.withoutClaim());
  assert.equal(pending.ok, true, JSON.stringify(pending));
  assert.equal(pending.awaitingArchive, true);
  assert.deepEqual(pending.commits, f.first.commits);
  assert.equal((await f.read())?.status, 'succeeded', f.diagnostics.join('\n'));
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});

for (const invalid of ['missing archive', 'changed description', 'changed row', 'unchecked row', 'old archive', 'wrong claim', 'foreign journal'] as const) {
  test(`Z414 rejects ${invalid} after a committed checkbox and archive`, async t => {
    const f = await fixture(t);
    await f.move();
    let report = f.report();
    if (invalid === 'missing archive') await rm(f.archived, { recursive: true });
    if (invalid === 'changed description') await writeFile(join(f.archived, 'tasks.md'), checked.replace('Finish assigned work', 'Different work'));
    if (invalid === 'changed row') await writeFile(join(f.archived, 'tasks.md'), checked.replace('- [x]', '  - [x]'));
    if (invalid === 'unchecked row') await writeFile(join(f.archived, 'tasks.md'), original);
    if (invalid === 'old archive') report = { ...report, changes: [{ ...report.changes[0], archive: oldArchive }] };
    if (invalid === 'wrong claim') report = { ...report, changes: [{ ...report.changes[0], archive: '2026-10-25-other' }] };
    if (invalid === 'foreign journal') await writeFile(join(f.request.tmpRoot, f.request.runId, 'task-checkbox-operations.json'), JSON.stringify((await f.journal()).map(row => ({ ...row, runId: 'foreign-run' }))));
    const head = f.git('rev-parse', 'HEAD');
    const result = await f.confirm(report);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(result.issues.length > 0);
    assert.match(result.issues.map(row => row.reason).join('\n'), /source|archive|task|row|description|journal|ENOENT|пункт|архів/i);
    assert.equal(f.git('rev-parse', 'HEAD'), head);
  });
}
