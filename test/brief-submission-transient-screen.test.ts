import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { commandFailure, failureContext } from '../src/cli-contract.ts';
import { redactDeliveryText } from '../src/delivery-diagnostic.ts';
import { runLaunchWrapper, type LaunchWrapperPorts, type LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import * as protocols from '../src/runner-protocols.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const source = readFileSync(new URL('../src/production-runtime.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('production-runtime.ts', source, ts.ScriptTarget.Latest, true);
const expressions = new Map<string, string>();
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.initializer && ['protocol', 'deliverInitialBrief'].includes(node.name.getText(tree))) {
    expressions.set(node.name.getText(tree), node.initializer.getText(tree));
  }
  if (ts.isBinaryExpression(node) && node.left.getText(tree) === 'transport.lastScreen') expressions.set('lastScreen', node.right.getText(tree));
  ts.forEachChild(node, visit);
}
visit(tree);
for (const name of ['protocol', 'deliverInitialBrief', 'lastScreen']) assert.ok(expressions.has(name), `Production ${name} entry exists`);
const program = ts.transpileModule([...expressions].map(([name, expression]) => `globalThis.${name} = ${expression};`).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const configured: ProtocolSettings[] = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols;
const screens = {
  codex: ['Ask Codex to do anything\n› ', '• Working (0s • esc to interrupt)\n› '],
  claude: ["don't ask on (shift+tab to cycle)\n$ ", "don't ask on (shift+tab to cycle)\nWorking…\n$ "],
  grok: ['Shift+Tab:mode\n│ ❯ │', 'Ctrl+c: cancel\n│ ❯ │'],
  agy: ['? for shortcuts\n> ', 'Generating...\n> '],
};
const brief = 'Confidential assignment payload for regression';
const unknown = `Unknown native transition\ntoken: private-token-value\nBearer private-bearer-value\nAccount: owner@example.test\nWorkspace: /private/customer/project\n${brief}`;

function deliveryFixture(runner: keyof typeof screens, frames: string[]) {
  const settings = { ...configured.find(row => row.runner === runner)!, timeouts: { pollMs: 10, transitionMs: 30 } };
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const owner = { runnerSessionId: nativeId };
  let clock = 0, inspections = 0, gates = 0, ownerChecks = 0;
  const delivered: string[] = [], keys: string[][] = [];
  const context = vm.createContext({
    ...protocols, redactDeliveryText, settings, native: settings.native, availability: { version: settings.version },
    request: { runId: 'transient-screen-unit', brief },
    Date: { now: () => clock }, setTimeout: (callback: () => void, ms: number) => { clock += ms; callback(); },
    screen: '', screenCapturedAt: undefined, now: () => new Date(clock).toISOString(),
    nativeId, assignedId: settings.native!.identity.source === 'assigned' ? nativeId : undefined,
    deferred: runner === 'agy', actual: undefined, dismissed: true,
    identityCommand: settings.native!.identity.source === 'session_start' ? null : settings.native!.identity.command,
    tools: { current: () => undefined }, emptyComposer: (pane: string) => protocols.readNativeComposer(settings as ProtocolSettings, pane)?.input === '',
    sameIdentity: (a: unknown, b: unknown) => a === b,
    ownership: async () => { ownerChecks++; return { state: 'owned', identity: owner }; },
    gate: async () => { gates++; }, sessionStartWork: Promise.resolve(), applySessionStarts: async () => {},
    deliveryPhase: 'before_submission', deliveryRetried: false,
    fail: (code: string, message: string) => { throw commandFailure({ code, message, reason: message, retrySafe: false }); },
    adapterSession: {}, adapter: {
      inspect: async () => context.protocol.observe(inspections++ === 0 ? screens[runner][0] : frames[Math.min(inspections - 2, frames.length - 1)]),
      deliver: async (_session: unknown, text: string) => { assert.equal(gates, 1); delivered.push(text); },
    },
    sendKeys: async (value: string[]) => { keys.push([...value]); },
  });
  vm.runInContext(program, context);
  return { run: () => context.deliverInitialBrief(brief) as Promise<void>, lastScreen: () => context.lastScreen() as Promise<string>,
    clock: () => clock, inspections: () => inspections, ownerChecks: () => ownerChecks, delivered, keys, context };
}

for (const runner of ['grok', 'agy', 'claude', 'codex'] as const) {
  test(`brief submission: ${runner} accepts working after one unknown frame without resubmission`, async () => {
    const f = deliveryFixture(runner, [unknown, screens[runner][1]]);
    await f.run();
    assert.deepEqual(f.delivered, [brief]);
    assert.deepEqual(f.keys, []);
    assert.equal(f.inspections(), 3);
    assert.equal(f.clock(), 10);
    assert.ok(f.ownerChecks() >= 4);
  });
}

test('brief submission: existing deadline failure links a saved masked last-screen.txt', async t => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'raf-transient-screen-unit-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));
  const f = deliveryFixture('grok', [unknown]);
  const identity = { pid: process.pid, startedAt: new Date().toISOString(), runner: 'grok', runnerSessionId: f.context.nativeId,
    tmuxSession: 'owned-unit', evidence: { runId: 'transient-screen-unit', command: process.execPath } };
  const request: LaunchWrapperRequest = { tmpRoot, statePath: join(tmpRoot, 'state.sqlite'), cwd: tmpRoot,
    runId: 'transient-screen-unit', address: 'unit-agent', tmuxSession: identity.tmuxSession,
    selection: { runner: 'grok', model: 'synthetic', effort: 'high' }, brief, readinessTimeoutMs: 100,
    assignment: { root: tmpRoot, baselineArchives: [], changes: [{ id: 'unit-change', items: [{ id: '1.1', description: 'Unit regression' }] }] } };
  let failure = '', stopped = false, cleaned = false;
  const ports: LaunchWrapperPorts = {
    transport: { startWithoutInput: async () => {}, waitReady: async () => ({ state: 'ready', runnerSessionId: identity.runnerSessionId }),
      ownership: async () => ({ state: 'owned', identity, processKind: 'agent' }), deliver: f.run, lastScreen: f.lastScreen,
      stop: async () => { stopped = true; }, waitExit: async () => ({ code: null, signal: 'SIGTERM' }) },
    report: { fs: { mkdir: async () => {}, readText: async () => null, removeTree: async () => { cleaned = true; } },
      watch: () => () => {}, now: () => new Date().toISOString(), verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }), diagnostic: async () => {} },
    lifecycle: { started: async () => assert.fail('No started handshake before acceptance'), acceptReport: async () => {}, finish: async () => {},
      failed: async (_run, reason, recoverable) => { failure = reason; assert.equal(recoverable, false); } },
    handshake: async () => assert.fail('Unknown frame must not be accepted'),
  };
  let path = '';
  await assert.rejects(runLaunchWrapper(request, ports), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(failureContext(error)?.code, 'RUNNER_DELIVERY_UNAVAILABLE');
    assert.match(error.message, /Native initial brief acceptance timed out/);
    const match = /; lastScreen (.+)$/.exec(error.message);
    assert.ok(match, 'failure must name the saved last screen');
    path = match[1];
    return true;
  });
  assert.equal(f.clock(), 30, 'reuse the existing submission deadline');
  assert.equal(failure.includes(path), true);
  assert.equal(stopped, true);
  assert.equal(cleaned, true);
  const saved = await readFile(path, 'utf8');
  assert.match(saved, /Unknown native transition/);
  assert.doesNotMatch(saved, /private-token-value|private-bearer-value|owner@example|\/private\/customer|Confidential assignment/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
