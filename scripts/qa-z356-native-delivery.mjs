import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readNativeComposer, readNativeSessionId, observeRunnerScreen, matchPendingBrief, nativeDeliveryContext, matchesNativeDeliveryContext, isNativeWorking } from '../src/runner-protocols.ts';
import { deliveryDiagnostic } from '../src/delivery-diagnostic.ts';
import { codexPastedBriefFixture } from '../test/codex-pasted-brief-fixture.ts';

const destination = path.resolve(process.argv[2]);
const settings = JSON.parse(fs.readFileSync('/srv/dev/work/orchestrator/conf/raf.json', 'utf8')).runnerProtocols.find(value => value.runner === 'codex');
const sourceHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const base = fs.mkdtempSync('/tmp/z356-');
fs.chmodSync(base, 0o700);
const home = path.join(base, 'home');
const codexHome = fs.mkdtempSync(path.join(process.argv[3], 'z356-native-codex-'));
fs.mkdirSync(home, { mode: 0o700 });
fs.chmodSync(codexHome, 0o700);
for (const name of ['auth.json', 'config.toml']) {
  if (fs.existsSync(path.join(sourceHome, name))) {
    fs.copyFileSync(path.join(sourceHome, name), path.join(codexHome, name));
    fs.chmodSync(path.join(codexHome, name), 0o600);
  }
}
const socket = path.join(base, 'tmux.sock');
const environment = { ...process.env, HOME: home, RAF_QA_HOME: home, CODEX_HOME: codexHome, TMUX_TMPDIR: base, TMPDIR: base, TERM: 'xterm-256color' };
delete environment.TMUX;
delete environment.TMUX_PANE;
const cwd = process.cwd();
const invoke = args => {
  const result = spawnSync('tmux', ['-S', socket, ...args], { cwd, env: environment, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Own tmux ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
};
const evidence = {
  startedAt: new Date().toISOString(), cwd, base, version: spawnSync('codex', ['--version'], { env: environment, encoding: 'utf8' }).stdout.trim(),
  selection: { model: 'gpt-6.1-sol', effort: 'high', source: 'Historical Z.356 live reproducer selection; this does not alter the executor selection' },
  scope: 'Direct native Codex with production protocol helpers; no raf CLI/worker/state/report acceptance claim',
  timeouts: settings.timeouts, cases: [], cleanup: null,
};
const pids = [];
try {
  for (const [index, characters] of [20177, 19146].entries()) {
    const target = `probe${index}`;
    const brief = codexPastedBriefFixture(characters).brief;
    const entry = { characters, frames: [], accepted: false, nativeIdentityVerified: false, retry: false, outcome: 'unknown' };
    evidence.cases.push(entry);
    let screen = '';
    const capture = phase => {
      screen = invoke(['capture-pane', '-p', '-t', target]);
      const diagnostic = deliveryDiagnostic(settings, { screen, brief, phase, retried: entry.retry });
      if (JSON.stringify(entry.frames.at(-1)?.diagnostic) !== JSON.stringify(diagnostic)) entry.frames.push({ at: new Date().toISOString(), diagnostic });
      return observeRunnerScreen(settings, { text: screen, version: settings.version, requestedCommand: '/status' }).state;
    };
    invoke(['-f', '/dev/null', 'new-session', '-d', '-s', target, '-x', '160', '-y', '40', 'codex', ...settings.baseArgs, '--model', evidence.selection.model, '-c', 'model_reasoning_effort="high"']);
    pids.push(Number(invoke(['display-message', '-p', '-t', target, '#{pane_pid}']).trim()));
    let ready = false;
    const startup = Date.now() + settings.timeouts.overallMs;
    while (Date.now() < startup) {
      const state = capture('before_submission');
      if (state === 'ready') { ready = true; break; }
      if (state !== 'starting' && screen.trim()) { entry.outcome = `startup:${state}`; break; }
      await delay(settings.timeouts.pollMs);
    }
    if (!ready) { if (entry.outcome === 'unknown') entry.outcome = 'startup-not-ready'; continue; }
    invoke(['send-keys', '-t', target, '-l', '/status']);
    const identityDeadline = Date.now() + settings.timeouts.transitionMs;
    let submittedStatus = false;
    let retriedStatus = false;
    let previousStatus;
    while (Date.now() < identityDeadline) {
      capture('before_submission');
      if (readNativeSessionId(settings, screen)) { entry.nativeIdentityVerified = true; break; }
      if (readNativeComposer(settings, screen)?.input === '/status') {
        if (!submittedStatus || !retriedStatus && previousStatus === screen) {
          invoke(['send-keys', '-t', target, 'Enter']);
          if (submittedStatus) retriedStatus = true;
          submittedStatus = true;
        }
        previousStatus = screen;
      }
      await delay(settings.timeouts.pollMs);
    }
    if (!entry.nativeIdentityVerified) { entry.outcome = 'native-identity-unavailable'; continue; }
    const composer = readNativeComposer(settings, screen);
    if (!composer || !['', ...settings.markers.ready].includes(composer.input)) { entry.outcome = 'before-submission:unknown-input'; continue; }
    const before = nativeDeliveryContext(settings, screen.split('\n'), composer.line);
    const pasteFile = path.join(base, 'inert-brief.txt');
    fs.writeFileSync(pasteFile, brief, { mode: 0o600 });
    invoke(['load-buffer', '-b', target, pasteFile]);
    invoke(['paste-buffer', '-p', '-b', target, '-t', target]);
    invoke(['send-keys', '-t', target, 'Enter']);
    const deadline = Date.now() + settings.timeouts.transitionMs;
    let previousPending;
    while (Date.now() < deadline) {
      const state = capture('awaiting_acceptance');
      const input = readNativeComposer(settings, screen);
      if (input && ['', ...settings.markers.ready].includes(input.input) && isNativeWorking(settings, screen)) { entry.accepted = true; entry.outcome = 'native-working'; break; }
      const pending = input && matchPendingBrief(settings, input.input, brief) === 'pending';
      const contextMatches = input && matchesNativeDeliveryContext(settings, before, nativeDeliveryContext(settings, screen.split('\n'), input.line), brief);
      if (pending && contextMatches) {
        if (!entry.retry && previousPending === screen) { invoke(['send-keys', '-t', target, 'Enter']); entry.retry = true; }
        previousPending = screen;
      } else {
        previousPending = undefined;
        if (state !== 'ready' && !isNativeWorking(settings, screen)) { entry.outcome = `delivery:${state}`; break; }
      }
      await delay(settings.timeouts.pollMs);
    }
    if (entry.outcome === 'unknown') entry.outcome = 'acceptance-not-observed';
  }
} catch (error) { evidence.error = error.message; }
finally {
  const killed = spawnSync('tmux', ['-S', socket, 'kill-server'], { env: environment, encoding: 'utf8' });
  for (let count = 0; count < 50 && pids.some(pid => fs.existsSync(`/proc/${pid}/stat`)); count++) await delay(settings.timeouts.pollMs);
  const remainingPids = pids.filter(pid => fs.existsSync(`/proc/${pid}/stat`) && !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')));
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
  evidence.cleanup = { tmuxExitCode: killed.status, remainingPids, privateHomeRemoved: !fs.existsSync(base), privateCodexHomeRemoved: !fs.existsSync(codexHome) };
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ cases: evidence.cases.map(({ characters, outcome }) => ({ characters, outcome })), error: evidence.error, cleanup: evidence.cleanup }) + '\n');
}
