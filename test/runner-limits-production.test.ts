import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { runProductionCli, type ProductionEntryOptions } from '../src/production-entry.ts';
import { openStateStore } from '../src/state-store.ts';
import type { ExecutionResult } from '../src/cli.ts';
import { agyUsagePanel, claudeReady, claudeUsageDismissed, claudeUsagePanel, grokUsageModal } from './quota-frames.ts';

const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const projects = JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects);
const fixtureTimeouts = { startupMs: 5000, transitionMs: 800, overallMs: 6000, pollMs: 50 };
const versions: Record<string, string> = { codex: 'codex-cli 0.163.0', grok: 'grok 1.0.67 (2fe064390d07) [alpha]', agy: '1.4.5', claude: '2.1.308 (Claude Code)' };

type StubBehavior = { runner: 'codex' | 'grok' | 'agy'; loadingResponses?: number; codexReset?: string; grokMenuItem?: string };
type ClaudeBehavior = { runner: 'claude'; registeredRafMain: boolean };

const claudeTrustPrompt = ['[Screen Reader Mode: on via flag]', 'Permission Required: Accessing workspace:', 'CWD', 'Quick safety check: Is this a project you created or one you trust?', 'y. Yes, I trust this folder', 'n. No, exit', 'Enter y/n:', 'Enter to confirm · Esc to cancel'].join('\n');
const claudeStubSource = (logPath: string) => `#!${process.execPath}
import { appendFileSync, realpathSync } from 'node:fs';
const frames = ${JSON.stringify({ prompt: claudeTrustPrompt, readyHead: claudeReady.slice(0, claudeReady.lastIndexOf('\n')), panel: claudeUsagePanel, dismissed: claudeUsageDismissed })};
const log = event => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ ...event, pid: process.pid }) + '\\n');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(versions.claude)}); process.exit(0); }
const cwd = realpathSync(process.cwd());
log({ event: 'start', argv: process.argv.slice(2), tz: process.env.TZ ?? null, cwd });
let trusted = false;
let choice = '';
let buffer = '';
let screen = null;
const write = text => process.stdout.write('\\x1b[2J\\x1b[H' + text);
const render = () => write(!trusted ? frames.prompt.replace('CWD', cwd) : screen ?? frames.readyHead + '\\n$ ' + buffer);
process.on('SIGHUP', () => { log({ event: 'hangup' }); process.exit(0); });
process.on('SIGTERM', () => { log({ event: 'terminated' }); process.exit(0); });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  for (const character of chunk) {
    if (!trusted) {
      log({ event: 'trust-input', character });
      if (character === 'y') choice = 'y';
      else if (character === '\\r' && choice === 'y') { trusted = true; log({ event: 'trusted', cwd }); }
    } else if (character === '\\r') {
      log({ event: 'submitted', command: buffer });
      if (buffer === '/usage') screen = frames.panel;
      buffer = '';
    } else if (character === '\\x1b') { log({ event: 'escape' }); if (screen) screen = frames.dismissed; }
    else if (character === '\\x7f') buffer = buffer.slice(0, -1);
    else if (character >= ' ') buffer += character;
    render();
  }
});
render();
`;

const stubSource = (logPath: string, behavior: StubBehavior, frames: { agyPanel: string; grokModal: string }) => `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const behavior = ${JSON.stringify(behavior)};
const frames = ${JSON.stringify(frames)};
const log = event => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ ...event, pid: process.pid }) + '\\n');
if (process.argv.includes('--version')) { console.log(${JSON.stringify('VERSION')}); process.exit(0); }
log({ event: 'start', argv: process.argv.slice(2), tz: process.env.TZ ?? null });
let buffer = '';
let submissions = 0;
const blocks = [];
let modal = null;
const write = text => process.stdout.write('\\x1b[2J\\x1b[H' + text);
const render = () => {
  if (behavior.runner === 'codex') {
    write(['  >_ OpenAI Codex (v0.163.0)', '     /fixture', '', ...blocks, '', '› ' + (buffer || 'Ask Codex to do anything'), '', '  GPT-6.1-Sol high · /fixture'].join('\\n'));
  } else if (behavior.runner === 'agy') {
    const menu = buffer.startsWith('/') ? ['> /usage                    View model quota usage', '  ↑/↓ Navigate · enter Select · tab Complete'] : [];
    write(['      Antigravity CLI 1.4.5', '─'.repeat(40), '> ' + buffer, '─'.repeat(40), ...(modal ? [modal] : menu.length ? menu : ['? for shortcuts'])].join('\\n'));
  } else {
    const shown = buffer.startsWith('/') ? behavior.grokMenuItem.split(/\\s+/)[1] : buffer;
    const menu = buffer.startsWith('/') ? ['    ' + behavior.grokMenuItem] : [];
    write([...(modal ? [modal] : menu), '  │ ❯ ' + shown, '  ╰─ Weekly limit left: 0% · Grok 4.7 (high) ─╯', '  Shift+Tab:mode  │  Ctrl+x:shortcuts'].join('\\n'));
  }
};
const submit = () => {
  const command = behavior.runner === 'grok' && buffer.startsWith('/') ? behavior.grokMenuItem.split(/\\s+/)[1] : buffer;
  log({ event: 'submitted', command });
  buffer = '';
  if (behavior.runner === 'codex' && command === '/status') {
    submissions += 1;
    const loading = behavior.loadingResponses < 0 || submissions <= behavior.loadingResponses;
    blocks.push(['/status', '', '  Visit https://chatgpt.com/settings/usage for up-to-date', '  information on rate limits and credits', '',
      loading ? '  Limits:              refresh requested; run /status again shortly.' : '  Weekly limit:        [░░░░░░░░░░░░░░░░░░░░] 0% left (resets ' + behavior.codexReset + ')', ''].join('\\n'));
  } else if (behavior.runner === 'agy' && command === '/usage') modal = frames.agyPanel;
  else if (behavior.runner === 'grok' && command === '/usage') modal = frames.grokModal;
  else if (command === '/exit') process.exit(0);
  render();
};
process.on('SIGHUP', () => { log({ event: 'hangup' }); process.exit(0); });
process.on('SIGTERM', () => { log({ event: 'terminated' }); process.exit(0); });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  for (const character of chunk) {
    if (character === '\\r') submit();
    else if (character === '\\x1b') { log({ event: 'escape' }); modal = null; render(); }
    else if (character === '\\x7f') { buffer = buffer.slice(0, -1); render(); }
    else if (character >= ' ') { buffer += character; render(); }
  }
});
render();
`.replace(JSON.stringify('VERSION'), JSON.stringify(versions[behavior.runner]));

function codexReset(): { text: string; iso: string } {
  const instant = new Date(Math.ceil((Date.now() + 2 * 86400000) / 60000) * 60000);
  const hours = instant.getUTCHours();
  const month = instant.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const text = `${hours % 12 || 12}:${String(instant.getUTCMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'} on ${instant.getUTCDate()} ${month}`;
  return { text, iso: instant.toISOString() };
}

function fixture(t: { after(action: () => void | Promise<void>): void }, behavior: StubBehavior | ClaudeBehavior) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-limits-'));
  const root = join(directory, 'orchestrator');
  const conf = join(root, 'conf');
  const home = join(directory, 'home');
  const bin = join(directory, 'bin');
  const logPath = join(directory, `${behavior.runner}-stub.log`);
  for (const path of [conf, home, bin]) mkdirSync(path, { recursive: true });
  const rows = settings.runnerProtocols.map((row: Record<string, unknown>) => ({ ...row, timeouts: { ...fixtureTimeouts } }));
  writeFileSync(join(conf, 'raf.json'), JSON.stringify({ ...settings, runnerProtocols: rows }));
  writeFileSync(join(conf, 'models.json'), JSON.stringify(models));
  writeFileSync(join(conf, 'raf-constants.json'), JSON.stringify(constants));
  writeFileSync(join(conf, 'projects.json'), JSON.stringify(projects));
  const artifactPath = join(directory, 'catalog.json');
  writeFileSync(artifactPath, JSON.stringify(catalog));
  const source = behavior.runner === 'claude' ? claudeStubSource(logPath) : stubSource(logPath, behavior, { agyPanel: agyUsagePanel.slice(agyUsagePanel.indexOf('└ Models & Quota')), grokModal: grokUsageModal });
  writeFileSync(join(bin, behavior.runner), source, { mode: 0o700 });
  if (behavior.runner === 'claude' && behavior.registeredRafMain) {
    mkdirSync(join(root, projects.projects.raf.path));
    assert.equal(spawnSync('git', ['init', '-q', join(root, projects.projects.raf.path)]).status, 0);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  const socket = join(home, '.raf', 'tmp', 'tmux', 'server.sock');
  t.after(() => {
    process.env.PATH = originalPath;
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    for (const pid of stubPids(logPath)) try { process.kill(pid, 'SIGKILL'); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  let clock = 0;
  const options: ProductionEntryOptions = { orchestratorRoot: root, homeDirectory: home, artifactPath, now: () => { clock += 10; return clock; } };
  return { root, home, socket, logPath, row: rows.find((row: { runner: string }) => row.runner === behavior.runner), statePath: join(home, '.raf', settings.state.fileName), run: (argv: string[]) => runProductionCli(argv, options) };
}

function events(logPath: string): Record<string, unknown>[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function stubPids(logPath: string): number[] {
  return [...new Set(events(logPath).map(event => event.pid as number))];
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(records)];
}
function json(result: ExecutionResult, stream: 'stdout' | 'stderr'): unknown {
  return JSON.parse(result[stream]);
}
function assertProbeCleaned(f: ReturnType<typeof fixture>) {
  const sessions = spawnSync('tmux', ['-S', f.socket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  assert.ok(sessions.status !== 0 || sessions.stdout.trim() === '', `raf tmux still has sessions: ${sessions.stdout}`);
  const pids = stubPids(f.logPath);
  assert.ok(pids.length > 0, 'stub runner was launched by the probe');
  for (const pid of pids) assert.equal(alive(pid), false, `probe process ${pid} is still alive`);
}
function listRows(result: ExecutionResult, runner: string) {
  assert.equal(result.exitCode, 0, result.stderr);
  return records(json(result, 'stdout')).filter(row => row.runner === runner && typeof row.model === 'string');
}

test('default CLI runner limits probes codex through owned tmux and runner list then reports exhausted codex models as unavailable', { timeout: 60000 }, async t => {
  const reset = codexReset();
  const f = fixture(t, { runner: 'codex', loadingResponses: 1, codexReset: reset.text });
  const limits = await f.run(['runner', 'limits', '--runners', 'codex']);
  assert.equal(limits.exitCode, 0, limits.stderr);
  const output = records(json(limits, 'stdout'));
  const weekly = output.find(row => row.name === 'weekly');
  assert.ok(weekly, `weekly window in output: ${limits.stdout}`);
  assert.equal(weekly.used, 1);
  assert.equal(weekly.remaining, 0);
  assert.equal(weekly.resetAt, reset.iso);
  assert.ok(output.some(row => row.runner === 'codex' && typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt as string))));
  const log = events(f.logPath);
  const start = log.find(event => event.event === 'start');
  assert.deepEqual(start?.argv, f.row.quota.args);
  assert.equal(start?.tz, 'UTC');
  const submitted = log.filter(event => event.event === 'submitted').map(event => event.command);
  assert.ok(submitted.length >= 2, 'loading block made the probe reissue /status');
  assert.ok(submitted.every(command => command === '/status'), JSON.stringify(submitted));
  assertProbeCleaned(f);
  const store = openStateStore(f.statePath);
  try { assert.ok(store.getQuota('codex')?.snapshot); } finally { store.close(); }
  const rows = listRows(await f.run(['runner', 'list']), 'codex');
  assert.equal(rows.length, models.models.filter((model: { runner: string }) => model.runner === 'codex').length);
  for (const row of rows) {
    assert.equal(row.quota, 'exhausted');
    assert.equal(row.available, false);
    assert.ok((row.reasons as string[]).includes('Quota exhausted'));
  }
});

test('codex status that never leaves the loading block stays unknown: nonzero limits, no fabricated snapshot, list quota unknown', { timeout: 60000 }, async t => {
  const f = fixture(t, { runner: 'codex', loadingResponses: -1, codexReset: codexReset().text });
  const limits = await f.run(['runner', 'limits', '--runners', 'codex']);
  assert.notEqual(limits.exitCode, 0);
  assert.ok(limits.stderr.includes('codex'), limits.stderr);
  assert.ok(!/"remaining":\s*0\b/.test(limits.stdout + limits.stderr));
  assertProbeCleaned(f);
  const store = openStateStore(f.statePath);
  try {
    const quota = store.getQuota('codex');
    assert.ok(quota, 'failed attempt is recorded');
    assert.equal(quota.snapshot ?? null, null);
  } finally { store.close(); }
  for (const row of listRows(await f.run(['runner', 'list']), 'codex')) assert.equal(row.quota, 'unknown');
});

test('grok probe never presses Enter when the menu offers a different command than /usage', { timeout: 60000 }, async t => {
  const f = fixture(t, { runner: 'grok', grokMenuItem: '❯ /statusline Configure the Grok Build status line.' });
  const limits = await f.run(['runner', 'limits', '--runners', 'grok']);
  assert.notEqual(limits.exitCode, 0);
  assert.deepEqual(events(f.logPath).filter(event => event.event === 'submitted'), []);
  assertProbeCleaned(f);
  for (const row of listRows(await f.run(['runner', 'list']), 'grok')) assert.equal(row.quota, 'unknown');
});

test('grok probe without a native dialect still collects quota and list reports grok-4.7 exhausted', { timeout: 60000 }, async t => {
  const f = fixture(t, { runner: 'grok', grokMenuItem: '❯ /usage                   View usage' });
  const limits = await f.run(['runner', 'limits', '--runners', 'grok']);
  assert.equal(limits.exitCode, 0, limits.stderr);
  assert.deepEqual(events(f.logPath).filter(event => event.event === 'submitted').map(event => event.command), ['/usage']);
  assert.ok(events(f.logPath).find(event => event.event === 'start')?.argv instanceof Array);
  assertProbeCleaned(f);
  for (const row of listRows(await f.run(['runner', 'list']), 'grok')) {
    assert.equal(row.quota, 'exhausted');
    assert.equal(row.available, false);
  }
});

test('agy probe stores both pools and list reports every mapped agy model exhausted', { timeout: 60000 }, async t => {
  const f = fixture(t, { runner: 'agy' });
  const limits = await f.run(['runner', 'limits', '--runners', 'agy']);
  assert.equal(limits.exitCode, 0, limits.stderr);
  const output = records(json(limits, 'stdout'));
  assert.ok(output.some(row => row.id === 'gemini'));
  assert.ok(output.some(row => row.id === 'claude_gpt'));
  const observed = output.find(row => row.runner === 'agy' && typeof row.observedAt === 'string')?.observedAt as string;
  const weekly = output.filter(row => row.name === 'weekly');
  assert.deepEqual(weekly.map(row => Date.parse(row.resetAt as string) - Date.parse(observed)).sort((a, b) => a - b), [(37 * 60 + 47) * 60000, (99 * 60 + 30) * 60000]);
  assertProbeCleaned(f);
  const rows = listRows(await f.run(['runner', 'list']), 'agy');
  for (const row of rows.filter(row => row.enabled === true)) {
    assert.equal(row.quota, 'exhausted', String(row.model));
    assert.equal(row.available, false);
  }
});

test('claude quota probe in a fresh temporary directory stops at workspace_trust_required without answering the prompt', { timeout: 60000 }, async t => {
  const f = fixture(t, { runner: 'claude', registeredRafMain: false });
  const limits = await f.run(['runner', 'limits', '--runners', 'claude']);
  assert.notEqual(limits.exitCode, 0);
  assert.match(limits.stdout + limits.stderr, /workspace_trust_required/);
  const log = events(f.logPath);
  const start = log.find(event => event.event === 'start');
  assert.ok(String(start?.cwd).startsWith(join(realpathSync(f.home), '.raf', 'tmp', 'quota', 'claude-')), String(start?.cwd));
  assert.deepEqual(log.filter(event => ['trust-input', 'trusted', 'submitted'].includes(String(event.event))), []);
  assertProbeCleaned(f);
  const store = openStateStore(f.statePath);
  try { assert.equal(store.getQuota('claude')?.snapshot ?? null, null); } finally { store.close(); }
});

test('claude quota probe in the registered raf branch directory confirms trust once and reports the all-model pool', { timeout: 60000 }, async t => {
  const f = fixture(t, { runner: 'claude', registeredRafMain: true });
  const limits = await f.run(['runner', 'limits', '--runners', 'claude']);
  assert.equal(limits.exitCode, 0, limits.stderr);
  const output = records(json(limits, 'stdout'));
  assert.ok(output.some(row => row.id === 'all_models'), limits.stdout);
  const weekly = output.find(row => row.name === 'weekly' && row.used === 0.78);
  assert.ok(weekly, `all-model weekly window in output: ${limits.stdout}`);
  const log = events(f.logPath);
  const start = log.find(event => event.event === 'start');
  assert.equal(start?.cwd, realpathSync(join(f.root, projects.projects.raf.path)));
  assert.deepEqual(start?.argv, f.row.quota.args);
  assert.deepEqual(log.filter(event => event.event === 'trust-input').map(event => event.character), ['y', '\r']);
  assert.equal(log.filter(event => event.event === 'trusted').length, 1);
  assert.deepEqual(log.filter(event => event.event === 'submitted').map(event => event.command), ['/usage']);
  assertProbeCleaned(f);
  for (const row of listRows(await f.run(['runner', 'list']), 'claude')) assert.equal(row.quota, 'available', String(row.model));
});
