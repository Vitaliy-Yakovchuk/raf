import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { createAppRuntime } from '../src/app-runtime.ts';
import { loadCompiledCatalog } from '../src/compiled-catalog.ts';
import { loadEventCatalog } from '../src/event-catalog.ts';
import { performance } from 'node:perf_hooks';

for (const command of ['reminder list', 'reminder close'] as const) {
  test(`${command} does not enumerate historical sessions for already attempted health summaries`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'raf-reminder-latency-'));
    mkdirSync(join(root, 'conf'));
    for (const name of ['raf.json', 'flow.json', 'raf-constants.json']) cpSync(new URL(`../../conf/${name}`, import.meta.url), join(root, 'conf', name));
    const store = openStateStore(join(root, 'state.sqlite'));
    const db = store.startupContextDatabase;
    const now = '2026-10-27T03:00:00.000Z';
    const insert = db.prepare('INSERT INTO sessions(run_id,address_id,state,payload) VALUES(?,?,?,?)');
    for (let i = 0; i < 423; i++) {
      const row = { runId: `run-${i}`, addressId: i ? `worker-${i}` : 'main', state: i < 30 ? 'running' : 'finished', revision: 1, history: 'x'.repeat(16000) };
      insert.run(row.runId, row.addressId, row.state, JSON.stringify(row));
    }
    const reminderInsert = db.prepare('INSERT INTO reminders(id,created_for,assigned_to,at,state,closed_at,payload) VALUES(?,?,?,?,?,?,?)');
    for (let i = 0; i < 1204; i++) {
      const row = { id: `reminder-${i}`, createdFor: 'main', assignedTo: 'main', text: 'profile fixture', at: now, binding: null,
        state: i ? 'closed' : 'active', closedAt: i ? now : null, closeReason: i ? 'done' : null };
      reminderInsert.run(row.id, row.createdFor, row.assignedTo, row.at, row.state, row.closedAt, JSON.stringify(row));
    }
    for (let i = 0; i < 14; i++) store.sessionRepository.transaction(tx => tx.putPending({ id: `summary-${i}`, runId: null, event: 'raf.health-summary',
      payload: { mainDelivered: false, mainDelivery: { recipientRunId: 'run-0', attemptedAt: now }, data: {} } }));
    const catalog = loadCompiledCatalog();
    let fullSessionReads = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (/SELECT payload FROM sessions\s*$/i.test(sql)) fullSessionReads++;
      return prepare(sql);
    }) as typeof db.prepare;
    let deliveries = 0;
    const runtime = createAppRuntime({ orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'),
      statePath: join(root, 'state.sqlite'), tmpRoot: join(root, 'tmp'), mode: 'test', commandStartedAtMs: performance.now(), resolveCaller: async () => undefined }, {
      loadConfiguration: async () => ({ catalog, models: catalog.models, commandTiming: JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8')).commandTiming }),
      openStore: async () => store, createServices: async () => { throw new Error('SQLite commands must not request service readiness'); },
      now: performance.now.bind(performance), nextRunIdentity: () => { throw new Error('No launches'); },
      commandState: () => ({ store, orchestratorRoot: root, now: () => Date.parse(now), nextReminderId: () => 'unused', catalog: loadEventCatalog(root),
        deliver: async () => { deliveries++; return { accepted: false, reason: 'Recipient has no recognized empty agent composer' }; } }),
    });
    t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
    const started = performance.now();
    const result = await runtime.handlers[command](command === 'reminder list' ? { to: 'main' } : { id: 'reminder-0', reason: 'done' });
    t.diagnostic(JSON.stringify({ command, durationMs: performance.now() - started, reminders: 1204, sessions: 423, fullSessionReads, deliveries }));
    if (command === 'reminder list') assert.equal((result as unknown[]).length, 1204);
    else assert.equal((result as { state: string }).state, 'closed');
    assert.equal(deliveries, command === 'reminder list' ? 1 : 0, 'required delivery still runs and a refusal never marks delivery');
    assert.equal(fullSessionReads, 0, 'already attempted summaries must not deserialize unrelated historical sessions');
    assert.equal(db.prepare('SELECT count(*) AS n FROM pending_intents WHERE id LIKE ?').get('summary-%')?.n, 14, 'uncertain receipts remain durable');
  });
}

test('health summary claims find current main without enumerating historical sessions', t => {
  const root = mkdtempSync(join(tmpdir(), 'raf-summary-address-'));
  const store = openStateStore(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.sessionRepository.transaction(tx => {
    tx.putSession({ runId: 'old-main', addressId: 'main', state: 'finished', revision: 1 });
    tx.putSession({ runId: 'current-main', addressId: 'main', state: 'running', revision: 1 });
    tx.putPending({ id: 'new-summary', runId: null, event: 'raf.health-summary', payload: { data: { factKey: 'new-summary' } } });
  });
  const db = store.startupContextDatabase;
  const prepare = db.prepare.bind(db);
  let fullSessionReads = 0;
  db.prepare = ((sql: string) => { if (/SELECT payload FROM sessions\s*$/i.test(sql)) fullSessionReads++; return prepare(sql); }) as typeof db.prepare;
  const claim = store.healthSummary.claim('new-summary', { token: 'owner', pid: process.pid, processStart: null }, new Date().toISOString(), () => true);
  assert.equal(claim?.recipientRunId, 'current-main');
  store.healthSummary.complete('new-summary', 'owner', true);
  assert.equal(store.healthSummary.claim('new-summary', { token: 'again', pid: process.pid, processStart: null }, new Date().toISOString(), () => true), undefined);
  assert.equal(fullSessionReads, 0, 'claiming a summary only needs the indexed main run ID');
});
