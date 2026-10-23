import { pathToFileURL } from 'node:url';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import type { ServiceHostDependencies } from '../src/service-host.ts';
import { listStartupContextReviewEvents, readStartupContextTrace } from '../src/startup-context.ts';
import { reserveStartupContextReview } from '../src/startup-context-lifecycle.ts';
import { closeSessionInTransaction } from '../src/session-state.ts';

test('service recovery captures a persisted accepted report before removing its brief and retries main delivery', async t => {
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
  await prepareProductionQaFixture(t, { root, home: homeDirectory });
  const { createServicePorts }: typeof import('../src/service-host.ts') = await import(pathToFileURL(join(root, 'raf-develop', 'src', 'service-host.ts')).href);
  const store = openStateStore(join(stateDirectory, settings.state.fileName));
  let host: Awaited<ReturnType<typeof createServicePorts>> | undefined;
  t.after(async () => { await host?.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  const context = { unnecessary: [], missing: [{ description: 'contract', foundAt: '/spec/context' }] };
  store.sessionRepository.transaction(tx => tx.putSession({
    runId: 'native-recovery', addressId: 'worker', revision: 1, state: 'exited',
    activity: { type: 'implement', project: 'raf', features: [], phase: 'implement', cwd: root },
    observation: { state: 'exited', observedAt: at, exitCode: 0, evidence: 'owned runner exit' },
    process: { pid: 123, startedAt: at, runner: 'codex', runnerSessionId: 'missing-native-session', tmuxSession: 'fixture', evidence: {} },
    result: { status: 'succeeded', response: 'accepted', proof: { context } },
    launchContext: { assignment: { root, changes: [] }, selection: { runner: 'codex', model: 'fixture', effort: 'fixture', reason: 'fixture' }, reportPath: join(directory, 'worker.json'), briefPath: join(directory, 'brief.txt') },
  }));
  let delivered = false;
  let attempts = 0;
  const dependencies: ServiceHostDependencies = {
    now: () => Date.parse(at), nextReminderId: () => 'unused', observeProcesses: async () => [],
    effectsForObservation: () => ({ pending: [], domain: [] }), sessionValidation: { verifyMainAuthority: () => false, verifyWorkResult: () => false },
    eventPorts: handle => ({ ...handle.eventRepository, validateId: () => true }),
    deliverReminder: async () => ({ delivered: false }),
    deliverStartupContextEvent: async intent => {
      attempts++;
      assert.equal(intent.event, 'context-review.due');
      if (attempts === 2) throw new Error('main temporarily unavailable');
      return delivered;
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
  assert.equal(store.sessionRepository.transaction(tx => tx.listPending()).filter(row => row.event === 'context-review.due').length, 1);
  await host.refresh();
  assert.equal(store.sessionRepository.transaction(tx => tx.listPending()).filter(row => row.event === 'context-review.due').length, 1);
  delivered = true;
  await host.refresh();
  assert.equal(attempts, 3);
  assert.equal(store.sessionRepository.transaction(tx => tx.listPending()).filter(row => row.event === 'context-review.due').length, 0);
  assert.equal(listStartupContextReviewEvents(store.startupContextDatabase)[0].id, events[0].id);
  reserveStartupContextReview({ runId: 'reviewer', phase: 'context-review', brief: 'review' }, { database: store.startupContextDatabase });
  store.sessionRepository.transaction(tx => {
    const session = { runId: 'reviewer', addressId: 'reviewer', revision: 0, state: 'reserved' as const };
    tx.putSession(session);
    closeSessionInTransaction(tx, session, at);
  });
  const retry = reserveStartupContextReview({ runId: 'retry', phase: 'context-review', brief: 'review' }, { database: store.startupContextDatabase });
  assert.equal(retry.contextReviewId, events[0].id);
});
