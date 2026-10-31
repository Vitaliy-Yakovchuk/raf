import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';

for (const workspaceWritable of [true, false]) {
  test(`Darwin uses native workspace-write isolation with exact permissions (${workspaceWritable})`, async t => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    const access = fs.access.bind(fs);
    t.mock.method(fs, 'access', async (path, mode) => {
      assert.notEqual(path, '/usr/bin/bwrap', 'Darwin must never resolve Linux bubblewrap');
      return access(path, mode);
    });
    const root = await fs.mkdtemp(join(tmpdir(), 'raf-darwin-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = join(root, 'workspace');
    const runDirectory = join(root, 'run');
    const extra = join(root, 'extra');
    const protectedPath = join(extra, 'production');
    const hidden = join(extra, 'private');
    const absentHidden = join(extra, 'not-created');
    const alias = join(extra, 'alias');
    const file = join(root, 'questions.md');
    await Promise.all([cwd, runDirectory, extra, protectedPath, hidden].map(path => fs.mkdir(path, { recursive: true })));
    await fs.symlink(hidden, alias);
    await fs.writeFile(file, 'original');
    const preserved = ['--model', 'chosen', '-c', 'model_reasoning_effort="high"'];
    const tail = ['--', 'prompt --sandbox=unchanged'];
    const prepared = await prepareCodexSandbox({
      runId: `darwin-${workspaceWritable}`, cwd, runDirectory,
      invocation: { executable: '/bin/true', args: [...preserved, '--sandbox', 'workspace-write', '--add-dir', extra, '--add-dir', file, ...tail], liveTaskVerified: true },
      writableDirectories: workspaceWritable ? [cwd] : [], readOnlyDirectories: [protectedPath],
      scope: { hidden: [alias, absentHidden], readable: [], tmuxDirectory: runDirectory, excludedCommands: [] },
      environment: { PATH: '/usr/bin:/bin', HOME: root, SSH_AUTH_SOCK: hidden, TMUX: 'host' },
    });
    t.after(() => prepared.cleanup());
    const policy = JSON.parse(await fs.readFile(join(prepared.policyPaths[0], 'policy.json'), 'utf8'));
    assert.equal(policy.profile, 'darwin');
    assert.equal(policy.backend.selection, 'native-seatbelt');
    assert.equal(policy.bwrap, undefined);
    assert.equal(policy.filesystem[cwd], workspaceWritable ? 'write' : 'read');
    for (const path of [extra, runDirectory, file]) assert.equal(policy.filesystem[path], 'write');
    assert.equal(policy.filesystem[root], undefined, 'a file grant must not grant its parent');
    assert.equal(policy.filesystem[protectedPath], 'read');
    for (const path of [hidden, alias, absentHidden, join(userInfo().homedir, '.raf', 'secrets.json')]) {
      assert.equal(policy.filesystem[path], 'none', `hidden path ${path}`);
    }
    for (const invocation of [prepared.invocation, prepared.toolSandbox]) {
      assert.ok(invocation.args.includes('sandbox_mode="workspace-write"'));
      assert.ok(invocation.args.includes('default_permissions="darwin"'));
      const config = invocation.args.find(arg => arg.startsWith('permissions.darwin.filesystem='));
      assert.ok(config);
      for (const [path, access] of Object.entries(policy.filesystem)) assert.ok(config.includes(`${JSON.stringify(path)}=${JSON.stringify(access)}`));
    }
    assert.deepEqual(prepared.invocation.args.slice(0, preserved.length + 1), ['--no-daemon', ...preserved]);
    assert.deepEqual(prepared.invocation.args.slice(-tail.length), tail);
    assert.equal(prepared.environment.TMUX, undefined);
    assert.equal(prepared.environment.SSH_AUTH_SOCK, undefined);
    for (const name of ['network.bpf', 'bwrap']) await assert.rejects(fs.stat(join(prepared.policyPaths[0], name)), { code: 'ENOENT' });
    await prepared.cleanup();
    await assert.rejects(fs.stat(prepared.policyPaths[0]), { code: 'ENOENT' });
  });
}
