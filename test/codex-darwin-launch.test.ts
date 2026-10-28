import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';

for (const flags of [
  ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--add-dir', '/missing/write'],
  ['--sandbox=workspace-write', '--full-auto', '-c', 'sandbox_mode="workspace-write"', '--config', 'default_permissions="linux"'],
  ['--dangerously-bypass-approvals-and-sandbox'],
]) {
  test(`Darwin launches Codex directly without RAF isolation: ${flags.join(' ')}`, { skip: process.platform !== 'darwin' }, async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'raf-darwin-launch-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const tail = ['--', 'literal --sandbox=read-only prompt'];
    const environment = { PATH: '/usr/bin:/bin', TMUX: 'owned-tmux', SSH_AUTH_SOCK: '/missing/agent.sock', OPTIONAL: undefined };
    const prepared = await prepareCodexSandbox({
      runId: 'darwin-launch', cwd: root, runDirectory: root,
      invocation: { executable: process.execPath, args: ['--model', 'chosen', '-c', 'model_reasoning_effort="medium"', ...flags, ...tail], liveTaskVerified: false },
      environment, writableDirectories: ['/missing/write'], readOnlyDirectories: ['/missing/read'],
      scope: { hidden: ['/missing/secret'], readable: [], tmuxDirectory: root, excludedCommands: [] },
    });
    t.after(() => prepared.cleanup());
    assert.deepEqual(prepared.invocation, {
      executable: process.execPath, args: ['--model', 'chosen', '-c', 'model_reasoning_effort="medium"', '--dangerously-bypass-approvals-and-sandbox', ...tail], liveTaskVerified: false,
    });
    assert.deepEqual(prepared.environment, { PATH: environment.PATH, TMUX: environment.TMUX, SSH_AUTH_SOCK: environment.SSH_AUTH_SOCK });
    assert.deepEqual(prepared.policyPaths, []);
    const tool = spawnSync(prepared.toolSandbox.executable, [...prepared.toolSandbox.args, process.execPath, '-e', 'process.stdout.write("direct-tool")'], { env: prepared.environment, encoding: 'utf8' });
    assert.equal(tool.status, 0, tool.stderr);
    assert.equal(tool.stdout, 'direct-tool');
    await prepared.cleanup();
    assert.deepEqual(await fs.readdir(root), []);
  });
}

test('Linux still refuses a missing bwrap executable', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const access = fs.access.bind(fs);
  t.mock.method(fs, 'access', async (path, ...args) => {
    if (path === '/usr/bin/bwrap') throw Object.assign(new Error('missing bwrap'), { code: 'ENOENT' });
    return access(path, ...args);
  });
  await assert.rejects(prepareCodexSandbox({
    runId: 'linux-launch', cwd: tmpdir(), runDirectory: tmpdir(),
    invocation: { executable: process.execPath, args: ['--sandbox', 'workspace-write'], liveTaskVerified: false },
    environment: process.env, writableDirectories: [],
    scope: { hidden: [], readable: [], tmuxDirectory: tmpdir(), excludedCommands: [] },
  }), /\/usr\/bin\/bwrap executable is not available/);
});

test('Linux retains the permission profile, bwrap and seccomp policy', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'raf-linux-policy-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const access = fs.access.bind(fs);
  const stat = fs.stat.bind(fs);
  t.mock.method(fs, 'access', async (path, ...args) => access(path === '/usr/bin/bwrap' ? '/bin/sh' : path, ...args));
  t.mock.method(fs, 'stat', async (path, ...args) => stat(path === '/usr/bin/bwrap' ? '/bin/sh' : path, ...args));
  const prepared = await prepareCodexSandbox({
    runId: 'linux-policy', cwd: root, runDirectory: root,
    invocation: { executable: process.execPath, args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'], liveTaskVerified: false },
    environment: process.env, writableDirectories: [root],
    scope: { hidden: [], readable: [], tmuxDirectory: root, excludedCommands: [] },
  });
  t.after(() => prepared.cleanup());
  assert.notEqual(prepared.invocation.executable, process.execPath);
  assert.ok(prepared.invocation.args.includes('default_permissions="linux"'));
  assert.ok(prepared.toolSandbox.args.includes('sandbox'));
  const policy = JSON.parse(await fs.readFile(join(prepared.policyPaths[0], 'policy.json'), 'utf8'));
  assert.equal(policy.bwrap, '/usr/bin/bwrap');
  assert.equal(policy.sandboxMode, 'workspace-write');
  assert.equal(policy.filesystem[root], 'write');
  assert.ok((await fs.stat(join(prepared.policyPaths[0], 'network.bpf'))).size > 0);
});
