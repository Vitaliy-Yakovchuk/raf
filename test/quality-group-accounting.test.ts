import assert from 'node:assert/strict';
import test from 'node:test';
import { recordQualityObservation } from '../src/test-run-quality.ts';
import type { QualityGroup, QualityObservation } from '../src/test-run-quality.ts';
import { fixtureGroup, policy } from './helpers/test-run-fixture.ts';
import { group, hash, testId, workspace } from './helpers/quality-fixture.ts';

const key = { project: 'raf', workspace, group };
function state(): QualityGroup {
  return { aggregate: fixtureGroup({ key, timeoutCount: 1, knownRed: [], unknown: [], inFlight: null }), observations: [] };
}
function observation(overrides: Partial<QualityObservation> = {}): QualityObservation {
  return { runId: 'mutant-1', agentId: 'author-a', phase: 'implement', mode: 'mutant', sourceSnapshotDigest: hash('source'), executionSnapshotDigest: hash('mutant-1'), classification: { outcome: 'assertions-failed', failureKinds: ['assertions'], knownRed: [testId], mutationDisposition: 'assertion-killed', reason: null, nextAction: 'fix-implementation' }, ...overrides };
}

test('T10 mutant assertion IDs are retained separately from canonical baseline knownRed', () => {
  const initial = state(), before = structuredClone(initial);
  const changed = recordQualityObservation(initial, key, observation(), policy);
  assert.deepEqual(changed.aggregate.key, key);
  assert.deepEqual(changed.aggregate.knownRed, []);
  assert.equal(changed.aggregate.timeoutCount, 1);
  assert.deepEqual(changed.observations[0].classification.knownRed, [testId]);
  assert.deepEqual(initial, before);
});

test('T10 baseline facts do not inherit prior mutant assertion failure', () => {
  const mutant = recordQualityObservation(state(), key, observation(), policy);
  const green = observation({ runId: 'baseline-2', mode: 'baseline', executionSnapshotDigest: hash('source'), classification: { outcome: 'passed', failureKinds: [], knownRed: [], mutationDisposition: 'not-applicable', reason: null, nextAction: 'complete' } });
  const changed = recordQualityObservation(mutant, key, green, policy);
  assert.equal(changed.aggregate.timeoutCount, 1);
  assert.deepEqual(changed.aggregate.knownRed, []);
  assert.deepEqual(changed.observations.map(item => item.mode), ['mutant', 'baseline']);
});

test('T10 changing mutant, agent or phase preserves one canonical timeout count', () => {
  const first = observation({ classification: { outcome: 'timed-out', failureKinds: ['timeout'], knownRed: [], mutationDisposition: 'timed-out', reason: null, nextAction: 'optimize' } });
  const initial = state(); initial.aggregate.timeoutCount = 0;
  const one = recordQualityObservation(initial, key, first, policy);
  assert.equal(one.aggregate.timeoutCount, 1);
  const second = { ...first, runId: 'mutant-2', agentId: 'author-b', phase: 'qa', executionSnapshotDigest: hash('mutant-2') };
  const two = recordQualityObservation(one, key, second, policy);
  assert.equal(two.aggregate.timeoutCount, 2);
  assert.deepEqual(two.aggregate.key, key);
});

test('T10 replaying one durable observation does not count a timeout twice', () => {
  const timeout = observation({ classification: { outcome: 'timed-out', failureKinds: ['timeout'], knownRed: [], mutationDisposition: 'timed-out', reason: null, nextAction: 'optimize' } });
  const once = recordQualityObservation(state(), key, timeout, policy);
  assert.deepEqual(recordQualityObservation(once, key, timeout, policy), once);
});

test('T10 quality observations cannot reset reached unit remainder policy', () => {
  const initial = state();
  initial.aggregate.timeoutCount = policy.maxGroupTimeouts;
  initial.aggregate.state = 'unverified-remainder';
  initial.aggregate.unexecuted = [testId];
  initial.aggregate.unknown = [testId];
  const changed = recordQualityObservation(initial, key, observation(), policy);
  assert.equal(changed.aggregate.timeoutCount, policy.maxGroupTimeouts);
  assert.equal(changed.aggregate.state, 'unverified-remainder');
  assert.deepEqual(changed.aggregate.unexecuted, [testId]);
  assert.deepEqual(changed.aggregate.unknown, [testId]);
});

test('T10 another execution root cannot replace in-flight ownership', () => {
  const initial = state();
  initial.aggregate.inFlight = { runId: 'other-live-run', deadlineMs: 1234, processIdentity: 'other-process' };
  const before = structuredClone(initial);
  assert.throws(() => recordQualityObservation(initial, key, observation(), policy), error => error instanceof Error && error.message !== 'NotImplemented' && /flight|owner|running/i.test(error.message));
  assert.deepEqual(initial, before);
});

test('T09 recovery without full quality facts cannot invent a kill', () => {
  const partial = observation(); delete (partial as any).classification;
  assert.throws(() => recordQualityObservation(state(), key, partial, policy), error => error instanceof Error && error.message !== 'NotImplemented' && /quality|evidence|classification|incomplete/i.test(error.message));
});
