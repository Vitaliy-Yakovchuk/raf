import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readAssignmentTasks, validateAssignment, verifyAssignmentCompletion, type AssignmentPorts } from '../src/assignment.ts';
import { createAssignmentIdentityAdapter } from '../src/assignment-identity.ts';
import { executeCommand } from '../src/os-runtime.ts';

const items = [
  { id: '2.1', description: 'Зберегти числовий пункт' },
  { id: 'C.1', description: '[spec] Зберегти точний контекст' },
  { id: 'R.3', description: 'Зберегти початкове доручення' },
];
const body = (done = false) => '## QA\n\n' + items.map(item => `- [${done ? 'x' : ' '}] ${item.id} ${item.description}\n`).join('');

function synthetic(rows: unknown[]): AssignmentPorts {
  return {
    cli: { async exec(args) {
      const data = args[0] === 'instructions' ? { tasks: rows } : { changes: args.includes('--archived') ? [] : [{ name: 'identity-qa', completedTasks: 0, totalTasks: rows.length }] };
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: '' };
    } },
    fs: { async readText() { throw new Error('Unexpected file read'); } },
  };
}

async function fixture(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'raf-identity-qa-')));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await assert.rejects(lstat(home), { code: 'ENOENT' });
    t.diagnostic(`Own fixture cleaned: ${home}`);
  });
  const root = join(home, 'project');
  const change = 'identity-qa';
  const dir = join(root, 'openspec', 'changes', change);
  const archive = join(root, 'openspec', 'changes', 'archive');
  await mkdir(archive, { recursive: true });
  await mkdir(dir);
  await writeFile(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await writeFile(join(dir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-22\nskip_specs: true\n');
  await writeFile(join(dir, 'proposal.md'), '# QA fixture\n\n## Why\nVerify original task identity.\n\n## What Changes\nInternal QA fixture.\n\n## Impact\nNo public API.\n');
  await writeFile(join(dir, 'design.md'), '# Design\n\nInitial independent artifact.\n');
  await writeFile(join(dir, 'tasks.md'), body());
  const ports: AssignmentPorts = {
    cli: { exec: (args, cwd) => executeCommand({ executable: 'openspec', args, cwd }) },
    fs: { readText: path => readFile(path, 'utf8') },
  };
  return { home, root, change, dir, archive, ports };
}

test('[identity-qa-parser] existing numeric and symbolic labels normalize only ordinal IDs', async () => {
  const rows = items.map((item, index) => ({ id: String(index + 1), description: `${item.id} ${item.description}`, done: false }));
  assert.deepEqual(await readAssignmentTasks('/work/project', 'identity-qa', synthetic(rows)), items.map(item => ({ ...item, done: false })));
  const native = [
    { id: 'R.3', description: 'C.1 Native description stays exact', done: false },
    { id: 'native-task', description: '2.1 Another exact native description', done: true },
    { id: '9', description: 'R.3 Nonordinal native ID', done: false },
  ];
  assert.deepEqual(await readAssignmentTasks('/work/project', 'identity-qa', synthetic(native)), native);
});

test('[identity-qa-parser] normalized duplicates remain ambiguous and unrecognized aliases stay invalid', async () => {
  const rows = [
    { id: '1', description: 'R.3 Original description', done: false },
    { id: 'R.3', description: 'Original description', done: false },
  ];
  const duplicate = await validateAssignment({ root: '/work/project', selections: [{ change: 'identity-qa', items: [{ id: 'R.3' }] }] }, synthetic(rows));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.issues[0].foundItems.filter(item => item.id === 'R.3').length, 2);
  for (const label of ['R', 'r.3', 'R-3', 'R.3.', 'R.3.1', 'Stage.3']) {
    const result = await validateAssignment({ root: '/work/project', selections: [{ change: 'identity-qa', items: [{ id: label }] }] }, synthetic([{ id: '1', description: 'R.3 Original description', done: false }]));
    assert.equal(result.ok, false, label);
  }
});

test('[identity-qa-live] actual ordinal task labels retain exact identity through completion archive and name reuse', async t => {
  const f = await fixture(t);
  const version = await f.ports.cli.exec(['--version'], f.root);
  assert.equal(version.exitCode, 0);
  assert.equal(version.stdout.trim(), '1.14.3');
  const fs = await statfs(f.root, { bigint: true });
  assert.ok(platform() === 'darwin' && fs.type === 26n || platform() === 'linux' && [0xEF53n, 0x01021994n].includes(fs.type),
    `Live identity requires a supported local filesystem: ${platform()}:0x${fs.type.toString(16)}`);
  t.diagnostic(JSON.stringify({ node: process.version, platform: platform(), release: release(), openspec: version.stdout.trim(), fsType: String(fs.type) }));
  const actual = await f.ports.cli.exec(['instructions', 'apply', '--change', f.change, '--json'], f.root);
  assert.equal(actual.exitCode, 0, actual.stderr);
  const raw = JSON.parse(actual.stdout).tasks;
  assert.deepEqual(raw.map(({ id, description, done }) => ({ id, description, done })), items.map((item, index) => ({ id: String(index + 1), description: `${item.id} ${item.description}`, done: false })));
  assert.ok(raw.every((task, index) => task.sourcePath === join(f.dir, 'tasks.md') && task.line === index + 3));
  t.diagnostic(`Actual installed OpenSpec tasks: ${JSON.stringify(raw)}`);
  const validation = await validateAssignment({ root: f.root, selections: [{ change: f.change, items: items.map(item => ({ id: item.id, expectedDescription: item.description })) }] }, f.ports);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  if (!validation.ok) return;
  assert.deepEqual(validation.snapshot.changes[0].items, items);
  const original = await lstat(f.dir, { bigint: true });
  const tuple = (stat: typeof original) => [stat.dev, stat.ino, stat.birthtimeNs].map(String);
  assert.ok(original.birthtimeNs > 0n);
  const adapter = createAssignmentIdentityAdapter({ raf: f.root });
  const captured = await adapter.capture('raf', validation.snapshot);
  const serialized = JSON.parse(JSON.stringify(captured));
  for (const value of [captured, ...captured.flatMap(task => [task, task.key])]) assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(captured.map(task => task.key.taskId), items.map(item => item.id));
  const expect = async (state: string, location: string) => assert.deepEqual(await createAssignmentIdentityAdapter({ raf: f.root }).resolveTasks(serialized), serialized.map(task => ({ state, task, location })));
  await writeFile(join(f.dir, 'design.md'), '# Design\n\nIndependent assigned artifact edit.\n');
  await expect('open', 'active');
  assert.deepEqual(await adapter.capture('raf', validation.snapshot), captured);
  await writeFile(join(f.dir, 'tasks.md'), body(true));
  assert.equal((await verifyAssignmentCompletion(validation.snapshot, f.ports)).ok, true);
  await expect('completed', 'active');
  const archived = await f.ports.cli.exec(['archive', f.change, '--yes', '--skip-specs', '--json'], f.root);
  assert.equal(archived.exitCode, 0, archived.stderr);
  t.diagnostic(`Actual archive: ${archived.stdout.trim()}`);
  const names = await readdir(f.archive);
  assert.equal(names.length, 1);
  const archivedDir = join(f.archive, names[0]);
  assert.deepEqual(tuple(await lstat(archivedDir, { bigint: true })), tuple(original));
  await cp(archivedDir, f.dir, { recursive: true, preserveTimestamps: true });
  assert.notDeepEqual(tuple(await lstat(f.dir, { bigint: true })), tuple(original));
  await expect('completed', 'archive');
  await rename(archivedDir, join(f.home, 'original-outside-source'));
  await cp(f.dir, archivedDir, { recursive: true, preserveTimestamps: true });
  for (const result of await adapter.resolveTasks(serialized)) assert.equal(result.state, 'mismatch');
  assert.deepEqual(captured, serialized);
  t.diagnostic(`Original tuple preserved by archive and rejected after byte-identical source replacement: ${JSON.stringify(tuple(original))}`);
});

test('[identity-qa-live] default source guards reject symlinks and unverified schema without support claims', async t => {
  const f = await fixture(t);
  const assignment = { root: f.root, changes: [{ id: f.change, items: [items[0]] }], baselineArchives: [] };
  const adapter = createAssignmentIdentityAdapter({ raf: f.root });
  const captured = await adapter.capture('raf', assignment);
  const tasks = join(f.dir, 'tasks.md');
  const outside = join(f.home, 'external-tasks.md');
  await rename(tasks, outside);
  await symlink(outside, tasks);
  const linked = await adapter.resolveTasks(captured);
  assert.equal(linked[0].state, 'unknown');
  await rm(tasks);
  await rename(outside, tasks);
  const local = join(f.root, 'openspec', 'schemas', 'spec-driven');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'schema.yaml'), 'name: spec-driven\nversion: 1\ndescription: Unverified project override\nartifacts: []\n');
  const override = await adapter.resolveTasks(captured);
  assert.equal(override[0].state, 'unknown');
  await assert.rejects(adapter.capture('raf', assignment), { code: 'TASK_SOURCE_UNKNOWN' });
  await rm(join(f.root, 'openspec', 'schemas'), { recursive: true });
  await writeFile(join(f.root, 'openspec', 'config.yaml'), 'schema: unverified-custom\n');
  await writeFile(join(f.dir, '.openspec.yaml'), 'schema: unverified-custom\ncreated: 2026-10-22\n');
  const custom = await adapter.resolveTasks(captured);
  assert.equal(custom[0].state, 'unknown');
  t.diagnostic(`Default refusal evidence: ${JSON.stringify({ linked, override, custom })}`);
});

test('[identity-qa-platform] supported host executes the live lifecycle without skipping its existing ID', async t => {
  const name = '[identity-qa-live] actual ordinal task labels retain exact identity through completion archive and name reuse';
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const home = await mkdtemp(join(tmpdir(), 'raf-identity-runner-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await assert.rejects(lstat(home), { code: 'ENOENT' });
  });
  const driver = join(home, 'runner.mjs');
  await writeFile(driver, `
import { run } from 'node:test';
const [file, name] = process.argv.slice(2);
const stream = run({ files: [file], isolation: 'process', execArgv: [], testNamePatterns: [new RegExp('^' + RegExp.escape(name) + '$')] });
const completed = [];
const observed = [];
let verifiedLifecycle = false;
for await (const event of stream) {
  if (event.type === 'test:fail' || event.type === 'test:stderr') observed.push({ type: event.type, name: event.data.name, message: event.data.message, error: event.data.details?.error?.message });
  if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.name === name) {
    completed.push({ type: event.type, skip: event.data.skip ?? null, error: event.data.details?.error?.message ?? null });
  }
  if (event.type === 'test:diagnostic' && event.data.message.startsWith('Original tuple preserved by archive and rejected after byte-identical source replacement:')) verifiedLifecycle = true;
}
process.stdout.write(JSON.stringify({ completed, verifiedLifecycle, observed, context: process.env.NODE_TEST_CONTEXT ?? null }));
`);
  const child = await executeCommand({ executable: process.execPath, environment, args: [driver, fileURLToPath(import.meta.url), name] });
  assert.equal(child.exitCode, 0, child.stderr);
  const { completed, verifiedLifecycle } = JSON.parse(child.stdout);
  assert.equal(JSON.parse(child.stdout).context, null, 'The observation runner starts outside the parent node:test context');
  assert.equal(completed.length, 1, JSON.stringify({ stdout: child.stdout, stderr: child.stderr }));
  assert.equal(completed[0].skip, null, 'A supported host must execute the live identity test instead of leaving its ID unexecuted');
  assert.equal(completed[0].type, 'test:pass', String(completed[0].error));
  assert.equal(verifiedLifecycle, true, 'The real lifecycle must reach archive and byte-identical source replacement checks');
});
