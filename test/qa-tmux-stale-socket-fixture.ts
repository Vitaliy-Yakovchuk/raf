import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { agentRunFixture, claudeRunnerScript, until } from './agent-run-fixture.ts';

const exec = promisify(execFile);

export const quotaRunnerScript = String.raw`
if (!process.argv.includes('--session-id') && !process.argv.includes('--version')) {
  const { readFileSync: readQuotaFile, appendFileSync: recordQuota } = await import('node:fs');
  const quotaConfig = JSON.parse(readQuotaFile(process.env.RAF_AGENT_RUN_FIXTURE, 'utf8'));
  const quotaRender = text => process.stdout.write('\x1b[2J\x1b[H' + text.replaceAll('\n', '\r\n'));
  const quotaReady = "Claude Code v" + quotaConfig.claudeVersion + "\ndon't ask on (shift+tab to cycle)\n$";
  const quotaReset = new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  quotaRender(quotaReady);
  process.stdin.setEncoding('utf8');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  let quotaInput = '';
  process.stdin.on('data', data => {
    recordQuota(quotaConfig.control + '/quota-input.log', data);
    if (data.includes('\x1b')) { quotaInput = ''; quotaRender(quotaReady); return; }
    for (const key of data) {
      if (key === '\r' || key === '\n') {
        if (quotaInput === '/exit') process.exit(0);
        if (quotaInput === '/usage') {
          recordQuota(quotaConfig.control + '/quota-panel.log', 'usage\n');
          quotaRender('Usage\nCurrent session\n10% 10% used\nResets 11:59pm (UTC)\nCurrent week (all models)\n20% 20% used\nResets ' + quotaReset + ', 11:59pm (UTC)\nEsc to cancel');
        }
        quotaInput = '';
      } else {
        quotaInput += key;
        quotaRender(quotaReady + ' ' + quotaInput);
      }
    }
  });
  await new Promise(() => {});
}
`;

export async function qaTmuxFixture(t: TestContext, mode = 'live') {
  const cleanup: Array<() => unknown> = [];
  let stopServer: () => Promise<unknown> = async () => undefined;
  t.after(async () => {
    try {
      await stopServer();
    } finally {
      for (const action of cleanup.reverse()) await action();
    }
  });
  const protocolConfiguration = JSON.parse(await fs.readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const protocol = protocolConfiguration.runnerProtocols.find((entry: { runner: string }) => entry.runner === 'claude');
  assert.ok(protocol, 'configured Claude protocol exists');
  const f = await agentRunFixture({ after: (action: () => unknown) => cleanup.push(action) }, mode, protocol.timeouts, 'claude', { productionQa: true, commands: ['runner limits'] });
  const cfg = JSON.parse(await fs.readFile(join(f.directory, 'fixture.json'), 'utf8'));
  const socket = join(f.tmpRoot, 'tmux', 'server.sock');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cfg.home, RAF_QA_HOME: cfg.home, RAF_AGENT_RUN_FIXTURE: join(f.directory, 'fixture.json'), TMPDIR: f.directory, TMUX_TMPDIR: f.directory };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const tmuxDirectory = join(f.tmpRoot, 'tmux');
  await fs.mkdir(tmuxDirectory, { recursive: true, mode: 0o700 });
  const tmuxDirectoryStat = await fs.lstat(tmuxDirectory);
  assert.equal(tmuxDirectoryStat.isDirectory(), true);
  assert.equal(tmuxDirectoryStat.mode & 0o777, 0o700, 'fixture tmux directory is private');
  assert.equal(tmuxDirectoryStat.uid, process.getuid!(), 'fixture tmux directory belongs to the current user');
  await fs.writeFile(join(f.directory, 'bin', 'tmux'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(f.control, 'tmux-argv.jsonl'))}, JSON.stringify(argv) + '\\n');
const result = spawnSync(${JSON.stringify(cfg.tmux)}, argv, { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  await fs.writeFile(join(f.directory, 'bin', 'claude'), `#!${process.execPath}\n${quotaRunnerScript}\n${claudeRunnerScript}`, { mode: 0o700 });

  async function tmux(args: string[], environment: NodeJS.ProcessEnv = env) {
    try {
      const result = await exec(cfg.tmux, ['-S', socket, ...args], { env: environment });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      if (typeof result.code !== 'number') throw error;
      return { exitCode: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
  }

  stopServer = () => tmux(['kill-server']);

  async function tmuxSessions() {
    const result = await tmux(['list-sessions', '-F', '#{session_name}']);
    if (result.exitCode === 0) return result.stdout.trim().split('\n').filter(Boolean);
    assert.match(result.stderr, /no server running|error connecting/u, JSON.stringify(result));
    return [];
  }

  async function staleSocket() {
    const result = await until(() => tmux(['show-environment', '-g', 'HOME']), value => value.exitCode !== 0, 'quota cleanup stopped the last tmux server', protocol.timeouts.transitionMs);
    assert.match(result.stderr, /no server running/u, JSON.stringify(result));
    assert.equal((await fs.lstat(socket)).isSocket(), true, 'the dead server left a real Unix socket');
    assert.deepEqual(await tmuxSessions(), []);
    return result;
  }

  async function runDirectories() {
    const quotaRoot = join(f.tmpRoot, 'quota');
    const entries = await fs.readdir(quotaRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(entries, [], 'no quota probe directories survive cleanup');
    return (await f.runDirectories()).filter(name => name !== 'quota');
  }

  return { ...f, tmuxSessions, runDirectories, tmux, staleSocket, socket, home: cfg.home as string, statePath: cfg.statePath as string, protocol };
}
