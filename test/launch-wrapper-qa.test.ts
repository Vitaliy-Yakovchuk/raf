import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPersistentWrapper, runLaunchWrapper } from '../src/launch-wrapper.ts';
import type { LaunchWrapperRequest } from '../src/launch-wrapper.ts';

const timeout = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8')).unitTests.timeoutMs;

for (const mode of ['valid', 'malformed', 'foreign-run', 'foreign-report', 'foreign-evidence']) {
  test(`QA: persistent wrapper private IPC and ${mode} handshake from owned temporary process`, { timeout }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'raf-wrapper-qa-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const observation = join(root, 'observation.json');
    const completed = join(root, 'completed');
    const worker = join(root, 'worker.mjs');
    const request: LaunchWrapperRequest = {
      tmpRoot: root, statePath: join(root, 'state.sqlite'), cwd: root, runId: 'qa-run', address: 'qa-worker',
      tmuxSession: 'qa-session', selection: { runner: 'codex', model: 'fixture', effort: 'fixture' },
      brief: 'Private fixture brief', readinessTimeoutMs: 2000,
      assignment: { root, baselineArchives: [], changes: [{ id: 'fixture', items: [{ id: '1.1', description: 'Fixture' }] }] },
    };
    await writeFile(worker, `
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connect } from 'node:net';
const requestPath = process.env.RAF_WRAPPER_REQUEST_PATH;
const socketPath = process.env.RAF_WRAPPER_HANDSHAKE_SOCKET;
const request = JSON.parse(await readFile(requestPath, 'utf8'));
const permissions = await Promise.all([dirname(requestPath), requestPath, socketPath].map(async path => (await stat(path)).mode & 0o777));
await writeFile(${JSON.stringify(observation)}, JSON.stringify({ permissions, request, requestPath, socketPath, pid: process.pid }));
const handshake = { runId: request.runId, address: request.address, reportPath: join(request.tmpRoot, request.runId, request.address + '.json'), identity: { pid: process.pid, startedAt: new Date().toISOString(), runner: request.selection.runner, runnerSessionId: 'fixture-session', tmuxSession: request.tmuxSession, evidence: { runId: request.runId, command: process.execPath } } };
const mode = ${JSON.stringify(mode)};
if (mode === 'foreign-run') handshake.runId = 'different-run';
if (mode === 'foreign-report') handshake.reportPath = join(request.tmpRoot, 'different-run', request.address + '.json');
if (mode === 'foreign-evidence') handshake.identity.evidence.runId = 'different-run';
const socket = connect(socketPath);
socket.on('error', () => {});
socket.on('connect', () => socket.write((mode === 'malformed' ? '{' : JSON.stringify(handshake)) + '\\n'));
socket.on('close', async () => { await writeFile(${JSON.stringify(completed)}, 'closed'); process.exit(0); });
setTimeout(() => process.exit(2), 4000).unref();
`);
    const launching = launchPersistentWrapper(request, { workerCommand: { executable: process.execPath, args: [worker] }, timeoutMs: 3000 });
    if (mode === 'valid') {
      const result = await launching;
      assert.equal(result.runId, request.runId);
      assert.equal(result.identity.runnerSessionId, 'fixture-session');
      assert.equal(result.wrapperPid, result.identity.pid);
    } else {
      await assert.rejects(launching, /Wrapper launch qa-run failed:.*(?:SyntaxError|Handshake does not match)/);
    }
    const actual = JSON.parse(await readFile(observation, 'utf8'));
    assert.deepEqual(actual.permissions, [0o700, 0o600, 0o600]);
    assert.deepEqual(actual.request, request);
    await assert.rejects(readFile(actual.requestPath), { code: 'ENOENT' });
    await assert.rejects(readFile(actual.socketPath), { code: 'ENOENT' });
    let closed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { closed = await readFile(completed, 'utf8') === 'closed'; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(closed, true, 'owned fixture process closed its handshake socket');
  });
}


test('QA: report sink failure retains report bytes and recoverable lifecycle state after child exit', { timeout }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'raf-wrapper-sink-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request: LaunchWrapperRequest = {
    tmpRoot: root, statePath: join(root, 'state.sqlite'), cwd: root, runId: 'qa-run', address: 'qa-worker',
    tmuxSession: 'qa-session', selection: { runner: 'codex', model: 'fixture', effort: 'fixture' }, brief: 'Fixture', readinessTimeoutMs: 2000,
    assignment: { root, baselineArchives: [], changes: [{ id: 'fixture', items: [{ id: '1.1', description: 'Fixture' }] }] },
  };
  const report = JSON.stringify({ status: 'succeeded', answer: 'Done', changes: [{ id: 'fixture', items: [{ id: '1.1', status: 'succeeded' }] }] });
  const identity = { pid: process.pid, startedAt: new Date().toISOString(), runner: 'codex', runnerSessionId: 'fixture-session', tmuxSession: request.tmuxSession, evidence: { runId: request.runId, command: process.execPath } };
  let reportPath = '';
  const failures: unknown[] = [];
  let finished = false;
  await assert.rejects(runLaunchWrapper(request, {
    transport: {
      startWithoutInput: async (_request, path) => { reportPath = path; },
      waitReady: async () => ({ state: 'ready', runnerSessionId: identity.runnerSessionId }),
      ownership: async () => ({ state: 'owned', identity, processKind: 'agent' }),
      deliver: async () => { await writeFile(reportPath, report); },
      waitExit: async () => ({ code: 0, signal: null }),
      stop: async () => { assert.fail('exited fixture does not need termination'); },
    },
    report: {
      fs: {
        mkdir: async path => { await mkdir(path, { recursive: true }); },
        readText: async path => { try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
        removeTree: async path => { await rm(path, { recursive: true, force: true }); },
      },
      watch: () => () => {}, now: () => new Date().toISOString(),
      verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }), diagnostic: async () => {},
    },
    lifecycle: {
      started: async () => {}, acceptReport: async () => { throw new Error('sink unavailable'); },
      finish: async () => { finished = true; },
      failed: async (runId, reason, recoverable) => { failures.push({ runId, reason, recoverable }); },
    },
    handshake: async () => {},
  }), /sink unavailable/);
  assert.equal(finished, false);
  assert.deepEqual(failures, [{ runId: request.runId, reason: 'sink unavailable', recoverable: true }]);
  assert.equal(await readFile(reportPath, 'utf8'), report);
});
