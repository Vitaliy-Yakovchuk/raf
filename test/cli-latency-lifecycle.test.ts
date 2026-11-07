import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { fixture, writeJson, json, until } from './production-launch-fixture.ts';

const exec = promisify(execFile);

test('[cli-latency] worker preparation preserves unchanged refused notices for a busy recipient', async t => {
  const f = await fixture(t);
  const tmux = (...args: string[]) => exec(f.tmux, ['-S', f.tmuxSocket, ...args], { env: f.env });
  await tmux('new-session', '-d', '-s', 'busy-recipient', process.execPath, '-e',
    'console.log("Unavailable fixture composer"); setInterval(() => {}, 1000)');
  const pane = (await tmux('display-message', '-p', '-t', 'busy-recipient:0.0', '#{pane_pid}|#{pane_id}')).stdout.trim().split('|');
  const pid = Number(pane[0]);
  const observed = (await exec('ps', ['-ww', '-p', String(pid), '-o', 'lstart=,command='])).stdout.trim();
  const row = observed.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
  const { readMachineBootIdentity } = await import('../src/os-runtime.ts');
  const boot = await readMachineBootIdentity();
  const store = openStateStore(f.statePath);
  try {
    store.sessionRepository.transaction(tx => {
      tx.putSession({ runId: 'busy-recipient', addressId: 'busy-recipient', revision: 1, state: 'running',
        process: { pid, startedAt: new Date(row[1]).toISOString(), runner: 'codex', runnerSessionId: 'busy-native',
          tmuxSession: 'busy-recipient', evidence: { command: row[2], tmuxSocket: f.tmuxSocket, tmuxPane: pane[1], ...boot } } });
    });
    for (let i = 0; i < 29; i++) {
      const source = { runId: `history-${i}`, addressId: `history-${i}`, revision: 1, state: 'finished' as const };
      store.sessionRepository.transaction(tx => tx.putSession(source));
      const notice = { id: `${source.runId}:result-notice`, runId: source.runId, source, recipient: 'busy-recipient',
        recipientRunId: 'busy-recipient', state: 'pending', attempts: 1, text: 'Fixture result',
        lastError: 'Message delivery failed: Recipient has no recognized empty agent composer' };
      store.startupContextDatabase.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES(?,?,?)')
        .run(notice.id, notice.runId, JSON.stringify(notice));
    }
  } finally { store.close(); }
  // Register the actual private pane for the fixture's identity-checked cleanup.
  await f.inspect();
  const started = performance.now();
  const result = await f.spawnChild('command', [JSON.stringify(f.argv(f.parameters('busy-backlog-worker')))]).done;
  const wallMs = performance.now() - started;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(JSON.parse(JSON.parse(result.stdout).stdout).status, 'running');
  const finished = openStateStore(f.statePath);
  try {
    const notices = finished.resultNotices.list();
    assert.equal(notices.length, 29);
    assert.ok(notices.every(notice => notice.state === 'pending' && notice.attempts === 1),
      `Worker preparation retried unchanged composer refusals: ${JSON.stringify(notices.map(notice => notice.attempts))}`);
  } finally { finished.close(); }
  t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', message: JSON.stringify({ command: 'agent run', pendingNotices: 29, wallMs, budgetMs: 3000 }), location: null, stack: [], redacted: false, truncated: false }], evidence: [] }));
  assert.ok(wallMs < 3000, `agent run with unchanged busy recipient took ${wallMs}ms`);
});

test('[cli-latency] successful commands keep production-sized history within their budgets', async t => {
  const f = await fixture(t);
  await writeJson(f.file, { ...await json(f.file), latency: true });
  for (let i = 0; i < 120; i++) {
    const directory = join(f.root, 'openspec/changes', `latency-${i}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, 'tasks.md'), '- [ ] 1.1 Fixture\n');
    await fs.writeFile(join(directory, 'proposal.md'), '# Fixture\n');
  }
  const store = openStateStore(f.statePath);
  try {
    const db = store.startupContextDatabase;
    db.exec('BEGIN');
    for (let i = 0; i < 399; i++) {
      const source = { runId: `history-${i}`, addressId: `history-${i}`, state: 'finished', revision: 1,
        launchContext: { brief: 'x'.repeat(64 * 1024) } };
      db.prepare('INSERT INTO sessions(run_id,address_id,state,payload) VALUES(?,?,?,?)')
        .run(source.runId, source.addressId, source.state, JSON.stringify(source));
      if (i < 115) {
        const notice = { id: `notice-${i}`, runId: source.runId, source, recipient: 'inactive', recipientRunId: null,
          state: 'pending', attempts: 1, text: 'Result', lastError: 'Recipient session is not active: inactive (unresolved run)' };
        db.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES(?,?,?)').run(notice.id, notice.runId, JSON.stringify(notice));
      }
    }
    for (let i = 115; i < 486; i++) {
      const notice = { id: `notice-${i}`, runId: `history-${i % 399}`, recipient: 'inactive', recipientRunId: null,
        state: i < 484 ? 'delivered' : 'undelivered', attempts: 1, text: 'Result', lastError: null };
      db.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES(?,?,?)').run(notice.id, notice.runId, JSON.stringify(notice));
    }
    for (let i = 0; i < 227; i++) {
      const reminder = { id: `reminder-${i}`, createdFor: 'main', assignedTo: 'main', text: 'Future reminder', at: '2099-01-01T00:00:00.000Z',
        binding: null, state: 'pending', closedAt: null, closeReason: null };
      db.prepare('INSERT INTO reminders(id,created_for,assigned_to,at,state,closed_at,payload) VALUES(?,?,?,?,?,?,?)')
        .run(reminder.id, reminder.createdFor, reminder.assignedTo, reminder.at, reminder.state, null, JSON.stringify(reminder));
    }
    for (let i = 0; i < 300; i++) db.prepare('INSERT INTO pending_intents(id,run_id,payload) VALUES(?,NULL,?)')
      .run(`intent-${i}`, JSON.stringify({ id: `intent-${i}`, runId: null, event: i < 266 ? 'raf.health-summary' : 'fixture.unknown', payload: { mainDelivery: { recipientRunId: 'latency-main' } } }));
    db.exec('COMMIT');
    const observed = (await exec('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='])).stdout.trim();
    const row = observed.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
    const { readMachineBootIdentity } = await import('../src/os-runtime.ts');
    const awaitBoot = await readMachineBootIdentity();
    for (let i = 0; i < 7; i++) store.sessionRepository.transaction(tx => tx.putSession({ runId: i ? `latency-observer-${i}` : 'latency-main', addressId: i ? `observer-${i}` : 'main', revision: 1,
      state: 'running', process: { pid: process.pid, startedAt: new Date(row[1]).toISOString(), runner: 'raf',
        runnerSessionId: 'latency-main', tmuxSession: 'latency-main', evidence: { command: row[2], ...awaitBoot } } }));
  } finally { store.close(); }
  const timings: { command: string; wallMs: number; budgetMs: number }[] = [];
  async function command(argv: string[], budgetMs: number) {
    const started = performance.now();
    const result = await f.spawnChild('command', [JSON.stringify(argv)]).done;
    const wallMs = performance.now() - started;
    const costs = openStateStore(f.statePath);
    const stages = costs.startupContextDatabase.prepare("SELECT payload FROM raf_cost_profile WHERE scope='command' AND command=?").all(argv.slice(0, 2).join(' ')).map(row => JSON.parse(String(row.payload)));
    costs.close();
    timings.push({ command: argv.slice(0, 2).join(' '), wallMs, budgetMs });
    t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', message: JSON.stringify({ command: argv.slice(0, 2).join(' '), wallMs, budgetMs, stages }), location: null, stack: [], redacted: false, truncated: false }], evidence: [] }));
    assert.equal(result.exitCode, 0, JSON.stringify(result));

    return JSON.parse(JSON.parse(result.stdout).stdout);
  }
  assert.equal((await command(['reminder', 'list'], 500)).length, 227);
  assert.equal((await command(['agent', 'ps'], 1000)).length, 122);
  const launched = await command(f.argv(f.parameters('latency-worker')), 3000);
  assert.equal(launched.status, 'running');
  const launchReads = (await fs.readFile(join(f.control, 'openspec-cost.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(launchReads.filter(call => call.args[0] === 'instructions').length, 1, 'Unchanged selected tasks must be parsed once before launch');
  const receipt = await command(['agent', 'message', '--to', 'latency-worker', '--text', 'Latency fixture message'], 3000);
  assert.equal(receipt.accepted, true);
  await f.gate('latency-worker.exit');
  await until(f.inspect, snapshot => snapshot.sessions.some(row => row.runId === launched.runId && row.state === 'finished'), 'Own fixture runner must finish before idempotent close');
  assert.equal((await command(['agent', 'close', '--id', 'latency-worker'], 3000)).closed, true);
  const openspec = (await fs.readFile(join(f.control, 'openspec-cost.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', message: JSON.stringify({ openspec }), location: null, stack: [], redacted: false, truncated: false }], evidence: [] }));
  assert.equal(openspec.filter(call => call.args.includes('--archived')).length, 0, 'Launching needs archive names, not recursive archived task statistics');
  assert.equal(openspec.filter(call => call.args.join(' ') === 'list --json').length, 0, 'Existing selected changes need their OpenSpec instructions, not recursive statistics for unrelated changes');
  for (const timing of timings) assert.ok(timing.wallMs < timing.budgetMs, `${timing.command} took ${timing.wallMs}ms; budget ${timing.budgetMs}ms`);
});
