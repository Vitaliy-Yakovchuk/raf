import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
const base = fs.mkdtempSync('/tmp/cfc24-live-');
const results = [];
for (const runner of ['codex', 'claude']) {
  const directory = path.join(base, runner); fs.mkdirSync(directory);
  const home = path.join(directory, 'home'); fs.mkdirSync(home);
  const socket = path.join(directory, 'tmux.sock');
  const env = { PATH: process.env.PATH, HOME: home, RAF_QA_HOME: home, TMPDIR: directory, TERM: 'xterm-256color', LANG: 'C.UTF-8', TZ: 'UTC' };
  const invoke = args => spawnSync('tmux', ['-S', socket, ...args], { env, cwd: directory, encoding: 'utf8' });
  const started = invoke(['-f', '/dev/null', 'new-session', '-d', '-s', 'native', '-x', '160', '-y', '40', runner, ...(runner === 'codex' ? ['--no-alt-screen'] : [])]);
  let pid, screen, identity;
  try {
    assert.equal(started.status, 0, started.stderr);
    identity = invoke(['display-message', '-p', '-t', 'native:0.0', '#{pane_id}|#{pane_pid}']).stdout.trim();
    pid = Number(identity.split('|')[1]);
    await delay(3000);
    screen = invoke(['capture-pane', '-p', '-t', 'native:0.0']);
  } finally {
    const stopped = invoke(['kill-server']);
    for (let i = 0; pid && fs.existsSync('/proc/' + pid + '/stat') && !/\) [ZX] /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')) && i < 100; i++) await delay(20);
    const remaining = pid && fs.existsSync('/proc/' + pid + '/stat') && !/\) [ZX] /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'));
    results.push({ runner, directory, home, socket, command: [runner, ...(runner === 'codex' ? ['--no-alt-screen'] : [])],
      started: { cliExitCode: started.status, stdout: started.stdout, stderr: started.stderr }, identity,
      screen: screen && { cliExitCode: screen.status, stdout: screen.stdout, stderr: screen.stderr },
      briefDelivered: false, nativeIdVerified: false, childExitCode: null,
      cleanup: { cliExitCode: stopped.status, stdout: stopped.stdout, stderr: stopped.stderr, remainingPids: remaining ? [pid] : [] },
      claim: 'Startup observation in own credential-free HOME only; no raf launch, readiness or task completion claim.' });
    assert.equal(remaining, false);
  }
}
fs.writeFileSync(path.join(output, 'native-startup.json'), JSON.stringify({ base, results }, null, 2) + '\n');
