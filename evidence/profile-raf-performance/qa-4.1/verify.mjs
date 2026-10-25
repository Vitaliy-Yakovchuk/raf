import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const base = import.meta.dirname;
const host = path.join(base, 'host');
const read = name => fs.readFileSync(path.join(host, name));
const json = name => JSON.parse(read(name));
const hash = value => createHash('sha256').update(value).digest('hex');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const entries = fs.readFileSync(path.join(base, 'host.sha256'), 'utf8').trim().split('\n').map(line => {
  const match = /^([0-9a-f]{64})  (\.\/.+)$/.exec(line);
  assert.ok(match);
  assert.equal(hash(read(match[2])), match[1], match[2]);
  return match[2];
});
const files = fs.readdirSync(host, { recursive: true }).filter(name => fs.statSync(path.join(host, name)).isFile()).map(name => './' + name);
assert.deepEqual(entries.toSorted(), files.toSorted());
assert.equal(entries.length, 490);
const summary = json('summary.json');
assert.equal(summary.status, 'passed');
assert.equal(summary.reviewed, '1212a1330a2b097620bd491e5cc8d2f549c774b9');
assert.equal(summary.repetitions, 5);
assert.equal(summary.cleanup.complete, true);
assert.deepEqual(summary.cleanup.remainingProcesses, []);
assert.equal(summary.cleanup.service.state, 'stopped');
assert.ok(summary.cleanup.actors.every(row => row.exitCode === 0 && row.signal === null));
assert.deepEqual(summary.cleanup.integrityCheck, [{ integrity_check: 'ok' }]);
assert.deepEqual(summary.cases.map(row => row.name), ['empty', 'live', 'finished', 'missing', 'pid-reused', 'unverifiable']);
const key = row => JSON.stringify([row.scope, row.command, row.stage, row.executor]);
const counters = { samples: 'samples', wallMs: 'wallTotalMs', cpuUserMs: 'cpuUserTotalMs', cpuSystemMs: 'cpuSystemTotalMs',
  cpuSamples: 'cpuSamples', cpuUnavailableSamples: 'cpuUnavailableSamples' };
const payloads = (state, table) => state[table].map(row => row.payload ? JSON.parse(row.payload) : row);
let statsCount = 0, psCount = 0, expectedFailures = 0;
for (const command of summary.commands) {
  assert.deepEqual(json('ev/' + command.label + '.json'), command);
  assert.equal(read('ev/' + command.label + '.stdout').length, command.stdoutBytes);
  assert.equal(read('ev/' + command.label + '.stderr').length, command.stderrBytes);
  assert.equal(command.error, null);
  assert.equal(command.signal, null);
  const isPs = command.command.slice(-2).join(' ') === 'agent ps';
  const isStats = command.command.slice(-2).join(' ') === 'command stats';
  if (isPs) psCount++;
  if (isStats) statsCount++;
  if (isPs && command.label.startsWith('unverifiable-')) {
    expectedFailures++;
    assert.equal(command.cliExitCode, 1);
    assert.equal(json('ev/' + command.label + '.stderr').code, 'PROCESS_SCAN_UNKNOWN');
  } else {
    assert.equal(command.cliExitCode, 0);
    json('ev/' + command.label + '.stdout');
  }
}
for (const scenario of summary.cases) {
  assert.equal(scenario.samples.length, 5);
  assert.equal(hash(read('ev/' + path.basename(scenario.seedDatabase))), scenario.seedSha256);
  for (const sample of scenario.samples) {
    assert.deepEqual(json('ev/' + sample.label + '-sample.json'), sample);
    const before = json('ev/' + sample.label + '-stats-before.stdout').profile.rows;
    const after = json('ev/' + sample.label + '-stats-after.stdout').profile.rows.filter(row => row.command === 'agent ps');
    assert.equal(after.length, sample.delta.length);
    for (const row of after) {
      assert.equal(row.scope, 'command');
      const previous = before.find(old => key(old) === key(row));
      const delta = sample.delta.find(value => value.stage === row.stage && value.executor === row.executor);
      assert.ok(delta);
      for (const [output, input] of Object.entries(counters)) {
        const expected = row[input] === null ? null : row[input] - (previous?.[input] ?? 0);
        if (expected === null) assert.equal(delta[output], null); else close(delta[output], expected);
      }
      if (row.executor === 'self') assert.ok(delta.cpuSamples > 0);
    }
    const self = sample.delta.filter(row => row.executor === 'self');
    close(sample.wallMs, self.reduce((sum, row) => sum + row.wallMs, 0));
    close(sample.cpuSelfMs, self.reduce((sum, row) => sum + row.cpuUserMs + row.cpuSystemMs, 0));
    close(sample.externalWallMs, json('ev/' + sample.label + '-ps.json').wallMs);
    const state = json('ev/' + sample.label + '-state-after.json');
    const sessions = payloads(state, 'sessions'), reservations = payloads(state, 'admission_reservations');
    const events = state.qa_ps_events.map(row => JSON.parse(row.intent));
    if (scenario.name === 'unverifiable') {
      const row = sessions.find(row => row.runId === 'qa-unverifiable');
      assert.equal(row.state, 'running');
      assert.equal(row.observation.state, 'unknown');
      assert.ok(reservations.some(reservation => reservation.runId === row.runId));
      assert.deepEqual(events, []);
    } else {
      const result = json('ev/' + sample.label + '-ps.stdout');
      assert.deepEqual(result.map(row => row.addressId).sort(), scenario.name === 'live' ? ['main', 'qa-hotfix'] : []);
      for (const row of result) assert.equal(row.observation.state, 'alive');
    }
    if (['missing', 'pid-reused'].includes(scenario.name)) {
      const id = scenario.name === 'missing' ? 'qa-missing' : 'qa-reused';
      assert.equal(sessions.find(row => row.runId === id).state, 'finished');
      assert.ok(!reservations.some(row => row.runId === id));
      assert.equal(events.filter(row => row.runId === id && row.event === 'agent.failed').length, 1);
      assert.equal(events.filter(row => row.runId === id && row.event === 'agent.closed').length, 1);
      const reminder = payloads(state, 'reminders').find(row => row.id === 'qa-reminder');
      assert.equal(reminder.assignedTo, 'main');
      assert.equal(reminder.createdFor, 'qa-owner');
      assert.equal(reminder.at, '2099-01-01T00:00:00.000Z');
    }
  }
  for (const field of ['wallMs', 'externalWallMs', 'cpuSelfMs']) {
    const values = scenario.samples.map(row => row[field]);
    const total = values.reduce((a, b) => a + b, 0), mean = total / values.length;
    close(scenario[field].total, total);
    close(scenario[field].mean, mean);
    close(scenario[field].standardDeviation, Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length));
    close(scenario[field].min, Math.min(...values));
    close(scenario[field].max, Math.max(...values));
  }
  assert.equal(scenario.mostExpensiveStage.stage, 'startup/config');
  const count = { empty: 0, live: 2, finished: 0, missing: 1, 'pid-reused': 1, unverifiable: 1 }[scenario.name];
  assert.equal(scenario.diagnostic.psCalls.length, count);
  for (const call of scenario.diagnostic.psCalls) assert.deepEqual(call.args, ['-ww', '-axo', 'pid=,lstart=,command=']);
}
assert.equal(summary.commands.length, 135);
assert.equal(statsCount, 60);
assert.equal(psCount, 72);
assert.equal(expectedFailures, 12);
console.log(JSON.stringify({ status: 'passed', manifestFiles: entries.length, scenarios: summary.cases.length, measuredSamples: 30,
  commands: summary.commands.length, statsCount, psCount, expectedFailures, unexpectedFailures: 0, cleanupComplete: true }));
