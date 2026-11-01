import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createBackgroundRuntime } from '../src/background-runtime.ts';
import { readResourceWaitProtocolOptions } from '../src/resource-wait-protocol.ts';

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(process.env.RAF_STOP_HOST_ORCHESTRATOR_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)));
const constants = JSON.parse(await readFile(join(root, 'conf/raf-constants.json'), 'utf8'));
const raf = JSON.parse(await readFile(join(root, 'conf/raf.json'), 'utf8'));
const options = readResourceWaitProtocolOptions({ constants, raf });
const fixture = 'test/helpers/resource-wait-stop-host-fixture.ts';

async function waitForFile(path: string, client: ChildProcess): Promise<unknown> {
  const deadline = Date.now() + options.readinessTimeoutMs;
  while (Date.now() < deadline) {
    assert.equal(client.exitCode, null, 'resource wait client must remain alive before service stop');
    assert.equal(client.signalCode, null, 'resource wait client must not be killed before service stop');
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(10);
  }
  assert.fail(`Fixture did not establish the waiting precondition: ${path}`);
}

for (const level of constants.resourceWaitLevels.map((entry: { id: string }) => entry.id)) {
  test(`[resource-wait/service-stop-host] real service stop delivers service_stopped and client exits 1 (${level})`, {
    timeout: options.readinessTimeoutMs * 4,
  }, async context => {
    const temporary = await mkdtemp('/tmp/raf-stop-host-');
    const home = join(temporary, 'home');
    const state = join(home, 'state');
    const socket = join(temporary, 'service.sock');
    await mkdir(state, { recursive: true });
    const overrides = {
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local/state'),
      RAF_MAIN_PATH: workspace,
      RAF_STOP_HOST_FIXTURE: JSON.stringify({ root, workspace, home, state, socket, level }),
    };
    const environment = { ...process.env, ...overrides };
    let hostProcess: ChildProcess | undefined;
    let client: ChildProcess | undefined;
    let hostOutput = '';
    let clientOutput = '';
    let clientErrors = '';
    const abortChildren = () => {
      for (const child of [client, hostProcess]) {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    };
    context.signal.addEventListener('abort', abortChildren, { once: true });
    const runtime = createBackgroundRuntime({
      stateDirectory: state, socketPath: socket, entryRelativePath: fixture,
      readinessTimeoutMs: options.readinessTimeoutMs,
    }, {
      resolveMainPath: async () => workspace,
      spawn: ((executable, argv, spawnOptions) => {
        hostProcess = spawn(executable, argv, {
          ...spawnOptions, env: { ...spawnOptions?.env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        hostProcess.stdout?.on('data', chunk => { hostOutput += chunk; });
        hostProcess.stderr?.on('data', chunk => { hostOutput += chunk; });
        return hostProcess;
      }) as typeof spawn,
    });
    try {
      const started = await runtime.start();
      assert.equal(started.exitCode, 0, JSON.stringify(started) + '\n' + hostOutput);
      if (started.exitCode !== 0) return;
      assert.equal(started.state, 'ready');
      assert.ok(started.serviceEpoch, 'host must advertise its actual epoch');
      assert.ok(hostProcess?.pid && hostProcess.pid !== process.pid, 'host must run outside the test process');
      client = spawn(process.execPath, [join(workspace, fixture), 'client'], {
        cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
      });
      client.stdout!.on('data', chunk => { clientOutput += chunk; });
      client.stderr!.on('data', chunk => { clientErrors += chunk; });
      const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        client!.once('error', reject);
        client!.once('close', (code, signal) => resolve({ code, signal }));
      });
      const ticket = await waitForFile(join(state, 'client-enqueued.json'), client) as { serviceEpoch: string };
      assert.equal(ticket.serviceEpoch, started.serviceEpoch);
      const snapshot = await waitForFile(join(state, 'no-resources.json'), client) as {
        measurement: { availableRamBytes: number; memoryPressure: string };
      };
      assert.equal(snapshot.measurement.availableRamBytes, 0);
      assert.equal(snapshot.measurement.memoryPressure, 'critical');
      assert.equal(client.exitCode, null, 'no permit may complete the client before stop');

      const stopped = await runtime.stop();
      assert.equal(stopped.exitCode, 0, JSON.stringify(stopped) + '\n' + hostOutput);
      if (stopped.exitCode === 0) assert.equal(stopped.state, 'stopped');
      const exit = await completed;
      assert.equal(exit.signal, null, clientErrors);
      assert.equal(exit.code, 1, clientErrors + '\n' + clientOutput);
      const output = JSON.parse(clientOutput.trim());
      assert.equal(output.result.exitCode, 1);
      assert.equal(output.result.kind, 'error');
      assert.equal(output.result.diagnostic.reason, 'service_stopped');
      assert.ok(output.received.some((message: any) =>
        message.kind === 'result' && message.result.kind === 'error'
        && message.result.diagnostic.reason === 'service_stopped'),
      'service_stopped must arrive through the real socket before connection close');
      assert.equal(output.received.some((message: any) => message.kind === 'offer'), false);
      const status = await runtime.status();
      assert.equal(status.exitCode, 0);
      if (status.exitCode === 0) assert.equal(status.state, 'stopped');
    } finally {
      context.signal.removeEventListener('abort', abortChildren);
      for (const child of [client, hostProcess]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
          child.kill('SIGKILL');
          await closed;
        }
      }
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

for (const workload of ['agent', 'test'] as const) {
  test(`[resource-wait/service-stop-host] ${workload} waiter survives stop then symlink swap then new generation start`, async context => {
    const temporary = await mkdtemp('/tmp/raf-rejoin-');
    const home = join(temporary, 'home');
    const state = join(home, 'state');
    const socket = join(temporary, 'service.sock');
    const active = join(temporary, 'main');
    const generations = [join(temporary, 'generation-1'), join(temporary, 'generation-2')];
    await mkdir(state, { recursive: true });
    for (const [index, generation] of generations.entries()) {
      await mkdir(generation);
      await symlink(join(workspace, 'test'), join(generation, 'test'));
      await writeFile(join(generation, 'generation.json'), JSON.stringify(index + 1));
    }
    await symlink(generations[0], active);
    const environment = {
      ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
      RAF_STOP_HOST_FIXTURE: JSON.stringify({ root, workspace, home, state, socket, level: 'hotfix', restart: true, workload }),
    };
    const children: ChildProcess[] = [];
    let output = '';
    let errors = '';
    const runtime = createBackgroundRuntime({ stateDirectory: state, socketPath: socket, entryRelativePath: fixture, readinessTimeoutMs: options.readinessTimeoutMs }, {
      resolveMainPath: async () => realpath(active),
      spawn: ((executable, argv, settings) => {
        const child = spawn(executable, argv, { ...settings, env: { ...settings?.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stderr?.on('data', chunk => { errors += chunk; });
        children.push(child);
        return child;
      }) as typeof spawn,
    });
    const abortChildren = () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    context.signal.addEventListener('abort', abortChildren, { once: true });
    try {
      const first = await runtime.start();
      assert.equal(first.exitCode, 0, JSON.stringify(first) + errors);
      assert.ok(first.exitCode === 0 && first.serviceEpoch);
      const client = spawn(process.execPath, [join(workspace, fixture), 'client'], { cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(client);
      client.stdout!.on('data', chunk => { output += chunk; });
      client.stderr!.on('data', chunk => { errors += chunk; });
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        client.once('error', reject);
        client.once('close', (code, signal) => resolve({ code, signal }));
      });
      const firstTicket = await waitForFile(join(state, 'client-enqueued.json'), client) as { serviceEpoch: string };
      assert.equal(firstTicket.serviceEpoch, first.serviceEpoch);
      await waitForFile(join(state, 'no-resources.json'), client);
      const stopped = await runtime.stop();
      assert.equal(stopped.exitCode, 0, JSON.stringify(stopped) + errors);
      await waitForFile(join(state, 'client-waiting-for-replacement.json'), client);
      assert.equal(client.exitCode, null, 'client must survive the interval between stop and swap');
      assert.equal(await realpath(active), generations[0]);
      await symlink(generations[1], join(temporary, 'next'));
      await rename(join(temporary, 'next'), active);
      assert.equal(await realpath(active), generations[1]);
      assert.equal(client.exitCode, null, 'swapping the symlink alone must not finish the client');
      const second = await runtime.start();
      assert.equal(second.exitCode, 0, JSON.stringify(second) + errors);
      assert.ok(second.exitCode === 0 && second.serviceEpoch);
      assert.notEqual(second.serviceEpoch, first.serviceEpoch);
      const exit = await completion;
      assert.deepEqual(exit, { code: 0, signal: null }, errors + output);
      const received = JSON.parse(output);
      assert.equal(received.result.kind, 'permit');
      assert.equal(received.result.permit.serviceEpoch, second.serviceEpoch);
      assert.ok(received.received.some((message: any) => message.kind === 'result' && message.result.kind === 'error' && message.result.diagnostic.reason === 'service_stopped'));
      assert.equal(received.received.some((message: any) => message.kind === 'offer' && message.offer.serviceEpoch === first.serviceEpoch), false);
      const oldHost = JSON.parse(await readFile(join(state, 'host-generation-1.json'), 'utf8'));
      const newHost = JSON.parse(await readFile(join(state, 'host-generation-2.json'), 'utf8'));
      assert.notEqual(oldHost.pid, newHost.pid);
      assert.equal(newHost.serviceEpoch, second.serviceEpoch);
      assert.equal((await runtime.stop()).exitCode, 0, errors);
    } finally {
      context.signal.removeEventListener('abort', abortChildren);
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
          child.kill('SIGKILL');
          await closed;
        }
      }
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
