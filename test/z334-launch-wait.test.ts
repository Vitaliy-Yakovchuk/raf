import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const driver = readFileSync(new URL('./z334-host-qa.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('z334-host-qa.mjs', driver, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = (name: string): string => {
  const statement = tree.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
  assert.ok(statement, `Driver declaration ${name} exists`);
  return statement.getText(tree);
};
const finalizer = tree.statements.find(node => ts.isTryStatement(node) && node.finallyBlock);
assert.ok(finalizer && ts.isTryStatement(finalizer) && finalizer.finallyBlock);
const finallyBody = finalizer.finallyBlock.getText(tree);

type CliResult = { cliExitCode: number | null; signal: string | null; error: string | null };
type Plan = { at: number; result: CliResult; stdout: string; stderr: string };
const success: CliResult = { cliExitCode: 0, signal: null, error: null };

function fixture() {
  let clock = 0, interruptAt = Infinity;
  const readiness = 300;
  const plans = new Map<string, Plan>();
  const published: Array<{ file: string; value: unknown }> = [];
  const actions: string[] = [];
  const summary = { status: 'succeeded', steps: [] as unknown[], assertions: [{ name: 'all-required' }], limitations: [] as string[], unexecuted: [] as string[], codexConfig: { before: '', after: '', restored: false }, cleanup: {} as { complete?: boolean; standRemoved?: boolean; errors?: string[] } };
  const interrupted = () => { if (clock >= interruptAt) context.interrupted = 'SIGTERM'; };
  const fs = {
    existsSync(file: string) {
      if (file.endsWith('/stand/pane')) return true;
      if (file.endsWith('/config.toml')) return true;
      const label = path.basename(file, '.json');
      return file.endsWith('.json') && clock >= (plans.get(label)?.at ?? Infinity);
    },
    readFileSync(file: string) {
      const extension = path.extname(file);
      const plan = plans.get(path.basename(file, extension));
      assert.ok(plan, `Scheduled CLI output for ${file}`);
      return extension === '.json' ? JSON.stringify(plan.result) : extension === '.stdout' ? plan.stdout : plan.stderr;
    },
    cpSync() { actions.push('preserve-pane'); },
    readdirSync() { return []; },
    rmSync() { actions.push('remove-stand'); fs.existsSync = file => !file.endsWith('/stand'); }
  };
  const context = vm.createContext({
    assert, path, fs, readiness, stand: '/fixture/stand', ev: '/fixture/evidence', home: '/fixture',
    sourceSha: 'a'.repeat(40), mode: 'live',
    socket: '/fixture/main.sock', codeHome: '/fixture/codex', codeConfigBefore: 'unchanged',
    control: undefined, sequence: 0, interrupted: undefined, cleaning: false, mainStarted: true,
    Date: { now: () => clock },
    delay: async (ms: number) => { clock += ms; interrupted(); assert.ok(clock < 10000, 'Virtual outer host deadline must interrupt a pending request'); },
    atomic: (file: string, value: unknown) => published.push({ file, value }),
    summary, leases: new Set(), children: new Set(), required: ['all-required'],
    state: () => [{ addressId: 'z334-one', state: 'running' }, { addressId: 'z334-neighbor', state: 'running' }],
    saveRun: (row: { addressId: string }) => actions.push('save:' + row.addressId),
    hash: () => 'unchanged',
    command: (label: string) => { actions.push(label); return { cliExitCode: 0, stderr: '' }; },
    process: { pid: 123, exitCode: undefined }, console: { log() {} }
  });
  vm.runInContext([declaration('wait'), declaration('request'), declaration('must'), 'globalThis.driverApi = { wait, request, must };'].join('\n'), context);
  const api = context.driverApi as {
    wait(label: string, read: () => unknown, budget?: number): Promise<unknown>;
    request(label: string, args: string[]): Promise<CliResult & { stdout: string; stderr: string }>;
    must(result: CliResult & { stdout: string; stderr: string }): string;
  };
  return {
    api, context, summary, actions, published, readiness,
    now: () => clock,
    interruptAt(at: number) { interruptAt = at; },
    plan(label: string, at: number, result = success, stdout = 'completed\n', stderr = '') { plans.set(label, { at, result, stdout, stderr }); },
    async cleanup() {
      context.Date = Date;
      await vm.runInContext(`(async () => ${finallyBody})()`, vm.createContext({ ...context }));
    }
  };
}

test('Z334.S01 agent run accepts successful CLI completion after several transition budgets', async () => {
  const f = fixture();
  f.plan('launch-neighbor', f.readiness * 4);
  const result = await f.api.request('launch-neighbor', ['agent', 'run', '--id', 'z334-neighbor']);
  assert.equal(f.now(), f.readiness * 4);
  assert.equal(f.api.must(result), 'completed');
  assert.equal(f.summary.steps.length, 1);
  assert.equal(f.published.length, 1, 'Exactly one CLI command is submitted; no retry or duplicate launch');
});

test('Z334.S02 session and tool readiness retain independent budgets after a late CLI result', async () => {
  const f = fixture();
  f.plan('launch-one', f.readiness * 3);
  f.api.must(await f.api.request('launch-one', ['agent', 'run']));
  const sessionReadyAt = f.now() + f.readiness - 100;
  assert.equal(await f.api.wait('real session one', () => f.now() >= sessionReadyAt && 'session', f.readiness), 'session');
  const probeReadyAt = f.now() + f.readiness - 100;
  assert.equal(await f.api.wait('real tool probes/commit one', () => f.now() >= probeReadyAt && 'probe', f.readiness), 'probe');
  await assert.rejects(f.api.wait('missing tool readiness', () => false, f.readiness), /Incomplete host scenario: missing tool readiness/);
});

test('Z334.S03 non-launch CLI requests retain their transition deadline', async () => {
  const f = fixture();
  f.plan('runner-list', f.readiness * 2);
  await assert.rejects(f.api.request('runner-list', ['runner', 'list']), /Incomplete host scenario: CLI runner-list/);
  assert.equal(f.now(), f.readiness);
  assert.equal(f.summary.steps.length, 0);
});

test('Z334.S04 a late failed CLI preserves its exit, signal and stderr for must to reject', async () => {
  for (const result of [{ cliExitCode: 7, signal: null, error: null }, { cliExitCode: null, signal: 'SIGTERM', error: null }, { cliExitCode: null, signal: null, error: 'spawn failed' }]) {
    const f = fixture();
    f.plan('launch-two', f.readiness * 2, result, '', 'target launch failure');
    const received = await f.api.request('launch-two', ['agent', 'run']);
    assert.equal(received.cliExitCode, result.cliExitCode);
    assert.equal(received.signal, result.signal);
    assert.equal(received.error, result.error);
    assert.equal(received.stderr, 'target launch failure');
    assert.throws(() => f.api.must(received));
  }
});

test('Z334.S05 outer SIGTERM interrupts a pending launch and the driver completes cleanup with failed status', async () => {
  const f = fixture();
  f.interruptAt(f.readiness * 4);
  await assert.rejects(f.api.request('launch-neighbor', ['agent', 'run']), /Interrupted: SIGTERM/);
  assert.equal(f.now(), f.readiness * 4);
  const closed: string[] = [];
  f.context.request = async (label: string) => { closed.push(label); return success; };
  await f.cleanup();
  assert.deepEqual(closed, ['cleanup-close-z334-one', 'cleanup-close-z334-neighbor', 'cleanup-service-stop']);
  assert.deepEqual(f.actions, ['save:z334-one', 'save:z334-neighbor', 'cleanup-tmux-agents', 'cleanup-tmux-main', 'preserve-pane', 'remove-stand']);
  assert.equal(f.summary.status, 'failed');
  assert.equal(f.summary.cleanup.complete, true);
  assert.equal(f.summary.cleanup.standRemoved, true);
  assert.equal(f.context.process.exitCode, 1);
  assert.equal(f.published.at(-1)?.file, '/fixture/evidence/summary.json');
});

test('Z334.S06 interrupted cleanup retains its own bounded CLI wait', async () => {
  const f = fixture();
  f.context.interrupted = 'SIGTERM';
  f.context.cleaning = true;
  f.plan('cleanup-service-stop', 100);
  f.api.must(await f.api.request('cleanup-service-stop', ['service', 'stop']));
  await assert.rejects(f.api.request('cleanup-close-hung', ['agent', 'close']), /Incomplete host scenario: CLI cleanup-close-hung/);
  assert.equal(f.now(), 100 + f.readiness);
});

test('Z334.S07 a failed cleanup close cannot skip other sessions, service stop or either tmux server', async () => {
  const f = fixture();
  f.context.interrupted = 'SIGTERM';
  const attempted: string[] = [];
  f.context.request = async (label: string) => {
    attempted.push(label);
    if (label === 'cleanup-close-z334-one') throw Error('close timed out');
    return success;
  };
  await f.cleanup();
  assert.deepEqual(attempted, ['cleanup-close-z334-one', 'cleanup-close-z334-neighbor', 'cleanup-service-stop']);
  assert.ok(f.actions.includes('cleanup-tmux-agents'));
  assert.ok(f.actions.includes('cleanup-tmux-main'));
  assert.ok(f.actions.includes('preserve-pane'));
  assert.ok(!f.actions.includes('remove-stand'));
  assert.equal(f.summary.status, 'failed');
  assert.equal(f.summary.cleanup.complete, false);
  assert.ok(f.summary.cleanup.errors?.some((message: string) => message.includes('close timed out')));
});


test('Z334.S08 a result published on the interruption poll cannot be accepted as success', async () => {
  const f = fixture();
  f.plan('launch-one', f.readiness * 2);
  f.interruptAt(f.readiness * 2);
  await assert.rejects(f.api.request('launch-one', ['agent', 'run']), /Interrupted: SIGTERM/);
  assert.equal(f.summary.steps.length, 0);
});

test('Z334.S09 completed cleanup cannot suppress the owner config guard or unexecuted gates', async () => {
  const f = fixture();
  f.summary.assertions = [];
  f.context.hash = () => 'changed-owner-config';
  f.context.request = async () => success;
  await f.cleanup();
  assert.equal(f.summary.status, 'failed');
  assert.equal(f.context.process.exitCode, 1);
  assert.deepEqual(Array.from(f.summary.unexecuted), ['all-required']);
  assert.equal(f.summary.codexConfig.before, 'unchanged');
  assert.equal(f.summary.codexConfig.after, 'changed-owner-config');
  assert.equal(f.summary.codexConfig.restored, false);
  assert.ok(f.summary.limitations.includes('Codex changed its selected config; not restored or hidden.'));
});
