import assert from 'node:assert/strict';
import fs from 'node:fs';
const [beforePath, afterPath, output] = process.argv.slice(2);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const before = read(beforePath), after = read(afterPath);
assert.equal(before.status, 'passed');
assert.equal(after.status, 'passed');
const statistics = values => ({ values, min: Math.min(...values), max: Math.max(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length });
const cases = before.cases.map(a => {
  const b = after.cases.find(row => row.name === a.name);
  assert.ok(b);
  const load = (summary, c) => statistics(c.samples.map(sample => {
    const command = summary.commands.find(row => row.label === sample.label + '-ps');
    assert.ok(command);
    return command.loadAverage[0];
  }));
  return { name: a.name, loadAverage1m: { before: load(before, a), after: load(after, b) },
    stages: a.stages.map(stage => {
      const target = b.stages.find(row => row.stage === stage.stage);
      assert.ok(target);
      return { stage: stage.stage, beforeWallMs: stage.wallMs, afterWallMs: target.wallMs,
        differenceMeanMs: target.wallMs.mean - stage.wallMs.mean };
    }) };
});
fs.writeFileSync(output, JSON.stringify({ before: before.reviewed, after: after.reviewed, cases,
  caveat: 'Per-stage self wall intervals and host load are descriptive; they neither replace complete external CPU nor establish a speed threshold. The shared host is not a controlled load generator.' }, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length, output }));
