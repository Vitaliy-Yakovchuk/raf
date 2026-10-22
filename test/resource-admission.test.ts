import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { evaluateResourceAdmission, type ResourceAdmissionInput } from '../src/resource-admission.ts';
import { createResourceSnapshotReader, type ResourceProbeDependencies } from '../src/os-runtime.ts';

const GiB = 1024 ** 3;

function fixture(): ResourceAdmissionInput {
  return {
    measurement: {
      machineId: 'execution-host', loadAverage1m: 4.8, availableCores: 4,
      totalRamBytes: 10 * GiB, availableRamBytes: 4 * GiB, memoryPressure: 'normal',
      fileSystems: [{ id: 'work', totalBytes: 100 * GiB, availableBytes: 14 * GiB }],
    },
    requested: { ramBytes: GiB, diskBytes: { work: 2 * GiB } },
    unusedReservations: [{ ramBytes: GiB, diskBytes: { work: 2 * GiB } }],
    requiredFileSystemIds: ['work'],
  };
}

describe('resource-admission numeric policies', () => {
  it('admits inclusive normal boundaries after all unused reservations', () => {
    const input = fixture();
    const result = evaluateResourceAdmission(input);
    assert.equal(result.level, 'ANY_RUN');
    assert.deepEqual(result.allowed, { normal: true, hotfix: true });
    assert.deepEqual(result.remaining, { ramBytes: 2 * GiB, diskBytes: { work: 10 * GiB }, normalizedLoad: 1.2 });
    assert.deepEqual(result.measurement, input.measurement);
  });

  it('admits inclusive hotfix boundaries', () => {
    const input = fixture();
    input.measurement.loadAverage1m = 6;
    input.measurement.availableRamBytes = 3 * GiB;
    input.measurement.fileSystems[0].availableBytes = 9 * GiB;
    const result = evaluateResourceAdmission(input);
    assert.equal(result.level, 'HOTFIX_ONLY');
    assert.deepEqual(result.allowed, { normal: false, hotfix: true });
  });

  for (const [name, change, expected] of [
    ['load above normal', (x: ResourceAdmissionInput) => { x.measurement.loadAverage1m = 5.2; }, 'HOTFIX_ONLY'],
    ['load above hotfix', (x: ResourceAdmissionInput) => { x.measurement.loadAverage1m = 6.001; }, 'NO_RESOURCES'],
    ['RAM below normal', (x: ResourceAdmissionInput) => { x.measurement.availableRamBytes -= 1; }, 'HOTFIX_ONLY'],
    ['disk below normal', (x: ResourceAdmissionInput) => { x.measurement.fileSystems[0].availableBytes -= 1; }, 'HOTFIX_ONLY'],
    ['RAM below hotfix', (x: ResourceAdmissionInput) => { x.measurement.availableRamBytes = 3 * GiB - 1; }, 'NO_RESOURCES'],
    ['disk below hotfix', (x: ResourceAdmissionInput) => { x.measurement.fileSystems[0].availableBytes = 9 * GiB - 1; }, 'NO_RESOURCES'],
    ['normal RAM percentage', (x: ResourceAdmissionInput) => { x.measurement.totalRamBytes = 20 * GiB; }, 'HOTFIX_ONLY'],
    ['hotfix RAM percentage', (x: ResourceAdmissionInput) => { x.measurement.totalRamBytes = 40 * GiB; }, 'NO_RESOURCES'],
    ['normal disk percentage', (x: ResourceAdmissionInput) => { x.measurement.fileSystems[0].totalBytes = 200 * GiB; }, 'HOTFIX_ONLY'],
    ['hotfix disk percentage', (x: ResourceAdmissionInput) => { x.measurement.fileSystems[0].totalBytes = 400 * GiB; }, 'NO_RESOURCES'],
  ] as const) {
    it(name, () => {
      const input = fixture();
      change(input);
      const result = evaluateResourceAdmission(input);
      assert.equal(result.level, expected);
      assert.ok(result.reasons.length);
      assert.equal(result.allowed.normal, false);
      assert.equal(result.allowed.hotfix, expected === 'HOTFIX_ONLY');
    });
  }

  it('applies absolute minima even when percentages pass', () => {
    const input = fixture();
    input.measurement.totalRamBytes = 4 * GiB;
    input.measurement.availableRamBytes = 3 * GiB - 1;
    assert.equal(evaluateResourceAdmission(input).level, 'NO_RESOURCES');
    input.measurement.availableRamBytes = 4 * GiB;
    input.measurement.fileSystems[0] = { id: 'work', totalBytes: 20 * GiB, availableBytes: 9 * GiB - 1 };
    assert.equal(evaluateResourceAdmission(input).level, 'NO_RESOURCES');
  });

  it('checks every affected filesystem independently', () => {
    const input = fixture();
    input.requiredFileSystemIds.push('temp');
    input.measurement.fileSystems.push({ id: 'temp', totalBytes: 100 * GiB, availableBytes: 5 * GiB });
    input.requested.diskBytes.temp = 1;
    const result = evaluateResourceAdmission(input);
    assert.equal(result.level, 'NO_RESOURCES');
    assert.ok(result.reasons.some(reason => reason.includes('temp')));
  });

  it('does not count the same filesystem twice for work and temporary paths', () => {
    const input = fixture();
    input.requiredFileSystemIds.push('work');
    const result = evaluateResourceAdmission(input);
    assert.equal(result.level, 'ANY_RUN');
    assert.deepEqual(result.remaining?.diskBytes, { work: 10 * GiB });
  });

  it('accounts for the supplied task estimate regardless of hotfix eligibility', () => {
    const input = fixture();
    input.requested.ramBytes = 3 * GiB;
    const result = evaluateResourceAdmission(input);
    assert.equal(result.level, 'NO_RESOURCES');
    assert.equal(result.allowed.hotfix, false);
  });
});

describe('resource-admission evidence and purity', () => {
  it('blocks critical memory pressure even with numerical headroom', () => {
    const input = fixture();
    input.measurement.memoryPressure = 'critical';
    const result = evaluateResourceAdmission(input);
    assert.equal(result.level, 'NO_RESOURCES');
    assert.deepEqual(result.allowed, { normal: false, hotfix: false });
    assert.ok(result.reasons.length);
  });

  for (const [name, change] of [
    ['missing RAM', (x: ResourceAdmissionInput) => { delete (x.measurement as Partial<typeof x.measurement>).availableRamBytes; }],
    ['unknown pressure', (x: ResourceAdmissionInput) => { x.measurement.memoryPressure = 'unknown'; }],
    ['missing filesystem', (x: ResourceAdmissionInput) => { x.measurement.fileSystems = []; }],
    ['zero cores', (x: ResourceAdmissionInput) => { x.measurement.availableCores = 0; }],
    ['NaN load', (x: ResourceAdmissionInput) => { x.measurement.loadAverage1m = NaN; }],
    ['infinite RAM', (x: ResourceAdmissionInput) => { x.measurement.availableRamBytes = Infinity; }],
    ['negative load', (x: ResourceAdmissionInput) => { x.measurement.loadAverage1m = -1; }],
    ['missing estimate', (x: ResourceAdmissionInput) => { delete (x as Partial<ResourceAdmissionInput>).requested; }],
    ['negative estimate', (x: ResourceAdmissionInput) => { x.requested.ramBytes = -1; }],
    ['invalid pending reservation', (x: ResourceAdmissionInput) => { x.unusedReservations[0].diskBytes.work = NaN; }],
    ['impossible available RAM', (x: ResourceAdmissionInput) => { x.measurement.availableRamBytes = x.measurement.totalRamBytes + 1; }],
  ] as const) {
    it(`returns UNKNOWN for ${name}`, () => {
      const input = fixture();
      change(input);
      const result = evaluateResourceAdmission(input);
      assert.equal(result.level, 'UNKNOWN');
      assert.deepEqual(result.allowed, { normal: false, hotfix: false });
      assert.ok(result.reasons.length);
    });
  }

  it('uses only the supplied execution-host snapshot without mutating or acquiring reservations', () => {
    const input = fixture();
    const before = structuredClone(input);
    const first = evaluateResourceAdmission(input);
    assert.deepEqual(evaluateResourceAdmission(input), first);
    assert.deepEqual(input, before);
    assert.equal(first.measurement.machineId, 'execution-host');
    input.unusedReservations.push({ ramBytes: 2 * GiB, diskBytes: {} });
    assert.equal(evaluateResourceAdmission(input).level, 'NO_RESOURCES');
  });
});

describe('resource-admission with measured nonzero Linux PSI', () => {
  const { resources } = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
  const KiB = 1024;
  const totalRamBytes = fixture().measurement.totalRamBytes;
  const ramMinimum = (profile: typeof resources.normal): number =>
    Math.ceil(Math.max(profile.minRamBytes, profile.minRamFraction * totalRamBytes) / KiB) * KiB;

  for (const [level, remainingRamBytes] of [
    ['ANY_RUN', ramMinimum(resources.normal)],
    ['HOTFIX_ONLY', ramMinimum(resources.hotfix)],
    ['NO_RESOURCES', ramMinimum(resources.hotfix) - KiB],
  ] as const) {
    it(`uses RAM thresholds after reservations for ${level} despite nonzero PSI`, async () => {
      const input = fixture();
      const availableRamBytes = remainingRamBytes + input.requested.ramBytes
        + input.unusedReservations.reduce((sum, reservation) => sum + reservation.ramBytes, 0);
      const volume = input.measurement.fileSystems[0];
      const files = new Map([
        ['/proc/meminfo', `MemTotal: ${totalRamBytes / KiB} kB\nMemFree: 0 kB\nMemAvailable: ${availableRamBytes / KiB} kB\n`],
        ['/proc/pressure/memory', 'some avg10=0.10 avg60=0.05 avg300=0.01 total=912345\nfull avg10=0.02 avg60=0.01 avg300=0.01 total=400000\n'],
        ['/proc/self/cgroup', '0::/\n'],
        ['/proc/self/mountinfo', '29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n'],
        ['/sys/fs/cgroup/cpu.max', 'max 100000\n'],
        ['/sys/fs/cgroup/memory.max', 'max\n'],
        ['/sys/fs/cgroup/memory.current', '0\n'],
      ]);
      const dependencies: ResourceProbeDependencies = {
        platform: () => 'linux',
        loadAverage1m: () => input.measurement.loadAverage1m,
        availableCores: () => input.measurement.availableCores,
        totalRamBytes: () => totalRamBytes,
        readFile: async path => {
          if (!files.has(path)) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
          return files.get(path)!;
        },
        execute: async command => {
          assert.equal(command.executable.split('/').at(-1), 'df');
          return { exitCode: 0, stderr: '', stdout:
            `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/work ${volume.totalBytes / KiB} ${(volume.totalBytes - volume.availableBytes) / KiB} ${volume.availableBytes / KiB} 86% /work\n` };
        },
      };
      const snapshot = await createResourceSnapshotReader({ machineId: 'execution-host', paths: ['/work'] }, dependencies).read();
      const fileSystemId = snapshot.fileSystemByPath['/work'];
      input.measurement = snapshot.measurement;
      input.requiredFileSystemIds = [fileSystemId];
      input.requested.diskBytes = { [fileSystemId]: input.requested.diskBytes.work };
      input.unusedReservations = input.unusedReservations.map(reservation => ({
        ...reservation, diskBytes: { [fileSystemId]: reservation.diskBytes.work },
      }));

      const result = evaluateResourceAdmission(input);
      assert.equal(result.level, level);
      assert.deepEqual(result.allowed, { normal: level === 'ANY_RUN', hotfix: level !== 'NO_RESOURCES' });
      assert.equal(result.remaining?.ramBytes, remainingRamBytes);
      assert.equal(snapshot.measurement.availableRamBytes, availableRamBytes);
      assert.equal(snapshot.measurement.memoryPressure, 'normal');
      assert.deepEqual(snapshot.reasons, []);
      assert.ok(result.reasons.every(reason => !/unknown|PSI|pressure/i.test(reason)));
      if (level !== 'ANY_RUN') assert.ok(result.reasons.some(reason => /RAM/i.test(reason)));
    });
  }
});
