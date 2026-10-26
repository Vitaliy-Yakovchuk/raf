import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareHostHome, verifyPreparedHostHome, assertOwnedDirectory } from './helpers/trt633-host-home.ts';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const self = fileURLToPath(import.meta.url);
const atomic = (file, data) => {
  fs.writeFileSync(file + '.part', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.part', file);
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const roles = ['test-scaffold', 'qa', 'hotfix'];
let interrupted = null;
const group = role => `add-raf-test-run/trt633-${role}`;
const testFile = role => `test/trt633-${role}.test.ts`;
const wait = async (label, probe, budget, interruptible = true) => {
  const end = budget === null ? Infinity : Date.now() + budget;
  while (Date.now() < end) {
    if (interruptible && interrupted) throw Error(`Host interrupted by ${interrupted}; result is incomplete`);
    const value = probe();
    if (value) return value;
    await delay(300);
  }
  throw Error(`Unexecuted: ${label}; host deadline is not a unit exception`);
};

async function worker(action, role, report) {
  assert.ok(roles.includes(role));
  assert.ok(path.isAbsolute(report));
  const own = path.dirname(report), cwd = fs.realpathSync(process.cwd());
  assert.ok(cwd.includes('/root/raf-'), 'isolated fixture workspace required');
  if (action === 'prepare') {
    const marker = `qa/trt633-${role}.fixed`;
    assert.ok(!fs.existsSync(marker), 'never reuse a previous red fixture');
    fs.writeFileSync(testFile(role), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { appendFileSync, existsSync } from 'node:fs';\ntest('TRT633 ${role} author red', () => {\n  appendFileSync(new URL('../qa/trt633-${role}.executions', import.meta.url), 'executed\\n');\n  assert.equal(existsSync(new URL('../${marker}', import.meta.url)), true, 'controlled own regression');\n});\n`);
    atomic(path.join(own, 'trt633-worker-ready.json'), { role, cwd, report, fixture: testFile(role) });
  } else if (action === 'fix') {
    assert.notEqual(role, 'test-scaffold');
    fs.writeFileSync(`qa/trt633-${role}.fixed`, 'fixture correction\n', { flag: 'wx' });
  } else if (action === 'finish') {
    atomic(path.join(own, 'trt633-worker-done.json'), { role, cwd, at: new Date().toISOString() });
    const verdict = await wait('host verification', () => {
      const file = path.join(own, 'trt633-verdict.json');
      return fs.existsSync(file) && read(file);
    }, 60000);
    const status = verdict.ok ? 'succeeded' : 'failed';
    const item = String(roles.indexOf(role) + 1) + '.1';
    const reason = verdict.ok ? undefined : verdict.reason;
    atomic(report, {
      status, answer: `Controlled live ${role} channel: ${verdict.reason}. No own commits: disposable fixture test/marker only; the host retains raw channel evidence.`,
      changes: [{ id: 'add-raf-test-run', items: [{ id: item, status, ...(reason ? { reason } : {}) }] }],
      commits: [], context: { unnecessary: [], missing: [] },
    });
  } else throw Error('worker prepare|fix|finish');
  console.log(JSON.stringify({ action, role, report }));
}

async function pane(stand) {
  const cli = path.join(stand, 'root/raf-main/bin/raf.ts');
  const active = new Map();
  const run = async (label, args, budget = 240000) => {
    const out = fs.openSync(path.join(stand, 'ev', label + '.stdout'), 'wx', 0o600);
    const err = fs.openSync(path.join(stand, 'ev', label + '.stderr'), 'wx', 0o600);
    const command = [process.execPath, cli, ...args];
    const child = spawn(command[0], command.slice(1), { cwd: path.dirname(path.dirname(cli)), env: process.env, stdio: ['ignore', out, err], detached: true });
    let error = null, hostDeadlineReached = false;
    child.once('error', cause => { error = cause.message; });
    const closed = new Promise(resolve => child.once('close', (...result) => resolve(result)));
    active.set(label, { child, args, closed });
    atomic(path.join(stand, 'ev', label + '.started.json'), { command, pid: child.pid ?? null, budgetMs: budget, startedAt: new Date().toISOString() });
    const timer = budget === null ? null : setTimeout(() => {
      hostDeadlineReached = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, budget);
    const [code, signal] = await closed;
    if (timer !== null) clearTimeout(timer);
    active.delete(label); fs.closeSync(out); fs.closeSync(err);
    const row = { command, cliExitCode: code, signal, error, hostDeadlineReached };
    atomic(path.join(stand, 'ev', label + '.json'), row);
    return row;
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', data => fs.appendFileSync(path.join(stand, 'ev/main-inbox.bin'), data));
  atomic(path.join(stand, 'main-ready.json'), await run('main-attach', ['main', 'attach']));
  setInterval(async () => {
    for (const name of fs.readdirSync(path.join(stand, 'commands')).filter(name => name.endsWith('.json')).sort()) {
      const file = path.join(stand, 'commands', name), request = read(file);
      fs.renameSync(file, file + '.running');
      if (request.cancelPending) {
        const cancelled = [], closed = [];
        for (const [label, { child, args, closed: finished }] of active) if (args[0] === 'agent' && args[1] === 'run') {
          try { process.kill(-child.pid, 'SIGKILL'); cancelled.push({ label, pid: child.pid }); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          closed.push(finished);
        }
        await Promise.all(closed);
        atomic(path.join(stand, 'ev', request.label + '.json'), { command: null, cliExitCode: 0, signal: null, error: null, cancelled });
        fs.renameSync(file + '.running', file + '.done');
      } else void run(request.label, request.args, request.budget).then(() => fs.renameSync(file + '.running', file + '.done'));
    }
  }, 100);
}

const observerProgram = String.raw`
import fs from 'node:fs';
import path from 'node:path';
if (process.argv[1]?.endsWith('/bin/raf.ts') && process.argv[2] === 'test' && process.argv[3] === 'run') {
  const base = path.join(process.env.TRT633_CAPTURE, String(process.pid));
  const outputs = ['stdout', 'stderr'].map(name => fs.openSync(base + '.' + name, 'wx', 0o600));
  for (const [index, name] of ['stdout', 'stderr'].entries()) {
    const original = process[name].write.bind(process[name]);
    process[name].write = (chunk, encoding, callback) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk);
      fs.writeSync(outputs[index], bytes);
      return original(chunk, encoding, callback);
    };
  }
  const ancestors = [];
  for (let pid = process.pid; pid > 1 && !ancestors.some(row => row.pid === pid);) {
    try {
      const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      ancestors.push({ pid, ppid: Number(fields[1]), startedTicks: fields[19] });
      pid = Number(fields[1]);
    } catch { break; }
  }
  const context = { executable: process.execPath, argv: process.argv.slice(1), cwd: process.cwd(), ancestors, startedAt: new Date().toISOString() };
  process.on('exit', code => {
    for (const fd of outputs) fs.closeSync(fd);
    fs.writeFileSync(base + '.cli-exit-code.txt', String(code) + '\n');
    fs.writeFileSync(base + '.json.part', JSON.stringify({ ...context, cliExitCode: code, finishedAt: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(base + '.json.part', base + '.json');
  });
}
`;

async function host(sourceSha, evidence) {
  assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);
  assert.ok(evidence && path.isAbsolute(evidence));
  const source = fs.realpathSync(path.resolve(path.dirname(self), '..')), ownerRoot = path.dirname(source);
  const prepared = verifyPreparedHostHome({ env: process.env, source, ownerRoot, evidence });
  const stand = prepared.home;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = signal; });
  const root = path.join(stand, 'root'), main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop'), hotfix = path.join(root, 'raf-hotfix');
  const ev = path.join(stand, 'ev'), capture = path.join(ev, 'channels'), mainSocket = path.join(stand, 'main.sock');
  const unitHomes = [develop, hotfix].map(workspace => path.join(`/tmp/raf-unit-${process.getuid()}`, createHash('sha256').update(JSON.stringify([root, 'raf', workspace])).digest('hex')));
  assert.ok(unitHomes.every(home => !fs.existsSync(home)), 'new stand identity must not alias an existing QA HOME');
  for (const file of [mainSocket, path.join(stand, '.raf/tmp/tmux/server.sock')]) assert.ok(Buffer.byteLength(file) <= 107, 'mktemp prefix too long for tmux');
  for (const dir of [root, ev, capture, path.join(stand, 'commands'), evidence]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const observer = path.join(stand, 'stdio-observer.mjs');
  fs.writeFileSync(observer, observerProgram);
  const gitConfig = path.join(stand, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n name = TRT633 QA\n email = trt633@example.invalid\n');
  const env = { ...process.env, CODEX_HOME: prepared.codexHome, HOME: stand, RAF_QA_HOME: stand, TMPDIR: stand, XDG_CONFIG_HOME: path.join(stand, '.config'), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', NODE_OPTIONS: `--import=${observer}`, TRT633_CAPTURE: capture };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(key) || /^RAF_/.test(key) && key !== 'RAF_QA_HOME' || ['TMUX', 'TMUX_PANE', 'ALLOW_MIGRATIONS', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
  const summary = {
    status: 'failed', source, sourceSha, driverSha256: hash(self), homeGuardSha256: hash(fileURLToPath(new URL('./helpers/trt633-host-home.ts', import.meta.url))), startedAt: new Date().toISOString(),
    runner: 'real codex CLI; provider prompts are sent; model and effort selected by copied raf routing',
    launchWaitPolicy: 'Only raf decides resource admission; agent run waits in its queue without a host timeout. SIGINT/SIGTERM interrupt the host as failed/incomplete and clean up owned launches.',
    instrumentation: 'NODE_OPTIONS preload tees only CLI test run stdout/stderr and records process ancestry/exit; no production source/auth/parser/runner replacement',
    stand, evidence, selectedEnvironment: prepared, codexAuthorization: { selector: prepared.codexHome, credentialOrigin: 'ordinary owner Codex; no separate login' }, codexTrust: { policy: 'observe project trust entries only; never edit or restore owner configuration' }, steps: [], scenarios: [], failures: [], cleanup: [],
  };
  const trustEvidence = () => {
    const configPath = path.join(prepared.codexHome, 'config.toml');
    try {
      const entries = [];
      let project = null;
      for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
        if (/^\s*\[/.test(line)) project = /^\s*\[projects\./.test(line) ? line.trim() : null;
        else if (project && /^\s*trust_level\s*=/.test(line)) {
          const level = line.match(/^\s*trust_level\s*=\s*["'](trusted|untrusted)["']\s*(?:#.*)?$/)?.[1];
          if (level) entries.push(project, `trust_level = "${level}"`);
        }
      }
      return { configPath, entries };
    } catch (error) { return { configPath, entries: [], unavailable: error.code ?? 'READ_FAILED' }; }
  };
  summary.codexTrust.before = trustEvidence();
  let sequence = 0, startedPane = false;
  const checked = row => { assert.equal(row.error, null); assert.equal(row.signal, null); assert.equal(row.cliExitCode, 0, `see ${row.label}.stderr`); return row; };
  const command = async (label, executable, argv, cwd = root, budget = 120000) => {
    const out = fs.openSync(path.join(ev, label + '.stdout'), 'wx', 0o600), err = fs.openSync(path.join(ev, label + '.stderr'), 'wx', 0o600);
    const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', out, err], detached: true });
    let spawnError = null, timedOut = false;
    child.once('error', error => { spawnError = error.message; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, budget);
    const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
    clearTimeout(timer); fs.closeSync(out); fs.closeSync(err);
    const row = { label, executable, argv, cwd, cliExitCode: code, signal, error: spawnError, hostDeadlineReached: timedOut };
    atomic(path.join(ev, label + '.json'), row); summary.steps.push(row);
    return row;
  };
  const git = async (cwd, ...args) => {
    const label = 'git-' + (++sequence);
    checked(await command(label, 'git', ['-C', cwd, ...args], cwd));
    return fs.readFileSync(path.join(ev, label + '.stdout'), 'utf8').trim();
  };
  const sessions = () => {
    const file = path.join(stand, '.raf/state.sqlite');
    if (!fs.existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload)); }
    finally { db.close(); }
  };
  const request = async (label, args, budget = 240000, cancelPending = false) => {
    const result = path.join(ev, label + '.json');
    assert.ok(!fs.existsSync(result));
    atomic(path.join(stand, 'commands', `${String(++sequence).padStart(4, '0')}.json`), { label, args, budget, cancelPending });
    const row = await wait(label, () => fs.existsSync(result) && read(result), budget === null ? null : budget + 10000, !label.startsWith('cleanup-'));
    summary.steps.push({ label, ...row }); return row;
  };
  const channelRows = () => fs.readdirSync(capture).filter(name => /^\d+\.json$/.test(name)).map(name => {
    const file = path.join(capture, name), row = read(file), base = file.slice(0, -5);
    const stdout = fs.readFileSync(base + '.stdout', 'utf8');
    return { ...row, artifact: path.relative(ev, base), stdoutSha256: hash(base + '.stdout'), stderrSha256: hash(base + '.stderr'), result: JSON.parse(stdout) };
  });
  const full = row => {
    const value = row.result;
    for (const key of ['runId', 'callerPhase', 'selection', 'command', 'exitCode', 'timedOut', 'cleanup', 'knownRed', 'unexecuted', 'unknown', 'removed', 'groupSnapshot', 'timeoutCount', 'groupState', 'nextAction', 'diagnostics']) assert.ok(Object.hasOwn(value, key), 'missing TestRunResult.' + key);
    assert.equal(value.timedOut, false); assert.deepEqual(value.cleanup, { complete: true, remainingPids: [] });
    assert.deepEqual(value.unexecuted, []); assert.deepEqual(value.unknown, []);
  };
  try {
    await git(source, 'cat-file', '-e', sourceSha + '^{commit}');
    summary.sourceHead = await git(source, 'rev-parse', 'HEAD'); summary.sourceDirty = await git(source, 'status', '--porcelain=v1');
    for (const [exe, args] of [['node', ['--version']], ['git', ['--version']], ['tmux', ['-V']], ['codex', ['--version']], ['uname', ['-a']]]) checked(await command('version-' + exe, exe, args));
    fs.cpSync(path.join(ownerRoot, 'conf'), path.join(root, 'conf'), { recursive: true });
    const projectsFile = path.join(root, 'conf/projects.json'), projects = read(projectsFile);
    projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator };
    projects.projects.raf.path = 'raf-main'; projects.projects.raf.branchPaths = { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' }; atomic(projectsFile, projects);
    const modelsFile = path.join(root, 'conf/models.json'), models = read(modelsFile);
    summary.sourceModelsHash = hash(modelsFile);
    for (const runner of models.runners) runner.initialEnabled = runner.id === 'codex';
    atomic(modelsFile, models);
    const configFile = path.join(root, 'conf/test-runs.json'), config = read(configFile);
    for (const role of roles) {
      config.projects.raf.profiles.node.unitFiles.push(testFile(role));
      config.projects.raf.groups[group(role)] = { profileId: 'node', files: [testFile(role)] };
    }
    atomic(configFile, config);
    summary.configurationHashes = Object.fromEntries(['models.json', 'projects.json', 'raf.json', 'flow.json', 'test-runs.json', 'raf-constants.json'].map(name => [name, hash(path.join(root, 'conf', name))]));
    checked(await command('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main]));
    await git(main, 'checkout', '-B', 'main', sourceSha);
    fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
    checked(await command('build', process.execPath, ['scripts/build.ts'], main));
    fs.mkdirSync(path.join(main, 'qa'));
    for (const role of roles) fs.writeFileSync(path.join(main, testFile(role)), "import test from 'node:test'; test('unprepared fixture', () => { throw Error('worker must prepare own red'); });\n");
    fs.writeFileSync(path.join(main, 'qa/.keep'), 'TRT633 disposable fixture\n');
    await git(main, 'add', '--', 'qa', ...roles.map(testFile)); await git(main, 'commit', '-m', 'qa: prepare isolated TRT633 inventory');
    await git(root, 'init', '-b', 'main');
    await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main'); await git(root, 'submodule', 'absorbgitdirs');
    const fixtureSha = await git(main, 'rev-parse', 'HEAD'); summary.fixtureSha = fixtureSha;
    await git(main, 'worktree', 'add', '-B', 'develop', develop, fixtureSha); await git(main, 'worktree', 'add', '-b', 'hotfix', hotfix, fixtureSha);
    for (const workspace of [develop, hotfix]) {
      fs.cpSync(path.join(main, 'node_modules'), path.join(workspace, 'node_modules'), { recursive: true, dereference: true });
      assert.ok(fs.statSync(path.join(workspace, 'node_modules')).isDirectory());
      summary.steps.push({ label: 'worktree-dependencies', workspace, source: path.join(main, 'node_modules'), complete: true });
    }
    const change = path.join(root, 'openspec/changes/add-raf-test-run'); fs.mkdirSync(change, { recursive: true });
    fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
    fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
    fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nControlled live author-red QA.\n\n## What Changes\nDisposable tests and markers only.\n\n## Non-goals\nProduct edits, migration, rollout, archive.\n');
    const description = role => {
      const instructions = [
        `[${role}] Controlled TRT633 live QA. Real codex runner. Execute only the following ordered steps with your tools; no implementation, git, commits, archive, model/effort changes, retries, env prefixes or shell wrappers. This fixture explicitly authorizes the negative phase probe below.`,
        `1. Run node test/trt633-host-qa.mjs worker prepare ${role} <your exact report_path>.`,
        `2. Execute ONE simple command using exact raf_command from YOUR brief: raf_command test run --project raf --phase red --group ${group(role)}${role === 'hotfix' ? '' : ` --files ${testFile(role)}`}. Expect assertions-failed, one knownRed, child/CLI 1. Setup/import/resource refusal is not red; on an unexpected result skip remaining test commands and go to finish.`,
      ];
      if (role === 'test-scaffold') instructions.push(`3. Execute ONE negative simple command: raf_command test run --project raf --phase qa --group ${group(role)} --files ${testFile(role)}. Expect CALLER_UNAUTHORIZED before spawn; do not try other phases.`);
      else instructions.push(`3. Run node test/trt633-host-qa.mjs worker fix ${role} <your report_path>, then ONE simple command: raf_command test run --project raf --phase ${role} --group ${group(role)}${role === 'qa' ? '' : ` --files ${testFile(role)}`}. Expect passed, one pass, no knownRed, same HOME/group, CLI 0.`);
      if (role === 'qa') instructions.push('4. Execute two own regression commands with your exact raf_command, both --project raf --phase qa: --group add-raf-test-run/author-red --files test/test-run-author-red.test.ts test/sandbox-test-run.test.ts ; then --group add-raf-test-run/unit --files test/test-runs.test.ts test/test-run-cli.test.ts . Each is a separate simple command; the semicolon in these instructions is prose, never shell. Preserve any nonzero result and continue to the second named regression; no retries or fixes.');
      instructions.push(`Finally run node test/trt633-host-qa.mjs worker finish ${role} <your report_path>. This waits for host evidence verdict and writes the atomic report; do not write a competing report. No own commits because this is a disposable host fixture. Tell host any helper failure and stop; do not bypass your channel.`);
      return instructions.join(' ');
    };
    fs.writeFileSync(path.join(change, 'tasks.md'), roles.map((role, index) => `- [ ] ${index + 1}.1 ${description(role)}`).join('\n') + '\n- [ ] 9.1 Host owns cleanup; keep active, do not execute or archive.\n');
    await git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'openspec'); await git(root, 'commit', '-m', 'qa: isolated TRT633 orchestrator');
    checked(await command('tmux-main-start', 'tmux', ['-S', mainSocket, 'new-session', '-d', '-s', 'trt633-main', '-x', '180', '-y', '50', process.execPath, self, 'pane', stand])); startedPane = true;
    checked(await wait('main attach', () => fs.existsSync(path.join(stand, 'main-ready.json')) && read(path.join(stand, 'main-ready.json')), 60000));
    checked(await request('runner-list', ['runner', 'list'])); checked(await request('runner-limits', ['runner', 'limits', '--runners', 'codex'])); checked(await request('service-start', ['service', 'start']));
    for (const [index, role] of roles.entries()) {
      let record;
      try {
        checked(await request('launch-' + role, ['agent', 'run', '--id', 'trt633-' + role, '--type', role, '--project', 'raf', '--features', 'add-raf-test-run', '--phase', role, '--complexity', 'mechanical', '--tasks', `add-raf-test-run:${index + 1}.1`], null));
        record = await wait(role + ' live identity', () => sessions().find(row => row.addressId === 'trt633-' + role && row.process), 60000);
        assert.equal(record.process.runner, 'codex'); assert.equal(record.launchContext.testAssignment.phase, role);
        const own = path.dirname(record.launchContext.reportPath);
        await wait(role + ' worker done', () => fs.existsSync(path.join(own, 'trt633-worker-done.json')), 600000);
        const rows = channelRows().filter(row => row.ancestors.some(ancestor => ancestor.pid === record.process.pid));
        const ownRows = rows.filter(row => row.result.group === group(role)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        assert.equal(ownRows.length, 2, 'two channel calls, no hidden retry or absent capture');
        const [red, verified] = ownRows;
        full(red); assert.equal(red.result.callerPhase, role); assert.equal(red.result.phase, 'red'); assert.equal(red.result.outcome, 'assertions-failed');
        assert.equal(red.cliExitCode, 1); assert.equal(red.result.exitCode, 1); assert.equal(red.result.knownRed.length, 1); assert.equal(red.result.groupSnapshot, 'loaded');
        assert.deepEqual(red.result.selection.files, [testFile(role)]); assert.deepEqual(red.result.failureKinds, ['assertions']);
        assert.ok(red.result.command.environment.HOME !== stand); assert.ok(red.result.command.environment.HOME.startsWith(`/tmp/raf-unit-${process.getuid()}/`));
        assert.equal(verified.result.phase, role === 'test-scaffold' ? 'qa' : role);
        if (role === 'test-scaffold') {
          assert.equal(verified.result.callerPhase, null, 'denied before unit context selection');
          assert.equal(verified.cliExitCode, 1); assert.equal(verified.result.errorCode, 'CALLER_UNAUTHORIZED'); assert.equal(verified.result.outcome, 'refused');
          assert.equal(verified.result.command, null); assert.equal(verified.result.exitCode, null); assert.equal(verified.result.groupSnapshot, 'unavailable');
        } else {
          assert.equal(verified.result.callerPhase, role);
          full(verified); assert.equal(verified.cliExitCode, 0); assert.equal(verified.result.exitCode, 0); assert.equal(verified.result.outcome, 'passed');
          assert.equal(verified.result.passed.length, 1); assert.deepEqual(verified.result.knownRed, []);
          for (const key of ['HOME', 'statePath', 'tmpPath']) assert.equal(verified.result.command.environment[key], red.result.command.environment[key]);
          assert.equal(verified.result.timeoutCount, red.result.timeoutCount);
        }
        const executions = fs.readFileSync(path.join(record.activity.cwd, `qa/trt633-${role}.executions`), 'utf8').trim().split('\n');
        assert.equal(executions.length, role === 'test-scaffold' ? 1 : 2, 'denial must not execute a test body');
        const scenario = { role, liveRunId: record.runId, process: { pid: record.process.pid, startedAt: record.process.startedAt, runner: record.process.runner }, selection: record.launchContext.selection, assignment: record.launchContext.testAssignment, calls: ownRows, status: 'succeeded' };
        summary.scenarios.push(scenario);
        if (role === 'qa') for (const target of ['add-raf-test-run/author-red', 'add-raf-test-run/unit']) {
          const runs = rows.filter(row => row.result.group === target); assert.equal(runs.length, 1, 'exact regression call required'); full(runs[0]);
          scenario.regressions ??= []; scenario.regressions.push(runs[0]);
          if (runs[0].result.outcome !== 'passed' || runs[0].cliExitCode !== 0) summary.failures.push({ role, group: target, reason: 'Regression is not green; preserve knownRed and keep 6.3.3 open', artifact: runs[0].artifact });
        }
        atomic(path.join(own, 'trt633-verdict.json'), { ok: true, reason: 'Live author red and phase boundaries verified; regression facts retained separately by host' });
        await wait(role + ' report', () => fs.existsSync(record.launchContext.reportPath), 90000);
        atomic(path.join(ev, role + '-session.json'), record);
      } catch (error) {
        summary.failures.push({ role, reason: error.stack ?? String(error) });
        if (record) {
          const own = path.dirname(record.launchContext.reportPath);
          atomic(path.join(own, 'trt633-verdict.json'), { ok: false, reason: String(error) });
          atomic(path.join(ev, role + '-failed-session.json'), record);
        }
      }
      if (interrupted) break;
      if (record) {
        const own = path.dirname(record.launchContext.reportPath), destination = path.join(ev, role + '-run');
        fs.mkdirSync(destination);
        for (const name of ['brief.txt', path.basename(record.launchContext.reportPath), 'trt633-worker-ready.json', 'trt633-worker-done.json', 'trt633-verdict.json']) {
          const file = path.join(own, name); if (fs.existsSync(file)) fs.copyFileSync(file, path.join(destination, name));
        }
        if (record.process.evidence?.tmuxSocket && record.process.evidence?.tmuxPane) await command('pane-' + role, 'tmux', ['-S', record.process.evidence.tmuxSocket, 'capture-pane', '-p', '-J', '-S', '-', '-t', record.process.evidence.tmuxPane]);
        checked(await request('close-' + role, ['agent', 'close', '--id', record.addressId, '--force', '--reason', 'TRT633 isolated fixture finished; raw channel evidence retained'], 60000));
      }
    }
    summary.status = summary.failures.length ? 'failed' : 'succeeded';
  } catch (error) { summary.failures.push({ stage: 'host', reason: error.stack ?? String(error) }); }
  finally {
    if (startedPane) {
      try { checked(await request('cleanup-cancel-pending', [], 60000, true)); }
      catch (error) { summary.failures.push({ stage: 'cleanup', reason: String(error) }); }
      for (const record of sessions().filter(row => row.addressId !== 'main' && row.state !== 'finished')) {
        try { summary.cleanup.push({ step: 'agent-close', id: record.addressId, result: await request('cleanup-close-' + record.addressId, ['agent', 'close', '--id', record.addressId, '--force', '--reason', 'TRT633 own stand cleanup'], 60000) }); }
        catch (error) { summary.failures.push({ stage: 'cleanup', reason: String(error) }); }
      }
      try { checked(await request('cleanup-service-stop', ['service', 'stop'], 60000)); } catch (error) { summary.failures.push({ stage: 'cleanup', reason: String(error) }); }
      for (const [label, socket] of [['agent', path.join(stand, '.raf/tmp/tmux/server.sock')], ['main', mainSocket]]) {
        const killed = await command('cleanup-tmux-' + label, 'tmux', ['-S', socket, 'kill-server']);
        const check = await command('cleanup-check-' + label, 'tmux', ['-S', socket, 'list-sessions']);
        summary.cleanup.push({ step: 'tmux-' + label, killed, check });
        if (check.cliExitCode !== 1 || !/no server|No such file/.test(fs.readFileSync(path.join(ev, 'cleanup-check-' + label + '.stderr'), 'utf8'))) summary.failures.push({ stage: 'cleanup', reason: 'Own tmux still running or state unknown: ' + socket });
      }
    }
    const remaining = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        const raw = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); if (raw.slice(raw.lastIndexOf(')') + 2).startsWith('Z ')) return [];
        const bytes = fs.readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
        return [stand, ...unitHomes].some(home => bytes.includes('HOME=' + home)) && Number(name) !== process.pid ? [Number(name)] : [];
      } catch { return []; }
    });
    summary.cleanup.push({ step: 'owned-process-check', remainingPids: remaining });
    if (remaining.length) summary.failures.push({ stage: 'cleanup', reason: 'Live owned processes remain; retained stand for inspection', pids: remaining });
    summary.sourceHeadAfter = await git(source, 'rev-parse', 'HEAD');
    summary.sourceDirtyAfter = await git(source, 'status', '--porcelain=v1');
    if (summary.failures.length) summary.status = 'failed';
    summary.codexTrust.after = trustEvidence();
    summary.finishedAt = new Date().toISOString();
    atomic(path.join(ev, 'summary.json'), summary);
    fs.cpSync(ev, evidence, { recursive: true });
    if (!remaining.length && !summary.failures.some(row => row.stage === 'cleanup')) {
      for (const unitHome of unitHomes) {
        if (fs.existsSync(unitHome)) {
          assert.equal(fs.realpathSync(unitHome), unitHome); assert.equal(fs.lstatSync(unitHome).uid, process.getuid());
          fs.rmSync(unitHome, { recursive: true });
        }
        summary.cleanup.push({ step: 'remove-own-unit-home', path: unitHome, complete: !fs.existsSync(unitHome) });
      }
      assertOwnedDirectory(stand, prepared.provenance);
      fs.rmSync(stand, { recursive: true });
      summary.cleanup.push({ step: 'remove-owned-stand', complete: !fs.existsSync(stand) });
    } else summary.cleanup.push({ step: 'retain-owned-stand', stand });
    atomic(path.join(evidence, 'summary.json'), summary);
    console.log(JSON.stringify(summary));
    process.exitCode = summary.status === 'succeeded' ? 0 : 1;
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'prepare') {
  const source = fs.realpathSync(path.resolve(path.dirname(self), '..'));
  console.log(JSON.stringify(prepareHostHome({ env: process.env, source, ownerRoot: path.dirname(source), evidence: args[0] })));
}
else if (mode === 'host') await host(...args);
else if (mode === 'pane') await pane(...args);
else if (mode === 'worker') await worker(...args);
else throw Error('prepare <new absolute evidence directory> | host <full source SHA> <new absolute evidence directory> | pane <stand> | worker prepare|fix|finish <role> <report_path>');
