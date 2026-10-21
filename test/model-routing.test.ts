import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectModel, listModelAvailability, type ModelCatalog, type RoutingSnapshot } from '../src/model-routing.ts';

function fixture(): { catalog: ModelCatalog; snapshot: RoutingSnapshot } {
  return {
    catalog: {
      version: 1,
      runners: [{ id: 'alpha', initialEnabled: true }, { id: 'beta', initialEnabled: false }],
      models: [
        { id: 'small', version: '1', runner: 'alpha', effort: 'low', complexity: 'routine', enabled: true, quotaPool: 'small-pool' },
        { id: 'large', version: '1', runner: 'alpha', effort: 'high', complexity: 'judgment', enabled: true, quotaPool: 'large-pool' },
        { id: 'alternative', version: '1', runner: 'beta', effort: 'medium', complexity: 'judgment', enabled: true, quotaPool: 'other-pool' },
      ],
      routing: { complexityOrder: ['routine', 'judgment'], taskClassification: {}, runnerPreferences: [], modelTransitions: [], roleModelBindings: {} },
    },
    snapshot: {
      runnerEnabled: { alpha: true, beta: true }, cliAvailable: { alpha: true, beta: true },
      quotas: [
        { runner: 'alpha', pool: 'small-pool', status: 'available' },
        { runner: 'alpha', pool: 'large-pool', status: 'available' },
        { runner: 'beta', pool: 'other-pool', status: 'available' },
      ],
    },
  };
}

describe('model-routing configured selection', () => {
  it('uses configured runner priority and returns actual effort with a reason', () => {
    const { catalog, snapshot } = fixture();
    catalog.routing.runnerPreferences = [{ complexity: 'judgment', runners: ['beta', 'alpha'] }];
    const result = selectModel(catalog, snapshot, { complexity: 'judgment', role: 'implement' });
    assert.equal(result.status, 'selected');
    if (result.status !== 'selected') return;
    assert.equal(result.runner, 'beta');
    assert.equal(result.model, 'alternative');
    assert.equal(result.effort, 'medium');
    assert.ok(result.reason.trim());
    assert.equal(result.quota, 'available');
    assert.equal('history' in result, false);
  });

  it('takes changed configuration on the next call and does not bind an unconfigured role', () => {
    const { catalog, snapshot } = fixture();
    for (const preferred of ['beta', 'alpha']) {
      catalog.routing.runnerPreferences = [{ complexity: 'judgment', runners: [preferred] }];
      const result = selectModel(catalog, snapshot, { complexity: 'judgment', role: 'hotfix' });
      assert.equal(result.status, 'selected');
      if (result.status === 'selected') assert.equal(result.runner, preferred);
    }
  });

  it('honors explicit role bindings', () => {
    const { catalog, snapshot } = fixture();
    catalog.routing.roleModelBindings.review = ['alternative'];
    const result = selectModel(catalog, snapshot, { complexity: 'judgment', role: 'review' });
    assert.equal(result.status, 'selected');
    if (result.status === 'selected') assert.equal(result.model, 'alternative');
  });

  it('uses configured transitions when the previous model pool is exhausted', () => {
    const { catalog, snapshot } = fixture();
    snapshot.quotas[1].status = 'exhausted';
    catalog.routing.modelTransitions = [{ from: 'large', to: ['alternative'] }];
    const result = selectModel(catalog, snapshot, { complexity: 'judgment', previousModel: 'large' });
    assert.equal(result.status, 'selected');
    if (result.status === 'selected') assert.equal(result.model, 'alternative');
  });

  it('does not disable an independent quota pool on the same runner', () => {
    const { catalog, snapshot } = fixture();
    snapshot.runnerEnabled.beta = false;
    snapshot.quotas[0].status = 'exhausted';
    const result = selectModel(catalog, snapshot, { complexity: 'judgment' });
    assert.equal(result.status, 'selected');
    if (result.status === 'selected') assert.equal(result.model, 'large');
  });

  it('rejects new selection explicitly when no model is enabled', () => {
    const { catalog, snapshot } = fixture();
    snapshot.runnerEnabled = { alpha: false, beta: false };
    const result = selectModel(catalog, snapshot, { complexity: 'routine' });
    assert.equal(result.status, 'waiting');
    if (result.status === 'waiting') {
      assert.equal(result.code, 'NO_ENABLED_MODELS');
      assert.ok(result.reason.trim());
    }
  });

  it('does not downgrade required complexity when only a small model remains', () => {
    const { catalog, snapshot } = fixture();
    catalog.models[1].enabled = false;
    snapshot.cliAvailable.beta = false;
    const result = selectModel(catalog, snapshot, { complexity: 'judgment' });
    assert.equal(result.status, 'waiting');
    if (result.status === 'waiting') assert.equal(result.code, 'NO_SUITABLE_CAPACITY');
  });

  it('uses persisted switches over initial defaults and initializes only absent switches', () => {
    const { catalog, snapshot } = fixture();
    snapshot.runnerEnabled.alpha = false;
    const enabled = selectModel(catalog, snapshot, { complexity: 'judgment' });
    assert.equal(enabled.status, 'selected');
    if (enabled.status === 'selected') assert.equal(enabled.runner, 'beta');
    delete snapshot.runnerEnabled.beta;
    assert.equal(selectModel(catalog, snapshot, { complexity: 'judgment' }).status, 'waiting');
  });

  it('does not present missing quota observations as confirmed capacity', () => {
    const { catalog, snapshot } = fixture();
    snapshot.quotas = [];
    const listing = listModelAvailability(catalog, snapshot);
    assert.equal(listing.length, 3);
    assert.ok(listing.every(model => model.quota === 'unknown'));
    const result = selectModel(catalog, snapshot, { complexity: 'judgment' });
    if (result.status === 'selected') assert.equal(result.quota, 'unknown');
    else assert.ok(result.reason.trim());
  });

  it('lists configuration separately from actual disabled availability', () => {
    const { catalog, snapshot } = fixture();
    snapshot.runnerEnabled.beta = false;
    const model = listModelAvailability(catalog, snapshot).find(item => item.model === 'alternative');
    assert.ok(model);
    assert.equal(model.enabled, false);
    assert.equal(model.available, false);
    assert.equal(model.configuredComplexity, 'judgment');
    assert.deepEqual(model.supportedComplexities, ['routine', 'judgment']);
    assert.ok(model.reasons.length);
  });
});
