import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateAssignment, verifyAssignmentCompletion, type AssignmentPorts, type AssignmentSnapshot } from '../src/assignment.ts';

const names = ['.git', '.codex', '.agents', '.aws'];
const change = { name: 'valid-change', completedTasks: 0, totalTasks: 2 };
const selection = [{ change: change.name, items: [{ id: 'Z.413', expectedDescription: 'Fix list parsing' }] }];
const placeholders = names.map(name => ({ name, completedTasks: 0, totalTasks: 0 }));

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'raf-z413-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'openspec', 'changes');
  const archive = join(directory, 'archive');
  await mkdir(archive, { recursive: true });
  for (const parent of [directory, archive]) for (const name of names) await mkdir(join(parent, name));
  const state = { active: [change, ...placeholders], archived: [...placeholders], done: false };
  const ports: AssignmentPorts = {
    cli: { async exec(args, cwd) {
      assert.equal(cwd, root);
      let data: unknown;
      if (args[0] === 'list') data = { changes: args.includes('--archived') ? state.archived : state.active };
      else {
        assert.deepEqual(args, ['instructions', 'apply', '--change', change.name, '--json']);
        data = { tasks: [{ id: 'Z.413', description: 'Fix list parsing', done: state.done }] };
      }
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: '' };
    } },
    fs: { async readText(path) { throw new Error(`Unexpected read: ${path}`); } },
  };
  const snapshot: AssignmentSnapshot = { root, changes: [{ id: change.name, items: [{ id: 'Z.413', description: 'Fix list parsing' }] }], baselineArchives: [] };
  return { root, directory, archive, state, ports, snapshot };
}

test('Z413 selection ignores only empty sandbox mountpoints beside real active and archived changes', async t => {
  const f = await fixture(t);
  f.state.archived.unshift({ name: '2026-10-24-older-change', completedTasks: 2, totalTasks: 2 });
  const result = await validateAssignment({ root: f.root, selections: selection }, f.ports);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.changes, f.snapshot.changes);
  assert.deepEqual(result.snapshot.baselineArchives, ['2026-10-24-older-change']);
  assert.deepEqual(f.state.active, [change, ...placeholders]);
});

test('Z413 completion accepts the confirmed checkbox despite concurrent sandbox mountpoints', async t => {
  const f = await fixture(t);
  f.state.done = true;
  const result = await verifyAssignmentCompletion(f.snapshot, f.ports);
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('Z413 mountpoints never confirm an open checkbox', async t => {
  const f = await fixture(t);
  const result = await verifyAssignmentCompletion(f.snapshot, f.ports);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].reason, /Z\.413.*відкритий/);
});

const malformedRows = [
  null,
  { completedTasks: 0, totalTasks: 0 },
  { name: '../escape', completedTasks: 0, totalTasks: 0 },
  { name: 'bad/name', completedTasks: 0, totalTasks: 0 },
  { name: 'real-change', totalTasks: 2 },
  { name: 'real-change', completedTasks: 0 },
  { name: 'real-change', completedTasks: 2, totalTasks: 1 },
  { name: 'real-change', completedTasks: -1, totalTasks: 0 },
  { name: 'real-change', completedTasks: 0, totalTasks: '0' },
];

for (const [index, row] of malformedRows.entries()) test(`Z413 malformed row ${index + 1} still refuses selection and checkbox confirmation`, async t => {
  const f = await fixture(t);
  f.state.active.push(row as typeof change);
  const result = await validateAssignment({ root: f.root, selections: selection }, f.ports);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'openspec-unavailable');
  assert.equal(result.issues[0].reason, 'OpenSpec list: malformed changes');
  f.state.done = true;
  const completion = await verifyAssignmentCompletion(f.snapshot, f.ports);
  assert.equal(completion.ok, false);
  assert.equal(completion.issues[0].reason, 'OpenSpec list: malformed changes');
});

const dotRows = [
  { name: '.claude', completedTasks: 0, totalTasks: 0 },
  { name: '.actual-change', completedTasks: 0, totalTasks: 0 },
  ...[...names, '.claude'].flatMap(name => [
    { name },
    { name, completedTasks: 0 },
    { name, totalTasks: 0 },
    { name, completedTasks: 0, totalTasks: 1 },
    { name, completedTasks: 1, totalTasks: 1 },
  ]),
];

for (const [index, row] of dotRows.entries()) test(`dot-entries row ${index + 1} named on a dot is skipped for selection and checkbox confirmation`, async t => {
  const f = await fixture(t);
  f.state.active.push(row as typeof change);
  f.state.archived.push(row as typeof change);
  const result = await validateAssignment({ root: f.root, selections: selection }, f.ports);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.deepEqual(result.snapshot.changes, f.snapshot.changes);
  f.state.done = true;
  assert.deepEqual(await verifyAssignmentCompletion(f.snapshot, f.ports), { ok: true, issues: [] });
});

test('dot-entries non-empty sandbox .claude beside real active and archived changes yields the changes', async t => {
  const f = await fixture(t);
  for (const parent of [f.directory, f.archive]) {
    await mkdir(join(parent, '.claude', '.cc-writes'), { recursive: true });
    await writeFile(join(parent, '.claude', '.cc-writes', 'marker'), 'sandbox');
  }
  const claude = { name: '.claude', completedTasks: 0, totalTasks: 0 };
  f.state.active.push(claude);
  f.state.archived.push(claude, { name: '2026-10-24-older-change', completedTasks: 2, totalTasks: 2 });
  const result = await validateAssignment({ root: f.root, selections: selection }, f.ports);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.changes, f.snapshot.changes);
  assert.deepEqual(result.snapshot.baselineArchives, ['2026-10-24-older-change']);
  f.state.done = true;
  assert.deepEqual(await verifyAssignmentCompletion(result.snapshot, f.ports), { ok: true, issues: [] });
});

for (const name of names) for (const mode of ['nonempty', 'missing', 'file', 'symlink'] as const) test(`dot-entries ${name} ${mode} is skipped like any dot-named entry`, async t => {
  const f = await fixture(t);
  const path = join(f.directory, name);
  if (mode === 'nonempty') await writeFile(join(path, 'proposal.md'), 'A real change');
  else {
    await rm(path, { recursive: true });
    if (mode === 'file') await writeFile(path, 'not a directory');
    if (mode === 'symlink') {
      const target = join(f.root, 'empty-target');
      await mkdir(target);
      await symlink(target, path);
    }
  }
  const result = await validateAssignment({ root: f.root, selections: selection }, f.ports);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.deepEqual(result.snapshot.changes, f.snapshot.changes);
});

test('Z413 duplicate real changes remain ambiguous alongside placeholders', async t => {
  const f = await fixture(t);
  f.state.active.push({ ...change });
  const result = await validateAssignment({ root: f.root, selections: selection }, f.ports);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0].reason, 'OpenSpec list: ambiguous duplicate changes');
});
