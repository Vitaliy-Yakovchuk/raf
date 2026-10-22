import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createLaunchState } from '../src/launch-state.ts';
import type { ProcessIdentity, ProcessObservation, SessionRecord, SessionTransaction } from '../src/session-state.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';
import {
  claimTaskReservations,
  completeTaskReservations,
  handoffTaskReservations,
  listTaskReservations,
  reconcileTaskReservations,
  releaseTaskReservations,
  startTaskReservations,
  type ClaimTasksRequest,
  type MachineBootIdentity,
  type ReservationProcessIdentity,
  type ReservedTaskResolution,
  type ReservedTaskSnapshot,
  type TaskReservationDependencies,
  type TaskReservationError,
  type TaskReservationLease,
} from '../src/task-reservations.ts';

const observedAt = '2099-10-22T12:00:00.000Z';

function task(taskId: string, project = 'raf', changeId = 'add-raf-agent-run', changeInstance = 'change-instance-original'): ReservedTaskSnapshot {
  return { key: { project, changeId, taskId }, changeInstance, fingerprint: `initial-content:${taskId}` };
}

function sourceKey(snapshot: ReservedTaskSnapshot): string {
  return JSON.stringify(snapshot.key);
}

function identity(runId: string, role: string, pid = 41001): ReservationProcessIdentity {
  return {
    pid,
    startedAt: '2026-10-22T09:00:00.000Z',
    runner: 'fixture-runner',
    runnerSessionId: `${runId}:${role}`,
    tmuxSession: `fixture-${runId}`,
    evidence: { machineId: 'fixture-machine', bootId: 'fixture-boot', runId, command: `fixture-${role}`, role },
  };
}

function exited(): ProcessObservation {
  return { state: 'exited', observedAt, exitCode: null, evidence: 'fixture verified process exit' };
}

function hasCode(code: TaskReservationError['code']): (error: unknown) => boolean {
  return error => error instanceof Error && 'code' in error && error.code === code;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'raf-task-reservations-'));
  const path = join(directory, 'state.sqlite');
  const stores: StateStore[] = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const connect = () => {
    const store = openStateStore(path);
    stores.push(store);
    return store;
  };
  const store = connect();
  const observations = new Map<string, ProcessObservation>();
  const resolutions = new Map<string, ReservedTaskResolution>();
  const probes: ProcessIdentity[] = [];
  let boot: MachineBootIdentity = { machineId: 'fixture-machine', bootId: 'fixture-boot' };
  let fence = 0;
  let launchCalls = 0;
  const dependencies = (connection = store): TaskReservationDependencies => ({
    store: connection,
    currentBoot: async () => structuredClone(boot),
    observe: async expected => {
      probes.push(structuredClone(expected));
      return structuredClone(observations.get(JSON.stringify(expected)) ?? { state: 'alive', observedAt, identity: expected });
    },
    resolveTasks: async tasks => tasks.map(snapshot => structuredClone(resolutions.get(sourceKey(snapshot)) ?? {
      state: 'open', task: snapshot, location: 'active',
    })),
    newFence: () => `fixture-fence-${++fence}`,
  });
  const request = (runId: string, tasks: readonly ReservedTaskSnapshot[], addressId = runId): ClaimTasksRequest => ({
    addressId,
    runId,
    tasks,
    starter: identity(runId, 'starter'),
    reserveLaunch: tx => {
      launchCalls++;
      const session: SessionRecord = {
        runId, addressId, revision: 0, state: 'reserved',
        activity: { type: 'test-scaffold', project: 'raf', features: ['add-raf-agent-run'], phase: 'tests', cwd: directory },
      };
      tx.putSession(session);
      tx.putReservation({ runId, resource: 'fixture-admitted-resource', amount: 1 });
      return session;
    },
  });
  const claim = async (input: ClaimTasksRequest, deps = dependencies()): Promise<TaskReservationLease> => {
    const result = await claimTaskReservations(deps, input);
    assert.equal(result.reserved, true, 'the complete requested task set must be reserved');
    if (!result.reserved) throw new Error('Expected successful fixture claim');
    return result.lease;
  };
  const running = async (input: ClaimTasksRequest) => {
    const initial = await claim(input);
    const wrapper = identity(input.runId, 'wrapper', 41002);
    const handed = await handoffTaskReservations(dependencies(), { lease: initial, wrapper });
    assert.ok(handed, 'a verified parked wrapper must receive the current lease');
    const agent = identity(input.runId, 'agent', 41003);
    const active = await startTaskReservations(dependencies(), { lease: handed, agent });
    assert.ok(active, 'work must be permitted only after durable agent registration');
    return { initial, handed, active, wrapper, agent };
  };
  const mark = (processIdentity: ProcessIdentity, observation = exited()) => observations.set(JSON.stringify(processIdentity), observation);
  const close = (runId: string) => (tx: SessionTransaction) => {
    const session = tx.getSession(runId);
    assert.ok(session);
    tx.putSession({ ...session, revision: session.revision + 1, state: 'finished', finishedAt: observedAt });
    tx.deleteReservation(runId);
  };
  return {
    store, connect, dependencies, request, claim, running, mark, close, observations, resolutions, probes,
    setBoot: (value: MachineBootIdentity) => { boot = value; },
    launchCalls: () => launchCalls,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function scenario(name: string, run: (f: Fixture) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    const f = await fixture(t);
    await assert.doesNotReject(() => run(f), `task reservation contract: ${name}`);
  });
}

for (const reverse of [false, true]) {
  scenario(`overlapping concurrent sets are all-or-none, reverse=${reverse}`, async f => {
    const inputs = [f.request('run-a', [task('R.1'), task('R.2')]), f.request('run-b', [task('R.2'), task('R.3')])];
    if (reverse) inputs.reverse();
    const other = f.connect();
    const results = await Promise.all(inputs.map((input, index) => claimTaskReservations(f.dependencies(index ? other : f.store), input)));
    const winners = results.flatMap((result, index) => result.reserved ? [index] : []);
    assert.equal(winners.length, 1, 'exactly one overlapping launch must acquire its entire set');
    const winner = inputs[winners[0]];
    const loser = inputs[1 - winners[0]];
    const denied = results[1 - winners[0]];
    assert.equal(denied.reserved, false);
    if (denied.reserved) throw new Error('Expected losing claim');
    assert.deepEqual(denied.conflicts.map(conflict => conflict.task), [task('R.2')]);
    assert.equal(denied.conflicts[0].owner.runId, winner.runId);
    assert.equal(denied.conflicts[0].owner.addressId, winner.addressId);
    assert.ok(denied.conflicts[0].owner.fence);
    assert.deepEqual(listTaskReservations(f.store).map(set => set.tasks), [winner.tasks]);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions().map(session => session.runId)), [winner.runId]);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations().map(item => item.runId)), [winner.runId]);
    assert.equal(f.launchCalls(), 1, 'a conflicting claim must not invoke the launch transaction participant');
    const freeTask = loser.tasks.filter(snapshot => snapshot.key.taskId !== 'R.2');
    await f.claim(f.request('run-c', freeTask));
    assert.equal(listTaskReservations(f.store).length, 2, 'the losing set must leave its disjoint task free');
  });
}

scenario('disjoint tasks in one change can be reserved concurrently through two connections', async f => {
  const other = f.connect();
  const inputs = [f.request('run-a', [task('R.1')]), f.request('run-b', [task('R.2')])];
  const results = await Promise.all(inputs.map((input, index) => claimTaskReservations(f.dependencies(index ? other : f.store), input)));
  assert.ok(results.every(result => result.reserved));
  assert.equal(listTaskReservations(f.store).length, 2);
  assert.equal(f.launchCalls(), 2);
});

scenario('the key distinguishes canonical projects and concrete changes without feature locks', async f => {
  await f.claim(f.request('run-a', [task('R.1')]));
  await f.claim(f.request('run-b', [task('R.1', 'another-project')]));
  await f.claim(f.request('run-c', [task('R.1', 'raf', 'another-change', 'another-instance')]));
  assert.equal(listTaskReservations(f.store).length, 3);
});

scenario('every conflicting task reports its actual owner and creates no session', async f => {
  const first = await f.claim(f.request('run-a', [task('R.1')]));
  const second = await f.claim(f.request('run-b', [task('R.2')]));
  const denied = await claimTaskReservations(f.dependencies(), f.request('run-c', [task('R.1'), task('R.2'), task('R.3')]));
  assert.equal(denied.reserved, false);
  if (denied.reserved) throw new Error('Expected all-or-none denial');
  assert.deepEqual(denied.conflicts, [
    { task: task('R.1'), owner: first.owner },
    { task: task('R.2'), owner: second.owner },
  ]);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession('run-c')), undefined);
  assert.equal(f.launchCalls(), 2);
});

scenario('launch failure rolls back task claims, session and admission writes together', async f => {
  const input = f.request('run-a', [task('R.1'), task('R.2')]);
  await assert.rejects(() => claimTaskReservations(f.dependencies(), {
    ...input,
    reserveLaunch: tx => {
      input.reserveLaunch(tx);
      throw new Error('fixture launch transaction failed');
    },
  }), /fixture launch transaction failed/);
  assert.deepEqual(listTaskReservations(f.store), []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  await f.claim(f.request('run-b', input.tasks));
});

scenario('claim rejects a launch participant returning the wrong run and rolls back', async f => {
  const input = f.request('run-a', [task('R.1')]);
  await assert.rejects(() => claimTaskReservations(f.dependencies(), {
    ...input,
    reserveLaunch: tx => ({ ...input.reserveLaunch(tx), runId: 'wrong-run' }),
  }), /identity|run|launch/i);
  assert.deepEqual(listTaskReservations(f.store), []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
});

scenario('one invalid source snapshot rejects the entire multi-change request before launch', async f => {
  const invalid = task('S.1', 'raf', 'second-change', 'second-instance');
  f.resolutions.set(sourceKey(invalid), { state: 'mismatch', requested: invalid, reason: 'fixture task was renumbered' });
  await assert.rejects(() => claimTaskReservations(f.dependencies(), f.request('run-a', [task('R.1'), invalid])), hasCode('TASK_IDENTITY_MISMATCH'));
  assert.deepEqual(listTaskReservations(f.store), []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  assert.equal(f.launchCalls(), 0);
});

scenario('a caller crash before spawn is reconciled automatically before the next claim', async f => {
  const first = f.request('run-a', [task('R.1')]);
  const old = await f.claim(first);
  f.mark(first.starter);
  const next = await f.claim(f.request('run-b', first.tasks));
  assert.notEqual(next.owner.fence, old.owner.fence);
  assert.deepEqual(listTaskReservations(f.store).map(set => set.lease.owner.runId), ['run-b']);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession('run-a')?.state), 'finished');
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations().map(item => item.runId)), ['run-b']);
});

scenario('a live starter keeps its reservation during pre-spawn reconciliation', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const lease = await f.claim(input);
  const result = await reconcileTaskReservations(f.dependencies());
  assert.deepEqual(result.released, []);
  assert.deepEqual(result.retained, [lease]);
  assert.deepEqual(listTaskReservations(f.store)[0].tasks, input.tasks);
  assert.ok(f.probes.some(probe => probe.runnerSessionId === input.starter.runnerSessionId));
});

scenario('a durable handoff survives caller death while the wrapper is alive', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const initial = await f.claim(input);
  const wrapper = identity(input.runId, 'wrapper', 41002);
  const handed = await handoffTaskReservations(f.dependencies(), { lease: initial, wrapper });
  assert.ok(handed);
  assert.notEqual(handed.revision, initial.revision);
  f.mark(input.starter);
  const reconciled = await reconcileTaskReservations(f.dependencies());
  assert.deepEqual(reconciled.retained, [handed]);
  const denied = await claimTaskReservations(f.dependencies(), f.request('run-b', input.tasks));
  assert.equal(denied.reserved, false);
  assert.equal(listTaskReservations(f.store)[0].stage, 'handoff');
});

scenario('wrapper death during handoff frees claims and fences an already spawned late agent', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const initial = await f.claim(input);
  const wrapper = identity(input.runId, 'wrapper', 41002);
  const handed = await handoffTaskReservations(f.dependencies(), { lease: initial, wrapper });
  assert.ok(handed);
  f.mark(wrapper);
  const reconciled = await reconcileTaskReservations(f.dependencies());
  assert.deepEqual(reconciled.released, [initial.owner]);
  assert.deepEqual(listTaskReservations(f.store), []);
  const replacement = await f.claim(f.request('run-b', input.tasks));
  let workStarts = 0;
  const late = await startTaskReservations(f.dependencies(), { lease: handed, agent: identity(input.runId, 'agent', 41003) });
  if (late) workStarts++;
  assert.equal(late, null, 'a late agent must fail its fence before receiving work');
  assert.equal(workStarts, 0);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, replacement);
});

scenario('a delayed handoff cannot resurrect a caller reservation reclaimed before spawn', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const lease = await f.claim(input);
  f.mark(input.starter);
  await reconcileTaskReservations(f.dependencies());
  const late = await handoffTaskReservations(f.dependencies(), { lease, wrapper: identity(input.runId, 'wrapper', 41002) });
  assert.equal(late, null);
  assert.deepEqual(listTaskReservations(f.store), []);
});

scenario('old reconciliation observations cannot release a newer handoff revision', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const initial = await f.claim(input);
  let observed!: () => void;
  let resume!: () => void;
  const observedPromise = new Promise<void>(resolve => { observed = resolve; });
  const resumePromise = new Promise<void>(resolve => { resume = resolve; });
  const base = f.dependencies(f.connect());
  let delayed = false;
  const pending = reconcileTaskReservations({
    ...base,
    observe: async expected => {
      if (!delayed && expected.runnerSessionId === input.starter.runnerSessionId) {
        delayed = true;
        observed();
        await resumePromise;
        return exited();
      }
      return base.observe(expected);
    },
  });
  await Promise.race([
    observedPromise,
    pending.then(() => { throw new Error('Reconciliation must observe the existing starter before committing'); }),
  ]);
  let handed: TaskReservationLease | null = null;
  try {
    handed = await handoffTaskReservations(f.dependencies(), { lease: initial, wrapper: identity(input.runId, 'wrapper', 41002) });
    assert.ok(handed);
  } finally {
    resume();
    await pending;
  }
  assert.deepEqual(listTaskReservations(f.store)[0].lease, handed);
  assert.equal(listTaskReservations(f.store)[0].stage, 'handoff');
});

scenario('a live running agent survives service restart and dead caller or wrapper', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const active = await f.running(input);
  f.mark(input.starter);
  f.mark(active.wrapper);
  const restarted = f.dependencies(f.connect());
  const result = await reconcileTaskReservations(restarted);
  assert.deepEqual(result.retained, [active.active]);
  assert.deepEqual(result.released, []);
  const denied = await claimTaskReservations(restarted, f.request('run-b', input.tasks));
  assert.equal(denied.reserved, false);
  assert.equal(f.launchCalls(), 1, 'service restart must not launch another executor');
  assert.equal(listTaskReservations(restarted.store)[0].stage, 'running');
});

scenario('a crashed agent retains its run until the verified report wrapper exits, even with a live older starter', async f => {
  const request = f.request('run-a', [task('R.1')]);
  const input = { ...request, reserveLaunch: (tx: SessionTransaction) => {
    const session = request.reserveLaunch(tx);
    const launchContext = {
      assignment: { root: session.activity!.cwd, changes: [{ id: 'add-raf-agent-run', items: [{ id: 'R.1', description: 'Original assigned task' }] }], baselineArchives: [] },
      selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reason: 'fixture' },
      briefPath: join(session.activity!.cwd, 'brief.txt'), reportPath: join(session.activity!.cwd, 'run-a.json'),
    };
    const reserved = { ...session, launchContext };
    tx.putSession(reserved);
    return reserved;
  } };
  const { active, agent, wrapper } = await f.running(input);
  const before = f.store.sessionRepository.transaction(tx => {
    const session = tx.getSession(input.runId)!;
    const running: SessionRecord = { ...session, revision: session.revision + 1, state: 'running', process: agent };
    tx.putSession(running);
    return running;
  });
  const claims = listTaskReservations(f.store);
  const admission = f.store.sessionRepository.transaction(tx => tx.listReservations());
  f.mark(agent);
  const pending = await reconcileTaskReservations(f.dependencies());
  assert.deepEqual(pending.retained, [active]);
  assert.deepEqual(pending.released, []);
  assert.deepEqual(listTaskReservations(f.store), claims);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.getSession(input.runId)), before);
  assert.deepEqual(before.launchContext!.wrapper, wrapper);
  assert.equal(before.result, undefined);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), admission);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listPending().some(intent => intent.event === 'agent.failed' || intent.event === 'agent.succeeded')), false);
  const denied = await claimTaskReservations(f.dependencies(), f.request('run-b', input.tasks));
  assert.equal(denied.reserved, false);
  assert.equal(f.launchCalls(), 1, 'pending report verification must not launch another executor');
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession('run-b')), undefined);
  assert.deepEqual(listTaskReservations(f.store), claims);
  assert.equal((await f.dependencies().observe(input.starter)).state, 'alive', 'the older starter may remain alive');
  f.mark(wrapper);
  const result = await reconcileTaskReservations(f.dependencies());
  assert.deepEqual(result.released, [active.owner]);
  assert.deepEqual(listTaskReservations(f.store), []);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(input.runId)?.state), 'finished');
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  await f.claim(f.request('run-b', input.tasks));
});

scenario('long execution never expires a verified live process by age', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const oldStarter = { ...input.starter, startedAt: '1999-01-01T00:00:00.000Z' };
  const lease = await f.claim({ ...input, starter: oldStarter });
  const result = await reconcileTaskReservations(f.dependencies());
  assert.deepEqual(result.retained, [lease]);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, lease);
});

scenario('a new boot reclaims the old run even if its numeric PID appears alive', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const old = await f.claim(input);
  f.setBoot({ machineId: 'fixture-machine', bootId: 'fixture-boot-after-reboot' });
  const result = await reconcileTaskReservations(f.dependencies());
  assert.deepEqual(result.released, [old.owner]);
  const nextInput = f.request('run-b', input.tasks);
  await f.claim({ ...nextInput, starter: {
    ...nextInput.starter,
    evidence: { ...nextInput.starter.evidence, bootId: 'fixture-boot-after-reboot' },
  } });
  assert.deepEqual(listTaskReservations(f.store).map(set => set.lease.owner.runId), ['run-b']);
});

for (const field of ['startedAt', 'runner', 'runnerSessionId', 'tmuxSession', 'command', 'runId'] as const) {
  scenario(`PID reuse or identity mismatch in ${field} cannot keep an abandoned run alive`, async f => {
    const input = f.request('run-a', [task('R.1')]);
    const old = await f.claim(input);
    const actual = structuredClone(input.starter);
    const observedIdentity: ProcessIdentity = field === 'command' || field === 'runId'
      ? { ...actual, evidence: { ...actual.evidence, [field]: 'another-process' } }
      : { ...actual, [field]: field === 'startedAt' ? '2026-10-22T10:00:00.000Z' : 'another-process' };
    f.mark(input.starter, { state: 'alive', observedAt, identity: observedIdentity });
    const result = await reconcileTaskReservations(f.dependencies());
    assert.deepEqual(result.released, [old.owner]);
    assert.deepEqual(listTaskReservations(f.store), []);
    await f.claim(f.request('run-b', input.tasks));
  });
}

scenario('unknown liveness is an explicit retryable error rather than busy or free', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const old = await f.claim(input);
  f.mark(input.starter, { state: 'unknown', observedAt, error: 'fixture permission denied for process inspection' });
  await assert.rejects(() => claimTaskReservations(f.dependencies(), f.request('run-b', input.tasks)), (error: unknown) => {
    assert.ok(hasCode('TASK_LIVENESS_UNKNOWN')(error));
    assert.match((error as Error).message, /permission denied/);
    assert.match((error as Error).message, /run-a/);
    return true;
  });
  assert.deepEqual(listTaskReservations(f.store)[0].lease, old);
  assert.equal(f.launchCalls(), 1);
  f.mark(input.starter);
  await f.claim(f.request('run-b', input.tasks));
});

scenario('a thrown process probe is reported without losing the reservation', async f => {
  const old = await f.claim(f.request('run-a', [task('R.1')]));
  await assert.rejects(() => reconcileTaskReservations({
    ...f.dependencies(), observe: async () => { throw new Error('fixture process inspection unavailable'); },
  }), (error: unknown) => {
    assert.ok(hasCode('TASK_LIVENESS_UNKNOWN')(error));
    assert.match((error as Error).message, /inspection unavailable/);
    return true;
  });
  assert.deepEqual(listTaskReservations(f.store)[0].lease, old);
});

scenario('another machine identity is unknown rather than evidence of a reboot', async f => {
  const old = await f.claim(f.request('run-a', [task('R.1')]));
  f.setBoot({ machineId: 'different-machine', bootId: 'different-boot' });
  await assert.rejects(() => reconcileTaskReservations(f.dependencies()), hasCode('TASK_LIVENESS_UNKNOWN'));
  assert.deepEqual(listTaskReservations(f.store)[0].lease, old);
});

scenario('missing process boot evidence is rejected before any reservation or launch', async f => {
  const input = f.request('run-a', [task('R.1')]);
  await assert.rejects(() => claimTaskReservations(f.dependencies(), {
    ...input, starter: { ...input.starter, evidence: { ...input.starter.evidence, bootId: '' } },
  }), hasCode('TASK_IDENTITY_INVALID'));
  assert.deepEqual(listTaskReservations(f.store), []);
  assert.equal(f.launchCalls(), 0);
});

scenario('work cannot start directly from the starter stage without durable wrapper handoff', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const lease = await f.claim(input);
  assert.equal(await startTaskReservations(f.dependencies(), { lease, agent: identity(input.runId, 'agent', 41003) }), null);
  assert.equal(listTaskReservations(f.store)[0].stage, 'starting');
  assert.deepEqual(listTaskReservations(f.store)[0].lease, lease);
});

scenario('handoff rejects a wrapper belonging to another run before transferring ownership', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const lease = await f.claim(input);
  await assert.rejects(() => handoffTaskReservations(f.dependencies(), {
    lease, wrapper: identity('unrelated-run', 'wrapper', 41002),
  }), hasCode('TASK_IDENTITY_INVALID'));
  assert.equal(listTaskReservations(f.store)[0].stage, 'starting');
  assert.deepEqual(listTaskReservations(f.store)[0].lease, lease);
});

scenario('start rejects an agent belonging to another boot before granting work', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const initial = await f.claim(input);
  const handed = await handoffTaskReservations(f.dependencies(), { lease: initial, wrapper: identity(input.runId, 'wrapper', 41002) });
  assert.ok(handed);
  const agent = identity(input.runId, 'agent', 41003);
  await assert.rejects(() => startTaskReservations(f.dependencies(), {
    lease: handed, agent: { ...agent, evidence: { ...agent.evidence, bootId: 'unrelated-boot' } },
  }), hasCode('TASK_IDENTITY_INVALID'));
  assert.equal(listTaskReservations(f.store)[0].stage, 'handoff');
  assert.deepEqual(listTaskReservations(f.store)[0].lease, handed);
});

scenario('handoff invalidates the old caller lease for cancellation and late start', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const initial = await f.claim(input);
  const handed = await handoffTaskReservations(f.dependencies(), { lease: initial, wrapper: identity(input.runId, 'wrapper', 41002) });
  assert.ok(handed);
  let closes = 0;
  assert.equal(await releaseTaskReservations(f.dependencies(), {
    lease: initial, reason: 'cancelled', closeLaunch: () => { closes++; },
  }), false);
  assert.equal(await startTaskReservations(f.dependencies(), { lease: initial, agent: identity(input.runId, 'agent', 41003) }), null);
  assert.equal(closes, 0);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, handed);
});

scenario('an old run cannot release a newer run using the same address', async f => {
  const first = f.request('run-a', [task('R.1')], 'test-scaffold-address');
  const old = await f.claim(first);
  f.mark(first.starter);
  assert.equal(await releaseTaskReservations(f.dependencies(), { lease: old, reason: 'failed', closeLaunch: f.close(first.runId) }), true);
  const next = await f.claim(f.request('run-b', first.tasks, first.addressId));
  let closes = 0;
  assert.equal(await releaseTaskReservations(f.dependencies(), {
    lease: old, reason: 'succeeded', closeLaunch: () => { closes++; },
  }), false);
  assert.equal(closes, 0);
  assert.notEqual(next.owner.fence, old.owner.fence);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, next);
});

scenario('a wrong fence cannot transfer, start, complete or release the current set', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const current = await f.claim(input);
  const stale = { ...current, owner: { ...current.owner, fence: 'stale-fence' } };
  assert.equal(await handoffTaskReservations(f.dependencies(), { lease: stale, wrapper: identity(input.runId, 'wrapper', 41002) }), null);
  assert.equal(await startTaskReservations(f.dependencies(), { lease: stale, agent: identity(input.runId, 'agent', 41003) }), null);
  assert.deepEqual(await completeTaskReservations(f.dependencies(), { lease: stale, tasks: input.tasks }), { applied: false });
  assert.equal(await releaseTaskReservations(f.dependencies(), { lease: stale, reason: 'cancelled', closeLaunch: f.close(input.runId) }), false);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, current);
});

scenario('confirmed completion releases only its subset and invalidates stale revisions', async f => {
  const input = f.request('run-a', [task('R.1'), task('R.2')]);
  const { active } = await f.running(input);
  f.resolutions.set(sourceKey(task('R.1')), { state: 'completed', task: task('R.1'), location: 'active' });
  const result = await completeTaskReservations(f.dependencies(), { lease: active, tasks: [task('R.1')] });
  assert.equal(result.applied, true);
  if (!result.applied) throw new Error('Expected completion');
  assert.ok(result.lease);
  assert.notEqual(result.lease.revision, active.revision);
  assert.deepEqual(listTaskReservations(f.store)[0].tasks, [task('R.2')]);
  assert.deepEqual(await completeTaskReservations(f.dependencies(), { lease: active, tasks: [task('R.2')] }), { applied: false });
  f.resolutions.set(sourceKey(task('R.2')), { state: 'completed', task: task('R.2'), location: 'active' });
  assert.deepEqual(await completeTaskReservations(f.dependencies(), { lease: result.lease, tasks: [task('R.2')] }), { applied: true, lease: null });
  assert.deepEqual(listTaskReservations(f.store), [], 'completion must leave no reservation history or empty owner rows');
});

scenario('a completion batch containing an open task releases none of its items', async f => {
  const input = f.request('run-a', [task('R.1'), task('R.2')]);
  const { active } = await f.running(input);
  f.resolutions.set(sourceKey(task('R.1')), { state: 'completed', task: task('R.1'), location: 'active' });
  await assert.rejects(() => completeTaskReservations(f.dependencies(), { lease: active, tasks: input.tasks }), hasCode('TASK_NOT_COMPLETED'));
  assert.deepEqual(listTaskReservations(f.store)[0].tasks, input.tasks);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, active);
});

scenario('completion cannot include a task outside the original assigned set', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const { active } = await f.running(input);
  const unrelated = task('R.99');
  f.resolutions.set(sourceKey(unrelated), { state: 'completed', task: unrelated, location: 'active' });
  await assert.rejects(() => completeTaskReservations(f.dependencies(), { lease: active, tasks: [unrelated] }), hasCode('TASK_IDENTITY_MISMATCH'));
  assert.deepEqual(listTaskReservations(f.store)[0].tasks, input.tasks);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, active);
});

scenario('completion accepts the exact original task in its completed archive', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const { active } = await f.running(input);
  f.resolutions.set(sourceKey(input.tasks[0]), { state: 'completed', task: input.tasks[0], location: 'archive' });
  assert.deepEqual(await completeTaskReservations(f.dependencies(), { lease: active, tasks: input.tasks }), { applied: true, lease: null });
  assert.deepEqual(listTaskReservations(f.store), []);
});

scenario('an incomplete archive requires main rather than silently completing work', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const { active } = await f.running(input);
  f.resolutions.set(sourceKey(input.tasks[0]), { state: 'open', task: input.tasks[0], location: 'archive' });
  await assert.rejects(() => completeTaskReservations(f.dependencies(), { lease: active, tasks: input.tasks }), hasCode('TASK_IDENTITY_MISMATCH'));
  assert.deepEqual(listTaskReservations(f.store)[0].lease, active);
});

for (const mutation of ['renumbered', 'rewritten', 'reused-change-id'] as const) {
  scenario(`${mutation} cannot rebind an original reservation during completion or another claim`, async f => {
    const original = task('R.1');
    const input = f.request('run-a', [original]);
    const { active } = await f.running(input);
    const changed: ReservedTaskSnapshot = mutation === 'renumbered'
      ? { ...original, key: { ...original.key, taskId: 'R.99' } }
      : mutation === 'rewritten'
        ? { ...original, fingerprint: 'different-content' }
        : { ...original, changeInstance: 'new-instance-reusing-the-name' };
    f.resolutions.set(sourceKey(original), { state: 'completed', task: changed, location: mutation === 'reused-change-id' ? 'active' : 'archive' });
    await assert.rejects(() => completeTaskReservations(f.dependencies(), { lease: active, tasks: input.tasks }), hasCode('TASK_IDENTITY_MISMATCH'));
    await assert.rejects(() => claimTaskReservations(f.dependencies(), f.request('run-b', [original])), hasCode('TASK_IDENTITY_MISMATCH'));
    await assert.rejects(() => claimTaskReservations(f.dependencies(), f.request('run-c', [changed])), hasCode('TASK_IDENTITY_MISMATCH'));
    assert.deepEqual(listTaskReservations(f.store)[0].tasks, [original]);
    assert.deepEqual(listTaskReservations(f.store)[0].lease, active);
    assert.equal(f.launchCalls(), 1);
  });
}

scenario('unknown or incomplete OpenSpec answers cannot release or reserve tasks', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const { active } = await f.running(input);
  f.resolutions.set(sourceKey(input.tasks[0]), { state: 'unknown', requested: input.tasks[0], reason: 'fixture OpenSpec unavailable' });
  await assert.rejects(() => completeTaskReservations(f.dependencies(), { lease: active, tasks: input.tasks }), hasCode('TASK_SOURCE_UNKNOWN'));
  await assert.rejects(() => claimTaskReservations(f.dependencies(), f.request('run-b', input.tasks)), hasCode('TASK_SOURCE_UNKNOWN'));
  await assert.rejects(() => completeTaskReservations({ ...f.dependencies(), resolveTasks: async () => [] }, { lease: active, tasks: input.tasks }), hasCode('TASK_SOURCE_UNKNOWN'));
  assert.deepEqual(listTaskReservations(f.store)[0].tasks, input.tasks);
  assert.equal(f.launchCalls(), 1);
});

for (const reason of ['succeeded', 'failed'] as const) {
  scenario(`terminal ${reason} releases every remaining task with session and admission cleanup`, async f => {
    const input = f.request('run-a', [task('R.1'), task('R.2')]);
    const { active, agent } = await f.running(input);
    f.mark(agent);
    assert.equal(await releaseTaskReservations(f.dependencies(), { lease: active, reason, closeLaunch: f.close(input.runId) }), true);
    assert.deepEqual(listTaskReservations(f.store), []);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
    assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(input.runId)?.state), 'finished');
    await f.claim(f.request('run-b', input.tasks));
  });
}

scenario('release failure rolls back session cleanup and all remaining claims', async f => {
  const input = f.request('run-a', [task('R.1'), task('R.2')]);
  const lease = await f.claim(input);
  await assert.rejects(() => releaseTaskReservations(f.dependencies(), {
    lease, reason: 'cancelled', closeLaunch: tx => {
      f.close(input.runId)(tx);
      throw new Error('fixture close transaction failed');
    },
  }), /fixture close transaction failed/);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, lease);
  assert.deepEqual(listTaskReservations(f.store)[0].tasks, input.tasks);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(input.runId)?.state), 'reserved');
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations().length), 1);
});

scenario('a live agent cannot lose its tasks through cancellation or a claimed terminal result', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const { active } = await f.running(input);
  let closes = 0;
  for (const reason of ['cancelled', 'succeeded', 'failed'] as const) {
    assert.equal(await releaseTaskReservations(f.dependencies(), { lease: active, reason, closeLaunch: () => { closes++; } }), false);
  }
  assert.equal(closes, 0);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, active);
});

scenario('unknown terminal liveness cannot release tasks or close the launch', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const { active, agent } = await f.running(input);
  f.mark(agent, { state: 'unknown', observedAt, error: 'fixture terminal process state unknown' });
  let closes = 0;
  await assert.rejects(() => releaseTaskReservations(f.dependencies(), {
    lease: active, reason: 'failed', closeLaunch: () => { closes++; },
  }), hasCode('TASK_LIVENESS_UNKNOWN'));
  assert.equal(closes, 0);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, active);
});

scenario('activity updates leave the original task assignment and reservation lease unchanged', async f => {
  const input = f.request('run-a', [task('R.1')]);
  const { active } = await f.running(input);
  const before = structuredClone(listTaskReservations(f.store));
  const session = f.store.sessionRepository.transaction(tx => tx.getSession(input.runId));
  assert.ok(session);
  const launch = createLaunchState({
    repository: f.store.sessionRepository,
    measure: async () => { throw new Error('Activity fixture must not measure resources'); },
    evaluateAdmission: () => { throw new Error('Activity fixture must not evaluate admission'); },
  });
  assert.equal(launch.updateActivity(input.runId, session.revision, { project: 'another-project', features: ['another-feature'], phase: 'implementation' }, []), true);
  assert.deepEqual(listTaskReservations(f.store), before);
  assert.deepEqual(listTaskReservations(f.store)[0].lease, active);
  assert.deepEqual(listTaskReservations(f.store)[0].tasks, input.tasks);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(input.runId)?.activity?.project), 'another-project');
});
