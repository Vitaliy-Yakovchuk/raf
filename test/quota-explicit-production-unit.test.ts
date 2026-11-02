import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createAppRuntime, type RuntimeConfiguration, type RuntimeContext, type RuntimeServices } from '../src/app-runtime.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { StateStore } from '../src/state-store.ts';
import { listModelAvailability } from '../src/model-routing.ts';
import { measuredSnapshot, observedAt } from './agy-quota-credits-fixtures.ts';
import type { ScreenQuotaSnapshot } from '../src/quota-screens.ts';

const runtimeUrl = new URL('../src/production-runtime.ts?s5-quota-unit', import.meta.url).href;
const realAvailability = new URL('../src/runner-availability.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && specifier === './runner-availability.ts') return { url: 's5-unit:availability', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 's5-unit:availability') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(realAvailability)};
      export const probeRunnerAvailability = async settings => ({ runner: settings.runner, available: true, path: '/unit/bin/' + settings.runner, version: settings.version, warnings: [] });
    ` };
    return next(url, context);
  },
});
const { createProductionServices } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
test.after(() => hooks.deregister());
const raf = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));

test('ordinary agent run skips the latest exhausted Grok quota after freshness expires and before reset', async t => {
  const observedAt = '2026-11-02T06:19:00.000Z';
  const at = '2026-11-02T07:20:00.000Z';
  const resetAt = '2026-11-07T16:58:00.000Z';
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const snapshot: ScreenQuotaSnapshot = {
    runner: 'grok', observedAt, version: '1.0.70', reliable: true, completeness: 'complete', credits: null, issues: [],
    pools: [{ id: 'shared', label: 'Weekly limit', windows: [{ name: 'weekly', label: 'Weekly limit', state: 'measured', used: 0.97, remaining: 0.03, resetAt, resetUncertaintyMs: 60000, explanation: null }] }],
  };
  let reads = 0;
  const store = {
    getRunnerEnabled: (runner: string) => ['grok', 'codex'].includes(runner),
    initializeRunners: () => {}, close: () => {},
    getQuota: (runner: string) => {
      if (runner !== 'grok') return undefined;
      reads++;
      return { snapshot: structuredClone(snapshot), observedAt, lastAttemptAt: observedAt, error: null };
    },
  } as unknown as StateStore;
  const context: RuntimeContext = {
    orchestratorRoot: '/unit/exhausted', confRoot: '/unit/exhausted/conf', artifactPath: '/unit/exhausted/catalog.json',
    statePath: '/unit/exhausted/home/state.sqlite', tmpRoot: '/unit/exhausted/home/tmp', mode: 'test',
    commandStartedAtMs: 0, commandTimingOwner: 'production', resolveCaller: async () => undefined,
  };
  const configuration = { models, commandTiming: raf.commandTiming, catalog: { commands: ['runner list', 'agent run'].map(handlerName => ({ handlerName, parameters: [] })) } } as unknown as RuntimeConfiguration;
  const services = await createProductionServices(store, configuration, context, {
    protocolSettings: raf.runnerProtocols,
    execute: async () => { throw new Error('Routing must not probe quotas or spawn external processes'); },
  });
  const before = await services.routingSnapshot();
  const beforeSelection = services.selectModel(models, before, { complexity: 'ordinary' });
  assert.equal(beforeSelection.status, 'selected');
  if (beforeSelection.status === 'selected') assert.equal(beforeSelection.runner, 'grok', 'stale positive capacity keeps existing unknown routing');
  snapshot.pools[0].windows[0].used = 1;
  snapshot.pools[0].windows[0].remaining = 0;
  const selectionReached = new Error('unit ordinary selection reached');
  let selected = false;
  const appServices = {
    ...services,
    assignment: { validate: async () => ({ ok: true, snapshot: { root: context.orchestratorRoot, baselineArchives: [], changes: [] } }) },
    resolveTask: async () => ({ branch: 'develop', writeBoundaries: [], sources: [], workspaceWritable: false }),
    route: async () => ({ ok: true, project: 'raf', branch: 'develop', cwd: '/unit/exhausted/raf-develop' }),
    selectModel: (catalog, current, request) => {
      const result = services.selectModel(catalog, current, request);
      assert.equal(result.status, 'selected');
      if (result.status === 'selected') assert.equal(result.runner, 'codex', 'ordinary launch must skip exhausted Grok');
      selected = true;
      throw selectionReached;
    },
  } as RuntimeServices;
  const app = createAppRuntime(context, {
    loadConfiguration: async () => configuration, openStore: async () => store, createServices: async () => appServices,
    nextRunIdentity: () => ({ runId: 'unit-exhausted-run', tmuxSession: 'unit-exhausted-agent' }),
    resolveGitWriteBoundaries: async () => [], now: () => Date.parse(at),
  });
  t.after(() => app.close());
  await assert.rejects(app.handlers['agent run']({ id: 'unit-exhausted-agent', type: 'implement', project: 'raf', phase: 'implement', complexity: 'ordinary', features: ['fix-raf-exhausted-runner-routing'], tasks: ['fix-raf-exhausted-runner-routing:1.1'] }), (error: unknown) => {
    assert.ok(selected, error instanceof Error ? error.message : String(error));
    assert.ok(error instanceof Error && error.message.includes(selectionReached.message));
    return true;
  });
  const listed = await app.handlers['runner list']({}) as ReturnType<typeof listModelAvailability>;
  for (const row of listed.filter(row => row.runner === 'grok')) {
    assert.equal(row.quota, 'exhausted');
    assert.equal(row.available, false);
  }
  t.mock.timers.setTime(Date.parse(resetAt));
  const afterReset = await services.routingSnapshot();
  assert.ok(afterReset.quotas.filter(row => row.runner === 'grok').every(row => row.status === 'unknown'));
  assert.equal(reads, 4, 'every selection and overview reads the latest saved observation');
});

for (const scheduling of ['legacy-fields', 'freshness-only'] as const) {
  for (const state of ['missing', 'fresh', 'stale', 'failed', 'reset'] as const) {
    test(`S.5 production routing shared by runner list and agent run reads ${state} SQLite quota without probe (${scheduling})`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse(observedAt) });
      const rows = structuredClone(raf.runnerProtocols) as ProtocolSettings[];
      if (scheduling === 'freshness-only') for (const row of rows) {
        const collection = row.collection as unknown as Record<string, unknown>;
        delete collection.intervalMs;
        delete collection.failureBackoffMs;
      }
      const snapshot = measuredSnapshot();
      if (state === 'stale') snapshot.observedAt = new Date(Date.parse(observedAt) - 86400000).toISOString();
      if (state === 'reset') for (const pool of snapshot.pools) for (const window of pool.windows) window.resetAt = observedAt;
      const error = state === 'failed' ? JSON.stringify({ code: 'probe_failed', message: 'Last explicit probe failed', remedy: 'Run runner limits' }) : null;
      const saved = state === 'missing' ? undefined : { runner: 'agy', snapshot, lastAttemptAt: observedAt, error };
      const before = structuredClone(saved);
      const reads: string[] = [];
      const effects: unknown[] = [];
      const store = {
        sessionRepository: { transaction: () => { throw new Error('Quota reads must not mutate sessions'); } },
        getRunnerEnabled: () => true,
        initializeRunners: () => {},
        close: () => {},
        getQuota: (runner: string) => { reads.push(runner); return runner === 'agy' ? structuredClone(saved) : undefined; },
        setQuotaSnapshot: (...args: unknown[]) => { effects.push(['snapshot', ...args]); },
        recordQuotaError: (...args: unknown[]) => { effects.push(['error', ...args]); },
        acquireQuotaLease: (...args: unknown[]) => { effects.push(['lease', ...args]); return true; },
      } as unknown as StateStore;
      const context: RuntimeContext = {
        orchestratorRoot: '/unit/s5', confRoot: '/unit/s5/conf', artifactPath: '/unit/s5/catalog.json',
        statePath: '/unit/s5/home/state.sqlite', tmpRoot: '/unit/s5/home/tmp', mode: 'test',
        commandStartedAtMs: 0, commandTimingOwner: 'production', resolveCaller: async () => undefined,
      };
      const configuration = { models, commandTiming: raf.commandTiming, catalog: { commands: ['runner list', 'agent run'].map(handlerName => ({ handlerName, parameters: [] })) } } as unknown as RuntimeConfiguration;
      const services = await createProductionServices(store, configuration, context, {
        protocolSettings: rows,
        execute: async command => { effects.push(command); throw new Error('No external process during quota reads'); },
      });
      const results = await Promise.all(Array.from({ length: 3 }, () => services.routingSnapshot()));
      const selectionReached = new Error('unit selection reached after reading quota');
      let selections = 0;
      const appServices = {
        ...services,
        collectQuotas: async () => { effects.push('unexpected collection'); throw new Error('Only runner limits collects quotas'); },
        assignment: { validate: async () => ({ ok: true, snapshot: { root: context.orchestratorRoot, baselineArchives: [], changes: [] } }) },
        resolveTask: async () => ({ branch: 'develop', writeBoundaries: [], sources: [], workspaceWritable: false }),
        route: async () => ({ ok: true, project: 'raf', branch: 'develop', cwd: '/unit/s5/raf-develop' }),
        selectModel: (_catalog: unknown, snapshot: Awaited<ReturnType<typeof services.routingSnapshot>>) => {
          selections++;
          assert.deepEqual(snapshot.quotas, results[0].quotas);
          throw selectionReached;
        },
      } as unknown as RuntimeServices;
      const app = createAppRuntime(context, {
        loadConfiguration: async () => configuration,
        openStore: async () => store,
        createServices: async () => appServices,
        nextRunIdentity: () => ({ runId: 'unit-s5-run', tmuxSession: 'unit-s5-agent' }),
        resolveGitWriteBoundaries: async () => [],
        now: () => Date.parse(observedAt),
      });
      const listed = await app.handlers['runner list']({}) as ReturnType<typeof listModelAvailability>;
      await assert.rejects(app.handlers['agent run']({ id: 'unit-s5-agent', type: 'implement', project: 'raf', phase: 'implement', complexity: 'ordinary', features: ['complete-raf-flow-contracts'], tasks: ['complete-raf-flow-contracts:S.5'] }), (caught: unknown) => {
        assert.equal(selections, 1, 'agent run reaches model selection through the saved quota snapshot');
        assert.ok(caught instanceof Error && caught.message.includes(selectionReached.message), caught instanceof Error ? caught.message : String(caught));
        return true;
      });
      assert.deepEqual(listed, listModelAvailability(models, results[0]));
      await app.close();
      assert.deepEqual(effects, [], 'no quota lease, probe process or quota writes outside runner limits');
      assert.equal(reads.filter(runner => runner === 'agy').length, 5, 'every routing read must consult the saved SQLite observation');
      assert.deepEqual(saved, before);
      for (const result of results) {
        const availability = listModelAvailability(models, result).filter(row => row.runner === 'agy');
        assert.ok(availability.length > 0);
        for (const row of availability) {
          assert.equal(row.quota, state === 'fresh' ? 'available' : 'unknown');
          if (state !== 'fresh') assert.ok(row.reasons.some(reason => /quota.*unknown/i.test(reason)), JSON.stringify(row));
        }
      }
    });
  }
}
