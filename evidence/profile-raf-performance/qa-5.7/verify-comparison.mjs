import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [beforePath, afterPath, output] = process.argv.slice(2);
assert.ok(beforePath && afterPath && output, 'Pass before/after summary paths and an output path');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const close = (a, b) => assert.ok(Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-9, `${a} != ${b}`);
const payloads = (state, table) => (state[table] ?? []).map(row => row.payload ? JSON.parse(row.payload) : row);
const matrix = ['empty', 'live', 'finished', 'missing', 'pid-reused', 'unverifiable'];
const semanticTables = ['sessions', 'admission_reservations', 'reminders', 'pending_intents', 'qa_ps_events', 'closure_notices', 'result_notices', 'reminder_deliveries'];
const derivedTables = ['command_timings', 'raf_cost_profile', 'raf_health_cpu', 'raf_health_summary', 'runners'];
const stats = values => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { samples: values.length, mean, min: Math.min(...values), max: Math.max(...values),
    standardDeviation: Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length), values };
};
const canonical = (value, summary, key = '') => {
  if (typeof value === 'string') {
    if (['payload', 'intent'].includes(key)) return canonical(JSON.parse(value), summary);
    if (['startedAt', 'observedAt', 'finishedAt', 'updatedAt', 'finished_at'].includes(key)) return '<time>';
    for (const identity of [...summary.actors.live, summary.actors.gone]) {
      if (value === identity.evidence.command) return `<actor:${identity.runnerSessionId}>`;
      if (value === identity.evidence.command + ' stale-run') return `<actor:${identity.runnerSessionId}:stale>`;
    }
    return value.replaceAll(summary.base, '<fixture>');
  }
  if (key === 'pid' && typeof value === 'number') {
    const identity = [...summary.actors.live, summary.actors.gone].find(row => row.pid === value);
    assert.ok(identity, 'Only known fixture identities can be normalized');
    return `<pid:${identity.runnerSessionId}>`;
  }
  if (Array.isArray(value)) return value.map(row => canonical(row, summary));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v, summary, k)]));
  return value;
};
function verify(file) {
  const summary = read(file), base = path.dirname(file), ev = path.join(base, 'ev');
  assert.equal(summary.status, 'passed');
  assert.equal(summary.cleanup.complete, true);
  assert.equal(summary.cleanup.service.state, 'stopped');
  assert.deepEqual(summary.cleanup.remainingProcesses, []);
  assert.deepEqual(summary.cleanup.integrityCheck, [{ integrity_check: 'ok' }]);
  for (const actor of summary.cleanup.actors) { assert.equal(actor.exitCode, 0); assert.equal(actor.signal, null); }
  assert.deepEqual(summary.cases.map(row => row.name), matrix);
  assert.ok(summary.repetitions > 1);
  const commandMap = new Map(summary.commands.map(row => [row.label, row]));
  let expectedFailures = 0;
  for (const command of summary.commands) {
    const raw = suffix => fs.readFileSync(path.join(ev, command.label + suffix));
    assert.equal(raw('.stdout').length, command.stdoutBytes);
    assert.equal(raw('.stderr').length, command.stderrBytes);
    assert.equal(command.signal, null); assert.equal(command.error, null);
    assert.deepEqual(read(path.join(ev, command.label + '.json')), command);
    assert.deepEqual(read(path.join(ev, command.label + '-rusage.json')), command.rusage);
    assert.equal(command.rusage.method, 'Linux wait4 rusage');
    assert.equal(command.rusage.childExitCode, command.cliExitCode);
    assert.ok(command.rusage.cpuUserMs >= 0 && command.rusage.cpuSystemMs >= 0);
    close(command.cpuFullMs, command.rusage.cpuUserMs + command.rusage.cpuSystemMs);
    if (command.label.startsWith('unverifiable-') && command.command.slice(-2).join(' ') === 'agent ps') {
      assert.equal(command.cliExitCode, 1); expectedFailures++;
      assert.equal(JSON.parse(raw('.stderr')).code, 'PROCESS_SCAN_UNKNOWN');
    } else { assert.equal(command.cliExitCode, 0); JSON.parse(raw('.stdout')); }
  }
  for (const c of summary.cases) {
    assert.equal(c.samples.length, summary.repetitions);
    const seed = fs.readFileSync(path.join(ev, path.basename(c.seedDatabase)));
    assert.equal(createHash('sha256').update(seed).digest('hex'), c.seedSha256);
    for (const sample of c.samples) {
      assert.deepEqual(read(path.join(ev, sample.label + '-sample.json')), sample);
      const before = read(path.join(ev, sample.label + '-stats-before.stdout')).profile.rows;
      const after = read(path.join(ev, sample.label + '-stats-after.stdout')).profile.rows.filter(row => row.command === 'agent ps');
      assert.equal(sample.delta.length, after.length);
      for (const row of after) {
        const previous = before.find(old => ['scope', 'command', 'stage', 'executor'].every(key => old[key] === row[key]));
        const delta = sample.delta.find(old => old.stage === row.stage && old.executor === row.executor);
        assert.ok(delta);
        for (const [out, input] of Object.entries({ samples: 'samples', wallMs: 'wallTotalMs', cpuUserMs: 'cpuUserTotalMs', cpuSystemMs: 'cpuSystemTotalMs', cpuSamples: 'cpuSamples', cpuUnavailableSamples: 'cpuUnavailableSamples' })) {
          if (row[input] === null) assert.equal(delta[out], null); else close(delta[out], row[input] - (previous?.[input] ?? 0));
        }
      }
      const own = sample.delta.filter(row => row.executor === 'self');
      assert.ok(own.every(row => row.cpuSamples > 0));
      close(sample.wallMs, own.reduce((sum, row) => sum + row.wallMs, 0));
      close(sample.cpuSelfMs, own.reduce((sum, row) => sum + row.cpuUserMs + row.cpuSystemMs, 0));
      close(sample.cpuFullMs, commandMap.get(sample.label + '-ps').cpuFullMs);
      assert.ok(sample.cpuFullMs + 1e-6 >= sample.cpuSelfMs, 'External full CPU includes every measured self interval');
      assert.deepEqual(sample.rusage, commandMap.get(sample.label + '-ps').rusage);
      const state = read(path.join(ev, sample.label + '-state-after.json'));
      for (const [table, initial] of Object.entries(c.initial)) {
        if (!semanticTables.includes(table) && !derivedTables.includes(table)) assert.deepEqual(state[table], initial, `${c.name}: unrelated SQLite table ${table} changed`);
      }
      const sessions = payloads(state, 'sessions'), events = state.qa_ps_events.map(row => JSON.parse(row.intent));
      const reservations = payloads(state, 'admission_reservations');
      if (c.name === 'unverifiable') {
        const row = sessions.find(row => row.runId === 'qa-unverifiable');
        assert.equal(row.state, 'running'); assert.equal(row.observation.state, 'unknown');
        assert.ok(reservations.some(row => row.runId === 'qa-unverifiable')); assert.deepEqual(events, []);
      } else {
        const result = read(path.join(ev, sample.label + '-ps.stdout'));
        assert.deepEqual(result.map(row => row.addressId).sort(), c.name === 'live' ? ['main', 'qa-hotfix'] : []);
        assert.ok(result.every(row => row.observation.state === 'alive'));
      }
      if (['missing', 'pid-reused'].includes(c.name)) {
        const id = c.name === 'missing' ? 'qa-missing' : 'qa-reused';
        assert.equal(sessions.find(row => row.runId === id).state, 'finished');
        assert.equal(sessions.find(row => row.runId === id).result.status, 'failed');
        assert.ok(!reservations.some(row => row.runId === id));
        for (const name of ['agent.failed', 'agent.closed']) assert.equal(events.filter(row => row.runId === id && row.event === name).length, 1);
        const reminder = payloads(state, 'reminders').find(row => row.id === 'qa-reminder');
        assert.equal(reminder.assignedTo, 'main'); assert.equal(reminder.createdFor, 'qa-owner'); assert.equal(reminder.at, '2099-01-01T00:00:00.000Z');
      }
    }
    for (const field of ['wallMs', 'externalWallMs', 'cpuSelfMs', 'cpuFullMs']) {
      const measured = stats(c.samples.map(row => row[field]));
      for (const key of ['samples', 'mean', 'min', 'max', 'standardDeviation']) close(c[field][key], measured[key]);
      assert.deepEqual(c[field].values, measured.values);
    }
  }
  assert.equal(expectedFailures, 2 + summary.repetitions * 2);
  return { summary, ev, commands: summary.commands.length, expectedFailures };
}
const before = verify(beforePath), after = verify(afterPath);
assert.deepEqual(before.summary.sourceConfiguration, after.summary.sourceConfiguration, 'Source conf must remain pinned between series');
assert.deepEqual(before.summary.fixtureConfiguration, after.summary.fixtureConfiguration, 'Normalized conf must be identical');
assert.equal(before.summary.harnessSha256, after.summary.harnessSha256);
for (const key of ['node', 'platform', 'release', 'cpus', 'osRelease', 'mode']) assert.deepEqual(before.summary.environment[key], after.summary.environment[key]);
assert.equal(before.summary.repetitions, after.summary.repetitions);
const comparisons = [];
for (const name of matrix) {
  const a = before.summary.cases.find(row => row.name === name), b = after.summary.cases.find(row => row.name === name);
  for (const table of semanticTables) assert.deepEqual(canonical(a.initial[table], before.summary), canonical(b.initial[table], after.summary), `${name}: restored seed ${table} semantics`);
  for (let i = 0; i < a.samples.length; i++) {
    const left = read(path.join(before.ev, a.samples[i].label + '-state-after.json'));
    const right = read(path.join(after.ev, b.samples[i].label + '-state-after.json'));
    for (const table of semanticTables) assert.deepEqual(canonical(left[table], before.summary), canonical(right[table], after.summary), `${name}: ${table} semantics`);
    const suffix = name === 'unverifiable' ? '-ps.stderr' : '-ps.stdout';
    assert.deepEqual(canonical(read(path.join(before.ev, a.samples[i].label + suffix)), before.summary), canonical(read(path.join(after.ev, b.samples[i].label + suffix)), after.summary), `${name}: CLI semantics`);
  }
  assert.equal(a.diagnostic.psCalls.length, ['empty', 'finished'].includes(name) ? 0 : 1);
  assert.equal(b.diagnostic.psCalls.length, ['empty', 'finished'].includes(name) ? 0 : 1);
  const metrics = Object.fromEntries(['wallMs', 'externalWallMs', 'cpuSelfMs', 'cpuFullMs'].map(field => [field, {
    before: a[field], after: b[field], differenceMeanMs: b[field].mean - a[field].mean,
    observedRangesOverlap: Math.max(a[field].min, b[field].min) <= Math.min(a[field].max, b[field].max),
  }]));
  comparisons.push({ name, semanticsPreserved: true, metrics,
    favorableMeans: b.wallMs.mean < a.wallMs.mean && b.externalWallMs.mean < a.externalWallMs.mean && b.cpuFullMs.mean <= a.cpuFullMs.mean,
    observedRangesStrictlyImprove: b.wallMs.max < a.wallMs.min && b.externalWallMs.max < a.externalWallMs.min && b.cpuFullMs.max < a.cpuFullMs.min,
    mostExpensiveStageBefore: a.mostExpensiveStage, mostExpensiveStageAfter: b.mostExpensiveStage });
}
const result = { evidenceIntegrity: 'verified', speedAcceptance: 'requires review of means and spread; integrity is not speed acceptance',
  before: { sha: before.summary.reviewed, commands: before.commands }, after: { sha: after.summary.reviewed, commands: after.commands },
  allCasesHaveFavorableMeans: comparisons.every(row => row.favorableMeans), comparisons,
  normalization: 'Only known actor PIDs/commands, fixture base paths and lifecycle timestamps; reminder dates, addresses, revisions, results, reservations and event content remain checked.' };
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ evidenceIntegrity: result.evidenceIntegrity, allCasesHaveFavorableMeans: result.allCasesHaveFavorableMeans, cases: comparisons.length }));
