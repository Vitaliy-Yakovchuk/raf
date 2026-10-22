import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readMachineBootIdentity } from '../src/os-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import { cliFixture, commandFixture } from './reminder-fixture.ts';

const past = (f: { now(): number }, milliseconds = 1000) => new Date(f.now() - milliseconds).toISOString();

test('a command delivers active reminders through the shared transport with the system sender and both addressees', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  f.session('reviewer');
  const own = f.reminders.add({ to: 'worker', at: past(f), text: 'Перевірити own' });
  const moved = f.reminders.add({ to: 'worker', at: past(f), text: 'Перевірити moved' });
  f.reminders.reassign(moved.id, 'reviewer');
  const report = await f.settle(f.separateProcess());
  assert.deepEqual([...report.delivered].sort(), [own.id, moved.id].sort());
  const toWorker = f.deliveredTo('worker', own.id);
  assert.equal(toWorker.length, 1);
  assert.deepEqual(toWorker[0].sender, { kind: 'system' });
  assert.match(toWorker[0].text, /Перевірити own/);
  const toReviewer = f.deliveredTo('reviewer', moved.id);
  assert.equal(toReviewer.length, 1);
  assert.deepEqual(toReviewer[0].sender, { kind: 'system' });
  assert.match(toReviewer[0].text, /Перевірити moved/);
  assert.match(toReviewer[0].text, /\bworker\b/);
  assert.match(toReviewer[0].text, /\breviewer\b/);
  assert.equal(f.get(own.id)?.state, 'active');
});

test('the SQLite delivery mark stops the next command in another process from delivering the same reminder again', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: past(f), text: 'Один раз' });
  await f.settle(f.separateProcess());
  assert.equal(f.deliveredTo('worker', reminder.id).length, 1);
  const marks = f.query('SELECT reminder_id FROM reminder_deliveries WHERE reminder_id = ?', reminder.id);
  assert.equal(marks.length, 1);
  await f.command('reminder list', {});
  await f.settle(f.separateProcess());
  assert.equal(f.attempts(reminder.id).length, 1);
  assert.equal(f.get(reminder.id)?.state, 'active');
});

test('two commands in separate processes settling at once deliver one reminder exactly once', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: past(f), text: 'Без дубля' });
  f.delayDelivery(50);
  await Promise.all([f.settle(f.separateProcess()), f.settle(f.separateProcess())]);
  assert.equal(f.attempts(reminder.id).length, 1, JSON.stringify(f.deliveries));
  assert.equal(f.deliveredTo('worker', reminder.id).length, 1);
});

test('unaccepted delivery stays active without a mark and the next command retries it until a receipt is accepted', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: past(f), text: 'Повторити доставку' });
  f.accept(() => false);
  const first = await f.settle(f.separateProcess());
  assert.deepEqual(first.undelivered.map(row => row.id), [reminder.id]);
  assert.equal(f.attempts(reminder.id).length, 1);
  assert.equal(f.deliveredTo('worker', reminder.id).length, 0);
  assert.equal(f.query('SELECT reminder_id FROM reminder_deliveries WHERE reminder_id = ?', reminder.id).length, 0);
  assert.equal(f.get(reminder.id)?.state, 'active');
  await f.settle(f.separateProcess());
  assert.equal(f.attempts(reminder.id).length, 2);
  f.accept(() => true);
  await f.settle(f.separateProcess());
  assert.equal(f.deliveredTo('worker', reminder.id).length, 1);
  await f.settle(f.separateProcess());
  assert.equal(f.attempts(reminder.id).length, 3);
});

test('inactive addressee keeps the reminder active with no mark until the address is active again', async t => {
  const f = await commandFixture(t);
  const main = f.session('main');
  const reminder = f.reminders.add({ to: 'main', at: new Date(f.now() + 60_000).toISOString(), text: 'Для main' });
  f.finish(main);
  f.advance(120_000);
  await f.settle(f.separateProcess());
  assert.equal(f.get(reminder.id)?.state, 'active');
  assert.equal(f.deliveredTo('main', reminder.id).length, 0);
  f.session('main');
  await f.settle(f.separateProcess());
  assert.equal(f.deliveredTo('main', reminder.id).length, 1);
  await f.settle(f.separateProcess());
  assert.equal(f.deliveredTo('main', reminder.id).length, 1);
});

test('reassign and update deliver the changed pair within the same command and the latest pair is not repeated later', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  f.session('reviewer');
  const reminder = f.reminders.add({ to: 'worker', at: past(f), text: 'Перша версія' });
  await f.settle(f.separateProcess());
  assert.equal(f.deliveredTo('worker', reminder.id).length, 1);
  await f.command('reminder reassign', { id: reminder.id, to: 'reviewer' });
  const reassigned = f.deliveredTo('reviewer', reminder.id);
  assert.equal(reassigned.length, 1);
  assert.match(reassigned[0].text, /\bworker\b/);
  assert.match(reassigned[0].text, /\breviewer\b/);
  await f.command('reminder update', { id: reminder.id, text: 'Друга версія' });
  assert.equal(f.deliveredTo('reviewer', 'Друга версія').length, 1);
  await f.settle(f.separateProcess());
  assert.equal(f.deliveredTo('reviewer', reminder.id).length, 2);
  assert.equal(f.deliveredTo('worker', reminder.id).length, 1);
  assert.equal(f.get(reminder.id)?.createdFor, 'worker');
});

test('a delivery failure does not change the result or code of the command that found the reminder', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  f.session('reviewer');
  const due = f.reminders.add({ to: 'worker', at: past(f), text: 'Транспорт падає' });
  f.accept(() => { throw new Error('injected transport failure'); });
  const added = await f.command('reminder add', { to: 'reviewer', at: '2030-01-01T00:00:00Z', text: 'Інша операція' }) as { id: string };
  assert.equal(f.get(added.id)?.state, 'pending');
  assert.equal(f.get(due.id)?.state, 'active');
  assert.equal(f.query('SELECT reminder_id FROM reminder_deliveries WHERE reminder_id = ?', due.id).length, 0);
});

test('production CLI with the service stopped delivers an active reminder into the attached main tmux pane with the raf prefix once', { timeout: 60_000 }, async t => {
  const f = await cliFixture(t);
  const server = `raf-reminder-${randomUUID().slice(0, 12)}`;
  const environment = { ...process.env, TMUX: '', TMUX_PANE: '' };
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', server, ...args], { encoding: 'utf8', env: environment });
  let socketPath = '';
  t.after(async () => { tmux('kill-server'); if (socketPath) await rm(socketPath, { force: true }); });
  const created = tmux('new-session', '-d', '-s', 'main', '-x', '200', '-y', '50', 'cat > /dev/null');
  assert.equal(created.status, 0, created.stderr);
  const shown = tmux('display-message', '-p', '-t', 'main', '#{socket_path}\t#{pane_id}\t#{pane_pid}');
  assert.equal(shown.status, 0, shown.stderr);
  const [socket, pane, panePid] = shown.stdout.trim().split('\t');
  socketPath = socket;
  const row = spawnSync('ps', ['-ww', '-o', 'lstart=,command=', '-p', panePid], { encoding: 'utf8' });
  assert.equal(row.status, 0, row.stderr);
  const match = row.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  assert.ok(match, row.stdout);
  const boot = await readMachineBootIdentity();
  const store = openStateStore(f.statePath);
  try {
    store.sessionRepository.transaction(tx => {
      const old = tx.getSession('run-main');
      if (old) tx.putSession({ ...old, revision: old.revision + 1, state: 'finished', finishedAt: new Date().toISOString() });
      tx.putSession({
        runId: 'main-pane-run', addressId: 'main', revision: 1, state: 'running',
        activity: { type: 'main', project: 'raf', features: ['add-raf-reminders'], phase: 'main', cwd: f.root },
        process: { pid: Number(panePid), startedAt: new Date(match[1]).toISOString(), runner: 'main', runnerSessionId: pane, tmuxSession: 'main',
          evidence: { command: match[2], tmuxSocket: socket, tmuxPane: pane, machineId: boot.machineId, bootId: boot.bootId } },
      });
    });
  } finally { store.close(); }
  const added = await f.run(['reminder', 'add', '--to', 'main', '--at', '2020-01-01T00:00:00Z', '--text', `qa-ping-${server}`]);
  assert.equal(added.exitCode, 0, added.stderr);
  const reminder = JSON.parse(added.stdout);
  const deadline = Date.now() + 10_000;
  let screen = '';
  while (Date.now() < deadline) {
    screen = tmux('capture-pane', '-p', '-J', '-t', pane).stdout;
    if (screen.includes(`qa-ping-${server}`)) break;
    await delay(100);
  }
  assert.match(screen, new RegExp(`\\[raf\\][^\\n]*${reminder.id}`));
  const listed = await f.run(['reminder', 'list']);
  assert.equal(listed.exitCode, 0, listed.stderr);
  await delay(300);
  screen = tmux('capture-pane', '-p', '-J', '-t', pane).stdout;
  assert.equal(screen.split(`qa-ping-${server}`).length - 1, 1, screen);
  assert.equal(f.serviceTouched(), false);
});
