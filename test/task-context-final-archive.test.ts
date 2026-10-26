import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deriveTaskContext, bindWorkspaceBoundaries, type TaskContextConfiguration } from '../src/task-context.ts';
import type { RuntimeRunParameters } from '../src/app-runtime.ts';
import { verifyAssignmentCompletion, type AssignmentSnapshot } from '../src/assignment.ts';
import { readPendingAgentReport, type AgentReport } from '../src/agent-report.ts';

const configuration: TaskContextConfiguration = {
  projects: { profiles: { raf: { development: 'develop' } }, projects: {
    raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } },
  } },
  reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }], resources: {},
};

async function fixture(t: TestContext, tasks = '- [x] 1.1 Earlier work\n- [ ] 7.2 Finish change\n') {
  const root = await mkdtemp(join(tmpdir(), 'raf-z412-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const change = 'finish-demo';
  const directory = join(root, 'openspec/changes', change);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'tasks.md'), tasks);
  const assignment: AssignmentSnapshot = {
    root, baselineArchives: [], changes: [{ id: change, items: [{ id: '7.2', description: 'Finish change' }] }],
  };
  const parameters: RuntimeRunParameters = {
    id: 'last-executor', type: 'design', phase: 'design', project: 'raf', features: [change],
    complexity: 'low', tasks: [`${change}:7.2`],
  };
  const derive = (params = parameters, snapshot = assignment) => deriveTaskContext({ root, parameters: params, assignment: snapshot, configuration });
  const put = async (path: string, text = '## ADDED Requirements\n') => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const delta = (capability: string) => put(join(directory, 'specs', capability, 'spec.md'));
  const original = [directory, join(root, 'questions/projects/raf/questions.md')];
  return { root, change, directory, parameters, assignment, derive, put, delta, original };
}

function writable(boundaries: readonly string[], path: string): boolean {
  return boundaries.some(boundary => {
    const suffix = relative(resolve(boundary), path);
    return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
  });
}

function assertFinalScope(f: Awaited<ReturnType<typeof fixture>>, boundaries: readonly string[], capabilities: string[]) {
  const expected = [join(f.root, 'openspec/changes'), ...capabilities.map(id => join(f.root, 'openspec/specs', id)), f.original[1]];
  assert.deepEqual(boundaries.map(path => resolve(path)).sort(), expected.sort(), 'only the necessary move parent and this change\'s sync targets are granted');
  assert.ok(writable(boundaries, join(f.root, 'openspec/changes/archive/.openspec-archive.lock')));
  assert.ok(writable(boundaries, join(f.root, 'openspec/changes/archive/2026-10-25-finish-demo/tasks.md')));
  for (const denied of ['conf/flow.json', 'openspec/config.yaml', 'openspec/specs/unrelated/spec.md', 'questions/projects/other/questions.md', 'raf-develop/source.ts']) {
    assert.equal(writable(boundaries, join(f.root, denied)), false, denied);
  }
  assert.equal(boundaries.some(path => resolve(path) === f.directory), false, 'do not mount the moved source separately under its writable parent');
}

for (const type of ['spec', 'design', 'implement', 'qa', 'hotfix']) {
  test(`Z412 last ${type} executor receives archive move scope and only its delta sync directories`, async t => {
    const f = await fixture(t);
    await f.delta('projects/raf/demo');
    await f.delta('core/demo');
    await f.put(join(f.directory, 'specs/ignored.txt'));
    const context = await f.derive({ ...f.parameters, type, phase: type });
    if (type === 'spec') assert.deepEqual(context.writeBoundaries, [join(f.root, 'openspec'), join(f.root, 'conf/briefs'), f.original[1]]);
    else assertFinalScope(f, context.writeBoundaries, ['projects/raf/demo', 'core/demo']);
    assert.equal(context.workspaceWritable, !['spec', 'design'].includes(type));
    const bound = bindWorkspaceBoundaries(context, join(f.root, `raf-${context.branch}`));
    assert.equal(writable(bound, join(f.root, `raf-${context.branch}/source.ts`)), context.workspaceWritable);
    assert.equal(writable(bound, join(f.root, 'conf/projects.json')), false);
  });
}

for (const tasks of [
  '- [ ] 7.2 Finish change\n- [ ] 7.3 Someone else\n',
  '- [ ] 7.2 Finish change\n  - [ ] 7.2.1 Unselected child\n',
  '- [ ] 7.2 Finish change\n  - [ ] Unnumbered remaining action\n',
  '- [ ] 7.2 Finish change\n* [ ] 7.3 Someone else\n',
  '- [ ] 7.2 Finish change\n+ [ ] 7.3 Someone else\n',
  '- [ ] 7.2 Finish change\n1. [ ] 7.3 Someone else\n',
  '- [ ] 7.2 Finish change\n2) [~] 7.3 Someone else\n',
  '- [ ] 7.2 Finish change\n- [] 7.3 Someone else\n',
  '- [ ] 7.2 Finish change\n- [~] 7.3 Someone else\n',
]) {
  test(`Z412 nonfinal selection keeps exactly its existing boundaries: ${tasks.trim().split('\n').at(-1)}`, async t => {
    const f = await fixture(t, tasks);
    await f.delta('projects/raf/demo');
    assert.deepEqual((await f.derive()).writeBoundaries, f.original);
  });
}

test('Z412 all remaining selected IDs qualify together, including uppercase checked rows and CRLF', async t => {
  const f = await fixture(t, '- [X] 1.1 Earlier work\r\n- [ ] 7.1 First finish\r\n- [ ] 7.2 Finish change\r\n');
  const assignment: AssignmentSnapshot = { ...f.assignment, changes: [{ id: f.change, items: [...f.assignment.changes[0].items, { id: '7.1', description: 'First finish' }] }] };
  const context = await f.derive({ ...f.parameters, tasks: [`${f.change}:7.1`, `${f.change}:7.2`] }, assignment);
  assertFinalScope(f, context.writeBoundaries, []);
});

test('Z412 completed tasks outside the selection do not require permission to execute them', async t => {
  const f = await fixture(t);
  await f.put(join(f.directory, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  assertFinalScope(f, (await f.derive()).writeBoundaries, []);
});

test('Z412 OpenSpec ordinal IDs also identify an unnumbered final checkbox', async t => {
  const f = await fixture(t, '* [ x ] Earlier work\n+ [] Finish change\n');
  const assignment: AssignmentSnapshot = { ...f.assignment, changes: [{ id: f.change, items: [{ id: '2', description: 'Finish change' }] }] };
  assertFinalScope(f, (await f.derive({ ...f.parameters, tasks: [`${f.change}:2`] }, assignment)).writeBoundaries, []);
});

test('Z412 multiple changes grant sync only for the final change', async t => {
  const f = await fixture(t);
  await f.delta('projects/raf/final');
  await f.put(join(f.root, 'openspec/changes/other/tasks.md'), '- [ ] 1.1 Selected\n- [ ] 1.2 Still open\n');
  await f.put(join(f.root, 'openspec/changes/other/specs/projects/raf/other/spec.md'));
  const assignment: AssignmentSnapshot = { ...f.assignment, changes: [...f.assignment.changes, { id: 'other', items: [{ id: '1.1', description: 'Selected' }] }] };
  const context = await f.derive({ ...f.parameters, tasks: [...f.parameters.tasks, 'other:1.1'] }, assignment);
  assertFinalScope(f, context.writeBoundaries, ['projects/raf/final']);
  assert.equal(writable(context.writeBoundaries, join(f.root, 'openspec/specs/projects/raf/other/spec.md')), false);
});

test('Z412 unknown or changed task rows do not widen scope', async t => {
  const f = await fixture(t, '- [ ] 7.2 Changed description\n');
  assert.deepEqual((await f.derive()).writeBoundaries, f.original);
  await rm(join(f.directory, 'tasks.md'));
  assert.deepEqual((await f.derive()).writeBoundaries, f.original);
});

for (const kind of ['delta', 'target']) {
  test(`Z412 a symlinked ${kind} cannot grant writes to another capability`, async t => {
    const f = await fixture(t);
    const outside = join(f.root, 'foreign');
    await f.put(join(outside, 'spec.md'));
    if (kind === 'delta') await symlink(outside, join(f.directory, 'specs'));
    else {
      await f.delta('projects/raf/demo');
      await mkdir(join(f.root, 'openspec/specs/projects/raf'), { recursive: true });
      await symlink(outside, join(f.root, 'openspec/specs/projects/raf/demo'));
    }
    await assert.rejects(f.derive(), /symlink|symbolic|scope/i);
  });
}

test('Z412 last executor can publish the exact archived report after checkbox confirmation', async t => {
  const f = await fixture(t);
  await f.delta('projects/raf/demo');
  const context = await f.derive();
  assertFinalScope(f, context.writeBoundaries, ['projects/raf/demo']);
  const archive = `2026-10-25-${f.change}`;
  const archivedTasks = join(f.root, 'openspec/changes/archive', archive, 'tasks.md');
  const syncTarget = join(f.root, 'openspec/specs/projects/raf/demo/spec.md');
  let report: AgentReport = { status: 'succeeded', answer: 'Finished', commits: [], changes: [{ id: f.change, items: [{ id: '7.2', status: 'succeeded' }] }] };
  const diagnostics: string[] = [];
  const ports: Parameters<typeof readPendingAgentReport>[1] = {
    fs: { readText: async () => JSON.stringify(report) },
    now: () => '2026-10-25T00:00:00Z', diagnostic: async reason => { diagnostics.push(reason); },
    confirmTaskCheckboxes: async () => ({ ok: true, issues: [], commits: [] }),
    verifyAssignmentCompletion: (snapshot, claims) => verifyAssignmentCompletion(snapshot, {
      cli: { exec: async args => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ changes: args.includes('--archived') ? [{ name: archive, totalTasks: 2, completedTasks: 2 }] : [] }) }) },
      fs: { readText: path => readFile(path, 'utf8') },
    }, claims),
  };
  const request = { tmpRoot: join(f.root, 'run'), runId: 'z412', address: 'last-executor', assignment: f.assignment };
  for (const path of [archivedTasks, syncTarget]) assert.ok(writable(context.writeBoundaries, path), path);
  await f.put(archivedTasks, '- [x] 1.1 Earlier work\n- [x] 7.2 Finish change\n');
  await f.put(syncTarget, '# Synchronized requirements\n');
  await rm(f.directory, { recursive: true });
  report = { ...report, changes: [{ ...report.changes[0], archive }] };
  const result = await readPendingAgentReport(request, ports);
  assert.equal(result?.event, 'agent.succeeded');
  assert.equal(result?.report?.changes[0].archive, archive);
});
