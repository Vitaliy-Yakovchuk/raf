import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTOR, canonical, createBugHarness, ETCHLY, serverKey, START } from './bug-sync-fixture.ts';

const KEY = canonical(ETCHLY, 'terminal');
const SERVER_KEY = serverKey(ETCHLY, 'terminal');

test('awaiting_verification goes directly to fixed without taking a claim', async (t) => {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, { rawId: 'terminal', status: 'awaiting_verification' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  const revision = h.server.state(SERVER_KEY).revision;

  const result = await h.writer.setStatus({ bugKey: KEY, status: 'fixed', reason: 'Зміну архівовано' });

  const writes = h.server.mcpCallsOf('set_problem_status');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.args.status, 'fixed');
  assert.equal(writes[0]!.args.expected_revision, revision);
  assert.equal(writes[0]!.args.claimToken, undefined);
  assert.equal(writes[0]!.args.reason, 'Зміну архівовано');
  assert.equal(h.server.mcpCallsOf('release_problem').length, 0);
  assert.equal(h.server.mutations, 1);
  assert.equal(result.status, 'fixed');
  assert.equal(result.bug.status, 'fixed');
  assert.equal(result.revision, revision + 1);
  assert.equal(h.repo.findBug(KEY).status, 'fixed');
  assert.equal(h.server.state(SERVER_KEY).claimedBy, null);
});

for (const status of ['fixed', 'rejected', 'awaiting_verification', 'in_progress']) {
  test(`setting the current ${status} status succeeds without a server write`, async (t) => {
    const h = createBugHarness(t);
    h.server.seedBug(ETCHLY, { rawId: 'terminal', status });
    await h.syncer.pullSection(ETCHLY.sectionId);
    const before = structuredClone(h.server.state(SERVER_KEY));

    const result = await h.writer.setStatus({ bugKey: KEY, status });

    assert.deepEqual(h.server.mcpCalls.map(call => call.tool), ['read_bug']);
    assert.equal(h.server.mutations, 0);
    assert.deepEqual(h.server.state(SERVER_KEY), before);
    assert.equal(result.status, status);
    assert.equal(result.bug.status, status);
    assert.equal(result.revision, before.revision);
  });
}

test('the current server status makes a stale local status request a no-op', async (t) => {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, { rawId: 'terminal', status: 'awaiting_verification' });
  await h.syncer.pullSection(ETCHLY.sectionId);
  h.server.setStatus(SERVER_KEY, 'fixed');
  const server = h.server.state(SERVER_KEY);

  const result = await h.writer.setStatus({ bugKey: KEY, status: 'fixed' });

  assert.deepEqual(h.server.mcpCalls.map(call => call.tool), ['read_bug']);
  assert.equal(h.server.mutations, 0);
  assert.equal(result.status, 'fixed');
  assert.equal(result.bug.status, 'fixed');
  assert.equal(result.revision, server.revision);
});

test('awaiting_verification with an expired claim goes directly to fixed', async (t) => {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, {
    rawId: 'terminal', status: 'awaiting_verification', claimedBy: ACTOR,
    claimToken: 'expired-token', claimExpiresAt: START,
  });
  await h.syncer.pullSection(ETCHLY.sectionId);

  const result = await h.writer.setStatus({ bugKey: KEY, status: 'fixed' });

  assert.deepEqual(h.server.mcpCalls.map(call => call.tool), ['read_bug', 'set_problem_status']);
  assert.equal(h.server.mcpCallsOf('set_problem_status')[0]!.args.status, 'fixed');
  assert.equal(h.server.mcpCallsOf('set_problem_status')[0]!.args.claimToken, undefined);
  assert.equal(h.server.mutations, 1);
  assert.equal(result.status, 'fixed');
});
