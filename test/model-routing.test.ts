import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyModelTask, selectModel, listModelAvailability, type ModelCatalog, type RoutingSnapshot } from '../src/model-routing.ts';

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
  it('U1 classifies tasks from the current catalog after classification and complexity names change', () => {
    const { catalog, snapshot } = fixture();
    catalog.routing.taskClassification = { judgment: ['investigate'], routine: ['copy'] };
    assert.equal(classifyModelTask(catalog, 'investigate'), 'judgment');
    assert.equal(classifyModelTask(catalog, 'copy'), 'routine');
    catalog.routing.complexityOrder = ['basic', 'advanced'];
    catalog.models[0].complexity = 'basic';
    catalog.models[1].complexity = catalog.models[2].complexity = 'advanced';
    catalog.routing.taskClassification = { basic: ['investigate'], advanced: ['copy'] };
    assert.equal(classifyModelTask(catalog, 'investigate'), 'basic');
    const complexity = classifyModelTask(catalog, 'copy');
    assert.equal(complexity, 'advanced');
    const selected = selectModel(catalog, snapshot, { complexity: complexity! });
    assert.equal(selected.status, 'selected');
    if (selected.status === 'selected') assert.notEqual(selected.model, 'small');
  });

  it('U1 an unclassified task has no implicit complexity or role rule', () => {
    const { catalog } = fixture();
    for (const task of ['implement', 'main', 'hotfix', 'unknown-task']) {
      assert.equal(classifyModelTask(catalog, task), null);
    }
  });

  it('U1 rereads complexity order, effort, transitions and role bindings without provider rules', () => {
    const { catalog, snapshot } = fixture();
    catalog.routing.modelTransitions = [{ from: 'small', to: ['alternative', 'large'] }];
    catalog.models[2].effort = 'custom-effort';
    let selected = selectModel(catalog, snapshot, { complexity: 'judgment', previousModel: 'small', role: 'main' });
    assert.equal(selected.status, 'selected');
    if (selected.status === 'selected') {
      assert.equal(selected.model, 'alternative');
      assert.equal(selected.effort, 'custom-effort');
    }
    catalog.routing.modelTransitions[0].to = ['large', 'alternative'];
    selected = selectModel(catalog, snapshot, { complexity: 'judgment', previousModel: 'small', role: 'main' });
    assert.equal(selected.status, 'selected');
    if (selected.status === 'selected') assert.equal(selected.model, 'large');
    catalog.routing.roleModelBindings.main = ['alternative'];
    selected = selectModel(catalog, snapshot, { complexity: 'judgment', previousModel: 'small', role: 'main' });
    assert.equal(selected.status, 'selected');
    if (selected.status === 'selected') assert.equal(selected.model, 'alternative');
    catalog.routing.complexityOrder.reverse();
    catalog.routing.roleModelBindings = {};
    catalog.routing.modelTransitions = [];
    selected = selectModel(catalog, snapshot, { complexity: 'routine', role: 'main' });
    assert.equal(selected.status, 'selected');
    if (selected.status === 'selected') assert.equal(selected.model, 'small');
    assert.deepEqual(listModelAvailability(catalog, snapshot).find(row => row.model === 'large')?.supportedComplexities, ['judgment']);
  });

  for (const unavailable of ['runner', 'model', 'cli', 'quota'] as const) {
    it(`U2 excludes the preferred candidate when its ${unavailable} is unavailable`, () => {
      const { catalog, snapshot } = fixture();
      catalog.routing.runnerPreferences = [{ complexity: 'judgment', runners: ['beta', 'alpha'] }];
      if (unavailable === 'runner') snapshot.runnerEnabled.beta = false;
      if (unavailable === 'model') catalog.models[2].enabled = false;
      if (unavailable === 'cli') snapshot.cliAvailable.beta = false;
      if (unavailable === 'quota') snapshot.quotas[2].status = 'exhausted';
      const before = structuredClone({ catalog, snapshot });
      const selected = selectModel(catalog, snapshot, { complexity: 'judgment' });
      assert.equal(selected.status, 'selected');
      if (selected.status === 'selected') assert.equal(selected.model, 'large');
      assert.deepEqual({ catalog, snapshot }, before);
    });
  }

  it('U2 unknown quota remains selectable and explicit, without a probe or confirmed capacity', () => {
    const { catalog, snapshot } = fixture();
    snapshot.quotas = [];
    const selected = selectModel(catalog, snapshot, { complexity: 'judgment' });
    assert.equal(selected.status, 'selected');
    if (selected.status === 'selected') {
      assert.equal(selected.quota, 'unknown');
      assert.match(selected.reason, /unknown/i);
    }
    assert.ok(listModelAvailability(catalog, snapshot).every(row => row.available && row.quota === 'unknown'));
    assert.deepEqual(snapshot.quotas, []);
  });

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
