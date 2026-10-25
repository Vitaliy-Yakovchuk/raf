import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import report from '../src/test-run-reporter.ts';
import VitestReporter from '../src/test-run-vitest-reporter.ts';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { classifyRunnerResult, type RunnerEvent, type TestId } from '../src/test-runs.ts';
import { fixtureConfig } from './helpers/test-run-fixture.ts';

const workspace = resolve(import.meta.dirname, '..');
const limits = JSON.parse(fs.readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8')).diagnostics;
const ids: TestId[] = Array.from({ length: 400 }, (_, index) => ({
  file: `test/product-${index % 54}.test.ts`, name: `case ${index} ${'Ж🙂 product behavior '.repeat(12)}`,
}));
const expectedBytes = Buffer.byteLength(JSON.stringify({ kind: 'complete', expected: ids }) + '\n');

function environment(t: TestContext, values: Record<string, string>): void {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

async function reporterLines(t: TestContext, adapter: 'node' | 'vitest-events', mode: 'passed' | 'mixed', selected = false, protocol = '2', inventory: TestId[] = ids): Promise<string[]> {
  environment(t, { RAF_TEST_RUN_DIAGNOSTICS_PROTOCOL: protocol });
  if (adapter === 'node') {
    async function* source() {
      for (const [index, id] of inventory.entries()) {
        const data = { file: join(workspace, id.file), name: id.name, nesting: 0, testId: index, entryFile: true, type: 'test' };
        yield { type: 'test:enqueue', data };
        const failed = mode === 'mixed' && index === 0;
        yield { type: failed ? 'test:fail' : 'test:pass', data: { ...data, skip: mode === 'mixed' && index === inventory.length - 1,
          details: failed ? { error: Object.assign(new Error('product assertion'), { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: new Error('product assertion') }) } : {},
        } };
      }
    }
    const lines: string[] = [];
    for await (const line of report(source(), selected ? inventory : undefined)) lines.push(line);
    return lines;
  }
  environment(t, { RAF_TEST_RUN_IDS: selected ? JSON.stringify(inventory) : '[]', RAF_TEST_RUN_WORKSPACE: workspace, RAF_TEST_RUN_DIAGNOSTICS: JSON.stringify(limits) });
  const lines: string[] = [];
  const writeSync = fs.writeSync;
  const write = t.mock.method(fs, 'writeSync', (fd: number, ...args: any[]) => {
    if (fd !== 3) return Reflect.apply(writeSync, fs, [fd, ...args]);
    lines.push(args[0]); return Buffer.byteLength(args[0]);
  });
  syncBuiltinESMExports();
  try {
    const reporter = new VitestReporter();
    const tests = inventory.map((id, index) => ({ name: id.name, module: { moduleId: join(workspace, id.file) },
      result: () => mode === 'mixed' && index === 0 ? { state: 'failed', errors: [Object.assign(new Error('product assertion'), { rafTestOrigin: 'test-body' })] }
        : mode === 'mixed' && index === inventory.length - 1 ? { state: 'skipped' } : { state: 'passed' },
    }));
    reporter.onTestModuleCollected({ children: { allTests: () => tests } });
    for (const value of tests) reporter.onTestCaseResult(value);
    reporter.onTestRunEnd([], [], 'passed');
    return lines;
  } finally { write.mock.restore(); syncBuiltinESMExports(); }
}

function fakeChild(t: TestContext, lines: string[], channel: number): void {
  t.mock.method(childProcess, 'spawn', (_executable: string, _argv: string[], options: any) => {
    if (channel === 1) assert.equal(options.env.RAF_TEST_RUN_DIAGNOSTICS_PROTOCOL, '2', 'new runtime must advertise chunked inventory support');
    const child = Object.assign(new EventEmitter(), { pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, new PassThrough(), new PassThrough(), new PassThrough()] });
    queueMicrotask(() => {
      child.emit('spawn');
      setImmediate(() => {
        const stream = channel === 1 ? child.stdout : child.stdio[3] as PassThrough;
        const bytes = Buffer.from(lines.join(''));
        for (let offset = 0; offset < bytes.length; offset += 997) stream.write(bytes.subarray(offset, offset + 997));
        stream.end(); child.stdout.end(); child.stderr.end();
        child.emit('exit', 0, null); child.emit('close', 0, null);
      });
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

async function receive(t: TestContext, lines: string[]): Promise<RunnerEvent[]> {
  const directory = fs.mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'z416-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const production = join(directory, 'production');
  fs.mkdirSync(production); fs.mkdirSync(join(directory, 'conf'));
  fs.writeFileSync(join(directory, 'conf/projects.json'), JSON.stringify({ version: 1, profiles: { local: { production: 'main', environments: { runtime: 'main' } } }, projects: {
    raf: { profile: 'local', path: production, environments: { runtime: 'main' }, branchPaths: { main: production, hotfix: workspace } },
  } }));
  fs.writeFileSync(join(directory, 'conf/raf.json'), JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
  const home = join(directory, 'qa');
  const context = resolveStateContext({ orchestratorRoot: directory, modulePath: join(workspace, 'src/test-run-runtime.ts'),
    homeDirectory: home, operatingSystemHome: join(directory, 'operational'), environment: { HOME: home, RAF_QA_HOME: home }, entryPoint: 'cli' });
  const config = fixtureConfig(); config.diagnostics = limits;
  const ports = createTestRunPorts(config, context, () => { throw new Error('Unit protocol test must not open state'); }, {},
    { flow: Buffer.alloc(0), testRuns: Buffer.alloc(0), projects: Buffer.alloc(0) });
  fakeChild(t, lines, 1);
  const events: RunnerEvent[] = [];
  const child = await ports.spawn({ executable: process.execPath, argv: [], cwd: workspace, shell: false,
    environment: { HOME: home, statePath: context.statePath, tmpPath: context.tmpRoot } }, event => events.push(event));
  assert.equal((await child.wait()).exitCode, 0);
  return events;
}

for (const adapter of ['node', 'vitest-events'] as const) {
  for (const selected of [false, true]) {
    test(`Z416 ${adapter}: large ${selected ? 'exact' : 'group'} collection completes within the line limit`, async t => {
      assert.ok(expectedBytes > limits.maxProtocolLineBytes * 2);
      const lines = await reporterLines(t, adapter, 'passed', selected);
      assert.ok(lines.every(line => Buffer.byteLength(line) <= limits.maxProtocolLineBytes), 'expected inventory must not create an oversized protocol line');
      const events = await receive(t, lines);
      assert.deepEqual(events.filter(event => event.kind === 'protocol-error'), []);
      const result = classifyRunnerResult(events, { exitCode: 0, signal: null, stderr: '' });
      assert.equal(result.outcome, 'passed');
      assert.deepEqual(result.passed, ids);
      assert.deepEqual(result.knownRed, []); assert.deepEqual(result.unexecuted, []); assert.deepEqual(result.unknown, []);
    });
  }

  test(`Z416 ${adapter}: large collection preserves known red and unexecuted identities`, async t => {
    const lines = await reporterLines(t, adapter, 'mixed');
    const red = ids[0];
    const events = await receive(t, lines);
    assert.deepEqual(events.filter(event => event.kind === 'protocol-error'), []);
    const result = classifyRunnerResult(events, { exitCode: 1, signal: null, stderr: '' });
    assert.deepEqual(result.passed, ids.slice(1, -1)); assert.deepEqual(result.knownRed, [red]);
    assert.deepEqual(result.unexecuted, [ids.at(-1)]); assert.deepEqual(result.unknown, []);
    assert.equal(result.outcome, adapter === 'node' ? 'setup-failed' : 'assertions-failed');
  });
}

test('Z416 oversized individual line retains the exact protocol error and already known facts', async t => {
  const lines = await reporterLines(t, 'node', 'passed');
  lines.unshift(JSON.stringify({ kind: 'discovered', test: { file: ids[0].file, name: 'x'.repeat(limits.maxProtocolLineBytes) } }) + '\n');
  const events = await receive(t, lines);
  assert.deepEqual(events.filter(event => event.kind === 'protocol-error'), [{ kind: 'protocol-error', diagnostic: 'Runner protocol line exceeds configured limit' }]);
  const result = classifyRunnerResult(events, { exitCode: 0, signal: null, stderr: '' });
  assert.equal(result.outcome, 'setup-failed'); assert.deepEqual(result.passed, ids);
});

for (const corruption of ['missing-final', 'missing-expected', 'duplicate-expected', 'wrong-count'] as const) {
  test(`Z416 incomplete inventory ${corruption} cannot pass despite successful test results`, async t => {
    const lines = await reporterLines(t, 'node', 'passed');
    const final = lines.findIndex(line => JSON.parse(line).kind === 'complete');
    const expected = lines.findIndex(line => JSON.parse(line).kind === 'expected');
    if (corruption === 'missing-final') lines.splice(final, 1);
    else if (corruption === 'wrong-count') {
      const event = JSON.parse(lines[final]);
      lines[final] = JSON.stringify({ ...event, expectedCount: ids.length + 1 }) + '\n';
    } else if (expected >= 0) {
      if (corruption === 'missing-expected') lines.splice(expected, 1);
      else lines.splice(expected, 0, lines[expected]);
    } else lines.splice(final, 1);
    const events = await receive(t, lines);
    const result = classifyRunnerResult(events, { exitCode: 0, signal: null, stderr: '' });
    assert.equal(result.outcome, 'setup-failed');
    assert.deepEqual(result.passed, ids);
  });
}

for (const corruption of ['none', 'missing-final', 'wrong-count'] as const) {
test(`Z416 Vitest batch wrapper validates large inventories across batches: ${corruption}`, async t => {
  const lines = await reporterLines(t, 'vitest-events', 'passed');
  const final = lines.findIndex(line => JSON.parse(line).kind === 'complete');
  if (corruption === 'missing-final') lines.splice(final, 1);
  if (corruption === 'wrong-count') lines[final] = JSON.stringify({ ...JSON.parse(lines[final]), expectedCount: ids.length + 1 }) + '\n';
  environment(t, { RAF_TEST_RUN_DIAGNOSTICS: JSON.stringify(limits), RAF_TEST_RUN_VITEST_BATCHES: JSON.stringify([
    { executable: process.execPath, argv: ['vitest', 'run'], cwd: workspace, environment: {} },
    { executable: process.execPath, argv: ['vitest', 'run'], cwd: workspace, environment: {} },
  ]) });
  fakeChild(t, lines, 3);
  const output: string[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  const stdoutWrite = process.stdout.write;
  const write = t.mock.method(process.stdout, 'write', (chunk: string | Buffer, ...args: any[]) => {
    if (Buffer.isBuffer(chunk) && chunk[0] === 0xff) return Reflect.apply(stdoutWrite, process.stdout, [chunk, ...args]);
    output.push(chunk.toString()); return true;
  });
  try {
    await import(`../scripts/test-run-vitest.ts?z416=${Date.now()}`);
    assert.equal(process.exitCode, corruption === 'none' ? 0 : 1, 'the Vitest batch protocol gate must require a complete inventory');
    assert.equal(output.join('').includes('Vitest batch missing complete structured protocol'), corruption !== 'none');
  } finally { write.mock.restore(); process.exitCode = previousExitCode; }
});
}

for (const adapter of ['node', 'vitest-events'] as const) {
  test(`Z416 ${adapter}: legacy runtime receives the legacy completion format`, async t => {
    const inventory = ids.slice(0, 2);
    const lines = await reporterLines(t, adapter, 'passed', false, '1', inventory);
    assert.equal(lines.some(line => JSON.parse(line).kind === 'expected'), false);
    assert.deepEqual(JSON.parse(lines.at(-1)!).expected, inventory);
    const events = await receive(t, lines);
    assert.deepEqual(events.filter(event => event.kind === 'protocol-error'), []);
    assert.equal(classifyRunnerResult(events, { exitCode: 0, signal: null, stderr: '' }).outcome, 'passed');
  });
}
