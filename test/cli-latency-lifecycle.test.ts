import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { fixture, writeJson, json, until } from './production-launch-fixture.ts';

const exec = promisify(execFile);

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
    for (let i = 0; i < 335; i++) {
      const source = { runId: `history-${i}`, addressId: `history-${i}`, state: 'finished', revision: 1,
        launchContext: { brief: 'x'.repeat(64 * 1024) } };
      db.prepare('INSERT INTO sessions(run_id,address_id,state,payload) VALUES(?,?,?,?)')
        .run(source.runId, source.addressId, source.state, JSON.stringify(source));
      if (i < 40) {
        const notice = { id: `notice-${i}`, runId: source.runId, source, recipient: 'inactive', recipientRunId: null,
          state: 'pending', attempts: 0, text: 'Result', lastError: null };
        db.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES(?,?,?)').run(notice.id, notice.runId, JSON.stringify(notice));
      }
    }
    db.exec('COMMIT');
    const observed = (await exec('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='])).stdout.trim();
    const row = observed.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
    const { readMachineBootIdentity } = await import('../src/os-runtime.ts');
    const awaitBoot = await readMachineBootIdentity();
    store.sessionRepository.transaction(tx => tx.putSession({ runId: 'latency-main', addressId: 'main', revision: 1,
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
  assert.equal((await command(['reminder', 'list'], 500)).length, 0);
  assert.equal((await command(['agent', 'ps'], 1000)).length, 41);
  const launched = await command(f.argv(f.parameters('latency-worker')), 3000);
  assert.equal(launched.status, 'running');
  const receipt = await command(['agent', 'message', '--to', 'latency-worker', '--text', 'Latency fixture message'], 3000);
  assert.equal(receipt.accepted, true);
  await f.gate('latency-worker.exit');
  await until(f.inspect, snapshot => snapshot.sessions.some(row => row.runId === launched.runId && row.state === 'finished'), 'Own fixture runner must finish before idempotent close');
  assert.equal((await command(['agent', 'close', '--id', 'latency-worker'], 3000)).closed, true);
  for (const timing of timings) assert.ok(timing.wallMs < timing.budgetMs, `${timing.command} took ${timing.wallMs}ms; budget ${timing.budgetMs}ms`);
});
