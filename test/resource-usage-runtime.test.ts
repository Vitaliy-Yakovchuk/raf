import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as usage from '../src/resource-usage-runtime.ts';
import type { ResourceUsageRepository, UsageIdentity, UsageContext } from '../src/resource-usage.ts';

test('one resource observation pass scans processes once and stats each regular output file once', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'raf-usage-budget-'));
  const output = join(directory, 'output.txt');
  fs.writeFileSync(output, 'Own output');
  const originalRead = fs.readFileSync;
  const originalList = fs.readdirSync;
  const originalStat = fs.statSync;
  const originalLstat = fs.lstatSync;
  let scans = 0;
  let fileStats = 0;
  t.mock.method(fs, 'readFileSync', (path: string, ...args: any[]) => {
    if (path === '/proc/sys/kernel/random/boot_id') return 'fixture-boot\n';
    const match = /^\/proc\/(\d+)\/(stat|status)$/.exec(String(path));
    if (!match) return (originalRead as any)(path, ...args);
    if (match[2] === 'status') return 'VmRSS:\t4 kB\n';
    const fields = Array(52).fill('0');
    fields[0] = 'S'; fields[1] = '1'; fields[19] = match[1];
    return `${match[1]} (fixture) ${fields.join(' ')}\n`;
  });
  t.mock.method(fs, 'readdirSync', (path: string, ...args: any[]) => {
    if (path === '/proc') { scans++; return Array.from({ length: 260 }, (_, i) => String(10000 + i)); }
    if (/^\/proc\/\d+\/fd$/.test(String(path))) return [];
    return (originalList as any)(path, ...args);
  });
  t.mock.method(fs, 'statSync', (path: string, ...args: any[]) => { if (path === output) fileStats++; return (originalStat as any)(path, ...args); });
  t.mock.method(fs, 'lstatSync', (path: string, ...args: any[]) => { if (path === output) fileStats++; return (originalLstat as any)(path, ...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(directory, { recursive: true, force: true }); });
  const context = { attributedPaths: [directory], requiredFileSystems: [{ id: 'work', paths: [directory] }], identity: { kind: 'agent', id: 'first' } } as UsageContext;
  const repository = { get: () => ({ context }) } as unknown as ResourceUsageRepository;
  const measurement = usage.createUsageMeasurement(repository);
  const identity = (pid: number): UsageIdentity => ({ kind: 'agent', id: String(pid), machineId: 'fixture-machine', bootId: 'fixture-boot', fence: 'fixture-fence', root: { pid, startTicks: String(pid), bootId: 'fixture-boot' } });
  const scope = (usage as { withUsageMeasurementSnapshots?: <T>(action: () => Promise<T>) => Promise<T> }).withUsageMeasurementSnapshots ?? (async action => action());
  await scope(async () => {
    for (const pid of [10000, 10001]) {
      const result = measurement.sample(identity(pid), 100);
      assert.equal(result.ram?.method, 'rss-sampled');
      if (result.ram?.method === 'rss-sampled') assert.deepEqual(result.ram.processes.map(row => [row.identity.pid, row.rssBytes]), [[pid, 4096]]);
      assert.equal(result.disk[0].files.length, 1);
      assert.equal(result.disk[0].files[0].path, output);
    }
  });
  assert.equal(scans, 1, 'Active agent resource samples share one procfs scan');
  assert.equal(fileStats, 2, 'Each output file needs one metadata read per fresh sample');
  await scope(async () => { measurement.sample(identity(10000), 200); });
  assert.equal(scans, 2, 'The next command must collect a fresh process snapshot');
});
