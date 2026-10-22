import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildRunnerInvocation,
  isNativeWorking,
  matchPendingBrief,
  nativeWriteScopeArgs,
  observeRunnerScreen,
  readNativeComposer,
  readNativeSessionId,
} from '../src/runner-protocols.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const raf = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const models = JSON.parse(await readFile(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const protocol = (runner: string): ProtocolSettings => {
  const rows = raf.runnerProtocols.filter((row: ProtocolSettings) => row.runner === runner);
  assert.equal(rows.length, 1, `conf/raf.json must define exactly one ${runner} protocol`);
  return structuredClone(rows[0]);
};
const nbsp = ' ';
const uuid = '93809909-b4f6-4161-9517-ba37bd084dc6';
const claudeReady = (input = '') => `[Screen Reader Mode: on via flag]
Claude Code v2.1.308
Sonnet 5.5 with low effort · Claude Max
/srv/dev/work/orchestrator/conf
don't ask on (shift+tab to cycle)
effort: low · /effort
$${input ? nbsp + input : ''}`;
const claudeTrust = `[Screen Reader Mode: on via flag]
Permission Required: Accessing workspace:
/srv/dev/work/orchestrator/raf-develop/test
Quick safety check: Is this a project you created or one you trust?
y. Yes, I trust this folder
n. No, exit
Enter y/n:
Enter to confirm · Esc to cancel`;
const codexTrust = `  Folder access
  /tmp/raf-qa/git-ws
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Quit
  enter continue · esc quit`;
const brief = (lines: number) => Array.from({ length: lines }, (_, index) => `Рядок ${index}`).join('\n');

test('[claude-protocol] conf defines a PATH-resolved claude protocol pinned to the installed version without permission bypass', () => {
  const claude = protocol('claude');
  assert.equal(claude.executable, 'claude');
  assert.equal(claude.version, '2.1.308');
  for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', 'acceptEdits']) assert.equal(claude.baseArgs.includes(forbidden), false, forbidden);
  assert.equal(claude.baseArgs[claude.baseArgs.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(claude.baseArgs.includes('--ax-screen-reader'));
  const settings = JSON.parse(claude.baseArgs[claude.baseArgs.indexOf('--settings') + 1]);
  assert.deepEqual(settings.sandbox, { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
  assert.equal(claude.baseArgs.some(value => /^(Edit|Write)(\(.*\))?$/.test(value)), false, 'edit permissions are granted only per launch write scope');
  assert.equal(claude.sessionIdFlag, '--session-id');
  assert.equal(claude.quotaCommand, '/usage');
  assert.equal(claude.liveTaskVerified, false);
  assert.equal(claude.quotaReliable, true);
  for (const model of models.models.filter((row: { runner: string }) => row.runner === 'claude')) assert.ok(Object.hasOwn(claude.modelAliases, model.id), `alias for ${model.id}`);
  assert.equal((raf.runnerProtocols.find((row: { runner: string }) => row.runner === 'claude') as { operationalEvidence?: unknown }).operationalEvidence !== undefined, true);
});

test('[claude-protocol] invocation maps catalog ids to native aliases and passes the assigned native session id', () => {
  const claude = protocol('claude');
  const invocation = buildRunnerInvocation(claude, { model: 'claude-sonnet', effort: 'high', sessionId: uuid });
  assert.equal(invocation.executable, 'claude');
  assert.deepEqual(invocation.args.slice(-6), ['--model', 'sonnet', '--effort', 'high', '--session-id', uuid]);
});

test('[claude-protocol] write scope grants each directory and a matching path-scoped edit rule; codex keeps sandbox grants only', () => {
  const directories = ['/srv/work/raf-develop', '/home/dev/.raf/tmp/run-1'];
  assert.deepEqual(nativeWriteScopeArgs(protocol('claude'), directories), [
    '--add-dir', directories[0], '--add-dir', directories[1],
    '--allowedTools', `Edit(/${directories[0]}/**)`, `Edit(/${directories[1]}/**)`,
  ]);
  assert.deepEqual(nativeWriteScopeArgs(protocol('codex'), directories), ['--add-dir', directories[0], '--add-dir', directories[1]]);
  assert.deepEqual(nativeWriteScopeArgs(protocol('claude'), []), []);
});

test('[claude-protocol] ready screen, composer and working state come from the native dialect', () => {
  const claude = protocol('claude');
  assert.equal(observeRunnerScreen(claude, { text: claudeReady(), version: claude.version, requestedCommand: null }).state, 'ready');
  assert.deepEqual(readNativeComposer(claude, claudeReady()), { line: 6, input: '' });
  assert.deepEqual(readNativeComposer(claude, claudeReady('[Pasted text #1 +60 lines]')), { line: 6, input: '[Pasted text #1 +60 lines]' });
  assert.equal(readNativeComposer(claude, claudeTrust), null);
  assert.equal(isNativeWorking(claude, `${claudeReady().replace("don't ask on (shift+tab to cycle)", "don't ask on (shift+tab to cycle)  ·  esc to interrupt")}`), true);
  assert.equal(isNativeWorking(claude, claudeReady()), false);
  const codex = protocol('codex');
  assert.deepEqual(readNativeComposer(codex, '  >_ OpenAI Codex (v0.163.0)\n› [Pasted Content 4669 chars]\n  GPT-6.1-Sol'), { line: 1, input: '[Pasted Content 4669 chars]' });
  assert.equal(isNativeWorking(codex, '• Working (0s • esc to interrupt)\n› '), true);
});

test('[claude-protocol] pending paste placeholder is matched by line count for claude and by characters for codex', () => {
  const claude = protocol('claude');
  const text = brief(61);
  assert.equal(matchPendingBrief(claude, '[Pasted text #1 +60 lines]', text), 'pending');
  assert.equal(matchPendingBrief(claude, '[Pasted text #3 +60 lines]', text), 'pending');
  assert.equal(matchPendingBrief(claude, '[Pasted text #1 +59 lines]', text), 'mismatch');
  assert.equal(matchPendingBrief(claude, 'Рядок 0', 'Рядок 0'), 'pending');
  assert.equal(matchPendingBrief(claude, '', text), 'none');
  const codex = protocol('codex');
  const characters = [...text].length;
  assert.equal(matchPendingBrief(codex, `[Pasted Content ${characters} chars]`, text), 'pending');
  assert.equal(matchPendingBrief(codex, `[Pasted Content ${characters + 1} chars]`, text), 'pending');
  assert.equal(matchPendingBrief(codex, `[Pasted Content ${characters + 7} chars]`, text), 'mismatch');
});

test('[claude-protocol] native session id is read from each runner status screen only', () => {
  assert.equal(readNativeSessionId(protocol('claude'), `you: /status\nVersion: 2.1.308\nSession ID: ${uuid}\nSession kind: interactive\nEsc to cancel`), uuid);
  assert.equal(readNativeSessionId(protocol('claude'), claudeReady()), null);
  assert.equal(readNativeSessionId(protocol('codex'), `Session: ${uuid}`), uuid);
  assert.equal(readNativeSessionId(protocol('claude'), 'Session ID: not-a-uuid'), null);
});

test('[claude-protocol] workspace trust prompts are a distinct state ahead of generic permission screens', () => {
  const claude = protocol('claude');
  assert.equal(observeRunnerScreen(claude, { text: claudeTrust, version: claude.version, requestedCommand: null }).state, 'workspace_trust_required');
  const codex = protocol('codex');
  assert.equal(observeRunnerScreen(codex, { text: codexTrust, version: codex.version, requestedCommand: null }).state, 'workspace_trust_required');
});

test('[claude-protocol] a screen made only of native startup lines is the starting state; any other line keeps the usual classification', () => {
  const claude = protocol('claude');
  assert.deepEqual(claude.native?.startup, ['[Screen Reader Mode: on via flag]']);
  const observe = (settings: ProtocolSettings, text: string) => observeRunnerScreen(settings, { text, version: settings.version, requestedCommand: null }).state;
  assert.equal(observe(claude, '[Screen Reader Mode: on via flag]'), 'starting');
  assert.equal(observe(claude, '\n  [Screen Reader Mode: on via flag]  \n\n'), 'starting');
  assert.equal(observe(claude, '[Screen Reader Mode: on via flag]\nUnexpected startup notice'), 'unknown_screen');
  assert.equal(observe(claude, claudeReady()), 'ready');
  assert.equal(observe(claude, claudeTrust), 'workspace_trust_required');
  const codex = protocol('codex');
  assert.deepEqual(codex.native?.startup, []);
  assert.equal(observe(codex, '[Screen Reader Mode: on via flag]'), 'unknown_screen');
});

test('[claude-protocol] workspace trust confirmation keys come from protocol navigation for the exact prompt option', () => {
  const claude = protocol('claude');
  assert.deepEqual(claude.navigation.filter(item => item.state === 'workspace_trust_required'), [{ state: 'workspace_trust_required', match: 'y. Yes, I trust this folder', keys: ['y', 'Enter'] }]);
  assert.ok(claudeTrust.includes('y. Yes, I trust this folder'));
  const codex = protocol('codex');
  assert.deepEqual(codex.navigation.filter(item => item.state === 'workspace_trust_required'), [{ state: 'workspace_trust_required', match: '› 1. Trust and continue', keys: ['Enter'] }]);
  assert.ok(codexTrust.includes('› 1. Trust and continue'));
  assert.equal(observeRunnerScreen(codex, { text: codexTrust, version: codex.version, requestedCommand: null }).state, 'workspace_trust_required');
});

const liveHeader = `[Screen Reader Mode: on via flag]
Claude Code v2.1.308
Sonnet 5.5 with low effort · Claude Max
/srv/dev/work/orchestrator/raf-develop
you: /status
Settings dialog dismissed`;
const liveFocusHint = `tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and
reattach for focus tracking`;
const livePending = (lines: number) => `${liveHeader}
paste again to expand
${liveFocusHint}
$${nbsp} [Pasted text #1 +${lines} lines]`;
const liveWorking = (verb: string) => `Рядок контексту 29: нічого не роби.
${verb}
Tip: Name your conversations with /rename to find them easily in /resume later
paste again to expand
${liveFocusHint}
$`;
const liveFinished = (done: string, mode: string) => `Рядок контексту 29: нічого не роби.
claude: ГОТОВО
${done}
${mode}
effort: low · /effort
$`;

test('[claude-protocol] live 2.1.308 composer after a bracketed paste is `$`, NBSP and a space before the placeholder, and the placeholder is the pending brief', () => {
  const claude = protocol('claude');
  assert.deepEqual(readNativeComposer(claude, livePending(118)), { line: 9, input: '[Pasted text #1 +118 lines]' });
  assert.equal(matchPendingBrief(claude, readNativeComposer(claude, livePending(118))!.input, brief(119)), 'pending');
  assert.equal(matchPendingBrief(claude, readNativeComposer(claude, livePending(29))!.input, brief(30)), 'pending');
  assert.deepEqual(readNativeComposer(claude, `${liveHeader}\n$${nbsp} /status`), { line: 6, input: '/status' });
  assert.deepEqual(readNativeComposer(claude, `${liveHeader}\n$`), { line: 6, input: '' });
});

test('[claude-protocol] live 2.1.308 model turn: a spinner verb line is the working state although the ready marker is replaced by a mode hint and no esc to interrupt is shown', () => {
  const claude = protocol('claude');
  assert.ok(claude.native?.modeHints?.includes('paste again to expand'), 'conf/raf.json#/runnerProtocols/claude/native/modeHints must list the paste hint that replaces the ready marker');
  for (const verb of ['Slithering…', 'Germinating…', 'Garnishing…', 'Pouncing…']) {
    const screen = liveWorking(verb);
    assert.equal(isNativeWorking(claude, screen), true, verb);
    assert.equal(screen.includes('esc to interrupt'), false);
    assert.deepEqual(readNativeComposer(claude, screen), { line: 6, input: '' });
  }
  assert.equal(isNativeWorking(claude, livePending(118)), false);
  assert.equal(isNativeWorking(claude, claudeReady()), false);
});

test('[claude-protocol] live 2.1.308 finished turn: the done line marks the return to the ready input and is not the working state', () => {
  const claude = protocol('claude');
  assert.equal(typeof claude.native?.finished, 'string', 'conf/raf.json#/runnerProtocols/claude/native/finished must define the finished-turn line');
  const finished = new RegExp(claude.native!.finished!, 'mu');
  for (const screen of [
    liveFinished('Baked for 6s · done 12:06 PM', 'paste again to expand'),
    liveFinished('Baked for 3s · done 12:07 PM', "don't ask on (shift+tab to cycle)"),
    liveFinished('Sautéed for 2s · done 12:08 PM', "don't ask on (shift+tab to cycle)"),
  ]) {
    assert.equal(finished.test(screen), true, screen);
    assert.equal(isNativeWorking(claude, screen), false, screen);
    assert.deepEqual(readNativeComposer(claude, screen)?.input, '');
  }
  for (const screen of [liveWorking('Slithering…'), livePending(118), claudeReady()]) assert.equal(finished.test(screen), false, screen);
});
