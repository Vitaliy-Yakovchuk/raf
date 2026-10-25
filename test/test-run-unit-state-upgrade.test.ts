import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';

const source = fileURLToPath(new URL('../', import.meta.url));
const schema16Commit = '944ae2a615151e2b48b481b6a2306e3c9e26b6ab';

test('test run upgrades its owned schema-16 unit state without losing the group budget', async t => {
  const root = mkdtempSync(join(tmpdir(), 'raf-z420-'));
  const workspace = join(root, 'raf-hotfix');
  const controlHome = join(root, 'control-home');
  const group = 'complete-raf-flow-contracts/z420';
  const key = { project: 'raf', workspace, group };
  const unitHome = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`,
    createHash('sha256').update(JSON.stringify([root, key.project, workspace])).digest('hex'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousQaHome = process.env.RAF_QA_HOME;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousQaHome === undefined) delete process.env.RAF_QA_HOME; else process.env.RAF_QA_HOME = previousQaHome;
    rmSync(unitHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  cpSync(join(source, '..', 'conf'), join(root, 'conf'), { recursive: true });
  const projectsPath = join(root, 'conf/projects.json');
  const projects = JSON.parse(readFileSync(projectsPath, 'utf8'));
  projects.projects.raf.path = 'raf-main';
  projects.projects.raf.branchPaths = { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' };
  writeFileSync(projectsPath, JSON.stringify(projects));
  for (const path of ['raf-main', 'raf-develop', 'raf-hotfix', 'control-home']) mkdirSync(join(root, path), { mode: 0o700 });
  cpSync(join(source, 'src'), join(workspace, 'src'), { recursive: true });
  symlinkSync(join(source, 'node_modules'), join(workspace, 'node_modules'));
  writeFileSync(join(workspace, 'package.json'), '{"type":"module"}');
  mkdirSync(join(workspace, 'bin'));
  writeFileSync(join(workspace, 'bin/raf.ts'), '');
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=hotfix');
  git('-c', 'user.name=Unit', '-c', 'user.email=unit@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture');
  const stateName = JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8')).state.fileName;
  const controlPath = join(controlHome, '.raf', stateName);
  const unitPath = join(unitHome, '.raf', stateName);
  openStateStore(controlPath).close();
  const controlBefore = readFileSync(controlPath);
  mkdirSync(dirname(unitHome), { recursive: true, mode: 0o700 });
  mkdirSync(unitHome, { mode: 0o700 });
  mkdirSync(dirname(unitPath), { mode: 0o700 });
  const historical = join(root, 'schema16');
  mkdirSync(historical);
  const archive = join(root, 'schema16.tar');
  execFileSync('git', ['-C', source, 'archive', '--format=tar', '--output', archive, schema16Commit, 'src', 'package.json']);
  execFileSync('tar', ['-xf', archive, '-C', historical]);
  const legacy = await import(pathToFileURL(join(historical, 'src/state-store.ts')).href);
  legacy.openStateStore(unitPath).close();
  const payload = { key, timeoutCount: 1, state: 'idle', inFlight: null, lastResult: null, knownRed: [], unexecuted: [] };
  const old = new DatabaseSync(unitPath);
  try {
    assert.equal(old.prepare('PRAGMA user_version').get()!.user_version, 16, 'Use a real schema-16 client');
    old.prepare('INSERT INTO test_run_groups(project, workspace, group_id, payload) VALUES (?, ?, ?, ?)').run(key.project, workspace, group, JSON.stringify(payload));
  } finally { old.close(); }
  assert.throws(() => openStateStore(unitPath), { code: 'STATE_MIGRATION_REQUIRED' });
  const caller = { pid: process.pid, startedAt: 'unit-process-start' };
  const assignment = { runId: 'unit-caller', agentId: 'unit-agent', type: 'hotfix', phase: 'hotfix', project: 'raf', workspace, branch: 'hotfix', changes: ['complete-raf-flow-contracts'] };
  const control = { ancestors: [caller], sessions: [{ process: caller, state: 'running', assignment }],
    activeChanges: ['complete-raf-flow-contracts'], groups: [key],
    workspaces: [{ project: 'raf', workspace, branch: 'hotfix', actualBranch: 'hotfix' }] };
  const runtimeUrl = pathToFileURL(join(workspace, 'src/test-run-runtime.ts')).href;
  const doubles: Record<string, string> = {
    './production-runtime.ts': `export const sandboxTestControlSnapshot = async () => (${JSON.stringify(control)});`,
    './sandbox-test-caller.ts': `export const resolveSandboxTestCaller = () => (${JSON.stringify(assignment)});`,
    './test-run-resource-runtime.ts': 'export const createTestRunResourcePort = () => ({ list: async () => [] });',
    './test-run-queue-runtime.ts': 'export const createTestRunQueuePort = () => ({});',
  };
  const cliUrl = pathToFileURL(join(workspace, 'src/test-run-cli.ts')).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === runtimeUrl && doubles[specifier]) return { url: `z420:${specifier}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith('z420:')) return { format: 'module', source: doubles[url.slice(5)], shortCircuit: true };
      if (url === cliUrl) return { format: 'module', shortCircuit: true, source: `
        export async function runTestRunCli(argv, ports) {
          const group = await ports.runtime.state.transaction(tx => tx.get(${JSON.stringify(key)}));
          if (group.timeoutCount !== 1) throw new Error('Unit group budget was reset');
          ports.stdout(JSON.stringify({ runId: 'unit-port-result', groupSnapshot: 'unavailable' }));
          return 0;
        }
      ` };
      return next(url, context);
    },
  });
  t.after(() => hooks.deregister());
  process.chdir(workspace);
  process.env.HOME = controlHome;
  process.env.RAF_QA_HOME = controlHome;
  const runtime = await import(runtimeUrl);
  const result = await runtime.runConfiguredTestRun(['--project', 'raf', '--phase', 'hotfix', '--group', group],
    { orchestratorRoot: root, homeDirectory: controlHome, commandTimingOwner: 'production' });
  assert.equal(result.exitCode, 0, result.stderr + '\n' + result.stdout);
  const upgraded = new DatabaseSync(unitPath, { readOnly: true });
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get()!.user_version, STATE_SCHEMA_VERSION);
    assert.deepEqual(JSON.parse(String(upgraded.prepare('SELECT payload FROM test_run_groups WHERE group_id = ?').get(group)!.payload)), payload);
    assert.equal(upgraded.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { upgraded.close(); }
  const backupFiles = readdirSync(dirname(unitPath)).filter(name => name !== stateName && !name.endsWith('-wal') && !name.endsWith('-shm') && name !== 'tmp');
  assert.ok(backupFiles.length > 0, 'A verified backup must precede migration');
  assert.ok(backupFiles.some(name => {
    const db = new DatabaseSync(join(dirname(unitPath), name), { readOnly: true });
    try {
      return db.prepare('PRAGMA user_version').get()!.user_version === 16 &&
        JSON.parse(String(db.prepare('SELECT payload FROM test_run_groups WHERE group_id = ?').get(group)!.payload)).timeoutCount === 1;
    } finally { db.close(); }
  }));
  assert.deepEqual(readFileSync(controlPath), controlBefore, 'The control database remains unchanged');
});
