import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentControlService } from '../src/agent-control.ts';
import type { AgentControlDependencies } from '../src/agent-control.ts';
import type { ProcessIdentity, SessionRecord, SessionRepository, SessionTransaction } from '../src/session-state.ts';
import { nativeId, now, pending, processIdentity, runId, sessionRecord } from './fixtures/agy-session-start.ts';

function fixture(id: string | null = null) {
  let record = sessionRecord(id);
  let closed = false;
  const delivered: { target: ProcessIdentity; text: string }[] = [];
  const interrupted: ProcessIdentity[] = [];
  const closes: ProcessIdentity[] = [];
  const tx = {
    getSession: (key: string) => key === runId ? structuredClone(record) : undefined,
    listSessions: () => [structuredClone(record)],
    putSession: (value: SessionRecord) => { record = structuredClone(value); },
    listReservations: () => [], listPending: () => [], applyEffects: () => {},
  } as unknown as SessionTransaction;
  const repository: SessionRepository = { transaction: action => action(tx) };
  const dependencies: AgentControlDependencies = {
    repository,
    scanner: {
      inspect: async identity => closed
        ? { state: 'exited', observedAt: now, exitCode: 0, evidence: 'owned child exited' }
        : { state: 'alive', observedAt: now, identity: structuredClone(identity) },
    },
    authority: { resolve: async () => ({ kind: 'system' }) },
    transport: {
      deliver: async (target, text) => { delivered.push({ target: structuredClone(target), text }); return { accepted: true, receiptId: 'q411-receipt' }; },
      close: async target => { closes.push(structuredClone(target)); closed = true; },
      interrupt: async target => { interrupted.push(structuredClone(target)); },
    },
    coordinator: {
      prepareClose: async () => structuredClone(record),
      observe: async (_session, observation) => {
        record = { ...record, observation, revision: record.revision + 1 };
        return structuredClone(record);
      },
      updateActivity: async (_session, update) => {
        record = { ...record, activity: { ...record.activity!, ...update } };
        return structuredClone(record);
      },
      finalize: async () => { record = { ...record, state: 'finished' }; return structuredClone(record); },
      publish: async () => {}, acceptPendingReport: async () => structuredClone(record),
    },
    reminders: { sessionEnded: () => ({ allowed: true, unfinished: [] }) },
    projects: ['raf'], agentTypes: ['implement'], agentPhases: ['implement'],
  };
  return {
    dependencies, service: new AgentControlService(dependencies), delivered, interrupted, closes,
    record: () => structuredClone(record),
    confirm: () => { record = { ...record, revision: record.revision + 1, process: processIdentity(nativeId) }; },
  };
}

for (const id of [null, nativeId]) {
  const state = id === null ? 'pending' : 'confirmed';
  test(`I6 inspection exposes true ${state} identity without substituting the agent address`, async () => {
    const f = fixture(id);
    const result = await f.service.ps();
    assert.equal(result.length, 1);
    assert.equal(result[0].process!.runnerSessionId, id);
    const native = (result[0].process as unknown as { nativeIdentity: unknown }).nativeIdentity;
    assert.deepEqual(native, id === null ? pending : {
      state: 'confirmed', id: nativeId, source: 'session_start', observedAt: now,
    });
    assert.equal(result[0].addressId, 'q411-agent');
  });

  test(`I6 message in ${state} uses the verified process and sends once`, async () => {
    const f = fixture(id);
    const receipt = await f.service.message({ to: 'q411-agent', text: 'continue the same assignment' }, {});
    assert.equal(receipt.accepted, true);
    assert.equal(f.delivered.length, 1);
    assert.equal(f.delivered[0].target.runnerSessionId, id);
    assert.equal(f.delivered[0].target.pid, processIdentity().pid);
    assert.deepEqual(f.delivered[0].target.evidence, processIdentity().evidence);
    assert.equal(f.record().process!.runnerSessionId, id);
  });

  test(`I6 interrupt in ${state} does not require or manufacture a native ID`, async () => {
    const f = fixture(id);
    await f.service.interrupt('q411-agent');
    assert.equal(f.interrupted.length, 1);
    assert.equal(f.interrupted[0].runnerSessionId, id);
    assert.equal(f.delivered.length, 0);
    assert.equal(f.record().process!.runnerSessionId, id);
  });

  test(`I6 stop and cleanup in ${state} operate on the owned OS/tmux process`, async () => {
    const f = fixture(id);
    const result = await f.service.close('q411-agent');
    assert.equal(result.closed, true);
    assert.equal(f.closes.length, 1);
    assert.equal(f.closes[0].runnerSessionId, id);
    assert.deepEqual(f.closes[0].evidence, processIdentity().evidence);
    assert.equal(f.delivered.length, 0);
    assert.equal(f.record().state, 'finished');
  });
}

for (const action of ['ps', 'message', 'interrupt', 'close'] as const) {
  test(`I4 ${action}: native ID enrichment during inspection preserves stable process ownership`, async () => {
    const f = fixture();
    let enriched = false;
    const inspect = f.dependencies.scanner.inspect;
    f.dependencies.scanner.inspect = async identity => {
      if (!enriched) {
        enriched = true;
        f.confirm();
        return { state: 'alive', observedAt: now, identity: processIdentity(nativeId) };
      }
      return inspect(identity);
    };
    if (action === 'ps') assert.equal((await f.service.ps())[0].process!.runnerSessionId, nativeId);
    if (action === 'message') assert.equal((await f.service.message({ to: 'q411-agent', text: 'one message' }, {})).accepted, true);
    if (action === 'interrupt') await f.service.interrupt('q411-agent');
    if (action === 'close') await f.service.close('q411-agent');
    assert.equal(f.record().process!.runnerSessionId, nativeId);
    const targets = [...f.delivered.map(value => value.target), ...f.interrupted, ...f.closes];
    for (const target of targets) {
      assert.equal(target.pid, processIdentity().pid);
      assert.equal(target.startedAt, processIdentity().startedAt);
      assert.deepEqual(target.evidence, processIdentity().evidence);
    }
  });
}

for (const field of ['pid', 'startedAt', 'machineId', 'bootId', 'command', 'tmuxSocket', 'tmuxPane', 'tmuxSession'] as const) {
  test(`I2/I6 unchanged native ID cannot authorize a different ${field}`, async () => {
    const f = fixture(nativeId);
    const foreign = processIdentity(nativeId);
    if (field === 'pid') foreign.pid++;
    else if (field === 'startedAt' || field === 'tmuxSession') foreign[field] += '-foreign';
    else foreign.evidence = { ...foreign.evidence, [field]: foreign.evidence[field] + '-foreign' };
    f.dependencies.scanner.inspect = async () => ({ state: 'alive', observedAt: now, identity: foreign });
    await f.service.message({ to: 'q411-agent', text: 'must not be delivered' }, {}).catch(() => {});
    await f.service.interrupt('q411-agent').catch(() => {});
    await f.service.close('q411-agent').catch(() => {});
    assert.equal(f.delivered.length, 0);
    assert.equal(f.interrupted.length, 0);
    assert.equal(f.closes.length, 0);
  });
}
