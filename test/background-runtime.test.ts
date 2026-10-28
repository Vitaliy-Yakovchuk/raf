import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBackgroundRuntime, type ServiceFailure, type ServiceStatus } from '../src/background-runtime.ts';

const moduleUrl = new URL('../src/background-runtime.ts', import.meta.url).href;

async function fixture(t: TestContext, mode = 'normal') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-host-')));
  const main = join(root, 'raf-main');
  const develop = join(root, 'raf-develop');
  const stateDirectory = join(root, 'state');
  const socketPath = join(root, 'service.sock');
  await Promise.all([mkdir(main), mkdir(develop), mkdir(stateDirectory)]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  execFileSync('git', ['init', '-q', '-b', 'develop', develop]);
  const log = join(root, 'events.jsonl');
  const entry = `
import { appendFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { runServiceHost } from ${JSON.stringify(moduleUrl)};
const log = async value => appendFile(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
await log({ event: 'spawn', pid: process.pid, cwd: process.cwd() });
let recovery = Promise.resolve();
const host = await runServiceHost({
  stateDirectory: ${JSON.stringify(stateDirectory)},
  socketPath: ${JSON.stringify(socketPath)},
  handlers: {
    recover: async bootstrap => {
      if (${JSON.stringify(mode)} === 'gated') {
        const wait = once(process, 'message', bootstrap?.signal ? { signal: bootstrap.signal } : undefined).catch(error => {
          if (bootstrap?.signal?.aborted) return [];
          throw error;
        });
        recovery = wait.then(() => {});
        process.send?.({ event: 'recover-blocked' });
        await wait;
        if (bootstrap?.signal?.aborted) return;
      }
      if (${JSON.stringify(mode)} === 'fail') throw new Error('fixture recovery failed');
      await log({ event: 'recovered' });
    },
    resourceWait: async () => {},
    handle: async (request, context) => {
      await log({ event: 'request', operation: request.operation });
      if (request.operation === 'crash') {
        process.stderr.write('fixture crash reason\\n');
        process.exit(17);
      }
      if (request.operation === 'hold') {
        process.send?.({ event: 'holding' });
        await once(context.signal, 'abort');
        await log({ event: 'canceled', clientId: context.clientId });
        return { canceled: true };
      }
      return { source: 'main', payload: request.payload };
    },
    shutdown: async () => {
      await recovery;
      if (${JSON.stringify(mode)} === 'slow-shutdown') {
        process.send?.({ event: 'shutdown-started' });
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      await log({ event: 'shutdown' });
    },
  },
});
await host.closed;
process.disconnect?.();
`;
  await writeFile(join(main, 'host.ts'), entry);
  await writeFile(join(develop, 'host.ts'), 'throw new Error("develop must never execute");\n');
  const children: ChildProcess[] = [];
  const spawned = Promise.withResolvers<ChildProcess>();
  const options = { stateDirectory, socketPath, entryRelativePath: 'host.ts', readinessTimeoutMs: 2000 };
  const dependencies = {
    resolveMainPath: async () => main,
    nodeExecutable: process.execPath,
    spawn: ((command, args, settings) => {
      const child = spawn(command, args, {
        ...settings,
        env: { ...settings?.env, HOME: root, RAF_QA_HOME: root },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      spawned.resolve(child);
      return child;
    }) as typeof spawn,
  };
  t.after(async () => {
    try {
      await createBackgroundRuntime(options, dependencies).stop();
    } catch {}
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const runtime = createBackgroundRuntime(options, dependencies);
  return {
    root, main, develop, log, options, dependencies, children, runtime, spawned,
    events: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
}

function ready(result: ServiceStatus | ServiceFailure) {
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  if (result.exitCode !== 0) assert.fail(result.reason);
  assert.equal(result.state, 'ready');
  assert.ok(result.pid && result.pid > 0);
  return result;
}

function failed(result: { exitCode: number }) {
  assert.notEqual(result.exitCode, 0);
  const diagnostic = result as ServiceFailure;
  assert.ok(diagnostic.reason.trim());
  assert.ok(diagnostic.details.trim());
  assert.ok(diagnostic.remediation.trim());
}

test('start uses configured main and remains available after empty work and completed request', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const initial = ready(await f.runtime.start());
  assert.equal(initial.mainPath, f.main);
  assert.equal(ready(await f.runtime.start()).pid, initial.pid);
  assert.deepEqual(await f.runtime.request({ operation: 'echo', payload: 'one' }), {
    exitCode: 0, value: { source: 'main', payload: 'one' },
  });
  assert.equal(ready(await f.runtime.status()).pid, initial.pid);
  assert.deepEqual(await f.runtime.request({ operation: 'echo', payload: 'two' }), {
    exitCode: 0, value: { source: 'main', payload: 'two' },
  });
  const spawns = (await f.events()).filter(event => event.event === 'spawn');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cwd, f.main);
});

test('independent concurrent clients share one process and wait until recovery handshake completes', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'gated');
  const second = createBackgroundRuntime(f.options, f.dependencies);
  let completed = 0;
  const firstCall = f.runtime.ensureReady().then(value => { completed++; return value; });
  const secondCall = second.request({ operation: 'echo', payload: 2 });
  const child = await f.spawned.promise;
  const [message] = await once(child, 'message');
  assert.deepEqual(message, { event: 'recover-blocked' });
  assert.equal(completed, 0);
  assert.equal((await f.events()).filter(event => event.event === 'request').length, 0);
  child.send({ event: 'continue' });
  ready(await firstCall);
  assert.equal((await secondCall).exitCode, 0);
  assert.equal((await f.events()).filter(event => event.event === 'spawn').length, 1);
});

test('missing main fails without executing available develop tree', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await rm(f.main, { recursive: true });
  const result = await f.runtime.request({ operation: 'echo', payload: null });
  failed(result);
  assert.match(JSON.stringify(result), /main/i);
  assert.equal(f.children.length, 0);
});

test('failed recovery and readiness timeout return actionable errors, never successful acceptance', { timeout: 10_000 }, async t => {
  const failedFixture = await fixture(t, 'fail');
  const failure = await failedFixture.runtime.ensureReady();
  failed(failure);
  assert.match(JSON.stringify(failure), /fixture recovery failed/);
  const gated = await fixture(t, 'gated');
  const timeout = await gated.runtime.request({ operation: 'echo', payload: null });
  failed(timeout);
  assert.match(JSON.stringify(timeout), /ready|readiness|готов/i);
  assert.equal((await gated.events()).filter(event => event.event === 'request').length, 0);
});

test('stop preserves agent and reminder state, distinguishes normal stop, and status does not restart', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const records = join(f.options.stateDirectory, 'owned-records.json');
  const contents = JSON.stringify({ agents: [{ id: 'alive', pid: process.pid }], reminders: [{ id: 'pending', closed: false }] });
  await writeFile(records, contents);
  ready(await f.runtime.start());
  const stopped = await f.runtime.stop();
  assert.equal(stopped.exitCode, 0);
  if (stopped.exitCode !== 0) assert.fail(stopped.reason);
  assert.equal(stopped.state, 'stopped');
  const status = await f.runtime.status();
  assert.equal(status.exitCode, 0);
  if (status.exitCode !== 0) assert.fail(status.reason);
  assert.equal(status.state, 'stopped');
  assert.equal(status.reasonKnown, true);
  assert.equal(await readFile(records, 'utf8'), contents);
  assert.equal((await f.events()).filter(event => event.event === 'spawn').length, 1);
  assert.equal((await f.events()).filter(event => event.event === 'shutdown').length, 1);
});

test('crash fails in-flight operation and a fresh client reports actual failure instead of stale ready state', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  ready(await f.runtime.start());
  const child = f.children[0];
  const exited = once(child, 'exit');
  failed(await f.runtime.request({ operation: 'crash', payload: null }));
  await exited;
  const fresh = createBackgroundRuntime(f.options, f.dependencies);
  const status = await fresh.status();
  assert.equal(status.exitCode, 0);
  if (status.exitCode !== 0) assert.fail(status.reason);
  assert.equal(status.state, 'failed');
  assert.equal(status.reasonKnown, true);
  assert.match(status.stopReason ?? '', /fixture crash reason|17/);
  const response = await fresh.request({ operation: 'echo', payload: 'restart' });
  assert.equal(response.exitCode, 0);
  assert.equal((await f.events()).filter(event => event.event === 'recovered').length, 2);
});

test('canceling a socket request propagates caller loss to host queue handler', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  ready(await f.runtime.start());
  const holding = once(f.children[0], 'message');
  const controller = new AbortController();
  const request = f.runtime.request({ operation: 'hold', payload: null }, { signal: controller.signal });
  const [message] = await holding;
  assert.deepEqual(message, { event: 'holding' });
  controller.abort(new Error('external timeout'));
  failed(await request);
  await f.runtime.stop();
  assert.equal((await f.events()).filter(event => event.event === 'canceled').length, 1);
});

test('separate command processes coordinate startup through shared state and socket', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const clientPath = join(f.root, 'client.ts');
  await writeFile(clientPath, `
import { createBackgroundRuntime } from ${JSON.stringify(moduleUrl)};
const runtime = createBackgroundRuntime(${JSON.stringify(f.options)}, {
  resolveMainPath: async () => ${JSON.stringify(f.main)},
  nodeExecutable: process.execPath,
});
const result = await runtime.request({ operation: 'echo', payload: process.pid });
process.stdout.write(JSON.stringify(result));
process.exitCode = result.exitCode;
`);
  const clients = [spawn(process.execPath, [clientPath], { stdio: ['ignore', 'pipe', 'pipe'] }), spawn(process.execPath, [clientPath], { stdio: ['ignore', 'pipe', 'pipe'] })];
  f.children.push(...clients);
  const results = await Promise.all(clients.map(async client => {
    let output = '';
    client.stdout!.setEncoding('utf8');
    client.stdout!.on('data', chunk => { output += chunk; });
    const [code] = await once(client, 'exit');
    assert.equal(code, 0);
    return JSON.parse(output);
  }));
  for (const result of results) assert.equal(result.exitCode, 0);
  assert.equal((await f.events()).filter(event => event.event === 'spawn').length, 1);
  assert.equal((await f.runtime.stop()).exitCode, 0);
});

test('service start waits for an owner that already received stop and is still shutting down, then starts ready with a new serviceEpoch', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'slow-shutdown');
  const first = ready(await f.runtime.start());
  const firstChild = f.children[0];
  const shutdownStarted = once(firstChild, 'message');
  const shortStop = createBackgroundRuntime({ ...f.options, readinessTimeoutMs: 250 }, f.dependencies).stop();
  const [message] = await shutdownStarted;
  assert.deepEqual(message, { event: 'shutdown-started' });
  failed(await shortStop);
  assert.equal(firstChild.exitCode, null);
  const restarted = ready(await f.runtime.start());
  assert.equal(restarted.state, 'ready');
  assert.notEqual(restarted.pid, first.pid);
  assert.ok(restarted.serviceEpoch);
  assert.notEqual(restarted.serviceEpoch, first.serviceEpoch);
  assert.notEqual(firstChild.exitCode, null);
  assert.equal((await f.events()).filter(event => event.event === 'spawn').length, 2);
});

test('service stop during startup recovery on isolated QA HOME interrupts recovery and leaves service stopped instead of stopping', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'gated');
  const second = createBackgroundRuntime(f.options, f.dependencies);
  const startCall = f.runtime.start();
  const child = await f.spawned.promise;
  const [message] = await once(child, 'message');
  assert.deepEqual(message, { event: 'recover-blocked' });
  const stopped = await second.stop();
  const persisted = JSON.parse(await readFile(join(f.options.stateDirectory, 'service.json'), 'utf8'));
  if (child.connected) child.send({ event: 'continue' });
  const started = await startCall;
  assert.equal(stopped.exitCode, 0, JSON.stringify({ stopped, persisted }));
  if (stopped.exitCode !== 0) assert.fail(stopped.reason);
  assert.equal(stopped.state, 'stopped');
  failed(started);
  assert.equal(persisted.state, 'stopped');
  const status = await second.status();
  assert.equal(status.exitCode, 0);
  if (status.exitCode !== 0) assert.fail(status.reason);
  assert.equal(status.state, 'stopped');
  assert.notEqual(child.exitCode, null);
  assert.equal((await f.events()).filter(event => event.event === 'recovered').length, 0);
  assert.equal((await f.events()).filter(event => event.event === 'shutdown').length, 1);
});
