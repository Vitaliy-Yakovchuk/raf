import fs from 'node:fs';
import assert from 'node:assert/strict';

// Offline review of retained observations; this does not execute integration scenarios.
const dir = import.meta.dirname;
const read = file => JSON.parse(fs.readFileSync(`${dir}/${file}`));
const timing = (snapshot, command = 'command stats') => snapshot.timings.find(r => r.command === command);
const displayed = (snapshot, command = 'command stats') => snapshot.commands.find(r => r.command === command);
const observations = {};
const i1 = read('I1.json');
let expected = null;
assert.equal(i1.before, null);
for (const sample of i1.samples) {
  expected = expected === null ? sample.durationMs : expected * (1 - sample.alpha) + sample.durationMs * sample.alpha;
  assert.ok(Math.abs(sample.row.averageMs - expected) < 1e-9);
  assert.ok(sample.row.updatedAt >= sample.start && sample.row.updatedAt <= sample.completedAt);
}
assert.equal(i1.rows.length, 1);
observations.I1 = { status: 'passed', finalEma: expected };
const i2 = read('I2.json');
assert.ok([155, 159].includes(i2.after[0].average_ms));
assert.equal(i2.after.length, 1);
assert.ok(i2.results.every(r => r.cliExitCode === 0));
assert.equal(i2.lock.result.cliExitCode, 1);
assert.equal(JSON.parse(i2.lock.result.stderr).errcode, 5);
assert.deepEqual(i2.lock.after, i2.after);
observations.I2 = { status: 'passed', finalEma: i2.after[0].average_ms, lockCli: 1 };
const i3 = read('I3-snapshot.json'), stats = read('I3-snapshot.stdout');
assert.equal(i3.cliExitCode, 0);
assert.equal(displayed(stats, 'runner enable').averageMs, 0);
assert.equal(displayed(stats, 'agent run').averageMs, null);
assert.equal(displayed(stats, 'agent run').updatedAt, null);
assert.equal(displayed(stats, 'agent ps').budgetMs, null);
assert.equal(displayed(stats).budgetMs, 1000);
assert.equal(displayed(stats).averageMs, timing(i3.before).average_ms);
assert.equal(displayed(read('I3-next.stdout')).averageMs, timing(i3.after).average_ms);
assert.equal(read('I3-help.json').cliExitCode, 0);
assert.equal(read('I3-parser.json').cliExitCode, 1);
assert.deepEqual(read('I3-help.json').before, read('I3-help.json').after);
assert.deepEqual(read('I3-parser.json').before, read('I3-parser.json').after);
observations.I3 = { status: 'passed', wrapper: ['commands', 'profile', 'health'] };
assert.equal(read('I4-success.json').cliExitCode, 0);
assert.equal(read('I4-runtime-error.json').cliExitCode, 1);
for (const label of ['I4-success', 'I4-runtime-error']) {
  const call = read(label + '.json');
  assert.equal(call.after.audit.length - call.before.audit.length, 1);
}
const crash = read('I4-crash.json');
assert.equal(crash.signal, 'SIGKILL');
assert.equal(crash.cliExitCode, null);
assert.deepEqual(crash.before, crash.after);
assert.equal(read('I4-state-refusal.json').cliExitCode, 1);
const refusal = read('I4-refusal-files.json');
assert.equal(refusal.before, refusal.after);
assert.deepEqual(refusal.files, ['.raf']);
observations.I4 = { status: 'passed', crashSignal: crash.signal };
const i5 = read('I5.json');
assert.equal(i5.samples.length, 16);
assert.equal(i5.volume.sessions.n, 120);
assert.equal(i5.volume.reminders.reduce((n, r) => n + r.n, 0), 1200);
for (const sample of i5.samples) {
  assert.equal(sample.cliExitCode, 0);
  assert.equal(sample.auditDelta, 1);
  assert.ok(sample.inferredDurationMs >= 0 && sample.inferredDurationMs <= sample.wallMs);
  assert.ok(Math.abs(sample.old.average_ms * (1 - i5.config.emaAlpha) + sample.inferredDurationMs * i5.config.emaAlpha - sample.next.average_ms) < 1e-9);
}
const finalMean = timing(i5.final).average_ms;
assert.ok(finalMean < i5.config.sqliteOnlyMeanBudgetMs);
observations.I5 = { status: 'passed', finalMeanMs: finalMean, budgetMs: i5.config.sqliteOnlyMeanBudgetMs,
  inferredDurationRangeMs: [Math.min(...i5.samples.map(s => s.inferredDurationMs)), Math.max(...i5.samples.map(s => s.inferredDurationMs))],
  wallArithmeticMeanMs: i5.samples.reduce((sum, s) => sum + s.wallMs, 0) / i5.samples.length };
const unit = read('boundary-green.TestRunResult.json');
assert.equal(unit.outcome, 'passed');
assert.equal(unit.exitCode, 0);
assert.equal(read('boundary-green.capture.json').cliExitCode, 0);
assert.equal(unit.passed.length, 56);
assert.equal(unit.cleanup.complete, true);
assert.equal(unit.timedOut, false);
assert.equal(unit.timeoutCount, 0);
for (const field of ['knownRed', 'unexecuted', 'unknown']) assert.deepEqual(unit[field], []);
assert.equal(unit.groupState, 'complete');
observations.unit = { status: 'passed', runId: unit.runId, count: unit.passed.length, nextAction: unit.nextAction,
  stderrCapture: 'Unavailable separately in exec_command; original merged stream retained without reconstruction.' };
const i6 = read('I6.json');
assert.equal(i6.status, 'unexecuted');
assert.equal(i6.attach.cliExitCode, 0);
assert.equal(i6.launch.cliExitCode, 1);
assert.equal(i6.cleanup.cliExitCode, 0);
assert.match(i6.reason, /RESOURCE_WAIT_FAILED/);
assert.match(i6.reason, /live reader has unknown protection/);
observations.I6 = { status: 'unexecuted', reason: 'RESOURCE_WAIT_FAILED / live reader has unknown protection',
  liveReaderRunId: 'ee08e714-de16-40ac-a65f-c5a4f89f6d13', nativePayloadExitCode: null };
fs.writeFileSync(`${dir}/review.json`, JSON.stringify({ purpose: 'Offline evidence consistency review, not a substitute for integration execution',
  reviewedAt: new Date().toISOString(), itemStatus: 'failed', observations }, null, 2) + '\n');
console.log(JSON.stringify(observations));
