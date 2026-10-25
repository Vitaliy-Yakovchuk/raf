import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = path.resolve(import.meta.dirname, '..');
const atomic = (file, value) => {
  fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
};
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const statistics = values => {
  assert.ok(values.length > 1 && values.every(Number.isFinite));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { count: values.length, mean, min: Math.min(...values), max: Math.max(...values),
    standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length), values };
};
const replaceOnce = (text, old, replacement) => {
  assert.equal(text.split(old).length, 2, 'Harness boundary changed: ' + old);
  return text.replace(old, replacement);
};
const run = (label, executable, args, cwd, output, environment = process.env) => {
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const record = { command: [executable, ...args], cwd, startedAt, endedAt: new Date().toISOString(),
    cliExitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(output, label + '.' + stream), record[stream]);
  atomic(path.join(output, label + '.json'), record);
  return record;
};
const nativeMain = original => {
  let code = replaceOnce(original, "import { spawn, spawnSync } from 'node:child_process';", "import { spawn, spawnSync } from 'node:child_process';\nimport { DatabaseSync } from 'node:sqlite';");
  code = replaceOnce(code, 'const run = (label, args, budget = 900000) => {', `const stateSnapshot = () => {
  const file = path.join(stand, '.raf/state.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]));
  } finally { db.close(); }
};
const run = (label, args, budget = 900000) => {`);
  const originalSpawn = `  const r = spawnSync(process.execPath, [cli, ...args], { cwd: path.dirname(path.dirname(cli)), env: process.env,
    encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024 });`;
  const measure = `import json, os, sys, time
start = time.monotonic_ns()
pid = os.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
_, status, usage = os.wait4(pid, 0)
code = os.waitstatus_to_exitcode(status)
with open(sys.argv[1], 'w') as out:
    json.dump(dict(method='Linux wait4 rusage', scope='CLI and synchronously reaped descendants only', cpuUserMs=usage.ru_utime*1000, cpuSystemMs=usage.ru_stime*1000, wallMs=(time.monotonic_ns()-start)/1e6, childExitCode=code, fullRuntimeCpuMs=None, incompleteReason='Persistent worker, service and tmux children may outlive CLI or belong to another parent; this rusage is not full runtime CPU'), out)
sys.exit(code if code >= 0 else 128-code)
`;
  code = replaceOnce(code, originalSpawn, `  const measured = args[0] === 'agent' && args[1] === 'run';
  const initialState = measured ? stateSnapshot() : null;
  const cpuFile = path.join(stand, 'ev', label + '-rusage.json');
  if (measured) atomic(path.join(stand, 'ev', label + '-initial-state.json'), initialState);
  const r = spawnSync(measured ? 'python3' : process.execPath,
    measured ? ['-c', ${JSON.stringify(measure)}, cpuFile, process.execPath, cli, ...args] : [cli, ...args],
    { cwd: path.dirname(path.dirname(cli)), env: process.env, encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024 });
  const finalState = measured ? stateSnapshot() : null;
  if (measured) atomic(path.join(stand, 'ev', label + '-final-state.json'), finalState);`);
  code = replaceOnce(code, '    signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? \'\', stderr: r.stderr ?? \'\' };', `    signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
    measurement: measured ? {
      rusage: fs.existsSync(cpuFile) ? JSON.parse(fs.readFileSync(cpuFile)) : null,
      initialState: label + '-initial-state.json', finalState: label + '-final-state.json',
      profileDelta: (finalState?.raf_cost_profile ?? []).map(row => JSON.parse(row.payload)).filter(row => row.command === 'agent run').map(row => {
        const previous = (initialState?.raf_cost_profile ?? []).map(value => JSON.parse(value.payload)).find(old => old.scope === row.scope && old.command === row.command && old.stage === row.stage && old.executor === row.executor);
        const delta = key => row[key] === null ? null : row[key] - (previous?.[key] ?? 0);
        return { scope: row.scope, stage: row.stage, executor: row.executor, samples: delta('samples'), wallMs: delta('wallTotalMs'),
          cpuUserMs: delta('cpuUserTotalMs'), cpuSystemMs: delta('cpuSystemTotalMs'), cpuSamples: delta('cpuSamples'),
          cpuUnavailableSamples: delta('cpuUnavailableSamples'), cpuAvailability: row.cpuAvailability, cpuSource: row.cpuSource, unavailableReason: row.unavailableReason };
      })
    } : null };`);
  return code;
};
const prepareNative = (output, conf) => {
    const mainHelper = path.join(output, 'native-main.mjs');
    fs.writeFileSync(mainHelper, nativeMain(fs.readFileSync(path.join(source, 'scripts/qa-agent-run-main.mjs'), 'utf8')));
    let code = fs.readFileSync(path.join(source, 'scripts/qa-agent-run-live.mjs'), 'utf8');
    code = code.replace(/from '(\.\.?\/[^']+)'/g, (_, relative) => 'from ' + JSON.stringify(pathToFileURL(path.resolve(source, 'scripts', relative)).href));
    code = replaceOnce(code, "const source = path.resolve(import.meta.dirname, '..');", 'const source = ' + JSON.stringify(source) + ';');
    code = replaceOnce(code, "  assert.equal(git(source, 'rev-parse', 'HEAD'), reviewed);", "  assert.equal(git(source, 'rev-parse', reviewed + '^{commit}'), reviewed);");
    code = replaceOnce(code, "  assert.equal(git(source, 'status', '--porcelain'), '', 'Run from a clean reviewed checkout');", "  summary.sourceWorkspaceIgnored = git(source, 'status', '--porcelain');");
    code = code.replaceAll("path.join(source, '../conf'", 'path.join(' + JSON.stringify(conf));
    code = replaceOnce(code, "  fs.cpSync(path.join(" + JSON.stringify(conf) + "), path.join(root, 'conf'), { recursive: true });",
      "  const {copyAgentPsConfiguration}=await import(" + JSON.stringify(pathToFileURL(path.join(source, 'scripts/qa-agent-ps-configuration.mjs')).href) + ");\n  copyAgentPsConfiguration(" + JSON.stringify(conf) + ", path.join(root, 'conf'));");
    assert.equal(code.split("path.join(source, 'scripts/qa-agent-run-main.mjs')").length, 3);
    code = code.replaceAll("path.join(source, 'scripts/qa-agent-run-main.mjs')", JSON.stringify(mainHelper));
    const nativeHarness = path.join(output, 'native-live.mjs'); fs.writeFileSync(nativeHarness, code);
    return { mainHelper, nativeHarness, hashes: { main: hash(mainHelper), live: hash(nativeHarness) } };
};
const [mode, ...args] = process.argv.slice(2);
if (mode === 'prepare') {
  const [confArgument, outputArgument] = args;
  const output = path.resolve(outputArgument); assert.ok(!fs.existsSync(output)); fs.mkdirSync(output, { recursive: true });
  console.log(JSON.stringify(prepareNative(output, path.resolve(confArgument))));
} else if (mode === 'run') {
  const [reviewed, confArgument, countArgument, outputArgument] = args;
  assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
  const conf = path.resolve(confArgument), output = path.resolve(outputArgument), repetitions = Number(countArgument);
  assert.ok(Number.isSafeInteger(repetitions) && repetitions > 1);
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.CODEX_HOME, '/home/dev/.codex');
  assert.equal(process.env.LC_ALL, 'C');
  assert.ok(!fs.existsSync(output), 'Use a new output directory; never retry an unknown run');
  process.umask(0o077); fs.mkdirSync(output, { recursive: true });
  const helpers = ['scripts/qa-agent-ps-comparison.mjs', 'scripts/qa-agent-ps-configuration.mjs',
    'scripts/qa-agent-run-live.mjs', 'scripts/qa-agent-run-main.mjs', 'scripts/qa-agent-run-audit.mjs',
    'scripts/qa-agent-run-actor.mjs', 'scripts/qa-agent-run-evidence.mjs', 'scripts/qa-main-agent-channel-metadata.mjs',
    'test/helpers/z4044-live-trust.mjs', 'evidence/profile-raf-performance/qa-5.7/verify-comparison.mjs'];
  const summary = { status: 'incomplete', reviewed, source, output, repetitions, startedAt: new Date().toISOString(),
    machine: { platform: process.platform, architecture: process.arch, release: os.release(), cpus: os.availableParallelism(), node: process.version,
      osRelease: fs.readFileSync('/etc/os-release', 'utf8') },
    configuration: Object.fromEntries(['raf-constants.json', 'raf.json', 'projects.json', 'flow.json', 'models.json', 'test-runs.json'].map(file => [file, hash(path.join(conf, file))])),
    harness: { self: hash(fileURLToPath(import.meta.url)), files: Object.fromEntries(helpers.map(file => [file, hash(path.join(source, file))])) },
    workspace: run('source-workspace', 'git', ['status', '--porcelain'], source, output).stdout,
    agentPs: null, agentRun: [],
    limitations: ['Full agent run CPU is unknown without accounting across persistent worker/tmux/service lifetimes. CLI wait4 is a partial measurement, never a CPU pass.',
      'Native actors and unchanged routing use the existing credentials selector; credentials are not copied. Provider model/effort is never overridden.',
      'Each native repetition uses a fresh isolated stand. The two launch positions have different initial session counts and are compared separately.',
      'The ps harness uses restored SQLite and real idle process fixtures; it does not prove native agent run readiness or delivery.',
      'The native harness uses registered main code in an isolated clone, plus its recorded QA entry instrumentation; it does not independently measure activated hotfix generation inventory cost.'],
    nextAction: 'Review original native checks, SQLite and primary errors; obtain full agent run CPU accounting before accepting 5.11.' };
  atomic(path.join(output, 'summary.json'), summary);
  try {
    const commit = run('source-commit', 'git', ['rev-parse', reviewed + '^{commit}'], source, output);
    assert.equal(commit.cliExitCode, 0); assert.equal(commit.stdout.trim(), reviewed);
    const ps = run('agent-ps', process.execPath, [path.join(source, 'scripts/qa-agent-ps-comparison.mjs'), reviewed, conf, String(repetitions)], source, output);
    const metadata = ps.stdout.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.evidence && value.base ? [value] : []; } catch { return []; } })[0];
    summary.agentPs = { command: 'agent-ps.json', cliExitCode: ps.cliExitCode, evidence: metadata?.evidence ?? null };
    assert.equal(ps.cliExitCode, 0, 'PS series failed; preserve primary result, do not retry');
    assert.ok(metadata && fs.existsSync(metadata.evidence));
    const { nativeHarness, hashes } = prepareNative(output, conf);
    summary.harness.generated = hashes;
    for (let index = 0; index < repetitions; index++) {
      const label = 'agent-run-' + (index + 1);
      const loadBefore = { at: new Date().toISOString(), loadAverage: os.loadavg(), processCount: fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).length };
      const result = run(label, process.execPath, [nativeHarness, reviewed], source, output);
      const native = result.stdout.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.stand && value.evidence ? [value] : []; } catch { return []; } }).at(-1);
      const record = { label, cliExitCode: result.cliExitCode, loadBefore, evidence: native?.evidence ?? null,
        status: native?.status ?? 'unknown', cleanup: native?.cleanup ?? null, launches: [] };
      summary.agentRun.push(record); atomic(path.join(output, 'summary.json'), summary);
      assert.equal(result.cliExitCode, 0, 'Native scenario failed; preserve primary result, do not retry');
      assert.equal(native.status, 'completed-review-required');
      assert.equal(native.cleanup.complete, true);
      assert.equal(native.unexecuted.length, 0);
      assert.ok(native.checks.every(check => check.status === 'passed'));
      for (const launch of native.launches) {
        const measured = JSON.parse(fs.readFileSync(path.join(native.evidence, launch.originalResult)));
        assert.equal(measured.cliExitCode, 0); assert.equal(measured.signal, null);
        assert.equal(measured.measurement.rusage.childExitCode, 0);
        assert.ok(measured.measurement.profileDelta.some(row => row.executor === 'self' && row.samples > 0));
        record.launches.push({ label: launch.label, source: path.join(native.evidence, launch.originalResult), measurement: measured.measurement });
      }
      assert.deepEqual(record.launches.map(launch => launch.label), ['launch-a', 'launch-b']);
      atomic(path.join(output, 'summary.json'), summary);
    }
    summary.semanticStatus = 'completed-review-required';
  } catch (error) { summary.status = 'failed'; summary.error = { message: error.message, stack: error.stack }; }
  finally {
    summary.endedAt = new Date().toISOString(); atomic(path.join(output, 'summary.json'), summary);
    console.log(JSON.stringify({ status: summary.status, evidence: path.join(output, 'summary.json'), reviewed }));
    process.exitCode = summary.status === 'failed' ? 1 : 2;
  }
} else if (mode === 'compare') {
  const [beforeFile, afterFile, outputArgument] = args;
  const before = JSON.parse(fs.readFileSync(beforeFile)), after = JSON.parse(fs.readFileSync(afterFile));
  const output = path.resolve(outputArgument); assert.ok(!fs.existsSync(output)); fs.mkdirSync(output, { recursive: true });
  const result = { status: 'incomplete', before: path.resolve(beforeFile), after: path.resolve(afterFile),
    baseline: before.reviewed, candidate: after.reviewed, agentRun: [], nextAction: 'Full agent run CPU and activated-generation live evidence remain required; no automatic succeeded.' };
  try {
    assert.deepEqual(after.configuration, before.configuration); assert.deepEqual(after.machine, before.machine);
    assert.deepEqual(after.harness.files, before.harness.files); assert.equal(after.harness.self, before.harness.self);
    assert.equal(after.repetitions, before.repetitions); assert.ok(before.repetitions > 1);
    assert.equal(before.semanticStatus, 'completed-review-required'); assert.equal(after.semanticStatus, 'completed-review-required');
    const verifier = run('agent-ps-comparison', process.execPath, [path.join(source, 'evidence/profile-raf-performance/qa-5.7/verify-comparison.mjs'),
      before.agentPs.evidence, after.agentPs.evidence, path.join(output, 'agent-ps-comparison.json')], source, output);
    result.agentPs = { cliExitCode: verifier.cliExitCode, evidence: 'agent-ps-comparison.json' };
    for (const label of ['launch-a', 'launch-b']) {
      const select = series => series.agentRun.map(sample => sample.launches.find(launch => launch.label === label).measurement);
      const initial = select(before), final = select(after);
      const stats = values => ({ wallMs: statistics(values.map(value => value.rusage.wallMs)),
        cpuCliTreeMs: statistics(values.map(value => value.rusage.cpuUserMs + value.rusage.cpuSystemMs)),
        cpuSelfProfileMs: statistics(values.map(value => value.profileDelta.filter(row => row.executor === 'self').reduce((sum, row) => sum + row.cpuUserMs + row.cpuSystemMs, 0))),
        fullRuntimeCpuMs: null, stages: values.map(value => value.profileDelta) });
      const baseline = stats(initial), candidate = stats(final);
      result.agentRun.push({ label, baseline, candidate, meanWallReduced: candidate.wallMs.mean < baseline.wallMs.mean,
        fullCpuNonIncrease: null, reason: 'CLI wait4 omits persistent workers/tmux/service; partial CPU cannot establish non-increase.' });
    }
  } catch (error) { result.status = 'failed'; result.error = { message: error.message, stack: error.stack }; }
  atomic(path.join(output, 'summary.json'), result); console.log(JSON.stringify({ status: result.status, evidence: path.join(output, 'summary.json') }));
  process.exitCode = result.status === 'failed' ? 1 : 2;
} else throw Error('Usage: run <full-sha> <conf-directory> <sample-count> <new-output-directory> | compare <before-summary> <after-summary> <new-output-directory>');
