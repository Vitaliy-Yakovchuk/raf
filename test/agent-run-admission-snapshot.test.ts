import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildAdmissionSnapshot } from '../src/admission-snapshot.ts';
import type { AdmissionSnapshot, AdmissionSnapshotRequest, AdmissionTier } from '../src/admission-snapshot.ts';
import type { FlowPolicy } from '../src/flow-policy.ts';
import { createAppRuntime } from '../src/app-runtime.ts';
import type { AppRuntimeDependencies, RuntimeServices } from '../src/app-runtime.ts';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import type { ModelCatalog } from '../src/model-routing.ts';
import type { StateStore } from '../src/state-store.ts';

const flow = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8')) as FlowPolicy;
const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8')) as ModelCatalog;
const projects = JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
const queueId = '968456cd-fcb0-4a89-a4ec-7c30f51c34df';
const source = 'conf/flow.json#/resourceEstimates/agentTypes/implement';

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

function fixture(tier: AdmissionTier = 'normal'): Omit<AdmissionSnapshotRequest, 'policy'> & { policy: Mutable<FlowPolicy> } {
  const policy = structuredClone(flow) as Mutable<FlowPolicy>;
  const ramFloor = Math.max(policy.resources.normal.minRamBytes, policy.resources.hotfix.minRamBytes, 1);
  const diskFloor = Math.max(policy.resources.normal.minDiskBytes, policy.resources.hotfix.minDiskBytes, 1);
  return {
    policy, requestedTier: tier, queueId,
    input: {
      measurement: {
        machineId: 'unit-machine', loadAverage1m: 0, availableCores: 4,
        totalRamBytes: ramFloor * 16, availableRamBytes: ramFloor * 12, memoryPressure: 'normal',
        fileSystems: [
          { id: 'dev-a', totalBytes: diskFloor * 16, availableBytes: diskFloor * 12 },
          { id: 'dev-b', totalBytes: diskFloor * 32, availableBytes: diskFloor * 24 },
          { id: 'home', totalBytes: Math.max(policy.resources.home.minDiskBytes, 1) * 4,
            availableBytes: policy.resources.home.minDiskBytes },
        ],
      },
      requested: { ramBytes: ramFloor, diskBytes: { 'dev-a': diskFloor, 'dev-b': diskFloor * 2 } },
      unusedReservations: [
        { ramBytes: ramFloor / 2, diskBytes: { 'dev-a': diskFloor / 2, 'dev-b': diskFloor } },
        { ramBytes: ramFloor / 2, diskBytes: { 'dev-a': diskFloor / 2 } },
      ],
      requiredFileSystemIds: ['dev-a', 'dev-b'], homeFileSystemId: 'home',
      estimate: { status: 'KNOWN', sources: [source], reason: null },
    },
  };
}

function snapshot(request: AdmissionSnapshotRequest): AdmissionSnapshot {
  let result: AdmissionSnapshot | undefined;
  assert.doesNotThrow(() => { result = buildAdmissionSnapshot(request); },
    'admission must be available as a structured decision before launch');
  assert.ok(result, 'a decision snapshot is required');
  return result!;
}

function assertContext(result: AdmissionSnapshot, request: AdmissionSnapshotRequest): void {
  assert.deepEqual(result.measurement, request.input.measurement);
  assert.deepEqual(result.thresholds, request.policy.resources);
  assert.equal(result.requestedTier, request.requestedTier);
  assert.equal(result.queueId, request.queueId);
  assert.deepEqual(result.estimate, request.input.estimate);
  assert.deepEqual(result.reservation.requested, request.input.requested);
  assert.ok(result.reasons.length > 0, 'each decision has an explanation');
  assert.ok(result.reasons.every(reason => typeof reason === 'string' && reason.length > 0));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'snapshot is losslessly JSON serializable');
}

test('Z.382 ANY_RUN contains raw measurements, both conf profiles, reserves and post-reserve values', () => {
  const request = fixture();
  const before = structuredClone(request);
  const result = snapshot(request);
  assert.equal(result.level, 'ANY_RUN');
  assert.equal(result.allowed, true);
  assertContext(result, request);
  assert.deepEqual(result.reservation.unused, {
    ramBytes: request.input.unusedReservations.reduce((sum, r) => sum + r.ramBytes, 0),
    diskBytes: {
      'dev-a': request.input.unusedReservations.reduce((sum, r) => sum + (r.diskBytes['dev-a'] ?? 0), 0),
      'dev-b': request.input.unusedReservations.reduce((sum, r) => sum + (r.diskBytes['dev-b'] ?? 0), 0),
    },
  });
  assert.deepEqual(result.remaining, {
    ramBytes: request.input.measurement.availableRamBytes! - request.input.requested.ramBytes - result.reservation.unused.ramBytes,
    diskBytes: Object.fromEntries(request.input.measurement.fileSystems.map(fs => [fs.id,
      fs.availableBytes! - (request.input.requested.diskBytes[fs.id] ?? 0) - (result.reservation.unused.diskBytes[fs.id] ?? 0)])),
    normalizedLoad: 0,
  });
  assert.deepEqual(request, before, 'snapshot construction must not mutate measurement, reserves or conf');
});

for (const requestedTier of ['normal', 'hotfix'] as const) {
  test(`Z.382 HOTFIX_ONLY retains the full level for ${requestedTier} and exposes load1m / cores`, () => {
    const request = fixture(requestedTier);
    const { normal, hotfix } = request.policy.resources;
    assert.ok(hotfix.maxNormalizedLoad > normal.maxNormalizedLoad, 'policy prerequisite: distinct admission tiers');
    const normalized = (normal.maxNormalizedLoad + hotfix.maxNormalizedLoad) / 2;
    request.input.measurement.loadAverage1m = normalized * request.input.measurement.availableCores!;
    const result = snapshot(request);
    assert.equal(result.level, 'HOTFIX_ONLY');
    assert.equal(result.allowed, requestedTier === 'hotfix');
    assert.equal(result.remaining?.normalizedLoad, normalized);
    assertContext(result, request);
  });

  test(`Z.382 NO_RESOURCES for ${requestedTier} preserves measurements and applied thresholds`, () => {
    const request = fixture(requestedTier);
    request.input.measurement.loadAverage1m =
      (Math.max(request.policy.resources.normal.maxNormalizedLoad, request.policy.resources.hotfix.maxNormalizedLoad) + 1)
      * request.input.measurement.availableCores!;
    const result = snapshot(request);
    assert.equal(result.level, 'NO_RESOURCES');
    assert.equal(result.allowed, false);
    assertContext(result, request);
  });
}

for (const id of ['dev-a', 'dev-b']) {
  test(`Z.382 disk refusal identifies ${id} even when another filesystem has ample room`, () => {
    const request = fixture();
    const fs = request.input.measurement.fileSystems.find(fs => fs.id === id)!;
    const unused = request.input.unusedReservations.reduce((sum, r) => sum + (r.diskBytes[id] ?? 0), 0);
    fs.availableBytes = request.input.requested.diskBytes[id] + unused;
    const result = snapshot(request);
    assert.equal(result.level, 'NO_RESOURCES');
    assert.equal(result.allowed, false);
    assert.equal(result.remaining?.diskBytes[id], 0);
    assert.ok(result.reasons.some(reason => reason.includes(id)), 'refusal identifies the constrained filesystem');
    assertContext(result, request);
  });
}

test('Z.382 RAM refusal exposes measured and remaining RAM instead of only a threshold message', () => {
  const request = fixture();
  request.input.measurement.availableRamBytes = request.input.requested.ramBytes
    + request.input.unusedReservations.reduce((sum, r) => sum + r.ramBytes, 0);
  const result = snapshot(request);
  assert.equal(result.level, 'NO_RESOURCES');
  assert.equal(result.allowed, false);
  assert.equal(result.remaining?.ramBytes, 0);
  assertContext(result, request);
});

test('Z.382 critical memory pressure blocks hotfix while retaining measured numbers', () => {
  const request = fixture('hotfix');
  request.input.measurement.memoryPressure = 'critical';
  const result = snapshot(request);
  assert.equal(result.level, 'NO_RESOURCES');
  assert.equal(result.allowed, false);
  assertContext(result, request);
});

test('Z.382 separate HOME uses its conf threshold without requested or unused disk reservation', () => {
  const request = fixture();
  const result = snapshot(request);
  assert.equal(result.allowed, true);
  assert.equal(result.remaining?.diskBytes.home, request.policy.resources.home.minDiskBytes);
  assert.equal(Object.hasOwn(result.reservation.requested!.diskBytes, 'home'), false);
  assert.equal(Object.hasOwn(result.reservation.unused.diskBytes, 'home'), false);
  const home = request.input.measurement.fileSystems.find(fs => fs.id === 'home')!;
  home.availableBytes! -= 1;
  const refused = snapshot(request);
  assert.equal(refused.level, 'NO_RESOURCES');
  assert.equal(refused.allowed, false);
  const reason = refused.reasons.join(' ');
  for (const detail of ['home', String(home.availableBytes), String(request.policy.resources.home.minDiskBytes),
    'conf/flow.json#/resources/home/minDiskBytes']) assert.ok(reason.includes(detail), `missing HOME diagnostic: ${detail}`);
  assertContext(refused, request);
});

test('Z.382 shared HOME has one measured filesystem and one development reservation', () => {
  const request = fixture();
  request.input.homeFileSystemId = 'dev-a';
  request.input.measurement.fileSystems = request.input.measurement.fileSystems.filter(fs => fs.id !== 'home');
  const result = snapshot(request);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.measurement.fileSystems.map(fs => fs.id), ['dev-a', 'dev-b']);
  assert.deepEqual(Object.keys(result.reservation.requested!.diskBytes).sort(), ['dev-a', 'dev-b']);
  assertContext(result, request);
});

for (const field of ['loadAverage1m', 'availableCores', 'totalRamBytes', 'availableRamBytes'] as const) {
  for (const value of [null, NaN, Infinity, -Infinity]) {
    test(`Z.382 UNKNOWN ${field}=${String(value)} uses explicit null without fabricating zero`, () => {
      const request = fixture();
      request.input.measurement[field] = value;
      const result = snapshot(request);
      assert.equal(result.level, 'UNKNOWN');
      assert.equal(result.allowed, false);
      assert.equal(result.measurement[field], null);
      assert.equal(result.remaining, null);
      assert.ok(result.reasons.length > 0);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
      assert.deepEqual(result.thresholds, request.policy.resources);
    });
  }
}

for (const field of ['totalBytes', 'availableBytes'] as const) {
  test(`Z.382 UNKNOWN disk ${field} preserves filesystem identity and explicit null`, () => {
    const request = fixture();
    request.input.measurement.fileSystems[1][field] = null;
    const result = snapshot(request);
    assert.equal(result.level, 'UNKNOWN');
    assert.equal(result.allowed, false);
    assert.equal(result.measurement.fileSystems[1].id, 'dev-b');
    assert.equal(result.measurement.fileSystems[1][field], null);
    assert.equal(result.remaining, null);
    assert.ok(result.reasons.some(reason => reason.includes('dev-b')));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });
}

test('Z.382 UNKNOWN estimate retains its exact conf source and explanation', () => {
  const request = fixture();
  request.input.estimate = { status: 'UNKNOWN', sources: [source], reason: `Missing estimate at ${source}` };
  const result = snapshot(request);
  assert.equal(result.level, 'UNKNOWN');
  assert.equal(result.allowed, false);
  assert.deepEqual(result.estimate, request.input.estimate);
  assert.equal(result.reservation.requested, null, 'unknown estimate is not a trustworthy reservation');
  assert.ok(result.reasons.join(' ').includes(source));
});

test('Z.382 UNKNOWN memory pressure preserves the signal and explains the unavailable measurement', () => {
  const request = fixture();
  request.input.measurement.memoryPressure = 'unknown';
  const result = snapshot(request);
  assert.equal(result.level, 'UNKNOWN');
  assert.equal(result.allowed, false);
  assert.equal(result.measurement.memoryPressure, 'unknown');
  assert.equal(result.remaining, null);
  assert.ok(result.reasons.length > 0);
});

test('Z.382 unavailable required filesystem is explicit rather than silently omitted', () => {
  const request = fixture();
  request.input.measurement.fileSystems = request.input.measurement.fileSystems.filter(fs => fs.id !== 'dev-b');
  const result = snapshot(request);
  assert.equal(result.level, 'UNKNOWN');
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some(reason => reason.includes('dev-b')));
  assert.deepEqual(result.measurement.fileSystems.find(fs => fs.id === 'dev-b'),
    { id: 'dev-b', totalBytes: null, availableBytes: null });
  assert.equal(result.remaining, null);
});

for (const value of [undefined, null, '500', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`Z.382 invalid HOME conf ${String(value)} returns UNKNOWN with its exact pointer`, () => {
    const request = fixture();
    const home = request.policy.resources.home as unknown as Record<string, unknown>;
    if (value === undefined) delete home.minDiskBytes;
    else home.minDiskBytes = value;
    const result = snapshot(request);
    assert.equal(result.level, 'UNKNOWN');
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.join(' ').includes('conf/flow.json#/resources/home/minDiskBytes'));
    assert.equal(result.remaining, null);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'invalid conf does not leave undefined/NaN fields');
  });
}

test('Z.382 thresholds follow the supplied conf revision and are detached from subsequent changes', () => {
  const firstRequest = fixture();
  const secondRequest = fixture();
  for (const tier of ['normal', 'hotfix'] as const) {
    const original = secondRequest.policy.resources[tier];
    secondRequest.policy.resources[tier] = {
      maxNormalizedLoad: original.maxNormalizedLoad / 2,
      minRamFraction: original.minRamFraction / 2,
      minRamBytes: original.minRamBytes + 17,
      minDiskFraction: original.minDiskFraction / 2,
      minDiskBytes: original.minDiskBytes + 31,
    };
  }
  secondRequest.policy.resources.home.minDiskBytes += 7;
  secondRequest.input.measurement.fileSystems.find(fs => fs.id === 'home')!.availableBytes = secondRequest.policy.resources.home.minDiskBytes;
  const normalized = (firstRequest.policy.resources.normal.maxNormalizedLoad + secondRequest.policy.resources.normal.maxNormalizedLoad) / 2;
  firstRequest.input.measurement.loadAverage1m = normalized * firstRequest.input.measurement.availableCores!;
  secondRequest.input.measurement.loadAverage1m = firstRequest.input.measurement.loadAverage1m;
  const first = snapshot(firstRequest);
  const second = snapshot(secondRequest);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false, 'decision must use the changed conf load threshold');
  assertContext(first, firstRequest);
  assertContext(second, secondRequest);
  assert.notDeepEqual(first.thresholds, second.thresholds);
  const frozen = structuredClone(second);
  secondRequest.policy.resources.home.minDiskBytes += 1;
  secondRequest.input.measurement.availableRamBytes! -= 1;
  secondRequest.input.requested.ramBytes += 1;
  assert.deepEqual(second, frozen, 'decision must retain the conf and measurement used before spawn');
});

function transportSnapshot(level: AdmissionSnapshot['level'], tier: AdmissionTier): AdmissionSnapshot {
  const request = fixture(tier);
  return {
    level, requestedTier: tier,
    allowed: level === 'ANY_RUN' || (level === 'HOTFIX_ONLY' && tier === 'hotfix'),
    reasons: [`unit admission ${level}`], measurement: request.input.measurement,
    thresholds: request.policy.resources,
    reservation: { requested: request.input.requested, unused: { ramBytes: 0, diskBytes: {} } },
    remaining: level === 'UNKNOWN' ? null : {
      ramBytes: request.input.measurement.availableRamBytes! - request.input.requested.ramBytes,
      diskBytes: { 'dev-a': 123456, 'dev-b': 654321, home: request.policy.resources.home.minDiskBytes },
      normalizedLoad: 0,
    },
    estimate: request.input.estimate, queueId,
  };
}

async function runWithAdmission(admission: AdmissionSnapshot | null, authorize = true) {
  const calls = { reserve: 0, spawn: 0, ready: 0, commit: 0, cleanup: 0 };
  const root = '/unit/orchestrator';
  const runId = '813e07e8-f351-49ba-bd81-264586af8227';
  const selection = { status: 'selected', runner: 'codex', model: 'unit-model', effort: 'low',
    reason: 'unit routing port', quota: 'available' } as const;
  const assignment = { root, changes: [{ id: 'complete-raf-flow-contracts',
    items: [{ id: 'Z.382', description: 'unit assignment' }] }], baselineArchives: [] };
  const request = fixture(admission?.requestedTier ?? 'normal');
  const services: RuntimeServices = {
    authorizeMain: async () => { if (!authorize) throw new Error('unit authorization refused'); },
    assignment: { validate: async () => ({ ok: true, snapshot: assignment }), compose: async () => 'unit brief' },
    resolveTask: async () => ({ branch: 'develop', outcome: 'unit', writeBoundaries: [root], sources: [],
      reportSchema: { type: 'object' }, requested: request.input.requested,
      requiredFileSystemIds: [...request.input.requiredFileSystemIds] }),
    route: async () => ({ ok: true, project: 'raf', branch: 'develop', cwd: `${root}/raf-develop` }),
    routingSnapshot: async () => ({ runnerEnabled: { codex: true }, cliAvailable: { codex: true }, quotas: [] }),
    selectModel: () => selection, listModels: () => [],
    prepareReport: async () => ({ reportPath: '/unit/report.json', reportWrapper: { wrap: command => command },
      cleanupUnstarted: async () => { calls.cleanup++; } }),
    reserve: async () => {
      calls.reserve++;
      return admission?.allowed
        ? { admitted: true, admission }
        : { admitted: false, reason: admission?.reasons.join('; ') ?? 'unit refusal', admission };
    },
    adapter: { start: async () => { calls.spawn++; return { tmuxSession: 'unit-session', selection }; } },
    verifyStarted: async () => { calls.ready++; return { pid: 42, startedAt: '2026-10-23T00:00:00Z',
      runner: 'codex', runnerSessionId: 'unit-runner', tmuxSession: 'unit-session', evidence: {} }; },
    commitStarted: async () => { calls.commit++; return true; },
    compensate: async () => ({ stopped: true }), abortLaunch: async () => { calls.cleanup++; },
    control: {
      ps: async () => [], update: async () => { throw new Error('unused update'); },
      message: async () => { throw new Error('unused message'); }, close: async () => { throw new Error('unused close'); },
      interrupt: async () => {}, attachMain: async () => { throw new Error('unused attach'); },
    },
  };
  const store = {
    close: () => {}, initializeRunners: () => {}, recordCommandDuration: () => {},
  } as unknown as StateStore;
  const commandConstants = { ...constants,
    commands: constants.commands.filter((command: { path: string[] }) => command.path.join(' ') === 'agent run') };
  const dependencies: AppRuntimeDependencies = {
    loadConfiguration: async () => ({ catalog, models, commandTiming: { emaAlpha: 0.5 } }),
    openStore: async () => store, createServices: async () => services,
    nextRunIdentity: () => ({ runId, tmuxSession: 'unit-session' }), now: () => 100,
  };
  const runtime = createAppRuntime({ orchestratorRoot: root, confRoot: `${root}/conf`, artifactPath: '/unit/catalog.json',
    statePath: '/unit/state.sqlite', tmpRoot: '/unit/tmp', mode: 'test', commandStartedAtMs: 100,
    resolveCaller: async () => ({ addressId: 'main' }) }, dependencies);
  const catalog = compileCatalog(commandConstants, models, Object.keys(runtime.handlers), projects);
  try {
    const result = await execute(['agent', 'run', '--id', 'unit-admission', '--type',
      admission?.requestedTier === 'hotfix' ? 'hotfix' : 'implement', '--project', 'raf',
      '--features', 'complete-raf-flow-contracts', '--phase', 'implement', '--complexity', 'ordinary',
      '--tasks', 'complete-raf-flow-contracts:Z.382'], catalog, runtime.handlers);
    return { ...result, calls };
  } finally {
    await runtime.close();
  }
}

for (const [level, tier] of [['ANY_RUN', 'normal'], ['HOTFIX_ONLY', 'hotfix']] as const) {
  test(`Z.382 agent run success exposes the actual ${level}/${tier} decision at admission`, async () => {
    const expected = transportSnapshot(level, tier);
    const result = await runWithAdmission(expected);
    assert.equal(result.calls.reserve, 1, 'fixture must reach the actual admission boundary');
    assert.equal(result.exitCode, 0, 'ready agent is a successful CLI result');
    assert.equal(result.calls.spawn, 1);
    assert.equal(result.calls.ready, 1);
    assert.equal(result.calls.commit, 1);
    assert.deepEqual(JSON.parse(result.stdout).admission, expected);
  });
}

test('Z.382 agent run UNKNOWN refusal exposes details.admission without spawning or waiting', async () => {
  const expected = transportSnapshot('UNKNOWN', 'normal');
  expected.measurement.fileSystems[1].availableBytes = null;
  expected.reasons = ['Missing availableBytes for dev-b'];
  const result = await runWithAdmission(expected);
  assert.equal(result.calls.reserve, 1, 'fixture must reach admission, not fail setup');
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.calls.spawn, 0);
  assert.equal(result.calls.commit, 0);
  const error = JSON.parse(result.stderr);
  assert.deepEqual(error.details.admission, expected);
});

test('Z.382 failure before admission exposes null rather than a fabricated resource decision', async () => {
  const result = await runWithAdmission(null, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.calls.reserve, 0);
  assert.equal(result.calls.spawn, 0);
  assert.equal(JSON.parse(result.stderr).details.admission, null);
});
