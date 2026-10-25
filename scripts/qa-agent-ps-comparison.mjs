import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const atomic = (file, value) => {
  fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const database = (file, action, readOnly = true) => {
  const db = new DatabaseSync(file, { readOnly });
  try { return action(db); } finally { db.close(); }
};
const snapshot = file => database(file, db => Object.fromEntries(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()])));
const rows = (state, table) => (state[table] ?? []).map(row => row.payload ? JSON.parse(row.payload) : row);
const statistics = values => {
  assert.ok(values.length > 1 && values.every(Number.isFinite));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { samples: values.length, total: values.reduce((a, b) => a + b, 0), mean, min: Math.min(...values), max: Math.max(...values),
    standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length), values };
};
const [mode, argument, countArgument] = process.argv.slice(2);
if (mode === 'actor') {
  atomic(argument, { pid: process.pid, at: new Date().toISOString() });
  process.stdin.resume();
} else if (mode === 'seed') {
  const { statePath, main, sessions, reservations, reminders } = JSON.parse(fs.readFileSync(argument));
  const { openStateStore } = await import(pathToFileURL(path.join(main, 'src/state-store.ts')).href);
  const store = openStateStore(statePath);
  try {
    store.sessionRepository.transaction(tx => {
      for (const row of tx.listSessions()) tx.deleteSession(row.runId);
      for (const row of tx.listReservations()) tx.deleteReservation(row.runId);
      for (const row of tx.listPending()) tx.deletePending(row.id);
      for (const row of sessions) tx.putSession(row);
      for (const row of reservations) tx.putReservation(row);
    });
    store.reminderRepository.transaction(tx => {
      for (const row of tx.list()) tx.remove(row.id);
      for (const row of reminders) tx.save(row);
    });
    const db = store.startupContextDatabase;
    db.exec(`CREATE TABLE IF NOT EXISTS qa_ps_events(id INTEGER PRIMARY KEY, intent TEXT);
      CREATE TRIGGER IF NOT EXISTS qa_ps_event_insert AFTER INSERT ON pending_intents BEGIN INSERT INTO qa_ps_events(intent) VALUES(new.payload); END;
      DELETE FROM qa_ps_events;`);
  } finally { store.close(); }
} else {
  assert.match(mode ?? '', /^[0-9a-f]{40}$/);
  const repetitions = Number(countArgument);
  assert.ok(Number.isSafeInteger(repetitions) && repetitions > 1, 'Pass an experimental sample count, not an acceptance threshold');
  const source = path.resolve(import.meta.dirname, '..');
  const conf = path.resolve(argument);
  const reviewed = mode;
  process.umask(0o077);
  const base = fs.mkdtempSync('/srv/dev/p45-');
  const root = path.join(base, 'root'), main = path.join(root, 'raf-main'), home = path.join(base, 'home'), tmp = path.join(base, 'tmp'), ev = path.join(base, 'ev');
  for (const dir of [root, home, tmp, ev, path.join(root, 'openspec/changes'), path.join(root, 'questions')]) fs.mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, RAF_QA_HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(base, 'config'),
    XDG_CACHE_HOME: path.join(base, 'cache'), GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n name = Agent ps QA\n email = qa@example.invalid\n[commit]\n gpgsign = false\n');
  const statePath = path.join(home, '.raf/state.sqlite');
  const script = path.resolve(import.meta.filename);
  const actors = [];
  const summary = { status: 'failed', source, reviewed, base, startedAt: new Date().toISOString(), repetitions,
    environment: { node: process.version, versions: process.versions, platform: process.platform, release: os.release(), cpus: os.availableParallelism(),
      osRelease: fs.readFileSync('/etc/os-release', 'utf8'), mode: 'fresh CLI processes; warm filesystem cache after saved warmup; no cache dropping or synthetic load; shared host external load recorded per sample; service stopped during restored samples to prevent competing reconciliation' },
    limitations: ['Fixture actors are real idle OS processes, not provider models; session records are seeded explicitly.',
      'Production profile helper CPU remains unavailable. External Linux wait4 rusage independently measures the CLI and its synchronously reaped helper tree; provider payload is absent. This is not a speed acceptance verdict.',
      'The service lifecycle is real. It is quiesced before snapshots so it cannot consume the ps transitions.',
      'No worker polling implementation or optimization is included. No unit run is needed for baseline-only work.'], commands: [], cases: [], cleanup: { complete: false } };
  console.log(JSON.stringify({ base, evidence: path.join(base, 'summary.json'), reviewed }));
  const setup = (executable, args, cwd = root, environment = env) => {
    const r = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
    assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const cli = (label, args, environment = env) => {
    const startedAt = new Date().toISOString(), start = performance.now();
    const cpuFile = path.join(ev, label + '-rusage.json');
    const measure = `import json, os, sys, time
start = time.monotonic_ns()
pid = os.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
_, status, usage = os.wait4(pid, 0)
code = os.waitstatus_to_exitcode(status)
with open(sys.argv[1], 'w') as out:
    json.dump(dict(method='Linux wait4 rusage', scope='CLI plus synchronously reaped descendants; isolated service stopped; no runner payload', cpuUserMs=usage.ru_utime*1000, cpuSystemMs=usage.ru_stime*1000, wallMs=(time.monotonic_ns()-start)/1e6, childExitCode=code), out)
sys.exit(code if code >= 0 else 128-code)
`;
    const r = spawnSync('python3', ['-c', measure, cpuFile, process.execPath, path.join(main, 'bin/raf.ts'), ...args], { cwd: main, env: environment,
      encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
    const record = { label, command: [process.execPath, path.join(main, 'bin/raf.ts'), ...args], cwd: main, startedAt,
      finishedAt: new Date().toISOString(), wallMs: performance.now() - start, cliExitCode: r.status, signal: r.signal, error: r.error?.message ?? null,
      stdoutBytes: Buffer.byteLength(r.stdout ?? ''), stderrBytes: Buffer.byteLength(r.stderr ?? ''), loadAverage: os.loadavg(),
      rusage: fs.existsSync(cpuFile) ? JSON.parse(fs.readFileSync(cpuFile)) : null };
    assert.ok(record.rusage, 'Full wait4 accounting must be available');
    assert.equal(record.rusage.childExitCode, r.status);
    record.cpuFullMs = record.rusage.cpuUserMs + record.rusage.cpuSystemMs;
    fs.writeFileSync(path.join(ev, label + '.stdout'), r.stdout ?? ''); fs.writeFileSync(path.join(ev, label + '.stderr'), r.stderr ?? '');
    atomic(path.join(ev, label + '.json'), record); summary.commands.push(record);
    assert.ifError(r.error); assert.equal(r.signal, null);
    return { ...record, stdout: r.stdout, stderr: r.stderr };
  };
  const must = result => { assert.equal(result.cliExitCode, 0, result.stderr); return JSON.parse(result.stdout); };
  const wait = async (label, read) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { const value = read(); if (value) return value; await delay(50); }
    throw Error('Unexecuted host scenario: ' + label);
  };
  const actor = async name => {
    const marker = path.join(base, name + '.ready.json');
    const child = spawn(process.execPath, [script, 'actor', marker], { cwd: main, env, stdio: ['pipe', 'ignore', 'ignore'] });
    actors.push(child); child.on('error', error => { summary.actorError = String(error); });
    await wait(name, () => fs.existsSync(marker));
    const output = setup('ps', ['-ww', '-p', String(child.pid), '-o', 'lstart=,command=']);
    const match = output.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    assert.ok(match, output);
    return { child, identity: { pid: child.pid, startedAt: new Date(match[1]).toISOString(), runner: 'main', runnerSessionId: name,
      tmuxSession: name, evidence: { command: match[2], machineId: fs.readFileSync('/etc/machine-id', 'utf8').trim(), bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } } };
  };
  let serviceStarted = false;
  try {
    assert.equal(setup('git', ['rev-parse', reviewed + '^{commit}'], source), reviewed);
    summary.sourceWorkspace = { head: setup('git', ['rev-parse', 'HEAD'], source), status: setup('git', ['status', '--porcelain'], source), policy: 'Only the exact committed SHA enters the fresh clone; unrelated workspace edits are excluded.' };
    summary.harnessSha256 = digest(script);
    summary.tools = Object.fromEntries([['git', ['--version']], ['tmux', ['-V']], ['ps', ['--version']], ['python3', ['--version']]].map(([exe, args]) => [exe, setup(exe, args)]));
    summary.sourceConfiguration = Object.fromEntries(['raf.json', 'flow.json', 'projects.json', 'models.json', 'raf-constants.json', 'test-runs.json'].map(name => [name, digest(path.join(conf, name))]));
    fs.cpSync(conf, path.join(root, 'conf'), { recursive: true });
    const projectPath = path.join(root, 'conf/projects.json'), projects = JSON.parse(fs.readFileSync(projectPath));
    projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator };
    Object.assign(projects.projects.raf, { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } });
    delete projects.projects.raf.mainCopies;
    fs.writeFileSync(projectPath, JSON.stringify(projects, null, 2));
    const settingsPath = path.join(root, 'conf/raf.json'), settings = JSON.parse(fs.readFileSync(settingsPath));
    settings.state.fileName = 'state.sqlite'; delete settings.bugs;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    summary.configurationChanges = { projects: 'owned root and conventional main route without mainCopies', stateFileName: 'state.sqlite', bugs: 'optional configuration omitted; no sync or credentials' };
    summary.fixtureConfiguration = Object.fromEntries(Object.keys(summary.sourceConfiguration).map(name => [name, digest(path.join(root, 'conf', name))]));
    setup('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', source, main]);
    setup('git', ['checkout', '-B', 'main', reviewed], main);
    fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
    setup(process.execPath, ['scripts/build.ts'], main);
    summary.catalogSha256 = digest(path.join(main, 'dist/catalog.json'));
    setup('git', ['init', '-b', 'main']);
    setup('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main']);
    setup('git', ['submodule', 'absorbgitdirs']);
    setup('git', ['add', '--', '.gitmodules', 'raf-main', 'conf']);
    setup('git', ['commit', '-m', 'qa: isolated agent ps baseline root']);
    summary.fixtureRootCommit = setup('git', ['rev-parse', 'HEAD']);
    must(cli('service-start', ['service', 'start'])); serviceStarted = true;
    must(cli('service-status', ['service', 'status']));
    must(cli('service-stop', ['service', 'stop'])); serviceStarted = false;
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.raf/service.json'))).state, 'stopped');
    const a = await actor('qa-live-main'), b = await actor('qa-live-hotfix'), gone = await actor('qa-gone');
    gone.child.stdin.end(); await wait('gone actor reaped', () => gone.child.exitCode !== null);
    const running = (name, identity, type = 'qa') => ({ runId: name, addressId: name, revision: 1, state: 'running',
      activity: { type, project: 'raf', features: ['profile-raf-performance'], phase: type, cwd: main }, process: identity });
    const live = [running('main', a.identity, 'main'), running('qa-hotfix', b.identity, 'hotfix')];
    const finished = { runId: 'qa-finished', addressId: 'qa-finished', revision: 3, state: 'finished', finishedAt: new Date().toISOString(),
      process: gone.identity, result: { status: 'succeeded', response: '', proof: null } };
    const missing = running('qa-missing', gone.identity);
    const reused = running('qa-reused', { ...b.identity, evidence: { ...b.identity.evidence, command: b.identity.evidence.command + ' stale-run' } });
    const unknown = running('qa-unverifiable', { ...b.identity, evidence: { ...b.identity.evidence, command: '' } });
    summary.actors = { live: live.map(row => row.process), gone: gone.identity, goneExitCode: gone.child.exitCode };
    const cases = [{ name: 'empty', sessions: [] }, { name: 'live', sessions: [...live, finished] }, { name: 'finished', sessions: [finished] },
      { name: 'missing', sessions: [missing, finished], closes: missing.runId }, { name: 'pid-reused', sessions: [reused, finished], closes: reused.runId },
      { name: 'unverifiable', sessions: [unknown, finished], unknown: unknown.runId }];
    const seedBase = path.join(base, 'seed-base.sqlite');
    database(statePath, db => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'), false);
    fs.copyFileSync(statePath, seedBase);
    const restore = file => {
      for (const suffix of ['-wal', '-shm']) fs.rmSync(statePath + suffix, { force: true });
      fs.copyFileSync(file, statePath);
    };
    const check = (c, result, state) => {
      const sessions = rows(state, 'sessions'), events = (state.qa_ps_events ?? []).map(row => JSON.parse(row.intent));
      if (c.unknown) {
        assert.notEqual(result.cliExitCode, 0);
        const failure = JSON.parse(result.stderr.trim().split('\n').at(-1)); assert.equal(failure.code, 'PROCESS_SCAN_UNKNOWN');
        const row = sessions.find(row => row.runId === c.unknown);
        assert.equal(row.state, 'running'); assert.equal(row.observation.state, 'unknown');
        assert.ok(rows(state, 'admission_reservations').some(row => row.runId === c.unknown));
        assert.ok(!events.some(row => row.event === 'agent.closed'));
      } else {
        const resultRows = must(result);
        assert.deepEqual(resultRows.map(row => row.addressId).sort(), c.name === 'live' ? ['main', 'qa-hotfix'] : []);
        for (const row of resultRows) assert.equal(row.observation.state, 'alive');
      }
      if (c.closes) {
        assert.equal(sessions.find(row => row.runId === c.closes)?.state, 'finished');
        assert.ok(!rows(state, 'admission_reservations').some(row => row.runId === c.closes));
        assert.equal(events.filter(row => row.runId === c.closes && row.event === 'agent.closed').length, 1);
        assert.equal(events.filter(row => row.runId === c.closes && row.event === 'agent.failed').length, 1);
        const reminder = rows(state, 'reminders').find(row => row.id === 'qa-reminder');
        assert.equal(reminder.assignedTo, 'main'); assert.equal(reminder.createdFor, 'qa-owner'); assert.equal(reminder.at, '2099-01-01T00:00:00.000Z');
      }
      return { sessions, events, reservations: rows(state, 'admission_reservations'), reminders: rows(state, 'reminders') };
    };
    for (const c of cases) {
      restore(seedBase);
      const active = c.sessions.filter(row => row.state === 'running' && row.activity.type !== 'main');
      const seedFile = path.join(ev, c.name + '-seed.json');
      atomic(seedFile, { main, statePath, sessions: c.sessions, reservations: active.map(row => ({ runId: row.runId, resource: 'ram', amount: 1 })),
        reminders: c.closes ? [{ id: 'qa-reminder', createdFor: 'qa-owner', assignedTo: c.closes, text: 'Owned baseline recovery reminder', at: '2099-01-01T00:00:00.000Z', binding: null, state: 'pending', closedAt: null, closeReason: null }] : [] });
      setup(process.execPath, [script, 'seed', seedFile], main);
      database(statePath, db => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'), false);
      const seedDb = path.join(ev, c.name + '-seed.sqlite'); fs.copyFileSync(statePath, seedDb);
      const record = { name: c.name, seedDatabase: seedDb, seedSha256: digest(seedDb), initial: snapshot(statePath), samples: [], diagnostic: null };
      summary.cases.push(record);
      const warmup = cli(c.name + '-warmup', ['agent', 'ps']); check(c, warmup, snapshot(statePath));
      for (let index = 0; index < repetitions; index++) {
        restore(seedDb);
        const label = `${c.name}-${index + 1}`;
        const before = must(cli(label + '-stats-before', ['command', 'stats']));
        const loadBefore = { loadAverage: os.loadavg(), processes: fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).length };
        const ps = cli(label + '-ps', ['agent', 'ps']);
        const stateAfter = snapshot(statePath); atomic(path.join(ev, label + '-state-after.json'), stateAfter);
        const verified = check(c, ps, stateAfter);
        const after = must(cli(label + '-stats-after', ['command', 'stats']));
        const delta = after.profile.rows.filter(row => row.command === 'agent ps').map(row => {
          const previous = before.profile.rows.find(old => old.scope === row.scope && old.command === row.command && old.stage === row.stage && old.executor === row.executor);
          const difference = key => row[key] === null ? null : row[key] - (previous?.[key] ?? 0);
          return { stage: row.stage, executor: row.executor, samples: difference('samples'), wallMs: difference('wallTotalMs'),
            cpuUserMs: difference('cpuUserTotalMs'), cpuSystemMs: difference('cpuSystemTotalMs'), cpuSamples: difference('cpuSamples'), cpuUnavailableSamples: difference('cpuUnavailableSamples'),
            cpuAvailability: row.cpuAvailability, cpuSource: row.cpuSource, unavailableReason: row.unavailableReason };
        });
        assert.ok(delta.length > 0); assert.ok(delta.filter(row => row.executor === 'self').every(row => row.cpuSamples > 0));
        const again = cli(label + '-idempotence', ['agent', 'ps']);
        const verifiedAgain = check(c, again, snapshot(statePath));
        assert.deepEqual(verifiedAgain.events, verified.events, 'No duplicate close/failure event');
        const sample = { label, startedAt: ps.startedAt, finishedAt: ps.finishedAt, cliExitCode: ps.cliExitCode, externalWallMs: ps.wallMs, loadBefore,
          wallMs: delta.filter(row => row.executor === 'self').reduce((sum, row) => sum + row.wallMs, 0),
          cpuFullMs: ps.cpuFullMs, rusage: ps.rusage,
          cpuSelfMs: delta.filter(row => row.executor === 'self').reduce((sum, row) => sum + row.cpuUserMs + row.cpuSystemMs, 0), delta };
        record.samples.push(sample); atomic(path.join(ev, label + '-sample.json'), sample);
      }
      record.wallMs = statistics(record.samples.map(row => row.wallMs));
      record.externalWallMs = statistics(record.samples.map(row => row.externalWallMs));
      record.cpuSelfMs = statistics(record.samples.map(row => row.cpuSelfMs));
      record.cpuFullMs = statistics(record.samples.map(row => row.cpuFullMs));
      record.stages = [...new Set(record.samples.flatMap(row => row.delta.filter(row => row.executor === 'self').map(row => row.stage)))].map(stage => ({ stage,
        wallMs: statistics(record.samples.map(row => row.delta.filter(row => row.stage === stage && row.executor === 'self').reduce((sum, row) => sum + row.wallMs, 0))) })).sort((a, b) => b.wallMs.mean - a.wallMs.mean);
      record.mostExpensiveStage = record.stages[0];
      record.externalCpu = { availability: 'complete', method: 'Linux wait4 rusage', scope: 'CLI and synchronously reaped descendants; actors and stopped service excluded' };
      record.helperCpu = { availability: record.samples.some(row => row.delta.some(stage => stage.cpuUnavailableSamples > 0)) ? 'unavailable' : 'no instrumented helper intervals', totalMs: null };
      restore(seedDb);
      const traceBin = path.join(base, 'trace-bin'); fs.mkdirSync(traceBin, { recursive: true });
      const realPs = setup('which', ['ps']), trace = path.join(ev, c.name + '-ps-scans.jsonl');
      fs.writeFileSync(path.join(traceBin, 'ps'), `#!${process.execPath}\nimport fs from 'node:fs'; import {spawnSync} from 'node:child_process'; fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args:process.argv.slice(2)})+'\\n'); const r=spawnSync(${JSON.stringify(realPs)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o700 });
      const diagnostic = cli(c.name + '-diagnostic', ['agent', 'ps'], { ...env, PATH: traceBin + path.delimiter + env.PATH });
      check(c, diagnostic, snapshot(statePath));
      record.diagnostic = { separateFromTimedSeries: true, psCalls: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
      atomic(path.join(ev, c.name + '-summary.json'), record);
    }
    summary.status = 'passed';
  } catch (error) { summary.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  finally {
    if (serviceStarted) {
      try { must(cli('finally-service-stop', ['service', 'stop'])); } catch (error) { summary.cleanup.serviceError = error.message; }
    }
    for (const child of actors) child.stdin?.end();
    try {
      await wait('owned actors exited', () => actors.every(child => child.exitCode !== null || child.signalCode !== null));
      const serviceFile = path.join(home, '.raf/service.json');
      summary.cleanup.service = fs.existsSync(serviceFile) ? JSON.parse(fs.readFileSync(serviceFile)) : null;
      summary.cleanup.actors = actors.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }));
      summary.cleanup.remainingProcesses = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
        try {
          const cwd = fs.readlinkSync(`/proc/${name}/cwd`);
          const fields = fs.readFileSync(`/proc/${name}/stat`, 'utf8').split(') ').at(-1).split(' ');
          return cwd.startsWith(base + '/') && fields[0] !== 'Z' ? [{ pid: Number(name), cwd, state: fields[0] }] : [];
        } catch (error) { if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return []; throw error; }
      });
      summary.cleanup.complete = summary.cleanup.remainingProcesses.length === 0 && !summary.cleanup.serviceError && (!summary.cleanup.service || summary.cleanup.service.state === 'stopped');
      if (fs.existsSync(statePath)) summary.cleanup.integrityCheck = database(statePath, db => db.prepare('PRAGMA integrity_check').all());
    } catch (error) { summary.cleanup.error = error.message; summary.cleanup.complete = false; process.exitCode = 1; }
    if (!summary.cleanup.complete) summary.status = 'failed';
    summary.finishedAt = new Date().toISOString(); atomic(path.join(base, 'summary.json'), summary);
  }
  console.log(JSON.stringify({ status: summary.status, base, evidence: path.join(base, 'summary.json'), failure: summary.failure?.message ?? null }));
}
