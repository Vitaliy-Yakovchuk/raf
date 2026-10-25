import assert from 'node:assert/strict';
import { openStateStore } from '../../../src/state-store.ts';
import { observeRafHealthCpu } from '../../../src/health-cpu.ts';
import { RafCostRuntime } from '../../../src/raf-cost-runtime.ts';
import { validateEventObjectId } from '../../../src/event-catalog.ts';

const store = openStateStore(':memory:');
const domain = store.healthCpu.domain();
assert.equal(validateEventObjectId('rafInstanceId', domain.rafInstanceId), true);
const before = store.healthCpu.readProfile();
before.profile.readAt = new Date(Date.now() - 1000).toISOString();
before.monotonicMs -= 1000;
store.healthCpu.transaction(tx => { tx.state.baseline = before; });
store.recordCostSample({ scope: 'command', command: 'agent ps', stage: 'handler', executor: 'self',
  startedAt: new Date(Date.now() - 900).toISOString(), completedAt: new Date().toISOString(), wallMs: 900,
  cpu: { userMs: 3000, systemMs: 1000, source: 'fixture-counter', unavailableReason: null } });
const ports = { readProfile: async () => store.healthCpu.readProfile(), transaction: async fn => store.healthCpu.transaction(fn), reportUnavailable: reason => { throw new Error(reason); } };
const context = { ...domain, enabled: true, entry: 'runtime', configuration: { health: { cpuWindowMs: 1, cpuThresholdCores: 1 } } };
const complete = await observeRafHealthCpu(context, ports);
assert.equal(complete.availability, 'complete');
assert.equal(complete.exceeded, true);
assert.equal(complete.cpuUserMs, 3000);
const events = () => store.eventRepository.transaction(tx => tx.listPending());
assert.equal(events().length, 1);
assert.equal(events()[0].event.id, domain.rafInstanceId);
await observeRafHealthCpu(context, ports);
assert.equal(events().length, 1);
const profile = new RafCostRuntime(store, { scope: 'command', command: 'agent ps' }, '/srv/dev/work/orchestrator', 'handler');
assert.equal(store.healthCpu.readProfile().coverage.openOwnIntervals, 1);
profile.finish();
assert.equal(store.healthCpu.readProfile().coverage.openOwnIntervals, 0);
assert.equal(store.healthCpu.readProfile().coverage.attributionComplete, true);
const sample = store.readCostProfile().rows[0];
store.costProfileRepository.update(sample, row => row);
assert.equal(store.healthCpu.readProfile().coverage.attributionComplete, false);
const saved = store.healthCpu.readProfile();
assert.throws(() => store.healthCpu.transaction(tx => { tx.state.baseline = null; throw new Error('rollback'); }), /rollback/);
assert.deepEqual(store.healthCpu.readProfile().accumulationId, saved.accumulationId);
store.startupContextDatabase.exec('DROP TABLE raf_health_cpu');
assert.doesNotThrow(() => store.recordCostSample({ scope: 'command', command: 'agent ps', stage: 'handler', executor: 'self',
  startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), wallMs: 0,
  cpu: { userMs: 0, systemMs: 0, source: 'fixture-counter', unavailableReason: null } }));
store.close();
console.log(JSON.stringify({ kind: 'in-memory SQLite wiring probe; fixture CPU counters, not live CPU QA', outcome: 'passed', checks: ['domain UUID', 'coverage and profile deltas', 'atomic event with boundary', 'repeat deduplication', 'runtime interval open and close', 'buffered profile merge metadata', 'unknown metadata remains partial', 'transaction rollback', 'monitoring storage failure preserves profile operation'] }));
