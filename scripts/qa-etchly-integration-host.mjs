import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const self = fileURLToPath(import.meta.url);
const code = path.resolve(path.dirname(self), '..');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const importCode = file => import(pathToFileURL(path.join(code, 'src', file)).href);
const smokeGroup = 'add-raf-test-run/etchly-worker-d1-smoke';
const lifecycleGroup = 'add-raf-test-run/etchly-worker-d1-lifecycle';
const fixtureFile = 'worker/src/raf-etchly-lifecycle-qa.test.ts';
const modeFile = 'worker/raf-etchly-lifecycle-mode.json';

function identity(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return { pid, ppid: Number(fields[1]), start: fields[19], argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
  } catch { return null; }
}

async function worker(input) {
  const { root, home, workspace, argv, observation } = json(input);
  assert.equal(fs.realpathSync(code), path.join(root, 'raf-develop'));
  const { productionStateContext } = await importCode('state-migration-guard.ts');
  const { openStateStore } = await importCode('state-store.ts');
  const { createTestRunPorts } = await importCode('test-run-runtime.ts');
  const { validateTestRunConfig, parseTestRunArgs } = await importCode('test-runs.ts');
  const { runTestRunCli } = await importCode('test-run-cli.ts');
  const flow = json(path.join(root, 'conf/flow.json'));
  const constants = json(path.join(root, 'conf/raf-constants.json'));
  const config = validateTestRunConfig(json(path.join(root, 'conf/test-runs.json')), constants.agentPhases.map(p => p.id), flow.unitTests, flow.integrationTests);
  const stateContext = productionStateContext(root, path.join(code, 'src/test-run-runtime.ts'), home, 'cli', process.env);
  const store = openStateStore(stateContext.statePath, { context: stateContext });
  try {
    const context = { cwd: workspace, workspace, projectWorkspaces: { etchly: [workspace] }, agentPhases: constants.agentPhases.map(p => p.id),
      activeChanges: ['add-raf-test-run'], agentId: 'controlled-host-api-stand', callerPhase: 'qa', sha: git(workspace, 'rev-parse', 'HEAD'),
      home, statePath: stateContext.statePath, tmpPath: stateContext.tmpRoot, operationalHome: userInfo().homedir, integrationTests: flow.integrationTests };
    const ports = createTestRunPorts(config, stateContext, () => store, process.env, undefined, parseTestRunArgs(argv));
    const spawnRunner = ports.spawn;
    ports.spawn = async (...args) => {
      const managed = await spawnRunner(...args);
      write(observation, { boundary: 'Actual production runtime spawn; host API stand does not prove broker authorization', command: args[0], processIdentity: managed.identity ?? null });
      return managed;
    };
    process.exitCode = await runTestRunCli(argv, { config, policy: flow.unitTests, context, runtime: ports,
      stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) });
  } finally { store.close(); }
}

function assertStand(root) {
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.join(root, 'raf-develop'), code, 'Execute the driver from its clean, registered stand clone');
  const stat = fs.statSync(root);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0, 'Stand must be private');
  const marker = json(path.join(root, '.qa-etchly-stand.json'));
  assert.equal(marker.root, root);
  assert(!inside(root, marker.sourceRoot) && !inside(marker.sourceRoot, root));
  for (const name of ['raf-develop', 'etchly-develop', 'shared-libs-develop']) {
    const repository = path.join(root, name);
    assert.equal(fs.realpathSync(repository), repository);
    assert.equal(git(repository, 'rev-parse', '--show-toplevel'), repository);
    assert.equal(git(repository, 'status', '--porcelain=v1'), '', `Stand repository must start clean: ${name}`);
  }
  return marker;
}

const fixture = String.raw`import { test, expect } from 'vitest';
import './test-support/live-worker.ts';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const { mode, readyPath } = JSON.parse(readFileSync(new URL('../raf-etchly-lifecycle-mode.json', import.meta.url), 'utf8'));
if (mode === 'setup') throw new Error('Controlled import failure');
(mode === 'skip' ? test.skip : test)('real fork, workerd and D1', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(process.env.TMPDIR, 'd1-persistence'), workers: [{ modules: true, script: 'export default { fetch() { return new Response("qa") } }', d1Databases: { QA_DB: '7311ab35-a96a-43cb-89b4-91cb7f11e302' } }] }));
  try {
    const db = await mf.getD1Database('QA_DB');
    const row = await db.prepare('SELECT 1 AS proof').first();
    expect(row.proof).toBe(1);
    writeFileSync(readyPath + '.pending', JSON.stringify({ pid: process.pid, mode, proof: row.proof, tmp: process.env.TMPDIR }));
    renameSync(readyPath + '.pending', readyPath);
    if (mode === 'assertions') expect(row.proof).toBe(2);
    // Stall this fixture's own OS fork after D1 readiness. Local file-budget
    // timers stay unchanged; only the outer wrapper can clean a stopped fork.
    if (mode === 'hang') { process.kill(process.pid, 'SIGSTOP'); await new Promise(() => {}); }
  } finally { await mf.dispose(); }
});
`;

async function host(root, output, mode, budget, watchdogMs) {
  const marker = assertStand(root);
  assert(['smoke', 'd08', 'd08-remainder'].includes(mode));
  assert(Number.isSafeInteger(budget) && budget > 0, 'Explicit stand integration budget is required');
  assert(Number.isSafeInteger(watchdogMs) && watchdogMs > budget, 'Explicit outer host watchdog must exceed one integration budget');
  assert(!inside(output, path.join(root, 'etchly-develop')));
  fs.mkdirSync(output, { mode: 0o700 });
  const workspace = path.join(root, 'etchly-develop');
  const home = path.join(root, 'qa-home');
  if (mode === 'd08-remainder') {
    assert.equal(fs.realpathSync(home), home);
    assert.equal(fs.statSync(home).uid, process.getuid());
    assert.equal(fs.statSync(home).mode & 0o077, 0);
  } else fs.mkdirSync(home, { mode: 0o700 });
  const configPath = path.join(root, 'conf/test-runs.json'), flowPath = path.join(root, 'conf/flow.json');
  const savedConfig = fs.readFileSync(configPath), savedFlow = fs.readFileSync(flowPath);
  const conf = JSON.parse(savedConfig), flow = JSON.parse(savedFlow);
  const statePath = path.join(home, '.raf', json(path.join(root, 'conf/raf.json')).state.fileName);
  const rows = [], owned = new Map(), roots = new Set();
  let interrupted = false, fixtureCreated = false, modeCreated = false;
  const summary = { sourceItem: 'add-raf-test-run:6.2.6.3', mode, root, output, marker, driverSha256: hash(self),
    evidenceBoundary: 'Main-executed controlled host API stand. Real production planner/runtime/reporter/SQLite/forks/workerd. Does not establish a live QA etchly assignment or its trusted broker channel; D09 own-caller gate stays open.',
    before: ['raf-develop', 'etchly-develop', 'shared-libs-develop'].map(name => ({ name, sha: git(path.join(root, name), 'rev-parse', 'HEAD'), dirty: git(path.join(root, name), 'status', '--porcelain=v1') })),
    configuration: ['flow.json', 'projects.json', 'test-runs.json', 'raf-constants.json'].map(name => ({ name, sha256: hash(path.join(root, 'conf', name)) })),
    integrationBudgetMs: budget, hostWatchdogMs: watchdogMs, scenarios: rows, failures: [], status: 'failed' };
  const state = () => {
    if (!fs.existsSync(statePath)) return [];
    const db = new DatabaseSync(statePath, { readOnly: true });
    try { return db.prepare('SELECT payload FROM test_run_groups').all().map(row => JSON.parse(row.payload)); }
    finally { db.close(); }
  };
  const track = () => {
    const all = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).map(identity).filter(Boolean);
    const selected = new Set([...roots, ...[...owned.values()].filter(row => identity(row.pid)?.start === row.start).map(row => row.pid)]);
    for (let count = -1; count !== selected.size;) {
      count = selected.size;
      for (const row of all) if (selected.has(row.ppid)) selected.add(row.pid);
    }
    for (const row of all) if (selected.has(row.pid)) owned.set(row.pid, row);
  };
  const killOwned = () => {
    track();
    for (const row of owned.values()) if (identity(row.pid)?.start === row.start) {
      try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const onSignal = () => { interrupted = true; killOwned(); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const watchdog = setTimeout(() => { summary.failures.push({ message: 'Explicit outer host watchdog expired' }); onSignal(); }, watchdogMs);
  const sampler = setInterval(track, 20);
  const group = mode === 'smoke' ? smokeGroup : lifecycleGroup;
  const keyGroup = () => state().find(row => row.key.group === group);
  function launch(label, selection = []) {
    assert(!interrupted, 'Host stand was interrupted or its explicit watchdog expired');
    const argv = ['--project', 'etchly', '--phase', 'integration', '--group', group, ...selection];
    const observation = path.join(output, label + '.spawn.json');
    const input = path.join(output, label + '.input.json');
    const readyPath = path.join(output, label + '.d1-proof.json');
    if (fixtureCreated) {
      assert(!fs.existsSync(readyPath));
      write(path.join(workspace, modeFile), { ...json(path.join(workspace, modeFile)), readyPath });
    }
    write(input, { root, home, workspace, argv, observation });
    const stdout = fs.openSync(path.join(output, label + '.stdout'), 'wx', 0o600), stderr = fs.openSync(path.join(output, label + '.stderr'), 'wx', 0o600);
    const command = { executable: process.execPath, argv: [self, '--worker', input], cwd: workspace };
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: home, RAF_QA_HOME: home };
    const child = spawn(command.executable, command.argv, { cwd: workspace, env, shell: false, stdio: ['ignore', stdout, stderr] });
    if (child.pid) roots.add(child.pid);
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (cliCode, signal) => {
        track(); roots.delete(child.pid); fs.closeSync(stdout); fs.closeSync(stderr);
        const raw = fs.readFileSync(path.join(output, label + '.stdout'), 'utf8');
        let result = null; try { result = JSON.parse(raw); } catch {}
        const row = { label, command, cliCode, signal, result, state: state(), stdoutSha256: hash(path.join(output, label + '.stdout')), stderrSha256: hash(path.join(output, label + '.stderr')) };
        write(path.join(output, label + '.capture.json'), row); rows.push(row); resolve(row);
      });
    });
    return { child, done, input, readyPath };
  }
  const expect = (row, outcome) => {
    assert.equal(row.signal, null);
    assert.equal(row.result?.outcome, outcome, `See ${row.label}.stdout/.stderr`);
    assert.equal(row.cliCode, outcome === 'passed' ? 0 : 1);
    assert.equal(row.result.testKind, 'integration');
    assert.equal(row.result.timeoutPolicy.source, 'conf/flow.json#/integrationTests/timeoutMs');
    assert.equal(row.result.timeoutPolicy.timeoutMs, budget);
    assert.equal(row.result.callerPhase, 'qa');
    assert.deepEqual(row.result.cleanup, { complete: true, remainingPids: [] });
    if (outcome === 'passed') {
      assert.equal(row.result.groupState, 'complete');
      assert.equal(row.result.groupSnapshot, 'loaded');
      for (const field of ['knownRed', 'unexecuted', 'unknown']) assert.deepEqual(row.result[field], []);
    }
  };
  const ready = async run => {
    while (!interrupted) {
      const flight = keyGroup()?.inFlight;
      const temp = flight?.temporary?.temporary?.path;
      if (temp && fs.existsSync(run.readyPath)) {
        track();
        const proof = json(run.readyPath);
        assert.equal(proof.proof, 1);
        assert.equal(proof.mode, 'hang');
        assert(inside(proof.tmp, temp), 'Actual fixture TMPDIR must be inside the reserved private run root');
        assert.equal(fs.realpathSync(proof.tmp), proof.tmp);
        const live = [...owned.values()].filter(row => identity(row.pid)?.start === row.start);
        assert(live.some(row => row.pid === proof.pid), 'SQL proof must belong to a live owned fork');
        assert(live.some(row => row.argv.some(value => /(?:^|\/)workerd$/.test(value))), 'A real live workerd identity must be observed');
        write(path.join(output, 'ready-' + flight.runId + '.json'), { flight, proof, processes: [...owned.values()] });
        return flight;
      }
      const completed = rows.some(row => row.command.argv.includes(run.input));
      if (run.child.exitCode !== null || run.child.signalCode !== null || completed) throw Error('D1 fixture did not become ready; inspect child capture');
      await delay(25);
    }
    throw Error('Interrupted host stand');
  };
  try {
    flow.integrationTests.timeoutMs = budget;
    write(flowPath, flow);
    if (mode !== 'smoke') {
      assert(!fs.existsSync(path.join(workspace, fixtureFile)) && !fs.existsSync(path.join(workspace, modeFile)));
      fs.writeFileSync(path.join(workspace, fixtureFile), fixture);
      fixtureCreated = true;
      conf.projects.etchly.profiles['vitest-worker-d1-integration'].integrationFiles.push(fixtureFile);
      conf.projects.etchly.groups[group] = { profileId: 'vitest-worker-d1-integration', files: [fixtureFile] };
      write(configPath, conf);
      const setMode = value => { write(path.join(workspace, modeFile), { mode: value }); modeCreated = true; };
      const originalGroup = keyGroup();
      if (mode === 'd08-remainder') {
        assert(originalGroup && !originalGroup.inFlight && !originalGroup.delivery?.pending, 'Continue only a settled own group');
        assert.equal(originalGroup.lastResult?.cleanup?.complete, true);
      } else assert.equal(originalGroup, undefined);
      const baseline = originalGroup?.timeoutCount ?? 0;
      summary.initialGroup = originalGroup ?? null;
      summary.initialTimeoutCount = baseline;
      const prefix = mode === 'd08-remainder' ? [['hang', 'timed-out']] : [['green', 'passed'], ['assertions', 'assertions-failed'], ['setup', 'setup-failed'], ['skip', 'setup-failed'], ['hang', 'timed-out']];
      for (const [value, expected] of prefix) {
        setMode(value);
        const run = launch(value);
        if (value === 'hang') await ready(run);
        const row = await run.done; expect(row, expected);
        if (value === 'hang') assert.equal(row.result.timeoutCount, baseline + 1);
      }
      setMode('hang');
      const interrupt = launch('interrupt'); await ready(interrupt); interrupt.child.kill('SIGINT');
      const interruptedRow = await interrupt.done; expect(interruptedRow, 'interrupted'); assert.equal(interruptedRow.result.timeoutCount, baseline + 1);
      const concurrent = launch('concurrent-owner'); await ready(concurrent);
      const refused = await launch('concurrent-refused').done;
      assert.equal(refused.cliCode, 1); assert.equal(refused.result?.errorCode, 'GROUP_IN_FLIGHT');
      concurrent.child.kill('SIGTERM'); expect(await concurrent.done, 'interrupted');
      const crashed = launch('crash'); const original = await ready(crashed);
      crashed.child.kill('SIGKILL'); const crashRow = await crashed.done;
      assert.equal(crashRow.signal, 'SIGKILL'); assert.equal(crashRow.result, null);
      while (Date.now() <= original.deadlineMs && !interrupted) await delay(Math.min(100, original.deadlineMs - Date.now() + 1));
      const recovered = await launch('recovery').done;
      assert.equal(recovered.cliCode, 1); assert.equal(recovered.result?.errorCode, 'GROUP_IN_FLIGHT');
      assert.equal(keyGroup().inFlight, null); assert.equal(keyGroup().timeoutCount, baseline + 2);
      const delivery = await launch('recovery-delivery').done; expect(delivery, 'timed-out');
      assert.equal(delivery.result.runId, original.runId);
      assert(!fs.existsSync(path.join(output, 'recovery-delivery.spawn.json')));
      setMode('green'); const green = await launch('after-recovery').done; expect(green, 'passed');
      assert.equal(green.result.timeoutCount, baseline + 2, 'Recovery must not count the same timeout twice');
    } else {
      const files = conf.projects.etchly.groups[group].files;
      assert.equal(files.length, 3); assert.equal(new Set(files).size, 3);
      expect(await launch('preset').done, 'passed');
      expect(await launch('exact-files', ['--files', ...files]).done, 'passed');
      for (const [label, selection] of [
        ['subset', ['--files', files[0]]], ['duplicate', ['--files', ...files, files[0]]],
        ['extra', ['--files', ...files, 'worker/src/not-in-preset.test.ts']], ['directory', ['--files', 'worker/src']],
        ['glob', ['--files', 'worker/src/*.test.ts']], ['escape', ['--files', '../foreign.test.ts']], ['only', ['--only', files[0] + '::foreign']],
      ]) {
        const row = await launch(label, selection).done;
        assert.equal(row.cliCode, 1); assert.equal(row.result?.outcome, 'refused');
        assert.equal(row.result.command, null); assert(!fs.existsSync(path.join(output, label + '.spawn.json')));
      }
      for (const [label, relative] of [['missing-local-build', 'app/dist/local/index.html'], ['missing-workerd', 'node_modules/workerd/bin/workerd']]) {
        const file = path.join(workspace, relative), held = file + '.qa-held';
        assert(!fs.existsSync(held));
        fs.renameSync(file, held);
        try {
          const row = await launch(label).done;
          assert.equal(row.cliCode, 1); assert.equal(row.result?.outcome, 'setup-failed');
          assert.equal(row.result.command, null); assert(!fs.existsSync(path.join(output, label + '.spawn.json')));
        } finally { fs.renameSync(held, file); }
      }
    }
    track();
    summary.liveOwnedBeforeEmergencyCleanup = [...owned.values()].filter(row => identity(row.pid)?.start === row.start);
    assert.deepEqual(summary.liveOwnedBeforeEmergencyCleanup, []);
    for (const row of rows) if (row.result?.command?.environment?.TMPDIR) assert(!fs.existsSync(row.result.command.environment.TMPDIR), 'Run TMPDIR must have been removed');
    summary.status = 'passed';
  } catch (error) { summary.failures.push({ message: error.message, stack: error.stack }); }
  finally {
    clearTimeout(watchdog); clearInterval(sampler); killOwned();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    fs.writeFileSync(configPath, savedConfig); fs.writeFileSync(flowPath, savedFlow);
    if (fixtureCreated) fs.rmSync(path.join(workspace, fixtureFile), { force: true });
    if (modeCreated) fs.rmSync(path.join(workspace, modeFile), { force: true });
    await delay(200);
    summary.restored = { configuration: hash(configPath) === createHash('sha256').update(savedConfig).digest('hex'), flow: hash(flowPath) === createHash('sha256').update(savedFlow).digest('hex'), etchlyDirty: git(workspace, 'status', '--porcelain=v1') };
    summary.observedProcesses = [...owned.values()];
    summary.liveOwnedAfterEmergencyCleanup = [...owned.values()].filter(row => identity(row.pid)?.start === row.start);
    if (summary.liveOwnedAfterEmergencyCleanup.length || !summary.restored.configuration || !summary.restored.flow || summary.restored.etchlyDirty) {
      summary.status = 'failed'; summary.failures.push({ message: 'Stand cleanup or restoration incomplete' });
    }
    summary.interrupted = interrupted;
    write(path.join(output, 'summary.json'), summary);
  }
  console.log(JSON.stringify({ status: summary.status, output, cases: rows.length, boundary: summary.evidenceBoundary }));
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}

if (process.argv[2] === '--worker') await worker(process.argv[3]);
else {
  const [root, output, mode, budget, watchdog] = process.argv.slice(2);
  assert(root && output && mode && budget && watchdog, 'Usage: node scripts/qa-etchly-integration-host.mjs STAND_ROOT NEW_OUTPUT smoke|d08|d08-remainder STAND_INTEGRATION_BUDGET_MS HOST_WATCHDOG_MS');
  await host(path.resolve(root), path.resolve(output), mode, Number(budget), Number(watchdog));
}
