import test from 'node:test';
import assert from 'node:assert/strict';
import { retryStateOperation } from '../src/state-store.ts';
import { ServiceLifecycleController } from '../src/service-lifecycle.ts';
import { ResourceWaitServiceStarter } from '../src/resource-wait-protocol.ts';

test('SQLite contention can resolve after the warning threshold', async () => {
  let attempts = 0;
  const value = await retryStateOperation(() => {
    if (++attempts < 4) throw Object.assign(new Error('busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    return 'written';
  }, { transitionMs: 1, pollMs: 2 });
  assert.equal(value, 'written');
  assert.equal(attempts, 4);
});

test('service readiness accepts a verified live owner after its warning threshold', async () => {
  let now = 0;
  const identity = { pid: 1, startedAt: 'start', machineId: 'machine', bootId: 'boot' };
  const record = { pid: 1, identity, serviceEpoch: 'epoch', mainPath: '/main', state: 'ready', stopReason: null };
  const runtime = new ServiceLifecycleController({ stateDirectory: '/state', socketPath: '/socket', entryRelativePath: 'bin/service.ts', readinessTimeoutMs: 5 }, {
    now: () => now, exclusive: async (_deadline, action) => action(),
    readRecord: async () => record, observe: async () => 'alive',
    handshake: async () => { now = 20; return { ...record, exclusiveOwner: true, databaseOpen: true, lastGrantLoaded: true, resourceWaitReady: true }; },
  } as any);
  const result = await runtime.ensureReady();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal((result as any).serviceEpoch, 'epoch');
});

test('resource readiness keeps waiting beyond its warning threshold without a second start', async () => {
  let now = 0;
  let starts = 0;
  const endpoint = { endpoint: 'fixture://service', serviceEpoch: 'epoch' };
  const starter = new ResourceWaitServiceStarter({ readinessTimeoutMs: 5 }, {
    monotonicNow: () => now,
    handshake: async () => now >= 15 ? { kind: 'ready', endpoint, ownsFence: true, stateValidated: true, acceptsEnqueue: true } : { kind: 'unavailable', reason: 'starting' },
    acquireStartLease: async () => ({ release: async () => {} }),
    startMain: async () => { starts++; },
    waitForChange: async () => { now += 5; },
  } as any);
  assert.deepEqual(await starter.ensureReady(), endpoint);
  assert.equal(starts, 1);
});

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';
import { command } from '../src/hotfix-host.ts';
import { runTestRun } from '../src/test-runs.ts';
import { RunHarness, policy, flushMicrotasks } from './helpers/test-run-fixture.ts';

async function temporary(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'raf-timeout-warning-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('Codex hook discovery waits for a slow child response', async t => {
  const root = await temporary(t);
  const executable = join(root, 'codex');
  await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume(); setTimeout(() => console.log('no hook protocol'), 30);\n`, { mode: 0o700 });
  const prepared = await prepareCodexRafCommandAccess({ invocation: { executable, args: ['--sandbox', 'workspace-write'] }, scope: { excludedCommands: ['raf agent ps'], hidden: [], readable: [], tmuxDirectory: root }, cwd: root, runDirectory: root, environment: process.env, timeoutMs: 1 } as any);
  try { assert.match(prepared.unavailable ?? '', /does not speak/); }
  finally { await prepared.cleanup(); }
});

test('hotfix non-test command is not killed by the unit test time limit', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'conf'));
  await writeFile(join(root, 'conf/flow.json'), JSON.stringify({ unitTests: { timeoutMs: 1 } }));
  const result = await command({ orchestratorRoot: root, qaHome: root } as any, root, process.execPath, ['-e', 'setTimeout(() => console.log("finished"), 30)']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.stdout.trim(), 'finished');
});

test('integration child is not terminated when its warning threshold passes', async () => {
  const h = new RunHarness();
  const file = 'test/service-integration.test.ts';
  const group = 'add-raf-test-run/slow-integration';
  h.context.integrationTests = { timeoutMs: 5 };
  h.context.agentPhases.push('integration');
  h.config.phases.integration = structuredClone(h.config.phases.implement);
  const { unitFiles, ...profile } = h.config.projects.raf.profiles.node;
  h.config.projects.raf.profiles.integration = { ...profile, testKind: 'integration', integrationFiles: [file] };
  h.config.projects.raf.groups[group] = { profileId: 'integration', files: [file] };
  h.environment.files[file] = { kind: 'file', realpath: `${h.context.workspace}/${file}`, unit: false, testKind: 'integration' };
  h.events = [{ kind: 'passed', test: { file, name: 'scenario' } }, { kind: 'complete', expected: [{ file, name: 'scenario' }] }];
  h.finishImmediately = false;
  const pending = runTestRun({ project: 'raf', phase: 'integration', group }, h.config, policy, h.context, h.ports);
  await flushMicrotasks();
  h.clock.advance(20);
  await flushMicrotasks();
  const killed = h.cleanupCalls.some(call => call.reason === 'timeout');
  h.resolveExit?.({ exitCode: 0, signal: null, stderr: '' });
  const result = await pending;
  assert.equal(killed, false);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.timedOut, false);
  assert.equal(result.timeoutCount, 0);
});

import { DatabaseSync } from 'node:sqlite';
import { openBugStore } from '../src/bug-store.ts';

test('bug store WAL initialization retries transient contention beyond five attempts', async t => {
  const root = await temporary(t);
  const original = DatabaseSync.prototype.prepare;
  let attempts = 0;
  DatabaseSync.prototype.prepare = function(sql: string, ...args: any[]) {
    if (sql === 'PRAGMA journal_mode' && ++attempts <= 6) throw Object.assign(new Error('busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    return Reflect.apply(original, this, [sql, ...args]);
  } as any;
  try {
    const repository = openBugStore(join(root, 'bugs.sqlite'));
    repository.close();
    assert.equal(attempts, 7);
  } finally { DatabaseSync.prototype.prepare = original; }
});

import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { readWaitIdentity, verifyWaitPeer } from '../src/resource-wait-identity.ts';

test('service peer verification waits for a slow helper without discarding identity checks', async t => {
  const root = await temporary(t);
  const helper = join(root, 'python3');
  await writeFile(helper, `#!${process.execPath}\nsetTimeout(() => console.log(process.ppid + ' ' + process.getuid()), 30);\n`, { mode: 0o700 });
  const server = createServer();
  server.listen(join(root, 'peer.sock'));
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = createConnection(join(root, 'peer.sock'));
  const [peer] = await accepted;
  const saved = process.env.PATH;
  process.env.PATH = root + ':' + saved;
  try {
    const identity = await readWaitIdentity(process.pid);
    await verifyWaitPeer(client, identity, 1);
    await assert.rejects(verifyWaitPeer(client, { ...identity, pid: identity.pid + 1 }, 1), /does not match Unix peer credentials/);
  } finally {
    process.env.PATH = saved;
    client.destroy(); peer.destroy(); server.close();
  }
});
