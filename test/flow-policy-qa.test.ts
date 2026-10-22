import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const configured = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
const timeout = configured.unitTests.timeoutMs;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-flow-policy-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, 'raf-develop', 'src');
  await mkdir(src, { recursive: true });
  await mkdir(join(root, 'conf'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['flow-policy', 'resource-admission', 'session-state', 'reminders', 'launcher-notice', 'state-store']) await copyFile(new URL(`../src/${name}.ts`, import.meta.url), join(src, `${name}.ts`));
  const configPath = join(root, 'conf', 'flow.json');
  const policy = structuredClone(configured);
  const save = () => writeFile(configPath, JSON.stringify(policy));
  await save();
  const resource = await import(pathToFileURL(join(src, 'resource-admission.ts')).href);
  const session = await import(pathToFileURL(join(src, 'session-state.ts')).href);
  const reminder = await import(pathToFileURL(join(src, 'reminders.ts')).href);
  const persistence = await import(pathToFileURL(join(src, 'state-store.ts')).href);
  const store = persistence.openStateStore(join(root, 'state.sqlite'));
  t.after(() => store.close());
  const now = '2026-10-22T12:00:00.000Z';
  const state = session.createSessionState({ repository: store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  const reminders = new reminder.ReminderService({ repository: store.reminderRepository, now: () => now, nextId: () => 'unused', approvedEventKinds: [] });
  return { root, configPath, policy, save, resource, store, state, reminders, now };
}

const input = {
  measurement: { machineId: 'qa', loadAverage1m: 1, availableCores: 1, totalRamBytes: 100, availableRamBytes: 50, memoryPressure: 'normal', fileSystems: [{ id: 'disk', totalBytes: 100, availableBytes: 50 }] },
  requested: { ramBytes: 0, diskBytes: { disk: 0 } }, unusedReservations: [], requiredFileSystemIds: ['disk'],
};

test('QA: each resource threshold reloads from isolated conf on the next operation', { timeout }, async t => {
  const f = await fixture(t);
  const permissive = { maxNormalizedLoad: 2, minRamFraction: 0.1, minRamBytes: 1, minDiskFraction: 0.1, minDiskBytes: 1 };
  f.policy.resources = { normal: { ...permissive }, hotfix: { ...permissive } };
  await f.save();
  assert.deepEqual(f.resource.evaluateResourceAdmission(input).allowed, { normal: true, hotfix: true });
  for (const profile of ['normal', 'hotfix']) {
    for (const [field, value] of Object.entries({ maxNormalizedLoad: 0.5, minRamFraction: 0.6, minRamBytes: 51, minDiskFraction: 0.6, minDiskBytes: 51 })) {
      f.policy.resources[profile][field] = value;
      if (profile === 'hotfix') f.policy.resources.normal[field] = value;
      await f.save();
      assert.equal(f.resource.evaluateResourceAdmission(input).allowed[profile], false, `${profile}.${field}`);
      f.policy.resources = { normal: { ...permissive }, hotfix: { ...permissive } };
      await f.save();
      assert.equal(f.resource.evaluateResourceAdmission(input).allowed[profile], true, `${profile}.${field} restored`);
    }
  }
});

test('QA: changed retention removes actual SQLite rows on the next operation', { timeout }, async t => {
  const f = await fixture(t);
  const at = (age: number) => new Date(Date.parse(f.now) - age).toISOString();
  f.policy.retention = { finishedSessionsMs: 20000, closedRemindersMs: 20000 };
  await f.save();
  f.store.sessionRepository.transaction(tx => {
    tx.putSession({ runId: 'finished', addressId: 'worker', state: 'finished', revision: 1, finishedAt: at(15000) });
    tx.putSession({ runId: 'active', addressId: 'live', state: 'running', revision: 1 });
    tx.putPending({ id: 'pending', runId: 'finished', event: 'fixture', payload: {} });
  });
  f.store.reminderRepository.transaction(tx => {
    tx.save({ id: 'closed', createdFor: 'worker', assignedTo: 'worker', text: 'closed', at: at(20000), binding: null, state: 'closed', closedAt: at(15000), closeReason: 'done' });
    tx.save({ id: 'open', createdFor: 'worker', assignedTo: 'worker', text: 'open', at: at(20000), binding: null, state: 'pending', closedAt: null, closeReason: null });
  });
  assert.equal(f.state.cleanupCompleted(f.now), 0);
  assert.deepEqual(f.reminders.pruneClosed(), []);
  f.policy.retention = { finishedSessionsMs: 10000, closedRemindersMs: 10000 };
  await f.save();
  assert.equal(f.state.cleanupCompleted(f.now), 1);
  assert.deepEqual(f.reminders.pruneClosed(), ['closed']);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions().map(row => row.runId)), ['active']);
  assert.deepEqual(f.store.reminderRepository.transaction(tx => tx.list().map(row => row.id)), ['open']);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listPending()).length, 1);
});

test('QA: malformed or incomplete conf fails explicitly without cached or hardcoded policy', { timeout }, async t => {
  const f = await fixture(t);
  f.resource.evaluateResourceAdmission(input);
  f.state.cleanupCompleted(f.now);
  f.reminders.pruneClosed();
  for (const contents of ['{', JSON.stringify({ ...f.policy, retention: {} })]) {
    await writeFile(f.configPath, contents);
    for (const action of [() => f.resource.evaluateResourceAdmission(input), () => f.state.cleanupCompleted(f.now), () => f.reminders.pruneClosed()]) assert.throws(action, /(?:Cannot load flow policy|Invalid flow policy)/);
  }
  await f.save();
  assert.doesNotThrow(() => f.resource.evaluateResourceAdmission(input));
  assert.equal(f.state.cleanupCompleted(f.now), 0);
  assert.deepEqual(f.reminders.pruneClosed(), []);
});
