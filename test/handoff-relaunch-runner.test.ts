import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPersistentWrapper, type LaunchWrapperRequest } from '../src/launch-wrapper.ts';

test('Z.478 second wrapper of the same runId replaces a leftover tmux session and reaches readiness', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'raf-relaunch-runner-'));
  const socket = join(root, 'tmux.sock');
  const runner = join(root, 'runner.mjs');
  const worker = join(root, 'worker.mjs');
  const pids: number[] = [];
  const tmux = (args: string[]) => spawnSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  t.after(async () => {
    tmux(['kill-server']);
    for (const pid of pids) {
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(runner, "process.stdout.write('RUNNER_READY\\n'); setInterval(() => {}, 1000);\n");
  const adapterUrl = new URL('../src/agent-adapters.ts', import.meta.url).href;
  await writeFile(worker, `
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { TmuxAgentAdapter } from ${JSON.stringify(adapterUrl)};
const socket = ${JSON.stringify(socket)};
const runner = ${JSON.stringify(runner)};
const tmux = (args) => spawnSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
const execute = async (command) => {
  const result = command.executable === 'tmux' ? tmux(command.args) : spawnSync(command.executable, command.args, { encoding: 'utf8', input: command.stdin });
  return { exitCode: result.status === null ? 1 : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
const request = JSON.parse(await readFile(process.env.RAF_WRAPPER_REQUEST_PATH, 'utf8'));
if (process.argv[2] === 'epoch-1') {
  const created = tmux(['new-session', '-d', '-s', request.tmuxSession, 'sh', '-c', 'exit 7', ';', 'set-option', '-p', '-t', '=' + request.tmuxSession + ':0.0', 'remain-on-exit', 'on']);
  if (created.status !== 0) throw new Error(created.stderr || created.stdout || 'leftover session was not created');
  setInterval(() => {}, 1000);
} else {
  const protocol = {
    invocation: () => ({ executable: process.execPath, args: [runner] }),
    observe: (text) => text.includes('RUNNER_READY') ? { status: 'ready', cliSessionId: 'relaunch-ready' } : { status: 'starting' },
  };
  const adapter = new TmuxAgentAdapter({ execute, protocols: { codex: protocol, grok: protocol, agy: protocol, claude: protocol } });
  const session = await adapter.startWithoutInput({ selection: request.selection, tmuxSession: request.tmuxSession, cwd: request.cwd, reportWrapper: { wrap: (value) => value } });
  let observation = await adapter.inspect(session);
  for (let attempt = 0; observation.status !== 'ready' && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    observation = await adapter.inspect(session);
  }
  if (observation.status !== 'ready') throw new Error('Runner session did not reach readiness: ' + JSON.stringify(observation));
  const handshake = {
    runId: request.runId,
    address: request.address,
    reportPath: join(request.tmpRoot, request.runId, request.address + '.json'),
    identity: {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runner: request.selection.runner,
      runnerSessionId: 'relaunch-ready',
      tmuxSession: request.tmuxSession,
      evidence: { runId: request.runId, command: process.execPath },
    },
  };
  const peer = JSON.parse(await readFile(process.env.RAF_WRAPPER_REQUEST_PATH + '.peer', 'utf8'));
  const channel = connect(process.env.RAF_WRAPPER_HANDSHAKE_SOCKET);
  channel.on('error', () => {});
  await new Promise((resolve, reject) => {
    channel.once('connect', () => channel.end(JSON.stringify({ ...handshake, wrapperPeer: { pid: process.pid, nonce: peer.nonce } }) + '\\n', () => resolve()));
    channel.once('error', reject);
  });
  setInterval(() => {}, 1000);
}
`);
  const request: LaunchWrapperRequest = {
    tmpRoot: root, statePath: join(root, 'state.sqlite'), cwd: root, runId: 'z478-run', address: 'z478-worker',
    tmuxSession: 'z478-session', selection: { runner: 'grok', model: 'fixture', effort: 'fixture' },
    brief: 'Repeat handoff after serviceEpoch change', readinessTimeoutMs: 2000,
    assignment: { root, baselineArchives: [], changes: [{ id: 'fix-raf-handoff-relaunch-runner', items: [{ id: '1.1', description: 'Relaunch runner' }] }] },
  };
  const launch = (marker: string, signal?: AbortSignal) => launchPersistentWrapper(request, {
    workerCommand: { executable: process.execPath, args: [worker, marker] },
    timeoutMs: 3000,
    signal,
  });
  const epoch = new AbortController();
  const first = launch('epoch-1', epoch.signal);
  let leftover = false;
  for (let attempt = 0; attempt < 50 && !leftover; attempt += 1) {
    leftover = tmux(['has-session', '-t', `=${request.tmuxSession}`]).status === 0;
    if (!leftover) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(leftover, true, 'handoff must leave the runner tmux session before serviceEpoch changes');
  const dead = tmux(['display-message', '-p', '-t', `=${request.tmuxSession}:0.0`, '#{pane_dead}|#{pane_dead_status}']);
  assert.equal(dead.stdout.trim(), '1|7', 'an early runner exit keeps the session name');
  epoch.abort();
  await assert.rejects(first, /Launch client interrupted|Worker exited before readiness/);
  assert.equal(tmux(['has-session', '-t', `=${request.tmuxSession}`]).status, 0, 'aborting the handoff wrapper must not drop the leftover session');
  let second: Awaited<ReturnType<typeof launch>>;
  try { second = await launch('epoch-2'); }
  catch (error) { assert.fail(`second wrapper of ${request.runId} must create the runner session and reach readiness: ${error instanceof Error ? error.message : String(error)}`); }
  pids.push(second.wrapperPid);
  assert.equal(second.runId, request.runId);
  const pane = tmux(['display-message', '-p', '-t', `=${request.tmuxSession}:0.0`, '#{pane_dead}|#{pane_current_command}']);
  assert.equal(pane.status, 0, pane.stderr);
  assert.equal(pane.stdout.trim(), '0|node');
  const screen = tmux(['capture-pane', '-p', '-t', `=${request.tmuxSession}:0.0`]);
  assert.match(screen.stdout, /RUNNER_READY/);
});
