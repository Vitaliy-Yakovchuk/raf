import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { compileCatalog, type CompiledCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import { runProductionCli } from '../src/production-entry.ts';
import { AgentControlService, type AgentControlDependencies } from '../src/agent-control.ts';
import { openStateStore } from '../src/state-store.ts';
import { createSessionState, type SessionRecord, type WorkResult } from '../src/session-state.ts';
import { loadFlowPolicy } from '../src/flow-policy.ts';
import {
  prepareAgentClose,
  type AcceptedCloseReport,
  type AgentClosePreparationDependencies,
  type AgentCloseOptions,
} from '../src/agent-close-preparation.ts';
import {
  agentRunFixture, alive, exists, until, description, type AgentRunFixture,
} from './agent-run-fixture.ts';

const exec = promisify(execFile);
const orchestrator = resolve(import.meta.dirname, '../..');
const conf = join(orchestrator, 'conf');
const policy = loadFlowPolicy(join(conf, 'flow.json'));
const json = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'));
const constants = await json(join(conf, 'raf-constants.json'));
const models = await json(join(conf, 'models.json'));
const projects = await json(join(conf, 'projects.json'));
const statusEvent = (status: 'succeeded' | 'failed') => {
  const entry = constants.reportStatuses.find((entry: any) => entry.id === status);
  assert.ok(entry?.event, `reportStatuses must define the event for ${status}`);
  return entry.event as string;
};
const closeCommand = (catalog: CompiledCatalog) => {
  const command = catalog.commands.find(command => command.path.join(' ') === 'agent close');
  assert.ok(command);
  return command;
};
const catalogFrom = (source = constants) => compileCatalog(
  source, models, source.commands.map((command: any) => command.path.join(' ')), projects,
);
const forced = { force: true, reason: 'Власник скасував запуск до звіту' };
const instant = '2026-10-23T08:00:00.000Z';

async function atomicReport(session: SessionRecord, report: unknown): Promise<void> {
  assert.ok(session.launchContext?.reportPath);
  const path = session.launchContext.reportPath;
  await fs.writeFile(`${path}.new`, JSON.stringify(report));
  await fs.rename(`${path}.new`, path);
}

type FixtureCommit = { repository: string; sha: string };

function report(status: 'succeeded' | 'failed', commits: FixtureCommit[] = []) {
  return {
    status, answer: `Результат fixture: ${status}`,
    commits,
    context: { unnecessary: [], missing: [] },
    changes: [{ id: 'launch-failure-fixture', items: [{
      id: '1.1', status, ...(status === 'failed' ? { reason: 'Контрольована невдача fixture' } : {}),
    }] }],
  };
}

function diagnostic(outcome: Awaited<ReturnType<AgentRunFixture['command']>>) {
  assert.ok(outcome.result, `CLI must return an ExecutionResult: ${outcome.stderr}`);
  assert.equal(outcome.exitCode, outcome.result.exitCode);
  return JSON.parse(outcome.result.stderr);
}

const mainCallerScript = String.raw`
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const marker = process.argv[2];
const c = JSON.parse(await readFile(marker, 'utf8'));
const started = new Set();
setInterval(async () => {
  for (const name of await readdir(c.control)) {
    if (!/^main-command-\d+\.json$/.test(name) || started.has(name)) continue;
    started.add(name);
    const prefix = c.control + '/' + name.slice(0, -5);
    const argv = JSON.parse(await readFile(prefix + '.json', 'utf8'));
    const child = spawn(process.execPath, [c.commandPath, marker, JSON.stringify(argv)], {
      cwd: c.root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', spawnError;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { spawnError = error.message; });
    child.on('close', async exitCode => {
      const outcome = { exitCode, result: stdout.trim() ? JSON.parse(stdout) : null, stderr: spawnError ?? stderr };
      await writeFile(prefix + '.done.tmp', JSON.stringify(outcome));
      await rename(prefix + '.done.tmp', prefix + '.done');
    });
  }
}, 20);
`;

async function attachMainCaller(f: AgentRunFixture, timeouts: { startupMs: number; transitionMs: number }) {
  const marker = join(f.directory, 'fixture.json');
  const cfg = await json(marker);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: cfg.home, RAF_QA_HOME: cfg.home, RAF_AGENT_RUN_FIXTURE: marker,
    PATH: `${join(f.directory, 'bin')}:${process.env.PATH}`,
    TMPDIR: f.directory, TMUX_TMPDIR: f.directory,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const socket = (await exec(cfg.tmux, ['-L', cfg.tmuxLabel, 'display-message', '-p', '#{socket_path}'], {
    env, timeout: timeouts.startupMs,
  })).stdout.trim();
  const socketLocation = relative(f.directory, socket);
  assert.ok(socketLocation && !socketLocation.startsWith('..') && !isAbsolute(socketLocation), 'main uses only the fixture tmux socket');
  const script = join(f.directory, 'main-caller.mjs');
  await fs.writeFile(script, mainCallerScript);
  await exec(cfg.tmux, ['-S', socket, 'new-session', '-d', '-s', 'main', '-c', cfg.root, process.execPath, script, marker], {
    env, timeout: timeouts.startupMs,
  });
  let sequence = 0;
  const command: AgentRunFixture['command'] = async argv => {
    const prefix = join(f.control, `main-command-${++sequence}`);
    await fs.writeFile(`${prefix}.json.tmp`, JSON.stringify(argv));
    await fs.rename(`${prefix}.json.tmp`, `${prefix}.json`);
    await until(() => exists(`${prefix}.done`), Boolean, `attached main ran ${argv.join(' ')}`, timeouts.transitionMs);
    return json(`${prefix}.done`);
  };
  const attached = await command(['main', 'attach']);
  assert.equal(attached.exitCode, 0, JSON.stringify(attached));
  const main = f.inspect().sessions.find(session => session.addressId === 'main');
  assert.ok(main?.process && main.state === 'running', 'public main attach registers the stable caller');
  return { ...f, command };
}

async function liveFixture(t: TestContext, options: { tasks?: number; commands?: string[] } = {}) {
  const protocol = (await json(join(conf, 'raf.json'))).runnerProtocols.find((entry: any) => entry.runner === 'codex');
  const base = await agentRunFixture(t, 'live', protocol.timeouts, 'codex', {
    tasks: 2, productionQa: true, ...options, commands: ['main attach', ...(options.commands ?? [])],
  });
  const outcome = await base.run('gate-worker');
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
  const session = await until(
    () => base.inspect().sessions.find(session => session.addressId === 'gate-worker'),
    session => session?.state === 'running' && Boolean(session.process),
    'fixture worker has a registered running identity',
  );
  assert.ok(session?.process);
  await until(() => exists(join(base.control, 'gate-worker.brief')), Boolean, 'runner accepted the assignment');
  const f = await attachMainCaller(base, protocol.timeouts);
  return { f, session };
}

async function acceptReport(f: AgentRunFixture, session: SessionRecord, status: 'succeeded' | 'failed', commits: FixtureCommit[] = []) {
  const tasksFile = 'openspec/changes/launch-failure-fixture/tasks.md';
  let before: string | undefined;
  let indexBefore: string | undefined;
  let parent: string | undefined;
  if (status === 'succeeded') {
    before = await f.git('show', `HEAD:${tasksFile}`);
    assert.ok(before.includes(`- [ ] 1.1 ${description}`));
    assert.equal(await fs.readFile(join(session.launchContext!.assignment.root, tasksFile), 'utf8'), before);
    indexBefore = await f.git('show', `:${tasksFile}`);
    assert.equal(indexBefore, before);
    parent = (await f.git('rev-parse', 'HEAD')).trim();
  }
  await atomicReport(session, report(status, commits));
  const accepted = await until(
    () => f.inspect().sessions.find(value => value.runId === session.runId),
    value => value?.result?.status === status,
    `production accepted the ${status} report`,
  );
  if (status === 'succeeded') {
    const expected = before!.replace(`- [ ] 1.1 ${description}`, `- [x] 1.1 ${description}`);
    assert.equal(await f.git('show', `HEAD:${tasksFile}`), expected, 'raf commits the exact assigned checkbox');
    assert.equal(await fs.readFile(join(session.launchContext!.assignment.root, tasksFile), 'utf8'), expected);
    assert.equal(await f.git('show', `:${tasksFile}`), expected, 'a task index matching the previous HEAD follows the committed checkbox');
    assert.equal(await f.git('diff', '--cached', 'HEAD', '--', tasksFile), '', 'the checkbox leaves no staged reversal against the new HEAD');
    const commits = (await f.git('rev-list', `${parent}..HEAD`)).trim().split('\n');
    assert.equal(commits.length, 1, 'one raf checkbox commit precedes accepted success');
    assert.notEqual(commits[0], '');
    assert.equal((await f.git('diff-tree', '--no-commit-id', '--name-only', '-r', commits[0])).trim(), tasksFile);
  }
  return accepted;
}

async function assertPendingPreserves(f: AgentRunFixture, session: SessionRecord) {
  const before = f.inspect();
  const outcome = await f.command(['agent', 'close', '--id', session.addressId]);
  assert.equal(outcome.exitCode, 1, JSON.stringify(outcome));
  const failure = diagnostic(outcome);
  assert.equal(failure.code, 'AGENT_RESULT_PENDING');
  const rendered = JSON.stringify(failure);
  assert.match(rendered, /agent close/);
  assert.match(rendered, /stage/);
  assert.ok(rendered.includes(session.addressId));
  assert.ok(rendered.includes(session.runId));
  assert.match(rendered, /report|звіт/i);
  assert.match(rendered, /event|поді/i);
  assert.match(rendered, /help agent close/);
  assert.match(rendered, /force/);
  assert.ok(!rendered.includes('SENSITIVE_FIXTURE_BRIEF'));
  const after = f.inspect();
  const actual = after.sessions.find(value => value.runId === session.runId)!;
  assert.equal(actual.state, 'running');
  assert.equal(actual.result, undefined, 'a gate rejection must not synthesize failed');
  assert.ok(alive(session.process!.pid));
  assert.ok(await exists(join(f.tmpRoot, session.runId)), 'the report channel stays writable');
  assert.deepEqual(after.claims, before.claims);
  assert.deepEqual(after.admission, before.admission);
  assert.deepEqual(after.reminders, before.reminders);
  assert.deepEqual(
    after.pending.filter(value => value.runId === session.runId && [statusEvent('failed'), 'agent.closed'].includes(value.event)),
    before.pending.filter(value => value.runId === session.runId && [statusEvent('failed'), 'agent.closed'].includes(value.event)),
  );
  const expectedTmux = before.sessions.filter(value => value.state === 'running').map(value => value.process!.tmuxSession);
  assert.deepEqual((await f.tmuxSessions()).sort(), expectedTmux.sort());
  const cfg = await json(join(f.directory, 'fixture.json'));
  const reopened = openStateStore(cfg.statePath);
  try {
    assert.equal(reopened.closureNotices.listUndelivered().filter(notice => notice.runId === session.runId).length, 0);
  } finally { reopened.close(); }
  return outcome;
}

function eventReminder(session: SessionRecord, kind: string, id = 'event-witness') {
  return {
    id, createdFor: 'main', assignedTo: 'main',
    text: 'Event witness', at: new Date(Date.now() + policy.retention.finishedSessionsMs).toISOString(), state: 'pending' as const,
    binding: { kind, id: session.addressId, action: 'close' as const },
    closedAt: null, closeReason: null,
  };
}

type LiveSnapshot = ReturnType<AgentRunFixture['inspect']>;

async function settledSnapshot(f: AgentRunFixture): Promise<LiveSnapshot> {
  const outcome = await f.command(['agent', 'ps']);
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
  return f.inspect();
}

function assertConsumedResultEvent(state: LiveSnapshot, session: SessionRecord, status: 'succeeded' | 'failed'): void {
  const witness = state.reminders.find(reminder => reminder.id === 'event-witness');
  assert.ok(witness, 'the applied event witness remains available until retention expires');
  assert.equal(witness.state, 'closed');
  assert.equal(witness.closeReason, `event ${statusEvent(status)}: ${session.addressId}`);
  assert.ok(witness.closedAt);
  assert.equal(new Date(witness.closedAt).toISOString(), witness.closedAt);
  assert.equal(state.pending.some(event => event.runId === session.runId && event.event === statusEvent(status)), false);
}

async function consumedResultEvent(f: AgentRunFixture, session: SessionRecord, status: 'succeeded' | 'failed'): Promise<LiveSnapshot> {
  const state = await until(
    () => settledSnapshot(f),
    state => state.reminders.some(reminder => reminder.id === 'event-witness' && reminder.state === 'closed') &&
      !state.pending.some(event => event.runId === session.runId && event.event === statusEvent(status)),
    'the public command applies and consumes the result event through its retained reminder effect',
  );
  assertConsumedResultEvent(state, session, status);
  return state;
}

async function assertUnchangedEventWitnesses(f: AgentRunFixture, session: SessionRecord, expected: LiveSnapshot['reminders']): Promise<void> {
  const state = await settledSnapshot(f);
  assert.deepEqual(expected.map(reminder => state.reminders.find(value => value.id === reminder.id)), expected,
    'result-event witnesses and pending/open sentinels retain their complete records without duplicate effects');
  assert.deepEqual(state.pending.filter(event => event.runId === session.runId &&
    [statusEvent('succeeded'), statusEvent('failed')].includes(event.event)), []);
}

test('public CLI keeps a committed live worker without a report alive, then accepts its atomic report', async t => {
  const { f, session } = await liveFixture(t);
  const workspace = session.activity!.cwd;
  await fs.writeFile(join(workspace, 'work.txt'), 'Committed work is not a report.\n');
  await exec('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '--', 'work.txt']);
  await exec('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture work before report']);
  const sha = (await exec('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim();
  await assertPendingPreserves(f, session);
  await acceptReport(f, session, 'failed', [{ repository: workspace, sha }]);
  const closed = await f.command(['agent', 'close', '--id', session.addressId]);
  assert.equal(closed.exitCode, 0, JSON.stringify(closed));
  assert.equal(JSON.parse(closed.result.stdout).closed, true);
  assert.equal(alive(session.process!.pid), false, 'close confirms process exit');
});

for (const variant of ['partial', 'malformed', 'foreign', 'unverified', 'answer-only'] as const) {
  test(`public CLI refuses ${variant} report without stopping or cleaning the worker`, async t => {
    const { f, session } = await liveFixture(t);
    const path = session.launchContext!.reportPath;
    if (variant === 'partial') await fs.writeFile(path, '{"status":"succeeded",');
    if (variant === 'malformed') await atomicReport(session, { status: 'unknown', answer: 'SENSITIVE_FIXTURE_BRIEF', changes: [] });
    if (variant === 'foreign') {
      const foreignRun = join(f.tmpRoot, 'previous-run');
      await fs.mkdir(foreignRun);
      await fs.writeFile(join(foreignRun, 'gate-worker.json'), JSON.stringify(report('failed')));
      await atomicReport(session, { ...report('failed'), changes: [{ id: 'foreign-change', items: [] }] });
    }
    if (variant === 'unverified') {
      const tasksPath = join(session.launchContext!.assignment.root, 'openspec/changes/launch-failure-fixture/tasks.md');
      const tasks = await fs.readFile(tasksPath, 'utf8');
      await fs.writeFile(tasksPath, tasks.replace(`1.1 ${description}`, `1.1 Changed after assignment`));
      await atomicReport(session, report('succeeded'));
    }
    if (variant === 'answer-only') await fs.writeFile(path, 'Усе готово. SENSITIVE_FIXTURE_BRIEF');
    await assertPendingPreserves(f, session);
  });
}

for (const status of ['succeeded', 'failed'] as const) {
  test(`accepted ${status} and its consumed result event allow normal close without a duplicate`, async t => {
    const { f, session } = await liveFixture(t);
    f.seedReminder(eventReminder(session, statusEvent(status)));
    const accepted = await acceptReport(f, session, status);
    assert.equal(accepted!.result!.response, report(status).answer);
    const consumed = await consumedResultEvent(f, session, status);
    const sentinel = eventReminder(session, statusEvent(status), 'duplicate-event-sentinel');
    f.seedReminder(sentinel);
    const closed = await f.command(['agent', 'close', '--id', session.addressId]);
    assert.equal(closed.exitCode, 0, JSON.stringify(closed));
    const value = JSON.parse(closed.result.stdout);
    assert.equal(value.closed, true);
    assert.equal(value.result, status);
    await assertUnchangedEventWitnesses(f, session, [...consumed.reminders, sentinel]);
    assert.equal(alive(session.process!.pid), false);
  });
}

test('catalog defines force as an optional boolean flag with default false and the gate error', () => {
  const source = constants.commands.find((command: any) => command.path.join(' ') === 'agent close');
  const flag = source.parameters.find((parameter: any) => parameter.name === 'force');
  assert.ok(flag, 'approved catalog patch must declare force');
  assert.equal(flag.type, 'boolean');
  assert.equal(flag.default, false);
  assert.equal(flag.required, false);
  assert.equal(flag.multiple, false);
  assert.equal(flag.option, '--force');
  assert.match(source.errors, /AGENT_RESULT_PENDING/);
  assert.match(source.errors, /1/);
  assert.equal(source.parameters.find((parameter: any) => parameter.name === 'reason')?.type, 'string');
});

test('parser passes a boolean true only for bare force and defaults to false', async () => {
  const catalog = catalogFrom();
  const calls: Record<string, unknown>[] = [];
  const handler = closeCommand(catalog).handlerName;
  for (const args of [
    ['--id', 'worker'],
    ['--id', 'worker', '--force', '--reason', 'Owner cancelled'],
    ['--id=worker', '--force', '--reason=Owner cancelled'],
  ]) {
    const result = await execute(['agent', 'close', ...args], catalog, { [handler]: async params => { calls.push(params); return { closed: true }; } });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  assert.equal(calls[0].force, false);
  assert.equal(calls[1].force, true);
  assert.equal(calls[2].force, true);
  assert.equal(calls[1].reason, 'Owner cancelled');
  assert.equal(calls[2].reason, 'Owner cancelled');
});

for (const args of [
  ['--force=true', '--reason', 'Owner cancelled'],
  ['--force=false', '--reason', 'Owner cancelled'],
  ['--force', 'true', '--reason', 'Owner cancelled'],
  ['--force', 'false', '--reason', 'Owner cancelled'],
  ['--force=1', '--reason', 'Owner cancelled'],
  ['--force', '--force', '--reason', 'Owner cancelled'],
  ['--force'], ['--force', '--reason', ''], ['--force', '--reason', ' \t\n '],
  ['--reason', 'Owner cancelled'],
]) {
  test(`invalid close parameters are refused before runtime: ${JSON.stringify(args)}`, async () => {
    const catalog = catalogFrom();
    let calls = 0;
    const result = await execute(['agent', 'close', '--id', 'worker', ...args], catalog, {
      [closeCommand(catalog).handlerName]: () => { calls++; return { closed: true }; },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(calls, 0, 'parameter rejection cannot reach the runtime handler');
    const failure = JSON.parse(result.stderr);
    assert.ok(failure.code);
    assert.match(JSON.stringify(failure), /force|reason/);
    assert.match(JSON.stringify(failure), /help agent close/);
  });
}

test('both help forms describe the same gate, force syntax, durable reason and reminder/main limits without runtime', async () => {
  const catalog = catalogFrom();
  const handlers = new Proxy({}, { get() { assert.fail('help must not access runtime handlers'); } });
  const first = await execute(['help', 'agent', 'close'], catalog, handlers);
  const second = await execute(['agent', 'close', '--help'], catalog, handlers);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.deepEqual(second, first);
  for (const pattern of [/--id/, /--force/, /--reason/, /report|звіт/i, /event|поді/i, /main/i, /reminder|нагадув/i, /cleanup|зберіг/i, /AGENT_RESULT_PENDING/]) {
    assert.match(first.stdout, pattern);
  }
});

test('public help works from the compiled artifact when conf, state, HOME and tmux are absent', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'raf-close-help-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const artifactPath = join(directory, 'catalog.json');
  await fs.writeFile(artifactPath, JSON.stringify(catalogFrom()));
  const options = { orchestratorRoot: join(directory, 'missing-root'), homeDirectory: join(directory, 'missing-home'), artifactPath };
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = join(directory, 'missing-bin');
    const first = await runProductionCli(['help', 'agent', 'close'], options);
    const second = await runProductionCli(['agent', 'close', '--help'], options);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.deepEqual(second, first);
    assert.match(first.stdout, /--force/);
    assert.match(first.stdout, /--reason/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.equal(await exists(options.orchestratorRoot), false);
  assert.equal(await exists(options.homeDirectory), false);
});

for (const invalid of [
  { default: 'false' }, { default: 0 }, { multiple: true }, { type: 'bool' },
]) {
  test(`compiler rejects incompatible boolean declaration ${JSON.stringify(invalid)}`, () => {
    const source = structuredClone(constants);
    const command = source.commands.find((command: any) => command.path.join(' ') === 'agent close');
    const parameter = command.parameters.find((parameter: any) => parameter.name === 'force');
    assert.ok(parameter, 'approved force declaration is required');
    Object.assign(parameter, invalid);
    assert.throws(() => catalogFrom(source), /force|boolean|bool|default|multiple|valueSources/i);
  });
}

test('compiler rejects a boolean parameter linked to string valueSources', () => {
  const source = structuredClone(constants);
  const command = source.commands.find((command: any) => command.path.join(' ') === 'agent close');
  command.valueSources = { ...(command.valueSources ?? {}), force: 'raf-constants.json#/reportStatuses' };
  assert.throws(() => catalogFrom(source), /force|boolean|valueSources/i);
});

test('force without a report returns failed and a durable trimmed reason after cleanup and reopen', async t => {
  const { f, session } = await liveFixture(t);
  f.seedReminder(eventReminder(session, statusEvent('failed')));
  const reason = 'Власник скасував\n  цей запуск: причина з внутрішніми пробілами';
  const outcome = await f.command(['agent', 'close', '--id', session.addressId, '--force', '--reason', `  ${reason}\t`]);
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
  const value = JSON.parse(outcome.result.stdout);
  assert.equal(value.closed, true);
  assert.equal(value.result, 'failed');
  assert.deepEqual(value.forcedClose, { reason });
  assert.equal(alive(session.process!.pid), false);
  assert.equal(await exists(join(f.tmpRoot, session.runId)), false);
  const saved = f.inspect().sessions.find(value => value.runId === session.runId)!;
  assert.equal(saved.state, 'finished');
  assert.equal(saved.result!.status, 'failed');
  assert.deepEqual((saved.result as any).forcedClose, { reason });
  assert.deepEqual(f.inspect().claims, []);
  assert.deepEqual(f.inspect().admission, []);
  const consumed = await consumedResultEvent(f, session, 'failed');
  assert.equal(await exists(session.launchContext!.reportPath), false, 'raf must not fabricate an executor report');
  const original = { finishedAt: saved.finishedAt, forcedClose: (saved.result as any).forcedClose };
  const sentinel = eventReminder(session, statusEvent('failed'), 'duplicate-event-sentinel');
  f.seedReminder(sentinel);
  await f.command(['agent', 'close', '--id', session.addressId, '--force', '--reason', 'A later reason']);
  const repeated = f.inspect().sessions.find(value => value.runId === session.runId)!;
  assert.deepEqual({ finishedAt: repeated.finishedAt, forcedClose: (repeated.result as any).forcedClose }, original);
  await assertUnchangedEventWitnesses(f, session, [...consumed.reminders, sentinel]);
  const cfg = await json(join(f.directory, 'fixture.json'));
  const reopened = openStateStore(cfg.statePath);
  try {
    const state = createSessionState({ repository: reopened.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => true });
    state.cleanupCompleted(new Date(Date.parse(saved.finishedAt!) + policy.retention.finishedSessionsMs - 1).toISOString());
    assert.deepEqual((reopened.sessionRepository.transaction(tx => tx.getSession(session.runId))!.result as any).forcedClose, { reason });
    state.cleanupCompleted(new Date(Date.parse(saved.finishedAt!) + policy.retention.finishedSessionsMs + 1).toISOString());
    assert.equal(reopened.sessionRepository.transaction(tx => tx.getSession(session.runId)), undefined);
  } finally { reopened.close(); }
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`force preserves an already accepted ${status} result and adds only its reason`, async t => {
    const { f, session } = await liveFixture(t);
    f.seedReminder(eventReminder(session, statusEvent(status)));
    await acceptReport(f, session, status);
    const consumed = await consumedResultEvent(f, session, status);
    const sentinels = [
      eventReminder(session, statusEvent(status), 'duplicate-event-sentinel'),
      eventReminder(session, statusEvent('failed'), 'unexpected-failed'),
    ];
    for (const sentinel of sentinels) f.seedReminder(sentinel);
    if (status === 'succeeded') f.seedReminder({
      ...eventReminder(session, statusEvent('failed'), 'success-unfinished'),
      createdFor: session.addressId, assignedTo: session.addressId,
      binding: null, at: new Date(Date.now() + policy.retention.finishedSessionsMs).toISOString(),
    });
    const outcome = await f.command(['agent', 'close', '--id', session.addressId, '--force', '--reason', forced.reason]);
    assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
    const result = JSON.parse(outcome.result.stdout);
    assert.equal(result.result, status);
    assert.deepEqual(result.forcedClose, { reason: forced.reason });
    assert.equal(f.inspect().sessions.find(value => value.runId === session.runId)!.result!.status, status);
    await assertUnchangedEventWitnesses(f, session, [...consumed.reminders, ...sentinels]);
    if (status === 'succeeded') {
      const reminder = f.inspect().reminders.find(reminder => reminder.id === 'success-unfinished');
      assert.ok(reminder, 'the successful session reminder is retained after close');
      assert.equal(reminder.state, 'closed');
      assert.equal(reminder.closeReason, 'сесія закінчилась з success');
    }
  });
}

test('force cannot bypass unfinished reminders and cannot record a completed forced close while blocked', async t => {
  const { f, session } = await liveFixture(t);
  const reminder = { ...eventReminder(session, statusEvent('failed'), 'unfinished'), createdFor: session.addressId, assignedTo: session.addressId, binding: null, state: 'active' as const };
  f.seedReminder(reminder);
  const inputBefore = await f.input(session.process!.pid);
  const before = f.inspect();
  const outcome = await f.command(['agent', 'close', '--id', session.addressId, '--force', '--reason', forced.reason]);
  assert.equal(outcome.exitCode, 1, JSON.stringify(outcome));
  assert.match(JSON.stringify(outcome.result), /unfinished|нагадув|reminder/i);
  assert.ok(alive(session.process!.pid));
  assert.equal(f.inspect().sessions.find(value => value.runId === session.runId)!.result, undefined);
  assert.deepEqual(f.inspect().claims, before.claims);
  assert.deepEqual(f.inspect().admission, before.admission);
  assert.equal(f.inspect().reminders.find(value => value.id === reminder.id)!.assignedTo, session.addressId);
  await until(() => f.input(session.process!.pid), value => value.length > inputBefore.length && value.includes(reminder.text), 'unfinished reminder delivered to the worker');
});

test('an actual crash without a report still recovers and finalizes without force', async t => {
  const { f, session } = await liveFixture(t, { commands: ['agent ps'] });
  process.kill(session.process!.pid, 'SIGKILL');
  await until(async () => {
    await f.command(['agent', 'ps']);
    return f.inspect().sessions.find(value => value.runId === session.runId);
  }, value => value?.state === 'finished', 'recovery finalizes a dead runner independently of close gate');
  const saved = f.inspect().sessions.find(value => value.runId === session.runId)!;
  assert.equal(saved.result!.status, 'failed');
  assert.equal((saved.result as any).forcedClose, undefined);
  assert.deepEqual(f.inspect().claims, []);
  assert.deepEqual(f.inspect().admission, []);
  assert.equal(await exists(join(f.tmpRoot, session.runId)), false);
});

test('force preserves caller authority: a different live worker cannot close the target', async t => {
  const { f, session } = await liveFixture(t);
  const intruder = await f.run('other-worker', 'implement', ['1.2']);
  assert.equal(intruder.exitCode, 0, JSON.stringify(intruder));
  await until(() => exists(join(f.control, 'other-worker.brief')), Boolean, 'second caller accepted its assignment');
  const before = f.inspect();
  const outcome = await f.as('other-worker', ['agent', 'close', '--id', session.addressId, '--force', '--reason', forced.reason]);
  assert.equal(outcome.exitCode, 1, JSON.stringify(outcome));
  assert.match(JSON.stringify(diagnostic(outcome)), /author|caller|main|дозвол|повноваж|викликач/i);
  assert.ok(alive(session.process!.pid));
  assert.equal(f.inspect().sessions.find(value => value.runId === session.runId)!.result, undefined);
  assert.deepEqual(f.inspect().claims, before.claims);
  assert.deepEqual(f.inspect().admission, before.admission);
});

test('two simultaneous public forced closes retain one result, one first reason and one finished timestamp', async t => {
  const { f, session } = await liveFixture(t);
  f.seedReminder(eventReminder(session, statusEvent('failed')));
  const reasons = ['Concurrent reason A', 'Concurrent reason B'];
  const outcomes = await Promise.all(reasons.map(reason => f.command([
    'agent', 'close', '--id', session.addressId, '--force', '--reason', reason,
  ])));
  assert.ok(outcomes.some(outcome => outcome.exitCode === 0), JSON.stringify(outcomes));
  const saved = f.inspect().sessions.find(value => value.runId === session.runId)!;
  assert.equal(saved.state, 'finished');
  assert.equal(saved.result!.status, 'failed');
  assert.ok(reasons.includes((saved.result as any).forcedClose.reason));
  assert.ok(saved.finishedAt);
  assert.equal(alive(session.process!.pid), false);
  assert.deepEqual(f.inspect().claims, []);
  assert.deepEqual(f.inspect().admission, []);
  const consumed = await consumedResultEvent(f, session, 'failed');
  for (const outcome of outcomes.filter(outcome => outcome.exitCode === 0)) {
    assert.deepEqual(JSON.parse(outcome.result.stdout).forcedClose, (saved.result as any).forcedClose);
  }
  const cfg = await json(join(f.directory, 'fixture.json'));
  const reopened = openStateStore(cfg.statePath);
  try {
    const pending = reopened.sessionRepository.transaction(tx => tx.listPending(), 'read');
    assert.equal(pending.filter(event => event.runId === session.runId && event.event === statusEvent('failed')).length, 0);
    const notices = reopened.closureNotices.listUndelivered().filter(notice => notice.runId === session.runId);
    assert.ok(notices.length <= 1);
  } finally { reopened.close(); }
  const sentinel = eventReminder(session, statusEvent('failed'), 'duplicate-event-sentinel');
  f.seedReminder(sentinel);
  await f.command(['agent', 'close', '--id', session.addressId, '--force', '--reason', 'Third reason']);
  const repeated = f.inspect().sessions.find(value => value.runId === session.runId)!;
  assert.equal(repeated.finishedAt, saved.finishedAt);
  assert.deepEqual((repeated.result as any).forcedClose, (saved.result as any).forcedClose);
  await assertUnchangedEventWitnesses(f, session, [...consumed.reminders, sentinel]);
});

async function withinFixtureWait<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Fixture wait did not settle: ${label}`)), 1000);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, wait: async () => { entered(); await released; } };
}

async function preparationFixture(t: TestContext) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'raf-close-preparation-'));
  const databasePath = join(directory, 'state.sqlite');
  const store = openStateStore(databasePath);
  t.after(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const session: SessionRecord = {
    runId: 'original-run', addressId: 'worker', revision: 1, state: 'running',
    activity: { type: 'implement', project: 'raf', features: ['fixture'], phase: 'implement', cwd: directory },
    process: { pid: 123, startedAt: instant, runner: 'codex', runnerSessionId: 'fixture-native', tmuxSession: 'fixture-tmux', evidence: { runId: 'original-run' } },
  };
  store.sessionRepository.transaction(tx => tx.putSession(session));
  const facts = new Map<string, AcceptedCloseReport>();
  const dependencies: AgentClosePreparationDependencies = {
    repository: store.sessionRepository,
    acceptPendingReport: async selected => selected,
    acceptedReport: (_transaction, selected) => facts.get(selected.runId) ?? null,
    eventForStatus: statusEvent,
  };
  const read = (runId = session.runId) => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
  const pending = () => store.sessionRepository.transaction(tx => tx.listPending(), 'read');
  const putResult = (result: WorkResult, fact?: AcceptedCloseReport) => {
    store.sessionRepository.transaction(tx => {
      const current = tx.getSession(session.runId)!;
      tx.putSession({ ...current, revision: current.revision + 1, result });
    });
    if (fact) facts.set(session.runId, fact);
  };
  const accept = (status: 'succeeded' | 'failed', eventRecorded = true, runId = session.runId) => {
    const result = { status, response: `Accepted ${status}`, proof: { report: report(status), runId: session.runId } };
    putResult(result, { runId, status, eventRecorded });
    return result;
  };
  return { directory, databasePath, store, session, dependencies, facts, read, pending, putResult, accept };
}

async function pendingRejection(action: () => Promise<unknown>, session: SessionRecord) {
  await assert.rejects(action, (error: any) => {
    const serialized = JSON.stringify({ code: error.code, message: error.message, details: error.details, context: error.context });
    assert.match(serialized, /AGENT_RESULT_PENDING/);
    assert.ok(serialized.includes(session.runId));
    return true;
  });
}

for (const variant of ['no-result', 'synthetic-failed', 'event-not-recorded', 'foreign-run'] as const) {
  test(`preparation refuses ${variant}; neither result alone nor a foreign event opens the gate`, async t => {
    const f = await preparationFixture(t);
    if (variant === 'synthetic-failed') f.putResult({ status: 'failed', response: 'Process died without report', proof: null });
    if (variant === 'event-not-recorded') f.accept('succeeded', false);
    if (variant === 'foreign-run') {
      f.accept('succeeded', true, 'previous-run');
      f.store.sessionRepository.transaction(tx => tx.putPending({ id: 'previous-event', runId: 'previous-run', event: statusEvent('succeeded'), payload: { id: f.session.addressId } }));
    }
    const before = f.read();
    const pendingBefore = f.pending();
    await pendingRejection(() => prepareAgentClose(f.dependencies, f.session), f.session);
    assert.deepEqual(f.read(), before);
    assert.deepEqual(f.pending(), pendingBefore);
  });
}

for (const status of ['succeeded', 'failed'] as const) {
  test(`preparation accepts ${status} with an event fact already consumed from pending`, async t => {
    const f = await preparationFixture(t);
    const result = f.accept(status);
    assert.deepEqual(f.pending(), []);
    const prepared = await prepareAgentClose(f.dependencies, f.read()!);
    assert.deepEqual(prepared.result, result);
    assert.deepEqual(f.read()!.result, result);
    assert.deepEqual(f.pending(), [], 'normal preparation must not recreate a consumed result event');
  });
}

test('a valid report awaiting its atomic event transition cannot authorize transport', async t => {
  const f = await preparationFixture(t);
  f.accept('succeeded', false);
  const control = controlFixture(f);
  await pendingRejection(() => control.service.close(f.session.addressId), f.session);
  assert.equal(control.closed.length, 0);
  assert.equal(control.finalized.length, 0);
  assert.equal(f.read()!.state, 'running');
});

type PreparationFixture = Awaited<ReturnType<typeof preparationFixture>>;

function controlFixture(f: PreparationFixture) {
  const closed: string[] = [];
  const finalized: string[] = [];
  const interrupted: string[] = [];
  const delivered: string[] = [];
  const events: string[] = [];
  const finalize: AgentControlDependencies['coordinator']['finalize'] = async session => {
    finalized.push(session.runId);
    f.store.sessionRepository.transaction(tx => {
      const current = tx.getSession(session.runId)!;
      tx.putSession({ ...current, revision: current.revision + 1, state: 'finished' });
    });
    return f.read(session.runId)!;
  };
  const dependencies: AgentControlDependencies = {
    repository: f.store.sessionRepository,
    coordinator: {
      acceptPendingReport: session => f.dependencies.acceptPendingReport(session),
      prepareClose: (session, options) => prepareAgentClose(f.dependencies, session, options),
      observe: async (session, observation) => {
        f.store.sessionRepository.transaction(tx => {
          const current = tx.getSession(session.runId)!;
          tx.putSession({ ...current, revision: current.revision + 1, observation, state: observation.state === 'exited' ? 'exited' : current.state });
        });
        return f.read(session.runId)!;
      },
      updateActivity: async session => session,
      finalize,
      publish: async values => { events.push(...values.map(value => `${value.kind}:${value.session.runId}`)); },
    },
    scanner: { inspect: async identity => ({ state: closed.includes(identity.runnerSessionId) ? 'exited' : 'alive', observedAt: instant, identity, exitCode: 0, evidence: 'fixture process scanner' } as any) },
    authority: { resolve: async () => ({ kind: 'system' }) },
    transport: {
      deliver: async (_identity, text) => { delivered.push(text); return { accepted: true, receiptId: 'fixture-receipt' }; },
      close: async identity => { closed.push(identity.runnerSessionId); },
      interrupt: async identity => { interrupted.push(identity.runnerSessionId); },
    },
    reminders: { sessionEnded: () => ({ allowed: true, unfinished: [] }) },
    projects: ['raf'], agentTypes: ['main', 'implement'], agentPhases: ['implement'],
  };
  const service = new AgentControlService(dependencies);
  const close = (options?: AgentCloseOptions) => (service.close as (id: string, options?: AgentCloseOptions) => Promise<any>).call(service, f.session.addressId, options);
  return { service, close, dependencies, closed, finalized, finalize, interrupted, delivered, events };
}

test('the reason and failed event are durable before the first stop signal, with no fabricated report', async t => {
  const f = await preparationFixture(t);
  const control = controlFixture(f);
  let observedBeforeSignal = false;
  control.dependencies.transport.close = async identity => {
    const reopened = openStateStore(f.databasePath);
    try {
      const snapshot = reopened.sessionRepository.transaction(tx => tx.getSession(f.session.runId), 'read')!;
      assert.equal(snapshot.result!.status, 'failed');
      assert.deepEqual((snapshot.result as any).forcedClose, { reason: forced.reason });
      assert.match(snapshot.result!.response, new RegExp(forced.reason));
      assert.equal((snapshot.result!.proof as any)?.report, undefined);
      const events = reopened.sessionRepository.transaction(tx => tx.listPending(), 'read');
      assert.equal(events.filter(event => event.runId === f.session.runId && event.event === statusEvent('failed')).length, 1);
      observedBeforeSignal = true;
    } finally { reopened.close(); }
    control.closed.push(identity.runnerSessionId);
  };
  const result = await control.close(forced);
  assert.equal(observedBeforeSignal, true);
  assert.equal(result.closed, true);
  assert.deepEqual(result.forcedClose, { reason: forced.reason });
  assert.equal(control.closed.length, 1);
  assert.equal(control.finalized.length, 1);
});

test('a durable-write failure rejects force before any stop or finalization', async t => {
  const f = await preparationFixture(t);
  const control = controlFixture(f);
  const repository = f.dependencies.repository;
  f.dependencies.repository = {
    transaction: (operation, mode) => repository.transaction(tx => operation(new Proxy(tx, {
      get(target, property) {
        if (property === 'putSession' || property === 'putPending') return () => { throw new Error('fixture durable write denied'); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })), mode),
  };
  const before = f.read();
  await assert.rejects(() => control.close(forced), /fixture durable write denied/);
  assert.deepEqual(control.closed, []);
  assert.deepEqual(control.finalized, []);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.pending(), []);
});

test('watcher wins the acceptance race while force is awaiting preparation: accepted result is preserved', async t => {
  const f = await preparationFixture(t);
  const gate = barrier();
  t.after(gate.release);
  f.dependencies.acceptPendingReport = async selected => { await gate.wait(); return selected; };
  const preparing = prepareAgentClose(f.dependencies, f.session, forced);
  await withinFixtureWait(gate.reached, 'watcher race reached report preparation');
  const result = f.accept('succeeded');
  gate.release();
  const prepared = await preparing;
  assert.equal(prepared.result!.status, 'succeeded');
  assert.equal(prepared.result!.response, result.response);
  assert.deepEqual(prepared.result!.proof, result.proof);
  assert.deepEqual((prepared.result as any).forcedClose, { reason: forced.reason });
  assert.equal(f.pending().filter(event => event.event === statusEvent('failed')).length, 0);
});

test('force wins before a late watcher report: the selected failed result cannot become succeeded', async t => {
  const f = await preparationFixture(t);
  await prepareAgentClose(f.dependencies, f.session, forced);
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => true });
  const late = state.acceptWorkResult(f.session.runId, { status: 'succeeded', response: 'Late answer', proof: report('succeeded') }, {
    pending: [{ id: 'late-result', runId: f.session.runId, event: statusEvent('succeeded'), payload: { id: f.session.addressId } }], domain: [],
  });
  assert.equal(late, false);
  assert.equal(f.read()!.result!.status, 'failed');
  assert.deepEqual((f.read()!.result as any).forcedClose, { reason: forced.reason });
  assert.deepEqual(f.pending().map(event => event.event), [statusEvent('failed')]);
});

test('two forced close preparations preserve one first reason and one failed event', async t => {
  const f = await preparationFixture(t);
  const gate = barrier();
  t.after(gate.release);
  f.dependencies.acceptPendingReport = async selected => { await gate.wait(); return selected; };
  const first = prepareAgentClose(f.dependencies, f.session, { force: true, reason: 'First reason' });
  const second = prepareAgentClose(f.dependencies, f.session, { force: true, reason: 'Second reason' });
  const settled = Promise.allSettled([first, second]);
  await withinFixtureWait(gate.reached, 'concurrent preparations reached report acceptance');
  gate.release();
  const outcomes = await withinFixtureWait(settled, 'concurrent preparations finished');
  assert.ok(outcomes.some(value => value.status === 'fulfilled'));
  const saved = f.read()!;
  const reason = (saved.result as any).forcedClose.reason;
  assert.ok(['First reason', 'Second reason'].includes(reason));
  assert.equal(f.pending().filter(event => event.event === statusEvent('failed') && event.runId === f.session.runId).length, 1);
  await prepareAgentClose(f.dependencies, saved, { force: true, reason: 'Retry reason' });
  assert.deepEqual((f.read()!.result as any).forcedClose, { reason });
  assert.equal(f.pending().filter(event => event.event === statusEvent('failed')).length, 1);
});

test('a stale close never switches to a new run reusing the same address', async t => {
  const f = await preparationFixture(t);
  const gate = barrier();
  t.after(gate.release);
  const control = controlFixture(f);
  f.dependencies.acceptPendingReport = async selected => { await gate.wait(); return selected; };
  const closing = control.close(forced).catch(() => undefined);
  await withinFixtureWait(gate.reached, 'stale close reached report preparation');
  const replacement: SessionRecord = {
    ...f.session, runId: 'replacement-run', revision: 1,
    process: { ...f.session.process!, pid: 456, runnerSessionId: 'replacement-native' },
  };
  f.store.sessionRepository.transaction(tx => {
    tx.putSession({ ...tx.getSession(f.session.runId)!, state: 'finished', finishedAt: instant });
    tx.putSession(replacement);
  });
  gate.release();
  await withinFixtureWait(closing, 'stale close finished after address reuse');
  assert.deepEqual(f.read(replacement.runId), replacement);
  assert.ok(!control.closed.includes('replacement-native'));
  assert.ok(!control.finalized.includes(replacement.runId));
});

for (const stage of ['transport', 'finalize'] as const) {
  test(`${stage} failure preserves the first durable reason and never reports a false successful close`, async t => {
    const f = await preparationFixture(t);
    const control = controlFixture(f);
    if (stage === 'transport') control.dependencies.transport.close = async () => { throw new Error('fixture transport unavailable'); };
    if (stage === 'finalize') control.dependencies.coordinator.finalize = async () => { throw new Error('fixture finalization unavailable'); };
    const outcome = await withinFixtureWait(
      control.close(forced).then(value => ({ value, error: null }), error => ({ value: null, error })),
      `${stage} failure returned`,
    );
    assert.ok(outcome.error || outcome.value?.closed === false, 'an unconfirmed operation cannot claim closed:true');
    assert.match(String(outcome.error?.message ?? JSON.stringify(outcome.value)), new RegExp(`fixture ${stage === 'transport' ? 'transport' : 'finalization'} unavailable`));
    assert.deepEqual((f.read()!.result as any).forcedClose, { reason: forced.reason });
    const events = f.pending().filter(event => event.runId === f.session.runId && event.event === statusEvent('failed'));
    assert.equal(events.length, 1);
    assert.equal(f.read()!.finishedAt, undefined);
    control.dependencies.transport.close = async identity => { control.closed.push(identity.runnerSessionId); };
    control.dependencies.coordinator.finalize = control.finalize;
    await withinFixtureWait(control.close({ force: true, reason: 'Retry cannot replace the first reason' }), `${stage} retry finished`);
    assert.deepEqual((f.read()!.result as any).forcedClose, { reason: forced.reason });
    assert.equal(f.pending().filter(event => event.event === statusEvent('failed')).length, 1);
    assert.ok(control.finalized.length <= 1);
  });
}

test('force cannot close main or an unknown process identity; interrupt keeps the session and result', async t => {
  const f = await preparationFixture(t);
  const control = controlFixture(f);
  f.store.sessionRepository.transaction(tx => tx.putSession({ ...f.session, addressId: 'main', activity: { ...f.session.activity!, type: 'main' } }));
  const mainClose = (control.service.close as (id: string, options?: AgentCloseOptions) => Promise<any>).call(control.service, 'main', forced);
  await withinFixtureWait(assert.rejects(mainClose, /main/i), 'main close was refused');
  assert.deepEqual(control.closed, []);
  assert.equal(f.read()!.result, undefined);
  f.store.sessionRepository.transaction(tx => tx.putSession(f.session));
  control.dependencies.scanner.inspect = async () => ({ state: 'unknown', observedAt: instant, error: 'fixture cannot verify process identity' });
  await withinFixtureWait(assert.rejects(() => control.close(forced)), 'unknown identity close was refused');
  assert.deepEqual(control.closed, []);
  assert.equal(f.read()!.result, undefined);
  control.dependencies.scanner.inspect = async identity => ({ state: 'alive', observedAt: instant, identity });
  await withinFixtureWait(control.service.interrupt(f.session.addressId), 'interrupt finished');
  assert.deepEqual(control.interrupted, ['fixture-native']);
  assert.equal(f.read()!.state, 'running');
  assert.equal(f.read()!.result, undefined);
  assert.deepEqual(control.finalized, []);
});

test('force does not signal a different process reported under the selected identity', async t => {
  const f = await preparationFixture(t);
  const control = controlFixture(f);
  control.dependencies.scanner.inspect = async identity => ({
    state: 'alive', observedAt: instant,
    identity: { ...identity, startedAt: '2026-10-23T08:00:01.000Z', runnerSessionId: 'foreign-native' },
  });
  await withinFixtureWait(assert.rejects(() => control.close(forced)), 'foreign identity close was refused');
  assert.deepEqual(control.closed, []);
  assert.deepEqual(control.finalized, []);
  assert.equal(f.read()!.result, undefined);
});
