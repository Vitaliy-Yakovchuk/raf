import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { buildCatalog } from '../src/bootstrap.ts';
import { openStateStore } from '../src/state-store.ts';
import { listTaskReservations } from '../src/task-reservations.ts';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const change = 'launch-failure-fixture';
const description = 'Write launch failure fixture';
const budgetMs = 30000;

const commandScript = String.raw`
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const c = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { runProductionCli } = await import(pathToFileURL(c.sourceRoot + '/src/production-entry.ts'));
const result = await runProductionCli(JSON.parse(process.argv[3]), {orchestratorRoot:c.root,homeDirectory:c.home,artifactPath:c.artifact});
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.exitCode;
`;

const tmuxScript = String.raw`
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const c = JSON.parse(readFileSync(process.env.RAF_LAUNCH_FAILURE_FIXTURE, 'utf8'));
const input = process.argv.slice(2);
const args = [];
for (let index = 0; index < input.length; index++) {
  if (input[index] === '-S' || input[index] === '-L') { index++; continue; }
  args.push(input[index]);
}
const result = spawnSync(c.tmux, ['-L', c.tmuxLabel, ...args], {stdio:'inherit',env:process.env});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

const runnerScript = String.raw`
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('codex-cli raf-synthetic-1'); process.exit(0); }
const c = JSON.parse(readFileSync(process.env.RAF_LAUNCH_FAILURE_FIXTURE, 'utf8'));
const mode = readFileSync(c.control + '/mode', 'utf8').trim();
const nativeId = randomUUID();
writeFileSync(c.control + '/runner-' + process.pid + '.pid', String(process.pid));
setInterval(() => {}, 1000);
if (mode === 'trust') {
  console.log('  Folder access\n  ' + process.cwd() + '\n  Trust this folder? Codex can read, edit, and run files here.\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit');
} else if (mode !== 'silent' && mode !== 'parent-timeout') {
  console.log('RAF SYNTHETIC READY\n› RAF SYNTHETIC READY');
  process.stdin.setEncoding('utf8');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = '', assignment;
  process.stdin.on('data', chunk => {
    input += chunk.replace(/\x1b\[(?:200|201)~/g, '').replace(/\r/g, '\n');
    if (input.includes('/status')) { console.log('\nSession: ' + nativeId + '\nRAF SYNTHETIC READY\n› RAF SYNTHETIC READY'); input = ''; return; }
    if (assignment) return;
    if (mode === 'delivery') { process.stdout.write('\x1b[2J\x1b[HSession: ' + nativeId + '\nUnknown native transition'); assignment = true; return; }
    const offset = input.search(/\{\s*"project"\s*:/);
    if (offset < 0) return;
    let candidate;
    try { candidate = JSON.parse(input.slice(offset).trim()); } catch { return; }
    if (!candidate.report_path || !candidate.assignments || !/[\r\n]\s*$/.test(input)) return;
    assignment = candidate;
    console.log('\n• Working (0s • esc to interrupt)\n› ');
    writeFileSync(c.control + '/' + candidate.agent_id + '.brief', String(process.pid));
  });
  setInterval(() => {
    if (!assignment || assignment === true) return;
    const id = assignment.agent_id;
    try { readFileSync(c.control + '/' + id + '.close'); } catch { return; }
    if (assignment.closing) return;
    assignment.closing = true;
    const out = openSync(c.control + '/' + id + '.close.out', 'w');
    const closer = spawn('/bin/sh', ['-c', '"$0" "$1" "$2" "$3"; echo $? > "$4.tmp" && mv "$4.tmp" "$4"', process.execPath, c.commandPath, process.env.RAF_LAUNCH_FAILURE_FIXTURE, JSON.stringify(['agent', 'close', '--id', id]), c.control + '/' + id + '.close.code'], { detached: true, stdio: ['ignore', out, out], env: process.env });
    closer.unref();
  }, 20);
}
`;

async function json(path: string) { return JSON.parse(await fs.readFile(path, 'utf8')); }
async function writeJson(path: string, value: unknown) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
async function exists(path: string) { try { await fs.access(path); return true; } catch { return false; } }
async function until<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, label: string, limitMs = budgetMs): Promise<T> {
  const deadline = Date.now() + limitMs;
  let last: T;
  do {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`${label}; last observation: ${JSON.stringify(last)}`);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function fixture(t: any, mode: string, timeouts: { startupMs: number; transitionMs: number; overallMs: number }) {
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/raf-lfc-'));
  const root = join(directory, 'orchestrator');
  const home = join(directory, 'home');
  const conf = join(root, 'conf');
  const tmpRoot = join(home, '.raf', 'tmp');
  const control = join(directory, 'control');
  const bin = join(directory, 'bin');
  const workspace = join(root, 'raf-develop');
  for (const path of [conf, tmpRoot, control, bin, workspace]) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const programs = await Promise.all(['openspec', 'tmux'].map(async name => (await exec('/bin/sh', ['-c', 'command -v "$1"', 'fixture', name])).stdout.trim()));
  const models = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/models.json'), 'utf8'));
  models.models = models.models.filter((x: any) => x.id === 'gpt-6.1-sol');
  models.runners = models.runners.filter((x: any) => x.id === 'codex');
  const constants = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/raf-constants.json'), 'utf8'));
  constants.commands = constants.commands.filter((x: any) => ['agent run', 'agent close', 'help'].includes(x.path.join(' ')));
  const artifact = join(directory, 'catalog.json');
  const changeDir = join(root, 'openspec', 'changes', change);
  const marker = join(directory, 'fixture.json');
  const cfg = { sourceRoot, root, home, artifact, control, statePath: join(home, '.raf', 'state.sqlite'), tmux: programs[1], tmuxLabel: `raf-lfc-${randomUUID().slice(0, 8)}`, commandPath: join(directory, 'command.mjs') };
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, RAF_LAUNCH_FAILURE_FIXTURE: marker, TMPDIR: directory };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const owned = async () => {
    const pids: number[] = [];
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const environ = await fs.readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
      if (environ.split('\0').includes(`RAF_LAUNCH_FAILURE_FIXTURE=${marker}`)) pids.push(Number(entry));
    }
    return pids;
  };
  const tmuxSessions = async () => {
    try { return (await exec(cfg.tmux, ['-L', cfg.tmuxLabel, 'list-sessions', '-F', '#{session_name}'])).stdout.split('\n').filter(Boolean); }
    catch (error) {
      if (/no server running|error connecting/i.test(String((error as { stderr?: string }).stderr))) return [];
      throw error;
    }
  };
  t.after(async () => {
    for (const pid of await owned()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await exec(cfg.tmux, ['-L', cfg.tmuxLabel, 'kill-server']).catch(() => undefined);
    await fs.rm(join(`/tmp/tmux-${process.getuid!()}`, cfg.tmuxLabel), { force: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  await writeJson(marker, cfg);
  await fs.writeFile(cfg.commandPath, commandScript);
  for (const [name, source] of Object.entries({ codex: runnerScript, tmux: tmuxScript })) await fs.writeFile(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await fs.writeFile(join(control, 'mode'), mode);
  await writeJson(join(conf, 'models.json'), models);
  await writeJson(join(conf, 'raf-constants.json'), constants);
  await writeJson(join(conf, 'projects.json'), { version: 1, projects: { raf: { path: 'raf-develop', profile: 'product', branchPaths: { develop: 'raf-develop' } } } });
  const flow = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/flow.json'), 'utf8'));
  await writeJson(join(conf, 'flow.json'), { ...flow, resources: Object.fromEntries(Object.entries(flow.resources).map(([tier, thresholds]) => [tier, { ...(thresholds as object), minRamBytes: 1, minDiskBytes: 1 }])) });
  await fs.mkdir(join(root, 'questions', 'projects', 'raf'), { recursive: true });
  await fs.writeFile(join(root, 'questions', 'projects', 'raf', 'questions.md'), '# Питання\n');
  await writeJson(join(conf, 'raf.json'), { version: 1, state: { fileName: 'state.sqlite' }, commandTiming: { emaAlpha: 0.1 }, runnerProtocols: [{
    runner: 'codex', executable: 'codex', version: 'raf-synthetic-1', baseArgs: [], modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null, quotaCommand: '/status', navigation: [], markers: { ready: ['RAF SYNTHETIC READY'] }, quotaParser: 'codex_status', modelPools: {}, quotaReliable: false, liveTaskVerified: true,
    timeouts: { ...timeouts, pollMs: 25 }, collection: { intervalMs: 300000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  }] });
  for (const path of ['runners/codex.md', 'tasks/implement.md', 'completion.md']) { await fs.mkdir(dirname(join(conf, 'briefs', path)), { recursive: true }); await fs.writeFile(join(conf, 'briefs', path), 'Synthetic launch failure fixture.\n'); }
  buildCatalog(conf, artifact, constants.commands.map((x: any) => x.path.join(' ')));
  await exec('git', ['init', '-b', 'develop', workspace], { env });
  await fs.mkdir(join(changeDir, 'specs', 'launch-fixture'), { recursive: true });
  await fs.writeFile(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(join(changeDir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-22\n');
  await fs.writeFile(join(changeDir, 'proposal.md'), '## Why\nLaunch failure fixture.\n\n## What Changes\nExercise failed launch cleanup.\n\n## Capabilities\n\n### New Capabilities\n- `launch-fixture`: Fail isolated launches.\n\n## Impact\nTemporary fixture only.\n');
  await fs.writeFile(join(changeDir, 'design.md'), '## Context\nSynthetic runner.\n\n## Decisions\nPrivate temporary fixture.\n');
  await fs.writeFile(join(changeDir, 'specs', 'launch-fixture', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Isolated fixture task\nThe fixture SHALL execute only selected temporary tasks.\n\n#### Scenario: Selected task\n- **WHEN** the fixture starts\n- **THEN** only the assigned item is touched\n');
  await fs.writeFile(join(changeDir, 'tasks.md'), `## 1. Fixture\n\n- [ ] 1.1 ${description}\n`);
  openStateStore(cfg.statePath).close();
  const command = async (argv: string[]) => {
    const child = spawn(process.execPath, [cfg.commandPath, marker, JSON.stringify(argv)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
    return { exitCode, result: stdout.trim() ? JSON.parse(stdout) : null, stderr };
  };
  const run = (id: string) => command(['agent', 'run', '--id', id, '--type', 'implement', '--project', 'raf', '--features', 'launch-fixture', '--phase', 'implement', '--complexity', 'decision', '--tasks', `${change}:1.1`]);
  const inspect = () => {
    const store = openStateStore(cfg.statePath);
    try {
      return { sessions: store.sessionRepository.transaction(tx => tx.listSessions()), claims: listTaskReservations(store), admission: store.sessionRepository.transaction(tx => tx.listReservations()), pending: store.sessionRepository.transaction(tx => tx.listPending()) };
    } finally { store.close(); }
  };
  const runners = async () => (await fs.readdir(control)).filter(name => /^runner-\d+\.pid$/.test(name)).map(name => Number(name.slice(7, -4)));
  const runDirectories = async () => (await fs.readdir(tmpRoot)).filter(name => name !== 'tmux');
  return { directory, control, tmpRoot, run, inspect, owned, tmuxSessions, runners, runDirectories };
}

async function assertFailedLaunchCleaned(f: Awaited<ReturnType<typeof fixture>>, outcome: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>, label: string) {
  assert.equal(outcome.exitCode, 1, JSON.stringify(outcome));
  const failure = JSON.parse(outcome.result.stderr);
  assert.equal(failure.code, 'LAUNCH_FAILED', outcome.result.stderr);
  const started = await f.runners();
  if (label !== 'parent-timeout') assert.equal(started.length, 1, `${label}: synthetic runner was started`);
  assert.deepEqual(started.filter(alive), [], `${label}: own runner process must be terminated before agent run returns`);
  assert.deepEqual(failure.details.pending, [], `${label}: nothing may stay pending: ${outcome.result.stderr}`);
  assert.equal(failure.details.retrySafe, true, `${label}: confirmed cleanup makes retry safe`);
  const snapshot = f.inspect();
  assert.deepEqual(snapshot.claims, [], `${label}: claims released atomically with the launch`);
  assert.deepEqual(snapshot.admission, [], `${label}: admission reservation released`);
  assert.deepEqual(snapshot.sessions.map(session => session.state), ['finished'], `${label}: launch closed`);
  assert.deepEqual(await f.runDirectories(), [], `${label}: launch directory removed`);
  assert.deepEqual(await f.tmuxSessions(), [], `${label}: own tmux session killed`);
  await until(f.owned, pids => pids.length === 0, `${label}: no fixture process (worker, runner, tmux server) remains`, 5000);
}

const failureBudget = { startupMs: 20000, transitionMs: 5000, overallMs: 30000 };

test('[launch-failure-cleanup] trust prompt: LAUNCH_FAILED stops own runner and tmux session, removes launch directory, releases claims', async t => {
  const f = await fixture(t, 'trust', failureBudget);
  await assertFailedLaunchCleaned(f, await f.run('trust-agent'), 'trust');
});

test('[launch-failure-cleanup] silent runner: worker readiness timeout cleans its own launch', async t => {
  const f = await fixture(t, 'silent', { ...failureBudget, startupMs: 1500 });
  await assertFailedLaunchCleaned(f, await f.run('silent-agent'), 'silent');
});

test('[launch-failure-cleanup] parent handshake timeout terminates own worker and its tmux session', async t => {
  const f = await fixture(t, 'parent-timeout', { ...failureBudget, overallMs: 3000 });
  await assertFailedLaunchCleaned(f, await f.run('timeout-agent'), 'parent-timeout');
});

test('[launch-failure-cleanup] brief delivery failure cleans its own launch', async t => {
  const f = await fixture(t, 'delivery', failureBudget);
  await assertFailedLaunchCleaned(f, await f.run('delivery-agent'), 'delivery');
});

test('[launch-failure-cleanup] agent close without report exits 0 after confirmed closure and reports failed result', async t => {
  const f = await fixture(t, 'close', failureBudget);
  const launched = await f.run('close-agent');
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const runId = JSON.parse(launched.result.stdout).runId;
  await until(() => exists(join(f.control, 'close-agent.brief')), Boolean, 'runner received brief');
  await fs.writeFile(join(f.control, 'close-agent.close'), 'close');
  const code = await until(async () => await exists(join(f.control, 'close-agent.close.code')) ? (await fs.readFile(join(f.control, 'close-agent.close.code'), 'utf8')).trim() : null, value => value !== null, 'agent close finished');
  const printed = await fs.readFile(join(f.control, 'close-agent.close.out'), 'utf8');
  assert.equal(code, '0', printed);
  const result = JSON.parse(printed);
  const output = JSON.parse(result.stdout);
  assert.equal(output.closed, true, printed);
  assert.equal(output.result, 'failed', printed);
  assert.deepEqual(output.unfinished, []);
  const snapshot = f.inspect();
  const session = snapshot.sessions.find(row => row.runId === runId)!;
  assert.equal(session.state, 'finished');
  assert.equal(session.result?.status, 'failed');
  assert.deepEqual(snapshot.claims, []);
  assert.deepEqual(snapshot.admission, []);
  assert.ok(snapshot.pending.some(row => row.runId === runId && row.event === 'agent.failed'), JSON.stringify(snapshot.pending));
  assert.deepEqual(await f.runDirectories(), []);
  assert.deepEqual(await f.tmuxSessions(), []);
  await until(f.owned, pids => pids.length === 0, 'no fixture process remains after close', 5000);
});
