import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { selectNativeLaunchProtocol } from '../src/agy-session-start.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { isNativeFinished, isNativeWorking, matchPendingBrief, nativeWriteScopeArgs, observeRunnerScreen, nextRunnerAction, readNativeComposer, readNativeSessionId } from '../src/runner-protocols.ts';

const configuration = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
for (const runner of ['grok', 'agy'] as const) {
  test(`Z.458 configured ${runner} supports native task launch`, () => {
    const settings = configuration.runnerProtocols.find((row: ProtocolSettings) => row.runner === runner);
    assert.ok(settings?.native, `${runner} needs its observed native dialect`);
    const protocol = selectNativeLaunchProtocol(settings);
    const invocation = protocol.invocation({ runner, model: runner === 'grok' ? 'grok-4.7' : 'gemini-4-argon-high', effort: 'high' });
    assert.equal(invocation.executable, runner);
    assert.equal(invocation.liveTaskVerified, true);
    if (runner === 'agy') {
      assert.equal(protocol.nativeIdentitySource, 'session_start');
      assert.equal(invocation.args.includes('--conversation'), false);
    } else {
      assert.equal(protocol.nativeIdentitySource, 'assigned');
      assert.ok(invocation.args.includes('--session-id'));
    }
  });
  test(`Z.458 configured ${runner} recognizes its captured live native screens`, () => {
    const settings = configuration.runnerProtocols.find((row: ProtocolSettings) => row.runner === runner);
    assert.ok(settings?.native);
    const live = JSON.parse(readFileSync(new URL(`../evidence/z458b/live-${runner}.json`, import.meta.url), 'utf8'));
    const frames: { stage: string; text: string }[] = live.frames;
    const pending = frames.find(frame => frame.stage === 'pending-paste')!.text;
    assert.match(readNativeComposer(settings, pending)!.input, /Pasted/);
    const brief = Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(matchPendingBrief(settings, readNativeComposer(settings, pending)!.input, brief), 'pending');
    assert.ok(frames.some(frame => isNativeWorking(settings, frame.text)));
    const finished = frames.filter(frame => frame.stage === 'task').at(-1)!.text;
    assert.equal(readNativeComposer(settings, finished)!.input, '');
    assert.equal(isNativeWorking(settings, finished), false);
    assert.equal(isNativeFinished(settings, finished), true);
    if (runner === 'grok') assert.ok(frames.some(frame => readNativeSessionId(settings, frame.text) === 'c82d0a64-457b-4c76-aa47-4ee1c64ce79d'));
    else assert.match(live.sessionStart.conversationId, /^[0-9a-f-]{36}$/);
  });
}

test('Z.458 Grok native status tabs retain identity dismissal before brief readiness', async () => {
  const source = readFileSync(new URL('../src/production-runtime.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('production-runtime.ts', source, ts.ScriptTarget.Latest, true);
  let readiness: ts.Expression | undefined, protocol: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.left.getText(tree) === 'transport.waitReady') readiness = node.right;
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'protocol' && node.initializer) protocol = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(readiness && protocol);
  const settings: ProtocolSettings = structuredClone(configuration.runnerProtocols.find((row: ProtocolSettings) => row.runner === 'grok'));
  const id = '45800000-0000-4000-8000-000000000001';
  settings.native = {
    identity: { source: 'assigned', command: '/usage', pattern: 'Session ID: ([0-9a-f-]+)', dismissKeys: ['Escape'] },
    composer: '^│ ❯ ?(.*?) │$', pendingPaste: { pattern: 'Pasted: (\\d+) lines', unit: 'logical-lines' },
    working: 'Ctrl\\+c:cancel', writeScope: { directoryFlag: null, ruleFlag: null, rule: null }, exitCommand: '/exit',
  };
  settings.markers = { ready: ['Shift+Tab:mode'], known_navigation: ['Auto-compact at', 'Session usage:'] };
  settings.navigation = [
    { state: 'known_navigation', match: 'Auto-compact at', keys: ['Tab'] },
    { state: 'known_navigation', match: 'Session usage:', keys: ['Tab'] },
  ];
  let pane = '│ ❯  │\nShift+Tab:mode', inspections = 0;
  const calls: string[][] = [];
  const context = vm.createContext({
    settings, native: settings.native, availability: { version: settings.version }, request: { runId: 'z458-status' },
    observeRunnerScreen, nextRunnerAction, readNativeSessionId, tools: { current: () => undefined },
    emptyComposer: (screen: string) => readNativeComposer(settings, screen)?.input === '',
    nativeId: null, actual: undefined, assignedId: id, deferred: false, identityCommand: '/usage',
    requestedStatus: false, submittedStatus: false, retriedStatus: false, statusDeadline: 0, dismissed: false,
    statusScreen: '', workspaceTrustDenied: false, screen: pane, screenCapturedAt: undefined, now: () => new Date().toISOString(), Date,
    process: { stderr: { write: () => {} } },
    setTimeout: (callback: () => void, ms: number) => { if (ms === settings.timeouts.pollMs) callback(); return 1; }, clearTimeout: () => {},
    adapterSession: {},
    adapter: { inspect: async () => {
      assert.ok(++inspections <= 12, 'native ID panel must be dismissed after status navigation');
      return context.nativeProtocol.observe(pane);
    } },
    sendKeys: async (keys: string[]) => {
      calls.push(keys);
      if (keys[0] === '-l') pane = '│ ❯ /usage │\nShift+Tab:mode';
      else if (keys[0] === 'Enter') pane = 'Auto-compact at 80%';
      else if (keys[0] === 'Tab') pane = pane.includes('Auto-compact') ? 'Session usage: no model calls yet' : `Session ID: ${id}`;
      else if (keys[0] === 'Escape') pane = '│ ❯  │\nShift+Tab:mode';
      else assert.fail(`Unexpected native key ${keys}`);
    },
  });
  const program = ts.transpileModule(`globalThis.nativeProtocol = ${protocol.getText(tree)}; globalThis.waitReady = ${readiness.getText(tree)};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  vm.runInContext(program, context);
  const result = await context.waitReady(settings.timeouts.startupMs);
  assert.equal(result.state, 'ready');
  assert.equal(result.runnerSessionId, id);
  assert.deepEqual(calls.map(keys => [...keys]), [['-l', '/usage'], ['Enter'], ['Tab'], ['Tab'], ['Escape']]);
});

for (const runner of ['grok', 'agy'] as const) {
  const settings: ProtocolSettings = structuredClone(configuration.runnerProtocols.find((row: ProtocolSettings) => row.runner === runner));
  settings.native = {
    identity: runner === 'grok' ? { source: 'assigned', command: '/usage', pattern: 'Session ID: (.+)', dismissKeys: ['Escape'] } : { source: 'session_start' },
    composer: '^> ?(.*)$',
    pendingPaste: { pattern: runner === 'grok' ? '^\\[Pasted: (\\d+) lines\\]$' : '^\\[Pasted text #\\d+ \\+(\\d+) lines\\]$', unit: 'logical-lines' },
    working: 'Generating|Thinking', finished: '^>\\s*$',
    writeScope: { directoryFlag: '--add-dir', ruleFlag: null, rule: null },
    exitCommand: '/exit', startup: [],
  };
  test(`Z.458 ${runner} accepts the observed logical-lines dialect`, () => {
    assert.doesNotThrow(() => selectNativeLaunchProtocol(settings));
  });
  if (runner === 'grok') test('Z.458 cwd-only Grok dialect emits no unsupported additionalDirectories', () => {
    const cwdOnly = structuredClone(settings);
    cwdOnly.native!.writeScope.directoryFlag = null;
    assert.doesNotThrow(() => selectNativeLaunchProtocol(cwdOnly));
    assert.deepEqual(nativeWriteScopeArgs(cwdOnly, ['/tmp/owned-work']), []);
  });
  test(`Z.458 ${runner} verifies exact logical line counts without mismatch tolerance`, () => {
    const brief = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');
    const paste = (count: number) => runner === 'grok' ? `[Pasted: ${count} lines]` : `[Pasted text #1 +${count} lines]`;
    assert.equal(matchPendingBrief(settings, paste(45), brief), 'pending');
    assert.equal(matchPendingBrief(settings, paste(44), brief), 'mismatch');
    assert.equal(matchPendingBrief(settings, paste(46), brief), 'mismatch');
    assert.equal(matchPendingBrief(settings, paste(46), brief + '\n'), 'pending');
    settings.native!.pendingPaste.unit = 'newlines';
    assert.equal(matchPendingBrief(settings, paste(44), brief), 'pending');
    assert.equal(matchPendingBrief(settings, paste(45), brief), 'mismatch');
  });
}
