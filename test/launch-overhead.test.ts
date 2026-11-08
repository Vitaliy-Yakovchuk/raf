import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectModel, type ModelCatalog, type RoutingSnapshot } from '../src/model-routing.ts';
import { resolveRunnerRoutingSnapshot } from '../src/runner-routing-snapshot.ts';
import type { RunnerAvailability } from '../src/runner-availability.ts';

const catalog: ModelCatalog = {
  version: 1,
  runners: [{ id: 'codex', initialEnabled: true }, { id: 'agy', initialEnabled: true }, { id: 'claude', initialEnabled: false }],
  models: ['codex', 'agy', 'claude'].map(runner => ({ id: runner, runner, version: '1.0.0', effort: 'high', complexity: 'high', enabled: true })),
  routing: { complexityOrder: ['low', 'high'], taskClassification: {}, runnerPreferences: [{ complexity: 'high', runners: ['codex', 'agy', 'claude'] }], modelTransitions: [], roleModelBindings: {} },
};
const snapshot = (): RoutingSnapshot => ({ runnerEnabled: {}, cliAvailable: {}, quotas: [] });
const available = (runner: string): RunnerAvailability => ({ runner, available: true, path: `/bin/${runner}`, version: '1.0.0', warnings: [] });
const selection = { catalog, request: { complexity: 'high' } };

test('launch probes only the winning runner under the existing model policy', async () => {
  const calls: string[] = [];
  const result = await resolveRunnerRoutingSnapshot(catalog, snapshot(), async runner => { calls.push(runner); return available(runner); }, selection);
  assert.deepEqual(calls, ['codex']);
  assert.equal(selectModel(catalog, result, selection.request).status, 'selected');
  assert.equal(result.cliAvailable.agy, undefined);
});

test('fallback follows transitions and retains version warnings', async () => {
  const policy = { ...catalog, routing: { ...catalog.routing, modelTransitions: [{ from: 'old', to: ['agy', 'codex'] }] } };
  const request = { complexity: 'high', previousModel: 'old' };
  const calls: string[] = [];
  const result = await resolveRunnerRoutingSnapshot(catalog, snapshot(), async runner => {
    calls.push(runner);
    return runner === 'agy' ? { runner, available: false, reason: 'missing executable' } : { ...available(runner), warnings: ['installed version differs'] };
  }, { catalog: policy, request });
  assert.deepEqual(calls, ['agy', 'codex']);
  assert.equal(selectModel(policy, result, request).status, 'selected');
  assert.deepEqual(result.cliWarnings?.codex, ['installed version differs']);
});

test('failure and runner list retain the full availability snapshot', async () => {
  const probe = async (runner: string): Promise<RunnerAvailability> => ({ runner, available: false, reason: `${runner} unavailable` });
  const full = await resolveRunnerRoutingSnapshot(catalog, snapshot(), probe);
  const targeted = await resolveRunnerRoutingSnapshot(catalog, snapshot(), probe, selection);
  assert.deepEqual(targeted, full);
  assert.deepEqual(selectModel(catalog, targeted, selection.request), selectModel(catalog, full, selection.request));
});

test('launch does not wait for an unrelated slow runner probe', async () => {
  const started = performance.now();
  await resolveRunnerRoutingSnapshot(catalog, snapshot(), async runner => {
    if (runner === 'agy') await new Promise(resolve => setTimeout(resolve, 1714));
    return available(runner);
  }, selection);
  const routingMs = performance.now() - started;
  assert.ok(routingMs < 728, `Candidate routing waited ${routingMs} ms for an unrelated probe`);
});
