import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadFlowPolicy, type FlowPolicy } from '../src/flow-policy.ts';
import { deriveResourceAdmissionVolumes, type ResourceAdmissionVolumes } from '../src/home-disk-admission.ts';
import { evaluateResourceAdmission, type ResourceAdmissionInput } from '../src/resource-admission.ts';
import { resolveAgentResourceEstimate } from '../src/resource-estimates.ts';

const flowDocument = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
const homePointer = 'conf/flow.json#/resources/home/minDiskBytes';
const paths = { orchestratorRoot: '/development/root', workspace: '/development/work', home: '/user/home' };
const mapping = { [paths.orchestratorRoot]: 'dev-root', [paths.workspace]: 'dev-work', [paths.home]: 'home-volume' };

function policy(minDiskBytes = flowDocument.resources.home.minDiskBytes): FlowPolicy {
  const result = structuredClone(flowDocument) as FlowPolicy;
  return { ...result, resources: { ...result.resources, home: { minDiskBytes } } };
}

function input(availableHomeBytes: number, selectedPolicy = policy()): ResourceAdmissionInput {
  const diskTotal = Math.max(selectedPolicy.resources.normal.minDiskBytes, selectedPolicy.resources.hotfix.minDiskBytes, 1) * 100;
  const ramTotal = Math.max(selectedPolicy.resources.normal.minRamBytes, selectedPolicy.resources.hotfix.minRamBytes, 1) * 100;
  return {
    measurement: {
      machineId: 'z386-unit-machine', loadAverage1m: 0, availableCores: 4,
      totalRamBytes: ramTotal, availableRamBytes: ramTotal, memoryPressure: 'normal',
      fileSystems: [
        { id: 'dev-root', totalBytes: diskTotal, availableBytes: diskTotal },
        { id: 'dev-work', totalBytes: diskTotal, availableBytes: diskTotal },
        { id: 'home-volume', totalBytes: Math.max(diskTotal, availableHomeBytes), availableBytes: availableHomeBytes },
      ],
    },
    requested: { ramBytes: 17, diskBytes: { 'dev-root': 19, 'dev-work': 19 } },
    unusedReservations: [{ ramBytes: 23, diskBytes: { 'dev-root': 29, 'dev-work': 29 } }],
    requiredFileSystemIds: ['dev-root', 'dev-work'], homeFileSystemId: 'home-volume',
  };
}

function derive(fileSystemByPath: Readonly<Record<string, string | null>>): ResourceAdmissionVolumes {
  let result: ResourceAdmissionVolumes | undefined;
  assert.doesNotThrow(() => { result = deriveResourceAdmissionVolumes(paths, fileSystemByPath); }, 'volume derivation must return the Z.386 mapping');
  assert.ok(result);
  return result;
}

function assertAllowed(result: ReturnType<typeof evaluateResourceAdmission>): void {
  assert.equal(result.level, 'ANY_RUN', result.reasons.join('; '));
  assert.deepEqual(result.allowed, { normal: true, hotfix: true });
}

function loaded(document: unknown): FlowPolicy {
  const root = mkdtempSync(join(tmpdir(), 'z386-flow-'));
  try {
    const file = join(root, 'flow.json');
    writeFileSync(file, JSON.stringify(document));
    return loadFlowPolicy(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('[Z.386 unit] distinct HOME below conf threshold blocks normal and hotfix with exact diagnostics', () => {
  const threshold = flowDocument.resources.home.minDiskBytes;
  assert.ok(Number.isSafeInteger(threshold) && threshold > 0, 'configured owner threshold is a positive safe integer');
  const request = input(threshold - 1);
  const before = structuredClone(request);
  const result = evaluateResourceAdmission(request);
  assert.equal(result.level, 'NO_RESOURCES');
  assert.deepEqual(result.allowed, { normal: false, hotfix: false });
  for (const fragment of ['home-volume', String(threshold - 1), String(threshold), homePointer]) {
    assert.ok(result.reasons.some(reason => reason.includes(fragment)), `HOME refusal must name ${fragment}`);
  }
  assert.equal(result.remaining?.diskBytes['home-volume'], threshold - 1);
  assert.deepEqual(request, before, 'admission must not mutate measurements or reservations');
});

for (const offset of [0, 1]) {
  test(`[Z.386 unit] distinct HOME at conf threshold ${offset === 0 ? 'exactly' : 'plus one'} permits both tiers without a reservation`, () => {
    const threshold = flowDocument.resources.home.minDiskBytes;
    const request = input(threshold + offset);
    request.unusedReservations.push({ ramBytes: 0, diskBytes: { 'home-volume': threshold + 100 } });
    const result = evaluateResourceAdmission(request);
    assertAllowed(result);
    assert.equal(result.remaining?.diskBytes['home-volume'], threshold + offset);
    assert.deepEqual(Object.keys(request.requested.diskBytes).sort(), ['dev-root', 'dev-work']);
  });
}

test('[Z.386 unit] small HOME uses neither development byte nor percentage thresholds', () => {
  const selected = policy(701);
  const request = input(701, selected);
  request.measurement.fileSystems[2].totalBytes = 10 ** 15;
  assert.ok(701 < selected.resources.hotfix.minDiskBytes);
  assertAllowed(evaluateResourceAdmission(request, selected));
});

test('[Z.386 unit] injected conf threshold changes the decision without changing estimate', () => {
  const request = input(800, policy(700));
  const before = structuredClone(request);
  assertAllowed(evaluateResourceAdmission(request, policy(700)));
  const denied = evaluateResourceAdmission(request, policy(900));
  assert.equal(denied.level, 'NO_RESOURCES');
  assert.deepEqual(denied.allowed, { normal: false, hotfix: false });
  assert.ok(denied.reasons.some(reason => reason.includes('900') && reason.includes(homePointer)));
  assert.deepEqual(request, before);
});

test('[Z.386 unit] zero HOME threshold is valid and still requires a measured HOME', () => {
  assertAllowed(evaluateResourceAdmission(input(0, policy(0)), policy(0)));
});

for (const sharedId of ['dev-root', 'dev-work']) {
  test(`[Z.386 unit] HOME sharing ${sharedId} has one measurement and one development reservation`, () => {
    const selected = policy(10 ** 15);
    const request = input(0, selected);
    request.homeFileSystemId = sharedId;
    request.measurement.fileSystems = request.measurement.fileSystems.filter(fs => fs.id !== 'home-volume');
    const result = evaluateResourceAdmission(request, selected);
    assertAllowed(result);
    assert.equal(result.measurement.fileSystems.filter(fs => fs.id === sharedId).length, 1);
    assert.equal(result.remaining?.diskBytes[sharedId], request.measurement.fileSystems.find(fs => fs.id === sharedId)!.availableBytes - 19 - 29);
    assert.equal(Object.keys(result.remaining!.diskBytes).length, 2);
  });
}

test('[Z.386 unit] sufficient HOME never masks a development disk refusal', () => {
  const request = input(flowDocument.resources.home.minDiskBytes);
  request.measurement.fileSystems[1].availableBytes = 0;
  const result = evaluateResourceAdmission(request);
  assert.equal(result.level, 'NO_RESOURCES');
  assert.deepEqual(result.allowed, { normal: false, hotfix: false });
  assert.ok(result.reasons.some(reason => reason.includes('dev-work')));
});

test('[Z.386 unit] unrelated full state and temporary filesystems do not affect admission', () => {
  const request = input(flowDocument.resources.home.minDiskBytes);
  request.measurement.fileSystems.push(
    { id: 'state-volume', totalBytes: 1000, availableBytes: 0 },
    { id: 'tmp-volume', totalBytes: 1000, availableBytes: 0 },
  );
  const result = evaluateResourceAdmission(request);
  assertAllowed(result);
  assert.equal(Object.hasOwn(result.remaining!.diskBytes, 'state-volume'), false);
  assert.equal(Object.hasOwn(result.remaining!.diskBytes, 'tmp-volume'), false);
});

test('[Z.386 unit] an explicit zero estimate does not skip the HOME check', () => {
  const request = input(0, policy(1));
  request.requested = { ramBytes: 0, diskBytes: { 'dev-root': 0, 'dev-work': 0 } };
  const result = evaluateResourceAdmission(request, policy(1));
  assert.equal(result.level, 'NO_RESOURCES');
  assert.deepEqual(result.allowed, { normal: false, hotfix: false });
});

test('[Z.386 unit] development estimates and unused reservations do not reduce HOME availability', () => {
  const selected = policy(701);
  const request = input(701, selected);
  request.requested.diskBytes = { 'dev-root': 702, 'dev-work': 702 };
  request.unusedReservations = [{ ramBytes: 0, diskBytes: { 'dev-root': 703, 'dev-work': 703, 'home-volume': 704 } }];
  const result = evaluateResourceAdmission(request, selected);
  assertAllowed(result);
  assert.equal(result.remaining?.diskBytes['home-volume'], 701);
});

for (const missing of ['mapping', 'measurement', 'availableBytes'] as const) {
  test(`[Z.386 unit] unknown HOME ${missing} gives UNKNOWN and cannot admit either tier`, () => {
    const request = input(701, policy(701));
    if (missing === 'mapping') request.homeFileSystemId = null;
    if (missing === 'measurement') request.measurement.fileSystems.pop();
    if (missing === 'availableBytes') Object.assign(request.measurement.fileSystems[2], { availableBytes: null });
    const result = evaluateResourceAdmission(request, policy(701));
    assert.equal(result.level, 'UNKNOWN');
    assert.deepEqual(result.allowed, { normal: false, hotfix: false });
    assert.equal(result.remaining, null);
    assert.ok(result.reasons.some(reason => /home/i.test(reason)));
  });
}

test('[Z.386 unit] derivation keeps distinct HOME out of the development reservation set', () => {
  const result = derive({ ...mapping, '/state': 'state-volume', '/temporary': 'tmp-volume' });
  assert.deepEqual([...result.requiredFileSystemIds].sort(), ['dev-root', 'dev-work']);
  assert.equal(result.homeFileSystemId, 'home-volume');
  assert.deepEqual(result.reasons, []);
  const estimate = resolveAgentResourceEstimate({
    flow: { resourceEstimates: { agentTypes: { implement: { ramBytes: 17, diskBytesPerFileSystem: 19 } } } },
    type: 'implement', project: 'raf', tasks: [], fileSystemIds: result.requiredFileSystemIds,
  });
  assert.equal(estimate.status, 'KNOWN');
  if (estimate.status !== 'KNOWN') assert.fail(estimate.reason);
  assert.deepEqual(estimate.reservation, { ramBytes: 17, diskBytes: { 'dev-root': 19, 'dev-work': 19 } });
});

for (const sharedId of ['dev-root', 'dev-work']) {
  test(`[Z.386 unit] derivation deduplicates HOME aliases of ${sharedId} by filesystem identity`, () => {
    const result = derive({ ...mapping, [paths.home]: sharedId });
    assert.deepEqual([...result.requiredFileSystemIds].sort(), ['dev-root', 'dev-work']);
    assert.equal(result.homeFileSystemId, sharedId);
    assert.deepEqual(result.reasons, []);
  });
}

test('[Z.386 unit] all development and HOME paths on one filesystem produce one required ID', () => {
  const result = derive(Object.fromEntries(Object.values(paths).map(path => [path, 'one-volume'])));
  assert.deepEqual(result.requiredFileSystemIds, ['one-volume']);
  assert.equal(result.homeFileSystemId, 'one-volume');
  assert.deepEqual(result.reasons, []);
});

for (const missing of [undefined, null]) {
  test(`[Z.386 unit] derivation reports ${String(missing)} HOME mapping instead of guessing a development volume`, () => {
    const fileSystemByPath: Record<string, string | null> = { ...mapping };
    if (missing === undefined) delete fileSystemByPath[paths.home];
    else fileSystemByPath[paths.home] = null;
    const result = derive(fileSystemByPath);
    assert.equal(result.homeFileSystemId, null);
    assert.ok(result.reasons.some(reason => reason.includes(paths.home)));
  });
}

test('[Z.386 unit] loader preserves a valid HOME conf threshold including zero', () => {
  for (const value of [0, 701, Number.MAX_SAFE_INTEGER]) {
    const document = structuredClone(flowDocument);
    document.resources.home = { minDiskBytes: value };
    assert.equal(loaded(document).resources.home?.minDiskBytes, value);
  }
});

const invalidHome = [undefined, null, {}, { minDiskBytes: null }, { minDiskBytes: '701' }, { minDiskBytes: -1 }, { minDiskBytes: 0.5 }, { minDiskBytes: Number.MAX_SAFE_INTEGER + 1 }, { minDiskBytes: true }];
for (const [index, value] of invalidHome.entries()) {
  test(`[Z.386 unit] invalid or missing HOME conf #${index} is rejected with its exact pointer`, () => {
    const document = structuredClone(flowDocument);
    if (value === undefined) delete document.resources.home;
    else document.resources.home = value;
    assert.throws(() => loaded(document), error => error instanceof Error && error.message.includes(homePointer));
  });
}

test('[Z.386 unit] invalid injected HOME policy is UNKNOWN with its pointer and no fallback', () => {
  const invalid = structuredClone(policy()) as unknown as { resources: { home?: unknown } };
  delete invalid.resources.home;
  const result = evaluateResourceAdmission(input(10 ** 12), invalid as FlowPolicy);
  assert.equal(result.level, 'UNKNOWN');
  assert.deepEqual(result.allowed, { normal: false, hotfix: false });
  assert.equal(result.remaining, null);
  assert.ok(result.reasons.some(reason => reason.includes(homePointer)));
});
