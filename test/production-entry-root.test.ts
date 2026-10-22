import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compileCatalog } from '../src/catalog.ts';

const exec = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const constants = JSON.parse(readFileSync(join(sourceRoot, '../conf/raf-constants.json'), 'utf8'));
const models = JSON.parse(readFileSync(join(sourceRoot, '../conf/models.json'), 'utf8'));
const settings = JSON.parse(readFileSync(join(sourceRoot, '../conf/raf.json'), 'utf8'));
const change = 'root-fixture';
const description = 'Root fixture item';

const openspecScript = String.raw`
const args = process.argv.slice(2).join(' ');
if (args === 'list --json') process.stdout.write(JSON.stringify({ changes: [{ name: 'root-fixture', completedTasks: 0, totalTasks: 1 }] }));
else if (args === 'list --archived --json') process.stdout.write(JSON.stringify({ changes: [] }));
else if (args === 'instructions apply --change root-fixture --json') process.stdout.write(JSON.stringify({ tasks: [{ id: '1', description: '1.1 Root fixture item', done: false }] }));
else { process.stderr.write('unexpected openspec ' + args); process.exit(2); }
`;

async function writeJson(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

async function fixture(t: { after(action: () => Promise<void>): void }) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'raf-entry-root-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'orchestrator');
  const link = join(directory, 'orchestrator-link');
  const home = join(directory, 'home');
  const bin = join(directory, 'bin');
  const workspace = join(root, 'raf-develop');
  for (const path of [join(root, 'conf'), join(workspace, 'bin'), join(workspace, 'dist'), home, bin]) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  await fs.copyFile(join(sourceRoot, 'bin', 'raf.ts'), join(workspace, 'bin', 'raf.ts'));
  await fs.symlink(join(sourceRoot, 'src'), join(workspace, 'src'));
  await fs.symlink(root, link);
  const flow = JSON.parse(readFileSync(join(sourceRoot, '../conf/flow.json'), 'utf8'));
  const projects = { version: 1, projects: { raf: { path: 'raf-develop', profile: 'raf', branchPaths: { develop: 'raf-develop' } } } };
  await writeJson(join(workspace, 'dist', 'catalog.json'), compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects));
  for (const [name, data] of [['raf.json', settings], ['models.json', models], ['raf-constants.json', constants], ['projects.json', projects], ['flow.json', flow]] as const) await writeJson(join(root, 'conf', name), data);
  await fs.writeFile(join(bin, 'openspec'), `#!${process.execPath}\n${openspecScript}`, { mode: 0o700 });
  const parameters = { id: 'root-check', type: 'implement', project: 'raf', features: ['root-fixture'], phase: 'implement', complexity: 'decision', tasks: [`${change}:1.1`] };
  const argv = ['agent', 'run', '--id', parameters.id, '--type', parameters.type, '--project', parameters.project, '--features', ...parameters.features, '--phase', parameters.phase, '--complexity', parameters.complexity, '--tasks', ...parameters.tasks];
  return {
    directory, root, link, workspace,
    legacyEnvelope: (assignmentRoot: string) => writeJson(join(home, '.raf', 'tmp', 'task-context', parameters.id + '.json'), { version: 1, parameters, assignment: { root: assignmentRoot, changes: [{ id: change, items: [{ id: '1.1', description: 'FOREIGN description' }] }], baselineArchives: [] }, context: { branch: 'main', outcome: 'FOREIGN', writeBoundaries: [assignmentRoot], sources: [], requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [], reportSchema: { type: 'object' } } }),
    run: async (entryRoot = root) => {
      const result = await exec(process.execPath, [join(entryRoot, 'raf-develop', 'bin', 'raf.ts'), ...argv], { cwd: directory, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, timeout: 60000 }).then(
        output => ({ exitCode: 0, stdout: output.stdout, stderr: output.stderr }),
        error => ({ exitCode: error.code as number, stdout: String(error.stdout), stderr: String(error.stderr) }));
      return { ...result, error: result.stderr ? JSON.parse(result.stderr) : undefined };
    },
  };
}

function passedTaskContext(result: { exitCode: number; stderr: string; error?: Record<string, any> }) {
  assert.doesNotMatch(result.stderr, /TASK_CONTEXT|TASK_SOURCE_MISSING|RESOURCE_ESTIMATE_UNKNOWN|FOREIGN/, `Корінь з bin/raf.ts має давати виведений task-context без помилки: ${result.stderr}`);
  assert.deepEqual({ code: result.error?.code, stage: result.error?.details?.stage }, { code: 'WORKSPACE_UNAVAILABLE', stage: 'workspace' }, result.stderr);
  assert.notEqual(result.exitCode, 0);
}

test('bin/raf.ts agent run derives task context from the orchestrator root without a trusted file', async t => {
  const f = await fixture(t);
  passedTaskContext(await f.run());
});

test('legacy task context whose root is written with trailing slash, dot-dot segment or symlink is ignored', async t => {
  const f = await fixture(t);
  const baseline = await f.run();
  passedTaskContext(baseline);
  for (const assignmentRoot of [f.root + '/', f.workspace + '/..', f.link]) {
    await f.legacyEnvelope(assignmentRoot);
    const result = await f.run();
    passedTaskContext(result);
    assert.deepEqual(result.error, baseline.error);
  }
});

test('bin/raf.ts started through a symlinked orchestrator path derives task context from its lexical root', async t => {
  const f = await fixture(t);
  passedTaskContext(await f.run(f.link));
});
