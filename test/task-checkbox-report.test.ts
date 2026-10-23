import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createAgentReportWatcher, readPendingAgentReport, type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import { composeAssignmentBrief, type AssignmentSnapshot, type AssignmentVerification } from '../src/assignment.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxCheckpoint, type TaskCheckboxConfirmation, type TaskCheckboxOperation, type TaskCheckboxPorts, type TaskCheckboxReportPort } from '../src/task-checkbox-report.ts';

const execute = promisify(execFile);
const openTasks = '# Tasks\n\n- [ ] A.1 Alpha\n- [ ] A.10 Neighbor\n- [ ] B.2 Parent\n  - [ ] B.2.1 Nested\n    - [ ] B.2.1.a Lettered\n- [ ] C.1 Other owner\n';
const descriptions: Record<string, string> = { 'A.1': 'Alpha', 'A.10': 'Neighbor', 'B.2': 'Parent', 'B.2.1': 'Nested', 'B.2.1.a': 'Lettered', 'C.1': 'Other owner' };
const ok: AssignmentVerification = { ok: true, issues: [] };
const success: TaskCheckboxConfirmation = { ...ok, commits: [], awaitingArchive: false };

function issue(change: string, item: string, reason: string): AssignmentVerification {
  return { ok: false, issues: [{ change, requestedItems: [item], reason, foundItems: [], archives: [], remedy: 'Узгодити джерело і повторити звірку початкового доручення.' }] };
}

function assignment(root: string, selections: Readonly<Record<string, readonly string[]>> = { sample: ['A.1'] }): AssignmentSnapshot {
  return { root, baselineArchives: ['2026-10-22-sample'], changes: Object.entries(selections).map(([id, ids]) => ({ id, items: ids.map(id => ({ id, description: descriptions[id] })) })) };
}

function reportFor(snapshot: AssignmentSnapshot): AgentReport {
  return { status: 'succeeded', answer: 'Виконано й закомічено докази.', changes: snapshot.changes.map(change => ({ id: change.id, items: change.items.map(item => ({ id: item.id, status: 'succeeded' })) })), commits: ['executor-owned-commit'] };
}

function requestFor(snapshot: AssignmentSnapshot, runId = 'run-checkbox-349'): AgentReportRequest {
  return { tmpRoot: join(snapshot.root, 'tmp'), runId, address: 'checkbox-author', assignment: snapshot };
}

function readerHarness(snapshot = assignment('/fixture')) {
  const request = requestFor(snapshot);
  let raw: string | null = JSON.stringify(reportFor(snapshot));
  let listener: ((event: 'create' | 'modify' | 'rename', filename: string) => Promise<void>) | undefined;
  const calls: string[] = [];
  const results: AgentReportResult[] = [];
  const diagnostics: string[] = [];
  const ports: AgentReportPorts & TaskCheckboxReportPort = {
    fs: { mkdir: async () => {}, readText: async path => path === join(request.tmpRoot, request.runId, request.address + '.json') ? raw : null, removeTree: async () => { calls.push('cleanup'); } },
    watch: (_directory, callback) => { listener = callback; return () => {}; },
    process: { onExit: () => () => {} },
    now: () => '2026-10-23T10:00:00.000Z',
    confirmTaskCheckboxes: async (received, report) => { assert.deepEqual(received, request); assert.deepEqual(report, JSON.parse(raw!)); calls.push('checkbox'); return success; },
    verifyAssignmentCompletion: async received => { assert.deepEqual(received, snapshot); calls.push('openspec'); return ok; },
    result: async result => { calls.push('result'); results.push(result); },
    diagnostic: async reason => { diagnostics.push(reason); },
  };
  return { request, ports, calls, results, diagnostics, setRaw(value: string | null) { raw = value; }, async notify() { assert.ok(listener); await listener('rename', request.address + '.json'); } };
}

test('[checkbox-report] pending reader confirms checkbox commits before final OpenSpec verification', async () => {
  const h = readerHarness();
  const result = await readPendingAgentReport(h.request, h.ports);
  assert.equal(result?.status, 'succeeded');
  assert.deepEqual(h.calls, ['checkbox', 'openspec']);
  assert.deepEqual(result?.report?.commits, ['executor-owned-commit']);
});

test('[checkbox-report] watcher publishes once after confirmation and preserves the executor JSON', async () => {
  const h = readerHarness();
  const original = reportFor(h.request.assignment);
  const watcher = await createAgentReportWatcher(h.request, h.ports);
  try {
    await h.notify();
    await h.notify();
    await watcher.finish({ code: 7, signal: null });
    assert.deepEqual(h.calls.filter(call => call === 'checkbox'), ['checkbox']);
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].event, 'agent.succeeded');
    assert.equal(h.results[0].runId, h.request.runId);
    assert.deepEqual(h.results[0].report, original);
    assert.ok(h.calls.indexOf('checkbox') < h.calls.indexOf('openspec'));
    assert.ok(h.calls.indexOf('openspec') < h.calls.indexOf('result'));
  } finally { await watcher.dispose(); }
});

const invalidReports: [string, (report: any) => string | null][] = [
  ['truncated JSON', () => '{"status":"succeeded",'],
  ['missing file', () => null],
  ['missing answer', report => { delete report.answer; return JSON.stringify(report); }],
  ['invalid status', report => { report.status = 'complete'; return JSON.stringify(report); }],
  ['missing change', report => { report.changes = []; return JSON.stringify(report); }],
  ['extra change', report => { report.changes.push({ id: 'other', items: [{ id: 'A.1', status: 'succeeded' }] }); return JSON.stringify(report); }],
  ['duplicate change', report => { report.changes.push(report.changes[0]); return JSON.stringify(report); }],
  ['missing item', report => { report.changes[0].items = []; return JSON.stringify(report); }],
  ['extra item', report => { report.changes[0].items.push({ id: 'A.10', status: 'succeeded' }); return JSON.stringify(report); }],
  ['duplicate item', report => { report.changes[0].items.push(report.changes[0].items[0]); return JSON.stringify(report); }],
  ['parent instead of exact item', report => { report.changes[0].items[0].id = 'A'; return JSON.stringify(report); }],
  ['failed item inside succeeded', report => { report.changes[0].items[0].status = 'failed'; report.changes[0].items[0].reason = 'Не виконано'; return JSON.stringify(report); }],
];

for (const [name, mutate] of invalidReports) {
  test('[checkbox-report] no writes for ' + name, async () => {
    const h = readerHarness();
    h.setRaw(mutate(reportFor(h.request.assignment)));
    assert.equal(await readPendingAgentReport(h.request, h.ports), null);
    assert.deepEqual(h.calls, []);
  });
}

test('[checkbox-report] failed with a succeeded subset never invokes checkbox or OpenSpec writes', async () => {
  const h = readerHarness(assignment('/fixture', { sample: ['A.1', 'B.2.1'] }));
  const report: any = reportFor(h.request.assignment);
  report.status = 'failed';
  report.changes[0].items[1] = { id: 'B.2.1', status: 'failed', reason: 'Робота не виконана' };
  h.setRaw(JSON.stringify(report));
  assert.equal((await readPendingAgentReport(h.request, h.ports))?.status, 'failed');
  assert.deepEqual(h.calls, []);
});

test('[checkbox-report] every change is validated before the first checkbox operation', async () => {
  const h = readerHarness(assignment('/fixture', { first: ['A.1'], second: ['B.2.1.a'] }));
  const report: any = reportFor(h.request.assignment);
  report.changes[1].items[0].id = 'B.2.1';
  h.setRaw(JSON.stringify(report));
  assert.equal(await readPendingAgentReport(h.request, h.ports), null);
  assert.deepEqual(h.calls, []);
});

test('[checkbox-report] old run path and exit zero do not authorize a new run', async () => {
  const h = readerHarness();
  const currentPath = join(h.request.tmpRoot, h.request.runId, h.request.address + '.json');
  h.ports.fs.readText = async path => path === currentPath ? null : JSON.stringify(reportFor(h.request.assignment));
  const watcher = await createAgentReportWatcher(h.request, h.ports);
  try {
    await watcher.finish({ code: 0, signal: null });
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].status, 'failed');
    assert.equal(h.calls.includes('checkbox'), false);
  } finally { await watcher.dispose(); }
});

for (const mode of ['identity conflict', 'Git failure', 'awaiting archive'] as const) {
  test('[checkbox-report] ' + mode + ' blocks final acceptance', async () => {
    const h = readerHarness();
    h.ports.confirmTaskCheckboxes = async () => {
      h.calls.push('checkbox');
      if (mode === 'Git failure') throw new Error('Git write refused for sample:A.1');
      return mode === 'awaiting archive' ? { ...success, awaitingArchive: true } : { ...issue('sample', 'A.1', 'source instance mismatch'), commits: [], awaitingArchive: false };
    };
    assert.equal(await readPendingAgentReport(h.request, h.ports), null);
    assert.deepEqual(h.results, []);
    assert.equal(h.calls.includes('openspec'), false);
    if (mode !== 'awaiting archive') assert.match(h.diagnostics.join('\n'), /sample|source|Git/u);
  });
}

test('[checkbox-report] final OpenSpec failure never emits succeeded after a checkbox commit', async () => {
  const h = readerHarness();
  h.ports.verifyAssignmentCompletion = async () => { h.calls.push('openspec'); throw new Error('OpenSpec unavailable'); };
  assert.equal(await readPendingAgentReport(h.request, h.ports), null);
  assert.deepEqual(h.calls, ['checkbox', 'openspec']);
  assert.equal(h.results.length, 0);
});

test('[checkbox-report] provisional last-item JSON keeps the session pending until the same report gains an archive', async () => {
  const h = readerHarness();
  h.ports.confirmTaskCheckboxes = async (_request, report) => { h.calls.push('checkbox'); return { ...success, awaitingArchive: !report.changes[0].archive }; };
  const watcher = await createAgentReportWatcher(h.request, h.ports);
  try {
    await h.notify();
    assert.equal(h.results.length, 0);
    assert.equal(h.calls.includes('cleanup'), false);
    const final = { ...reportFor(h.request.assignment), changes: [{ ...reportFor(h.request.assignment).changes[0], archive: '2026-10-23-sample' }] };
    h.setRaw(JSON.stringify(final));
    await h.notify();
    await h.notify();
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].event, 'agent.succeeded');
    assert.equal(h.results[0].report?.changes[0].archive, '2026-10-23-sample');
  } finally { await watcher.dispose(); }
});

type Fixture = Awaited<ReturnType<typeof gitFixture>>;

async function gitFixture(t: TestContext, selections: Readonly<Record<string, readonly string[]>> = { sample: ['A.1'] }, tasks = openTasks) {
  const root = await mkdtemp(join(tmpdir(), 'raf-checkbox-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const git = async (...args: string[]) => (await execute('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Checkbox fixture', GIT_AUTHOR_EMAIL: 'checkbox@example.invalid', GIT_COMMITTER_NAME: 'Checkbox fixture', GIT_COMMITTER_EMAIL: 'checkbox@example.invalid' } })).stdout;
  await git('init', '-q');
  await git('config', 'user.name', 'Checkbox fixture');
  await git('config', 'user.email', 'checkbox@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.hooksPath', join(root, 'empty-hooks'));
  const paths = Object.keys(selections).map(change => 'openspec/changes/' + change + '/tasks.md');
  for (const path of paths) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), tasks); }
  await writeFile(join(root, 'other.txt'), 'base\n');
  await git('add', '--', ...paths, 'other.txt');
  await git('commit', '-qm', 'fixture source');
  const baseline = (await git('rev-parse', 'HEAD')).trim();
  const snapshot = assignment(root, selections);
  const request = requestFor(snapshot);
  const report = reportFor(snapshot);
  const calls: string[] = [];
  const sources = new Map(await Promise.all(snapshot.changes.map(async change => {
    const stat = await lstat(join(root, 'openspec/changes', change.id), { bigint: true });
    return [change.id, [stat.dev, stat.ino, stat.birthtimeNs].map(String).join(':')] as const;
  })));
  const journal = join(root, '.git', 'checkbox-current-run.json');
  let checkpoint: NonNullable<TaskCheckboxPorts['checkpoint']> = async () => {};
  const ports: TaskCheckboxPorts = {
    verifySourceIdentity: async (received, archives) => {
      assert.deepEqual(received, snapshot);
      calls.push('identity');
      for (const change of snapshot.changes) {
        try {
          if (archives[change.id] && snapshot.baselineArchives.includes(archives[change.id])) return issue(change.id, change.items[0].id, 'old archive predates launch');
          const directory = archives[change.id] ? join(root, 'openspec/changes/archive', archives[change.id]) : join(root, 'openspec/changes', change.id);
          const stat = await lstat(directory, { bigint: true });
          if (stat.isSymbolicLink() || [stat.dev, stat.ino, stat.birthtimeNs].map(String).join(':') !== sources.get(change.id)) return issue(change.id, change.items[0].id, 'source instance mismatch');
        } catch { return issue(change.id, change.items[0].id, 'source instance missing'); }
      }
      return ok;
    },
    verifyAssignmentCompletion: async (received, archives) => {
      assert.deepEqual(received, snapshot);
      calls.push('openspec');
      for (const change of snapshot.changes) {
        const path = archives[change.id] ? join(root, 'openspec/changes/archive', archives[change.id], 'tasks.md') : join(root, 'openspec/changes', change.id, 'tasks.md');
        const text = await readFile(path, 'utf8');
        for (const item of change.items) if (!text.split('\n').some(line => line.trim() === '- [x] ' + item.id + ' ' + item.description)) return issue(change.id, item.id, 'OpenSpec item still open');
        if (archives[change.id] && text.split('\n').some(line => /^\s*- \[ \]/u.test(line))) return issue(change.id, change.items[0].id, 'OpenSpec completedTasks differs from totalTasks');
      }
      return ok;
    },
    operations: {
      read: async runId => { assert.equal(runId, request.runId); try { return JSON.parse(await readFile(journal, 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; } },
      write: async (runId, operations) => { assert.equal(runId, request.runId); await writeFile(journal + '.tmp', JSON.stringify(operations)); await rename(journal + '.tmp', journal); },
    },
    checkpoint: async (phase, item) => { calls.push(phase); await checkpoint(phase, item); },
    waitForIndex: async () => { throw new Error('Unexpected occupied index in fixture'); },
  };
  const confirm = async (input = report, selectedRequest = request) => {
    let result!: TaskCheckboxConfirmation;
    await assert.doesNotReject(async () => { result = await prepareReportedTaskCheckboxes(selectedRequest, input, ports); }, 'valid report must reach checkbox behavior; NotImplemented is the intended scaffold red');
    return result;
  };
  return { root, git, baseline, paths, snapshot, request, report, calls, ports, confirm, setCheckpoint(value: typeof checkpoint) { checkpoint = value; }, async text(path = paths[0]) { return readFile(join(root, path), 'utf8'); }, async edit(text: string, path = paths[0]) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); } };
}

async function assertCheckboxCommits(f: Fixture, result: TaskCheckboxConfirmation, expected: readonly [string, string][]) {
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.commits.map(commit => [commit.change, commit.item]).sort(), [...expected].sort());
  const shas = (await f.git('rev-list', '--reverse', f.baseline + '..HEAD')).trim().split('\n').filter(Boolean);
  assert.equal(shas.length, expected.length);
  assert.deepEqual(new Set(result.commits.map(commit => commit.sha)), new Set(shas));
  for (const commit of result.commits) {
    const path = 'openspec/changes/' + commit.change + '/tasks.md';
    assert.equal((await f.git('show', '--format=', '--name-only', commit.sha)).trim(), path);
    const parent = await f.git('show', commit.sha + '^:' + path);
    const after = await f.git('show', commit.sha + ':' + path);
    const id = commit.item;
    const originalLine = parent.split('\n').find(line => line.trim() === '- [ ] ' + id + ' ' + descriptions[id]);
    assert.ok(originalLine, 'parent has the exact unchanged task');
    assert.equal(after, parent.replace(originalLine, originalLine.replace('[ ]', '[x]')));
    const message = await f.git('show', '-s', '--format=%B', commit.sha);
    assert.ok(message.includes(f.request.runId));
    assert.ok(message.includes(commit.change + ':' + id));
  }
}

test('[checkbox-git] exact nested and lettered IDs across changes get one marker-only commit each', async t => {
  const f = await gitFixture(t, { sample: ['A.1', 'B.2.1.a'], second: ['B.2.1'] });
  const before = JSON.stringify(f.report);
  const result = await f.confirm();
  await assertCheckboxCommits(f, result, [['sample', 'A.1'], ['sample', 'B.2.1.a'], ['second', 'B.2.1']]);
  assert.equal(result.awaitingArchive, false);
  assert.equal(JSON.stringify(f.report), before);
  assert.equal(await f.text(), openTasks.replace('[ ] A.1 ', '[x] A.1 ').replace('[ ] B.2.1.a ', '[x] B.2.1.a '));
  assert.ok(f.calls.indexOf('identity') < f.calls.indexOf('before-write'));
});

test('[checkbox-git] selecting a parent never checks its descendants', async t => {
  const f = await gitFixture(t, { sample: ['B.2'] });
  await assertCheckboxCommits(f, await f.confirm(), [['sample', 'B.2']]);
  assert.equal(await f.text(), openTasks.replace('[ ] B.2 Parent', '[x] B.2 Parent'));
});

test('[checkbox-git] staged and unstaged foreign hunks and index bytes survive exactly', async t => {
  const f = await gitFixture(t);
  await f.edit(openTasks.replace('[ ] A.10', '[x] A.10') + '  - staged executor evidence\n');
  await writeFile(join(f.root, 'other.txt'), 'foreign staged\n');
  await f.git('add', '--', f.paths[0], 'other.txt');
  await f.edit((await f.text()).replace('[ ] C.1', '[x] C.1') + '  - unstaged other author evidence\n');
  await writeFile(join(f.root, 'other.txt'), 'foreign staged\nforeign unstaged\n');
  const indexBefore = await readFile(join(f.root, '.git/index'));
  const stagedBefore = await f.git('diff', '--cached', f.baseline, '--', f.paths[0], 'other.txt');
  const treeBefore = await f.text();
  const otherBefore = await readFile(join(f.root, 'other.txt'));
  await assertCheckboxCommits(f, await f.confirm(), [['sample', 'A.1']]);
  assert.deepEqual(await readFile(join(f.root, '.git/index')), indexBefore);
  assert.equal(await f.git('diff', '--cached', f.baseline, '--', f.paths[0], 'other.txt'), stagedBefore);
  assert.equal(await f.text(), treeBefore.replace('[ ] A.1 ', '[x] A.1 '));
  assert.deepEqual(await readFile(join(f.root, 'other.txt')), otherBefore);
});

const conflictingEdits: [string, (f: Fixture) => Promise<void>][] = [
  ['description', async f => { await f.edit(openTasks.replace('A.1 Alpha', 'A.1 Renamed')); }],
  ['renumbered ID', async f => { await f.edit(openTasks.replace('A.1 Alpha', 'A.2 Alpha')); }],
  ['duplicate exact ID', async f => { await f.edit(openTasks + '- [ ] A.1 Alpha\n'); }],
  ['deleted ID', async f => { await f.edit(openTasks.replace('- [ ] A.1 Alpha\n', '')); }],
  ['uncommitted checkbox', async f => { await f.edit(openTasks.replace('[ ] A.1 ', '[x] A.1 ')); }],
  ['staged description', async f => { await f.edit(openTasks.replace('A.1 Alpha', 'A.1 Staged description')); await f.git('add', '--', f.paths[0]); await f.edit(openTasks); }],
  ['task absent in HEAD', async f => { await f.git('rm', '--', f.paths[0]); await f.git('commit', '-qm', 'remove old source'); await f.edit(openTasks); }],
];

for (const [name, edit] of conflictingEdits) {
  test('[checkbox-git] refuses ' + name + ' without committing or overwriting any data', async t => {
    const f = await gitFixture(t);
    await edit(f);
    const head = await f.git('rev-parse', 'HEAD');
    const text = await f.text();
    const index = await readFile(join(f.root, '.git/index'));
    const result = await f.confirm();
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.issues), /sample/u);
    assert.match(JSON.stringify(result.issues), /A\.1/u);
    assert.equal(await f.git('rev-parse', 'HEAD'), head);
    assert.equal(await f.text(), text);
    assert.deepEqual(await readFile(join(f.root, '.git/index')), index);
  });
}

test('[checkbox-git] changed description in the last change prevents all earlier writes', async t => {
  const f = await gitFixture(t, { first: ['B.2.1.a'], second: ['A.1'] });
  await f.edit(openTasks.replace('A.1 Alpha', 'A.1 A different task'), f.paths[1]);
  const result = await f.confirm();
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.issues), /second/u);
  assert.match(JSON.stringify(result.issues), /A\.1/u);
  assert.equal(await f.text(f.paths[0]), openTasks);
  assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline + '\n');
});

for (const mode of ['same-name replacement', 'symlink source', 'symlink tasks'] as const) {
  test('[checkbox-git] refuses ' + mode + ' before any write, including another valid change', async t => {
    const f = await gitFixture(t, { first: ['B.2.1'], sample: ['A.1'] });
    const source = join(f.root, 'openspec/changes/sample');
    const outside = join(f.root, 'untrusted-target');
    await mkdir(outside);
    await writeFile(join(outside, 'tasks.md'), openTasks);
    if (mode === 'symlink tasks') { await rm(join(source, 'tasks.md')); await symlink(join(outside, 'tasks.md'), join(source, 'tasks.md')); }
    else { await rename(source, source + '-original'); if (mode === 'symlink source') await symlink(outside, source); else { await mkdir(source); await writeFile(join(source, 'tasks.md'), openTasks); } }
    const result = await f.confirm();
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.issues), /sample/u);
    assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline + '\n');
    assert.equal(await f.text(f.paths[0]), openTasks);
    assert.equal(await readFile(join(outside, 'tasks.md'), 'utf8'), openTasks);
  });
}

test('[checkbox-git] report extension fields never choose paths, commands or extra assignments', async t => {
  const f = await gitFixture(t);
  const sentinel = join(f.root, 'sentinel');
  await writeFile(sentinel, 'unchanged');
  const report = { ...f.report, root: sentinel, tasksPath: sentinel, command: 'touch ' + sentinel, changesPath: '../outside', assignment: { changes: [{ id: 'other', items: ['A.10'] }] } };
  await assertCheckboxCommits(f, await f.confirm(report), [['sample', 'A.1']]);
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
});

test('[checkbox-git] committed exact checkbox is accepted without an empty commit', async t => {
  const f = await gitFixture(t);
  await f.edit(openTasks.replace('[ ] A.1 ', '[x] A.1 '));
  await f.git('add', '--', f.paths[0]);
  await f.git('commit', '-qm', 'executor previously completed exact item');
  const head = await f.git('rev-parse', 'HEAD');
  assert.equal((await f.confirm()).ok, true);
  assert.equal(await f.git('rev-parse', 'HEAD'), head);
});

test('[checkbox-git] unrelated concurrent HEAD is retained as an ancestor of the checkbox commit', async t => {
  const f = await gitFixture(t);
  let foreignHead = '';
  f.setCheckpoint(async phase => {
    if (phase !== 'before-ref-update' || foreignHead) return;
    await writeFile(join(f.root, 'foreign.txt'), 'concurrent author\n');
    await f.git('add', '--', 'foreign.txt');
    await f.git('commit', '-qm', 'concurrent author');
    foreignHead = (await f.git('rev-parse', 'HEAD')).trim();
  });
  const result = await f.confirm();
  assert.equal(result.ok, true);
  assert.ok(foreignHead, 'race was exercised');
  await f.git('merge-base', '--is-ancestor', foreignHead, 'HEAD');
  assert.equal(await f.git('show', 'HEAD:foreign.txt'), 'concurrent author\n');
  assert.equal((await f.git('rev-list', f.baseline + '..HEAD')).trim().split('\n').length, 2);
});

test('[checkbox-git] file changed before write is reread and foreign evidence survives', async t => {
  const f = await gitFixture(t);
  let changed = false;
  f.setCheckpoint(async phase => { if (phase === 'before-write' && !changed) { changed = true; await f.edit((await f.text()) + '  - concurrent evidence\n'); } });
  const result = await f.confirm();
  assert.ok(changed);
  assert.equal(result.ok, true);
  assert.equal(await f.text(), openTasks.replace('[ ] A.1 ', '[x] A.1 ') + '  - concurrent evidence\n');
  await assertCheckboxCommits(f, result, [['sample', 'A.1']]);
});

test('[checkbox-git] assigned line changed before write is a diagnosed conflict', async t => {
  const f = await gitFixture(t);
  f.setCheckpoint(async phase => { if (phase === 'before-write') await f.edit(openTasks.replace('A.1 Alpha', 'A.1 Changed during read')); });
  const result = await f.confirm();
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.issues), /A\.1/u);
  assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline + '\n');
  assert.ok((await f.text()).includes('Changed during read'));
});

test('[checkbox-git] foreign index.lock is waited for and never deleted', async t => {
  const f = await gitFixture(t);
  const lock = join(f.root, '.git/index.lock');
  await writeFile(lock, 'owned-by-other-writer');
  let waited = false;
  f.ports.waitForIndex = async () => { assert.equal(await readFile(lock, 'utf8'), 'owned-by-other-writer'); waited = true; await rm(lock); };
  const result = await f.confirm();
  assert.equal(waited, true, 'must use the existing wait policy rather than unlinking another writer lock');
  await assertCheckboxCommits(f, result, [['sample', 'A.1']]);
});

test('[checkbox-git] concurrent different items serialize without losing either author', async t => {
  const f = await gitFixture(t);
  const second = requestFor(assignment(f.root, { sample: ['B.2.1'] }), 'second-run');
  const secondJournal: TaskCheckboxOperation[] = [];
  const secondPorts: TaskCheckboxPorts = {
    ...f.ports,
    verifySourceIdentity: async () => ok,
    verifyAssignmentCompletion: async () => ok,
    operations: { read: async () => secondJournal, write: async (_run, values) => { secondJournal.splice(0, secondJournal.length, ...values); } },
  };
  let both!: TaskCheckboxConfirmation[];
  await assert.doesNotReject(async () => { both = await Promise.all([prepareReportedTaskCheckboxes(f.request, f.report, f.ports), prepareReportedTaskCheckboxes(second, reportFor(second.assignment), secondPorts)]); });
  assert.ok(both.every(result => result.ok), JSON.stringify(both));
  assert.equal(await f.text(), openTasks.replace('[ ] A.1 ', '[x] A.1 ').replace('[ ] B.2.1 ', '[x] B.2.1 '));
  assert.equal((await f.git('rev-list', f.baseline + '..HEAD')).trim().split('\n').length, 2);
  for (const confirmation of both) {
    assert.equal(confirmation.commits.length, 1);
    const diff = await f.git('show', '--format=', '--numstat', confirmation.commits[0].sha);
    assert.equal(diff.trim(), '1\t1\t' + f.paths[0]);
  }
});

for (const phase of ['after-write', 'after-commit', 'after-verification'] as TaskCheckboxCheckpoint[]) {
  test('[checkbox-git] durable recovery after ' + phase + ' never duplicates a commit', async t => {
    const f = await gitFixture(t);
    let crashed = false;
    f.setCheckpoint(async received => { if (received === phase && !crashed) { crashed = true; throw new Error('simulated crash at ' + phase); } });
    await assert.rejects(prepareReportedTaskCheckboxes(f.request, f.report, f.ports), /simulated crash/u);
    assert.equal(crashed, true);
    const serialized = JSON.stringify(await f.ports.operations.read(f.request.runId));
    assert.ok(JSON.parse(serialized).length > 0, 'recovery provenance must be durable before writing');
    f.setCheckpoint(async () => {});
    const restartedPorts: TaskCheckboxPorts = { ...f.ports, operations: { ...f.ports.operations, read: async () => JSON.parse(serialized) } };
    let recovered!: TaskCheckboxConfirmation;
    await assert.doesNotReject(async () => { recovered = await prepareReportedTaskCheckboxes(f.request, f.report, restartedPorts); });
    await assertCheckboxCommits(f, recovered, [['sample', 'A.1']]);
    const head = await f.git('rev-parse', 'HEAD');
    assert.equal((await f.confirm()).ok, true);
    assert.equal(await f.git('rev-parse', 'HEAD'), head);
  });
}

test('[checkbox-git] later commit failure keeps earlier progress and retry completes only the remaining item', async t => {
  const f = await gitFixture(t, { sample: ['A.1', 'B.2.1'] });
  let failed = false;
  f.setCheckpoint(async (phase, item) => { if (phase === 'before-write' && item?.item === 'B.2.1' && !failed) { failed = true; throw new Error('Git write refused for sample:B.2.1'); } });
  await assert.rejects(prepareReportedTaskCheckboxes(f.request, f.report, f.ports), /Git write refused/u);
  assert.equal(failed, true);
  assert.equal((await f.git('rev-list', f.baseline + '..HEAD')).trim().split('\n').length, 1);
  assert.ok((await f.text()).includes('[x] A.1 Alpha'));
  f.setCheckpoint(async () => {});
  await assertCheckboxCommits(f, await f.confirm(), [['sample', 'A.1'], ['sample', 'B.2.1']]);
});

test('[checkbox-git] Git command refusal cannot produce a successful confirmation', async t => {
  const f = await gitFixture(t);
  const index = await readFile(join(f.root, '.git/index'));
  const commands: readonly string[][] = [];
  f.ports.executeGit = async args => { (commands as string[][]).push([...args]); return { code: 1, stdout: '', stderr: 'Git unavailable for sample:A.1' }; };
  let accepted = false;
  try { accepted = (await prepareReportedTaskCheckboxes(f.request, f.report, f.ports)).ok; } catch (error) { assert.match(String(error), /Git unavailable/u); }
  assert.equal(accepted, false);
  assert.ok(commands.length > 0);
  assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline + '\n');
  assert.equal(await f.text(), openTasks);
  assert.deepEqual(await readFile(join(f.root, '.git/index')), index);
});

test('[checkbox-git] OpenSpec refusal preserves checkbox commits and retry verifies without new commits', async t => {
  const f = await gitFixture(t);
  const verify = f.ports.verifyAssignmentCompletion;
  f.ports.verifyAssignmentCompletion = async () => issue('sample', 'A.1', 'OpenSpec unavailable');
  const first = await f.confirm();
  assert.equal(first.ok, false);
  assert.ok((await f.text()).includes('[x] A.1 Alpha'));
  const head = await f.git('rev-parse', 'HEAD');
  f.ports.verifyAssignmentCompletion = verify;
  assert.equal((await f.confirm()).ok, true);
  assert.equal(await f.git('rev-parse', 'HEAD'), head);
});

for (const skipSpecs of [false, true]) {
  test('[checkbox-archive] last item waits for executor archive, skip_specs=' + skipSpecs, async t => {
    const f = await gitFixture(t, { sample: ['A.1'] }, '# Tasks\n\n- [ ] A.1 Alpha\n');
    const source = join(f.root, 'openspec/changes/sample');
    await writeFile(join(source, '.openspec.yaml'), 'skip_specs: ' + skipSpecs + '\n');
    const first = await f.confirm();
    assert.equal(first.ok, true);
    assert.equal(first.awaitingArchive, true);
    assert.equal(first.commits.length, 1);
    const h = readerHarness(f.snapshot);
    h.ports.confirmTaskCheckboxes = async () => first;
    assert.equal(await readPendingAgentReport(h.request, h.ports), null);
    const archive = '2026-10-23-sample';
    await mkdir(join(f.root, 'openspec/changes/archive'), { recursive: true });
    await rename(source, join(f.root, 'openspec/changes/archive', archive));
    const final: AgentReport = { ...f.report, changes: f.report.changes.map(change => ({ ...change, archive })), commits: ['executor-owned-commit', 'executor-sync-archive-commit'] };
    const head = await f.git('rev-parse', 'HEAD');
    const confirmed = await f.confirm(final);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.awaitingArchive, false);
    assert.equal(await f.git('rev-parse', 'HEAD'), head);
    assert.deepEqual(final.commits, ['executor-owned-commit', 'executor-sync-archive-commit']);
    h.setRaw(JSON.stringify(final));
    h.ports.confirmTaskCheckboxes = async () => confirmed;
    const accepted = await readPendingAgentReport(h.request, h.ports);
    assert.equal(accepted?.status, 'succeeded');
    assert.equal(accepted?.report?.changes[0].archive, archive);
  });
}

for (const failure of ['old archive', 'incomplete archive', 'missing active source'] as const) {
  test('[checkbox-archive] ' + failure + ' cannot replace a new exact archive', async t => {
    const f = await gitFixture(t, { sample: ['A.1'] }, '- [ ] A.1 Alpha\n');
    assert.equal((await f.confirm()).awaitingArchive, true);
    const archive = failure === 'old archive' ? f.snapshot.baselineArchives[0] : '2026-10-23-sample';
    const path = join(f.root, 'openspec/changes/archive', archive);
    const source = join(f.root, 'openspec/changes/sample');
    if (failure === 'incomplete archive') {
      await mkdir(dirname(path), { recursive: true });
      await rename(source, path);
      await writeFile(join(path, 'tasks.md'), '- [x] A.1 Alpha\n- [ ] C.1 Other owner\n');
    } else {
      if (failure === 'old archive') { await mkdir(path, { recursive: true }); await writeFile(join(path, 'tasks.md'), '- [x] A.1 Alpha\n'); }
      await rm(source, { recursive: true });
    }
    const final = { ...f.report, changes: f.report.changes.map(change => ({ ...change, archive })) };
    const head = await f.git('rev-parse', 'HEAD');
    assert.equal((await f.confirm(final)).ok, false);
    assert.equal(await f.git('rev-parse', 'HEAD'), head);
  });
}

for (const stage of ['spec', 'design', 'implement']) {
  test('[checkbox-brief] ' + stage + ' assigns commits and evidence to executor and exact checkboxes to raf', async () => {
    const root = new URL('../../', import.meta.url).pathname.replace(/\/$/u, '');
    const snapshot = assignment(root);
    const context: Parameters<typeof composeAssignmentBrief>[1] & { cwd: string } = { cwd: join(root, 'raf-develop'), briefsRoot: join(root, 'conf/briefs'), runner: 'codex', stage, project: 'raf', agentId: 'checkbox-author', sessionName: 'checkbox-author', features: ['sample'], phase: stage, outcome: 'sample:A.1', writeBoundaries: ['/fixture/result'], sources: [], reportPath: '/fixture/tmp/run/checkbox-author.json', reportSchema: { type: 'object' }, commitOwnWork: true, commitPaths: ['/fixture/result'], commitRepositories: [root], workspaceWritable: false };
    const brief = await composeAssignmentBrief(snapshot, context, { readText: path => readFile(path, 'utf8') });
    assert.match(brief, /[Rr]af.{0,100}(галоч|checkbox)/u);
    assert.match(brief, /sync\/archive/u);
    assert.match(brief, /skip_specs/u);
    assert.ok(brief.includes('/fixture/result'));
    assert.doesNotMatch(brief, /Онови галочки доручених пунктів|коміти[\s\S]{0,40}власн[\s\S]{0,20}галоч/u);
  });
}
