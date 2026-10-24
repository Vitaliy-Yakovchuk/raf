import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import { setTimeout as pause } from 'node:timers/promises';
import { openStateStore } from '../src/state-store.ts';
import { reconcileProductionReports } from '../src/production-runtime.ts';
import type { RuntimeContext, RuntimeConfiguration } from '../src/app-runtime.ts';
import type { SessionRecord } from '../src/session-state.ts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'raf-z411-recovery-'));
  const confRoot = join(root, 'conf');
  const tmpRoot = join(root, 'reports');
  await fs.mkdir(confRoot);
  await fs.copyFile(new URL('../../conf/raf.json', import.meta.url), join(confRoot, 'raf.json'));
  const catalog = JSON.parse(await fs.readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  const store = openStateStore(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const context = { orchestratorRoot: root, confRoot, tmpRoot, statePath: join(root, 'state.sqlite'), artifactPath: join(root, 'catalog.json'), mode: 'production', resolveCaller: async () => undefined } as RuntimeContext;
  const seed = async (runId: string, state: SessionRecord['state'] = 'exited', accepted = false) => {
    const reportPath = join(tmpRoot, runId, `${runId}.json`);
    await fs.mkdir(join(tmpRoot, runId), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ status: 'failed', answer: 'Retained report', changes: [{ id: 'demo', items: [{ id: 'A.1', status: 'failed' }] }] }));
    await fs.writeFile(join(tmpRoot, runId, 'report-confirmation-pending.json'), JSON.stringify({ runId, exhausted: true }));
    const row = { runId, addressId: runId, state, revision: 1,
      ...(accepted ? { result: { status: 'succeeded', response: 'Accepted', proof: {} } } : {}),
      launchContext: { reportPath, assignment: { root, baselineArchives: [], changes: [{ id: 'demo', items: [{ id: 'A.1', description: 'Work' }] }] }, selection: { runner: 'codex' } },
    } as SessionRecord;
    store.sessionRepository.transaction(tx => tx.putSession(row));
    return row;
  };
  return { root, store, context, catalog: catalog as RuntimeConfiguration['catalog'], seed };
}

test('Z411.S01 closed and accepted runs with exhausted confirmation are never reread during recovery', async t => {
  const f = await fixture(t);
  await f.seed('closed', 'finished');
  await f.seed('accepted', 'exited', true);
  const readFile = fs.readFile;
  let reportReads = 0;
  t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith('/closed.json') || String(args[0]).endsWith('/accepted.json')) reportReads++;
    return readFile(...args);
  });
  assert.deepEqual(await reconcileProductionReports(f.store, f.context, f.catalog), []);
  assert.deepEqual(await reconcileProductionReports(f.store, f.context, f.catalog), []);
  assert.equal(reportReads, 0);
});

test('Z411.S02 service recovery does not reconfirm reports or block readiness on exhausted pending runs', async t => {
  const f = await fixture(t);
  const rows = await Promise.all(['pending-one', 'pending-two', 'pending-three'].map(id => f.seed(id)));
  const home = join(f.root, 'home');
  const stateDirectory = join(home, '.raf');
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.copyFile(new URL('../../conf/projects.json', import.meta.url), join(f.context.confRoot, 'projects.json'));
  await fs.copyFile(new URL('../../conf/raf-constants.json', import.meta.url), join(f.context.confRoot, 'raf-constants.json'));
  await prepareProductionQaFixture(t, { root: f.root, home });
  const codeRoot = join(f.root, 'raf-develop');
  await fs.mkdir(join(codeRoot, 'dist'), { recursive: true });
  await fs.copyFile(new URL('../dist/catalog.json', import.meta.url), join(codeRoot, 'dist/catalog.json'));
  const { createProductionServiceDependencies } = await import(pathToFileURL(join(codeRoot, 'src/production-service-ports.ts')).href);
  const { createServicePorts } = await import(pathToFileURL(join(codeRoot, 'src/service-host.ts')).href);
  const settings = JSON.parse(await fs.readFile(join(f.context.confRoot, 'raf.json'), 'utf8'));
  const serviceStore = openStateStore(join(stateDirectory, settings.state.fileName));
  for (const row of rows) serviceStore.sessionRepository.transaction(tx => tx.putSession(row));
  const before = serviceStore.sessionRepository.transaction(tx => tx.listSessions());
  const context = { orchestratorRoot: f.root, homeDirectory: home, stateDirectory, socketPath: join(stateDirectory, 'service.sock') };
  const dependencies = await createProductionServiceDependencies(context);
  dependencies.disableLegacyResourceWait = true;
  const ports = await createServicePorts(context, dependencies);
  const gate = Promise.withResolvers<void>();
  const readFile = fs.readFile;
  let reportReads = 0;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (rows.some(row => row.launchContext!.reportPath === String(args[0]))) {
      reportReads++;
      await gate.promise;
    }
    return readFile(...args);
  });
  const recovery = ports.recover();
  try {
    assert.equal(await Promise.race([recovery.then(() => 'ready'), pause(100).then(() => 'blocked')]), 'ready', 'Readiness must not await a report confirmation cycle');
    await ports.refresh();
    assert.equal(reportReads, 0, 'Only command/worker may confirm these reports');
    assert.deepEqual(serviceStore.sessionRepository.transaction(tx => tx.listSessions()), before);
    assert.deepEqual(serviceStore.sessionRepository.transaction(tx => tx.listPending()), []);
  } finally {
    if (reportReads) serviceStore.sessionRepository.transaction(tx => { for (const row of rows) tx.putSession({ ...row, revision: 2, state: 'finished' }); });
    gate.resolve();
    await recovery;
    await ports.shutdown();
    serviceStore.close();
  }
});
