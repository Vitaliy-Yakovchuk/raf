import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { observeRunnerScreen } from '../src/runner-protocols.ts';
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
