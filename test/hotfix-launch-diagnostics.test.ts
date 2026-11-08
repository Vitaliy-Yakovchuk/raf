import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxAgentAdapter, type AdapterCommand, type RunnerProtocol, type AgentRunner } from '../src/agent-adapters.ts';
import { deliverExecutionResult } from '../src/cli-output.ts';

for (const stage of ['import', 'dispatch']) {
  test(`hotfix: entrypoint emits JSON when CLI ${stage} fails`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'raf-entry-failure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'src'));
    await copyFile(new URL('../bin/raf.ts', import.meta.url), join(root, 'bin/raf.ts'));
    await copyFile(new URL('../src/cli-output.ts', import.meta.url), join(root, 'src/cli-output.ts'));
    await writeFile(join(root, 'src/cli.ts'), stage === 'import' ? 'throw new Error("fixture import failed");' : 'export async function runPublicCli() { throw new Error("fixture dispatch failed"); }');
    const result = spawnSync(process.execPath, [join(root, 'bin/raf.ts'), 'agent', 'run'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.code, 'PRODUCTION_ENTRY_FAILED');
    assert.equal(error.message, `fixture ${stage} failed`);
  });
}

for (const warning of ['', 'Warning: Dash refused the read: not-found\n']) {
  test(`hotfix: a failure without a diagnostic cannot leave the CLI silent (${warning ? 'warnings' : 'empty'})`, async () => {
    let stderr = '';
    const exitCode = await deliverExecutionResult({ stdout: '', stderr: warning, exitCode: 1 }, {
      writeStdout: async () => { assert.fail('failure belongs on stderr'); },
      writeStderr: async chunk => { stderr += chunk; },
    });
    assert.equal(exitCode, 1);
    assert.equal(JSON.parse(stderr.trim().split('\n').at(-1)!).code, 'PRODUCTION_ENTRY_FAILED');
  });
}

for (const oversized of [false, true]) {
  test(`hotfix: launching at a PTY allocation boundary avoids closing a live placeholder (${oversized ? 'source-file' : 'argv'})`, async () => {
    const commands: AdapterCommand[] = [];
    let livePlaceholder = false;
    let launches = 0;
    const adapter = new TmuxAgentAdapter({
      execute: async command => {
        commands.push(command);
        if (command.args[0] === 'new-session') livePlaceholder = command.args.includes('read -r _');
        if (command.args.includes('respawn-pane') || command.args[0] === 'source-file') {
          if (livePlaceholder) return { exitCode: 1, stdout: '', stderr: 'respawn pane failed: fork failed: Device not configured' };
          launches++;
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      protocols: { codex: { invocation: () => ({ executable: 'codex', args: oversized ? ['x'.repeat(20000)] : [] }), observe: () => ({ status: 'starting' }) } } as Record<AgentRunner, RunnerProtocol>,
    });
    const session = await adapter.startWithoutInput({ selection: { runner: 'codex', model: 'assigned', effort: 'high' }, tmuxSession: 'raf-hotfix-owned', cwd: '/tmp', reportWrapper: { wrap: command => command } });
    assert.equal(session.tmuxSession, 'raf-hotfix-owned');
    assert.equal(launches, 1);
    assert.equal(commands.filter(command => command.args[0] === 'new-session').length, 1);
    assert.equal(commands.some(command => command.args.includes('-k') || command.stdin?.includes("'-k'")), false);
    assert.equal(commands.some(command => ['paste-buffer', 'send-keys', 'kill-server'].includes(command.args[0])), false);
  });

  test(`hotfix: real tmux has no placeholder PID before starting the runner (${oversized ? 'source-file' : 'argv'})`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-empty-pane-')));
    const socket = join(root, 'tmux.sock');
    const output = join(root, 'runner.json');
    const run = (args: readonly string[], input?: string) => {
      const result = spawnSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], { input, encoding: 'utf8' });
      assert.ifError(result.error);
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    };
    t.after(async () => { run(['kill-server']); await rm(root, { recursive: true, force: true }); });
    let inspected = false;
    const inspect = () => {
      const pane = run(['display-message', '-p', '-t', '=owned:0.0', '#{pane_pid}|#{pane_dead}']);
      assert.equal(pane.exitCode, 0, pane.stderr);
      const [pid, dead] = pane.stdout.trim().split('|');
      if (process.platform !== 'linux') {
        assert.equal(dead, '1', 'bootstrap must leave a dead pane without a live placeholder');
        if (pid) assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
      }
      inspected = true;
    };
    const payload = oversized ? 'literal Україна $HOME \' ;'.repeat(2000) : 'literal Україна $HOME \' ;';
    const adapter = new TmuxAgentAdapter({
      execute: async command => {
        const split = command.args.indexOf('respawn-pane');
        if (split >= 0) {
          const bootstrap = run(command.args.slice(0, split - 1));
          assert.equal(bootstrap.exitCode, 0, bootstrap.stderr);
          inspect();
          return run(command.args.slice(split));
        }
        if (command.args[0] === 'source-file') inspect();
        return run(command.args, command.stdin);
      },
      protocols: { codex: { invocation: () => ({ executable: process.execPath, args: ['--input-type=commonjs', '-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))', output, payload] }), observe: () => ({ status: 'starting' }) } } as Record<AgentRunner, RunnerProtocol>,
    });
    await adapter.startWithoutInput({ selection: { runner: 'codex', model: 'assigned', effort: 'high' }, tmuxSession: 'owned', cwd: root, reportWrapper: { wrap: command => command } });
    assert.equal(inspected, true);
    const deadline = Date.now() + 5000;
    for (;;) {
      try { assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), [payload]); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const deadlineExit = Date.now() + 5000;
    while (!run(['display-message', '-p', '-t', '=owned:0.0', '#{pane_dead}|#{pane_dead_status}']).stdout.startsWith('1|0')) {
      assert.ok(Date.now() < deadlineExit, 'fast runner exit must remain observable');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
}

test('hotfix: a live bootstrap shell is replaced instead of failing the launch', async () => {
  const commands: AdapterCommand[] = [];
  const adapter = new TmuxAgentAdapter({
    execute: async command => {
      commands.push(command);
      if (command.args.includes('respawn-pane') && !command.args.includes('-k')) return { exitCode: 1, stdout: '', stderr: 'respawn pane failed: pane owned:0.0 still active' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    protocols: { codex: { invocation: () => ({ executable: 'codex', args: [] }), observe: () => ({ status: 'starting' }) } } as Record<AgentRunner, RunnerProtocol>,
  });
  const session = await adapter.startWithoutInput({ selection: { runner: 'codex', model: 'assigned', effort: 'high' }, tmuxSession: 'owned', cwd: '/tmp', reportWrapper: { wrap: command => command } });
  assert.equal(session.tmuxSession, 'owned');
  assert.equal(commands.filter(command => command.args[0] === 'respawn-pane' && command.args.includes('-k')).length, 1);
});
