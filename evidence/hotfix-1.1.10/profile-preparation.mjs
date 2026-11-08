import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync, backup } from 'node:sqlite';

const source = process.cwd();
const root = '/srv/dev/work/orchestrator';
const liveHome = homedir();
const home = await mkdtemp('/tmp/frcll-1-1-10-preparation-');
await mkdir(join(home, '.raf'));
process.env.HOME = process.env.RAF_QA_HOME = home;
const sourceDb = new DatabaseSync(join(liveHome, '.raf/state.sqlite'), { readOnly: true });
const statePath = join(home, '.raf/state.sqlite');
await backup(sourceDb, statePath);
sourceDb.close();
const stages = [], calls = [];
const stage = async (name, action) => {
  const start = performance.now();
  try { return await action(); }
  finally { stages.push({ name, ms: performance.now() - start }); }
};
let store;
try {
  const { enableCompileCache } = await import('node:module');
  enableCompileCache();
  const { createProductionServices } = await stage('runtime-import', () => import('../../src/production-runtime.ts'));
  const { openStateStore } = await import('../../src/state-store.ts');
  const { loadCompiledCatalog } = await import('../../src/compiled-catalog.ts');
  const { executeCommand } = await import('../../src/os-runtime.ts');
  const { settleRuntimeHealthCpu } = await import('../../src/health-cpu-runtime.ts');
  store = await stage('open-copied-state', async () => openStateStore(statePath));
  const catalog = loadCompiledCatalog(join(source, 'dist/catalog.json'));
  const configuration = { catalog, models: catalog.models, commandTiming: { emaAlpha: 0.1 } };
  const context = { orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(source, 'dist/catalog.json'), statePath, tmpRoot: join(home, '.raf/tmp'), mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined };
  const api = await createProductionServices(store, configuration, context);
  let params;
  for (const [change, item, project, type] of [['fix-raf-cli-live-latency', '1.1.10', 'raf', 'hotfix'], ['adopt-ub-mode-quality-gates', '1.2.11.2', 'etchly', 'implement']]) {
    const assignment = await stage('assignment-validation:' + change, () => api.assignment.validate({ root, selections: [{ change, items: [{ id: item }] }] }));
    if (!assignment.ok) throw new Error(JSON.stringify(assignment));
    params = { id: 'profile-preparation', type, project, features: [change], phase: 'implement', complexity: 'ordinary', tasks: [change + ':' + item] };
    await stage('task-context:' + change, () => api.resolveTask(params, assignment.snapshot));
  }
  const request = { complexity: params.complexity, role: params.type };
  const snapshot = await stage('routing-full-diagnostic', () => api.routingSnapshot());
  const targeted = await stage('routing-targeted', () => api.routingSnapshot({ catalog: configuration.models, request }));
  const fullSelection = api.selectModel(configuration.models, snapshot, request);
  const targetSelection = api.selectModel(configuration.models, targeted, request);
  const { mainRoute, hotfixRoute } = await import('../../src/hotfix-host.ts');
  const host = {orchestratorRoot: root, qaHome: home, environment: {}, sandboxExecutable: 'codex'};
  await stage('main-route', () => mainRoute(host));
  await stage('hotfix-route', () => hotfixRoute(host));
  const counts = Object.fromEntries(['sessions', 'result_notices', 'pending_intents'].map(table => [table, store.startupContextDatabase.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
  const active = store.startupContextDatabase.prepare("SELECT state, count(*) n FROM sessions GROUP BY state").all();
  const result = { active, scope: 'Read-only SQLite backup; no route, launch, delivery, credentials or live writes. All runtime writes are confined to the copy; production adapter paths, no executor override.', counts, stages, calls, fullSelection, targetSelection };
  await writeFile(new URL('./preparation-profile.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  store?.close();
  await rm(home, { recursive: true, force: true });
}
