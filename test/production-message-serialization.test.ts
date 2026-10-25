import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';
import type { AdapterCommand, AdapterCommandResult } from '../src/agent-adapters.ts';
import type { DeliveryReceipt } from '../src/agent-control.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { SessionRecord, SessionTransaction } from '../src/session-state.ts';
import type { StateStore } from '../src/state-store.ts';

const key = Symbol.for('raf.production-message-serialization.unit');
const runtimeUrl = new URL('../src/production-runtime.ts?message-serialization-unit', import.meta.url).href;
const bridge = 'const f = () => globalThis[Symbol.for("raf.production-message-serialization.unit")];';
const real = (name: string) => JSON.stringify(new URL(`../src/${name}`, import.meta.url).href);
const doubles: Record<string, string> = {
  'node:fs': `export * from 'node:fs'; import { promises as actual } from 'node:fs';
    export const promises = { ...actual, mkdir: async () => {} };`,
  './os-runtime.ts': `export * from ${real('os-runtime.ts')};
    export const observeProcesses = async identities => identities.map(identity => ({ state: 'alive', identity, observedAt: new Date().toISOString() }));
    export const readMachineBootIdentity = async () => ({ machineId: 'unit-machine', bootId: 'unit-boot' });`,
  './resource-wait-identity.ts': `${bridge} export * from ${real('resource-wait-identity.ts')};
    export const tryWaitLease = (path, timeoutMs, signal) => f().tryLease(path, timeoutMs, signal);`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && doubles[specifier]) return { url: `message-serialization-unit:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('message-serialization-unit:')) return { format: 'module', source: doubles[url.slice('message-serialization-unit:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { createProductionServices, rafSystemCaller } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
const configured = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')) as { runnerProtocols: ProtocolSettings[] };
test.after(() => hooks.deregister());

type Outcome = { state: 'pending' } | { state: 'fulfilled'; receipt: DeliveryReceipt } | { state: 'rejected'; error: unknown };

function track(promise: Promise<DeliveryReceipt>) {
  const result: { outcome: Outcome } = { outcome: { state: 'pending' } };
  const done = promise.then(receipt => { result.outcome = { state: 'fulfilled', receipt }; }, error => { result.outcome = { state: 'rejected', error }; });
  return { result, done };
}

async function drain(): Promise<void> {
  for (let index = 0; index < 200; index++) await Promise.resolve();
}

async function fixture(t: TestContext, runner: 'codex' | 'claude', transitionMs = 120, pollMs = 10) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-25T12:00:00Z') });
  const root = '/unit/message-serialization';
  const context: RuntimeContext = {
    orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'),
    statePath: join(root, 'home/state.sqlite'), tmpRoot: join(root, 'home/tmp'),
    mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  };
  const settings = structuredClone(configured.runnerProtocols.find(row => row.runner === runner)!);
  assert.ok(settings?.native, `configured ${runner} native protocol is required`);
  settings.timeouts = { ...settings.timeouts, transitionMs, pollMs };
  const sessions = new Map<string, SessionRecord>();
  const panes = new Map(['%11', '%22'].map((pane, index) => {
    const name = `recipient-${index + 1}`;
    sessions.set(name, {
      runId: name, addressId: name, state: 'running', revision: 0,
      process: {
        runner, pid: 4002 + index * 2, startedAt: '2026-10-25T12:00:00.000Z',
        runnerSessionId: `native-${index}`, tmuxSession: name,
        evidence: { command: `unit-${name}`, tmuxSocket: '/unit/message.sock', tmuxPane: pane, machineId: 'unit-machine', bootId: 'unit-boot' },
      },
    });
    return [pane, { pane, name, pending: '', accepted: [] as string[], captures: 0 }];
  }));
  const tx = {
    getSession: (id: string) => structuredClone(sessions.get(id)),
    listSessions: () => structuredClone([...sessions.values()]),
    putSession: (session: SessionRecord) => sessions.set(session.runId, structuredClone(session)),
    putPending: () => {}, applyEffects: () => {},
  } as unknown as SessionTransaction;
  const store = { sessionRepository: { transaction: (operation: (value: SessionTransaction) => unknown) => operation(tx) } } as unknown as StateStore;
  const buffers = new Map<string, string>();
  const locks = new Set<string>();
  let release!: () => void;
  const acceptanceGate = new Promise<void>(resolve => { release = resolve; });
  const f = {
    settings, panes, locks, sessions,
    attempts: [] as { path: string; at: number; timeoutMs?: number; busy: boolean }[],
    releases: [] as string[], pasted: [] as { pane: string; text: string }[],
    holdAcceptance: true, insideAcceptance: false, mode: 'normal' as 'normal' | 'refuse' | 'throw',
    release,
    async tryLease(path: string, timeoutMs?: number, signal?: AbortSignal) {
      assert.ok(!signal?.aborted, 'test never cancels acquisition');
      const busy = locks.has(path);
      f.attempts.push({ path, at: Date.now(), timeoutMs, busy });
      if (busy) return null;
      locks.add(path);
      let released = false;
      return { release: async () => {
        assert.equal(released, false, 'each acquired message lease is released exactly once');
        released = true;
        locks.delete(path);
        f.releases.push(path);
      } };
    },
    async execute(command: AdapterCommand): Promise<AdapterCommandResult> {
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
      if (command.executable === 'ps') return ok([...sessions.values()].map((session, index) =>
        `${4001 + index * 2} 1 Sun Oct 25 12:00:00 2026 unit-shell\n${session.process!.pid} ${4001 + index * 2} Sun Oct 25 12:00:00 2026 ${session.process!.evidence.command}\n`).join(''));
      assert.equal(command.executable, 'tmux', 'unit test must never execute an external command');
      const args = [...command.args];
      if (args[0] === '-u') args.shift();
      assert.equal(args.shift(), '-S');
      assert.equal(args.shift(), '/unit/message.sock', 'transport must use the recorded recipient socket');
      const action = args[0];
      const target = args[args.indexOf('-t') + 1];
      const pane = panes.get(target) ?? [...panes.values()].find(row => target === `=${row.name}:0.0`);
      if (action === 'display-message') {
        assert.ok(pane);
        if (args.at(-1) === '#{pane_pid}') return ok(`${sessions.get(pane.name)!.process!.pid - 1}\n`);
        if (args.at(-1) === '#{pane_id}') return ok(`${pane.pane}\n`);
      }
      if (action === 'load-buffer') { buffers.set(args[args.indexOf('-b') + 1], command.stdin!); return ok(); }
      if (action === 'paste-buffer') {
        assert.ok(pane);
        const buffer = args[args.indexOf('-b') + 1];
        assert.equal(pane.pending, '', 'no second insert may overlap an unaccepted composer');
        pane.pending = buffers.get(buffer)!;
        buffers.delete(buffer);
        f.pasted.push({ pane: pane.pane, text: pane.pending });
        return ok();
      }
      if (action === 'send-keys') { assert.equal(args.at(-1), 'Enter'); return ok(); }
      if (action === 'capture-pane') {
        assert.ok(pane);
        pane.captures++;
        if (f.mode === 'throw') throw new Error('unit capture exception');
        if (f.mode === 'refuse') return ok('unknown native screen');
        if (pane.pending) {
          if (pane.pane === '%11' && f.holdAcceptance) {
            f.insideAcceptance = true;
            await acceptanceGate;
          }
          pane.accepted.push(pane.pending);
          pane.pending = '';
        }
        return ok(`${settings.markers.ready![0]}\n${pane.accepted.join('\n')}\n${runner === 'codex' ? '›' : '$'} `);
      }
      throw new Error(`Unexpected unit tmux command: ${JSON.stringify(args)}`);
    },
  };
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[key];
  globals[key] = f;
  t.after(() => { release(); globals[key] = previous; });
  const configuration = { catalog: { commands: [], reportStatuses: [] } } as unknown as RuntimeConfiguration;
  const services = await createProductionServices(store, configuration, context, { execute: f.execute, protocolSettings: [settings] });
  const message = (text: string, to = 'recipient-1') => services.control.message({ to, text }, rafSystemCaller);
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await drain(); };
  return { ...f, state: f, message, advance };
}

function assertAccepted(outcome: Outcome, explanation: string): void {
  assert.equal(outcome.state, 'fulfilled', `${explanation}: ${outcome.state === 'rejected' ? String(outcome.error) : outcome.state}`);
  if (outcome.state === 'fulfilled') {
    assert.equal(outcome.receipt.accepted, true);
    assert.ok('receiptId' in outcome.receipt && outcome.receipt.receiptId);
  }
}

for (const runner of ['codex', 'claude'] as const) {
  test(`${runner}: parallel production messages wait through acceptance, preserve literal text, and leave other recipients independent`, async t => {
    const f = await fixture(t, runner);
    const firstText = 'first\n$(literal) `text` "one"';
    const secondText = 'second\n$(literal) `text` "two"';
    const first = track(f.message(firstText));
    await drain();
    assert.equal(f.state.insideAcceptance, true, 'first delivery must be held inside real native acceptance');
    const captures = f.panes.get('%11')!.captures;
    const second = track(f.message(secondText));
    await drain();
    const whileHeld = second.result.outcome;
    const attemptsWhileHeld = f.attempts.filter(row => row.busy);
    const other = track(f.message('independent recipient', 'recipient-2'));
    await drain();
    const otherWhileHeld = other.result.outcome;
    const capturesWhileHeld = f.panes.get('%11')!.captures;
    f.state.holdAcceptance = false;
    f.release();
    await drain();
    await f.advance(f.settings.timeouts.pollMs);
    assert.equal(whileHeld.state, 'pending', `contention must wait rather than refuse the second delivery: ${whileHeld.state === 'rejected' ? String(whileHeld.error) : whileHeld.state}`);
    assert.ok(attemptsWhileHeld.length > 0, 'test must exercise nonblocking lease contention');
    assert.equal(capturesWhileHeld, captures, 'waiting delivery must not inspect the occupied composer');
    assertAccepted(otherWhileHeld, 'another recipient must finish while the first acceptance remains held');
    assertAccepted(first.result.outcome, 'first delivery');
    assertAccepted(second.result.outcome, 'waiting delivery after release');
    assert.deepEqual(f.panes.get('%11')!.accepted, [`[raf] ${firstText}`, `[raf] ${secondText}`]);
    assert.deepEqual(f.panes.get('%22')!.accepted, ['[raf] independent recipient']);
    assert.deepEqual(f.pasted.filter(row => row.pane === '%11').map(row => row.text), [`[raf] ${firstText}`, `[raf] ${secondText}`], 'each literal message must be pasted once without mixing');
    assert.equal(f.locks.size, 0);
    assert.equal(f.releases.length, 3);
  });

  for (const mode of ['refuse', 'throw'] as const) {
    test(`${runner}: production message ${mode} releases its lease for a later delivery`, async t => {
      const f = await fixture(t, runner);
      f.state.holdAcceptance = false;
      f.state.mode = mode;
      const failed = track(f.message('must fail before insertion'));
      await drain();
      assert.equal(failed.result.outcome.state, 'rejected');
      if (failed.result.outcome.state === 'rejected') assert.match(String(failed.result.outcome.error), mode === 'throw' ? /unit capture exception/ : /recognized empty agent composer/);
      assert.equal(f.locks.size, 0, 'refusal and exception must release the acquired lease');
      f.state.mode = 'normal';
      const next = track(f.message('after failure'));
      await drain();
      assertAccepted(next.result.outcome, 'delivery after a failed predecessor');
      assert.deepEqual(f.panes.get('%11')!.accepted, ['[raf] after failure']);
      assert.equal(f.releases.length, 2);
      assert.equal(f.locks.size, 0);
    });
  }

  for (const budget of [{ transitionMs: 90, pollMs: 10 }, { transitionMs: 140, pollMs: 20 }]) {
    test(`${runner}: contended production message waits and polls only within protocol ${budget.transitionMs}/${budget.pollMs}`, async t => {
      const f = await fixture(t, runner, budget.transitionMs, budget.pollMs);
      const first = track(f.message('held owner'));
      await drain();
      assert.equal(f.state.insideAcceptance, true);
      const started = Date.now();
      const waiting = track(f.message('must never be inserted after timeout'));
      await drain();
      const initial = waiting.result.outcome;
      await f.advance(budget.pollMs - 1);
      const attemptsBeforePoll = f.attempts.filter(row => row.busy).length;
      await f.advance(1);
      const attemptsAtPoll = f.attempts.filter(row => row.busy).length;
      for (let elapsed = budget.pollMs; elapsed < budget.transitionMs; elapsed += budget.pollMs) await f.advance(Math.min(budget.pollMs, budget.transitionMs - elapsed));
      const expired = waiting.result.outcome;
      const attemptsAtDeadline = f.attempts.length;
      await f.advance(budget.transitionMs);
      const attemptsAfterDeadline = f.attempts.length;
      f.state.holdAcceptance = false;
      f.release();
      await drain();
      await f.advance(budget.pollMs);
      assert.equal(initial.state, 'pending', `a busy nonblocking lease must be retried within the runner budget: ${initial.state === 'rejected' ? String(initial.error) : initial.state}`);
      assert.equal(attemptsBeforePoll, 1, 'acquisition must not spin before pollMs');
      assert.equal(attemptsAtPoll, 2, 'retry cadence must come from the selected runner pollMs');
      assert.equal(expired.state, 'rejected', 'contention must finish by transitionMs');
      if (expired.state === 'rejected') assert.match(String(expired.error), /lease|composer|delivery|deadline|timed?\s*out|budget/i);
      assert.equal(attemptsAfterDeadline, attemptsAtDeadline, 'expired wait must not keep polling');
      assert.ok(f.attempts.filter(row => row.busy).every(row => row.at - started <= budget.transitionMs));
      assertAccepted(first.result.outcome, 'timeout must preserve the active owner');
      assert.deepEqual(f.panes.get('%11')!.accepted, ['[raf] held owner'], 'expired message must never appear after owner release');
      assert.equal(f.releases.length, 1, 'waiter must never release the owner lease');
      assert.equal(f.locks.size, 0);
    });
  }
}
