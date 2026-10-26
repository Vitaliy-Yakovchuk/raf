import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createAppRuntime, type RuntimeConfiguration, type RuntimeContext, type RuntimeServices } from '../src/app-runtime.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { StateStore } from '../src/state-store.ts';
import { listModelAvailability } from '../src/model-routing.ts';
import { measuredSnapshot, observedAt } from './agy-quota-credits-fixtures.ts';

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
      await assert.rejects(app.handlers['agent run']({ id: 'unit-s5-agent', type: 'implement', project: 'raf', phase: 'implement', complexity: 'ordinary', features: ['complete-raf-flow-contracts'], tasks: ['complete-raf-flow-contracts:S.5'] }), error => error instanceof Error && error.message === selectionReached.message);
      assert.equal(selections, 1, 'agent run reaches model selection through the saved quota snapshot');
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
