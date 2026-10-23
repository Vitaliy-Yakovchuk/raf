import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  ResourceUsageRepository,
  ResourceUsageTracker,
  type ResourceUsageRecord,
  type UsageBaseline,
  type UsageConfiguration,
  type UsageContext,
  type UsageDiskReading,
  type UsageFile,
  type UsageFinishReason,
  type UsageIdentity,
  type UsageMeasurementPort,
  type UsageObservation,
  type UsageProcessIdentity,
  type UsageTestRunResult,
} from '../src/resource-usage.ts';

const root: UsageProcessIdentity = { pid: 101, startTicks: '1000', bootId: 'boot-a' };
const child: UsageProcessIdentity = { pid: 102, startTicks: '1001', bootId: 'boot-a' };
const grandchild: UsageProcessIdentity = { pid: 103, startTicks: '1002', bootId: 'boot-a' };
const outsider: UsageProcessIdentity = { pid: 909, startTicks: '9000', bootId: 'boot-a' };

function identity(overrides: Partial<UsageIdentity> = {}): UsageIdentity {
  return { kind: 'agent', id: 'run-a', machineId: 'machine-a', bootId: 'boot-a', fence: 'fence-a', root: structuredClone(root), ...overrides };
}

function context(scope = identity()): UsageContext {
  return {
    identity: scope,
    project: 'raf',
    agentType: scope.kind === 'agent' ? 'implement' : null,
    testProfile: scope.kind === 'test' ? 'node' : null,
    items: [{ project: 'raf', change: 'fix-raf-load-admission', item: '3.5' }],
    requestedEstimate: {
      ramBytes: 8192,
      diskBytes: { work: 32768, tmp: 16384 },
      sources: [scope.kind === 'agent' ? 'conf/flow.json#/resourceEstimates/agentTypes/implement' : 'conf/test-runs.json#/projects/raf/profiles/node/resourceEstimate'],
      confHash: 'sha256:usage-fixture-conf',
    },
    requiredFileSystems: [{ id: 'work', paths: ['/work'] }, { id: 'tmp', paths: ['/tmp/run-a'] }],
  };
}

function configuration(tick = 17): UsageConfiguration {
  return {
    flow: { retention: { finishedSessionsMs: 1000 }, unitTests: { timeoutMs: 9000 }, resourceEstimates: { implement: { ramBytes: 8192 } }, resources: { normal: { minRamBytes: 100 } } },
    raf: { service: { hostTickIntervalMs: tick } },
  };
}

function file(inode: string, allocatedBytes: number, overrides: Partial<UsageFile> = {}): UsageFile {
  return { fileSystemId: 'work', deviceId: 'dev-work', inode, path: `/work/${inode}`, allocatedBytes, logicalBytes: allocatedBytes, attribution: { kind: 'run', key: { kind: 'agent', id: 'run-a' } }, ...overrides };
}

function volume(fileSystemId: string, files: UsageFile[] = [], complete = true, reasons: string[] = []): UsageDiskReading {
  return { fileSystemId, files, complete, reasons };
}

function observation(at: number, ram: number | null = 0, disks: UsageDiskReading[] = [volume('work'), volume('tmp')], scope = identity()): UsageObservation {
  return {
    identity: scope,
    at,
    ram: ram === null ? null : { method: 'rss-sampled', processes: [{ identity: root, parent: null, rssBytes: ram }], complete: true, reasons: [] },
    disk: disks,
    reasons: ram === null ? ['process-gone-before-sample'] : [],
  };
}

class Measurements implements UsageMeasurementPort {
  baselineValue: UsageBaseline = { at: 10, disk: [volume('work'), volume('tmp')] };
  calls: { operation: string; at?: number; identity?: UsageIdentity }[] = [];
  observations: UsageObservation[] = [];

  baseline(_context: UsageContext): UsageBaseline {
    this.calls.push({ operation: 'baseline' });
    return structuredClone(this.baselineValue);
  }

  sample(scope: UsageIdentity, at: number): UsageObservation {
    this.calls.push({ operation: 'sample', at, identity: structuredClone(scope) });
    const next = this.observations.shift();
    assert.ok(next, 'the scripted measurement port has a snapshot for each expected host tick');
    return structuredClone(next);
  }
}

function fixture(t: TestContext, conf = configuration(), database?: DatabaseSync) {
  const db = database ?? new DatabaseSync(':memory:');
  if (!database) t.after(() => db.close());
  let repository!: ResourceUsageRepository;
  assert.doesNotThrow(() => { repository = new ResourceUsageRepository(db); }, 'usage repository must be available on the supplied main SQLite connection');
  const measurement = new Measurements();
  let tracker!: ResourceUsageTracker;
  assert.doesNotThrow(() => { tracker = new ResourceUsageTracker({ repository, measurement, configuration: conf }); }, 'usage lifecycle must accept the existing repository and host tick configuration');
  return { db, repository, measurement, tracker };
}

function launch(f: ReturnType<typeof fixture>, ctx = context()) {
  const prepared = f.tracker.prepare(ctx, true, 10);
  assert.ok(prepared, 'an admitted launch creates a usage record before spawn');
  assert.equal(f.tracker.started(ctx.identity, 11), true);
  return ctx.identity;
}

function record(f: ReturnType<typeof fixture>, key = identity()): ResourceUsageRecord {
  const value = f.repository.get(key);
  assert.ok(value, 'the launch usage remains queryable');
  return value;
}

function scenario(id: string, run: (t: TestContext) => void): void {
  test(`usage/${id}`, run);
}

scenario('ram-simultaneous-tree-peak', t => {
  const f = fixture(t);
  launch(f);
  const first = observation(20);
  first.ram = { method: 'rss-sampled', processes: [
    { identity: root, parent: null, rssBytes: 10 },
    { identity: child, parent: root, rssBytes: 90 },
    { identity: grandchild, parent: child, rssBytes: 5 },
    { identity: outsider, parent: null, rssBytes: 10000 },
  ], complete: true, reasons: [] };
  const second = structuredClone(first);
  second.at = 30;
  if (second.ram?.method === 'rss-sampled') second.ram.processes[1].rssBytes = 0;
  if (second.ram?.method === 'rss-sampled') second.ram.processes[0].rssBytes = 80;
  f.tracker.observe(first);
  f.tracker.observe(second);
  const r = record(f);
  assert.equal(r.peakRamBytes, 105, 'max simultaneous sum is 105, not per-PID maxima 175 or foreign RSS');
  assert.equal(r.ram.currentBytes, 85);
  assert.equal(r.ram.method?.name, 'rss-sampled');
  assert.match(r.ram.method?.scope ?? '', /tree/i);
  assert.match(r.ram.method?.sharedPages ?? '', /shared/i);
});

scenario('ram-order-and-duplicate-process-invariance', t => {
  const f = fixture(t);
  launch(f);
  const s = observation(20);
  s.ram = { method: 'rss-sampled', processes: [
    { identity: grandchild, parent: child, rssBytes: 3 },
    { identity: child, parent: root, rssBytes: 2 },
    { identity: root, parent: null, rssBytes: 1 },
    { identity: child, parent: root, rssBytes: 2 },
  ], complete: true, reasons: [] };
  f.tracker.observe(s);
  assert.equal(record(f).peakRamBytes, 6);
});

scenario('ram-system-high-water-has-explicit-scope', t => {
  const f = fixture(t);
  launch(f);
  const s = observation(20);
  s.ram = { method: 'cgroup-high-water', scope: { id: 'run-a-cgroup', identity: identity() }, peakBytes: 900, currentBytes: 20, complete: true, reasons: [] };
  f.tracker.observe(s);
  const r = record(f);
  assert.equal(r.peakRamBytes, 900);
  assert.equal(r.ram.currentBytes, 20);
  assert.equal(r.ram.method?.name, 'cgroup-high-water');
  assert.match(r.ram.method?.scope ?? '', /run-a-cgroup/);
});

scenario('ram-foreign-cgroup-is-not-attributed', t => {
  const f = fixture(t);
  launch(f);
  const s = observation(20);
  s.ram = { method: 'cgroup-high-water', scope: { id: 'foreign', identity: identity({ id: 'run-b' }) }, peakBytes: 9999, currentBytes: 9999, complete: true, reasons: [] };
  f.tracker.observe(s);
  const r = record(f);
  assert.equal(r.peakRamBytes, null);
  assert.notEqual(r.ram.completeness, 'complete');
  assert.ok(r.ram.reasons.length > 0);
});

scenario('disk-per-volume-independent-peaks-and-deletion', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 100, [volume('work', [file('a', 12288)]), volume('tmp', [file('b', 4096, { fileSystemId: 'tmp', deviceId: 'dev-tmp' })])]));
  f.tracker.observe(observation(30, 1, [volume('work'), volume('tmp', [file('b', 16384, { fileSystemId: 'tmp', deviceId: 'dev-tmp' })])]));
  f.tracker.observe(observation(40, 0));
  const r = record(f);
  assert.deepEqual(r.peakDiskBytes, { work: 12288, tmp: 16384 });
  assert.equal(r.disk.work.currentBytes, 0);
  assert.equal(r.disk.tmp.currentBytes, 0);
  assert.equal(r.peakRamBytes, 100);
});

scenario('disk-baseline-before-spawn-and-physical-growth', t => {
  const f = fixture(t);
  f.measurement.baselineValue.disk[0].files = [file('existing', 4096, { logicalBytes: 999999 })];
  const prepared = f.tracker.prepare(context(), true, 10);
  assert.ok(prepared);
  assert.deepEqual(f.measurement.calls, [{ operation: 'baseline' }]);
  assert.equal(prepared.startedAt, null);
  assert.equal(prepared.baseline.at, 10);
  f.tracker.started(identity(), 11);
  f.tracker.observe(observation(20, 0, [volume('work', [file('existing', 12288, { logicalBytes: 999999 })]), volume('tmp')]));
  assert.equal(record(f).peakDiskBytes.work, 8192, 'subtract pre-spawn allocation, use physical bytes rather than logical size');
});

scenario('disk-below-baseline-clamps-verified-zero', t => {
  const f = fixture(t);
  f.measurement.baselineValue.disk[0].files = [file('existing', 8192)];
  launch(f);
  f.tracker.observe(observation(20, 0, [volume('work', [file('existing', 4096)]), volume('tmp')]));
  assert.equal(record(f).peakDiskBytes.work, 0);
  assert.equal(record(f).disk.work.completeness, 'complete');
});

scenario('disk-hardlinks-and-alias-volumes-count-once', t => {
  const f = fixture(t);
  const c = context();
  c.requiredFileSystems.push({ id: 'work', paths: ['/work/alias', '/tmp/same-device'] });
  launch(f, c);
  const a = file('same-inode', 4096);
  f.tracker.observe(observation(20, 7, [volume('work', [a, { ...a, path: '/work/hardlink' }]), volume('work', [{ ...a, path: '/tmp/same-device/hardlink' }]), volume('tmp')]));
  const r = record(f);
  assert.deepEqual(r.peakDiskBytes, { work: 4096, tmp: 0 });
  assert.equal(r.peakRamBytes, 7, 'volume aliases never multiply RAM');
  assert.equal(r.context.requiredFileSystems.length, 2);
});

scenario('disk-inode-is-scoped-by-device', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 0, [volume('work', [file('inode-1', 4096)]), volume('tmp', [file('inode-1', 8192, { fileSystemId: 'tmp', deviceId: 'dev-tmp' })])]));
  assert.deepEqual(record(f).peakDiskBytes, { work: 4096, tmp: 8192 });
});

scenario('disk-sparse-files-use-allocated-bytes', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 0, [volume('work', [file('sparse', 4096, { logicalBytes: 2 ** 40 })]), volume('tmp')]));
  assert.equal(record(f).peakDiskBytes.work, 4096);
  assert.match(record(f).disk.work.method?.name ?? '', /allocat/i);
});

scenario('disk-foreign-shared-checkout-and-df-excluded', t => {
  const f = fixture(t);
  launch(f);
  const sample = observation(20, 0, [volume('work', [file('own', 4096), file('checkout', 999999, { attribution: { kind: 'shared' } }), file('foreign', 888888, { attribution: { kind: 'foreign' } }), file('other-run', 777777, { attribution: { kind: 'run', key: { kind: 'agent', id: 'run-b' } } })], false, ['shared-worktree-attribution-unavailable']), volume('tmp')]);
  Object.assign(sample, { dfUsedBytes: { work: 999999999 }, checkoutBytes: 999999 });
  f.tracker.observe(sample);
  const r = record(f);
  assert.equal(r.peakDiskBytes.work, 4096);
  assert.equal(r.disk.work.completeness, 'partial');
  assert.ok(r.disk.work.reasons.includes('shared-worktree-attribution-unavailable'));
  assert.equal(r.completeness, 'partial');
});

scenario('disk-concurrent-runs-do-not-charge-each-other', t => {
  const f = fixture(t);
  const a = launch(f);
  const b = launch(f, context(identity({ id: 'run-b', fence: 'fence-b', root: outsider })));
  const files = [file('a', 4096), file('b', 8192, { attribution: { kind: 'run', key: { kind: 'agent', id: 'run-b' } } })];
  f.tracker.observe(observation(20, 0, [volume('work', files), volume('tmp')], a));
  f.tracker.observe(observation(20, null, [volume('work', files), volume('tmp')], b));
  assert.equal(record(f, a).peakDiskBytes.work, 4096);
  assert.equal(record(f, b).peakDiskBytes.work, 8192);
});

scenario('unknown-is-null-with-reason-and-not-reservation', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, null, []));
  const r = record(f);
  assert.equal(r.peakRamBytes, null);
  assert.deepEqual(r.peakDiskBytes, { work: null, tmp: null });
  assert.equal(r.ram.completeness, 'unknown');
  assert.equal(r.disk.work.completeness, 'unknown');
  assert.ok(r.ram.reasons.length > 0);
  assert.ok(r.disk.work.reasons.length > 0);
  assert.ok(!JSON.stringify(r).includes('NaN'));
});

scenario('verified-zero-survives-round-trip', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 0));
  const r = JSON.parse(JSON.stringify(record(f)));
  assert.equal(r.peakRamBytes, 0);
  assert.deepEqual(r.peakDiskBytes, { work: 0, tmp: 0 });
  assert.equal(r.ram.completeness, 'complete');
  assert.equal(r.disk.work.completeness, 'complete');
});

scenario('partial-fields-preserve-known-resources', t => {
  const f = fixture(t);
  launch(f);
  const s = observation(20, 7, [volume('work', [file('own', 4096)], false, ['unattributed-worktree-writes'])]);
  if (s.ram?.method === 'rss-sampled') { s.ram.complete = false; s.ram.reasons = ['child-inaccessible']; }
  f.tracker.observe(s);
  const r = record(f);
  assert.equal(r.peakRamBytes, 7);
  assert.equal(r.peakDiskBytes.work, 4096);
  assert.equal(r.peakDiskBytes.tmp, null);
  assert.equal(r.ram.completeness, 'partial');
  assert.ok(r.ram.reasons.includes('child-inaccessible'));
  assert.ok(r.disk.work.reasons.includes('unattributed-worktree-writes'));
  assert.equal(r.disk.tmp.completeness, 'unknown');
});

for (const field of ['machineId', 'bootId', 'fence', 'id', 'kind', 'pid-reuse'] as const) {
  scenario(`identity-rejects-${field}`, t => {
    const f = fixture(t);
    launch(f);
    f.tracker.observe(observation(20, 10));
    const before = record(f);
    const wrong = identity();
    if (field === 'pid-reuse') wrong.root = { ...root, startTicks: '99999' };
    else if (field === 'kind') wrong.kind = 'test';
    else wrong[field] = 'foreign';
    assert.equal(f.tracker.observe(observation(30, 999999, [volume('work', [file('bad', 999999)]), volume('tmp')], wrong)), false);
    assert.deepEqual(record(f), before, 'a stale or foreign sample must not mutate peaks, timestamps, context, or completeness');
    assert.equal(f.tracker.finish(wrong, { at: 40, reason: 'exit', verifiedComplete: true, reasons: [] }), null);
    assert.deepEqual(record(f), before, 'stale finalization is fenced too');
  });
}

scenario('identity-descendant-pid-reuse-is-excluded', t => {
  const f = fixture(t);
  launch(f);
  const s = observation(20);
  s.ram = { method: 'rss-sampled', processes: [
    { identity: root, parent: null, rssBytes: 10 },
    { identity: child, parent: { ...root, startTicks: 'old-root' }, rssBytes: 999999 },
    { identity: grandchild, parent: child, rssBytes: 999999 },
  ], complete: false, reasons: ['parent-identity-mismatch'] };
  f.tracker.observe(s);
  assert.equal(record(f).peakRamBytes, 10);
  assert.equal(record(f).ram.completeness, 'partial');
  assert.ok(record(f).ram.reasons.includes('parent-identity-mismatch'));
});

scenario('identity-start-binds-root-once', t => {
  const f = fixture(t);
  const pending = context(identity({ root: null }));
  assert.ok(f.tracker.prepare(pending, true, 10));
  assert.equal(f.tracker.started(identity(), 11), true);
  const before = record(f);
  assert.deepEqual(before.context.identity.root, root);
  assert.equal(f.tracker.started(identity({ root: { ...root, startTicks: 'reused' } }), 30), false);
  assert.deepEqual(record(f), before);
});

scenario('peaks-monotone-and-stale-samples-cannot-rollback-current', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 100, [volume('work', [file('a', 8192)]), volume('tmp')]));
  f.tracker.observe(observation(40, 10));
  f.tracker.observe(observation(30, 20, [volume('work', [file('a', 4096)]), volume('tmp')]));
  const r = record(f);
  assert.equal(r.peakRamBytes, 100);
  assert.equal(r.peakDiskBytes.work, 8192);
  assert.equal(r.lastObservedAt, 40);
  assert.deepEqual(f.tracker.currentConsumption(identity()), { ramBytes: 10, diskBytes: { work: 0, tmp: 0 } });
});

scenario('replayed-snapshot-is-idempotent', t => {
  const f = fixture(t);
  launch(f);
  const s = observation(20, 30, [volume('work', [file('a', 4096)], false, ['shared-attribution-gap']), volume('tmp')]);
  f.tracker.observe(s);
  const before = record(f);
  f.tracker.observe(structuredClone(s));
  f.tracker.reconcile(identity(), { at: 20, state: 'alive', observation: s, reasons: [] });
  f.tracker.reconcile(identity(), { at: 20, state: 'alive', observation: s, reasons: [] });
  assert.deepEqual(record(f), before);
});

scenario('sample-gap-remains-visible-after-later-good-sample', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, null, []));
  f.tracker.observe(observation(30, 8));
  const r = f.tracker.finish(identity(), { at: 40, reason: 'exit', verifiedComplete: true, reasons: [] });
  assert.ok(r);
  assert.equal(r.peakRamBytes, 8);
  assert.equal(r.completeness, 'partial');
  assert.ok(r.reasons.length > 0 || r.ram.reasons.length > 0);
});

scenario('host-tick-uses-configured-interval', t => {
  const f = fixture(t, configuration(37));
  launch(f);
  f.measurement.observations.push(observation(48, 12), observation(85, 4));
  f.tracker.hostTick(47);
  assert.equal(f.measurement.calls.filter(c => c.operation === 'sample').length, 0);
  f.tracker.hostTick(48);
  f.tracker.hostTick(60);
  f.tracker.hostTick(85);
  assert.deepEqual(f.measurement.calls.filter(c => c.operation === 'sample').map(c => c.at), [48, 85]);
  assert.equal(record(f).peakRamBytes, 12);
});

scenario('host-tick-config-change-is-observed', t => {
  const conf = configuration(37);
  const f = fixture(t, conf);
  launch(f);
  conf.raf.service.hostTickIntervalMs = 5;
  f.measurement.observations.push(observation(16, 4));
  f.tracker.hostTick(16);
  assert.deepEqual(f.measurement.calls.filter(c => c.operation === 'sample').map(c => c.at), [16]);
});

scenario('host-tick-measurement-failure-preserves-peak-as-partial', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 100));
  f.measurement.sample = () => { throw new Error('measurement-unavailable'); };
  assert.doesNotThrow(() => f.tracker.hostTick(100), 'accounting failure does not terminate the launch lifecycle');
  const r = record(f);
  assert.equal(r.peakRamBytes, 100);
  assert.equal(r.completeness, 'partial');
  assert.ok(r.reasons.length > 0);
});

for (const reason of ['exit', 'signal', 'timeout', 'death'] satisfies UsageFinishReason[]) {
  scenario(`finish-${reason}-retains-observed-peak`, t => {
    const f = fixture(t);
    launch(f);
    f.tracker.observe(observation(20, 100, [volume('work', [file('a', 12288)]), volume('tmp')]));
    const r = f.tracker.finish(identity(), { at: 40, reason, finalObservation: observation(39, 1), verifiedComplete: reason === 'exit', reasons: reason === 'exit' ? [] : ['final-tree-not-fully-observed'] });
    assert.ok(r);
    assert.equal(r.peakRamBytes, 100);
    assert.equal(r.peakDiskBytes.work, 12288);
    assert.equal(r.lastObservedAt, 39);
    assert.equal(r.finishedAt, 40);
    assert.equal(r.finishReason, reason);
    assert.equal(r.completeness, reason === 'exit' ? 'complete' : 'partial');
    assert.deepEqual(record(f), r);
    assert.deepEqual(f.repository.listActive(), []);
  });
}

scenario('finish-takes-larger-final-snapshot', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 5));
  const r = f.tracker.finish(identity(), { at: 40, reason: 'exit', finalObservation: observation(39, 99, [volume('work', [file('last', 16384)]), volume('tmp')]), verifiedComplete: true, reasons: [] });
  assert.equal(r?.peakRamBytes, 99);
  assert.equal(r?.peakDiskBytes.work, 16384);
});

scenario('finish-without-final-snapshot-keeps-partial', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 5));
  const r = f.tracker.finish(identity(), { at: 40, reason: 'signal', verifiedComplete: false, reasons: ['process-gone-before-final-sample'] });
  assert.equal(r?.peakRamBytes, 5);
  assert.equal(r?.completeness, 'partial');
  assert.ok(r?.reasons.includes('process-gone-before-final-sample'));
});

scenario('spawn-failure-after-prepare-keeps-null-usage', t => {
  const f = fixture(t);
  const pending = identity({ root: null });
  f.tracker.prepare(context(pending), true, 10);
  const r = f.tracker.finish(pending, { at: 12, reason: 'spawn-failure', verifiedComplete: false, reasons: ['spawn-failed-before-process-identity'] });
  assert.ok(r);
  assert.equal(r.startedAt, null);
  assert.equal(r.peakRamBytes, null);
  assert.deepEqual(r.peakDiskBytes, { work: null, tmp: null });
  assert.equal(r.finishedAt, 12);
  assert.equal(r.completeness, 'partial');
  assert.ok(r.reasons.includes('spawn-failed-before-process-identity'));
});

scenario('pre-spawn-refusal-does-not-invent-usage', t => {
  const f = fixture(t);
  assert.equal(f.tracker.prepare(context(), false, 10), null);
  assert.equal(f.repository.get(identity()), null);
  assert.deepEqual(f.measurement.calls, []);
});

scenario('reconcile-death-retains-best-partial-and-is-idempotent', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 123, [volume('work', [file('a', 8192)]), volume('tmp')]));
  const first = f.tracker.reconcile(identity(), { at: 40, state: 'dead', reasons: ['death-detected-after-crash'] });
  assert.ok(first);
  assert.equal(first.peakRamBytes, 123);
  assert.equal(first.peakDiskBytes.work, 8192);
  assert.equal(first.finishedAt, 40);
  assert.equal(first.completeness, 'partial');
  assert.ok(first.reasons.includes('death-detected-after-crash'));
  const again = f.tracker.reconcile(identity(), { at: 50, state: 'dead', reasons: ['death-detected-after-crash'] });
  assert.deepEqual(again, first, 'reconcile must not reset peaks or extend retention on each observation');
});

scenario('reconcile-unknown-liveness-preserves-open-partial-record', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 5));
  const r = f.tracker.reconcile(identity(), { at: 40, state: 'unknown', reasons: ['identity-cannot-be-verified'] });
  assert.ok(r);
  assert.equal(r.peakRamBytes, 5);
  assert.equal(r.finishedAt, null);
  assert.equal(r.completeness, 'partial');
  assert.ok(r.reasons.includes('identity-cannot-be-verified'));
});

scenario('reconcile-stale-fence-cannot-close-live-record', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 5));
  const before = record(f);
  assert.equal(f.tracker.reconcile(identity({ fence: 'stale' }), { at: 40, state: 'dead', reasons: ['stale-worker'] }), null);
  assert.deepEqual(record(f), before);
});

scenario('finished-record-rejects-late-updates-and-repeated-finish', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 10));
  f.tracker.finish(identity(), { at: 40, reason: 'exit', verifiedComplete: true, reasons: [] });
  const before = record(f);
  assert.equal(f.tracker.observe(observation(50, 999999)), false);
  f.tracker.finish(identity(), { at: 60, reason: 'death', verifiedComplete: false, reasons: ['late-worker'] });
  f.tracker.hostTick(100);
  assert.deepEqual(record(f), before);
  assert.deepEqual(f.measurement.calls.filter(c => c.operation === 'sample'), []);
});

scenario('metadata-context-deduplicates-items-and-is-snapshotted', t => {
  const f = fixture(t);
  const ctx = context();
  ctx.items.push(structuredClone(ctx.items[0]), { project: 'raf', change: 'fix-raf-load-admission', item: '3.2' });
  ctx.requestedEstimate.sources.push(ctx.requestedEstimate.sources[0]);
  launch(f, ctx);
  ctx.requestedEstimate.ramBytes = 999999;
  ctx.requestedEstimate.sources[0] = 'changed-after-start';
  ctx.items[0].item = 'changed';
  f.tracker.observe(observation(20, 3));
  const r = record(f);
  assert.equal(r.context.project, 'raf');
  assert.equal(r.context.agentType, 'implement');
  assert.equal(r.context.testProfile, null);
  assert.deepEqual(r.context.identity, identity());
  assert.deepEqual(r.context.items.map(i => i.item).sort(), ['3.2', '3.5']);
  assert.equal(r.context.requestedEstimate.ramBytes, 8192);
  assert.deepEqual(r.context.requestedEstimate.sources, ['conf/flow.json#/resourceEstimates/agentTypes/implement']);
  assert.equal(r.context.requestedEstimate.confHash, 'sha256:usage-fixture-conf');
  assert.equal(r.startedAt, 11);
  assert.equal(r.lastObservedAt, 20);
});

scenario('sqlite-restart-preserves-baseline-peaks-and-context', t => {
  const directory = mkdtempSync(join(tmpdir(), 'raf-usage-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'main.sqlite');
  const db1 = new DatabaseSync(path);
  let firstClosed = false;
  t.after(() => { if (!firstClosed) db1.close(); });
  const f = fixture(t, configuration(), db1);
  f.measurement.baselineValue.disk[0].files = [file('existing', 4096)];
  launch(f);
  f.tracker.observe(observation(20, 123, [volume('work', [file('existing', 12288)]), volume('tmp')]));
  const before = record(f);
  assert.ok(db1.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length > 0, 'usage must reside in the supplied main SQLite database');
  db1.close();
  firstClosed = true;
  const db2 = new DatabaseSync(path);
  t.after(() => db2.close());
  const restarted = fixture(t, configuration(), db2);
  assert.deepEqual(record(restarted), before, 'a new connection and repository recover persisted data without in-memory state');
  restarted.tracker.reconcile(identity(), { at: 30, state: 'alive', observation: observation(30, 2, [volume('work', [file('existing', 8192)]), volume('tmp')]), reasons: ['restart-observation-gap'] });
  const recovered = record(restarted);
  assert.equal(recovered.peakRamBytes, 123);
  assert.equal(recovered.peakDiskBytes.work, 8192);
  assert.equal(recovered.disk.work.currentBytes, 4096, 'restart must retain the original baseline');
  assert.equal(recovered.completeness, 'partial');
  assert.ok(recovered.reasons.includes('restart-observation-gap'));
  restarted.tracker.reconcile(identity(), { at: 40, state: 'dead', reasons: ['restart-detected-death'] });
  assert.equal(record(restarted).peakRamBytes, 123);
});

scenario('sqlite-fenced-monotone-merge-across-repositories', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 100, [volume('work', [file('a', 8192)]), volume('tmp')]));
  const second = new ResourceUsageRepository(f.db);
  const smaller = structuredClone(record(f));
  smaller.peakRamBytes = 2;
  smaller.ram.peakBytes = 2;
  smaller.peakDiskBytes.work = 0;
  smaller.disk.work.peakBytes = 0;
  smaller.lastObservedAt = 15;
  second.merge(identity(), smaller);
  assert.equal(record(f).peakRamBytes, 100);
  assert.equal(record(f).peakDiskBytes.work, 8192);
  assert.equal(record(f).lastObservedAt, 20);
  const before = record(f);
  const foreign = structuredClone(before);
  foreign.context.identity.fence = 'old-worker';
  foreign.peakRamBytes = 999999;
  foreign.ram.peakBytes = 999999;
  assert.equal(second.merge(foreign.context.identity, foreign), false);
  assert.deepEqual(record(f), before);
});

scenario('sqlite-agent-and-test-same-id-are-independent', t => {
  const f = fixture(t);
  launch(f);
  const testIdentity = identity({ kind: 'test' });
  launch(f, context(testIdentity));
  f.tracker.observe(observation(20, 11));
  f.tracker.observe(observation(20, 22, [volume('work'), volume('tmp')], testIdentity));
  assert.equal(record(f).peakRamBytes, 11);
  assert.equal(record(f, testIdentity).peakRamBytes, 22);
  assert.equal(record(f, testIdentity).context.testProfile, 'node');
  assert.equal(record(f, testIdentity).context.agentType, null);
  assert.deepEqual(record(f, testIdentity).context.requestedEstimate.sources, ['conf/test-runs.json#/projects/raf/profiles/node/resourceEstimate']);
});

scenario('retention-finished-session-and-active-record', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 100));
  f.tracker.finish(identity(), { at: 40, reason: 'exit', verifiedComplete: true, reasons: [] });
  const active = launch(f, context(identity({ id: 'active', fence: 'active-fence' })));
  assert.deepEqual(f.repository.prune({ now: 1039, finishedSessionsMs: 1000, retainedTestRunIds: [] }), []);
  assert.equal(record(f).peakRamBytes, 100, 'closing/releasing the run does not erase usage before session retention');
  const removed = f.repository.prune({ now: 1041, finishedSessionsMs: 1000, retainedTestRunIds: [] });
  assert.deepEqual(removed, [{ kind: 'agent', id: 'run-a' }]);
  assert.equal(f.repository.get(identity()), null);
  assert.ok(f.repository.get(active));
  assert.deepEqual(f.repository.prune({ now: 2000, finishedSessionsMs: 1000, retainedTestRunIds: [] }), []);
});

scenario('retention-test-usage-lives-with-test-result', t => {
  const f = fixture(t);
  const key = identity({ kind: 'test', id: 'test-a' });
  launch(f, context(key));
  f.tracker.observe(observation(20, 7, [volume('work'), volume('tmp')], key));
  f.tracker.finish(key, { at: 40, reason: 'timeout', verifiedComplete: false, reasons: ['deadline'] });
  assert.deepEqual(f.repository.prune({ now: 999999, finishedSessionsMs: 1, retainedTestRunIds: ['test-a'] }), []);
  assert.equal(record(f, key).peakRamBytes, 7);
  assert.deepEqual(f.repository.prune({ now: 999999, finishedSessionsMs: 1, retainedTestRunIds: [] }), [{ kind: 'test', id: 'test-a' }]);
  assert.equal(f.repository.get(key), null);
});

scenario('persistence-bounded-summary-without-raw-snapshot-journal', t => {
  const f = fixture(t);
  launch(f);
  for (let at = 20; at < 220; at++) f.tracker.observe(observation(at, at % 19));
  const r = record(f);
  assert.equal(r.peakRamBytes, 18);
  assert.equal(r.lastObservedAt, 219);
  assert.equal('snapshots' in r, false);
  assert.equal('history' in r, false);
  let totalRows = 0;
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const table of tables) {
    const name = String(table.name).replaceAll('"', '""');
    const count = f.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get();
    totalRows += Number(count?.n ?? 0);
  }
  assert.ok(totalRows < 40, 'one run and 200 samples must retain bounded summaries rather than one row per raw sample');
});

for (const outcome of ['passed', 'assertions-failed', 'timeout', 'interrupted', 'spawn-failed']) {
  scenario(`test-result-${outcome}-embeds-persisted-summary`, t => {
    const f = fixture(t);
    const key = identity({ kind: 'test', id: `test-${outcome}` });
    if (outcome === 'spawn-failed') {
      f.tracker.prepare(context({ ...key, root: null }), true, 10);
    } else {
      launch(f, context(key));
      f.tracker.observe(observation(20, 5, [volume('work'), volume('tmp')], key));
    }
    const finishedIdentity = outcome === 'spawn-failed' ? { ...key, root: null } : key;
    f.tracker.finish(finishedIdentity, { at: 40, reason: outcome === 'passed' ? 'exit' : outcome === 'timeout' ? 'timeout' : outcome === 'spawn-failed' ? 'spawn-failure' : 'signal', verifiedComplete: outcome === 'passed', reasons: outcome === 'passed' ? [] : ['incomplete-final-observation'] });
    const input: UsageTestRunResult = { runId: key.id, outcome, timeoutCount: 2, knownRed: ['unchanged-id'], admission: { level: 'ANY_RUN', allowed: true }, cleanup: { groupReleased: true, resourceReleased: true } };
    const before = structuredClone(input);
    const result = f.tracker.attachTestRunResult(input);
    assert.deepEqual(result.resourceUsage, f.repository.get(key));
    assert.equal(result.resourceUsage?.peakRamBytes, outcome === 'spawn-failed' ? null : 5);
    const { resourceUsage: _usage, ...unchanged } = result;
    assert.deepEqual(unchanged, before, 'usage must preserve outcome, admission, cleanup and timeout accounting');
    assert.deepEqual(input, before, 'adding the summary must not mutate the caller result');
    assert.equal(record(f, key).peakRamBytes, outcome === 'spawn-failed' ? null : 5, 'released claims do not delete usage');
  });
}

scenario('test-result-without-spawn-has-null-not-fabricated-usage', t => {
  const f = fixture(t);
  const input: UsageTestRunResult = { runId: 'never-spawned', outcome: 'refused', timeoutCount: 0, knownRed: [], admission: { allowed: false }, cleanup: null };
  assert.equal(f.tracker.attachTestRunResult(input).resourceUsage, null);
  assert.equal(f.repository.get({ kind: 'test', id: input.runId }), null);
});

scenario('current-consumption-never-substitutes-historical-peak', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 4096, [volume('work', [file('a', 8192)]), volume('tmp')]));
  f.tracker.observe(observation(30, 64));
  assert.deepEqual(f.tracker.currentConsumption(identity()), { ramBytes: 64, diskBytes: { work: 0, tmp: 0 } });
  assert.equal(record(f).peakRamBytes, 4096);
  assert.equal(record(f).peakDiskBytes.work, 8192);
  f.tracker.observe(observation(40, null, []));
  assert.deepEqual(f.tracker.currentConsumption(identity()), { ramBytes: null, diskBytes: { work: null, tmp: null } }, 'a missing current sample cannot fall back to a peak or stale current value');
  assert.equal(record(f).peakRamBytes, 4096);
});

scenario('conf-admission-timeout-budget-and-next-estimate-stay-unchanged', t => {
  const conf = configuration();
  const before = structuredClone(conf);
  Object.freeze(conf.flow.resourceEstimates);
  Object.freeze(conf.flow.resources);
  Object.freeze(conf.flow.retention);
  Object.freeze(conf.flow.unitTests);
  Object.freeze(conf.flow);
  Object.freeze(conf.raf.service);
  Object.freeze(conf.raf);
  Object.freeze(conf);
  const f = fixture(t, conf);
  const first = context();
  launch(f, first);
  f.tracker.observe(observation(20, 99999999, [volume('work', [file('large', 99999999)]), volume('tmp')]));
  f.tracker.finish(identity(), { at: 40, reason: 'timeout', verifiedComplete: false, reasons: ['deadline'] });
  const next = context(identity({ id: 'next', fence: 'next-fence' }));
  assert.ok(f.tracker.prepare(next, true, 50), 'a large historical peak never introduces a new admission condition');
  assert.deepEqual(record(f, next.identity).context.requestedEstimate, first.requestedEstimate);
  assert.deepEqual(conf, before, 'accounting does not tune conf, thresholds, resource estimates, or deadline budget');
});

scenario('missing-history-does-not-block-first-launch', t => {
  const f = fixture(t);
  assert.equal(f.repository.get(identity()), null);
  assert.equal(f.tracker.currentConsumption(identity()), null);
  assert.ok(f.tracker.prepare(context(), true, 10));
});

for (const [label, invalid] of [['nan', NaN], ['infinity', Infinity], ['negative', -1], ['unsafe', Number.MAX_SAFE_INTEGER + 1]] as const) {
  scenario(`invalid-${label}-measurement-is-not-a-known-number`, t => {
    const f = fixture(t);
    launch(f);
    f.tracker.observe(observation(20, invalid, [volume('work', [file('invalid', invalid)]), volume('tmp')]));
    const r = record(f);
    assert.equal(r.peakRamBytes, null);
    assert.equal(r.peakDiskBytes.work, null);
    assert.notEqual(r.ram.completeness, 'complete');
    assert.notEqual(r.disk.work.completeness, 'complete');
    assert.ok(r.ram.reasons.length > 0);
    assert.ok(r.disk.work.reasons.length > 0);
    assert.doesNotThrow(() => JSON.stringify(r));
  });
}

scenario('baseline-unavailable-never-treats-checkout-as-zero-baseline', t => {
  const f = fixture(t);
  f.measurement.baselineValue = { at: 10, disk: [volume('work', [], false, ['baseline-unavailable']), volume('tmp')] };
  launch(f);
  f.tracker.observe(observation(20, 1, [volume('work', [file('existing', 999999)]), volume('tmp')]));
  const r = record(f);
  assert.equal(r.peakDiskBytes.work, null, 'without a verified baseline, the full checkout allocation is not a measured delta');
  assert.ok(r.disk.work.reasons.includes('baseline-unavailable'));
  assert.notEqual(r.disk.work.completeness, 'complete');
  assert.equal(r.peakRamBytes, 1);
  assert.equal(r.peakDiskBytes.tmp, 0);
});

scenario('unrequired-home-volume-is-not-added', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 1, [volume('work'), volume('tmp'), volume('home', [file('home', 999999, { fileSystemId: 'home', deviceId: 'dev-home' })])]));
  assert.deepEqual(record(f).peakDiskBytes, { work: 0, tmp: 0 });
  assert.deepEqual(Object.keys(record(f).disk).sort(), ['tmp', 'work']);
});

scenario('prepare-reentry-does-not-reset-record-or-baseline', t => {
  const f = fixture(t);
  launch(f);
  f.tracker.observe(observation(20, 100, [volume('work', [file('a', 8192)]), volume('tmp')]));
  const before = record(f);
  f.measurement.baselineValue = { at: 30, disk: [volume('work', [file('a', 8192)]), volume('tmp')] };
  f.tracker.prepare(context(), true, 30);
  assert.deepEqual(record(f), before);
  assert.equal(f.measurement.calls.filter(c => c.operation === 'baseline').length, 1);
});

scenario('ram-missing-root-is-unknown-not-zero', t => {
  const f = fixture(t);
  launch(f);
  const s = observation(20);
  s.ram = { method: 'rss-sampled', processes: [{ identity: outsider, parent: null, rssBytes: 999999 }], complete: false, reasons: ['root-identity-not-found'] };
  f.tracker.observe(s);
  assert.equal(record(f).peakRamBytes, null);
  assert.ok(record(f).ram.reasons.includes('root-identity-not-found'));
});

scenario('ram-sum-overflow-is-unknown-with-reason', t => {
  const f = fixture(t);
  launch(f);
  const s = observation(20);
  s.ram = { method: 'rss-sampled', processes: [{ identity: root, parent: null, rssBytes: Number.MAX_SAFE_INTEGER }, { identity: child, parent: root, rssBytes: 1 }], complete: true, reasons: [] };
  f.tracker.observe(s);
  const r = record(f);
  assert.equal(r.peakRamBytes, null);
  assert.ok(r.ram.reasons.length > 0);
  assert.notEqual(r.ram.completeness, 'complete');
});
