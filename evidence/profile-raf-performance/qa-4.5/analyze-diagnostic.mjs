import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [base, output] = process.argv.slice(2);
assert.ok(base && output);
const read = name => JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
const command = read('command.json'), operations = read('operations.json'), profile = read('agent-ps.cpuprofile');
assert.equal(command.cliExitCode, 0); assert.equal(command.signal, null); assert.equal(command.error, null);
assert.deepEqual(read('stdout'), []); assert.equal(fs.readFileSync(path.join(base, 'stderr'), 'utf8'), '');
const host = command.command.find(arg => arg.startsWith('--cpu-prof-dir=')).slice('--cpu-prof-dir='.length);
const names = ['state-migration-guard.ts::productionStateContext', 'state-migration-guard.ts::verifyStateContext', 'state-store.ts::openStateStore'];
const grouped = Object.fromEntries(names.map(name => {
  const calls = operations.filter(row => row.name === name);
  assert.ok(calls.length > 0);
  return [name, { calls: calls.length, wallMs: calls.map(row => row.wallMs), selfCpuMs: calls.map(row => row.cpuUserMs + row.cpuSystemMs),
    inclusiveWallTotalMs: calls.reduce((sum, row) => sum + row.wallMs, 0), inclusiveSelfCpuTotalMs: calls.reduce((sum, row) => sum + row.cpuUserMs + row.cpuSystemMs, 0) }];
}));
assert.equal(profile.samples.length, profile.timeDeltas.length);
const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame])), sampled = new Map();
for (let index = 0; index < profile.samples.length; index++) {
  const frame = nodes.get(profile.samples[index]); assert.ok(frame);
  const key = JSON.stringify({ functionName: frame.functionName || '<anonymous>', url: frame.url.replaceAll(host, '<diagnostic>'), line: frame.lineNumber + 1 });
  sampled.set(key, (sampled.get(key) ?? 0) + profile.timeDeltas[index] / 1000);
}
const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(id => [id, node.id]))), inclusiveSource = new Map();
for (let index = 0; index < profile.samples.length; index++) {
  let id = profile.samples[index]; const seen = new Set();
  while (id !== undefined) {
    const frame = nodes.get(id);
    if (frame?.url.includes('/src/')) {
      const key = JSON.stringify({ functionName: frame.functionName || '<anonymous>', url: frame.url.replaceAll(host, '<diagnostic>'), line: frame.lineNumber + 1 });
      if (!seen.has(key)) { seen.add(key); inclusiveSource.set(key, (inclusiveSource.get(key) ?? 0) + profile.timeDeltas[index] / 1000); }
    }
    id = parents.get(id);
  }
}
const topInclusiveSourceLocations = [...inclusiveSource].map(([key, sampledIntervalMs]) => ({ ...JSON.parse(key), sampledIntervalMs })).sort((a, b) => b.sampledIntervalMs - a.sampledIntervalMs).slice(0, 30);
const totalSampledIntervalMs = profile.timeDeltas.reduce((sum, delta) => sum + delta, 0) / 1000;
const topExclusiveSampleLocations = [...sampled].map(([key, sampledIntervalMs]) => ({ ...JSON.parse(key), sampledIntervalMs, fractionOfSampledIntervals: sampledIntervalMs / totalSampledIntervalMs }))
  .sort((a, b) => b.sampledIntervalMs - a.sampledIntervalMs).slice(0, 30);
const result = { host, evidenceDirectory: base, reviewed: command.reviewed, cliExitCode: command.cliExitCode, command: command.command, operations: grouped,
  operationCaveat: 'Operation wrappers are inclusive and nested. Never add store and guard totals together. CPU is process.cpuUsage self only; this diagnostic is excluded from full CPU acceptance.',
  v8: { samples: profile.samples.length, totalSampledIntervalMs, topExclusiveSampleLocations, topInclusiveSourceLocations,
    caveat: 'V8 sampled intervals locate work; timeDeltas are sampling intervals, not independent complete process-tree CPU measurements or speed acceptance.' } };
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ reviewed: command.reviewed, storeOpenCalls: grouped[names[2]].calls, totalSampledIntervalMs }));
