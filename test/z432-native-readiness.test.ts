import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { observeRunnerScreen, readNativeComposer, readNativeSessionId, nativeDeliveryContext, isNativeBriefEcho, matchPendingBrief, isNativeWorking, isNativeFinished } from '../src/runner-protocols.ts';
import type { AdapterObservation } from '../src/agent-adapters.ts';
import type { LaunchReadiness } from '../src/launch-wrapper.ts';

const source = readFileSync(new URL('../src/production-runtime.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('production-runtime.ts', source, ts.ScriptTarget.Latest, true);
let readiness: ts.Expression | undefined;
function visit(node: ts.Node): void {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.left.getText(tree) === 'transport.waitReady') readiness = node.right;
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(readiness, 'Production native readiness entry exists');
const program = ts.transpileModule(`globalThis.waitReady = ${readiness.getText(tree)};`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;

function fixture(final: AdapterObservation) {
  let clock = 0;
  let inspections = 0;
  const warnings: string[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let timerId = 0;
  const advance = (milliseconds: number) => {
    clock += milliseconds;
    for (const [id, timer] of timers) if (timer.at <= clock) {
      timers.delete(id);
      timer.callback();
    }
  };
  const settings = {
    version: 'fixture', markers: { ready: ['Ready'] }, navigation: [],
    native: { startup: ['Loading runner'] },
    timeouts: { pollMs: 10, transitionMs: 100 },
  };
  const context = vm.createContext({
    settings, request: { runId: 'z432-unit' },
    Date: { now: () => clock },
    process: { stderr: { write: (text: string) => warnings.push(text) } },
    setTimeout: (callback: () => void, milliseconds: number) => {
      const id = ++timerId;
      if (milliseconds === settings.timeouts.pollMs) { advance(milliseconds); callback(); }
      else timers.set(id, { at: clock + milliseconds, callback });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    adapterSession: {},
    adapter: { inspect: async () => {
      inspections++;
      assert.ok(inspections <= 4, 'Readiness must settle on the observed terminal state');
      advance(45);
      return inspections < 4 ? { status: 'starting' } : final;
    } },
    screen: 'Loading runner', availability: { version: settings.version },
    observeRunnerScreen, requestedStatus: false, nativeId: null, deferred: false,
    workspaceTrustDenied: false,
    sendKeys: async () => assert.fail('No input before readiness'),
  });
  vm.runInContext(program, context);
  return {
    run: () => context.waitReady(100) as Promise<LaunchReadiness>,
    warnings, timers, now: () => clock, inspections: () => inspections,
  };
}

test('Z432 admitted native startup remains pending past startupMs and reaches ready without early input', async () => {
  const f = fixture({ status: 'ready', cliSessionId: 'native-z432' });
  const result = await f.run();
  assert.equal(result.state, 'ready');
  assert.equal(result.state === 'ready' && result.runnerSessionId, 'native-z432');
  assert.ok(f.now() > 100);
  assert.equal(f.inspections(), 4);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /Warning: native runner readiness still pending.*startup screen starting.*waiting/);
  assert.equal(f.timers.size, 0);
});

test('Z432 late native startup failure retains the observed reason instead of readiness timeout', async () => {
  const f = fixture({ status: 'failed', reason: 'auth_required' });
  const result = await f.run();
  assert.equal(result.state, 'unknown_screen');
  assert.equal('reason' in result && result.reason, 'auth_required');
  assert.equal(f.inspections(), 4);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.timers.size, 0);
});

test('Z432 runner exiting after the warning is reported as exited rather than timeout', async () => {
  const f = fixture({ status: 'exited', exitCode: 1 });
  const result = await f.run();
  assert.equal(result.state, 'exited');
  assert.equal('reason' in result && result.reason, 'Runner exited before native identity');
  assert.equal(f.inspections(), 4);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.timers.size, 0);
});

let protocol: ts.Expression | undefined;
let delivery: ts.Expression | undefined;
function findProtocol(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'protocol' && node.initializer) protocol = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'deliverInitialBrief' && node.initializer) delivery = node.initializer;
  ts.forEachChild(node, findProtocol);
}
findProtocol(tree);
assert.ok(protocol);
assert.ok(delivery);
const nativeProgram = ts.transpileModule(`globalThis.protocol = ${protocol.getText(tree)}; globalThis.waitReady = ${readiness!.getText(tree)}; globalThis.deliverInitialBrief = ${delivery.getText(tree)};`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const codex = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');

for (const refresh of [false, true]) test(`Z439 Codex ready prompt completes native identity after status refresh=${refresh}`, async () => {
  const nativeId = '43900000-0000-4000-8000-000000000001';
  const calls: string[][] = [];
  let submissions = 0, inspections = 0;
  const delivered: string[] = [];
  const owner = { runnerSessionId: nativeId };
  let gated = false;
  let pane = 'OpenAI Codex (v0.163.0)\nTip: Use /skills\n› Ask Codex to do anything';
  const context = vm.createContext({
    settings: codex, native: codex.native, availability: { version: '0.163.0' }, request: { runId: 'z439-unit' },
    observeRunnerScreen, readNativeSessionId, tools: { current: () => undefined },
    emptyComposer: (screen: string) => ['', 'Ask Codex to do anything'].includes(readNativeComposer(codex, screen)?.input ?? 'missing'),
    composerInput: (screen: string) => readNativeComposer(codex, screen)?.input,
    now: () => new Date().toISOString(), Date, setTimeout, clearTimeout, process,
    readNativeComposer, nativeDeliveryContext, isNativeBriefEcho, matchPendingBrief, isNativeWorking, isNativeFinished,
    sameIdentity: (left: unknown, right: unknown) => left === right,
    ownership: async () => ({ state: 'owned', identity: owner }),
    gate: async () => { assert.equal(context.nativeId, nativeId); gated = true; },
    sessionStartWork: Promise.resolve(), applySessionStarts: async () => {},
    deliveryPhase: 'before_submission', deliveryRetried: false,
    fail: (_code: string, message: string) => { throw new Error(message); },
    adapterSession: {}, screen: '', screenCapturedAt: undefined, nativeId: null, assignedId: null, actual: undefined, deferred: false,
    requestedStatus: false, submittedStatus: false, retriedStatus: false, statusDeadline: 0, dismissed: false,
    statusScreen: '', identityCommand: '/status', workspaceTrustDenied: false,
    adapter: { inspect: async () => {
      assert.ok(++inspections <= 12, 'ready prompt must not remain stuck after completed /status refresh');
      return context.protocol.observe(pane);
    }, deliver: async (_session: unknown, brief: string) => {
      assert.equal(gated, true, 'durable start gate must precede brief input');
      assert.equal(context.nativeId, nativeId);
      delivered.push(brief);
      pane = '• Working (0s • esc to interrupt)\n› ';
    } },
    sendKeys: async (keys: string[]) => {
      calls.push([...keys]);
      if (keys[0] === '-l') { assert.equal(keys[1], '/status'); pane = 'OpenAI Codex\n› /status'; }
      else {
        assert.deepEqual(Array.from(keys), ['Enter']);
        submissions++;
        pane = (refresh && submissions === 1
          ? 'Model: GPT-6.1-Sol (reasoning high)\nLimits: refresh requested; run /status again shortly.'
          : 'Session: ' + nativeId) + '\nTip: Use /skills\n› Ask Codex to do anything';
      }
    },
  });
  context.settings = { ...codex, timeouts: { ...codex.timeouts, pollMs: 1 } };
  vm.runInContext(nativeProgram, context);
  const result = await context.waitReady(10000);
  assert.equal(result.state, 'ready');
  assert.equal(result.runnerSessionId, nativeId, 'never substitute the prompt or raf runId for native identity');
  await context.deliverInitialBrief('Z439 brief\nsecond line');
  assert.deepEqual(delivered, ['Z439 brief\nsecond line']);
  assert.equal(submissions, refresh ? 2 : 1);
  assert.deepEqual(calls.map(keys => keys.join(' ')), Array.from({ length: submissions }, () => ['-l /status', 'Enter']).flat());
});
