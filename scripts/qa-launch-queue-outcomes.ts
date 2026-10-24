import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openStateStore } from '../src/state-store.ts';
import { createStoredLaunchQueueEvents } from '../src/stored-launch-queue-events.ts';
import { createAgentQueueState } from '../src/agent-queue-state.ts';
import { reconcileFinishedAgentQueues } from '../src/production-agent-queue.ts';
import { readWaitIdentity } from '../src/resource-wait-identity.ts';
import { createReminderHandlers, settleCommandState } from '../src/reminder-cli.ts';
import { execute } from '../src/cli.ts';
import { startQueueMainStand, queueCommandPorts } from './qa-launch-queue-transport.ts';
import type { AgentQueueRecord } from '../src/agent-run-queue.ts';
import type { LaunchQueueFailure } from '../src/launch-queue-events.ts';
import type { CompiledCatalog } from '../src/catalog.ts';

const codeRoot = resolve(import.meta.dirname, '..');
const compiled = JSON.parse(readFileSync(join(codeRoot, 'dist/catalog.json'), 'utf8')) as CompiledCatalog;

async function worker(directory: string, input: any) {
  const store = openStateStore(join(directory, 'state.sqlite'));
  try {
    const identity = { stateDomain: join(directory, 'state.sqlite'), machineId: (await readWaitIdentity()).machineId };
    const queue = createStoredLaunchQueueEvents(store, identity);
    const state = createAgentQueueState(store);
    const entries = () => state.transaction(() => state.list());
    const entry = () => {
      const found = entries().find(row => row.record.agentId === input.label);
      assert.ok(found, `Missing queue entry ${input.label}`);
      return found;
    };
    let result: unknown = null;
    if (input.action === 'init') {
      store.sessionRepository.transaction(tx => tx.putSession({ runId: input.main.runId, addressId: 'main', state: 'running', revision: 1, process: input.main.identity }));
    } else if (input.action === 'enqueue') {
      for (const label of input.labels) {
        const record: AgentQueueRecord = { queueId: queue.queueId(), requestId: randomUUID(), agentId: label,
          owner: { runId: randomUUID(), fence: randomUUID() }, clientIdentity: input.client, coordinator: null, eventHandle: null };
        state.save({ record, phase: 'waiting', tasks: [], fingerprint: 'qa-6.7' });
      }
    } else if (input.action === 'ready') {
      const queued = entry();
      state.save({ ...queued, phase: 'starting' });
      state.transaction(tx => {
        tx.putSession({ runId: queued.record.owner.runId, addressId: input.label, state: 'running', revision: 1, process: input.process });
        assert.equal(state.confirmReady(tx, queued.record), true);
      });
      assert.equal(state.remove(queued.record), true);
      result = queued.record;
    } else if (input.action === 'terminal') {
      const queued = entry();
      assert.equal(state.remove({ ...queued.record, owner: { ...queued.record.owner, fence: 'stale-fence' } }, input.reason), false);
      assert.equal(state.remove(queued.record, input.reason), true);
      result = queued.record;
    } else if (input.action === 'reconcile') {
      const before = entries();
      const cleaned: string[] = [];
      await reconcileFinishedAgentQueues({ store,
        current: runId => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read'),
        observe: async () => { throw new Error('Unready client cleanup must not probe a runner'); },
        cleanReport: async runId => { cleaned.push(runId); },
      });
      result = { cleaned, removed: before.filter(row => !entries().some(next => next.record.requestId === row.record.requestId)).map(row => row.record) };
    } else if (input.action === 'replay') {
      const record = input.record as AgentQueueRecord;
      assert.ok(record.eventHandle);
      queue.confirmReady(record.eventHandle);
      for (const reason of ['cancelled', 'client-died', 'launch-failed'] as const) queue.fail(record.eventHandle, reason);
      assert.equal(state.remove(record), false);
    } else if (input.action === 'bind') {
      const ports = await queueCommandPorts(store, directory);
      const reminders = [];
      for (const action of ['activate', 'close']) {
        const argv = ['reminder', 'add', '--to', 'main', '--at', '2099-01-01T00:00:00Z', '--text', `${input.label}-${action}`,
          '--event', 'launch-queue.drained', '--event-id', queue.queueId(), '--event-action', action];
        const cli = await execute(argv, compiled, createReminderHandlers(ports));
        assert.equal(cli.exitCode, 0, cli.stderr);
        reminders.push({ argv, ...cli, reminder: JSON.parse(cli.stdout) });
      }
      result = reminders;
    } else if (input.action === 'settle') {
      result = await settleCommandState(await queueCommandPorts(store, directory));
    } else if (input.action !== 'snapshot') throw new Error(`Unknown QA action ${input.action}`);
    return { action: input.action, pid: process.pid, result,
      queue: store.eventRepository.transaction(tx => tx.loadQueue(identity)),
      entries: entries(), pending: store.eventRepository.transaction(tx => tx.listPending()),
      reminders: store.reminderRepository.transaction(tx => tx.list()),
      deliveries: store.reminderRepository.transaction(tx => tx.list().map(reminder => store.reminderDeliveries.get(reminder.id)).filter(Boolean)),
      sessions: store.sessionRepository.transaction(tx => tx.listSessions().map(row => ({ runId: row.runId, addressId: row.addressId, state: row.state })), 'read'),
    };
  } finally { store.close(); }
}

if (process.argv[2] === '--worker') {
  const result = await worker(process.argv[3], JSON.parse(process.argv[4]));
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  const evidence = resolve(process.argv[2]);
  mkdirSync(evidence, { recursive: true });
  const directory = mkdtempSync('/tmp/fla67-process-');
  mkdirSync(join(directory, 'tmp'));
  const operations: any[] = [];
  const scenarios: any[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  let main: Awaited<ReturnType<typeof startQueueMainStand>> | undefined;
  const report: any = { outcome: 'failed', command: [process.execPath, process.argv[1], evidence], scenarios, operations,
    environment: { os: process.platform, node: process.version, isolatedState: join(directory, 'state.sqlite'), serviceStarted: false, transport: 'real tmux / production services / synthetic main receiver' } };
  const environment = { PATH: process.env.PATH!, HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), TERM: 'xterm', LANG: 'C.UTF-8' };
  let sequence = 0;
  const step = (input: any) => {
    const args = [process.argv[1], '--worker', directory, JSON.stringify(input)];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', env: environment, maxBuffer: 8 * 1024 * 1024 });
    const prefix = `${String(++sequence).padStart(3, '0')}-${input.action}`;
    writeFileSync(join(evidence, prefix + '.stdout.json'), run.stdout);
    writeFileSync(join(evidence, prefix + '.stderr'), run.stderr);
    const operation = { prefix, executable: process.execPath, argv: args, cliExitCode: run.status, signal: run.signal, stdout: prefix + '.stdout.json', stderr: prefix + '.stderr' };
    operations.push(operation);
    assert.ifError(run.error);
    assert.equal(run.status, 0, `${prefix}: ${run.stderr}`);
    assert.equal(run.signal, null);
    return JSON.parse(run.stdout);
  };
  const liveChild = async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', "console.log('ready');setInterval(()=>{},1000)"], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await once(child.stdout!, 'data');
    const identity = await readWaitIdentity(child.pid!);
    const observed = spawnSync('ps', ['-ww', '-p', String(child.pid), '-o', 'lstart=,args='], { encoding: 'utf8' });
    assert.equal(observed.status, 0, observed.stderr);
    const row = observed.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    assert.ok(row);
    return { child, identity, processIdentity: { pid: child.pid!, startedAt: new Date(row[1]).toISOString(), runner: 'qa',
      runnerSessionId: 'live-agent', tmuxSession: '', evidence: { command: row[2], machineId: identity.machineId, bootId: identity.bootId } } };
  };
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  };
  const totals = (snapshot: any, expected: any) => {
    assert.deepEqual({ started: snapshot.queue.started, cancelled: snapshot.queue.cancelled, failed: snapshot.queue.failed }, expected);
  };
  const facts = (snapshot: any) => snapshot.pending.filter((fact: any) => fact.event.kind === 'launch-queue.drained');
  const expectFact = (snapshot: any, generation: number, expected: any) => {
    const fact = facts(snapshot).find((fact: any) => fact.data.generation === generation);
    assert.ok(fact);
    assert.deepEqual(fact, { key: JSON.stringify(['launch-queue.drained', snapshot.queue.queueId, generation]),
      event: { kind: 'launch-queue.drained', id: snapshot.queue.queueId }, data: { queueId: snapshot.queue.queueId, generation, ...expected } });
    return fact;
  };
  const deliver = async (bindings: any[], expectedCount: number) => {
    const settled = step({ action: 'settle' });
    assert.equal(settled.reminders.find((r: any) => r.id === bindings[0].reminder.id).state, 'active');
    assert.equal(settled.reminders.find((r: any) => r.id === bindings[1].reminder.id).state, 'closed');
    assert.equal(settled.deliveries.length, expectedCount);
    assert.equal(settled.result.undelivered.length, 0);
    assert.equal(settled.pending.length, 0);
    for (let attempt = 0; attempt < 100 && main!.received().length < expectedCount; attempt++) await delay(10);
    assert.equal(main!.received().length, expectedCount);
    assert.equal(main!.received().at(-1).text, `[raf] Reminder ${bindings[0].reminder.id}: ${bindings[0].reminder.text}`);
    assert.ok(settled.deliveries.every((r: any) => r.receiptId));
    return { settled, received: main!.received() };
  };
  try {
    main = await startQueueMainStand(directory);
    const init = step({ action: 'init', main: { runId: main.runId, identity: main.identity } });
    totals(init, { started: 0, cancelled: 0, failed: 0 });
    assert.equal(facts(init).length, 0);
    const live = await liveChild();
    const dead = await liveChild();
    const client = await readWaitIdentity();
    step({ action: 'enqueue', labels: ['mixed-ready', 'mixed-cancel', 'mixed-failure'], client });
    const queued = step({ action: 'enqueue', labels: ['mixed-dead'], client: dead.identity });
    const bindings = step({ action: 'bind', label: 'mixed' }).result;
    const ready = step({ action: 'ready', label: 'mixed-ready', process: live.processIdentity });
    report.readyProcess = { identity: live.identity, process: live.processIdentity };
    const cancelled = step({ action: 'terminal', label: 'mixed-cancel', reason: 'cancelled' });
    await stop(dead.child);
    const died = step({ action: 'reconcile' });
    assert.equal(died.result.cleaned.length, 1);
    totals(died, { started: 1, cancelled: 1, failed: 1 });
    assert.equal(facts(died).length, 0);
    const restarted = step({ action: 'snapshot' });
    assert.deepEqual(restarted.queue, died.queue);
    const mixed = step({ action: 'terminal', label: 'mixed-failure', reason: 'launch-failed' });
    const mixedFact = expectFact(mixed, queued.queue.generation, { started: 1, cancelled: 1, failed: 2 });
    const delivered = await deliver(bindings, 1);
    assert.equal(delivered.settled.sessions.find((row: any) => row.addressId === 'mixed-ready').state, 'running');
    assert.equal((await readWaitIdentity(live.child.pid!)).startedAt, live.identity.startedAt);
    for (const record of [ready.result, cancelled.result, died.result.removed[0], mixed.result]) {
      const replayed = step({ action: 'replay', record });
      totals(replayed, { started: 1, cancelled: 1, failed: 2 });
      assert.equal(facts(replayed).length, 0);
    }
    const repeat = step({ action: 'settle' });
    assert.deepEqual(repeat.result.delivered, []);
    assert.equal(main.received().length, 1);
    scenarios.push({ name: 'mixed generation, persisted intermediate failure, restart, last launch-failed, real activate/close, ready agent still alive, duplicate terminals', exitCode: 0, fact: mixedFact, deliveries: delivered.settled.deliveries });

    let count = 1;
    for (const reason of ['cancelled', 'client-died', 'launch-failed'] as LaunchQueueFailure[]) {
      const dying = reason === 'client-died' ? await liveChild() : null;
      const fresh = step({ action: 'enqueue', labels: [`zero-${reason}`], client: dying?.identity ?? client });
      totals(fresh, { started: 0, cancelled: 0, failed: 0 });
      assert.equal(fresh.queue.queueId, mixed.queue.queueId);
      const bound = step({ action: 'bind', label: `zero-${reason}` }).result;
      let finished;
      if (dying) { await stop(dying.child); finished = step({ action: 'reconcile' }); assert.equal(finished.result.cleaned.length, 1); }
      else finished = step({ action: 'terminal', label: `zero-${reason}`, reason });
      const expected = { started: 0, cancelled: reason === 'cancelled' ? 1 : 0, failed: reason === 'cancelled' ? 0 : 1 };
      const fact = expectFact(finished, fresh.queue.generation, expected);
      const delivery = await deliver(bound, ++count);
      const record = dying ? finished.result.removed[0] : finished.result;
      step({ action: 'replay', record });
      const duplicate = step({ action: 'settle' });
      assert.deepEqual(duplicate.result.delivered, []);
      assert.equal(main.received().length, count);
      scenarios.push({ name: `last ${reason} with started=0; new generation zero totals; bindings and repeated fact`, exitCode: 0, fact, deliveries: delivery.settled.deliveries });
    }

    const first = step({ action: 'enqueue', labels: ['before-terminal'], client });
    const extended = step({ action: 'enqueue', labels: ['enqueued-before'], client });
    assert.equal(extended.queue.generation, first.queue.generation);
    const interim = step({ action: 'terminal', label: 'before-terminal', reason: 'cancelled' });
    assert.equal(facts(interim).length, 0);
    const drained = step({ action: 'terminal', label: 'enqueued-before', reason: 'launch-failed' });
    const beforeFact = expectFact(drained, first.queue.generation, { started: 0, cancelled: 1, failed: 1 });
    const next = step({ action: 'enqueue', labels: ['enqueued-after'], client });
    assert.equal(next.queue.generation, first.queue.generation + 1);
    totals(next, { started: 0, cancelled: 0, failed: 0 });
    assert.deepEqual(facts(next), facts(drained));
    const nextDrain = step({ action: 'terminal', label: 'enqueued-after', reason: 'cancelled' });
    const afterFact = expectFact(nextDrain, next.queue.generation, { started: 0, cancelled: 1, failed: 0 });
    assert.equal(facts(nextDrain).length, 2);
    const reopenPending = step({ action: 'snapshot' });
    assert.deepEqual(facts(reopenPending), facts(nextDrain));
    const unbound = step({ action: 'settle' });
    assert.deepEqual(unbound.result.delivered, []);
    assert.equal(unbound.deliveries.length, count);
    assert.equal(unbound.pending.length, 0);
    assert.equal(main.received().length, count);
    assert.equal(unbound.entries.length, 0);
    assert.equal(unbound.queue.entries.length, 0);
    assert.equal(unbound.reminders.length, count * 2);
    scenarios.push({ name: 'enqueue before and after terminal, two independent pending generations through process restart, no binding / no extra direct main message', exitCode: 0, facts: [beforeFact, afterFact], deliveries: unbound.deliveries });
    report.mainMessages = main.received();
    report.outcome = 'passed';
  } catch (error) {
    report.error = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack };
    process.exitCode = 1;
  } finally {
    for (const child of children) await stop(child);
    report.cleanup = { main: main ? await main.stop() : null, childProcesses: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode })), serviceStarted: false };
    rmSync(directory, { recursive: true, force: true });
    report.cleanup.temporaryStateRemoved = !existsSync(directory);
    writeFileSync(join(evidence, 'process.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ outcome: report.outcome, scenarios: scenarios.length, operations: operations.length, cleanup: report.cleanup, error: report.error }) + '\n');
  }
}
