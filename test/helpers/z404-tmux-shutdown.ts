import assert from 'node:assert/strict';
import { lstat, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type TmuxShutdownIdentity = Pick<Stats, 'dev' | 'ino' | 'uid' | 'mode' | 'isSocket' | 'isDirectory'>;

export type TmuxShutdownResult = {
  status: number | null;
  signal: string | null;
  error?: Error;
  stdout: string;
  stderr: string;
};

export type TmuxShutdownDependencies = {
  lstat: (address: string) => Promise<TmuxShutdownIdentity>;
  unlink: (address: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type OwnTmuxShutdownOptions = {
  address: string;
  socketIdentity: TmuxShutdownIdentity;
  directoryIdentity: TmuxShutdownIdentity;
  transitionMs: number;
  pollMs: number;
  killed: TmuxShutdownResult;
  execute: (timeoutMs: number) => TmuxShutdownResult;
  progress: (marker: string) => void;
  dependencies?: TmuxShutdownDependencies;
};

export async function observeOwnTmuxShutdown(options: OwnTmuxShutdownOptions): Promise<void> {
  const { address, socketIdentity, directoryIdentity, killed, execute, progress } = options;
  const io = options.dependencies ?? { lstat, unlink, now: Date.now, sleep: delay };
  assert.equal(killed.error, undefined, 'own tmux kill must execute');
  assert.equal(killed.signal, null, 'own tmux kill must complete');
  assert.equal(killed.status, 0, killed.stderr);
  assert.equal(killed.stderr.trim(), '', 'own tmux kill must not report an unknown diagnostic');
  assert.ok(Number.isFinite(options.transitionMs) && options.transitionMs > 0);
  assert.ok(Number.isFinite(options.pollMs) && options.pollMs > 0);
  const deadline = io.now() + options.transitionMs;
  const remaining = () => {
    const ms = deadline - io.now();
    assert.ok(ms > 0, 'own tmux server and socket must exit before cleanup deadline');
    return ms;
  };
  const pause = async () => { await io.sleep(Math.min(options.pollMs, remaining())); };
  progress('server-exit:before');
  while (true) {
    const listed = execute(remaining());
    assert.equal(listed.error, undefined, 'own tmux server exit check must execute');
    assert.equal(listed.signal, null, 'own tmux server exit check must complete');
    remaining();
    const diagnostic = listed.stderr.trim();
    if (listed.status === 1) {
      assert.equal(listed.stdout.trim(), '', 'no server produces no sessions');
      if (diagnostic === `error connecting to ${address} (No such file or directory)`) {
        await assert.rejects(io.lstat(address), { code: 'ENOENT' }, 'missing own socket confirms no server');
        remaining();
        break;
      }
      if (diagnostic === `no server running on ${address}`) break;
      assert.equal(diagnostic, 'server exited unexpectedly', 'only the known shutdown transition may be retried');
    } else {
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(diagnostic, '', 'a running own server must not report an unknown diagnostic');
    }
    await pause();
  }
  progress('server-exit:after');
  let residual: TmuxShutdownIdentity | undefined;
  try { residual = await io.lstat(address); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  remaining();
  if (residual) {
    assert.ok(residual.isSocket(), 'residual own tmux endpoint must still be a socket');
    for (const field of ['dev', 'ino', 'uid', 'mode'] as const) {
      assert.equal(residual[field], socketIdentity[field], `own tmux socket ${field} identity retained`);
    }
    const directory = await io.lstat(dirname(address));
    remaining();
    assert.ok(directory.isDirectory(), 'own tmux socket directory must not be replaced by a symlink');
    for (const field of ['dev', 'ino', 'uid', 'mode'] as const) {
      assert.equal(directory[field], directoryIdentity[field], `own tmux socket directory ${field} identity retained`);
    }
    progress('socket-unlink:before');
    try { await io.unlink(address); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    progress('socket-unlink:after');
  }
  while (true) {
    remaining();
    try { await io.lstat(address); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      remaining();
      break;
    }
    await pause();
  }
}
