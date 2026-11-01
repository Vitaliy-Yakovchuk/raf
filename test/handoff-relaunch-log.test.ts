import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPersistentWrapper, type LaunchWrapperRequest } from '../src/launch-wrapper.ts';

test('Z.478 second wrapper of the same runId appends to the existing worker.log', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'raf-relaunch-log-'));
  const pids: number[] = [];
  t.after(async () => {
    for (const pid of pids) {
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  const request: LaunchWrapperRequest = {
    tmpRoot: root, statePath: join(root, 'state.sqlite'), cwd: root, runId: 'z478-run', address: 'z478-worker',
    tmuxSession: 'z478-session', selection: { runner: 'codex', model: 'fixture', effort: 'fixture' },
    brief: 'Repeat handoff after serviceEpoch change', readinessTimeoutMs: 2000,
    assignment: { root, baselineArchives: [], changes: [{ id: 'complete-raf-flow-contracts', items: [{ id: 'Z.478', description: 'Relaunch handoff' }] }] },
  };
  const worker = join(root, 'worker.mjs');
  await writeFile(worker, `
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
const request = JSON.parse(await readFile(process.env.RAF_WRAPPER_REQUEST_PATH, 'utf8'));
writeSync(1, process.argv[2]);
const handshake = {
  runId: request.runId,
  address: request.address,
  reportPath: join(request.tmpRoot, request.runId, request.address + '.json'),
  identity: {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runner: request.selection.runner,
    runnerSessionId: 'relaunch-session',
    tmuxSession: request.tmuxSession,
    evidence: { runId: request.runId, command: process.execPath },
  },
};
const socket = connect(process.env.RAF_WRAPPER_HANDSHAKE_SOCKET);
socket.on('error', () => {});
socket.on('connect', () => socket.end(JSON.stringify(handshake) + '\\n'));
setTimeout(() => process.exit(0), 4000).unref();
`);
  const launch = (marker: string) => launchPersistentWrapper(request, {
    workerCommand: { executable: process.execPath, args: [worker, marker] },
    timeoutMs: 3000,
  });
  const first = await launch('epoch-1 wrapper\n');
  pids.push(first.wrapperPid);
  assert.equal(first.runId, request.runId);
  const logPath = join(root, request.runId, 'worker.log');
  assert.equal(await readFile(logPath, 'utf8'), 'epoch-1 wrapper\n');
  let second: Awaited<ReturnType<typeof launch>>;
  try { second = await launch('epoch-2 wrapper\n'); }
  catch (error) { assert.fail(`second wrapper of ${request.runId} must start when worker.log exists and append to it: ${error instanceof Error ? error.message : String(error)}`); }
  pids.push(second.wrapperPid);
  assert.equal(second.runId, request.runId);
  assert.notEqual(second.wrapperPid, first.wrapperPid);
  assert.equal(await readFile(logPath, 'utf8'), 'epoch-1 wrapper\nepoch-2 wrapper\n');
});
