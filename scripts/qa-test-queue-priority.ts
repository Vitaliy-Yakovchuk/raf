import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { productionResourceWait } from '../src/production-resource-wait.ts';
import { runServiceHost } from '../src/background-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import { createResourceSnapshotReader, readMachineBootIdentity } from '../src/os-runtime.ts';
import { readWaitIdentity } from '../src/resource-wait-identity.ts';
import { readResourceWaitProtocolOptions, runResourceWaitCommand } from '../src/resource-wait-protocol.ts';
import { connectResourceWait } from '../src/resource-wait-transport.ts';

const code = resolve(import.meta.dirname, '..');
const root = resolve(code, '..');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const options = readResourceWaitProtocolOptions({ constants: read(join(root, 'conf/raf-constants.json')), raf: read(join(root, 'conf/raf.json')) });

if (process.argv[2] === '--client') {
  const [directory, name, level, workload] = process.argv.slice(3);
  const endpoint = read(join(directory, 'endpoint.json'));
  const identity = await readWaitIdentity();
  const result = await runResourceWaitCommand({ level, workload: workload as 'test' | 'agent', developmentDirectory: directory, clientIdentity: identity, connectionId: '' }, options, {
    ensureReady: async () => endpoint,
    connect: async target => {
      const connection = await connectResourceWait(target);
      return { ...connection, enqueue: async request => {
        const ticket = await connection.enqueue(request);
        write(join(directory, `${name}.enqueued.json`), { ticket, identity, level, workload, at: Date.now() });
        return ticket;
      } };
    },
    recordDuration: () => {},
  });
  write(join(directory, `${name}.result.json`), result);
  if (result.kind === 'permit') write(join(directory, `${name}.started.json`), { at: Date.now(), pid: process.pid, permit: result.permit });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.exitCode;
} else {
  const output = resolve(process.argv[2]);
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync('/tmp/raf-priority-qa-');
  const store = openStateStore(join(directory, 'state.sqlite'));
  const machine = await readMachineBootIdentity();
  const policy = read(join(root, 'conf/flow.json'));
  const reader = createResourceSnapshotReader({ machineId: machine.machineId, paths: [root, directory, homedir()] });
  let stage: 'blocked' | 'hotfix' | 'all' = 'blocked';
  const samples: unknown[] = [];
  const resourceReader = { read: async () => {
    const snapshot = await reader.read();
    const normalized = stage === 'blocked' ? policy.resources.hotfix.maxNormalizedLoad + 1
      : stage === 'hotfix' ? (policy.resources.normal.maxNormalizedLoad + policy.resources.hotfix.maxNormalizedLoad) / 2 : 0;
    const actualLoad = snapshot.measurement.loadAverage1m;
    snapshot.measurement.loadAverage1m = normalized * snapshot.measurement.availableCores;
    samples.push({ stage, at: Date.now(), actualLoad, injectedLoad: snapshot.measurement.loadAverage1m, reasons: snapshot.reasons });
    return snapshot;
  } };
  const runtime = await productionResourceWait({ orchestratorRoot: root } as any, options, () => store, resourceReader);
  let host: Awaited<ReturnType<typeof runServiceHost>> | undefined;
  const clients: { name: string; child: ReturnType<typeof spawn>; done: Promise<any> }[] = [];
  const evidence: any = {
    environment: { node: process.version, os: release(), platform: process.platform, code, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(), directory },
    options,
    limitations: ['Process-level service subscenario only: real Unix sockets, peer PID checks, SQLite, OS identities and clocks. The measured load is replaced at the resource-reader seam to select NO_RESOURCES/HOTFIX_ONLY/ANY_RUN deterministically.', 'Clients use the production resource-wait API and record a start receipt after permit. This does not exercise a trusted CLI test assignment, test wrapper reservation, test execution, or an actual AI agent launch; those remain required separately.'],
    samples, invocations: [], assertions: [], outcome: 'failed',
  };
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 90000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `Stand guard expired: ${label}`);
      await new Promise(done => setTimeout(done, 40));
    }
  };
  const start = (name: string, level: string, workload: string) => {
    const args = [import.meta.filename, '--client', directory, name, level, workload];
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, HOME: directory, LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const done = new Promise<any>(resolve => child.once('close', (exitCode, signal) => {
      writeFileSync(join(output, `${name}.stdout.json`), stdout);
      writeFileSync(join(output, `${name}.stderr`), stderr);
      const result = { name, executable: process.execPath, args, exitCode, signal, pid: child.pid };
      evidence.invocations.push(result); resolve(result);
    }));
    clients.push({ name, child, done });
  };
  try {
    host = await runServiceHost({ stateDirectory: directory, socketPath: join(directory, 'service.sock'), handlers: {
      recover: async bootstrap => { await runtime.start(bootstrap!.serviceEpoch); },
      resourceWait: runtime.attach, handle: async () => null, shutdown: runtime.stop,
    } });
    const record = read(join(directory, 'service.json'));
    write(join(directory, 'endpoint.json'), { endpoint: join(directory, 'service.sock'), serviceEpoch: record.token });
    start('normal-agent', 'normal', 'agent');
    await until(() => existsSync(join(directory, 'normal-agent.enqueued.json')), 'normal agent queued first');
    start('hotfix-test', 'hotfix', 'test');
    await until(() => existsSync(join(directory, 'hotfix-test.enqueued.json')), 'hotfix test queued second');
    assert.equal(existsSync(join(directory, 'normal-agent.started.json')), false);
    assert.equal(existsSync(join(directory, 'hotfix-test.started.json')), false);
    evidence.assertions.push('Both real client processes remain pending while NO_RESOURCES');
    stage = 'hotfix';
    await until(() => existsSync(join(directory, 'hotfix-test.started.json')), 'hotfix test permit under HOTFIX_ONLY');
    assert.equal(existsSync(join(directory, 'normal-agent.started.json')), false);
    evidence.assertions.push('Later hotfix test receives permit while older normal agent remains pending under HOTFIX_ONLY');
    stage = 'all';
    await until(() => existsSync(join(directory, 'normal-agent.started.json')), 'normal agent permit under ANY_RUN');
    for (const client of clients) assert.equal((await client.done).exitCode, 0);
    evidence.receipts = Object.fromEntries(clients.map(({ name }) => [name, { enqueue: read(join(directory, `${name}.enqueued.json`)), started: read(join(directory, `${name}.started.json`)), result: read(join(directory, `${name}.result.json`)) }]));
    const hotfix = evidence.receipts['hotfix-test'].started.permit;
    const normal = evidence.receipts['normal-agent'].started.permit;
    assert.ok(normal.grantedAt - hotfix.grantedAt >= options.grantIntervalMs);
    evidence.assertions.push('Global configured permit interval preserved; both API clients exit 0');
    evidence.lastGrant = store.readResourceWaitGrant();
    evidence.outcome = 'passed-service-subscenario';
  } catch (error) {
    evidence.error = String(error); evidence.stack = (error as Error).stack;
    process.exitCode = 1;
  } finally {
    for (const client of clients) if (client.child.exitCode === null) client.child.kill('SIGTERM');
    await Promise.all(clients.map(client => client.done));
    await host?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    evidence.cleanup = { directoryRemoved: !existsSync(directory), remainingPids: clients.filter(client => client.child.exitCode === null && client.child.signalCode === null).map(client => client.child.pid) };
    write(join(output, 'service-process.json'), evidence);
  }
  process.stdout.write(JSON.stringify({ outcome: evidence.outcome, assertions: evidence.assertions, cleanup: evidence.cleanup, error: evidence.error }) + '\n');
}
