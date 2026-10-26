import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, lstat, readlink, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxAgentAdapter, type AdapterCommand, type AgentRunner, type RunnerProtocol } from '../src/agent-adapters.ts';
import { resolveWorkspaceRoute } from '../src/workspace-routing.ts';
import { validateAssignment, verifyAssignmentCompletion } from '../src/assignment.ts';

async function run(executable: string, args: readonly string[], cwd?: string, stdin?: string) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, OPENSPEC_TELEMETRY: '0' }, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

test('integration QA: tmux retains immediately exited child status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-tmux-qa-'));
  const socket = join(root, 'socket');
  const protocol: RunnerProtocol = { invocation: () => ({ executable: 'sh', args: ['-c', 'exit 37'] }), observe: () => ({ status: 'ready' }) };
  const adapter = new TmuxAgentAdapter({
    execute: async command => {
      const result = await run(command.executable, ['-S', socket, '-f', '/dev/null', ...command.args], command.cwd, command.stdin);
      if (command.args[0] === 'new-session') await new Promise(resolve => setTimeout(resolve, 100));
      return result;
    },
    protocols: Object.fromEntries(['codex', 'grok', 'agy', 'claude'].map(name => [name, protocol])) as Record<AgentRunner, RunnerProtocol>,
  });
  try {
    const session = await adapter.start({ selection: { runner: 'codex', model: 'fixture', effort: 'fixture' }, tmuxSession: 'qa', cwd: root, brief: 'fixture', reportWrapper: { wrap: command => command } });
    assert.deepEqual(await adapter.inspect(session), { status: 'exited', exitCode: 37 });
    await adapter.stop(session);
  } finally {
    await run('tmux', ['-S', socket, 'kill-server']);
    await rm(root, { recursive: true, force: true });
  }
});

test('integration QA: same-branch shared library symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-git-qa-'));
  try {
    for (const name of ['app-develop', 'shared-libs-develop', 'shared-libs-main']) {
      await mkdir(join(root, name));
      const result = await run('git', ['init', '-b', name.endsWith('main') ? 'main' : 'develop'], join(root, name));
      assert.equal(result.exitCode, 0, result.stderr);
    }
    const config = { projects: { app: { path: 'app-develop', profile: 'product', branchPaths: { develop: 'app-develop' }, usesSharedLibs: true }, 'shared-libs': { path: 'shared-libs-main', profile: 'library', branchPaths: { develop: 'shared-libs-develop', main: 'shared-libs-main' } } } };
    const dependencies = {
      pathKind: async (path: string) => { try { const stat = await lstat(path); return stat.isSymbolicLink() ? 'symlink' as const : stat.isDirectory() ? 'directory' as const : 'file' as const; } catch { return 'missing' as const; } },
      readLink: readlink,
    };
    const request = { root, project: 'app', branch: 'develop' };
    const link = join(root, 'app-develop', 'shared-libs');
    await symlink('../shared-libs-main', link);
    const wrong = await resolveWorkspaceRoute(request, config, dependencies);
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.error.code, 'SHARED_LIBS_LINK_INVALID');
    await unlink(link);
    await symlink('../shared-libs-develop', link);
    assert.equal((await resolveWorkspaceRoute(request, config, dependencies)).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('integration QA: live OpenSpec assignment and completion reject changed descriptions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-openspec-qa-'));
  try {
    const initialized = await run('openspec', ['init', '--tools', 'none', '--no-animation', '--no-copilot-cloud', root]);
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    const change = join(root, 'openspec', 'changes', 'qa-fixture');
    await mkdir(join(change, 'specs', 'qa-fixture'), { recursive: true });
    await writeFile(join(change, 'proposal.md'), '# QA fixture\n\n## Why\nExercise local integration.\n\n## What Changes\nAdd a fixture.\n\n## Capabilities\n### New Capabilities\n- `qa-fixture`: fixture\n\n## Impact\nTemporary only.\n');
    await writeFile(join(change, 'design.md'), '## Context\nTemporary integration fixture.\n');
    await writeFile(join(change, 'specs', 'qa-fixture', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Fixture\nThe fixture SHALL be temporary.\n\n#### Scenario: QA\n- **WHEN** QA runs\n- **THEN** it remains isolated\n');
    const tasksPath = join(change, 'tasks.md');
    await writeFile(tasksPath, '## 1. QA\n- [ ] 1.1 Exercise fixture\n');
    const ports = { cli: { exec: (args: readonly string[], cwd: string) => run('openspec', args, cwd) }, fs: { readText: (path: string) => readFile(path, 'utf8') } };
    const validation = await validateAssignment({ root, selections: [{ change: 'qa-fixture', items: [{ id: '1.1' }] }] }, ports);
    assert.equal(validation.ok, true, JSON.stringify(validation));
    if (!validation.ok) return;
    assert.equal((await verifyAssignmentCompletion(validation.snapshot, ports)).ok, false);
    await writeFile(tasksPath, '## 1. QA\n- [x] 1.1 Different work\n');
    assert.equal((await verifyAssignmentCompletion(validation.snapshot, ports)).ok, false);
    await writeFile(tasksPath, '## 1. QA\n- [x] 1.1 Exercise fixture\n');
    assert.equal((await verifyAssignmentCompletion(validation.snapshot, ports)).ok, true);
    const archived = await run('openspec', ['archive', 'qa-fixture', '--yes', '--skip-specs', '--json'], root);
    assert.equal(archived.exitCode, 0, archived.stderr + archived.stdout);
    const verifiedArchive = await verifyAssignmentCompletion(validation.snapshot, ports);
    assert.equal(verifiedArchive.ok, true, JSON.stringify(verifiedArchive));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('integration QA: tmux delivers literal briefs and messages to a harmless child and stops exactly its session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-message-qa-'));
  const socket = join(root, 'socket');
  const received = join(root, 'received.txt');
  const execute = (command: AdapterCommand) => run(command.executable, ['-S', socket, '-f', '/dev/null', ...command.args], command.cwd, command.stdin);
  const protocol: RunnerProtocol = {
    invocation: () => ({ executable: process.execPath, args: ['-e', 'const fs = require("fs"); process.stdin.on("data", data => fs.appendFileSync(process.argv[1], data)); console.log("READY");', received] }),
    observe: pane => pane.includes('READY') ? { status: 'ready', cliSessionId: 'fixture-only' } : { status: 'starting' },
  };
  const adapter = new TmuxAgentAdapter({ execute, protocols: Object.fromEntries(['codex', 'grok', 'agy', 'claude'].map(name => [name, protocol])) as Record<AgentRunner, RunnerProtocol> });
  try {
    const sentinel = await run('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'sentinel', 'sh', '-c', 'read -r _']);
    assert.equal(sentinel.exitCode, 0, sentinel.stderr);
    const brief = 'literal $(printf injected); `echo example` "quotes"';
    const session = await adapter.start({ selection: { runner: 'codex', model: 'fixture', effort: 'fixture' }, tmuxSession: 'qa', cwd: root, brief, reportWrapper: { wrap: command => command } });
    const message = 'follow-up $HOME';
    await adapter.deliver(session, message);
    let contents = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      contents = await readFile(received, 'utf8').catch(() => '');
      if (contents.includes(message)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(contents, `${brief}\n${message}\n`);
    assert.deepEqual(await adapter.inspect(session), { status: 'ready', cliSessionId: 'fixture-only' });
    await adapter.stop(session);
    assert.equal((await run('tmux', ['-S', socket, 'has-session', '-t', '=sentinel'])).exitCode, 0);
    assert.deepEqual(await adapter.inspect(session), { status: 'exited', exitCode: null });
  } finally {
    await run('tmux', ['-S', socket, 'kill-server']);
    await rm(root, { recursive: true, force: true });
  }
});
