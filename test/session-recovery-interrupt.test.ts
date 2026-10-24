import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createProductionServices } from '../src/production-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import { readMachineBootIdentity } from '../src/os-runtime.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { RuntimeConfiguration } from '../src/app-runtime.ts';

const busy = '• Working (0s • esc to interrupt)\n› ';
const ready = 'Ask Codex to do anything\n› ';

async function fixture(t: TestContext, options: { screen?: string; panePid?: number; stuck?: boolean; replaced?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'raf-interrupt-unit-'));
  const store = openStateStore(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
  settings.timeouts = { startupMs: 20, transitionMs: 20, overallMs: 40, pollMs: 1 };
  const startedAt = '2026-10-24T12:00:00.000Z';
  const start = 'Sat Oct 24 12:00:00 2026';
  const identity = { pid: process.pid, startedAt, runner: 'codex', runnerSessionId: 'native-session', tmuxSession: 'worker',
    evidence: { command: 'codex fixture', tmuxSocket: join(root, 'owned.sock'), tmuxPane: '%1', ...await readMachineBootIdentity() } };
  const session = { runId: 'worker-run', addressId: 'worker', revision: 1, state: 'running' as const, process: identity };
  store.sessionRepository.transaction(tx => {
    tx.putSession(session);
    tx.putReservation({ runId: session.runId, resource: 'fixture', amount: 1 });
  });
  const reminder = { id: 'reminder', createdFor: 'worker', assignedTo: 'worker', at: '2099-01-01T00:00:00Z', text: 'Retain this action context', binding: null, state: 'pending' as const, closedAt: null, closeReason: null };
  store.reminderRepository.transaction(tx => tx.save(reminder));
  const calls: AdapterCommand[] = [];
  let sent = false;
  const execute: AdapterCommandExecutor = async command => {
    calls.push(structuredClone(command));
    let stdout = '';
    if (command.executable === 'ps') {
      const commandText = options.replaced && sent ? 'unrelated replacement' : identity.evidence.command;
      stdout = command.args.includes('pid=,ppid=,lstart=,command=') ? `${process.pid} 1 ${start} ${commandText}\n` : `${process.pid} ${start} ${commandText}\n`;
    } else if (command.executable === 'tmux') {
      if (command.args.includes('display-message')) stdout = command.args.includes('#{pane_id}') ? '%1\n' : `${options.panePid ?? process.pid}\n`;
      else if (command.args.includes('capture-pane')) stdout = sent && !options.stuck ? ready : options.screen ?? busy;
      else if (command.args.includes('send-keys')) sent = true;
      else assert.fail('Unexpected tmux operation: ' + JSON.stringify(command));
    } else assert.fail('Unexpected operation: ' + JSON.stringify(command));
    return { exitCode: 0, stdout, stderr: '' };
  };
  const configuration = { catalog: { commands: [], reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }] } } as RuntimeConfiguration;
  const services = await createProductionServices(store, configuration, { orchestratorRoot: root, confRoot: new URL('../../conf/', import.meta.url).pathname, artifactPath: join(root, 'catalog.json'), statePath: join(root, 'state.sqlite'), tmpRoot: root, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined }, { execute, protocolSettings: [settings] });
  return { store, services, calls, identity, reminder, session };
}

test('production interrupt stops a verified busy action and preserves the live session, reminders and reservation', async t => {
  const f = await fixture(t);
  await f.services.control.interrupt('worker', undefined);
  const keys = f.calls.filter(row => row.executable === 'tmux' && row.args.includes('send-keys'));
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0].args, ['-u', '-S', f.identity.evidence.tmuxSocket, 'send-keys', '-t', '%1', 'Escape']);
  const current = f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId));
  assert.equal(current?.state, 'running');
  assert.deepEqual(current?.process, f.identity);
  assert.deepEqual(f.store.reminderRepository.transaction(tx => tx.get(f.reminder.id)), f.reminder);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listPending()).some(row => row.event === 'agent.closed'), false);
});

test('production interrupt refuses an unknown or idle screen without sending a key', async t => {
  const f = await fixture(t, { screen: ready });
  await assert.rejects(f.services.control.interrupt('worker', undefined), { code: 'INTERRUPT_UNAVAILABLE' });
  assert.equal(f.calls.some(row => row.args.includes('send-keys')), false);
});

test('production interrupt refuses a pane owned by an unrelated process', async t => {
  const f = await fixture(t, { panePid: process.pid + 100000 });
  await assert.rejects(f.services.control.interrupt('worker', undefined), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  assert.equal(f.calls.some(row => row.args.includes('send-keys')), false);
});

test('production interrupt requires confirmation instead of reporting success while still busy', async t => {
  const f = await fixture(t, { stuck: true });
  await assert.rejects(f.services.control.interrupt('worker', undefined), { code: 'INTERRUPT_UNCONFIRMED' });
  assert.equal(f.calls.filter(row => row.args.includes('send-keys')).length, 1);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId))?.state, 'running');
});

test('production interrupt cannot accept a replacement PID as the preserved live session', async t => {
  const f = await fixture(t, { replaced: true });
  await assert.rejects(f.services.control.interrupt('worker', undefined), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  assert.equal(f.calls.some(row => row.args.includes('kill-session')), false);
});
