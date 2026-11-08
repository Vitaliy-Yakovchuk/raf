import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { observeRunnerScreen, readNativeComposer, readNativeSessionId, nextRunnerAction, type ProtocolSettings } from '../src/runner-protocols.ts';

const configuration = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const settings = configuration.runnerProtocols.find((row: ProtocolSettings) => row.runner === 'grok') as ProtocolSettings;
const sessionId = '11111111-2222-4333-8444-555555555555';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/grok-1.0.77-usage-dialog/${name}`, import.meta.url), 'utf8');
const readyScreen = fixture('startup.txt');
const typedScreen = fixture('typed-usage.txt');
const usageDialog = fixture('usage-dialog.txt');
const sessionDialog = fixture('session-info.txt');
const closedScreen = fixture('after-esc.txt');

test('grok 1.0.77 startup is ready and does not open the usage dialog', () => {
  assert.equal(readyScreen.includes('Shift+Tab:mode'), true);
  assert.equal(readyScreen.includes('Esc close'), false);
  assert.equal(observeRunnerScreen(settings, { text: readyScreen, version: settings.version, requestedCommand: null }).state, 'ready');
  assert.equal(typedScreen.includes('/usage'), true);
  assert.equal(typedScreen.includes('Esc close'), false);
});

test('grok 1.0.77 usage dialog keeps the session id on the following line', () => {
  assert.equal(usageDialog.includes('Context usage'), true);
  assert.equal(usageDialog.includes('Usage limit'), true);
  assert.equal(usageDialog.includes('Session info'), true);
  assert.equal(usageDialog.includes('Esc close'), true);
  assert.equal(usageDialog.includes('Session usage:'), true);
  assert.equal(readNativeSessionId(settings, usageDialog), null);
  assert.equal(readNativeSessionId(settings, sessionDialog), sessionId);
  assert.equal(observeRunnerScreen(settings, { text: usageDialog, version: settings.version, requestedCommand: '/usage' }).state, 'known_navigation');
  assert.equal(closedScreen.includes('Shift+Tab:mode'), true);
  assert.equal(readNativeSessionId(settings, closedScreen), null);
});

function loadWaitReady(screenFor: (keys: string[]) => string) {
  const source = readFileSync(new URL('../src/production-runtime.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('production-runtime.ts', source, ts.ScriptTarget.Latest, true);
  let readiness: ts.Expression | undefined;
  let protocol: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.left.getText(tree) === 'transport.waitReady') readiness = node.right;
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'protocol' && node.initializer) protocol = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(readiness && protocol);
  let pane = readyScreen;
  let inspections = 0;
  const calls: string[][] = [];
  const context = vm.createContext({
    settings,
    native: settings.native,
    availability: { version: settings.version },
    request: { runId: 'grok-dialog' },
    observeRunnerScreen,
    nextRunnerAction,
    readNativeSessionId,
    readNativeComposer,
    tools: { current: () => undefined },
    emptyComposer: (screen: string) => readNativeComposer(settings, screen)?.input === '',
    composerInput: (screen: string) => readNativeComposer(settings, screen)?.input,
    nativeId: null as string | null,
    actual: undefined,
    assignedId: sessionId,
    deferred: false,
    identityCommand: '/usage',
    requestedStatus: false,
    submittedStatus: false,
    retriedStatus: false,
    statusSubmissionPending: false,
    statusDeadline: 0,
    dismissed: false,
    statusScreen: '',
    screenReadyRecorded: false,
    nativeIdRecorded: false,
    workspaceTrustDenied: false,
    screen: pane,
    screenCapturedAt: undefined,
    now: () => '2026-11-08T10:30:00.000Z',
    Date,
    process: { stderr: { write: () => true } },
    setTimeout: (callback: () => void, ms: number) => {
      if (ms === settings.timeouts.pollMs) callback();
      return 1;
    },
    clearTimeout: () => {},
    recordLaunchStage: () => {},
    adapterSession: {},
    adapter: {
      inspect: async () => {
        assert.ok(++inspections <= 8, 'readiness kept polling the usage dialog');
        return context.nativeProtocol.observe(pane);
      },
    },
    sendKeys: async (keys: string[]) => {
      calls.push([...keys]);
      pane = screenFor(keys);
    },
  });
  const program = ts.transpileModule(
    `globalThis.nativeProtocol = ${protocol.getText(tree)}; globalThis.waitReady = ${readiness.getText(tree)};`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
  ).outputText;
  vm.runInContext(program, context);
  return { context, calls };
}

test('readiness reads the grok 1.0.77 session id from the dialog and closes it with Esc', async () => {
  const { context, calls } = loadWaitReady(keys => {
    if (keys[0] === '-l') return typedScreen;
    if (keys[0] === 'Enter') return usageDialog;
    if (keys[0] === 'Tab') return sessionDialog;
    if (keys[0] === 'Escape') return closedScreen;
    throw new Error(`Unexpected native key ${keys.join(' ')}`);
  });
  const result = await context.waitReady(settings.timeouts.startupMs);
  assert.equal(result.state, 'ready');
  assert.equal(result.runnerSessionId, sessionId);
  assert.deepEqual(calls, [['-l', '/usage'], ['Enter'], ['Tab'], ['Escape']]);
});

test('a stuck grok 1.0.77 usage dialog is closed with Esc and then refused', async () => {
  const { context, calls } = loadWaitReady(keys => {
    if (keys[0] === '-l') return typedScreen;
    if (keys[0] === 'Enter' || keys[0] === 'Tab' || keys[0] === 'Escape') return usageDialog;
    throw new Error(`Unexpected native key ${keys.join(' ')}`);
  });
  const result = await context.waitReady(settings.timeouts.startupMs);
  assert.equal(result.state, 'unknown_screen');
  assert.match(result.reason, /usage\/session dialog/);
  assert.match(result.reason, /Esc/);
  assert.deepEqual(calls, [['-l', '/usage'], ['Enter'], ['Tab'], ['Escape']]);
});

test('closing the usage dialog without a session id does not type /usage again', async () => {
  const { context, calls } = loadWaitReady(keys => {
    if (keys[0] === '-l') return typedScreen;
    if (keys[0] === 'Enter' || keys[0] === 'Tab') return usageDialog;
    if (keys[0] === 'Escape') return closedScreen;
    throw new Error(`Unexpected native key ${keys.join(' ')}`);
  });
  const result = await context.waitReady(settings.timeouts.startupMs);
  assert.equal(result.state, 'unknown_screen');
  assert.match(result.reason, /usage\/session dialog/);
  assert.match(result.reason, /Esc/);
  assert.equal(calls.filter(keys => keys[0] === '-l').length, 1);
  assert.deepEqual(calls.at(-1), ['Escape']);
});
