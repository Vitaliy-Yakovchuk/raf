import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { TmuxAgentAdapter, type AdapterCommand, type AdapterCommandExecutor, type AgentRunner, type RunnerProtocol } from '../src/agent-adapters.ts';

const root = await mkdtemp(join(tmpdir(), 'raf-worker-idle-'));
const socket = join(root, 'tmux.sock');
const environment = { ...process.env, HOME: root, RAF_QA_HOME: root };
const pids = new Set<number>();
const commands: AdapterCommand[] = [];
let delayStatus = false;
const execute: AdapterCommandExecutor = command => new Promise((resolve, reject) => {
  commands.push(command);
  const child = spawn(command.executable, command.executable === 'tmux' ? ['-S', socket, ...command.args] : [...command.args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid) pids.add(child.pid);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  child.once('error', reject);
  child.once('close', async code => {
    if (child.pid) pids.delete(child.pid);
    if (delayStatus && command.args[0] === 'display-message') { delayStatus = false; await delay(250); }
    resolve({ exitCode: code ?? 1, stdout, stderr });
  });
});
const protocol: RunnerProtocol = { invocation: () => ({ executable: 'sh', args: [] }), observe: () => ({ status: 'starting' }) };
const adapter = new TmuxAgentAdapter({ execute, protocols: Object.fromEntries(['codex', 'grok', 'agy', 'claude'].map(runner => [runner, protocol])) as Record<AgentRunner, RunnerProtocol> });
const session = { tmuxSession: 'worker-idle', selection: { runner: 'codex' as const, model: 'fixture', effort: 'fixture' } };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const scenarios: Record<string, unknown>[] = [];
let watchdogFired = false;
const watchdog = setTimeout(() => {
  watchdogFired = true;
  for (const pid of pids) process.kill(pid, 'SIGKILL');
  void execute({ executable: 'tmux', args: ['kill-server'] });
}, 10000);
async function start(command: string) {
  const result = await execute({ executable: 'tmux', args: ['new-session', '-d', '-s', session.tmuxSession, 'sh', '-c', 'read -r _', ';', 'set-option', '-p', '-t', `=${session.tmuxSession}:0.0`, 'remain-on-exit', 'on', ';', 'respawn-pane', '-k', '-t', `=${session.tmuxSession}:0.0`, 'sh', '-c', command] });
  assert.equal(result.exitCode, 0, result.stderr);
}
try {
  for (const scenario of ['normal-exit', 'already-exited', 'exit-before-wait', 'session-removed', 'server-stopped']) {
    await start(scenario === 'already-exited' ? 'exit 17' : scenario === 'exit-before-wait' ? 'sleep 0.1; exit 19' : 'sleep 1; exit 23');
    await execute({ executable: 'tmux', args: ['set-hook', '-t', `=${session.tmuxSession}:0.0`, 'pane-died[0]', 'set-option @fixture-hook preserved'] });
    delayStatus = scenario === 'exit-before-wait';
    if (scenario === 'already-exited') await delay(50);
    const before = commands.length;
    const waiting = adapter.waitForExit(session);
    if (scenario === 'session-removed' || scenario === 'server-stopped') {
      await delay(100);
      await execute({ executable: 'tmux', args: scenario === 'server-stopped' ? ['kill-server'] : ['kill-session', '-t', `=${session.tmuxSession}`] });
    }
    const result = await waiting;
    assert.deepEqual(result, { code: scenario === 'normal-exit' ? 23 : scenario === 'already-exited' ? 17 : scenario === 'exit-before-wait' ? 19 : null, signal: null });
    const observed = commands.slice(before);
    assert.ok(observed.length <= 12, `bounded command count: ${observed.length}`);
    assert.equal(observed.filter(command => command.args.includes('capture-pane')).length, 0);
    const hookScopes = await Promise.all([[], ['-w'], ['-p']].map(scope => execute({ executable: 'tmux', args: ['show-hooks', ...scope, '-t', `=${session.tmuxSession}:0.0`] })));
    const hooks = hookScopes.map(result => result.stdout).join('\n');
    assert.ok(!hooks.includes('raf-exit-'), 'own hooks removed');
    if (hookScopes.some(result => result.exitCode === 0)) assert.ok(hooks.includes('@fixture-hook'), `preexisting hooks preserved: ${hooks}`);
    scenarios.push({ scenario, result, commandCount: observed.length, captureCount: 0 });
    await execute({ executable: 'tmux', args: ['kill-server'] });
  }
  assert.equal(watchdogFired, false);
} finally {
  clearTimeout(watchdog);
  await execute({ executable: 'tmux', args: ['kill-server'] });
  for (const pid of pids) process.kill(pid, 'SIGKILL');
  await rm(root, { recursive: true, force: true });
}
assert.equal(pids.size, 0);
console.log(JSON.stringify({ scenarios, watchdogFired, cleanup: { complete: true, remainingPids: [...pids] } }));
