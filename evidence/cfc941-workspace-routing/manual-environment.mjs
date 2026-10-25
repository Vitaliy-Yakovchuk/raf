import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { release } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const output = resolve(import.meta.dirname);
const root = mkdtempSync('/tmp/cfc941-native-');
const home = join(root, 'home'); mkdirSync(home);
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: join(home, '.config'), TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C', TMPDIR: root };
const record = { runId: randomUUID(), root, scope: 'Real tool availability and native CLI startup only; no model request, no brief delivery or trust acceptance', os: release(), node: process.version, sqlite: process.versions.sqlite, commands: [], cleanup: { complete: false } };
const run = (label, executable, args, cwd = root) => {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const value = { label, executable, args, cwd, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  record.commands.push(value); return value;
};
for (const p of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.XDG_CONFIG_HOME]) mkdirSync(p, { recursive: true });
const socket = join(root, 'tmux.sock'); let server = false;
try {
  record.sha = run('workspace-sha', 'git', ['rev-parse', 'HEAD'], resolve(output, '../..')).stdout.trim();
  record.workspace = run('workspace-status', 'git', ['status', '--porcelain=v1'], resolve(output, '../..')).stdout;
  for (const [name, args] of [['git', ['--version']], ['tmux', ['-V']], ['codex', ['--version']], ['claude', ['--version']], ['bwrap', ['--version']]]) run('version-' + name, name, args);
  record.priorBwrapCapability = 'manual-environment.json#commands/native-bwrap-capability';
  const started = run('tmux-create', 'tmux', ['-S', socket, 'new-session', '-d', '-s', 'cfc941', '-x', '140', '-y', '42', '-c', root, 'sleep 30']);
  server = started.exitCode === 0;
  if (server) {
    run('tmux-retain-exit', 'tmux', ['-S', socket, 'set-window-option', '-g', 'remain-on-exit', 'on']);
    run('tmux-fixed-shell', 'tmux', ['-S', socket, 'set-option', '-g', 'default-shell', '/bin/bash']);
    for (const runner of ['codex', 'claude']) {
      const cwd = join(root, runner); mkdirSync(cwd);
      run('git-init-' + runner, 'git', ['init', '-q', '-b', 'develop'], cwd);
      const args = runner === 'codex' ? ['codex', '--no-alt-screen'] : ['claude', '--ax-screen-reader'];
      const launched = run('native-start-' + runner, 'tmux', ['-S', socket, 'new-window', '-d', '-t', 'cfc941', '-n', runner, '-c', cwd, ...args]);
      if (launched.exitCode === 0) {
        await delay(3000);
        run('native-screen-' + runner, 'tmux', ['-S', socket, 'capture-pane', '-p', '-S', '-', '-t', 'cfc941:' + runner]);
        run('native-exit-' + runner, 'tmux', ['-S', socket, 'display-message', '-p', '-t', 'cfc941:' + runner, '#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}']);
        run('native-stop-' + runner, 'tmux', ['-S', socket, 'kill-window', '-t', 'cfc941:' + runner]);
      }
    }
  }
  record.portPrerequisite = { available: false, path: '/tmp/raf-ipc-1000', reason: 'Explicit denied filesystem path in this assignment. Production createRafTemporarySocketEndpoint always uses this root; it was not accessed or replaced.' };
  record.source = createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex');
} finally {
  if (server) run('tmux-cleanup', 'tmux', ['-S', socket, 'kill-server']);
  rmSync(root, { recursive: true, force: true });
  record.cleanup = { complete: !existsSync(root), fixtureRemoved: !existsSync(root), tmuxStopped: !server || record.commands.findLast(row => row.label === 'tmux-cleanup')?.exitCode === 0 };
  writeFileSync(join(output, 'manual-environment-corrected.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ evidence: join(output, 'manual-environment-corrected.json'), commands: record.commands.map(({ label, exitCode, error }) => ({ label, exitCode, error })), cleanup: record.cleanup }));
  assert.equal(record.cleanup.complete, true);
}
