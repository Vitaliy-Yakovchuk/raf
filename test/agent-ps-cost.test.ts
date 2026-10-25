import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { copyAgentPsConfiguration } from '../scripts/qa-agent-ps-configuration.mjs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import { failureContext } from '../src/cli-contract.ts';
import { compileCatalog } from '../src/catalog.ts';
import type { RuntimeConfiguration } from '../src/app-runtime.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { ProcessIdentity, SessionRecord, WorkResult } from '../src/session-state.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtimeUrl = new URL('../src/production-runtime.ts?agent-ps-cost-unit', import.meta.url).href;
const osUrl = new URL('../src/os-runtime.ts', import.meta.url).href;
const boot = { machineId: 'agent-ps-unit-machine', bootId: 'agent-ps-unit-boot' };
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && specifier === './os-runtime.ts') return { url: 'agent-ps-unit:os', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'agent-ps-unit:os') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(osUrl)}; export const readMachineBootIdentity = async () => (${JSON.stringify(boot)});` };
    return next(url, context);
  },
});
const { createProductionServices } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
hooks.deregister();

const configuration: RuntimeConfiguration = {
  catalog: { commands: [], reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }] },
  models: { version: 1, runners: [], models: [], routing: { complexityOrder: [], taskClassification: {}, runnerPreferences: [], modelTransitions: [], roleModelBindings: {} } },
  commandTiming: JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).commandTiming,
};
const start = 'Sun Oct 25 00:00:00 2026';
const startedAt = new Date(start).toISOString();
const succeeded: WorkResult = { status: 'succeeded', response: 'Verified result', proof: { fixture: true } };

test('agent ps live harness: read-only source conf remains immutable and its owned copy is writable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'raf-ps-conf-unit-'));
  const source = join(directory, 'source'), destination = join(directory, 'destination');
  await mkdir(source);
  await writeFile(join(source, 'projects.json'), '{"projects":{}}\n');
  await chmod(join(source, 'projects.json'), 0o400);
  await chmod(source, 0o500);
  t.after(async () => {
    for (const path of [source, destination]) await chmod(path, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  copyAgentPsConfiguration(source, destination);
  assert.equal((await stat(destination)).mode & 0o200, 0o200, 'The new owned conf directory must permit fixture normalization');
  assert.equal((await stat(join(destination, 'projects.json'))).mode & 0o200, 0o200, 'The new owned projects file must permit fixture normalization');
  assert.equal((await stat(source)).mode & 0o777, 0o500);
  assert.equal((await stat(join(source, 'projects.json'))).mode & 0o777, 0o400);
  assert.equal(await readFile(join(destination, 'projects.json'), 'utf8'), await readFile(join(source, 'projects.json'), 'utf8'));
  await writeFile(join(destination, 'projects.json'), '{"projects":{"raf":{}}}\n');
  assert.equal(await readFile(join(source, 'projects.json'), 'utf8'), '{"projects":{}}\n');
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'raf-ps-unit-'));
  const tmpRoot = join(directory, 'home', '.raf', 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const store = openStateStore(':memory:');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const db = store.startupContextDatabase;
  db.exec(`CREATE TABLE ps_event_audit (payload TEXT NOT NULL);
    CREATE TRIGGER ps_event_insert AFTER INSERT ON pending_intents
    BEGIN INSERT INTO ps_event_audit(payload) VALUES (NEW.payload); END;`);
  const processes = new Map<number, { start: string; command: string }>();
  const calls: AdapterCommand[] = [];
  let nextPid = 42000;
  let failure: 'exit' | 'throw' | 'malformed' | null = null;
  const execute: AdapterCommandExecutor = async command => {
    calls.push(structuredClone(command));
    assert.equal(basename(command.executable), 'ps', 'No runner, tmux, timer helper or replacement process is launched');
    assert.deepEqual(command.args, ['-ww', '-axo', 'pid=,lstart=,command='], 'Observe full PID/start/command evidence');
    if (failure === 'throw') throw new Error('Unit process scan unavailable');
    if (failure === 'exit') return { exitCode: 1, stdout: '', stderr: 'Unit process scan refused' };
    if (failure === 'malformed') return { exitCode: 0, stdout: 'not a process table', stderr: '' };
    return { exitCode: 0, stdout: [...processes].map(([pid, row]) => `${pid} ${row.start} ${row.command}`).join('\n'), stderr: '' };
  };
  const service = await createProductionServices(store, configuration, {
    orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(directory, 'catalog.json'),
    statePath: join(directory, 'state.sqlite'), tmpRoot, mode: 'production', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  }, { execute });
  const seed = (addressId: string, options: { finished?: boolean; result?: WorkResult; type?: string } = {}) => {
    const runId = `run-${addressId}`;
    const pid = ++nextPid;
    const command = `unit-agent --address ${addressId} --run ${runId}`;
    const identity: ProcessIdentity = { pid, startedAt, runner: addressId === 'main' ? 'main' : 'codex', runnerSessionId: `native-${runId}`,
      tmuxSession: `unit-${addressId}`, evidence: { command, runId, ...boot } };
    processes.set(pid, { start, command });
    const type = options.type ?? (addressId === 'main' ? 'main' : 'hotfix');
    const session: SessionRecord = { runId, addressId, revision: 1, state: options.finished ? 'finished' : 'running', process: identity,
      ...(options.finished ? { finishedAt: '2099-01-01T00:00:00.000Z' } : { activity: { type, project: 'raf', features: ['profile-raf-performance'], phase: type, cwd: directory } }),
      ...(options.result ? { result: structuredClone(options.result) } : {}) };
    store.sessionRepository.transaction(tx => {
      tx.putSession(session);
      if (!options.finished) tx.putReservation({ runId, resource: 'ram', amount: 1 });
    });
    return session;
  };
  const get = (row: SessionRecord) => store.sessionRepository.transaction(tx => tx.getSession(row.runId))!;
  const reservations = () => store.sessionRepository.transaction(tx => tx.listReservations());
  const events = () => db.prepare('SELECT payload FROM ps_event_audit ORDER BY rowid').all().map(row => JSON.parse(row.payload as string));
  const replaceIdentity = (row: SessionRecord, change: Partial<ProcessIdentity>) => {
    const updated = { ...row, process: { ...row.process!, ...change } };
    store.sessionRepository.transaction(tx => tx.putSession(updated));
    return updated;
  };
  const reminder = (row: SessionRecord) => {
    const value = { id: `reminder-${row.runId}`, createdFor: 'original-owner', assignedTo: row.addressId, text: 'Preserve recovery obligation',
      at: '2099-01-01T00:00:00.000Z', binding: null, state: 'pending' as const, closedAt: null, closeReason: null };
    store.reminderRepository.transaction(tx => tx.save(value));
    return value;
  };
  const reminders = () => store.reminderRepository.transaction(tx => tx.list());
  return { store, processes, calls, seed, get, reservations, events, replaceIdentity, reminder, reminders,
    ps: () => service.control.ps(), fail: (mode: typeof failure) => { failure = mode; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function assertAlive(f: Fixture, rows: readonly SessionRecord[], expected: readonly SessionRecord[]) {
  assert.deepEqual(rows.map(row => row.addressId).sort(), expected.map(row => row.addressId).sort());
  for (const original of expected) {
    const row = rows.find(candidate => candidate.runId === original.runId)!;
    assert.ok(row, 'Preserve durable run ID rather than substituting tmux or native IDs');
    assert.equal(row.state, 'running');
    assert.deepEqual(row.activity, original.activity);
    assert.deepEqual(row.process, original.process);
    assert.deepEqual(row.result, original.result);
    assert.equal(row.observation?.state, 'alive');
    if (row.observation?.state === 'alive') assert.deepEqual(row.observation.identity, original.process);
    assert.deepEqual(f.get(original).observation, row.observation, 'Observation is committed before ps returns');
  }
}

function assertClosed(f: Fixture, original: SessionRecord, status = 'failed') {
  const closed = f.get(original);
  assert.equal(closed.state, 'finished');
  assert.equal(closed.addressId, original.addressId);
  assert.deepEqual(closed.process, original.process);
  assert.equal(closed.result?.status, status);
  assert.equal(f.reservations().some(row => row.runId === original.runId), false);
  for (const event of ['agent.closed', ...(status === 'failed' ? ['agent.failed'] : [])]) {
    const matches = f.events().filter(row => row.runId === original.runId && row.event === event);
    assert.equal(matches.length, 1, `${event} is committed once for the original run`);
    assert.equal(matches[0].payload.id, original.addressId);
  }
}

for (const state of ['empty', 'finished', 'live'] as const) {
  test(`agent ps baseline ${state}: preserve addresses, results, SQLite and one shared process table`, async t => {
    const f = await fixture(t);
    const finished = state === 'empty' ? undefined : f.seed('already-finished', { finished: true, result: succeeded });
    const live = state === 'live' ? [f.seed('main'), f.seed('qa-hotfix', { result: succeeded })] : [];
    const reservations = f.reservations();
    const rows = await f.ps();
    assertAlive(f, rows, live);
    assert.deepEqual(f.reservations(), reservations);
    assert.deepEqual(f.events(), []);
    if (finished) assert.deepEqual(f.get(finished), finished);
    assert.equal(f.calls.length, live.length ? 1 : 0, 'Baseline 4.1: acquire one full table for the invocation, never one per live identity');
  });
}

for (const state of ['missing', 'pid-reused', 'start-reused', 'old-boot'] as const) {
  test(`agent ps ${state}: retain required identity checks, atomic recovery and idempotent events`, async t => {
    const f = await fixture(t);
    const finished = f.seed('already-finished', { finished: true, result: succeeded });
    const target = f.seed('qa-target');
    if (state === 'missing') f.processes.delete(target.process!.pid);
    if (state === 'pid-reused') f.processes.get(target.process!.pid)!.command = 'unrelated-process';
    if (state === 'start-reused') f.processes.get(target.process!.pid)!.start = 'Sun Oct 25 00:00:01 2026';
    if (state === 'old-boot') f.replaceIdentity(target, { evidence: { ...target.process!.evidence, bootId: 'previous-boot' } });
    const original = f.get(target);
    const owned = f.reminder(target);
    const rows = await f.ps();
    assert.deepEqual(rows, []);
    assertClosed(f, original);
    assert.deepEqual(f.get(finished), finished);
    assert.deepEqual(f.reminders(), [{ ...owned, assignedTo: 'main' }]);
    const events = f.events();
    const closed = f.get(target);
    const calls = f.calls.length;
    assert.deepEqual(await f.ps(), []);
    assert.deepEqual(f.get(target), closed);
    assert.deepEqual(f.events(), events);
    assert.deepEqual(f.reminders(), [{ ...owned, assignedTo: 'main' }]);
    assert.equal(calls, 1);
    assert.equal(f.calls.length, calls, 'Already closed rows require no fresh process scan');
  });
}

test('agent ps shared table verifies every identity and refreshes it on the next invocation', async t => {
  const f = await fixture(t);
  const main = f.seed('main');
  const target = f.seed('qa-hotfix');
  const rows = await f.ps();
  assertAlive(f, rows, [main, target]);
  assert.deepEqual(f.events(), []);
  const firstScans = f.calls.length;
  f.processes.delete(target.process!.pid);
  const next = await f.ps();
  assertAlive(f, next, [main]);
  assertClosed(f, target);
  const secondScans = f.calls.length - firstScans;
  assert.equal(firstScans, 1, 'Remove duplicate full-table work for the first invocation');
  assert.equal(secondScans, 1, 'A cached table from an earlier invocation cannot prove process liveness');
});

for (const mode of ['evidence', 'exit', 'throw', 'malformed'] as const) {
  test(`agent ps unverifiable ${mode}: fail explicitly and preserve session, result, reservation and reminders`, async t => {
    const f = await fixture(t);
    const finished = f.seed('already-finished', { finished: true, result: succeeded });
    let target = f.seed('qa-unverifiable', { result: succeeded });
    if (mode === 'evidence') target = f.replaceIdentity(target, { evidence: { ...target.process!.evidence, command: '' } });
    else f.fail(mode);
    const owned = f.reminder(target);
    const reservations = f.reservations();
    await assert.rejects(f.ps(), error => failureContext(error)?.code === 'PROCESS_SCAN_UNKNOWN');
    const current = f.get(target);
    assert.equal(current.state, 'running');
    assert.equal(current.addressId, target.addressId);
    assert.deepEqual(current.process, target.process);
    assert.deepEqual(current.result, target.result);
    assert.equal(current.observation?.state, 'unknown');
    assert.deepEqual(f.reservations(), reservations);
    assert.deepEqual(f.reminders(), [owned]);
    assert.deepEqual(f.get(finished), finished);
    assert.deepEqual(f.events(), []);
    assert.equal(f.calls.length, 1);
    f.fail(null);
    target = f.replaceIdentity(current, { evidence: { ...current.process!.evidence, command: f.processes.get(current.process!.pid)!.command } });
    assertAlive(f, await f.ps(), [target]);
    assert.equal(f.calls.length, 2, 'Retry must obtain fresh evidence after unknown, not reuse a failed scan');
  });
}

test('agent ps mixed live and reused PID: a shared scan never copies one live observation to another run', async t => {
  const f = await fixture(t);
  const main = f.seed('main');
  const target = f.seed('qa-reused');
  f.processes.get(target.process!.pid)!.command = 'foreign-process-with-reused-pid';
  const owned = f.reminder(target);
  const rows = await f.ps();
  assertAlive(f, rows, [main]);
  assertClosed(f, target);
  assert.deepEqual(f.reservations().map(row => row.runId), [main.runId]);
  assert.deepEqual(f.reminders(), [{ ...owned, assignedTo: 'main' }]);
  assert.equal(f.calls.length, 1, 'One shared table still checks every PID, start and command independently');
});

test('agent ps recovery write failure preserves closure effects atomically and retries without duplicate events', async t => {
  const f = await fixture(t);
  const target = f.seed('qa-missing');
  f.processes.delete(target.process!.pid);
  const owned = f.reminder(target);
  f.store.startupContextDatabase.exec(`CREATE TRIGGER ps_block_handoff BEFORE UPDATE ON reminders
    WHEN NEW.assigned_to = 'main' BEGIN SELECT RAISE(ABORT, 'unit handoff failure'); END;`);
  await assert.rejects(f.ps(), /unit handoff failure/);
  assert.notEqual(f.get(target).state, 'finished');
  assert.equal(f.reservations().some(row => row.runId === target.runId), true);
  assert.deepEqual(f.reminders(), [owned]);
  assert.equal(f.events().filter(row => row.event === 'agent.closed').length, 0);
  f.store.startupContextDatabase.exec('DROP TRIGGER ps_block_handoff');
  assert.deepEqual(await f.ps(), []);
  assertClosed(f, target);
  assert.deepEqual(f.reminders(), [{ ...owned, assignedTo: 'main' }]);
  const events = f.events();
  assert.deepEqual(await f.ps(), []);
  assert.deepEqual(f.events(), events);
});


const entryFixture = Symbol.for('raf.agent-ps-entry.fixture');
const entryUrl = new URL('../src/production-entry.ts?agent-ps-entry-cost-unit', import.meta.url).href;
const appUrl = new URL('../src/app-runtime.ts', import.meta.url).href;
const entryBridge = 'const f = () => globalThis[Symbol.for("raf.agent-ps-entry.fixture")];';
const entryDoubles: Record<string, string> = {
  'state-store.ts': `${entryBridge} export const openStateStore = () => f().openStore();`,
  'state-migration-guard.ts': `${entryBridge} export const productionStateContext = () => f().context;`,
  'app-runtime.ts': `export * from ${JSON.stringify(appUrl)}; import {createAppRuntime as create} from ${JSON.stringify(appUrl)}; export const createAppRuntime = (context, dependencies) => create(context, {...dependencies, commandState:undefined});`,
  'production-runtime.ts': `${entryBridge} export const rafSystemCaller = {}; export const createProductionServices = async () => ({control:{ps:()=>f().ps()}});`,
};
const entryHooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === entryUrl && entryDoubles[specifier.slice(2)]) return { url: 'agent-ps-entry:' + specifier.slice(2), shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('agent-ps-entry:')) return { format: 'module', source: entryDoubles[url.slice('agent-ps-entry:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { runProductionCli } = await import(entryUrl) as typeof import('../src/production-entry.ts');
entryHooks.deregister();

for (const state of ['empty', 'live', 'finished', 'missing', 'pid-reused', 'unverifiable', 'scan-failure'] as const) {
  test(`agent ps production ${state}: one SQLite connection owns profile, runtime and finalization`, async t => {
    const f = await fixture(t);
    if (state !== 'empty') f.seed('finished', { finished: true, result: succeeded });
    if (state === 'live') { f.seed('main'); f.seed('qa-hotfix'); }
    if (['missing', 'pid-reused', 'unverifiable', 'scan-failure'].includes(state)) {
      const target = f.seed('qa-target');
      if (state === 'missing') f.processes.delete(target.process!.pid);
      if (state === 'pid-reused') f.processes.get(target.process!.pid)!.command = 'foreign-command';
      if (state === 'unverifiable') f.replaceIdentity(target, { evidence: { ...target.process!.evidence, command: '' } });
      if (state === 'scan-failure') f.fail('exit');
    }
    const directory = await mkdtemp(join(tmpdir(), 'raf-ps-entry-unit-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const constants = JSON.parse(await readFile(join(root, 'conf/raf-constants.json'), 'utf8'));
    const models = JSON.parse(await readFile(join(root, 'conf/models.json'), 'utf8'));
    const projects = JSON.parse(await readFile(join(root, 'conf/projects.json'), 'utf8'));
    const catalog = compileCatalog(constants, models, constants.commands.map((row: {path:string[]}) => row.path.join(' ')), projects);
    const artifactPath = join(directory, 'catalog.json');
    await writeFile(artifactPath, JSON.stringify(catalog));
    const events: string[] = [];
    let opens = 0, closes = 0;
    const context = { statePath: join(directory, 'state.sqlite'), tmpRoot: join(directory, 'tmp') };
    const bridge = {
      context, ps: f.ps,
      openStore() {
        opens++;
        let closed = false;
        return { ...f.store,
          costProfileRepository: { ...f.store.costProfileRepository, update(...args: Parameters<typeof f.store.costProfileRepository.update>) {
            assert.equal(closed, false, 'Profile flush must precede its connection close');
            events.push('profile'); return f.store.costProfileRepository.update(...args);
          } },
          mergeCostContribution(...args: Parameters<NonNullable<typeof f.store.mergeCostContribution>>) {
            assert.equal(closed, false, 'Profile flush must precede its connection close');
            events.push('profile'); return f.store.mergeCostContribution!(...args);
          },
          recordCommandDuration(...args: Parameters<typeof f.store.recordCommandDuration>) {
            assert.equal(closed, false, 'EMA finalization must precede its connection close');
            events.push('ema'); return f.store.recordCommandDuration(...args);
          },
          close() { assert.equal(closed, false, 'Each owned connection closes once'); closed = true; closes++; events.push('close'); },
        };
      },
    };
    const previous = (globalThis as Record<symbol, unknown>)[entryFixture];
    (globalThis as Record<symbol, unknown>)[entryFixture] = bridge;
    t.after(() => { (globalThis as Record<symbol, unknown>)[entryFixture] = previous; });
    const result = await runProductionCli(['agent', 'ps'], { orchestratorRoot: root, homeDirectory: directory, artifactPath });
    const unknown = ['unverifiable', 'scan-failure'].includes(state);
    assert.equal(result.exitCode, unknown ? 1 : 0, result.stderr);
    if (unknown) assert.equal(JSON.parse(result.stderr).code, 'PROCESS_SCAN_UNKNOWN');
    else assert.deepEqual(JSON.parse(result.stdout).map((row: SessionRecord) => row.addressId).sort(), state === 'live' ? ['main', 'qa-hotfix'] : []);
    assert.equal(opens, 1, 'The already opened profiling connection must serve the same agent ps runtime');
    assert.equal(closes, 1);
    assert.ok(events.includes('profile')); assert.ok(events.includes('ema'));
    assert.equal(events.at(-1), 'close', 'The production owner closes after profile and EMA finalization');
    assert.ok(f.store.readCostProfile().rows.some(row => row.command === 'agent ps'));
    assert.ok(f.store.getCommandTiming('agent ps'));
  });
}
