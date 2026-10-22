import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { compileCatalog } from '../src/catalog.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';
import { ReminderService, type Reminder } from '../src/reminders.ts';
import { loadEventCatalog } from '../src/event-catalog.ts';
import { createReminderHandlers, settleCommandState, type CommandStatePorts, type ReminderCommand } from '../src/reminder-cli.ts';
import { createProductionServices } from '../src/production-runtime.ts';
import { runProductionCli, type ProductionEntryOptions } from '../src/production-entry.ts';
import type { RuntimeConfiguration } from '../src/app-runtime.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { MessageRequest, VerifiedSender } from '../src/agent-control.ts';
import type { ProcessIdentity, SessionRecord, WorkResult } from '../src/session-state.ts';
import type { ExecutionResult } from '../src/cli.ts';

const read = async (name: string) => JSON.parse(await readFile(new URL(`../../conf/${name}`, import.meta.url), 'utf8'));
export const [constants, flow, settings, models, projects] = await Promise.all(['raf-constants.json', 'flow.json', 'raf.json', 'models.json', 'projects.json'].map(read));
export const successReason = 'сесія закінчилась з success';
export const reminderFields = ['id', 'createdFor', 'assignedTo', 'text', 'at', 'binding', 'state', 'closedAt', 'closeReason'];

export type Delivery = { to: string; text: string; sender: VerifiedSender; accepted: boolean };

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

export function psStart(at: Date): string {
  return `${weekdays[at.getDay()]} ${months[at.getMonth()]} ${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${at.getFullYear()}`;
}

export function errorCode(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown; context?: { code?: unknown } } | null;
  const code = typeof value?.code === 'string' ? value.code : typeof value?.context?.code === 'string' ? value.context.code : '';
  return `${code} ${typeof value?.message === 'string' ? value.message : String(error)}`;
}

const runtimeConfiguration: RuntimeConfiguration = {
  catalog: { commands: [], reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }] },
  models: {
    version: 1,
    runners: [{ id: 'codex', initialEnabled: true }],
    models: [{ id: 'gpt-6.1-sol', version: '6.1', runner: 'codex', effort: 'high', complexity: 'decision', enabled: true }],
    routing: { complexityOrder: ['decision'], taskClassification: {}, runnerPreferences: [], modelTransitions: [], roleModelBindings: {} },
  },
  commandTiming: { emaAlpha: 0.1 },
};

export async function commandFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-reminder-')));
  const homeDirectory = join(root, 'home');
  const stateDirectory = join(homeDirectory, '.raf');
  await Promise.all([mkdir(join(root, 'conf')), mkdir(join(root, 'tmp')), mkdir(stateDirectory, { recursive: true, mode: 0o700 })]);
  await Promise.all([
    writeFile(join(root, 'conf', 'raf.json'), JSON.stringify(settings)),
    writeFile(join(root, 'conf', 'raf-constants.json'), JSON.stringify(constants)),
    writeFile(join(root, 'conf', 'flow.json'), JSON.stringify(flow)),
    writeFile(join(root, 'catalog.json'), JSON.stringify(runtimeConfiguration.catalog)),
  ]);
  const statePath = join(stateDirectory, settings.state.fileName);
  const store = openStateStore(statePath);
  const handles: StateStore[] = [store];
  const catalog = loadEventCatalog(root);
  let now = Date.parse('2026-10-22T12:00:00.000Z');
  let sequence = 0;
  let nextPid = 41000;
  let scanFails = false;
  let deliveryDelayMs = 0;
  const processes = new Map<number, { start: string; command: string }>();
  const commands: AdapterCommand[] = [];
  const deliveries: Delivery[] = [];
  const sessions = () => store.sessionRepository.transaction(tx => tx.listSessions());
  const recipientAlive = (address: string) => sessions().some(session => session.addressId === address && session.state === 'running' &&
    (!session.process || processes.has(session.process.pid)));
  let accept = (request: MessageRequest) => recipientAlive(request.to);
  const execute: AdapterCommandExecutor = async command => {
    commands.push(structuredClone(command));
    if (command.executable !== 'ps') return { exitCode: 127, stdout: '', stderr: `fixture forbids ${command.executable}` };
    if (scanFails) return { exitCode: 1, stdout: '', stderr: 'injected process scan failure' };
    return { exitCode: 0, stderr: '', stdout: [...processes].map(([pid, row]) => `${pid} ${row.start} ${row.command}`).join('\n') + '\n' };
  };
  const deliver = async (request: MessageRequest, sender: VerifiedSender) => {
    if (deliveryDelayMs) await new Promise(resolve => setTimeout(resolve, deliveryDelayMs));
    const accepted = accept(request);
    deliveries.push({ to: request.to, text: request.text, sender: structuredClone(sender), accepted });
    return accepted ? { accepted: true as const, receiptId: `receipt-${deliveries.length}` } : { accepted: false as const, reason: 'Recipient is not an active session' };
  };
  const reminders = new ReminderService({ repository: store.reminderRepository, now: () => new Date(now).toISOString(),
    nextId: () => `seed-${++sequence}`, approvedEventKinds: constants.events.map((event: { id: string }) => event.id) });
  t.after(async () => {
    for (const handle of handles) { try { handle.close(); } catch { } }
    await rm(root, { recursive: true, force: true });
  });
  const separateProcess = () => {
    const handle = openStateStore(statePath);
    handles.push(handle);
    return handle;
  };
  const ports = (handle: StateStore = store): CommandStatePorts => ({ store: handle, now: () => now, nextReminderId: () => `rem-${++sequence}`, catalog, deliver });
  const handlers = (handle: StateStore = store) => createReminderHandlers(ports(handle));
  const settle = (handle: StateStore = store) => settleCommandState(ports(handle));
  const command = async (name: ReminderCommand, params: Record<string, unknown>, handle: StateStore = separateProcess()) => {
    const result = await handlers(handle)[name](params);
    await settle(handle);
    return result;
  };
  const agentPs = async (handle: StateStore = separateProcess()): Promise<SessionRecord[]> => {
    const services = await createProductionServices(handle, runtimeConfiguration, {
      orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'), statePath, tmpRoot: join(root, 'tmp'),
      mode: 'production', commandStartedAtMs: 0, resolveCaller: async () => undefined,
    }, { execute });
    let failure: unknown;
    let rows: SessionRecord[] = [];
    try { rows = await services.control.ps(); } catch (error) { failure = error; }
    await settle(handle);
    if (failure !== undefined) throw failure;
    return rows;
  };
  const identityFor = (address: string, runId: string): ProcessIdentity => {
    const pid = ++nextPid;
    const startedAt = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    const command = `fixture-agent --address ${address} --run ${runId}`;
    processes.set(pid, { start: psStart(startedAt), command });
    return { pid, startedAt: startedAt.toISOString(), runner: 'codex', runnerSessionId: `native-${runId}`, tmuxSession: `raf-${runId}`, evidence: { command, runId } };
  };
  const session = (address: string, options: { project?: string; withProcess?: boolean; result?: WorkResult; state?: SessionRecord['state'] } = {}): SessionRecord => {
    const runId = `run-${address}-${++sequence}`;
    const record: SessionRecord = {
      runId, addressId: address, revision: 1, state: options.state ?? 'running',
      activity: { type: address === 'main' ? 'main' : 'implement', project: options.project ?? 'raf', features: ['add-raf-reminders'], phase: 'implement', cwd: root },
      ...(options.withProcess === false ? {} : { process: identityFor(address, runId) }),
      ...(options.result ? { result: options.result } : {}),
      ...(options.state === 'finished' ? { finishedAt: new Date(now).toISOString() } : {}),
    };
    store.sessionRepository.transaction(tx => tx.putSession(record));
    return record;
  };
  const sql = (statement: string) => {
    const database = new DatabaseSync(statePath);
    try { database.exec(statement); } finally { database.close(); }
  };
  const query = (statement: string, ...values: (string | number)[]) => {
    const database = new DatabaseSync(statePath);
    try { return database.prepare(statement).all(...values); } finally { database.close(); }
  };
  return {
    root, statePath, store, reminders, deliveries, commands, catalog,
    now: () => now,
    time: (value: number) => { now = value; },
    advance: (milliseconds: number) => { now += milliseconds; },
    accept: (predicate: (request: MessageRequest) => boolean) => { accept = predicate; },
    delayDelivery: (milliseconds: number) => { deliveryDelayMs = milliseconds; },
    failScan: (value: boolean) => { scanFails = value; },
    kill: (identity: ProcessIdentity | undefined) => { if (identity) processes.delete(identity.pid); },
    replaceProcess: (identity: ProcessIdentity, row: { start: string; command: string }) => { processes.set(identity.pid, row); },
    separateProcess, ports, handlers, settle, command, agentPs, session, sql, query, sessions,
    getSession: (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId)),
    finish: (record: SessionRecord) => store.sessionRepository.transaction(tx => tx.putSession({ ...record, revision: record.revision + 1, state: 'finished', finishedAt: new Date(now).toISOString() })),
    list: (): Reminder[] => store.reminderRepository.transaction(tx => tx.list()).sort((left, right) => left.id.localeCompare(right.id)),
    get: (id: string): Reminder | undefined => store.reminderRepository.transaction(tx => tx.get(id)),
    recordEvent: (key: string, event: { kind: string; id: string }) => store.eventRepository.transaction(tx => tx.savePending({ key, event })),
    pendingEvents: (id: string) => query('SELECT id FROM pending_intents WHERE id = ?', id).length,
    deliveredTo: (address: string, needle?: string) => deliveries.filter(item => item.accepted && item.to === address && (needle === undefined || item.text.includes(needle))),
    attempts: (needle: string) => deliveries.filter(item => item.text.includes(needle)),
  };
}

export type CommandFixture = Awaited<ReturnType<typeof commandFixture>>;

export async function cliFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-reminder-cli-')));
  const main = join(root, 'raf-main-fixture');
  const home = join(root, 'home');
  const stateDirectory = join(home, '.raf');
  await Promise.all([mkdir(join(root, 'conf')), mkdir(join(main, 'bin'), { recursive: true }), mkdir(stateDirectory, { recursive: true, mode: 0o700 })]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  const configuredProjects = structuredClone(projects);
  configuredProjects.projects.raf.path = 'raf-main-fixture';
  configuredProjects.projects.raf.branchPaths.main = 'raf-main-fixture';
  const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), configuredProjects);
  await Promise.all([
    writeFile(join(root, 'conf', 'raf.json'), JSON.stringify(settings)),
    writeFile(join(root, 'conf', 'raf-constants.json'), JSON.stringify(constants)),
    writeFile(join(root, 'conf', 'models.json'), JSON.stringify(models)),
    writeFile(join(root, 'conf', 'projects.json'), JSON.stringify(configuredProjects)),
    writeFile(join(root, 'conf', 'flow.json'), JSON.stringify(flow)),
    writeFile(join(root, 'catalog.json'), JSON.stringify(catalog)),
    writeFile(join(main, 'bin', 'service.ts'), "process.stderr.write('reminder fixture forbids starting the raf service\\n');\nprocess.exit(3);\n"),
  ]);
  const statePath = join(stateDirectory, settings.state.fileName);
  const store = openStateStore(statePath);
  try {
    for (const [address, state] of [['worker', 'running'], ['reviewer', 'running'], ['main', 'running'], ['gone', 'finished']] as const) {
      store.sessionRepository.transaction(tx => tx.putSession({
        runId: `run-${address}`, addressId: address, revision: 1, state,
        activity: { type: address === 'main' ? 'main' : 'implement', project: 'raf', features: ['add-raf-reminders'], phase: 'implement', cwd: root },
        ...(state === 'finished' ? { finishedAt: '2026-10-22T00:00:00.000Z' } : {}),
      }));
    }
  } finally { store.close(); }
  const originalHome = globalThis.process.env.HOME;
  globalThis.process.env.HOME = home;
  const entry: ProductionEntryOptions = { orchestratorRoot: root, homeDirectory: home, artifactPath: join(root, 'catalog.json') };
  const run = (argv: string[]): Promise<ExecutionResult> => runProductionCli(argv, entry);
  t.after(async () => {
    try {
      const record = JSON.parse(await readFile(join(stateDirectory, 'service.json'), 'utf8'));
      if (Number.isSafeInteger(record.pid) && record.pid > 0) globalThis.process.kill(record.pid, 'SIGKILL');
    } catch { }
    if (originalHome === undefined) delete globalThis.process.env.HOME;
    else globalThis.process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });
  const rows = (): Reminder[] => {
    if (!existsSync(statePath)) return [];
    const handle = openStateStore(statePath);
    try { return handle.reminderRepository.transaction(tx => tx.list()); } finally { handle.close(); }
  };
  const serviceTouched = () => ['service.json', 'service.sock'].some(name => existsSync(join(stateDirectory, name)));
  return { root, home, statePath, run, rows, serviceTouched };
}
