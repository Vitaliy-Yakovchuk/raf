import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentReport, AgentReportRequest } from '../src/agent-report.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation, type TaskCheckboxPorts } from '../src/task-checkbox-report.ts';

const taskPath = 'openspec/changes/index-regression/tasks.md';
const original = '# Index regression\n\n- [ ] 1.1 Selected task\n- [ ] 1.2 Other task\n\n## Evidence\n\nOriginal evidence\n';
const completed = (text: string): string => text.replace('- [ ] 1.1 Selected task', '- [x] 1.1 Selected task');

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-checkbox-index-')));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  git('init', '-q');
  git('config', 'user.name', 'Checkbox index fixture');
  git('config', 'user.email', 'checkbox-index@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'core.hooksPath', join(root, 'empty-hooks'));
  await mkdir(dirname(join(root, taskPath)), { recursive: true });
  await writeFile(join(root, taskPath), original);
  await writeFile(join(root, 'other.txt'), 'Original other file\n');
  git('add', '--', taskPath, 'other.txt');
  git('commit', '-qm', 'Initial task source');
  const parent = git('rev-parse', 'HEAD').trim();
  const request: AgentReportRequest = {
    tmpRoot: join(root, 'report-tmp'),
    runId: 'z368-index-regression',
    address: 'index-regression-agent',
    assignment: {
      root,
      changes: [{ id: 'index-regression', items: [{ id: '1.1', description: 'Selected task' }] }],
      baselineArchives: [],
    },
  };
  const report: AgentReport = {
    status: 'succeeded',
    answer: 'Selected work completed',
    changes: [{ id: 'index-regression', items: [{ id: '1.1', status: 'succeeded' }] }],
  };
  let operations: readonly TaskCheckboxOperation[] = [];
  const ports: TaskCheckboxPorts = {
    verifySourceIdentity: async (snapshot, archives) => {
      assert.deepEqual(snapshot, request.assignment);
      assert.deepEqual(archives, {});
      return { ok: true, issues: [] };
    },
    verifyAssignmentCompletion: async (snapshot, archives) => {
      assert.deepEqual(snapshot, request.assignment);
      assert.deepEqual(archives, {});
      assert.equal(git('show', `HEAD:${taskPath}`), completed(original));
      assert.ok((await readFile(join(root, taskPath), 'utf8')).includes('- [x] 1.1 Selected task\n'));
      return { ok: true, issues: [] };
    },
    operations: {
      read: async runId => {
        assert.equal(runId, request.runId);
        return structuredClone(operations);
      },
      write: async (runId, next) => {
        assert.equal(runId, request.runId);
        operations = structuredClone(next);
      },
    },
  };
  const confirm = async (): Promise<string> => {
    const result = await prepareReportedTaskCheckboxes(request, report, ports);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.awaitingArchive, false);
    assert.equal(result.commits.length, 1);
    const commit = result.commits[0];
    assert.equal(commit.change, 'index-regression');
    assert.equal(commit.item, '1.1');
    assert.equal(git('rev-parse', 'HEAD').trim(), commit.sha);
    assert.equal(git('rev-parse', `${commit.sha}^`).trim(), parent);
    assert.equal(git('show', '--format=', '--name-only', commit.sha).trim(), taskPath);
    assert.equal(git('show', `${commit.sha}:${taskPath}`), completed(original));
    assert.equal(git('show', `${commit.sha}^:${taskPath}`), original);
    const message = git('show', '-s', '--format=%B', commit.sha);
    assert.ok(message.includes(request.runId));
    assert.ok(message.includes('index-regression:1.1'));
    return commit.sha;
  };
  return { root, git, confirm };
}

test('[checkbox-index Z.368] clean task index follows checkbox HEAD while foreign unstaged evidence survives', async t => {
  const f = await fixture(t);
  assert.equal(f.git('rev-parse', `:${taskPath}`), f.git('rev-parse', `HEAD:${taskPath}`));
  const working = original + '\nForeign unstaged evidence\n';
  await writeFile(join(f.root, taskPath), working);
  await writeFile(join(f.root, 'other.txt'), 'Foreign unstaged other file\n');

  await f.confirm();

  assert.equal(await readFile(join(f.root, taskPath), 'utf8'), completed(working));
  assert.equal(await readFile(join(f.root, 'other.txt'), 'utf8'), 'Foreign unstaged other file\n');
  assert.equal(f.git('rev-parse', `:${taskPath}`), f.git('rev-parse', `HEAD:${taskPath}`), 'the shared index must contain the committed checkbox blob');
  assert.equal(f.git('show', `:${taskPath}`), completed(original));
  assert.equal(f.git('diff', '--cached', '--', taskPath), '');
});

test('[checkbox-index Z.368] next ordinary commit of only another file cannot revert the checkbox', async t => {
  const f = await fixture(t);
  const working = original + '\nEvidence intentionally left unstaged\n';
  await writeFile(join(f.root, taskPath), working);
  const checkboxCommit = await f.confirm();
  const committedTasks = f.git('show', `HEAD:${taskPath}`);

  await writeFile(join(f.root, 'other.txt'), 'Agent work for the next commit\n');
  f.git('add', '--', 'other.txt');
  f.git('commit', '-qm', 'Agent commits only another file');

  assert.equal(f.git('show', `HEAD:${taskPath}`), committedTasks, 'an ordinary commit must not roll back the raf checkbox');
  assert.equal(f.git('diff', '--name-only', checkboxCommit, 'HEAD').trim(), 'other.txt');
  assert.equal(f.git('show', 'HEAD:other.txt'), 'Agent work for the next commit\n');
  assert.equal(await readFile(join(f.root, taskPath), 'utf8'), completed(working));
  assert.equal(f.git('show', `:${taskPath}`), committedTasks);
});

test('[checkbox-index Z.368] staged task hunks gain the checkbox and preserve staged versus unstaged ownership', async t => {
  const f = await fixture(t);
  const staged = original.replace('- [ ] 1.2 Other task', '- [x] 1.2 Other task').replace('Original evidence', 'Foreign staged evidence');
  const working = staged + '\nForeign unstaged evidence\n';
  await writeFile(join(f.root, taskPath), staged);
  await writeFile(join(f.root, 'other.txt'), 'Foreign staged other file\n');
  f.git('add', '--', taskPath, 'other.txt');
  const stagedDiff = f.git('diff', '--cached', '--unified=0', '--', taskPath, 'other.txt');
  await writeFile(join(f.root, taskPath), working);
  await writeFile(join(f.root, 'other.txt'), 'Foreign staged other file\nForeign unstaged other file\n');
  const unstagedDiff = f.git('diff', '--unified=0', '--', taskPath, 'other.txt');

  await f.confirm();

  assert.equal(await readFile(join(f.root, taskPath), 'utf8'), completed(working));
  assert.equal(await readFile(join(f.root, 'other.txt'), 'utf8'), 'Foreign staged other file\nForeign unstaged other file\n');
  assert.equal(f.git('show', ':other.txt'), 'Foreign staged other file\n');
  assert.equal(f.git('show', `:${taskPath}`), completed(staged), 'keep foreign staged hunks and apply only the committed checkbox');
  const afterStagedDiff = f.git('diff', '--cached', '--unified=0', '--', taskPath, 'other.txt');
  const afterUnstagedDiff = f.git('diff', '--unified=0', '--', taskPath, 'other.txt');
  const patchContent = (diff: string): string => diff.split('\n').filter(line => !line.startsWith('index ')).join('\n');
  assert.equal(patchContent(afterStagedDiff), patchContent(stagedDiff));
  assert.equal(patchContent(afterUnstagedDiff), patchContent(unstagedDiff));
});
