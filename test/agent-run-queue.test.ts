import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgentWithQueue, reconcileAgentQueue } from '../src/agent-run-queue.ts';
import type {
  AgentQueueAdmission, AgentQueueCheck, AgentQueueCleanup, AgentQueueObservation,
  AgentQueueProcess, AgentQueueRecord, AgentQueueRequest, AgentQueueValidation,
  AgentRunQueuePorts, AgentRunQueueResult,
} from '../src/agent-run-queue.ts';
import type { AdmissionSnapshot } from '../src/admission-snapshot.ts';
import type { CommandFailureContext } from '../src/cli.ts';
import type { ResourceWaitCommandResult } from '../src/resource-wait-protocol.ts';

const queueId = '53008034-6049-421a-97c3-1866fc54be40';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function failure(code: string, reason = code): CommandFailureContext {
  return {
    code, message: reason, stage: 'agent-run', source: 'unit-port', sourceCode: code,
    reason, received: { agentId: 'queue-worker' }, expected: 'valid unclaimed assignment',
    found: null, completed: [], pending: ['start-agent'], retrySafe: false,
    remediation: ['Revalidate the assignment with main.'],
  };
}

function admission(level: AdmissionSnapshot['level'] = 'HOTFIX_ONLY'): AdmissionSnapshot {
  return {
    level, requestedTier: 'normal', allowed: level === 'ANY_RUN',
    reasons: [`synthetic ${level}`],
    measurement: {
      machineId: 'unit-machine', loadAverage1m: null, availableCores: null,
      totalRamBytes: null, availableRamBytes: null, memoryPressure: null, fileSystems: [],
    },
    thresholds: null, reservation: { requested: { ramBytes: 8, diskBytes: { dev: 16 } }, unused: { ramBytes: 0, diskBytes: {} } },
    remaining: null, estimate: { status: 'KNOWN', sources: ['unit-estimate-port'], reason: null }, queueId,
  };
}

type Call = { name: string; input: unknown };

function fixture() {
  const controller = new AbortController();
  const request: AgentQueueRequest = {
    orchestratorRoot: '/unit/root', homeDirectory: '/unit/qa-home', developmentDirectory: '/unit/root/raf-develop',
    project: 'raf', agentId: 'queue-worker', agentType: 'implement',
    owner: { runId: 'launch-1', fence: 'launch-fence-1' },
    clientIdentity: { pid: 101, startedAt: 'client-start', machineId: 'unit-machine', bootId: 'unit-boot' },
    selections: [{ change: 'fix-raf-load-admission', items: ['4.2', '4.3'] }],
    coordinator: null, signal: controller.signal,
  };
  const validation: AgentQueueValidation = {
    fingerprint: 'assignment-revision-1',
    assignment: {
      root: request.orchestratorRoot, baselineArchives: [],
      changes: [{ id: 'fix-raf-load-admission', items: [{ id: '4.2', description: 'implement queue' }, { id: '4.3', description: 'verify queue' }] }],
    },
    requested: { ramBytes: 8, diskBytes: { dev: 16 } }, requiredFileSystemIds: ['dev'],
  };
  const record: AgentQueueRecord = {
    queueId, requestId: 'launch-request-1', agentId: request.agentId, owner: request.owner,
    clientIdentity: request.clientIdentity, coordinator: request.coordinator,
    eventHandle: { queueId, generation: 7, requestId: 'launch-request-1', fence: request.owner.fence },
  };
  const process: AgentQueueProcess = { pid: 202, startedAt: 'agent-start', machineId: 'unit-machine', bootId: 'unit-boot', runnerSessionId: 'runner-1' };
  const calls: Call[] = [];
  const progress: string[] = [];
  const enteredWait = deferred<void>();
  const state = {
    checks: [{ ok: true, validation }] as AgentQueueCheck[],
    initial: { kind: 'waiting', record, admission: admission() } as AgentQueueAdmission,
    rechecks: [{ kind: 'reserved', record, admission: admission('ANY_RUN') }] as AgentQueueAdmission[],
    waits: [] as ResourceWaitCommandResult[],
    waitGate: null as Promise<ResourceWaitCommandResult> | null,
    startError: null as Error | null,
    readinessError: null as Error | null,
    commit: true,
    transition: true,
    observation: { owner: 'client', client: 'dead', agent: 'dead', reason: 'verified client identity died' } as AgentQueueObservation,
    cleanup: { state: 'released', reason: 'verified cleanup', completed: ['release-client-claims'], pending: [] } as AgentQueueCleanup,
  };
  function log(name: string, input: unknown): void { calls.push({ name, input }); }
  const ports: AgentRunQueuePorts = {
    validate: async (input, previous) => {
      log('validate', { request: input, previous });
      return state.checks.length > 1 ? state.checks.shift()! : state.checks[0];
    },
    claimAndAdmit: async input => { log('claimAndAdmit', input); return state.initial; },
    waitForResources: async input => {
      log('waitForResources', input);
      enteredWait.resolve();
      return state.waitGate ?? state.waits.shift() ?? permit(`permit-${calls.filter(call => call.name === 'waitForResources').length}`);
    },
    transition: async (input, phase) => { log('transition', { record: input, phase }); return state.transition; },
    recheckAndReserve: async input => {
      log('recheckAndReserve', input);
      return state.rechecks.length > 1 ? state.rechecks.shift()! : state.rechecks[0];
    },
    start: async (input, checked) => {
      log('start', { record: input, validation: checked });
      if (state.startError) throw state.startError;
      return process;
    },
    verifyReady: async (input, spawned) => {
      log('verifyReady', { record: input, process: spawned });
      if (state.readinessError) throw state.readinessError;
      return process;
    },
    commitReady: async (input, ready) => { log('commitReady', { record: input, process: ready }); return state.commit; },
    cleanup: async (input, reason, detail) => { log('cleanup', { record: input, reason, detail }); return state.cleanup; },
    observe: async input => { log('observe', input); return state.observation; },
    writeStderr: line => { progress.push(line); },
  };
  return { request, validation, record, process, calls, progress, enteredWait, state, ports, controller };
}

type Fixture = ReturnType<typeof fixture>;

function permit(requestId: string): ResourceWaitCommandResult {
  return { exitCode: 0, kind: 'permit', permit: { requestId, serviceEpoch: 'service-epoch-1', grantedAt: 123 }, reservation: false };
}

function waitError(reason: string): ResourceWaitCommandResult {
  return {
    exitCode: 1, kind: 'error', diagnostic: {
      reason, details: `exact ${reason} diagnostic`, remediation: 'Inspect service readiness before retrying.',
      received: 'channel unavailable', expected: 'confirmed permit', completed: ['request-created'], pending: ['permit'],
    },
  };
}

function names(f: Fixture): string[] { return f.calls.map(call => call.name); }
function count(f: Fixture, name: string): number { return f.calls.filter(call => call.name === name).length; }
function input(f: Fixture, name: string, index = 0): any { return f.calls.filter(call => call.name === name)[index]?.input; }
function messages(f: Fixture): any[] { return f.progress.flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))); }

function success(result: AgentRunQueueResult, waited: boolean): any {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1, 'stdout has one final JSON object');
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.queue, { queueId, waited });
  return body;
}

function error(result: AgentRunQueueResult): any {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  const body = JSON.parse(result.stderr);
  assert.ok(body.code);
  assert.ok(body.details);
  assert.ok(Array.isArray(body.details.completed));
  assert.ok(Array.isArray(body.details.pending));
  return body;
}

async function waiting(f: Fixture): Promise<{ running: Promise<AgentRunQueueResult>; finish: (value: ResourceWaitCommandResult) => void }> {
  const gate = deferred<ResourceWaitCommandResult>();
  f.state.waitGate = gate.promise;
  const running = runAgentWithQueue(f.request, f.ports);
  await Promise.race([
    f.enteredWait.promise,
    running.then(() => { assert.fail('agent run settled before its pending permit'); }),
  ]);
  return { running, finish: gate.resolve };
}

test('agent-queue fast path reserves and confirms readiness without service access', async () => {
  const f = fixture();
  f.record.eventHandle = null;
  f.state.initial = { kind: 'reserved', record: f.record, admission: admission('ANY_RUN') };
  success(await runAgentWithQueue(f.request, f.ports), false);
  assert.equal(count(f, 'waitForResources'), 0);
  assert.equal(count(f, 'validate'), 1);
  assert.equal(count(f, 'claimAndAdmit'), 1);
  assert.equal(count(f, 'start'), 1);
  assert.equal(count(f, 'verifyReady'), 1);
  assert.equal(count(f, 'commitReady'), 1);
  assert.equal(count(f, 'cleanup'), 0);
  assert.deepEqual(messages(f), []);
  assert.ok(names(f).indexOf('claimAndAdmit') < names(f).indexOf('start'));
  assert.ok(names(f).indexOf('verifyReady') < names(f).indexOf('commitReady'));
});

test('agent-queue resource refusal waits once, revalidates and starts exactly once', async () => {
  const f = fixture();
  success(await runAgentWithQueue(f.request, f.ports), true);
  assert.deepEqual(names(f), ['validate', 'claimAndAdmit', 'waitForResources', 'transition', 'validate', 'recheckAndReserve', 'transition', 'start', 'verifyReady', 'commitReady']);
  assert.deepEqual(input(f, 'validate', 1).previous, f.validation);
  assert.deepEqual(input(f, 'recheckAndReserve').permit, (permit('permit-1') as Extract<ResourceWaitCommandResult, { kind: 'permit' }>).permit);
});

test('agent-queue waiting is a live pending client with no spawn or resource reservation', async () => {
  const f = fixture();
  const run = await waiting(f);
  assert.deepEqual(names(f), ['validate', 'claimAndAdmit', 'waitForResources']);
  assert.equal(count(f, 'recheckAndReserve'), 0);
  assert.equal(count(f, 'start'), 0);
  assert.equal(count(f, 'commitReady'), 0);
  run.finish(permit('permit-pending'));
  success(await run.running, true);
});

test('agent-queue waiting stderr is one bounded JSON line with stable launch identity', async () => {
  const f = fixture();
  const run = await waiting(f);
  assert.deepEqual(messages(f), [{ kind: 'launch-queue.waiting', queueId, requestId: f.record.requestId, agentId: f.request.agentId, admission: f.state.initial.kind === 'refused' ? null : f.state.initial.admission }]);
  assert.equal(f.progress.length, 1, 'no repeated poll snapshots while blocked');
  assert.ok(f.progress[0].endsWith('\n'));
  run.finish(permit('permit-stdout'));
  const body = success(await run.running, true);
  assert.equal(body.queue.queueId, messages(f)[0].queueId);
});

for (const stage of ['waiting', 'rechecking', 'starting']) {
  test(`agent-queue joins nonempty ${stage} predecessors even when resources suffice`, async () => {
    const f = fixture();
    f.state.initial = { kind: 'waiting', record: f.record, admission: admission('ANY_RUN') };
    f.state.initial.admission.reasons = [`predecessor ${stage} prevents fast path`];
    const run = await waiting(f);
    assert.equal(count(f, 'start'), 0);
    assert.equal(count(f, 'recheckAndReserve'), 0);
    assert.equal(messages(f).length, 1);
    run.finish(permit(`permit-after-${stage}`));
    success(await run.running, true);
    assert.equal(count(f, 'claimAndAdmit'), 1);
    assert.equal(count(f, 'waitForResources'), 1);
  });
}

test('agent-queue resource race reenters wait with same launch claim and new permit request', async () => {
  const f = fixture();
  const shortage = admission('NO_RESOURCES');
  f.state.rechecks.unshift({ kind: 'waiting', record: f.record, admission: shortage });
  success(await runAgentWithQueue(f.request, f.ports), true);
  assert.equal(count(f, 'waitForResources'), 2);
  assert.equal(count(f, 'claimAndAdmit'), 1, 'reentry retains the original claim');
  assert.equal(count(f, 'validate'), 3);
  assert.equal(count(f, 'start'), 1);
  assert.equal(count(f, 'commitReady'), 1);
  assert.equal(count(f, 'cleanup'), 0);
  assert.deepEqual(messages(f).map(message => message.requestId), [f.record.requestId, f.record.requestId]);
  assert.deepEqual(messages(f).map(message => message.admission), [admission(), shortage]);
  assert.deepEqual([input(f, 'recheckAndReserve', 0).permit.requestId, input(f, 'recheckAndReserve', 1).permit.requestId], ['permit-1', 'permit-2']);
  assert.deepEqual(input(f, 'recheckAndReserve', 1).record, f.record);
});

for (const agentType of ['hotfix', 'implement', 'test-scaffold', 'qa', 'coordinator', 'spec', 'design']) {
  test(`agent-queue ${agentType} forwards only its conf level to the existing resource wait port`, async () => {
    const f = fixture();
    f.request.agentType = agentType;
    const tier = agentType === 'hotfix' ? 'hotfix' : 'normal';
    f.state.initial = { kind: 'waiting', record: f.record, admission: { ...admission('NO_RESOURCES'), requestedTier: tier } };
    f.state.rechecks = [{ kind: 'reserved', record: f.record, admission: { ...admission('ANY_RUN'), requestedTier: tier } }];
    success(await runAgentWithQueue(f.request, f.ports), true);
    assert.equal(input(f, 'claimAndAdmit').tier, tier);
    assert.equal(input(f, 'recheckAndReserve').tier, tier);
    assert.deepEqual(input(f, 'waitForResources'), {
      orchestratorRoot: f.request.orchestratorRoot, homeDirectory: f.request.homeDirectory,
      developmentDirectory: f.request.developmentDirectory, level: tier, requested: { ramBytes: 8, diskBytes: { dev: 16 } }, signal: f.controller.signal,
    });
  });
}

for (const code of ['INVALID_ASSIGNMENT', 'OPENSPEC_UNAVAILABLE', 'RUNNER_UNAVAILABLE', 'WORKSPACE_UNAVAILABLE', 'UNAUTHORIZED']) {
  test(`agent-queue initial ${code} never reaches queue, service or spawn`, async () => {
    const f = fixture();
    f.state.checks = [{ ok: false, failure: failure(code) }];
    const body = error(await runAgentWithQueue(f.request, f.ports));
    assert.equal(body.code, code);
    assert.equal(body.details.admission, null);
    assert.deepEqual(names(f), ['validate']);
    assert.deepEqual(messages(f), []);
  });
}

test('agent-queue UNKNOWN admission does not wait or turn uncertainty into permission', async () => {
  const f = fixture();
  const unknown = admission('UNKNOWN');
  f.state.initial = { kind: 'refused', admission: unknown, failure: failure('RESOURCE_UNAVAILABLE', 'unknown estimate or measurement') };
  const body = error(await runAgentWithQueue(f.request, f.ports));
  assert.deepEqual(body.details.admission, unknown, 'forward last decision without regenerating its JSON');
  assert.deepEqual(names(f), ['validate', 'claimAndAdmit']);
  assert.deepEqual(messages(f), []);
});

for (const change of ['item removed', 'item description changed', 'item completed', 'change archived and reused', 'owner changed', 'runner disabled', 'workspace changed']) {
  test(`agent-queue permit cannot bypass revalidation: ${change}`, async () => {
    const f = fixture();
    const rejected = failure('ASSIGNMENT_CHANGED', change);
    f.state.checks.push({ ok: false, failure: rejected });
    const body = error(await runAgentWithQueue(f.request, f.ports));
    assert.equal(body.code, rejected.code);
    assert.equal(body.details.reason, change);
    assert.equal(count(f, 'recheckAndReserve'), 0);
    assert.equal(count(f, 'start'), 0);
    assert.equal(count(f, 'commitReady'), 0);
    assert.equal(count(f, 'cleanup'), 1);
    assert.deepEqual(input(f, 'cleanup').record, f.record);
  });
}

test('agent-queue waits with the measured admission reservation instead of provisional device IDs', async () => {
  const f = fixture();
  f.validation.requested = { ramBytes: 8, diskBytes: { 'dev:253': 16 } };
  f.validation.requiredFileSystemIds = ['dev:253'];
  const first = { ramBytes: 8, diskBytes: { '/dev/mapper/data-dev': 16, '/dev/workspace': 16 } };
  const second = { ramBytes: 32, diskBytes: { '/dev/mapper/data-dev': 64, '/dev/workspace': 64 } };
  f.state.initial = { kind: 'waiting', record: f.record, admission: {
    ...admission(), reservation: { requested: first, unused: { ramBytes: 0, diskBytes: {} } },
  } };
  f.state.rechecks = [
    { kind: 'waiting', record: f.record, admission: {
      ...admission(), reservation: { requested: second, unused: { ramBytes: 0, diskBytes: {} } },
    } },
    { kind: 'reserved', record: f.record, admission: admission('ANY_RUN') },
  ];
  success(await runAgentWithQueue(f.request, f.ports), true);
  assert.deepEqual(input(f, 'waitForResources', 0).requested, first);
  assert.deepEqual(input(f, 'waitForResources', 1).requested, second);
  assert.equal(count(f, 'recheckAndReserve'), 2);
});

test('agent-queue recheck uses current estimate rather than the prewait budget', async () => {
  const f = fixture();
  const current = { ...f.validation, requested: { ramBytes: 32, diskBytes: { 'new-dev': 64 } }, requiredFileSystemIds: ['new-dev'] };
  f.state.checks.push({ ok: true, validation: current });
  success(await runAgentWithQueue(f.request, f.ports), true);
  assert.deepEqual(input(f, 'recheckAndReserve').validation, current);
  assert.deepEqual(input(f, 'start').validation, current);
});

test('agent-queue UNKNOWN after permit terminates without another permit or spawn', async () => {
  const f = fixture();
  const unknown = admission('UNKNOWN');
  f.state.rechecks = [{ kind: 'refused', admission: unknown, failure: failure('RESOURCE_UNAVAILABLE') }];
  const body = error(await runAgentWithQueue(f.request, f.ports));
  assert.deepEqual(body.details.admission, unknown);
  assert.equal(count(f, 'waitForResources'), 1);
  assert.equal(count(f, 'start'), 0);
  assert.equal(count(f, 'cleanup'), 1);
});

for (const code of ['AGENT_ID_IN_USE', 'TASK_RESERVED']) {
  test(`agent-queue conflicting address or one selected item rejects whole request: ${code}`, async () => {
    const f = fixture();
    f.state.initial = { kind: 'refused', admission: null, failure: failure(code) };
    const body = error(await runAgentWithQueue(f.request, f.ports));
    assert.equal(body.code, code);
    assert.deepEqual(input(f, 'claimAndAdmit').request.selections, f.request.selections, 'transaction receives the whole selection');
    assert.deepEqual(input(f, 'claimAndAdmit').request.owner, f.request.owner);
    assert.equal(count(f, 'claimAndAdmit'), 1);
    assert.equal(count(f, 'waitForResources'), 0);
    assert.equal(count(f, 'start'), 0);
    assert.equal(count(f, 'cleanup'), 0, 'rejected caller must not release the other caller claims');
  });
}

test('agent-queue coordinator retains ownership until readiness and transfers with its exact fence', async () => {
  const f = fixture();
  f.request.coordinator = { runId: 'coordinator-run-1', fence: 'coordinator-fence-1' };
  f.record.coordinator = f.request.coordinator;
  const run = await waiting(f);
  assert.deepEqual(input(f, 'claimAndAdmit').request.coordinator, f.request.coordinator);
  assert.equal(count(f, 'commitReady'), 0);
  run.finish(permit('coordinator-permit'));
  success(await run.running, true);
  assert.deepEqual(input(f, 'commitReady').record.coordinator, f.request.coordinator);
  assert.deepEqual(input(f, 'commitReady').process, f.process);
});

test('agent-queue changed coordinator fence refuses at recheck without transferring or spawning', async () => {
  const f = fixture();
  f.request.coordinator = { runId: 'coordinator-old', fence: 'coordinator-old-fence' };
  f.record.coordinator = f.request.coordinator;
  f.state.rechecks = [{ kind: 'refused', admission: admission('ANY_RUN'), failure: failure('TASK_RESERVED', 'coordinator fence changed') }];
  const body = error(await runAgentWithQueue(f.request, f.ports));
  assert.equal(body.code, 'TASK_RESERVED');
  assert.equal(count(f, 'start'), 0);
  assert.equal(count(f, 'commitReady'), 0);
  assert.deepEqual(input(f, 'cleanup').record.coordinator, f.request.coordinator);
});

for (const reason of ['service_stopped', 'connection_lost', 'delivery_unknown', 'readiness_failed']) {
  test(`agent-queue ${reason} propagates exact resource wait diagnostic without retry`, async () => {
    const f = fixture();
    const result = waitError(reason);
    f.state.waits.push(result);
    const body = error(await runAgentWithQueue(f.request, f.ports));
    assert.equal(body.details.reason, reason);
    assert.deepEqual(body.details.received, result.kind === 'error' ? result.diagnostic.received : null);
    assert.deepEqual(body.details.expected, result.kind === 'error' ? result.diagnostic.expected : null);
    assert.deepEqual(body.details.admission, admission());
    assert.equal(count(f, 'waitForResources'), 1, 'channel uncertainty must not reconnect or requeue');
    assert.equal(count(f, 'recheckAndReserve'), 0);
    assert.equal(count(f, 'start'), 0);
    assert.equal(count(f, 'commitReady'), 0);
    assert.equal(count(f, 'cleanup'), 1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'deadline']) {
  test(`agent-queue ${signal} during wait cancels only the current launch fence`, async () => {
    const f = fixture();
    const run = await waiting(f);
    f.controller.abort(signal);
    assert.equal(input(f, 'waitForResources').signal.aborted, true);
    run.finish(waitError('cancelled'));
    const body = error(await run.running);
    assert.equal(count(f, 'start'), 0);
    assert.equal(count(f, 'waitForResources'), 1);
    assert.deepEqual(input(f, 'cleanup').record.owner, f.request.owner);
    assert.equal(input(f, 'cleanup').reason, 'cancelled');
    assert.deepEqual(body.details.cleanup, f.state.cleanup);
  });
}

test('agent-queue already aborted caller cannot claim or spawn', async () => {
  const f = fixture();
  f.controller.abort('SIGTERM');
  error(await runAgentWithQueue(f.request, f.ports));
  assert.equal(count(f, 'claimAndAdmit'), 0);
  assert.equal(count(f, 'waitForResources'), 0);
  assert.equal(count(f, 'start'), 0);
});

test('agent-queue abort racing a returned permit cannot create a resource claim or agent', async () => {
  const f = fixture();
  const run = await waiting(f);
  f.controller.abort('SIGTERM');
  run.finish(permit('commit-won-in-resource-wait'));
  error(await run.running);
  assert.equal(count(f, 'recheckAndReserve'), 0);
  assert.equal(count(f, 'start'), 0);
  assert.equal(count(f, 'cleanup'), 1);
});

for (const at of ['start', 'readiness']) {
  test(`agent-queue ${at} failure cleans fenced claims and never reports ready success`, async () => {
    const f = fixture();
    if (at === 'start') f.state.startError = new Error('spawn failed');
    else f.state.readinessError = new Error('runner readiness failed');
    const body = error(await runAgentWithQueue(f.request, f.ports));
    assert.equal(count(f, 'start'), 1);
    assert.equal(count(f, 'commitReady'), 0);
    assert.equal(count(f, 'cleanup'), 1);
    assert.equal(input(f, 'cleanup').reason, 'launch-failed');
    assert.deepEqual(body.details.admission, admission('ANY_RUN'));
    assert.deepEqual(body.details.cleanup, f.state.cleanup);
  });
}

test('agent-queue readiness remains pending after process creation and permit alone', async () => {
  const f = fixture();
  const ready = deferred<AgentQueueProcess>();
  const verifying = deferred<void>();
  f.ports.verifyReady = async (record, process) => {
    f.calls.push({ name: 'verifyReady', input: { record, process } });
    verifying.resolve();
    return ready.promise;
  };
  const running = runAgentWithQueue(f.request, f.ports);
  await Promise.race([verifying.promise, running.then(() => { assert.fail('returned success before readiness'); })]);
  assert.equal(count(f, 'commitReady'), 0);
  ready.resolve(f.process);
  success(await running, true);
  assert.equal(count(f, 'commitReady'), 1);
});

test('agent-queue lost launch fence at rechecking prevents revalidation, reserve and spawn', async () => {
  const f = fixture();
  f.state.transition = false;
  error(await runAgentWithQueue(f.request, f.ports));
  assert.equal(count(f, 'validate'), 1);
  assert.equal(count(f, 'recheckAndReserve'), 0);
  assert.equal(count(f, 'start'), 0);
  assert.deepEqual(input(f, 'transition').record.owner, f.request.owner);
});

test('agent-queue lost launch fence between reservation and spawn prevents creating an agent', async () => {
  const f = fixture();
  f.ports.transition = async (record, phase) => {
    f.calls.push({ name: 'transition', input: { record, phase } });
    return phase !== 'starting';
  };
  error(await runAgentWithQueue(f.request, f.ports));
  assert.equal(count(f, 'recheckAndReserve'), 1);
  assert.equal(count(f, 'start'), 0);
  assert.equal(count(f, 'commitReady'), 0);
});

test('agent-queue lost fence at readiness commit cannot report success or launch again', async () => {
  const f = fixture();
  f.state.commit = false;
  f.state.cleanup = { state: 'unknown', reason: 'readiness owner changed', completed: [], pending: ['reconcile-launch-owner'] };
  const body = error(await runAgentWithQueue(f.request, f.ports));
  assert.equal(count(f, 'start'), 1);
  assert.equal(count(f, 'waitForResources'), 1);
  assert.equal(count(f, 'commitReady'), 1);
  assert.deepEqual(body.details.cleanup, f.state.cleanup);
  assert.ok(body.details.pending.length > 0);
});

test('agent-queue uncertain cleanup is explicit and cannot claim resources were released', async () => {
  const f = fixture();
  f.state.readinessError = new Error('readiness interrupted with unknown process tree');
  f.state.cleanup = { state: 'unknown', reason: 'cannot verify process death', completed: [], pending: ['verify-process-tree', 'release-client-claims'] };
  const body = error(await runAgentWithQueue(f.request, f.ports));
  assert.deepEqual(body.details.cleanup, f.state.cleanup);
  assert.ok(body.details.pending.includes('verify-process-tree'));
  assert.equal(count(f, 'start'), 1);
});

test('agent-queue client death before permit reconciles its own claims without resource reserve', async () => {
  const f = fixture();
  assert.deepEqual(await reconcileAgentQueue(f.record, f.ports), f.state.cleanup);
  assert.deepEqual(names(f), ['observe', 'cleanup']);
  assert.deepEqual(input(f, 'observe'), f.record);
  assert.equal(input(f, 'cleanup').reason, 'client-died');
  assert.deepEqual(input(f, 'cleanup').record.owner, f.request.owner);
});

test('agent-queue ready live agent survives loss of its CLI caller', async () => {
  const f = fixture();
  f.state.observation = { owner: 'agent', client: 'dead', agent: 'alive', reason: 'ready agent owns launch' };
  const result = await reconcileAgentQueue(f.record, f.ports);
  assert.equal(result.state, 'retained');
  assert.deepEqual(names(f), ['observe']);
});

test('agent-queue old fence reconciliation preserves a new owner using the same address', async () => {
  const f = fixture();
  f.state.observation = { owner: 'other', client: 'dead', agent: 'alive', reason: 'new run uses queue-worker' };
  const result = await reconcileAgentQueue(f.record, f.ports);
  assert.equal(result.state, 'retained');
  assert.deepEqual(names(f), ['observe']);
});

test('agent-queue unknown liveness retains claims for reconciliation rather than freeing them', async () => {
  const f = fixture();
  f.state.observation = { owner: 'client', client: 'unknown', agent: 'unknown', reason: 'OS identity unavailable' };
  const result = await reconcileAgentQueue(f.record, f.ports);
  assert.equal(result.state, 'unknown');
  assert.ok(result.pending.length > 0);
  assert.match(result.reason, /OS identity unavailable/);
  assert.deepEqual(names(f), ['observe']);
});

test('agent-queue dead client with unknown agent state keeps resources until ownership is proven', async () => {
  const f = fixture();
  f.state.observation = { owner: 'client', client: 'dead', agent: 'unknown', reason: 'spawn handoff cannot be verified' };
  const result = await reconcileAgentQueue(f.record, f.ports);
  assert.equal(result.state, 'unknown');
  assert.ok(result.pending.length > 0);
  assert.deepEqual(names(f), ['observe']);
});

test('agent-queue cleanup preserves a ready agent even when failure response is being assembled', async () => {
  const f = fixture();
  f.state.commit = false;
  f.state.cleanup = { state: 'retained', reason: 'ready agent already accepted ownership', completed: ['verify-live-agent'], pending: ['retrieve-final-response'] };
  const body = error(await runAgentWithQueue(f.request, f.ports));
  assert.deepEqual(body.details.cleanup, f.state.cleanup);
  assert.equal(count(f, 'start'), 1);
  assert.equal(count(f, 'waitForResources'), 1);
});

test('agent-queue verified living client keeps its launch claim without spawning from reconciliation', async () => {
  const f = fixture();
  f.state.observation = { owner: 'client', client: 'alive', agent: 'dead', reason: 'client still waiting' };
  const result = await reconcileAgentQueue(f.record, f.ports);
  assert.equal(result.state, 'retained');
  assert.deepEqual(names(f), ['observe']);
});
