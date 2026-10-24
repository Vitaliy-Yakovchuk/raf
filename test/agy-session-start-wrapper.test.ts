import assert from 'node:assert/strict';
import test from 'node:test';
import { runLaunchWrapper } from '../src/launch-wrapper.ts';
import type { LaunchHandshake, LaunchOwnership, LaunchReadiness, LaunchWrapperPorts } from '../src/launch-wrapper.ts';
import type { AgentReportResult } from '../src/agent-report.ts';
import { nativeId, pending, processIdentity, wrapperRequest } from './fixtures/agy-session-start.ts';

function fixture() {
  const request = wrapperRequest('/isolated/q411-wrapper');
  let identity = processIdentity();
  let published = false;
  let report: unknown = {
    status: 'succeeded', answer: 'Fixture completed', commits: [],
    changes: [{ id: 'fixture', items: [{ id: '1.1', status: 'succeeded' }] }],
  };
  const deliveries: string[] = [];
  const handshakes: LaunchHandshake[] = [];
  const accepted: AgentReportResult[] = [];
  const failures: string[] = [];
  const stopped: unknown[] = [];
  const removed: string[] = [];
  const calls: string[] = [];
  const ports: LaunchWrapperPorts = {
    transport: {
      startWithoutInput: async () => { calls.push('start'); },
      waitReady: async () => ({ state: 'ready', runnerSessionId: null, nativeIdentity: structuredClone(pending) }) as unknown as LaunchReadiness,
      ownership: async () => ({ state: 'owned', identity: structuredClone(identity), processKind: 'agent' }),
      deliver: async brief => { calls.push('deliver'); deliveries.push(brief); published = true; },
      waitExit: async () => { calls.push('exit'); return { code: 0, signal: null }; },
      stop: async owner => { stopped.push(structuredClone(owner)); },
    },
    report: {
      fs: { mkdir: async () => {}, readText: async () => published ? JSON.stringify(report) : null,
        removeTree: async path => { removed.push(path); } },
      watch: () => () => {}, now: () => '2026-10-24T08:02:00.000Z',
      verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }),
      diagnostic: async reason => { failures.push(reason); },
    },
    lifecycle: {
      started: async handshake => { calls.push('started'); handshakes.push(structuredClone(handshake)); },
      acceptReport: async result => { accepted.push(structuredClone(result)); },
      finish: async () => { calls.push('finish'); },
      failed: async (_run, reason) => { failures.push(reason); },
    },
    handshake: async handshake => { calls.push('handshake'); handshakes.push(structuredClone(handshake)); },
  };
  return {
    request, ports, deliveries, handshakes, accepted, failures, stopped, removed, calls,
    confirmExternalEvent: () => { identity = processIdentity(nativeId); },
    corruptReport: () => { report = { status: 'succeeded', changes: [] }; },
    identity: () => structuredClone(identity),
  };
}

test('I1/I6 wrapper: ready pending launches, delivers once, accepts an independent succeeded report and exits', async () => {
  const f = fixture();
  await runLaunchWrapper(f.request, f.ports);
  assert.deepEqual(f.deliveries, [f.request.brief]);
  assert.ok(f.handshakes.length);
  for (const handshake of f.handshakes) {
    assert.equal(handshake.identity.runnerSessionId, null);
    assert.deepEqual((handshake.identity as unknown as { nativeIdentity: unknown }).nativeIdentity, pending);
    assert.equal(handshake.runId, f.request.runId);
    assert.equal(handshake.address, f.request.address);
    assert.ok(handshake.reportPath.includes(f.request.runId));
  }
  assert.equal(f.accepted.length, 1);
  assert.equal(f.accepted[0].status, 'succeeded');
  assert.equal(f.failures.length, 0);
  assert.equal(f.stopped.length, 0);
  assert.equal(f.calls.filter(call => call === 'start').length, 1);
  assert.equal(f.calls.includes('finish'), true);
  assert.equal(f.calls.indexOf('exit') > f.calls.indexOf('deliver'), true);
  assert.equal(f.identity().runnerSessionId, null);
});

for (const phase of ['before', 'during', 'after'] as const) {
  test(`I4 wrapper: native confirmation ${phase} delivery does not change ownership or repeat input`, async () => {
    const f = fixture();
    const startIdentity = f.identity();
    const ready = f.ports.transport.waitReady;
    const deliver = f.ports.transport.deliver;
    const exit = f.ports.transport.waitExit;
    if (phase === 'before') f.ports.transport.waitReady = async timeout => {
      await ready(timeout);
      f.confirmExternalEvent();
      return { state: 'ready', runnerSessionId: nativeId,
        nativeIdentity: (f.identity() as unknown as { nativeIdentity: unknown }).nativeIdentity } as LaunchReadiness;
    };
    if (phase === 'during') f.ports.transport.deliver = async brief => {
      f.confirmExternalEvent();
      await deliver(brief);
    };
    if (phase === 'after') f.ports.transport.waitExit = async () => {
      f.confirmExternalEvent();
      return exit();
    };
    await runLaunchWrapper(f.request, f.ports);
    assert.deepEqual(f.deliveries, [f.request.brief]);
    assert.equal(f.identity().runnerSessionId, nativeId);
    assert.deepEqual(f.identity().evidence, startIdentity.evidence);
    assert.equal(f.identity().pid, startIdentity.pid);
    assert.equal(f.identity().startedAt, startIdentity.startedAt);
    assert.equal(f.accepted[0]?.status, 'succeeded');
    assert.equal(f.failures.length, 0);
    assert.equal(f.stopped.length, 0);
    assert.equal(f.calls.filter(call => call === 'start').length, 1);
  });
}

for (const state of ['auth_required', 'permission_required', 'unknown_screen', 'timeout', 'exited'] as const) {
  test(`I2 wrapper: pending cannot bypass ${state} readiness`, async () => {
    const f = fixture();
    f.ports.transport.waitReady = async () => ({ state, reason: `fixture ${state}` });
    await runLaunchWrapper(f.request, f.ports).catch(error => { f.failures.push(String(error)); });
    assert.equal(f.deliveries.length, 0);
    assert.ok(f.failures.some(reason => reason.includes(state)));
  });
}

for (const state of ['unknown', 'mismatch', 'exited'] as const) {
  test(`I2 wrapper: ${state} OS/tmux ownership prevents input despite ready pending`, async () => {
    const f = fixture();
    f.ports.transport.ownership = async () => ({ state, reason: `fixture owner ${state}` });
    await runLaunchWrapper(f.request, f.ports).catch(error => { f.failures.push(String(error)); });
    assert.equal(f.deliveries.length, 0);
    assert.equal(f.stopped.length, 0);
    assert.ok(f.failures.some(reason => reason.includes(state)));
  });
}

test('I2 wrapper: ownership loss between readiness and input is rechecked by the transport', async () => {
  const f = fixture();
  const lost: LaunchOwnership = { state: 'mismatch', reason: 'PID reused before input' };
  f.ports.transport.deliver = async () => {
    f.ports.transport.ownership = async () => lost;
    throw new Error(lost.reason);
  };
  await runLaunchWrapper(f.request, f.ports).catch(error => { f.failures.push(String(error)); });
  assert.equal(f.deliveries.length, 0);
  assert.ok(f.failures.some(reason => reason.includes('PID reused')));
  assert.equal(f.stopped.length, 0);
});

test('I6 wrapper: an unconfirmed delivery never becomes successful merely because native identity is pending', async () => {
  const f = fixture();
  f.ports.transport.deliver = async () => { throw new Error('paste/delivery unconfirmed'); };
  await runLaunchWrapper(f.request, f.ports).catch(error => { f.failures.push(String(error)); });
  assert.equal(f.accepted.some(result => result.status === 'succeeded'), false);
  assert.ok(f.failures.some(reason => reason.includes('delivery unconfirmed')));
  assert.equal(f.deliveries.length, 0);
});

test('I6 wrapper: pending identity preserves ordinary JSON report validation', async () => {
  const f = fixture();
  f.corruptReport();
  await runLaunchWrapper(f.request, f.ports).catch(error => { f.failures.push(String(error)); });
  assert.deepEqual(f.deliveries, [f.request.brief]);
  assert.equal(f.accepted.some(result => result.status === 'succeeded'), false);
  assert.ok(f.failures.length || f.accepted.some(result => result.status === 'failed'));
  assert.equal(f.identity().runnerSessionId, null);
});
