import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { prepareLiveMainInvocation } from './qa-main-symlink-fixture.ts';

const [stand, ev, commands] = process.argv.slice(2);
for (const directory of [stand, ev, commands]) assert.ok(path.isAbsolute(directory));
const root = path.join(stand, 'root'), cli = path.join(root, 'raf-main/bin/raf.ts');
const protocol = JSON.parse(fs.readFileSync(path.join(root, 'conf/raf.json'), 'utf8')).runnerProtocols.find(p => p.runner === 'claude');
const { observeRunnerScreen, nextRunnerAction, readNativeComposer, readNativeSessionId, isNativeWorking } = await import(pathToFileURL(path.join(root, 'raf-main/src/runner-protocols.ts')));
const nativeId = randomUUID();
const invocation = prepareLiveMainInvocation(protocol, process.env, nativeId);
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
process.on('uncaughtExceptionMonitor', error => atomic(path.join(ev, 'native-main-error.json'), { message: error.message, stack: error.stack, at: new Date().toISOString() }));
const run = (label, args, budget = 240000) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: path.dirname(path.dirname(cli)), env: process.env, encoding: 'utf8', timeout: budget, maxBuffer: 32 * 1024 * 1024 });
  const result = { command: [process.execPath, cli, ...args], cliExitCode: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(ev, label + '.' + stream), result[stream]);
  atomic(path.join(ev, label + '.json'), result);
  return result;
};
const socket = process.env.TMUX?.split(',')[0], pane = process.env.TMUX_PANE;
assert.ok(socket && path.isAbsolute(socket)); assert.match(pane ?? '', /^%\d+$/);
const tmux = args => {
  const r = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr); return r.stdout;
};
const version = spawnSync(invocation.executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
assert.equal(version.status, 0, version.stderr);
assert.ok(version.stdout.includes(protocol.version), 'Use the configured native protocol version');
const child = spawn(invocation.executable, invocation.args, { cwd: root, env: { ...process.env, ...invocation.env }, stdio: 'inherit' });
let exited = false, spawnError;
child.on('error', error => { spawnError = String(error); exited = true; });
child.on('exit', (code, signal) => { exited = true; atomic(path.join(ev, 'native-main-exit.json'), { code, signal, at: new Date().toISOString() }); });
const capture = label => { const screen = tmux(['capture-pane', '-p', '-t', pane]); fs.writeFileSync(path.join(ev, label + '.txt'), screen); return screen; };
const idle = async label => {
  const deadline = Date.now() + 120000;
  let navigation;
  while (Date.now() < deadline) {
    assert.equal(exited, false, spawnError ?? 'Native Claude exited before readiness');
    const screen = capture(label), observation = observeRunnerScreen(protocol, { text: screen, version: protocol.version, requestedCommand: null });
    if (observation.state === 'ready' && readNativeComposer(protocol, screen)?.input === '' && !isNativeWorking(protocol, screen)) return screen;
    if (observation.state === 'workspace_trust_required') {
      const action = nextRunnerAction(protocol, observation, { trustWorkspace: true });
      assert.equal(action.kind, 'keys', 'Only configured workspace trust navigation is allowed');
      if (navigation !== screen) { tmux(['send-keys', '-t', pane, ...action.keys]); navigation = screen; }
    } else assert.ok(!['auth_required', 'permission_required', 'quota_untrusted', 'exited'].includes(observation.state), 'Native prerequisite: ' + observation.state);
    await delay(300);
  }
  throw Error('Native Claude has no verified empty composer: ' + label);
};
await idle('native-main-startup');
const identity = protocol.native.identity;
assert.notEqual(identity.source, 'session_start');
tmux(['send-keys', '-t', pane, '-l', identity.command]); tmux(['send-keys', '-t', pane, 'Enter']);
let confirmed = false;
for (let n = 0; n < 100; n++) {
  const screen = capture('native-main-status');
  if (readNativeSessionId(protocol, screen) === nativeId) { confirmed = true; break; }
  assert.equal(exited, false); await delay(300);
}
assert.equal(confirmed, true, 'Confirm the actual native UUID through its own status UI');
tmux(['send-keys', '-t', pane, ...identity.dismissKeys]);
await idle('native-main-ready');
atomic(path.join(ev, 'native-main-identity.json'), { pid: child.pid, coordinatorPid: process.pid, nativeId, command: [invocation.executable, ...invocation.args], socket, pane, version: version.stdout.trim(), authSelectorsFromEnvironment: Object.keys(invocation.env), confirmedThroughNativeStatus: true });
const attached = run('main-attach', ['main', 'attach']);
atomic(path.join(ev, 'main-ready.json'), attached);
assert.equal(attached.cliExitCode, 0, attached.stderr);
while (!exited) {
  for (const name of fs.readdirSync(commands).filter(x => x.endsWith('.json')).sort()) {
    const file = path.join(commands, name), request = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.renameSync(file, file + '.running');
    run(request.label, request.args, request.budget);
    fs.renameSync(file + '.running', file + '.done');
  }
  await delay(100);
}
throw Error(spawnError ?? 'Native Claude main recipient exited');
