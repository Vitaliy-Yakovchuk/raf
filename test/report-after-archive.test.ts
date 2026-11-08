import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyAssignmentCompletion, type AssignmentPorts } from '../src/assignment.ts';
import { readPendingAgentReport } from '../src/agent-report.ts';

const change = 'fix-raf-hotfix-role-brief';
const archive = `2026-11-08-${change}`;

for (const mode of ['archived', 'active', 'open', 'missing', 'ambiguous', 'baseline'] as const) {
  test(`run 31a30718 report after committed checkbox: ${mode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'raf-report-archive-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const changes = join(root, 'openspec/changes');
    const source = join(changes, change);
    const archives = join(changes, 'archive');
    await mkdir(source, { recursive: true });
    await mkdir(archives);
    const tasks = join(source, 'tasks.md');
    await writeFile(tasks, '- [ ] 1.1 Complete hotfix\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Report fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', '/dev/null');
    git('add', '--', 'openspec');
    git('commit', '-qm', 'Initial task');
    await writeFile(tasks, '- [x] 1.1 Complete hotfix\n');
    git('add', '--', 'openspec');
    git('commit', '-qm', 'raf: confirm checkbox');
    const checkbox = git('rev-parse', 'HEAD');
    if (mode !== 'active') {
      await rename(source, join(archives, archive));
      git('add', '-A', '--', 'openspec');
      git('commit', '-qm', 'openspec archive --skip-specs');
    }
    if (mode === 'open') await writeFile(join(archives, archive, 'tasks.md'), '- [ ] 1.1 Complete hotfix\n');
    if (mode === 'missing') await rm(join(archives, archive), { recursive: true });
    if (mode === 'ambiguous') {
      await mkdir(join(archives, `2026-11-09-${change}`));
      await writeFile(join(archives, `2026-11-09-${change}`, 'tasks.md'), '- [x] 1.1 Complete hotfix\n');
    }
    const assignment = { root, baselineArchives: mode === 'baseline' ? [archive] : [], changes: [{ id: change, items: [{ id: '1.1', description: 'Complete hotfix' }] }] };
    const calls: string[] = [];
    const ports: AssignmentPorts = {
      fs: { readText: path => readFile(path, 'utf8'), listDirectories: async path => (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name) },
      cli: { exec: async args => {
        calls.push(args.join(' '));
        if (args[0] === 'list') return { exitCode: 0, stdout: JSON.stringify({ changes: [{ name: change, completedTasks: 1, totalTasks: 1 }] }), stderr: '' };
        if (mode !== 'active') return { exitCode: 1, stdout: '', stderr: `change_error: Change '${change}' not found` };
        return { exitCode: 0, stdout: JSON.stringify({ tasks: [{ id: '1.1', description: 'Complete hotfix', done: true }] }), stderr: '' };
      } },
    };
    const diagnostics: string[] = [];
    const result = await readPendingAgentReport({ tmpRoot: root, runId: 'fixture', address: 'executor', assignment }, {
      fs: { readText: async () => JSON.stringify({ status: 'succeeded', answer: 'Done', changes: [{ id: change, items: [{ id: '1.1', status: 'succeeded' }] }] }) },
      now: () => new Date().toISOString(), diagnostic: async text => { diagnostics.push(text); },
      verifyAssignmentCompletion: snapshot => verifyAssignmentCompletion(snapshot, ports),
    });
    const accepted = mode === 'archived' || mode === 'active';
    assert.equal(result?.status === 'succeeded', accepted, diagnostics.join('\n'));
    if (mode === 'archived') assert.deepEqual(calls, []);
    if (mode === 'active') assert.ok(calls.includes(`instructions apply --change ${change} --json`));
    assert.equal(git('show', `${checkbox}:openspec/changes/${change}/tasks.md`), '- [x] 1.1 Complete hotfix');
  });
}
