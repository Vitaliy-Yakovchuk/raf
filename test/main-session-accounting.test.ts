import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildCatalog } from '../src/bootstrap.ts';
import { openStateStore } from '../src/state-store.ts';
import { sendSystemMessageToMain, NotImplementedError, type MainSessionContext } from '../src/main-session.ts';
import type { ProcessIdentity, SessionLaunchContext, SessionRecord } from '../src/session-state.ts';

const readConf = (name: string) => JSON.parse(readFileSync(new URL(`../../conf/${name}`, import.meta.url), 'utf8'));
const constants = readConf('raf-constants.json');
const models = readConf('models.json');
const settings = readConf('raf.json');
const confFiles = ['raf.json', 'models.json', 'raf-constants.json', 'projects.json'];
const runnerIds: string[] = models.runners.map((runner: { id: string }) => runner.id);
const genericFailures = ['COMMAND_UNAVAILABLE', 'PRODUCTION_ENTRY_FAILED'];
const currentBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const tmuxBinary = (() => {
  const found = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' });
  assert.equal(found.status, 0, 'isolated tests require a tmux binary');
  return found.stdout.trim();
})();

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

type CliResult = { exitCode: number; stdout: string; stderr: string };
type Actor = { name: string; session: string; paneId: string; pid: number; queue: string; next: number };
type Fixture = Awaited<ReturnType<typeof fixture>>;

function writeStub(directory: string, name: string, log: string) {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 97\n`);
  chmodSync(path, 0o755);
}

function processesMentioning(text: string): string[] {
  const found = spawnSync('pgrep', ['-a', '-f', '--', text], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim().split('\n').filter(Boolean) : [];
}

async function fixture(t: { after(action: () => Promise<void>): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-main-attach-'));
  const root = join(directory, 'orchestrator');
  const checkout = join(root, 'raf');
  const home = join(directory, 'home');
  const tmuxTmp = join(directory, 'tmux-tmp');
  const stubs = join(directory, 'stubs');
  const sentinels = join(directory, 'sentinels');
  const stubLog = join(directory, 'stubs.log');
  for (const path of [join(root, 'conf'), join(checkout, 'bin'), home, stubs, sentinels]) mkdirSync(path, { recursive: true });
  mkdirSync(tmuxTmp, { mode: 0o700 });
  for (const name of confFiles) cpSync(new URL(`../../conf/${name}`, import.meta.url), join(root, 'conf', name));
  cpSync(new URL('../src', import.meta.url), join(checkout, 'src'), { recursive: true });
  cpSync(new URL('../bin/raf.ts', import.meta.url), join(checkout, 'bin', 'raf.ts'));
  writeFileSync(join(checkout, 'package.json'), '{"type":"module"}');
  const artifactPath = join(checkout, 'dist', 'catalog.json');
  buildCatalog(join(root, 'conf'), artifactPath, constants.commands.map((command: { path: string[] }) => command.path.join(' ')));
  writeFileSync(stubLog, '');
  for (const name of ['openspec', ...runnerIds]) writeStub(stubs, name, stubLog);
  for (const name of ['tmux', 'openspec', ...runnerIds]) writeStub(sentinels, name, stubLog);
  const bin = join(checkout, 'bin', 'raf.ts');
  const socketName = `raf-main-attach-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const socketPath = join(tmuxTmp, `tmux-${process.getuid!()}`, socketName);
  const env: Record<string, string> = { HOME: home, LANG: 'C.UTF-8', TMUX_TMPDIR: tmuxTmp, PATH: `${stubs}:${dirname(tmuxBinary)}:/usr/bin:/bin` };
  const tmux = (args: string[]) => spawnSync(tmuxBinary, ['-L', socketName, ...args], { encoding: 'utf8', env });
  const ownTmuxSocket = join(home, '.raf', 'tmp', 'tmux', 'server.sock');
  t.after(async () => {
    tmux(['kill-server']);
    if (existsSync(ownTmuxSocket)) spawnSync(tmuxBinary, ['-S', ownTmuxSocket, 'kill-server'], { env });
    const survivors = () => [...processesMentioning(directory), ...processesMentioning(socketName)];
    let leftovers = survivors();
    for (let waited = 0; leftovers.length && waited < 5_000; waited += 100) { await pause(100); leftovers = survivors(); }
    for (const line of leftovers) spawnSync('kill', ['-KILL', line.split(' ')[0]]);
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(leftovers, [], 'no tmux server or process of the fixture may survive the test');
  });
  const workerScript = join(directory, 'worker.sh');
  writeFileSync(workerScript, [
    'queue="$1"',
    'i=0',
    'while :; do',
    '  if [ -e "$queue/req-$i.sh" ]; then',
    '    sh "$queue/req-$i.sh" </dev/null >"$queue/out-$i" 2>"$queue/err-$i"',
    '    echo "$?" >"$queue/code-$i.tmp"',
    '    mv "$queue/code-$i.tmp" "$queue/code-$i"',
    '    i=$((i+1))',
    '  fi',
    '  sleep 0.1',
    'done',
  ].join('\n'));
  const context: MainSessionContext = { orchestratorRoot: root, homeDirectory: home, artifactPath };
  return {
    directory, root, home, bin, env, tmux, socketName, socketPath, stubLog, sentinels, workerScript, context, ownTmuxSocket,
    statePath: join(home, '.raf', settings.state.fileName),
  };
}

function cli(f: Fixture, argv: readonly string[], extraEnv: Record<string, string> = {}): CliResult {
  const result = spawnSync(process.execPath, [f.bin, ...argv], { cwd: f.directory, encoding: 'utf8', env: { ...f.env, ...extraEnv }, timeout: 60_000, killSignal: 'SIGKILL' });
  assert.equal(result.signal, null, `raf ${argv.join(' ')} must finish before the deadline`);
  return { exitCode: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function success(result: CliResult): unknown {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function failure(result: CliResult): Record<string, any> {
  assert.notEqual(result.exitCode, 0, result.stdout);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(typeof error.code, 'string');
  assert.ok(!genericFailures.includes(error.code), `rejection must come from the command itself: ${result.stderr}`);
  assert.ok(String(error.message).length > 0);
  assert.ok(Array.isArray(error.remediation) && error.remediation.length > 0, result.stderr);
  return error;
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(records)];
}

function leaves(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(leaves);
  return value === null || value === undefined ? [] : [String(value)];
}

function launchActor(f: Fixture, name: string, place: { session: string } | { besidePane: string }): Actor {
  const queue = join(f.directory, `queue-${name}`);
  mkdirSync(queue);
  const command = ['sh', f.workerScript, queue];
  const created = 'besidePane' in place
    ? f.tmux(['new-window', '-d', '-a', '-t', paneValue(f, place.besidePane, '#{window_id}'), '-P', '-F', '#{pane_id}', ...command])
    : f.tmux(['new-session', '-d', '-s', place.session, '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}', ...command]);
  assert.equal(created.status, 0, created.stderr);
  const paneId = created.stdout.trim();
  const pid = Number(paneValue(f, paneId, '#{pane_pid}'));
  assert.ok(Number.isInteger(pid) && pid > 0);
  return { name, session: paneValue(f, paneId, '#{session_name}'), paneId, pid, queue, next: 0 };
}

function paneValue(f: Fixture, paneId: string, format: string): string {
  const result = f.tmux(['display-message', '-p', '-t', paneId, format]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function runIn(f: Fixture, actor: Actor, argv: readonly string[]): Promise<CliResult> {
  const index = actor.next++;
  const script = join(actor.queue, `req-${index}.sh`);
  writeFileSync(`${script}.tmp`, `cd ${quote(f.directory)}\nexec ${[process.execPath, f.bin, ...argv].map(quote).join(' ')}\n`);
  renameSync(`${script}.tmp`, script);
  const code = join(actor.queue, `code-${index}`);
  for (let waited = 0; waited < 60_000; waited += 100) {
    if (existsSync(code)) {
      return {
        exitCode: Number(readFileSync(code, 'utf8').trim()),
        stdout: readFileSync(join(actor.queue, `out-${index}`), 'utf8').trim(),
        stderr: readFileSync(join(actor.queue, `err-${index}`), 'utf8').trim(),
      };
    }
    await pause(100);
  }
  assert.fail(`pane ${actor.name} did not finish raf ${argv.join(' ')}`);
}

function capture(f: Fixture, actor: Actor): string {
  const result = f.tmux(['capture-pane', '-p', '-J', '-S', '-200', '-t', actor.paneId]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function waitForPane(f: Fixture, actor: Actor, expected: string): Promise<string> {
  let text = '';
  for (let waited = 0; waited < 5_000; waited += 100) {
    text = capture(f, actor);
    if (text.includes(expected)) return text;
    await pause(100);
  }
  return text;
}

function sessions(f: Fixture): SessionRecord[] {
  if (!existsSync(f.statePath)) return [];
  const store = openStateStore(f.statePath);
  try { return store.sessionRepository.transaction(tx => tx.listSessions()); }
  finally { store.close(); }
}

const activeMain = (f: Fixture) => sessions(f).filter(row => row.addressId === 'main' && row.state !== 'finished' && row.state !== 'exited');

function seedSession(f: Fixture, session: SessionRecord) {
  const store = openStateStore(f.statePath);
  try { store.sessionRepository.transaction(tx => tx.putSession(session)); }
  finally { store.close(); }
}

function identityOf(f: Fixture, actor: Actor): ProcessIdentity {
  const result = spawnSync('ps', ['-ww', '-o', 'lstart=,command=', '-p', String(actor.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  assert.ok(match, result.stdout);
  return { pid: actor.pid, startedAt: new Date(match[1].replace(/\s+/g, ' ')).toISOString(), runner: runnerIds[0], runnerSessionId: `fixture-${actor.name}`, tmuxSession: actor.session, evidence: { command: match[2], tmuxSocket: f.socketPath } };
}

async function initializeState(f: Fixture) {
  success(cli(f, ['runner', 'list']));
  assert.ok(existsSync(f.statePath));
  writeFileSync(f.stubLog, '');
}

async function startAgent(f: Fixture, addressId: string, launchContext?: SessionLaunchContext): Promise<Actor> {
  const actor = launchActor(f, addressId, { session: `agent-${addressId}` });
  await pause(200);
  seedSession(f, {
    runId: `run-${addressId}`, addressId, revision: 0, state: 'running',
    activity: { type: 'hotfix', project: 'raf', features: ['main-accounting'], phase: 'hotfix', cwd: f.root },
    process: identityOf(f, actor),
    ...(launchContext ? { launchContext } : {}),
  });
  return actor;
}

async function startMainPane(f: Fixture, session = 'main'): Promise<{ decoy: Actor; main: Actor }> {
  const decoy = launchActor(f, 'main-decoy', { session });
  const main = launchActor(f, 'main-pane', { besidePane: decoy.paneId });
  await pause(200);
  return { decoy, main };
}

async function attach(f: Fixture, actor: Actor): Promise<unknown> {
  return success(await runIn(f, actor, ['main', 'attach']));
}

function assertDescribesPane(f: Fixture, output: unknown, actor: Actor) {
  const values = leaves(output);
  assert.ok(values.includes('main'), `attach output must name the address main: ${JSON.stringify(output)}`);
  for (const expected of [paneValue(f, actor.paneId, '#{socket_path}'), actor.session, actor.paneId, String(actor.pid), currentBootId]) {
    assert.ok(values.includes(expected), `attach output must contain ${expected}: ${JSON.stringify(output)}`);
  }
}

function listedMain(f: Fixture): Record<string, unknown>[] {
  return records(success(cli(f, ['agent', 'ps']))).filter(row => row.addressId === 'main');
}

function replaceEverywhere(path: string, from: string, to: string): number {
  const db = new DatabaseSync(path);
  let changed = 0;
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
      for (const column of columns) {
        changed += Number(db.prepare(`UPDATE "${name}" SET "${column.name}" = replace("${column.name}", ?, ?) WHERE typeof("${column.name}") = 'text' AND instr("${column.name}", ?) > 0`).run(from, to, from).changes);
      }
    }
  } finally { db.close(); }
  return changed;
}

const runArguments = (id: string, type: string) => ['agent', 'run', '--id', id, '--type', type, '--project', 'raf', '--features', 'main-accounting', '--phase', 'hotfix', '--complexity', models.routing.complexityOrder[0], '--tasks', 'add-raf-agent-run:1.1'];

for (const [label, argv, code] of [
  ['type main', runArguments('main-attempt', 'main'), 'TYPE_NOT_LAUNCHABLE'],
  ['address main with type hotfix', runArguments('main', 'hotfix'), null],
  ['address main with type test-scaffold', runArguments('main', 'test-scaffold'), null],
] as const) {
  test(`agent run rejects ${label} before any tmux, OpenSpec or runner process`, { timeout: 120_000 }, async t => {
    const f = await fixture(t);
    await initializeState(f);
    const result = cli(f, argv, { PATH: `${f.sentinels}:/usr/bin:/bin` });
    const error = failure(result);
    if (code) {
      assert.equal(error.code, code);
      assert.equal(error.details.received, 'main');
    }
    assert.equal(readFileSync(f.stubLog, 'utf8'), '', 'no external command may run before the main address is rejected');
    assert.match(result.stderr, /main/);
    assert.deepEqual(sessions(f), []);
    assert.ok(!existsSync(f.ownTmuxSocket));
  });
}

test('raf main attach registers the calling tmux pane as main without starting processes', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  const panesBefore = f.tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}']).stdout;
  const output = await attach(f, main);
  assertDescribesPane(f, output, main);
  const registered = activeMain(f);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].state, 'running');
  assert.equal(registered[0].process?.pid, main.pid);
  assert.equal(registered[0].activity?.type, 'main');
  assert.equal(f.tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}']).stdout, panesBefore);
  assert.equal(readFileSync(f.stubLog, 'utf8'), '');
  assert.ok(!existsSync(f.ownTmuxSocket), 'attach must not start a raf tmux server');
});

test('repeated raf main attach from the registered pane is idempotent', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  const first = await attach(f, main);
  const stored = sessions(f);
  const second = await attach(f, main);
  assert.deepEqual(second, first);
  assert.deepEqual(sessions(f), stored);
  assert.equal(activeMain(f).length, 1);
});

test('raf main attach from another pane is refused while the registered main is alive', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  await attach(f, main);
  const stored = sessions(f);
  const intruder = launchActor(f, 'intruder', { session: 'other' });
  await pause(200);
  const result = await runIn(f, intruder, ['main', 'attach']);
  failure(result);
  assert.ok(result.stderr.includes(main.paneId) || result.stderr.includes(String(main.pid)), `diagnostic must identify the live main: ${result.stderr}`);
  assert.deepEqual(sessions(f), stored);
});

test('raf main attach is allowed from a new pane after the registered main process died', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  await attach(f, main);
  process.kill(main.pid, 'SIGKILL');
  await pause(500);
  const successor = launchActor(f, 'successor', { session: 'main-next' });
  await pause(200);
  const output = await attach(f, successor);
  assertDescribesPane(f, output, successor);
  const active = activeMain(f);
  assert.equal(active.length, 1);
  assert.equal(active[0].addressId, 'main');
  assert.equal(active[0].process?.pid, successor.pid);
});

test('raf main attach is allowed from a new pane after the boot identity of the registered main changed', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  await attach(f, main);
  assert.ok(replaceEverywhere(f.statePath, currentBootId, '00000000-0000-4000-8000-000000000000') > 0, 'main registration must persist the boot identity');
  const successor = launchActor(f, 'successor', { session: 'main-next' });
  await pause(200);
  await attach(f, successor);
  const active = activeMain(f);
  assert.equal(active.length, 1);
  assert.equal(active[0].process?.pid, successor.pid);
  const agent = await startAgent(f, 'hotfix-a1');
  success(await runIn(f, agent, ['agent', 'message', '--to', 'main', '--text', 'after reboot']));
  assert.match(await waitForPane(f, successor, '[hotfix-a1] after reboot'), /\[hotfix-a1\] after reboot/);
  assert.doesNotMatch(capture(f, main), /after reboot/);
});

test('raf main attach outside tmux or with forged tmux variables is refused and registers nothing', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  const outside = failure(cli(f, ['main', 'attach']));
  assert.match(JSON.stringify(outside), /tmux/);
  const forged = { TMUX: `${f.socketPath},${paneValue(f, main.paneId, '#{pid}')},0`, TMUX_PANE: main.paneId };
  failure(cli(f, ['main', 'attach'], forged));
  assert.deepEqual(activeMain(f), []);
  assert.deepEqual(listedMain(f), []);
  await attach(f, main);
  assert.equal(activeMain(f).length, 1);
});

test('agent ps lists main with type main and its pane while the pane process lives', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  await attach(f, main);
  const listed = listedMain(f);
  assert.equal(listed.length, 1);
  assert.equal((listed[0].activity as Record<string, unknown>).type, 'main');
  const values = leaves(listed[0]);
  assert.ok(values.includes(main.paneId) || values.includes(String(main.pid)), JSON.stringify(listed[0]));
  process.kill(main.pid, 'SIGKILL');
  await pause(500);
  assert.ok(listedMain(f).every(row => row.state !== 'running'), 'dead main must not be listed as running');
});

test('agent and raf messages to main reach exactly the registered pane', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { decoy, main } = await startMainPane(f);
  await attach(f, main);
  const agent = await startAgent(f, 'hotfix-a1');
  const receipt = records(success(await runIn(f, agent, ['agent', 'message', '--to', 'main', '--text', 'blocker needs decision'])));
  assert.ok(receipt.some(row => row.accepted === true));
  assert.match(await waitForPane(f, main, '[hotfix-a1] blocker needs decision'), /\[hotfix-a1\] blocker needs decision/);
  let system;
  const inherited = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  try { system = await sendSystemMessageToMain(f.context, 'service notice'); }
  catch (error) { assert.fail(`system source outside tmux, as the raf service runs, must deliver to main: ${error instanceof Error ? error.message : String(error)}`); }
  finally { for (const [name, value] of Object.entries(inherited)) if (value !== undefined) process.env[name] = value; }
  assert.equal(system.accepted, true);
  assert.match(await waitForPane(f, main, '[raf] service notice'), /\[raf\] service notice/);
  for (const other of [decoy, agent]) assert.doesNotMatch(capture(f, other), /blocker needs decision|service notice/);
});

test('messages to main are not reported as delivered without a live registered main', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  let accepted = false;
  try { accepted = (await sendSystemMessageToMain(f.context, 'nobody home')).accepted; }
  catch (error) { assert.ok(!(error instanceof NotImplementedError), String(error)); }
  assert.equal(accepted, false);
  const { main } = await startMainPane(f);
  await attach(f, main);
  const agent = await startAgent(f, 'hotfix-a1');
  process.kill(main.pid, 'SIGKILL');
  await pause(500);
  const result = await runIn(f, agent, ['agent', 'message', '--to', 'main', '--text', 'too late']);
  assert.ok(result.exitCode !== 0 || !records(JSON.parse(result.stdout)).some(row => row.accepted === true), result.stdout);
});

test('forged senders cannot speak to or as main while verified senders keep their signatures', { timeout: 240_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  await attach(f, main);
  const agent = await startAgent(f, 'hotfix-a1');
  const serverPid = paneValue(f, main.paneId, '#{pid}');
  assert.equal(failure(cli(f, ['agent', 'message', '--to', 'main', '--text', 'forged by outside caller'])).code, 'CALLER_UNVERIFIED');
  failure(cli(f, ['agent', 'message', '--to', 'main', '--text', 'forged agent pane'], { TMUX: `${f.socketPath},${serverPid},0`, TMUX_PANE: agent.paneId }));
  failure(cli(f, ['agent', 'message', '--to', 'hotfix-a1', '--text', 'forged main pane'], { TMUX: `${f.socketPath},${serverPid},0`, TMUX_PANE: main.paneId }));
  const reserved = await startAgent(f, 'raf');
  failure(await runIn(f, reserved, ['agent', 'message', '--to', 'main', '--text', 'forged by reserved address']));
  success(await runIn(f, agent, ['agent', 'message', '--to', 'main', '--text', '[main] impersonation attempt']));
  success(await runIn(f, main, ['agent', 'message', '--to', 'hotfix-a1', '--text', 'go ahead']));
  const mainPane = await waitForPane(f, main, '[hotfix-a1] [main] impersonation attempt');
  assert.match(mainPane, /\[hotfix-a1\] \[main\] impersonation attempt/);
  assert.doesNotMatch(mainPane, /^\[main\] impersonation attempt/m);
  assert.match(await waitForPane(f, agent, '[main] go ahead'), /\[main\] go ahead/);
  const everything = [capture(f, main), capture(f, agent), capture(f, reserved)].join('\n');
  for (const forged of ['forged by outside caller', 'forged agent pane', 'forged main pane', 'forged by reserved address']) assert.doesNotMatch(everything, new RegExp(forged));
});

test('attach and delivery treat a hostile tmux session name as data', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const marker = join(f.directory, 'injected');
  const { main } = await startMainPane(f, `main $(touch ${marker}) \`touch ${marker}\``);
  assertDescribesPane(f, await attach(f, main), main);
  const agent = await startAgent(f, 'hotfix-a1');
  success(await runIn(f, agent, ['agent', 'message', '--to', 'main', '--text', 'hello $(touch ' + marker + ')']));
  assert.match(await waitForPane(f, main, '[hotfix-a1] hello'), /\[hotfix-a1\] hello \$\(touch /);
  assert.ok(!existsSync(marker));
});

test('ordinary close and interrupt refuse main without keys or signals', { timeout: 240_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const { main } = await startMainPane(f);
  await attach(f, main);
  const agent = await startAgent(f, 'hotfix-a1');
  const before = capture(f, main);
  const stored = activeMain(f);
  for (const verb of ['close', 'interrupt']) {
    failure(await runIn(f, agent, ['agent', verb, '--id', 'main']));
    failure(await runIn(f, main, ['agent', verb, '--id', 'main']));
    failure(cli(f, ['agent', verb, '--id', 'main']));
  }
  await pause(500);
  assert.doesNotThrow(() => process.kill(main.pid, 0));
  assert.equal(Number(paneValue(f, main.paneId, '#{pane_pid}')), main.pid);
  assert.equal(capture(f, main), before);
  assert.deepEqual(activeMain(f), stored);
  assert.equal(listedMain(f).length, 1);
});

test('assignment snapshot is kept and agent update accepts a configured project', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await initializeState(f);
  const change = join(f.root, 'openspec', 'changes', 'fixture-change');
  mkdirSync(change, { recursive: true });
  const tasks = join(change, 'tasks.md');
  writeFileSync(tasks, '## 1. Fixture\n\n- [ ] 1.1 First item\n- [ ] 1.2 Assigned item\n- [ ] 1.3 Later item\n');
  const reports = join(f.directory, 'reports');
  mkdirSync(reports);
  const briefPath = join(reports, 'hotfix-a1.brief.md');
  const reportPath = join(reports, 'hotfix-a1.json');
  const briefText = '# Конкретне доручення\n\nfixture-change 1.2 Assigned item\n';
  writeFileSync(briefPath, briefText);
  const launchContext: SessionLaunchContext = {
    assignment: { root: f.root, changes: [{ id: 'fixture-change', items: [{ id: '1.2', description: 'Assigned item' }] }], baselineArchives: [] },
    selection: { runner: runnerIds[0], model: 'fixture-model', effort: 'low', reason: 'fixture' },
    briefPath, reportPath,
  };
  const agent = await startAgent(f, 'hotfix-a1', launchContext);
  writeFileSync(tasks, '## 1. Fixture\n\n- [x] 1.1 Assigned item renumbered\n- [ ] 1.2 Replacement item\n');
  const update = await runIn(f, agent, ['agent', 'update', '--id', 'hotfix-a1', '--project', 'raf', '--features', 'main-accounting', 'follow-up', '--phase', 'qa']);
  assert.doesNotMatch(update.stderr, /Unknown project|UNKNOWN_PROJECT/);
  success(cli(f, ['agent', 'ps']));
  const stored = sessions(f).find(row => row.addressId === 'hotfix-a1');
  assert.ok(stored);
  assert.deepEqual(stored.launchContext, launchContext);
  assert.equal(readFileSync(briefPath, 'utf8'), briefText);
  assert.ok(!existsSync(reportPath));
  assert.deepEqual(readdirSync(reports), ['hotfix-a1.brief.md']);
  success(update);
  const updated = sessions(f).find(row => row.addressId === 'hotfix-a1');
  assert.equal(updated?.activity?.phase, 'qa');
  assert.deepEqual(updated?.launchContext, launchContext);
});
