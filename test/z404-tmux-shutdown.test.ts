import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  observeOwnTmuxShutdown,
  type OwnTmuxShutdownOptions,
  type TmuxShutdownIdentity,
  type TmuxShutdownResult,
} from './helpers/z404-tmux-shutdown.ts';

const success = (): TmuxShutdownResult => ({ status: 0, signal: null, stdout: '', stderr: '' });
const refusal = (stderr: string): TmuxShutdownResult => ({ ...success(), status: 1, stderr });
const missing = () => Object.assign(new Error('missing own socket'), { code: 'ENOENT' });
const identity = (socket: boolean): TmuxShutdownIdentity => ({
  dev: 5, ino: socket ? 11 : 12, uid: 1000, mode: socket ? 0o140600 : 0o40700,
  isSocket: () => socket, isDirectory: () => !socket,
});

function fixture(kind = 'default') {
  const address = `/own/tmux-1000/${kind}`;
  const socketIdentity = identity(true), directoryIdentity = identity(false);
  const state = {
    time: 1000, commandMs: 0, socket: socketIdentity as TmuxShutdownIdentity | undefined,
    directory: directoryIdentity, statError: undefined as Error | undefined,
    unlinkError: undefined as Error | undefined, retainAfterUnlink: false,
  };
  const results: TmuxShutdownResult[] = [];
  const budgets: number[] = [], sleeps: number[] = [], reads: string[] = [], unlinks: string[] = [], markers: string[] = [], events: string[] = [];
  const options: OwnTmuxShutdownOptions = {
    address, socketIdentity, directoryIdentity, transitionMs: 25, pollMs: 10, killed: success(),
    execute: timeoutMs => {
      budgets.push(timeoutMs); state.time += state.commandMs;
      const result = results.shift() ?? refusal('server exited unexpectedly');
      events.push(result.stderr);
      return result;
    },
    progress: marker => markers.push(marker),
    dependencies: {
      now: () => state.time,
      sleep: async ms => { sleeps.push(ms); state.time += ms; },
      lstat: async path => {
        reads.push(path);
        if (state.statError) throw state.statError;
        if (path === dirname(address)) return state.directory;
        assert.equal(path, address);
        if (!state.socket) throw missing();
        return state.socket;
      },
      unlink: async path => {
        assert.equal(path, address); unlinks.push(path); events.push('unlink');
        if (state.unlinkError) {
          if ((state.unlinkError as NodeJS.ErrnoException).code === 'ENOENT') state.socket = undefined;
          throw state.unlinkError;
        }
        if (!state.retainAfterUnlink) state.socket = undefined;
      },
    },
  };
  return { options, state, results, budgets, sleeps, reads, unlinks, markers, events,
    noServer: () => refusal(`no server running on ${address}`),
    noSocket: () => refusal(`error connecting to ${address} (No such file or directory)`) };
}

for (const kind of ['default', 'z404-own-named']) {
  test(`[Z.404.4.1 S01 ${kind}] transition is retried until exact own no-server before unlink`, async () => {
    const f = fixture(kind);
    f.results.push(refusal('server exited unexpectedly'), f.noServer());
    await observeOwnTmuxShutdown(f.options);
    assert.deepEqual(f.budgets, [25, 15]);
    assert.deepEqual(f.sleeps, [10]);
    assert.deepEqual(f.events, ['server exited unexpectedly', f.noServer().stderr, 'unlink']);
    assert.deepEqual(f.unlinks, [f.options.address]);
    assert.equal(f.state.socket, undefined);
    assert.deepEqual(f.markers, ['server-exit:before', 'server-exit:after', 'socket-unlink:before', 'socket-unlink:after']);
    assert.ok(f.reads.includes(dirname(f.options.address)));
    assert.equal(f.reads.at(-1), f.options.address);
  });

  test(`[Z.404.4.1 S02 ${kind}] transition then exact ENOENT requires absent own socket`, async () => {
    const f = fixture(kind); f.state.socket = undefined;
    f.results.push(refusal('server exited unexpectedly'), f.noSocket());
    await observeOwnTmuxShutdown(f.options);
    assert.deepEqual(f.budgets, [25, 15]);
    assert.deepEqual(f.unlinks, []);
    assert.ok(f.reads.length >= 2, 'absence is checked on observation and final cleanup');
    assert.deepEqual(f.markers, ['server-exit:before', 'server-exit:after']);
  });
}

test('[Z.404.4.1 S03] persistent transition exhausts one transitionMs deadline without unlink', async () => {
  const f = fixture();
  await assert.rejects(observeOwnTmuxShutdown(f.options), /cleanup deadline/);
  assert.deepEqual(f.budgets, [25, 15, 5]);
  assert.deepEqual(f.sleeps, [10, 10, 5]);
  assert.equal(f.state.time, 1025);
  assert.deepEqual(f.unlinks, []);
  assert.deepEqual(f.markers, ['server-exit:before']);
});

test('[Z.404.4.1 S04] sessions still visible after kill are polled within the same deadline', async () => {
  const f = fixture();
  f.results.push({ ...success(), stdout: 'probe: 1 windows\n' }, refusal('server exited unexpectedly'), f.noServer());
  await observeOwnTmuxShutdown(f.options);
  assert.deepEqual(f.budgets, [25, 15, 5]);
  assert.deepEqual(f.sleeps, [10, 10]);
  assert.deepEqual(f.unlinks, [f.options.address]);
});

test('[Z.404.4.1 S05] direct exact no-server safely removes the same residual socket', async () => {
  const f = fixture(); f.results.push(f.noServer());
  await observeOwnTmuxShutdown(f.options);
  assert.deepEqual(f.budgets, [25]);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual(f.unlinks, [f.options.address]);
});

test('[Z.404.4.1 S06] exact ENOENT stderr with an existing socket is not shutdown proof', async () => {
  const f = fixture(); f.results.push(f.noSocket());
  await assert.rejects(observeOwnTmuxShutdown(f.options), /missing own socket confirms no server/);
  assert.deepEqual(f.unlinks, []);
});

for (const diagnostic of ['', 'server exited unexpectedly\nunknown', 'permission denied',
  'no server running on /foreign/default', 'error connecting to /foreign/default (No such file or directory)',
  'error connecting to /own/tmux-1000/default (Connection refused)']) {
  test(`[Z.404.4.1 S07 ${JSON.stringify(diagnostic)}] unknown stderr is rejected immediately`, async () => {
    const f = fixture(); f.results.push(refusal(diagnostic), f.noServer());
    await assert.rejects(observeOwnTmuxShutdown(f.options));
    assert.deepEqual(f.budgets, [25]);
    assert.deepEqual(f.sleeps, []);
    assert.deepEqual(f.unlinks, []);
  });
}

const invalidResults: Array<[string, Partial<TmuxShutdownResult>]> = [
  ['timeout', { error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM' }],
  ['spawn failure', { error: Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }), status: null }],
  ['signal', { signal: 'SIGKILL', status: null }],
  ['null status', { status: null }],
  ['unexpected status', { status: 2 }],
  ['no-server with sessions', { stdout: 'probe: 1 windows\n' }],
  ['running with unknown stderr', { status: 0, stderr: 'unknown diagnostic' }],
  ['running with shutdown stderr', { status: 0, stderr: 'server exited unexpectedly' }],
];
for (const [label, override] of invalidResults) {
  test(`[Z.404.4.1 S08 ${label}] incomplete or invalid list-sessions is never accepted or retried`, async () => {
    const f = fixture(); f.results.push({ ...f.noServer(), ...override }, f.noServer());
    await assert.rejects(observeOwnTmuxShutdown(f.options));
    assert.deepEqual(f.budgets, [25]);
    assert.deepEqual(f.sleeps, []);
    assert.deepEqual(f.unlinks, []);
  });
}

for (const [label, override] of invalidResults.slice(0, 5).concat([
  ['nonzero kill', { status: 1 }], ['kill stderr', { stderr: 'unknown diagnostic' }],
])) {
  test(`[Z.404.4.1 S09 ${label}] shutdown polling requires a confirmed successful kill`, async () => {
    const f = fixture(); f.options.killed = { ...success(), ...override };
    await assert.rejects(observeOwnTmuxShutdown(f.options));
    assert.deepEqual(f.budgets, []);
    assert.deepEqual(f.unlinks, []);
    assert.deepEqual(f.markers, []);
  });
}

test('[Z.404.4.1 S10] a command finishing at the shared deadline cannot confirm shutdown', async () => {
  const f = fixture(); f.state.commandMs = 25; f.results.push(f.noServer());
  await assert.rejects(observeOwnTmuxShutdown(f.options), /cleanup deadline/);
  assert.deepEqual(f.budgets, [25]);
  assert.deepEqual(f.unlinks, []);
});

for (const target of ['socket', 'directory'] as const) {
  for (const field of ['dev', 'ino', 'uid', 'mode'] as const) {
    test(`[Z.404.4.1 S11 ${target} ${field}] replaced identity blocks residual unlink`, async () => {
      const f = fixture(); f.results.push(refusal('server exited unexpectedly'), f.noServer());
      const original = target === 'socket' ? f.options.socketIdentity : f.options.directoryIdentity;
      f.state[target] = { ...original, [field]: original[field] + 1 };
      await assert.rejects(observeOwnTmuxShutdown(f.options), new RegExp(`${target} ${field} identity retained`));
      assert.deepEqual(f.budgets, [25, 15]);
      assert.deepEqual(f.unlinks, []);
    });
  }
  test(`[Z.404.4.1 S12 ${target}] a symlink or other replaced file type blocks unlink`, async () => {
    const f = fixture(); f.results.push(f.noServer());
    const original = target === 'socket' ? f.options.socketIdentity : f.options.directoryIdentity;
    f.state[target] = { ...original, isSocket: () => false, isDirectory: () => false };
    await assert.rejects(observeOwnTmuxShutdown(f.options));
    assert.deepEqual(f.unlinks, []);
  });
}

test('[Z.404.4.1 S13] socket cleanup shares the observation deadline and verifies final absence', async () => {
  const f = fixture(); f.state.retainAfterUnlink = true;
  f.results.push(refusal('server exited unexpectedly'), f.noServer());
  await assert.rejects(observeOwnTmuxShutdown(f.options), /cleanup deadline/);
  assert.deepEqual(f.unlinks, [f.options.address]);
  assert.deepEqual(f.sleeps, [10, 10, 5]);
  assert.equal(f.state.time, 1025);
});

test('[Z.404.4.1 S14] disappearing socket between identity check and unlink is accepted only after absence check', async () => {
  const f = fixture(); f.results.push(f.noServer()); f.state.unlinkError = missing();
  await observeOwnTmuxShutdown(f.options);
  assert.deepEqual(f.unlinks, [f.options.address]);
  assert.equal(f.state.socket, undefined);
  assert.equal(f.reads.at(-1), f.options.address);
});

for (const stage of ['stat', 'unlink'] as const) {
  test(`[Z.404.4.1 S15 ${stage}] non-ENOENT filesystem failures are rejected`, async () => {
    const f = fixture(); f.results.push(stage === 'stat' ? f.noSocket() : f.noServer());
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    if (stage === 'stat') f.state.statError = error;
    else f.state.unlinkError = error;
    await assert.rejects(observeOwnTmuxShutdown(f.options));
    assert.equal(f.unlinks.length, stage === 'stat' ? 0 : 1);
  });
}

test('[Z.404.4.1 S16] both drivers use the same observer and live fixture ships its dependency', async () => {
  const direct = await readFile(new URL('./helpers/z404-tool-probe.mjs', import.meta.url), 'utf8');
  const live = await readFile(new URL('./helpers/z4044-live-boundaries.mjs', import.meta.url), 'utf8');
  const stand = await readFile(new URL('./helpers/z4044-live-stand.mjs', import.meta.url), 'utf8');
  for (const source of [direct, live]) {
    assert.match(source, /import \{ observeOwnTmuxShutdown \} from '\.\/z404-tmux-shutdown\.ts'/);
    assert.match(source, /await observeOwnTmuxShutdown\(/);
    assert.match(source, /execute: timeoutMs => execute\(\['list-sessions'\], timeoutMs\)/);
    assert.ok(source.indexOf("execute(['kill-server'])") < source.indexOf('await observeOwnTmuxShutdown('));
  }
  assert.match(stand, /copyFileSync\(path\.join\(here, 'z404-tmux-shutdown\.ts'\), path\.join\(main, 'qa\/z404-tmux-shutdown\.ts'\)\)/);
});

test('[Z.404.4.1 S17] a missing socket alone does not complete the transient server observation', async () => {
  const f = fixture(); f.state.socket = undefined;
  await assert.rejects(observeOwnTmuxShutdown(f.options), /cleanup deadline/);
  assert.deepEqual(f.budgets, [25, 15, 5]);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.unlinks, []);
});

test('[Z.404.4.1 S18] command time reduces both subsequent spawn timeout and polling delay', async () => {
  const f = fixture(); f.state.commandMs = 12;
  await assert.rejects(observeOwnTmuxShutdown(f.options), /cleanup deadline/);
  assert.deepEqual(f.budgets, [25, 3]);
  assert.deepEqual(f.sleeps, [10]);
  assert.deepEqual(f.unlinks, []);
});
