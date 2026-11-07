import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { runtimeExecution } from '../src/production-runtime.ts';
import type { StateContext } from '../src/state-migration-guard.ts';

const exec = promisify(execFile);

test('batched QA tmux observations retain both HOME checks and preserve a foreign server', async t => {
  const directory = await fs.mkdtemp('/tmp/raf-latency-tmux-');
  const home = join(directory, 'home');
  const tmpRoot = join(home, '.raf/tmp');
  const socket = join(tmpRoot, 'tmux/server.sock');
  await fs.mkdir(join(tmpRoot, 'tmux'), { recursive: true, mode: 0o700 });
  const tmux = (args: string[]) => exec('tmux', ['-S', socket, ...args], { env: { ...process.env, HOME: home, RAF_QA_HOME: home } });
  t.after(async () => { await tmux(['kill-server']).catch(() => undefined); await fs.rm(directory, { recursive: true, force: true }); });
  await tmux(['new-session', '-d', '-s', 'sentinel', 'sleep', '300']);
  const stateContext: StateContext = { mode: 'qa', orchestratorRoot: directory, codeRoot: directory,
    homeDirectory: home, statePath: join(home, '.raf/state.sqlite'), tmpRoot, tmuxSocketPath: socket };
  const execute = runtimeExecution({ tmpRoot, stateContext });
  const command = { executable: 'tmux', args: ['display-message', '-p', '-t', '=sentinel:0.0', '#{pid}:#{pane_pid}:#{pane_id}'] };
  const before = (await tmux(command.args)).stdout;
  assert.equal((await execute(command)).stdout, before, 'owned observation strips only the environment prefix');
  for (const variable of ['HOME', 'RAF_QA_HOME']) {
    for (const missing of [false, true]) {
      await tmux(missing ? ['set-environment', '-gu', variable] : ['set-environment', '-g', variable, join(directory, 'foreign')]);
      const environment = (await tmux(['show-environment', '-g'])).stdout;
      await assert.rejects(execute(command), /STATE_CONTEXT_REFUSED/);
      await assert.rejects(execute({ executable: 'tmux', args: ['send-keys', '-t', '=sentinel:0.0', 'unexpected'] }), /STATE_CONTEXT_REFUSED/);
      assert.equal((await tmux(command.args)).stdout, before, 'refusal preserves server and pane identity');
      assert.equal((await tmux(['show-environment', '-g'])).stdout, environment, 'refusal never rewrites the foreign environment');
      await tmux(['set-environment', '-g', variable, home]);
    }
  }
  await tmux(['kill-server']);
  const absent = await execute(command);
  assert.notEqual(absent.exitCode, 0, 'an absent server is an ordinary failed observation');
  await execute({ executable: 'tmux', args: ['new-session', '-d', '-s', 'recreated', 'sleep', '300'] });
  for (const variable of ['HOME', 'RAF_QA_HOME']) assert.equal((await tmux(['show-environment', '-g', variable])).stdout.trim(), `${variable}=${home}`);
});
