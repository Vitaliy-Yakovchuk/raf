import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { buildCatalog } from '../src/bootstrap.ts';
import { openStateStore } from '../src/state-store.ts';
import type { Reminder } from '../src/reminders.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const change = 'launch-failure-fixture';
export const description = 'Write launch failure fixture';
export const budgetMs = 30000;

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
const c = JSON.parse(readFileSync(process.env.RAF_AGENT_RUN_FIXTURE, 'utf8'));
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

export const runnerScript = String.raw`
import { readFileSync, writeFileSync, openSync, appendFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('codex-cli raf-synthetic-1'); process.exit(0); }
const c = JSON.parse(readFileSync(process.env.RAF_AGENT_RUN_FIXTURE, 'utf8'));
const mode = readFileSync(c.control + '/mode', 'utf8').trim();
const nativeId = randomUUID();
writeFileSync(c.control + '/runner-' + process.pid + '.pid', String(process.pid));
setInterval(() => {}, 1000);
if (mode === 'readiness-unknown') {
  console.log('RAF SYNTHETIC READY\n› RAF SYNTHETIC READY');
  process.stdin.setEncoding('utf8');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = '';
  process.stdin.on('data', chunk => {
    appendFileSync(c.control + '/input-' + process.pid + '.log', chunk);
    input += chunk;
    if (input.includes('/status')) process.stdout.write('\x1b[2J\x1b[HSession: ' + nativeId + '\n› Approve unknown action');
  });
} else if (mode === 'trust') {
  console.log('  Folder access\n  ' + process.cwd() + '\n  Trust this folder? Codex can read, edit, and run files here.\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit');
} else if (mode !== 'silent' && mode !== 'parent-timeout') {
  console.log('RAF SYNTHETIC READY\n› RAF SYNTHETIC READY');
  process.stdin.setEncoding('utf8');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = '', assignment;
  process.stdin.on('data', chunk => {
    appendFileSync(c.control + '/input-' + process.pid + '.log', chunk);
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
  let step = 1, stepping = false;
  setInterval(() => {
    if (!assignment || assignment === true || stepping) return;
    const id = assignment.agent_id, prefix = c.control + '/' + id + '.cmd.' + step;
    let argv;
    try { argv = readFileSync(prefix + '.json', 'utf8'); } catch { return; }
    stepping = true;
    const out = openSync(prefix + '.out', 'w'), err = openSync(prefix + '.err', 'w');
    const child = spawn(process.execPath, [c.commandPath, process.env.RAF_AGENT_RUN_FIXTURE, argv], { stdio: ['ignore', out, err], env: process.env });
    child.on('close', code => { writeFileSync(prefix + '.code.tmp', String(code)); renameSync(prefix + '.code.tmp', prefix + '.code'); step++; stepping = false; });
  }, 20);
  setInterval(() => {
    if (!assignment || assignment === true) return;
    const id = assignment.agent_id;
    try { readFileSync(c.control + '/' + id + '.close'); } catch { return; }
    if (assignment.closing) return;
    assignment.closing = true;
    const out = openSync(c.control + '/' + id + '.close.out', 'w'), err = openSync(c.control + '/' + id + '.close.err', 'w');
    const closer = spawn('/bin/sh', ['-c', '"$0" "$1" "$2" "$3"; echo $? > "$4.tmp" && mv "$4.tmp" "$4"', process.execPath, c.commandPath, process.env.RAF_AGENT_RUN_FIXTURE, JSON.stringify(['agent', 'close', '--id', id]), c.control + '/' + id + '.close.code'], { detached: true, stdio: ['ignore', out, err], env: process.env });
    closer.unref();
  }, 20);
}
`;

export const claudeRunnerScript = String.raw`
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const c = JSON.parse(readFileSync(process.env.RAF_AGENT_RUN_FIXTURE, 'utf8'));
if (process.argv.includes('--version')) { console.log(c.claudeVersion + ' (Claude Code)'); process.exit(0); }
const argv = process.argv.slice(2);
const mode = readFileSync(c.control + '/mode', 'utf8').trim();
const assigned = argv[argv.indexOf('--session-id') + 1];
writeFileSync(c.control + '/runner-' + process.pid + '.pid', String(process.pid));
setInterval(() => {}, 1000);
process.on('SIGHUP', () => setTimeout(() => process.exit(129), c.claudeHangupExitMs));
process.stdout.on('error', () => {});
const render = text => { try { process.stdout.write('\x1b[2J\x1b[H' + text.replaceAll('\n', '\r\n')); } catch {} };
const header = '[Screen Reader Mode: on via flag]\nClaude Code v' + c.claudeVersion + '\nOpus 5.5 with high effort · Claude Max\n' + process.cwd();
const ready = "don't ask on (shift+tab to cycle)";
const focusHint = "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and\nreattach for focus tracking";
const screen = (modeLine, input) => header + '\nyou: /status\nSettings dialog dismissed\n' + modeLine + '\n' + focusHint + '\n$' + input;
render(header + '\n' + ready + '\neffort: high · /effort\n$');
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
let typed = '', paste = null, pasted = null, panel = false;
process.stdin.on('data', data => {
  appendFileSync(c.control + '/input-' + process.pid + '.log', data);
  let rest = data;
  while (rest.length) {
    if (paste !== null) {
      const end = rest.indexOf('\x1b[201~');
      if (end < 0) { paste += rest; rest = ''; break; }
      paste += rest.slice(0, end);
      rest = rest.slice(end + 6);
      pasted = paste;
      paste = null;
      render(screen('paste again to expand', '  [Pasted text #1 +' + (pasted.match(/[\r\n]/g) ?? []).length + ' lines]'));
      continue;
    }
    if (rest.startsWith('\x1b[200~')) { paste = ''; rest = rest.slice(6); continue; }
    if (rest.startsWith('\x1b')) { rest = rest.slice(1); if (panel) { panel = false; render(screen(ready, '')); } continue; }
    const key = rest[0];
    rest = rest.slice(1);
    if (key !== '\r' && key !== '\n') { typed += key; if (pasted === null) render(header + '\n/status                         Show Claude Code status including version,\n$  ' + typed); continue; }
    if (pasted !== null) {
      pasted = null;
      if (mode === 'claude-unknown-after-enter') setTimeout(() => render(header + '\nUnrecognized native dialog after submission'), 110);
      continue;
    }
    if (typed === '/status') { panel = true; typed = ''; render(header + '\nyou: /status\nSettings  Status   Config   Usage   Stats\nVersion: ' + c.claudeVersion + '\nSession ID: ' + assigned + '\nSession kind: interactive\nEsc to cancel'); continue; }
    typed = '';
  }
});
`;

async function json(path: string) { return JSON.parse(await fs.readFile(path, 'utf8')); }
async function writeJson(path: string, value: unknown) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
export async function exists(path: string) { try { await fs.access(path); return true; } catch { return false; } }
export async function until<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, label: string, limitMs = budgetMs): Promise<T> {
  const deadline = Date.now() + limitMs;
  let last: T;
  do {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`${label}; last observation: ${JSON.stringify(last)}`);
}
export function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

export async function agentRunFixture(t: any, mode: string, timeouts: { startupMs: number; transitionMs: number; overallMs: number }, runner: 'codex' | 'claude' = 'codex', options: { tasks?: number; commands?: readonly string[]; stages?: readonly string[]; productionQa?: boolean } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'raf-lfc-')));
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
  const claudeProtocol = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/raf.json'), 'utf8')).runnerProtocols.find((x: any) => x.runner === 'claude');
  models.models = models.models.filter((x: any) => runner === 'claude' ? x.id === 'claude-opus' : x.id === 'gpt-6.1-sol');
  models.runners = models.runners.filter((x: any) => x.id === runner).map((x: any) => ({ ...x, initialEnabled: true }));
  const constants = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/raf-constants.json'), 'utf8'));
  constants.commands = constants.commands.filter((x: any) => ['agent run', 'agent close', 'help', ...(options.commands ?? [])].includes(x.path.join(' ')));
  const artifact = join(directory, 'catalog.json');
  const changeDir = join(root, 'openspec', 'changes', change);
  const marker = join(directory, 'fixture.json');
  const cfg = { sourceRoot: options.productionQa ? workspace : sourceRoot, root, home, artifact, control, statePath: join(home, '.raf', 'state.sqlite'), tmux: programs[1], tmuxLabel: `raf-lfc-${randomUUID().slice(0, 8)}`, commandPath: join(directory, 'command.mjs'), claudeVersion: claudeProtocol.version, claudeHangupExitMs: 750 };
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, RAF_AGENT_RUN_FIXTURE: marker, TMPDIR: directory, TMUX_TMPDIR: directory };
  if (options.productionQa) env.RAF_QA_HOME = home;
  delete env.TMUX;
  delete env.TMUX_PANE;
  const owned = async () => {
    const pids: number[] = [];
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const environ = await fs.readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
      if (environ.split('\0').includes(`RAF_AGENT_RUN_FIXTURE=${marker}`)) pids.push(Number(entry));
    }
    return pids;
  };
  const tmuxSessions = async () => {
    try { return (await exec(cfg.tmux, ['-L', cfg.tmuxLabel, 'list-sessions', '-F', '#{session_name}'], { env })).stdout.split('\n').filter(Boolean); }
    catch (error) {
      if (/no server running|error connecting/i.test(String((error as { stderr?: string }).stderr))) return [];
      throw error;
    }
  };
  t.after(async () => {
    await exec(cfg.tmux, ['-L', cfg.tmuxLabel, 'kill-server'], { env }).catch(() => undefined);
    await until(async () => {
      const pids = await owned();
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      return pids;
    }, pids => pids.length === 0, 'all fixture processes exited before directory removal');
    await fs.rm(directory, { recursive: true, force: true });
  });
  await writeJson(marker, cfg);
  await fs.writeFile(cfg.commandPath, commandScript);
  for (const [name, source] of Object.entries({ [runner]: runner === 'claude' ? claudeRunnerScript : runnerScript, tmux: tmuxScript })) await fs.writeFile(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await fs.writeFile(join(control, 'mode'), mode);
  await writeJson(join(conf, 'models.json'), models);
  await writeJson(join(conf, 'raf-constants.json'), constants);
  await writeJson(join(conf, 'projects.json'), { version: 1, projects: { raf: { path: 'raf-develop', profile: 'product', branchPaths: { develop: 'raf-develop' } } } });
  const flow = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/flow.json'), 'utf8'));
  await writeJson(join(conf, 'flow.json'), { ...flow, resources: Object.fromEntries(Object.entries(flow.resources).map(([tier, thresholds]) => [tier, { ...(thresholds as object), minRamBytes: 1, minDiskBytes: 1 }])) });
  await fs.mkdir(join(root, 'questions', 'projects', 'raf'), { recursive: true });
  await fs.writeFile(join(root, 'questions', 'projects', 'raf', 'questions.md'), '# Питання\n');
  const protocols = runner === 'claude' ? [{ ...claudeProtocol, timeouts: { ...timeouts, pollMs: 25 } }] : [{
    runner: 'codex', executable: 'codex', version: 'raf-synthetic-1', baseArgs: [], modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null, quotaCommand: '/status', navigation: [], markers: { ready: ['RAF SYNTHETIC READY'] }, quotaParser: 'codex_status', modelPools: {}, quotaReliable: false, liveTaskVerified: true,
    timeouts: { ...timeouts, pollMs: 25 }, collection: { intervalMs: 300000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  }];
  await writeJson(join(conf, 'raf.json'), { version: 1, state: { fileName: 'state.sqlite' }, commandTiming: { emaAlpha: 0.1 }, runnerProtocols: protocols });
  for (const path of [`runners/${runner}.md`, ...['implement', ...(options.stages ?? [])].map(stage => `tasks/${stage}.md`), 'completion.md']) { await fs.mkdir(dirname(join(conf, 'briefs', path)), { recursive: true }); await fs.writeFile(join(conf, 'briefs', path), 'Synthetic launch failure fixture.\n'); }
  buildCatalog(conf, artifact, constants.commands.map((x: any) => x.path.join(' ')));
  await exec('git', ['init', '-b', 'develop', workspace], { env });
  await fs.mkdir(join(changeDir, 'specs', 'launch-fixture'), { recursive: true });
  await fs.writeFile(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(join(changeDir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-22\n');
  await fs.writeFile(join(changeDir, 'proposal.md'), '## Why\nLaunch failure fixture.\n\n## What Changes\nExercise failed launch cleanup.\n\n## Capabilities\n\n### New Capabilities\n- `launch-fixture`: Fail isolated launches.\n\n## Impact\nTemporary fixture only.\n');
  await fs.writeFile(join(changeDir, 'design.md'), '## Context\nSynthetic runner.\n\n## Decisions\nPrivate temporary fixture.\n');
  await fs.writeFile(join(changeDir, 'specs', 'launch-fixture', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Isolated fixture task\nThe fixture SHALL execute only selected temporary tasks.\n\n#### Scenario: Selected task\n- **WHEN** the fixture starts\n- **THEN** only the assigned item is touched\n');
  await fs.writeFile(join(changeDir, 'tasks.md'), `## 1. Fixture\n\n${Array.from({ length: options.tasks ?? 1 }, (_, index) => `- [ ] 1.${index + 1} ${description}${index ? ` ${index + 1}` : ''}\n`).join('')}`);
  if (options.productionQa) {
    await fs.copyFile(join(sourceRoot, '../conf/projects.json'), join(conf, 'projects.json'));
    await prepareProductionQaFixture(t, { root, home });
  }
  openStateStore(cfg.statePath).close();
  const command = async (argv: string[]) => {
    const child = spawn(process.execPath, [cfg.commandPath, marker, JSON.stringify(argv)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
    return { exitCode, result: stdout.trim() ? JSON.parse(stdout) : null, stderr };
  };
  const runArgs = (id: string, type = 'implement', tasks = ['1.1']) => ['agent', 'run', '--id', id, '--type', type, '--project', 'raf', '--features', 'launch-fixture', '--phase', type, '--complexity', 'decision', '--tasks', ...tasks.map(task => `${change}:${task}`)];
  const run = (id: string, type?: string, tasks?: string[]) => command(runArgs(id, type, tasks));
  const steps: Record<string, number> = {};
  const as = async (id: string, argv: string[]) => {
    const step = steps[id] = (steps[id] ?? 0) + 1;
    const prefix = join(control, `${id}.cmd.${step}`);
    await fs.writeFile(`${prefix}.json.tmp`, JSON.stringify(argv));
    await fs.rename(`${prefix}.json.tmp`, `${prefix}.json`);
    const code = await until(async () => await exists(`${prefix}.code`) ? Number((await fs.readFile(`${prefix}.code`, 'utf8')).trim()) : null, value => value !== null, `${id} ran ${argv.join(' ')}`);
    const printed = (await fs.readFile(`${prefix}.out`, 'utf8')).trim();
    return { exitCode: code, result: printed ? JSON.parse(printed) : null, stderr: await fs.readFile(`${prefix}.err`, 'utf8') };
  };
  const input = async (pid: number) => fs.readFile(join(control, `input-${pid}.log`), 'utf8').catch(() => '');
  const inspect = () => {
    const store = openStateStore(cfg.statePath);
    try {
      return { sessions: store.sessionRepository.transaction(tx => tx.listSessions()), claims: listTaskReservations(store), admission: store.sessionRepository.transaction(tx => tx.listReservations()), pending: store.sessionRepository.transaction(tx => tx.listPending()), reminders: store.reminderRepository.transaction(tx => tx.list()) };
    } finally { store.close(); }
  };
  const seedReminder = (reminder: Reminder) => {
    const store = openStateStore(cfg.statePath);
    try { store.reminderRepository.transaction(tx => tx.save(reminder)); } finally { store.close(); }
  };
  const runners = async () => (await fs.readdir(control)).filter(name => /^runner-\d+\.pid$/.test(name)).map(name => Number(name.slice(7, -4)));
  const runDirectories = async () => (await fs.readdir(tmpRoot)).filter(name => name !== 'tmux');
  return { directory, control, tmpRoot, run, runArgs, command, as, input, inspect, seedReminder, owned, tmuxSessions, runners, runDirectories };
}

export type AgentRunFixture = Awaited<ReturnType<typeof agentRunFixture>>;

export async function assertFailedLaunchCleaned(f: AgentRunFixture, outcome: Awaited<ReturnType<AgentRunFixture['run']>>, label: string) {
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

