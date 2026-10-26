import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import type { ServiceHostDependencies } from '../src/service-host.ts';
import { listStartupContextReviewEvents, readStartupContextTrace, recordStartupContextCompletion, type StartupContextDueEvent, type StartupContextTrace } from '../src/startup-context.ts';
import { reserveStartupContextReview } from '../src/startup-context-lifecycle.ts';
import { closeSessionInTransaction } from '../src/session-state.ts';
import type { RuntimeLaunch } from '../src/app-runtime.ts';
import type { LaunchWrapperRequest, PersistentWrapperLaunch } from '../src/launch-wrapper.ts';
import { configuration } from './production-fixture.ts';
import { traceFixture } from './startup-context-fixture.ts';

async function productionReviewStartFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-review-start-'));
  const confRoot = join(root, 'conf');
  const cwd = join(root, 'raf-develop');
  const tmpRoot = join(root, 'run-files');
  const changeId = 'review-agent-startup-context';
  const changeRoot = join(root, 'openspec', 'changes', changeId);
  await Promise.all([mkdir(confRoot), mkdir(cwd), mkdir(tmpRoot), mkdir(changeRoot, { recursive: true })]);
  const statePath = join(root, 'isolated.sqlite');
  const store = openStateStore(statePath);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const flowPath = join(confRoot, 'flow.json');
  await Promise.all([
    writeFile(flowPath, JSON.stringify({ startupContextReview: { runsPerReview: 2 } })),
    writeFile(join(confRoot, 'projects.json'), JSON.stringify({ projects: { raf: { branchPaths: { develop: 'raf-develop', main: 'raf-main' } } } })),
    writeFile(join(changeRoot, 'tasks.md'), '- [ ] 3.1 [spec] Аналіз дорученого пакета\n'),
  ]);
  const batches = [];
  for (const prefix of ['old', 'assigned', 'new']) {
    const first = traceFixture(`${prefix}-z`);
    const second = traceFixture(`${prefix}-a`);
    const traces: StartupContextTrace[] = [{
      ...first,
      reads: [], brief: { tokens: 0, parts: [] }, boundary: { kind: 'run-ended', eventIndex: 0 },
      tokens: { ...first.tokens, totalInput: { value: null, reason: 'Native journal unavailable for this stored run' } },
    }, {
      ...second,
      runner: 'claude', agentType: 'test-scaffold', phase: 'test-scaffold',
      autoloaded: { ...second.autoloaded, skills: { value: [], reason: null } },
      reads: second.reads.map(read => ({ ...read, resultBytes: { value: null, reason: 'Runner did not expose result bytes' } })),
      context: { unnecessary: [], missing: [{ description: 'Stored contract', foundAt: '/spec/stored-contract' }] },
    }];
    let event: StartupContextDueEvent | null = null;
    for (const trace of traces) event = recordStartupContextCompletion(store.startupContextDatabase, {
      runId: trace.runId, phase: trace.phase, trace, finishedAt: '2026-10-22T10:00:00.000Z', flowPath, mainAddress: 'main',
    });
    assert.ok(event);
    batches.push({ event, traces });
  }
  const key = `raf.z2.production-start.${randomUUID()}`;
  const runtimeUrl = new URL(`../src/production-runtime.ts?${key}`, import.meta.url).href;
  const wrapperUrl = new URL('../src/launch-wrapper.ts', import.meta.url).href;
  const starts: { request: LaunchWrapperRequest; inputAtStart: string | null }[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = async (request: LaunchWrapperRequest): Promise<PersistentWrapperLaunch> => {
    const inputAtStart = await readFile(join(request.tmpRoot, request.runId, 'context-review-input.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    starts.push({ request: structuredClone(request), inputAtStart });
    return { runId: request.runId, address: request.address, reportPath: join(request.tmpRoot, request.runId, `${request.address}.json`), wrapperPid: process.pid,
      identity: { pid: process.pid, startedAt: '2026-10-22T10:00:00.000Z', runner: 'codex', runnerSessionId: 'unit-native', tmuxSession: request.tmuxSession, evidence: { runId: request.runId } } };
  };
  t.after(() => { delete globals[key]; });
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === runtimeUrl && specifier === './launch-wrapper.ts') return { url: `z2-wrapper:${key}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === `z2-wrapper:${key}`) return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(wrapperUrl)}; export const launchPersistentWrapper = (...args) => globalThis[${JSON.stringify(key)}](...args);` };
      return next(url, context);
    },
  });
  let runtime: typeof import('../src/production-runtime.ts');
  try { runtime = await import(runtimeUrl); } finally { hook.deregister(); }
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const protocol = { ...settings.runnerProtocols.find((row: any) => row.runner === 'codex'), executable: process.execPath, version: '0.0.0' };
  const services = await runtime.createProductionServices(store, configuration, {
    orchestratorRoot: root, confRoot, artifactPath: join(root, 'catalog.json'), statePath, tmpRoot, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  }, { protocolSettings: [protocol], execute: async command => {
    if (command.executable === process.execPath && command.args.length === 1 && command.args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli 0.0.0', stderr: '' };
    if (command.executable === 'git' && command.args.includes('--show-toplevel')) return { exitCode: 1, stdout: '', stderr: 'Unit workspace has no external Git process' };
    assert.fail(`Unexpected external command: ${command.executable} ${command.args.join(' ')}`);
  } });
  async function start(selected: typeof batches[number], index: number) {
    const runId = `reviewer-${index}`;
    const addressId = `reviewer-${index}`;
    const assignment = { root, baselineArchives: [], changes: [{ id: changeId, items: [{ id: '3.1', description: `[spec] Аналіз пакета context-review.due ${selected.event.id}` }] }] };
    const selection = { status: 'selected' as const, runner: 'codex' as const, model: 'unit-model', effort: 'unit-effort', reason: 'Unit boundary', quota: 'unknown' as const };
    const launch: RuntimeLaunch = { runId, addressId, tmuxSession: `unit-${runId}`, activity: { type: 'spec', project: 'raf', features: [changeId], phase: 'context-review', cwd }, assignment, selection, statePath, tmpRoot,
      writeBoundaries: [changeRoot], taskContext: { parameters: { id: addressId, type: 'spec', project: 'raf', features: [changeId], phase: 'context-review', complexity: 'decision', tasks: [`${changeId}:3.1`] },
        context: { branch: 'develop', outcome: 'Review stored startup context', sources: [], writeBoundaries: [changeRoot], reportSchema: { type: 'object' }, requested: { ramBytes: 0, diskBytes: {} }, requiredFileSystemIds: [] } } };
    const prepared = await services.prepareReport(launch);
    const review = reserveStartupContextReview({ runId, phase: 'context-review', brief: '', assignment }, { database: store.startupContextDatabase });
    store.taskReservationRepository.transaction(tx => {
      tx.putSession({ runId, addressId, revision: 1, state: 'reserved', activity: launch.activity,
        launchContext: { assignment, selection, reportPath: prepared.reportPath, briefPath: join(tmpRoot, runId, 'brief.txt'), contextReview: review } });
      tx.putTaskReservation({ lease: { owner: { runId, addressId, fence: `unit-fence-${runId}` }, revision: 1 }, tasks: [], stage: 'starting', boot: { machineId: 'unit-machine', bootId: 'unit-boot' },
        starter: { pid: process.pid, startedAt: '2026-10-22T10:00:00.000Z', runner: 'codex', runnerSessionId: null, tmuxSession: launch.tmuxSession, evidence: { runId, machineId: 'unit-machine', bootId: 'unit-boot' } } });
    });
    await services.adapter.start({ selection, tmuxSession: launch.tmuxSession, cwd, brief: 'Review the assigned stored traces', reportWrapper: prepared.reportWrapper });
    assert.equal(starts.length, index + 1);
    return { ...starts[index], review, directory: join(tmpRoot, runId) };
  }
  return { batches, starts, start, store };
}

test('production start passes the bound package file and its absolute path to the worker among multiple open packages', async t => {
  const f = await productionReviewStartFixture(t);
  const selected = f.batches[1];
  const started = await f.start(selected, 0);
  const match = /^contextReviewInputPath:\s*(.+)$/m.exec(started.request.brief);
  assert.ok(match, 'The brief actually passed to the worker must name contextReviewInputPath');
  const inputPath = match[1].trim();
  assert.equal(isAbsolute(inputPath), true);
  assert.equal(inputPath, join(started.directory, 'context-review-input.json'));
  assert.equal(dirname(inputPath), dirname(join(started.directory, 'brief.txt')));
  assert.equal(await readFile(join(started.directory, 'brief.txt'), 'utf8'), started.request.brief);
  assert.notEqual(started.inputAtStart, null, 'The input file must exist before the worker starts');
  const readerPaths: string[] = [];
  const agentRead = async (path: string) => {
    readerPaths.push(path);
    assert.equal(path, inputPath, 'The agent reads only the exported run file');
    return JSON.parse(await readFile(path, 'utf8'));
  };
  const payload = await agentRead(inputPath);
  assert.deepEqual(readerPaths, [inputPath]);
  assert.deepEqual(payload, { contextReviewId: selected.event.id, runIds: selected.event.runIds, traces: selected.traces });
  assert.deepEqual(JSON.parse(started.inputAtStart!), payload);
  assert.match(started.request.brief, new RegExp(`^contextReviewId: ${selected.event.id}$`, 'm'));
  assert.ok(started.request.brief.includes(`runIds: ${JSON.stringify(selected.event.runIds)}`));
  for (const other of [f.batches[0], f.batches[2]]) {
    assert.equal(started.request.brief.includes(other.event.id), false);
    for (const runId of other.event.runIds) assert.equal(JSON.stringify(payload).includes(runId), false);
  }
  assert.deepEqual(f.store.startupContextDatabase.prepare('SELECT id, review_run_id, closed_at FROM startup_context_reviews ORDER BY rowid').all().map(row => ({ ...row })),
    f.batches.map(batch => ({ id: batch.event.id, review_run_id: batch === selected ? started.request.runId : null, closed_at: null })));
});

test('production start exports decoded payloads in package order preserving explained nulls and empty lists for separate reviewer runs', async t => {
  const f = await productionReviewStartFixture(t);
  for (const [index, selected] of [f.batches[1], f.batches[0]].entries()) {
    const started = await f.start(selected, index);
    assert.notEqual(started.inputAtStart, null, 'Production start must export stored traces before launching');
    const payload = JSON.parse(started.inputAtStart!);
    assert.deepEqual(payload, { contextReviewId: selected.event.id, runIds: selected.event.runIds, traces: selected.traces });
    assert.deepEqual(payload.traces.map((trace: any) => trace.runId), selected.event.runIds);
    assert.deepEqual(payload.traces[0].tokens.totalInput, { value: null, reason: 'Native journal unavailable for this stored run' });
    assert.equal(payload.traces[0].context, null);
    assert.deepEqual(payload.traces[0].reads, []);
    assert.deepEqual(payload.traces[0].brief.parts, []);
    assert.deepEqual(payload.traces[1].autoloaded.skills, { value: [], reason: null });
    assert.deepEqual(payload.traces[1].reads[0].resultBytes, { value: null, reason: 'Runner did not expose result bytes' });
    for (const trace of selected.traces) assert.deepEqual(readStartupContextTrace(f.store.startupContextDatabase, trace.runId), trace);
  }
});

test('service recovery captures a persisted accepted report before removing its brief and retains uncertain main delivery until package binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'raf-context-runtime-'));
  const homeDirectory = join(root, 'home');
  const stateDirectory = join(homeDirectory, '.raf');
  const directory = join(stateDirectory, 'tmp', 'native-recovery');
  await Promise.all([mkdir(join(root, 'conf')), mkdir(directory, { recursive: true })]);
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  if (!catalog.events.some((event: any) => event.id === 'context-review.due')) catalog.events.push({ id: 'context-review.due', idKind: 'contextReviewId', description: 'fixture' });
  catalog.eventIdKinds.contextReviewId = 'fixture';
  const flow = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
  flow.startupContextReview.runsPerReview = 1;
  await Promise.all([
    writeFile(join(root, 'conf', 'raf.json'), JSON.stringify(settings)),
    writeFile(join(root, 'conf', 'raf-constants.json'), JSON.stringify(catalog)),
    writeFile(join(root, 'conf', 'flow.json'), JSON.stringify(flow)),
    writeFile(join(directory, 'brief.txt'), 'brief to measure before cleanup'),
  ]);
  await writeFile(join(root, 'conf', 'projects.json'), await readFile(new URL('../../conf/projects.json', import.meta.url)));
  await prepareProductionQaFixture(t, { root, home: homeDirectory }, async codeRoot => {
    await mkdir(join(codeRoot, 'dist'), { recursive: true });
    await writeFile(join(codeRoot, 'dist', 'catalog.json'), JSON.stringify({ ...configuration.catalog, constants: catalog }));
  });
  const { createServicePorts }: typeof import('../src/service-host.ts') = await import(pathToFileURL(join(root, 'raf-develop', 'src', 'service-host.ts')).href);
  const store = openStateStore(join(stateDirectory, settings.state.fileName));
  let host: Awaited<ReturnType<typeof createServicePorts>> | undefined;
  t.after(async () => { await host?.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  const context = { unnecessary: [], missing: [{ description: 'contract', foundAt: '/spec/context' }] };
  store.sessionRepository.transaction(tx => tx.putSession({ runId: 'main', addressId: 'main', revision: 1, state: 'running' }));
  store.sessionRepository.transaction(tx => tx.putSession({
    runId: 'native-recovery', addressId: 'worker', revision: 1, state: 'exited',
    activity: { type: 'implement', project: 'raf', features: [], phase: 'implement', cwd: root },
    observation: { state: 'exited', observedAt: at, exitCode: 0, evidence: 'owned runner exit' },
    process: { pid: 123, startedAt: at, runner: 'codex', runnerSessionId: 'missing-native-session', tmuxSession: 'fixture', evidence: {} },
    result: { status: 'succeeded', response: 'accepted', proof: { context } },
    launchContext: { assignment: { root, changes: [] }, selection: { runner: 'codex', model: 'fixture', effort: 'fixture', reason: 'fixture' }, reportPath: join(directory, 'worker.json'), briefPath: join(directory, 'brief.txt') },
  }));
  let attempts = 0;
  const dependencies: ServiceHostDependencies = {
    now: () => Date.parse(at), nextReminderId: () => 'unused', observeProcesses: async () => [],
    effectsForObservation: () => ({ pending: [], domain: [] }), sessionValidation: { verifyMainAuthority: () => false, verifyWorkResult: () => false },
    eventPorts: handle => ({ ...handle.eventRepository, validateId: () => true }),
    deliverReminder: async () => ({ delivered: false }),
    deliverStartupContextEvent: async intent => {
      attempts++;
      assert.equal(intent.event, 'context-review.due');
      throw new Error('main delivery receipt unavailable');
    },
    schedule: () => () => {},
    resourceWait: { readSnapshot: async () => ({ status: 'UNKNOWN', reason: 'unused' }), isClientAlive: () => false, watchResources: () => () => {}, schedule: () => () => {}, loadLastGrant: () => null, saveLastGrant: () => {} },
  };
  host = await createServicePorts({ orchestratorRoot: root, homeDirectory, stateDirectory, socketPath: join(stateDirectory, 'service.sock') }, dependencies);
  await host.recover();
  const trace = readStartupContextTrace(store.startupContextDatabase, 'native-recovery');
  assert.ok(trace && trace.brief.tokens > 0);
  assert.deepEqual(trace.context, context);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const events = listStartupContextReviewEvents(store.startupContextDatabase);
  assert.equal(events.length, 1);
  assert.equal(attempts, 1);
  const uncertain = events[0].mainDelivery!;
  assert.equal(uncertain.state, 'uncertain');
  assert.match(uncertain.reason!, /main delivery receipt unavailable/);
  assert.equal(store.sessionRepository.transaction(tx => tx.listPending()).filter(row => row.event === 'context-review.due').length, 1);
  await host.refresh();
  assert.equal(store.sessionRepository.transaction(tx => tx.listPending()).filter(row => row.event === 'context-review.due').length, 1);
  await host.refresh();
  assert.equal(attempts, 1);
  assert.deepEqual(listStartupContextReviewEvents(store.startupContextDatabase)[0].mainDelivery, uncertain);
  assert.equal(store.sessionRepository.transaction(tx => tx.listPending()).filter(row => row.event === 'context-review.due').length, 1);
  assert.equal(listStartupContextReviewEvents(store.startupContextDatabase)[0].id, events[0].id);
  const assignment = { root, baselineArchives: [], changes: [{ id: 'review-agent-startup-context', items: [{ id: '3.32', description: `[spec] Аналіз пакета context-review.due ${events[0].id}` }] }] };
  reserveStartupContextReview({ runId: 'reviewer', phase: 'context-review', brief: 'review', assignment }, { database: store.startupContextDatabase });
  await host.refresh();
  assert.equal(attempts, 1);
  assert.equal(listStartupContextReviewEvents(store.startupContextDatabase)[0].mainDelivery!.state, 'delivered');
  assert.equal(store.sessionRepository.transaction(tx => tx.listPending()).filter(row => row.event === 'context-review.due').length, 0);
  store.sessionRepository.transaction(tx => {
    const session = { runId: 'reviewer', addressId: 'reviewer', revision: 0, state: 'reserved' as const };
    tx.putSession(session);
    closeSessionInTransaction(tx, session, at);
  });
  const retry = reserveStartupContextReview({ runId: 'retry', phase: 'context-review', brief: 'review', assignment }, { database: store.startupContextDatabase });
  assert.equal(retry.contextReviewId, events[0].id);
});
