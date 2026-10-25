import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { configureLiveCodexTrust } from '../test/helpers/z4044-live-trust.mjs';

const atomic = (file, value) => {
  fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
};
const database = (file, use, readOnly = true) => {
  const db = new DatabaseSync(file, { readOnly });
  try { return use(db); } finally { db.close(); }
};
const snapshot = file => database(file, db => ({
  timings: db.prepare('SELECT * FROM command_timings ORDER BY command').all(),
  audit: db.prepare('SELECT * FROM qa_timing_audit ORDER BY id').all(),
  profile: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%cost%'").all()
    .map(({ name }) => ({ table: name, rows: db.prepare(`SELECT * FROM ${name}`).all() })),
}));
const ownedProcesses = stand => fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name)).flatMap(name => {
  try {
    const cwd = fs.readlinkSync(`/proc/${name}/cwd`);
    if (cwd !== stand && !cwd.startsWith(stand + '/')) return [];
    const fields = fs.readFileSync(`/proc/${name}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return fields[0] === 'Z' ? [] : [{ pid: Number(name), cwd, startTicks: fields[19], state: fields[0] }];
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return [];
    throw error;
  }
});
const [mode, argument, configArgument] = process.argv.slice(2);

if (mode === 'actor') {
  assert.ok(path.isAbsolute(argument));
  const marker = path.join(path.dirname(argument), 'prp34-actor-ready.json');
  atomic(marker, { pid: process.pid, at: new Date().toISOString() });
  const gate = path.join(path.dirname(argument), 'prp34-release');
  await new Promise(resolve => {
    const watcher = fs.watch(path.dirname(gate), () => {
      if (fs.existsSync(gate)) { watcher.close(); resolve(); }
    });
    if (fs.existsSync(gate)) { watcher.close(); resolve(); }
  });
} else if (mode === 'pane') {
  const stand = argument;
  const root = path.join(stand, 'root');
  const db = path.join(stand, 'home/.raf/state.sqlite');
  const run = (label, args, budget = 240000) => {
    const before = fs.existsSync(db) && database(db, d => !!d.prepare("SELECT 1 FROM sqlite_master WHERE name='qa_timing_audit'").get()) ? snapshot(db) : null;
    const started = performance.now();
    const cli = path.join(root, 'raf-main/bin/raf.ts');
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: path.dirname(path.dirname(cli)), env: process.env, encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024,
    });
    const value = { command: [process.execPath, cli, ...args], cwd: path.dirname(path.dirname(cli)),
      cliExitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
      wallMs: performance.now() - started, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
      before, after: before ? snapshot(db) : null };
    for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(stand, 'ev', label + '.' + stream), value[stream]);
    atomic(path.join(stand, 'ev', label + '.json'), value);
    return value;
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  atomic(path.join(stand, 'main-ready.json'), run('main-attach', ['main', 'attach']));
  setInterval(() => {
    for (const name of fs.readdirSync(path.join(stand, 'commands')).filter(name => name.endsWith('.json')).sort()) {
      const file = path.join(stand, 'commands', name);
      const request = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.renameSync(file, file + '.running');
      run(request.label, request.args, request.budget);
      fs.renameSync(file + '.running', file + '.done');
    }
  }, 100);
} else {
  const reviewed = mode;
  const source = path.resolve(import.meta.dirname, '..');
  const conf = path.resolve(argument ?? path.join(source, '../conf'));
  const baseline = configArgument ?? '0605c8563376b1255e302f8a6ccf9060259131df';
  assert.match(reviewed ?? '', /^[0-9a-f]{40}$/);
  assert.match(baseline, /^[0-9a-f]{40}$/);
  assert.equal(process.env.CODEX_HOME, '/home/dev/.codex');
  process.umask(0o077);
  const base = fs.mkdtempSync('/srv/dev/p34-');
  const summary = { status: 'failed', base, source, reviewed, baseline, versions: { node: process.version, os: os.release(), platform: process.platform },
    limits: { commandDeadlineMs: 240000, actorReadinessMs: 240000 }, runs: [], limitations: [
      'Only local read-only bug handlers are exercised; no production bug mutation or authentication copy.',
      'EMA audit triggers are fixture-only instrumentation. Unit payload CPU is intentionally outside raf self CPU.',
      'The host integration deadline is separate from the unit timeout policy.',
    ] };
  console.log(JSON.stringify({ base, evidence: path.join(base, 'summary.json'), reviewed, baseline }));
  const originalPath = process.env.PATH;
  const cleanEnv = stand => ({ PATH: originalPath, CODEX_HOME: '/home/dev/.codex', HOME: path.join(stand, 'home'), RAF_QA_HOME: path.join(stand, 'home'),
    TMPDIR: path.join(stand, 'tmp'), XDG_CONFIG_HOME: path.join(stand, 'config'), XDG_CACHE_HOME: path.join(stand, 'cache'),
    GIT_CONFIG_GLOBAL: path.join(stand, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' });
  const wait = async (label, read, budget = 240000) => {
    const end = Date.now() + budget;
    while (Date.now() < end) { const value = read(); if (value) return value; await delay(100); }
    throw Error('Unexecuted host scenario: ' + label);
  };
  const checks = [];
  let setupEnv;
  const execute = (exe, args, cwd, env = setupEnv) => {
    const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    const setup = path.join(base, 'setup'); fs.mkdirSync(setup);
    setupEnv = cleanEnv(setup);
    for (const p of [setupEnv.HOME, setupEnv.TMPDIR]) fs.mkdirSync(p);
    fs.writeFileSync(setupEnv.GIT_CONFIG_GLOBAL, '[user]\n name = Timing QA\n email = qa@example.invalid\n[commit]\n gpgsign = false\n');
    assert.equal(execute('git', ['rev-parse', 'HEAD'], source), reviewed);
    assert.equal(execute('git', ['status', '--porcelain', '--untracked-files=no'], source), '', 'Reviewed clone must be clean');
    summary.tools = Object.fromEntries([['git', ['--version']], ['tmux', ['-V']], ['codex', ['--version']], ['openspec', ['--version']]]
      .map(([exe, args]) => [exe, execute(exe, args, source)]));
    summary.configurationFingerprints = Object.fromEntries(['raf.json', 'flow.json', 'test-runs.json', 'models.json', 'raf-constants.json', 'projects.json']
      .map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(conf, name))).digest('hex')]));
    for (const [label, sha] of [['before', baseline], ['after', reviewed]]) {
      const stand = path.join(base, label), root = path.join(stand, 'root'), ev = path.join(stand, 'ev');
      for (const p of [root, ev, path.join(stand, 'commands'), path.join(stand, 'home'), path.join(stand, 'tmp')]) fs.mkdirSync(p, { recursive: true });
      const env = cleanEnv(stand); fs.copyFileSync(setupEnv.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_GLOBAL);
      const git = (cwd, ...args) => execute('git', ['-C', cwd, ...args], cwd, env);
      const main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop');
      const socket = path.join(stand, 'main.sock');
      const record = { label, sha, root, home: env.HOME, tmp: env.TMPDIR, commands: [], checks: [], cleanup: {}, status: 'failed' };
      summary.runs.push(record);
      let pane = false;
      let sequence = 0;
      const request = async (label, args, budget = 240000) => {
        const target = path.join(ev, label + '.json'); assert.ok(!fs.existsSync(target));
        atomic(path.join(stand, 'commands', String(++sequence).padStart(4, '0') + '.json'), { label, args, budget });
        const r = await wait(label, () => fs.existsSync(target) && JSON.parse(fs.readFileSync(target, 'utf8')), budget + 10000);
        record.commands.push({ label, command: r.command, cliExitCode: r.cliExitCode, signal: r.signal, evidence: target });
        assert.equal(r.error, null, r.error); assert.equal(r.signal, null, 'A killed command is not a verified runtime failure');
        return r;
      };
      const must = r => { assert.equal(r.cliExitCode, 0, r.stderr); return JSON.parse(r.stdout); };
      const statePath = path.join(env.HOME, '.raf/state.sqlite');
      const sessions = () => database(statePath, db => db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload)));
      const inspect = (name, result, success, expected = 1) => {
        if (success) assert.equal(result.cliExitCode, 0, result.stderr); else assert.notEqual(result.cliExitCode, 0, result.stdout);
        const contributions = result.after.audit.slice(result.before.audit.length).filter(row => row.command === name);
        const check = { name, success, cliExitCode: result.cliExitCode, expectedContributions: expected, contributions,
          commandWallMs: result.wallMs, inferredSamplesMs: contributions.map(row => row.old_ms === null ? row.new_ms : (row.new_ms - (1 - record.alpha) * row.old_ms) / record.alpha), before: result.before.timings.find(row => row.command === name) ?? null,
          after: result.after.timings.find(row => row.command === name) ?? null };
        record.checks.push(check);
        if (label === 'after' || expected === 0) assert.equal(contributions.length, expected, name + ': exactly one completed contribution');
        if (expected === 0) assert.deepEqual(result.after.timings, result.before.timings, name + ': excluded operation must preserve every EMA row');
        return check;
      };
      try {
        fs.cpSync(conf, path.join(root, 'conf'), { recursive: true });
        const projectPath = path.join(root, 'conf/projects.json'), projects = JSON.parse(fs.readFileSync(projectPath));
        projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator };
        Object.assign(projects.projects.raf, { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } });
        delete projects.projects.raf.mainCopies;
        fs.writeFileSync(projectPath, JSON.stringify(projects, null, 2));
        const settingsPath = path.join(root, 'conf/raf.json'), settings = JSON.parse(fs.readFileSync(settingsPath));
        settings.state.fileName = 'state.sqlite';
        settings.bugs.origin = 'https://127.0.0.1:9';
        record.trust = configureLiveCodexTrust(settings, root);
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        record.alpha = settings.commandTiming.emaAlpha;
        execute('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', source, main], root, env);
        git(main, 'checkout', '-B', 'main', sha);
        fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
        execute(process.execPath, ['scripts/build.ts'], main, env);
        fs.mkdirSync(path.join(main, 'qa'), { recursive: true });
        fs.copyFileSync(path.join(source, 'scripts/qa-runtime-timing-host.mjs'), path.join(main, 'qa/timing-host.mjs'));
        fs.mkdirSync(path.join(main, 'test/helpers'), { recursive: true });
        fs.copyFileSync(path.join(source, 'test/helpers/z4044-live-trust.mjs'), path.join(main, 'test/helpers/z4044-live-trust.mjs'));
        for (const outcome of ['pass', 'fail']) fs.writeFileSync(path.join(main, `test/prp34-${outcome}.test.ts`),
          `import test from 'node:test'; import assert from 'node:assert/strict'; test('isolated ${outcome} payload', async () => { await new Promise(r => setTimeout(r, 250)); assert.equal(${outcome === 'pass'}, true); });\n`);
        git(main, 'add', '--', 'qa/timing-host.mjs', 'test/prp34-pass.test.ts', 'test/prp34-fail.test.ts', 'test/helpers/z4044-live-trust.mjs');
        git(main, 'commit', '-m', 'qa: owned host timing fixtures'); record.fixtureCommit = git(main, 'rev-parse', 'HEAD');
        git(root, 'init', '-b', 'main');
        git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main'); git(root, 'submodule', 'absorbgitdirs');
        git(main, 'worktree', 'add', '-B', 'develop', develop, 'HEAD');
        git(main, 'worktree', 'add', '-B', 'hotfix', path.join(root, 'raf-hotfix'), 'HEAD');
        for (const name of ['node_modules', 'dist']) for (const dir of [develop, path.join(root, 'raf-hotfix')]) fs.cpSync(path.join(main, name), path.join(dir, name), { recursive: true, dereference: true });
        const testPath = path.join(root, 'conf/test-runs.json'), testRuns = JSON.parse(fs.readFileSync(testPath));
        for (const outcome of ['pass', 'fail']) {
          const file = `test/prp34-${outcome}.test.ts`;
          testRuns.projects.raf.profiles.node.unitFiles.push(file);
          testRuns.projects.raf.groups[`prp34-host/${outcome}`] = { profileId: 'node', files: [file] };
        }
        fs.writeFileSync(testPath, JSON.stringify(testRuns, null, 2));
        const change = path.join(root, 'openspec/changes/prp34-host'); fs.mkdirSync(change, { recursive: true });
        fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
        fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
        fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nOwned runtime timing host QA.\n\n## What Changes\nFixture only.\n\n## Non-goals\nNo product change.\n');
        fs.writeFileSync(path.join(change, 'tasks.md'), '- [ ] 1.1 [implement] Execute exactly one command: node qa/timing-host.mjs actor <exact report_path from your brief>. Wait for it to return. Do not change code, run tests, write a report, commit, archive, or send messages. Raf has already selected model and effort; preserve them. This host-controlled fixture checks command duration while the agent remains alive.\n- [ ] 1.2 Host keeps this fixture active.\n');
        git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'openspec'); git(root, 'commit', '-m', 'qa: isolated timing orchestrator');
        record.fixtureConfigurationFingerprints = Object.fromEntries(['raf.json', 'projects.json', 'test-runs.json'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, 'conf', name))).digest('hex')]));
        for (const [name, args, code] of [['lazy-help', ['service', 'start', '--help'], 0], ['lazy-parser', ['service', 'status', '--prp34-unknown'], 1]]) {
          const r = spawnSync(process.execPath, [path.join(main, 'bin/raf.ts'), ...args], { cwd: main, env, encoding: 'utf8' });
          for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(ev, name + '.' + stream), r[stream]);
          assert.equal(r.status, code); assert.ok(!fs.existsSync(statePath), 'Lazy parser/help must not open state');
        }
        execute('tmux', ['-S', socket, 'new-session', '-d', '-s', 'prp34-main', '-x', '180', '-y', '50', process.execPath, path.join(main, 'qa/timing-host.mjs'), 'pane', stand], root, env); pane = true;
        must(await wait('main attach', () => fs.existsSync(path.join(stand, 'main-ready.json')) && JSON.parse(fs.readFileSync(path.join(stand, 'main-ready.json')))));
        database(statePath, db => db.exec(`CREATE TABLE qa_timing_audit(id INTEGER PRIMARY KEY, command TEXT, old_ms REAL, new_ms REAL, at TEXT);
          CREATE TRIGGER qa_timing_insert AFTER INSERT ON command_timings BEGIN INSERT INTO qa_timing_audit(command,old_ms,new_ms,at) VALUES(new.command,NULL,new.average_ms,new.updated_at); END;
          CREATE TRIGGER qa_timing_update AFTER UPDATE ON command_timings BEGIN INSERT INTO qa_timing_audit(command,old_ms,new_ms,at) VALUES(new.command,old.average_ms,new.average_ms,new.updated_at); END;`), false);
        inspect('service start', await request('service-start', ['service', 'start']), true);
        inspect('service status', await request('service-status', ['service', 'status']), true);
        inspect('bug list', await request('bug-list', ['bug', 'list']), true);
        const missing = await request('bug-missing', ['bug', 'show', '--bug', 'projects/raf/bug#999999']);
        inspect('bug show', missing, false); assert.equal(JSON.parse(missing.stderr.trim().split('\n').at(-1)).code, 'BUG_NOT_FOUND');
        for (const outcome of ['pass', 'fail']) {
          const r = await request('test-' + outcome, ['test', 'run', '--project', 'raf', '--phase', 'red', '--group', 'prp34-host/' + outcome]);
          inspect('test run', r, outcome === 'pass');
          const result = JSON.parse(r.stdout); atomic(path.join(ev, 'test-' + outcome + '.TestRunResult.json'), result);
          assert.equal(result.outcome, outcome === 'pass' ? 'passed' : 'assertions-failed');
          assert.equal(result.exitCode, outcome === 'pass' ? 0 : 1); assert.equal(result.timedOut, false); assert.equal(result.cleanup.complete, true);
          assert.deepEqual(result.unexecuted, []); assert.deepEqual(result.unknown, []);
          if (outcome === 'pass') assert.deepEqual(result.knownRed, []); else assert.equal(result.knownRed.length, 1);
        }
        inspect('resource wait', await request('resource-wait', ['resource', 'wait', '--level', 'ANY_RUN']), true, 0);
        inspect('runner list', await request('runtime-help', ['runner', 'list', '--help']), true, 0);
        inspect('runner list', await request('runtime-parser', ['runner', 'list', '--prp34-unknown']), false, 0);
        must(await request('runner-limits', ['runner', 'limits', '--runners', 'codex']));
        const launch = ['agent', 'run', '--id', 'prp34-actor', '--type', 'implement', '--project', 'raf', '--features', 'prp34-host', '--phase', 'implement', '--complexity', 'mechanical', '--tasks', 'prp34-host:1.1'];
        const started = await request('agent-run', launch); inspect('agent run', started, true);
        const actor = await wait('live native actor marker', () => {
          const s = sessions().find(row => row.addressId === 'prp34-actor' && row.state === 'running');
          return s?.launchContext?.reportPath && fs.existsSync(path.join(path.dirname(s.launchContext.reportPath), 'prp34-actor-ready.json')) && s;
        });
        record.processesDuringActor = ownedProcesses(stand);
        record.actor = { runId: actor.runId, process: actor.process, selection: actor.selection, reportPath: actor.launchContext.reportPath };
        const launchTiming = snapshot(statePath).timings.find(row => row.command === 'agent run');
        await delay(5000);
        assert.equal(sessions().find(row => row.runId === actor.runId)?.state, 'running');
        assert.deepEqual(snapshot(statePath).timings.find(row => row.command === 'agent run'), launchTiming, 'Agent lifetime cannot update launch EMA');
        inspect('agent run', await request('agent-duplicate', launch), false);
        must(await request('agent-cleanup', ['agent', 'close', '--id', 'prp34-actor', '--force', '--reason', 'Owned host timing QA cleanup']));
        inspect('service stop', await request('service-stop', ['service', 'stop']), true);
        await wait('service stopped', () => !fs.existsSync(path.join(env.HOME, '.raf/service.sock')));
        const serviceRecord = path.join(env.HOME, '.raf/service.json'), saved = fs.readFileSync(serviceRecord);
        try {
          fs.writeFileSync(serviceRecord, '{');
          for (const operation of ['start', 'status', 'stop']) inspect('service ' + operation, await request('service-error-' + operation, ['service', operation]), false);
          inspect('resource wait', await request('resource-error', ['resource', 'wait', '--level', 'ANY_RUN']), false, 0);
        } finally { fs.writeFileSync(serviceRecord, saved); }
        const stats = must(await request('final-stats', ['command', 'stats'])); atomic(path.join(ev, 'commands-profile.json'), stats);
        assert.ok(Array.isArray(stats.commands)); assert.ok(Array.isArray(stats.profile.rows));
        record.status = 'passed'; checks.push(record);
      } catch (error) {
        record.failure = { message: error.message, stack: error.stack }; throw error;
      } finally {
        if (pane) {
          try {
            const live = sessions().find(row => row.addressId === 'prp34-actor' && row.state === 'running');
            if (live) await request('finally-agent-close', ['agent', 'close', '--id', 'prp34-actor', '--force', '--reason', 'Owned host cleanup after failure']);
            await request('finally-service-stop', ['service', 'stop']);
          } catch (error) { record.cleanup.error = error.message; }
          const serviceFile = path.join(env.HOME, '.raf/service.json');
          if (fs.existsSync(serviceFile)) {
            const service = JSON.parse(fs.readFileSync(serviceFile));
            record.cleanup.service = service;
            assert.equal(service.state, 'stopped', 'Never claim cleanup with a running service');
          }
          const r = spawnSync('tmux', ['-S', socket, 'kill-server'], { env, encoding: 'utf8' });
          record.cleanup.mainTmuxExitCode = r.status;
          const workerSocket = path.join(env.HOME, '.raf/tmp/tmux/server.sock');
          const worker = spawnSync('tmux', ['-S', workerSocket, 'kill-server'], { env, encoding: 'utf8' });
          record.cleanup.workerTmuxExitCode = worker.status;
          record.cleanup.processesBeforeWait = ownedProcesses(stand);
          await wait('all owned stand processes exited', () => ownedProcesses(stand).length === 0, 15000);
          record.cleanup.remainingProcesses = ownedProcesses(stand);
          record.cleanup.complete = record.cleanup.remainingProcesses.length === 0 && !record.cleanup.error;
          assert.equal(record.cleanup.complete, true, 'Cleanup must be verified');
          if (fs.existsSync(statePath)) atomic(path.join(ev, 'final-sqlite-snapshot.json'), snapshot(statePath));
          const log = path.join(env.HOME, '.raf/service.log'); if (fs.existsSync(log)) fs.copyFileSync(log, path.join(ev, 'service.log'));
        }
        atomic(path.join(ev, 'summary.json'), record);
      }
    }
    assert.equal(checks.length, 2);
    summary.comparison = summary.runs[1].checks.map((after, index) => ({ name: after.name, success: after.success,
      beforeContributions: summary.runs[0].checks[index].contributions.length, afterContributions: after.contributions.length,
      beforeWallMs: summary.runs[0].checks[index].commandWallMs, afterWallMs: after.commandWallMs }));
    summary.status = 'passed';
  } catch (error) { summary.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  finally { summary.finishedAt = new Date().toISOString(); atomic(path.join(base, 'summary.json'), summary); }
  console.log(JSON.stringify({ status: summary.status, base, evidence: path.join(base, 'summary.json'), failure: summary.failure?.message ?? null }));
}
