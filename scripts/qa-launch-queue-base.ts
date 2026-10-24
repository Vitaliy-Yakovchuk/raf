import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openStateStore } from '../src/state-store.ts';
import { createAgentQueueState } from '../src/agent-queue-state.ts';
import { storedLaunchQueueIdentity } from '../src/stored-launch-queue-events.ts';
import { createReminderHandlers, settleCommandState } from '../src/reminder-cli.ts';
import { execute } from '../src/cli.ts';
import { startQueueMainStand, queueCommandPorts } from './qa-launch-queue-transport.ts';

const script = fileURLToPath(import.meta.url);
const code = resolve(import.meta.dirname, '..');
const root = resolve(code, '..');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));

if (process.argv[2] === '--worker') {
  const input = JSON.parse(process.argv[3]);
  const store = openStateStore(input.statePath);
  const queue = createAgentQueueState(store);
  const identity = storedLaunchQueueIdentity(store, readFileSync('/etc/machine-id', 'utf8').trim());
  const snapshot = () => ({ queue: store.eventRepository.transaction(tx => tx.loadQueue(identity)),
    pending: store.eventRepository.transaction(tx => tx.listPending()), entries: queue.list(),
    reminders: store.reminderRepository.transaction(tx => tx.list()),
    deliveries: store.reminderRepository.transaction(tx => tx.list().map(item => store.reminderDeliveries.get(item.id)).filter(Boolean)) });
  try {
    if (input.gate) {
      process.send!({ waiting: true });
      while (!existsSync(input.gate)) await delay(10);
    }
    let result: any;
    if (input.operation === 'enqueue') {
      const record: any = { queueId: queue.queueId(identity.stateDomain, identity.machineId), requestId: randomUUID(),
        agentId: `base-${randomUUID()}`, owner: { runId: randomUUID(), fence: randomUUID() },
        clientIdentity: { pid: process.pid, startedAt: new Date().toISOString(), machineId: identity.machineId,
          bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }, coordinator: null, eventHandle: null };
      queue.save({ record, phase: 'waiting', tasks: [], fingerprint: 'controlled-process-qa' });
      result = record;
    } else if (input.operation === 'starting') {
      const entry = queue.get(input.record)!;
      queue.save({ ...entry, phase: 'rechecking' });
      queue.save({ ...entry, phase: 'starting' });
    } else if (input.operation === 'ready') {
      const record = input.record;
      store.taskReservationRepository.transaction(tx => {
        tx.putSession({ runId: record.owner.runId, addressId: record.agentId, revision: 0, state: 'running',
          process: { pid: process.pid, startedAt: new Date().toISOString(), runner: 'qa', runnerSessionId: record.owner.runId,
            tmuxSession: '', evidence: {} } });
        result = queue.confirmReady(tx, record);
      });
      assert.equal(result, true);
    } else if (input.operation === 'cancel') {
      result = queue.remove(input.record, 'cancelled');
    } else if (input.operation === 'remove-ready') {
      result = queue.remove(input.record);
    } else if (input.operation === 'bind' || input.operation === 'close-reminder' || input.operation === 'settle') {
      const ports = await queueCommandPorts(store, input.directory);
      if (input.operation === 'settle') result = await settleCommandState(ports);
      else {
        const argv = input.operation === 'bind'
          ? ['reminder', 'add', '--to', 'main', '--at', '2099-01-01T00:00:00Z', '--text', `Base QA ${input.action}`,
            '--event', 'launch-queue.drained', '--event-id', input.queueId, '--event-action', input.action]
          : ['reminder', 'close', '--id', input.id, '--reason', 'Base QA cleanup'];
        result = await execute(argv, json(join(code, 'dist/catalog.json')), createReminderHandlers(ports));
        assert.equal(result.exitCode, 0, result.stderr);
      }
    } else if (input.operation !== 'snapshot') throw new Error(`Unknown operation ${input.operation}`);
    process.send!({ pid: process.pid, result, ...snapshot() });
  } catch (error) {
    process.send!({ error: String(error), stack: (error as Error).stack });
    process.exitCode = 1;
  } finally { store.close(); }
  if (input.hold && !process.exitCode) await new Promise<void>(done => process.once('message', () => done()));
  process.disconnect?.();
} else {
  const output = resolve(process.argv[2]);
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync('/tmp/raf-queue-base-');
  const home = join(directory, 'home');
  mkdirSync(home);
  const statePath = join(directory, 'state.sqlite');
  const evidence: any = { assignment: 'fix-raf-load-admission:6.3', command: [process.execPath, script, output],
    environment: { platform: process.platform, os: release(), node: process.version, directory, home, statePath,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: code, encoding: 'utf8' }),
      configurationHashes: Object.fromEntries(['raf-constants.json', 'flow.json', 'raf.json'].map(name => [name,
        createHash('sha256').update(readFileSync(join(root, 'conf', name))).digest('hex')])) },
    limitations: ['Controlled lightweight launch records use real production SQLite queue save/confirmReady/remove; resource refusal and provider startup are not exercised by this event-focused stand.'],
    invocations: [], scenarios: [], serviceStarted: false };
  const children: any[] = [];
  let stand: any;
  function worker(operation: string, extra: any = {}) {
    const input = { operation, statePath, directory, ...extra };
    const child = fork(script, ['--worker', JSON.stringify(input)], { env: { PATH: process.env.PATH,
      HOME: home, RAF_QA_HOME: home, LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout!.on('data', value => { stdout += value; });
    child.stderr!.on('data', value => { stderr += value; });
    let waitingResolve: any, resultResolve: any, resultReject: any;
    const waiting = new Promise(done => { waitingResolve = done; });
    const result = new Promise<any>((done, fail) => { resultResolve = done; resultReject = fail; });
    child.on('message', (message: any) => {
      if (message.waiting) waitingResolve(message);
      else if (message.error) resultReject(new Error(message.stack ?? message.error));
      else resultResolve(message);
    });
    const completed = new Promise<any>(done => child.once('close', (exitCode, signal) => {
      const row = { executable: process.execPath, argv: [script, '--worker', JSON.stringify(input)], pid: child.pid,
        exitCode, signal, stdout, stderr };
      evidence.invocations.push(row);
      if (exitCode !== 0) resultReject(new Error(`Worker ${operation}: ${exitCode} ${signal} ${stderr}`));
      done(row);
    }));
    return { child, waiting, result, completed };
  }
  async function run(operation: string, extra: any = {}) {
    const item = worker(operation, extra);
    const result = await item.result;
    const done = await item.completed;
    assert.equal(done.exitCode, 0);
    return result;
  }
  const facts = (row: any) => row.pending.filter((fact: any) => fact.event.kind === 'launch-queue.drained');
  async function scenario(name: string, body: () => Promise<any>) {
    const started = Date.now();
    try { const details = await body(); evidence.scenarios.push({ name, exitCode: 0, durationMs: Date.now() - started, details }); }
    catch (error) { evidence.scenarios.push({ name, exitCode: 1, error: String(error), stack: (error as Error).stack }); throw error; }
    finally { writeFileSync(join(output, 'process.json'), JSON.stringify(evidence, null, 2) + '\n'); }
  }
  try {
    stand = await startQueueMainStand(directory);
    const store = openStateStore(statePath);
    store.sessionRepository.transaction(tx => tx.putSession({ runId: stand.runId, addressId: 'main', revision: 0,
      state: 'running', process: stand.identity }));
    store.close();
    evidence.main = { runId: stand.runId, identity: stand.identity, socket: stand.socket };
    await scenario('readiness-before-agent-completion-real-activate-close-and-repeated-fact', async () => {
      const queued = await run('enqueue');
      const record = queued.result;
      assert.equal(facts(queued).length, 0);
      const activate = JSON.parse((await run('bind', { action: 'activate', queueId: record.queueId })).result.stdout);
      const close = JSON.parse((await run('bind', { action: 'close', queueId: record.queueId })).result.stdout);
      const started = await run('starting', { record });
      assert.equal(facts(started).length, 0);
      const ready = worker('ready', { record, hold: true });
      const confirmed = await ready.result;
      assert.equal(facts(confirmed).length, 1);
      const fact = facts(confirmed)[0];
      assert.deepEqual(fact.data, { queueId: record.queueId, generation: record.eventHandle.generation, started: 1, cancelled: 0, failed: 0 });
      process.kill(ready.child.pid!, 0);
      const delivered = await run('settle');
      assert.deepEqual(delivered.result.delivered, [activate.id]);
      assert.equal(delivered.reminders.find((item: any) => item.id === close.id)?.state, 'closed');
      assert.equal(facts(delivered).length, 0);
      for (let tries = 0; (await stand.received()).length < 1; tries++) {
        assert.ok(tries < 100, 'tmux recipient did not consume the delivered reminder');
        await delay(20);
      }
      const receiptsBefore = await stand.received();
      await run('ready', { record });
      await run('settle');
      const receiptsAfter = await stand.received();
      assert.deepEqual(receiptsAfter, receiptsBefore);
      process.kill(ready.child.pid!, 0);
      ready.child.send('finish');
      assert.equal((await ready.completed).exitCode, 0);
      await run('remove-ready', { record });
      await run('close-reminder', { id: activate.id });
      await run('settle');
      return { queueId: record.queueId, fact, activate, close, delivered: delivered.result,
        receipts: receiptsAfter, deliveryConfirmations: delivered.deliveries, closedReminder: delivered.reminders.find((item: any) => item.id === close.id), agentAliveAtDelivery: true, serviceStarted: false };
    });
    await scenario('restart-and-cancelled-last-entry', async () => {
      const a = await run('enqueue');
      const id = a.result.queueId;
      const activate = JSON.parse((await run('bind', { action: 'activate', queueId: id })).result.stdout);
      const cancelled = await run('cancel', { record: a.result });
      assert.equal(cancelled.result, true);
      const restarted = await run('snapshot');
      assert.deepEqual(facts(restarted), facts(cancelled));
      const fact = facts(restarted)[0];
      assert.deepEqual(fact.data, { queueId: id, generation: a.result.eventHandle.generation, started: 0, cancelled: 1, failed: 0 });
      const settled = await run('settle');
      assert.deepEqual(settled.result.delivered, [activate.id]);
      assert.equal((await run('cancel', { record: a.result })).result, false);
      assert.deepEqual((await run('settle')).result.delivered, []);
      await run('close-reminder', { id: activate.id });
      await run('settle');
      return { fact, delivered: settled.result, restart: 'all writes and reads made by separate OS processes', receipts: await stand.received() };
    });
    await scenario('concurrent-enqueue-and-last-confirmed-start', async () => {
      const races: any[] = [];
      for (let index = 0; index < 6; index++) {
        const a = (await run('enqueue')).result;
        await run('starting', { record: a });
        const gate = join(directory, `race-${index}`);
        const enqueue = worker('enqueue', { gate });
        const ready = worker('ready', { record: a, gate });
        await Promise.all([enqueue.waiting, ready.waiting]);
        writeFileSync(gate, 'go');
        const [b, confirmed] = await Promise.all([enqueue.result, ready.result]);
        assert.equal((await enqueue.completed).exitCode, 0);
        assert.equal((await ready.completed).exitCode, 0);
        const after = await run('snapshot');
        const sameGeneration = b.result.eventHandle.generation === a.eventHandle.generation;
        assert.equal(facts(after).length, sameGeneration ? 0 : 1);
        assert.equal(after.queue.entries.length, 1);
        await run('starting', { record: b.result });
        const last = await run('ready', { record: b.result });
        const pending = facts(last);
        assert.equal(pending.length, sameGeneration ? 1 : 2);
        assert.equal(pending.reduce((sum: number, fact: any) => sum + fact.data.started, 0), 2);
        assert.equal(new Set(pending.map((fact: any) => fact.key)).size, pending.length);
        await run('ready', { record: a });
        assert.deepEqual(facts(await run('snapshot')), pending);
        await run('remove-ready', { record: a });
        await run('remove-ready', { record: b.result });
        await run('settle');
        assert.equal(facts(await run('snapshot')).length, 0);
        races.push({ first: a.eventHandle, second: b.result.eventHandle, sameGeneration, facts: pending,
          workerPids: [b.pid, confirmed.pid], noDuplicate: true });
      }
      return { races, receiptsUnchangedWithoutBindings: await stand.received() };
    });
    const final = await run('snapshot');
    assert.equal(final.entries.length, 0);
    assert.equal(final.queue.entries.length, 0);
    assert.equal(final.pending.length, 0);
    assert.equal(final.reminders.filter((item: any) => item.state !== 'closed').length, 0);
    evidence.final = final;
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.outcome = 'failed'; evidence.error = String(error); evidence.stack = (error as Error).stack;
    process.exitCode = 1;
  } finally {
    await Promise.all(children.filter(item => item.exitCode === null && item.signalCode === null).map(item =>
      new Promise<void>(done => { item.once('close', () => done()); item.kill('SIGKILL'); })));
    const standCleanup = await stand?.stop();
    evidence.cleanup = { children: children.map(item => ({ pid: item.pid, exitCode: item.exitCode, signal: item.signalCode })),
      standStopped: true, standCleanup, temporaryDirectoryRemoved: false };
    rmSync(directory, { recursive: true, force: true });
    evidence.cleanup.temporaryDirectoryRemoved = !existsSync(directory);
    writeFileSync(join(output, 'process.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ outcome: evidence.outcome, scenarios: evidence.scenarios.map((item: any) => ({ name: item.name, exitCode: item.exitCode })), cleanup: evidence.cleanup }));
  }
}
