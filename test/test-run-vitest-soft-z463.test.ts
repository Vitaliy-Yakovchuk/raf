import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import VitestReporter from '../src/test-run-vitest-reporter.ts';
import { classifyRunnerResult, type RunnerEvent } from '../src/test-runs.ts';

const workspace = resolve(import.meta.dirname, '..');
const file = 'app/soft.test.ts';
const limits = JSON.parse(fs.readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8')).diagnostics;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'raf-z463-'));
  const base = join(directory, 'base.mjs');
  await writeFile(base, `export default class Runner {
    static current;
    static getCurrentTest() { return this.current; }
    trace(_name, attributes, callback) { return (callback ?? attributes)(); }
    async onAfterTryTask(task) { await task.afterTry?.(); }
  }`);
  const values = {
    RAF_TEST_RUN_WORKSPACE: workspace, RAF_TEST_RUN_BASE_RUNNER: base,
    RAF_TEST_RUN_IDS: '[]', RAF_TEST_RUN_DIAGNOSTICS: JSON.stringify(limits),
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const { default: Runner } = await import(new URL(`../src/test-run-vitest-runner.ts?fixture=${encodeURIComponent(directory)}`, import.meta.url).href);
  const runner = new Runner();
  const task = { type: 'test', result: { state: 'fail', errors: [] as any[] }, afterTry: undefined as (() => any) | undefined };
  Runner.current = task;
  return { runner, task };
}

function classify(t: TestContext, errors: any[]) {
  const events: RunnerEvent[] = [];
  const original = fs.writeSync;
  const write = t.mock.method(fs, 'writeSync', (fd: number, ...args: any[]) => {
    if (fd !== 3) return Reflect.apply(original, fs, [fd, ...args]);
    events.push(JSON.parse(args[0]));
    return Buffer.byteLength(args[0]);
  });
  syncBuiltinESMExports();
  try {
    const module = { moduleId: resolve(workspace, file), children: { allTests: () => [reported] } };
    const reported = { name: 'soft assertions', module, parent: module, result: () => ({ state: 'failed', errors }) };
    const reporter = new VitestReporter();
    reporter.onTestModuleCollected(module);
    reporter.onTestCaseResult(reported);
    reporter.onTestRunEnd([], [], 'failed');
    return { events, result: classifyRunnerResult(events, { exitCode: 1, signal: null, stderr: '' }) };
  } finally {
    write.mock.restore();
    syncBuiltinESMExports();
  }
}

function softError(message = 'expected 1 to be 2') {
  return { name: 'AssertionError', message, actual: 1, expected: 2, stack: `AssertionError: ${message}\n    at ${resolve(workspace, file)}:8:3` };
}

for (const asynchronous of [false, true]) {
  test(`Z463 ${asynchronous ? 'async' : 'sync'} soft errors accumulated without a throw are assertion failures`, async t => {
    const { runner, task } = await fixture(t);
    const body = () => { task.result.errors.push(softError(), softError('second soft assertion')); };
    await runner.trace('test.callback', asynchronous ? { file } : () => body(), asynchronous ? async () => { await Promise.resolve(); body(); } : undefined);
    await runner.onAfterTryTask(task);
    const { events, result } = classify(t, task.result.errors);
    assert.equal(result.outcome, 'assertions-failed');
    assert.deepEqual(result.knownRed, [{ file, name: 'soft assertions' }]);
    assert.deepEqual(result.unknown, []);
    assert.deepEqual(result.unexecuted, []);
    assert.equal(events.filter(event => event.kind === 'assertion-failed').length, 2);
    assert.equal(events.some(event => event.kind === 'setup-failed'), false);
  });
}

test('Z463 soft errors remain assertions when a later hard error skips afterTry', async t => {
  const { runner, task } = await fixture(t);
  try {
    await runner.trace('test.callback', async () => {
      task.result.errors.push(softError());
      throw new Error('later product failure');
    });
    assert.fail('callback must throw');
  } catch (error) { task.result.errors.push(error); }
  const { events, result } = classify(t, task.result.errors);
  assert.equal(result.outcome, 'assertions-failed');
  assert.equal(events.filter(event => event.kind === 'assertion-failed').length, 2);
  assert.deepEqual(result.unknown, []);
});

test('Z463 afterTry result errors are collected even if the base assertion-count check throws', async t => {
  const { runner, task } = await fixture(t);
  task.afterTry = async () => {
    task.result.errors.push(softError());
    throw new Error('expected assertion count');
  };
  try { await runner.onAfterTryTask(task); assert.fail('base must throw'); }
  catch (error) { task.result.errors.push(error); }
  assert.equal(classify(t, task.result.errors).result.outcome, 'assertions-failed');
});

for (const hook of ['test.beforeEach', 'test.afterEach', 'test.onFinished']) {
  test(`Z463 soft errors in ${hook} keep setup origin alongside a soft body failure`, async t => {
    const { runner, task } = await fixture(t);
    const runHook = () => runner.trace(hook, async () => { task.result.errors.push(softError('hook soft assertion')); });
    if (hook === 'test.beforeEach') await runHook();
    await runner.trace('test.callback', () => { task.result.errors.push(softError()); });
    await runner.onAfterTryTask(task);
    if (hook !== 'test.beforeEach') await runHook();
    const { events, result } = classify(t, task.result.errors);
    assert.equal(result.outcome, 'setup-failed');
    assert.equal(events.filter(event => event.kind === 'setup-failed' && event.inlineDiagnostic?.origin === 'hook').length, 1);
    assert.equal(events.filter(event => event.kind === 'assertion-failed').length, 1);
  });
}

test('Z463 explicit fixture origins survive result tagging and unobserved errors remain unknown', async t => {
  const { runner, task } = await fixture(t);
  task.result.errors.push(Object.assign(softError(), { rafTestOrigin: 'fixture-setup' }));
  await runner.onAfterTryTask(task);
  const { events, result } = classify(t, [...task.result.errors, softError('unobserved error')]);
  assert.equal(result.outcome, 'setup-failed');
  assert.deepEqual(result.knownRed, []);
  assert.deepEqual(events.filter(event => event.kind === 'setup-failed').map(event => event.inlineDiagnostic?.origin), ['fixture-setup', 'unknown']);
});
