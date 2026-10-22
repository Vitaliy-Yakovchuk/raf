import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BugStoreError } from '../src/bug-store.ts';
import { BugServerError, BugWriteError, createHttpBugMcp, type BugMcpTool, type ServerAuth } from '../src/bug-sync.ts';
import {
  accessDenied,
  ACTOR,
  canonical,
  CLAIM_OWNER,
  createBugHarness,
  ETCHLY,
  invalidInput,
  LEASE_MS,
  leaseRequired,
  networkDown,
  notFound,
  revisionConflict,
  serverKey,
  START,
  storageUnavailable,
  timedOut,
  type BugHarness,
  type SeedBug,
} from './bug-sync-fixture.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = canonical(ETCHLY, '344');
const SERVER_KEY = serverKey(ETCHLY, '344');

async function synced(t: Parameters<typeof createBugHarness>[0], seed: Partial<SeedBug> = {}): Promise<BugHarness> {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, { rawId: '344', ...seed });
  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);
  assert.equal(outcome.errorCode, null);
  return h;
}

function snapshot(h: BugHarness): string {
  const rows = (table: string) => h.repo.database.prepare(`SELECT * FROM ${table}`).all();
  return JSON.stringify({ bug: h.repo.findBug(KEY), list: h.repo.listBugs({ limit: 50 }), bugs: rows('bugs'), comments: rows('comments'), sync: rows('sync_state') });
}

function storedText(h: BugHarness): string {
  const dump = (table: string) => JSON.stringify(h.repo.database.prepare(`SELECT * FROM ${table}`).all());
  return dump('bugs') + dump('comments');
}

const writeError = (code: string, serverCode: string | null = null) => (error: unknown): boolean => {
  assert.ok(error instanceof BugWriteError, `expected BugWriteError, got ${String(error)}`);
  assert.equal(error.code, code);
  if (serverCode !== null) assert.equal(error.serverCode, serverCode);
  return true;
};

test('comment add calls MCP with a fresh revision and writes the server answer locally at once', async (t) => {
  const h = await synced(t);
  const server = h.server.state(SERVER_KEY);
  h.server.addComment(server.key, 'human', 'людина після pull');
  const pullCalls = h.server.calls.length;

  const result = await h.writer.addComment({ bugKey: KEY, text: 'Перевірено агентом' });

  assert.deepEqual(h.server.mcpCalls.map((call) => call.tool), ['read_bug', 'comment_problem']);
  const [read, mutation] = h.server.mcpCalls;
  assert.equal(read!.args.id, server.problemId);
  assert.equal(read!.auth.token.split('|')[1], 'read');
  assert.equal(mutation!.auth.token.split('|')[1], 'write');
  for (const call of h.server.mcpCalls) {
    assert.equal(call.auth.origin, h.config.origin);
    assert.equal(call.auth.project, ETCHLY.project);
    assert.equal(call.auth.env, ETCHLY.env);
    assert.equal(call.auth.timeoutMs, h.config.requestTimeoutMs);
  }
  assert.equal(mutation!.args.problem_id, server.problemId);
  assert.equal(mutation!.args.expected_revision, 2, 'revision comes from the fresh read, not from the stale local copy');
  assert.equal(mutation!.args.comment, 'Перевірено агентом');
  assert.match(String(mutation!.args.operation_id), UUID);
  assert.deepEqual(h.operationIds, [mutation!.args.operation_id]);
  assert.equal(mutation!.args.claimToken, undefined);
  assert.equal(mutation!.args.reply_to, undefined);

  const created = h.server.serverComments(server.key).at(-1)!;
  assert.equal(result.bugKey, KEY);
  assert.equal(result.operationId, mutation!.args.operation_id);
  assert.equal(result.commentId, created.id);
  assert.equal(result.revision, 3);
  assert.equal(result.comment.serverId, created.id);
  assert.equal(result.comment.text, 'Перевірено агентом');
  assert.equal(result.bug.revision, 3);

  assert.equal(h.server.calls.length, pullCalls, 'no pull is needed to see the comment');
  const local = h.repo.findBug(KEY);
  assert.equal(local.revision, 3);
  const mine = local.comments.filter((comment) => comment.text === 'Перевірено агентом');
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.serverId, created.id);
  assert.equal(mine[0]!.authorId, ACTOR);
  assert.deepEqual(h.server.callsOf('comment'), []);
});

test('the next pull after a synchronous comment converges to the server without duplicates or notices', async (t) => {
  const h = await synced(t);
  await h.writer.addComment({ bugKey: KEY, text: 'один раз' });

  await h.syncer.pullSection(ETCHLY.sectionId);
  await h.syncer.pullSection(ETCHLY.sectionId);

  const local = h.repo.findBug(KEY);
  const key = SERVER_KEY;
  assert.equal(local.revision, h.server.state(key).revision);
  assert.deepEqual(local.comments.map((comment) => comment.serverId), h.server.serverComments(key).map((comment) => comment.id));
  assert.deepEqual(h.visibleTexts(KEY), ['один раз']);
  assert.deepEqual(h.notifier.calls, []);
});

test('status set forwards the status to MCP and stores the returned bug state', async (t) => {
  const h = await synced(t);

  const result = await h.writer.setStatus({ bugKey: KEY, status: 'closed' });

  assert.deepEqual(h.server.mcpCalls.map((call) => call.tool), ['read_bug', 'set_problem_status']);
  const mutation = h.server.mcpCallsOf('set_problem_status')[0]!;
  assert.equal(mutation.args.status, 'closed');
  assert.equal(mutation.args.expected_revision, 1);
  assert.match(String(mutation.args.operation_id), UUID);
  assert.equal(mutation.auth.token.split('|')[1], 'write');
  assert.equal(result.status, 'closed');
  assert.equal(result.revision, 2);
  const local = h.repo.findBug(KEY);
  assert.equal(local.status, 'closed');
  assert.equal(local.revision, 2);
  assert.deepEqual(local.comments, []);
});

test('raf does not check the status list itself and reports the server refusal', async (t) => {
  const h = await synced(t);
  const before = snapshot(h);

  await assert.rejects(h.writer.setStatus({ bugKey: KEY, status: 'no-such-status' }), writeError('BUG_WRITE_REJECTED', 'invalid-input'));

  assert.equal(h.server.mcpCallsOf('set_problem_status')[0]?.args.status, 'no-such-status');
  assert.equal(snapshot(h), before);
});

test('in_progress claims the bug for raf and the claim token is never stored locally', async (t) => {
  const h = await synced(t);

  const claimed = await h.writer.setStatus({ bugKey: KEY, status: 'in_progress' });

  const key = SERVER_KEY;
  const token = h.server.state(key).claimToken!;
  assert.ok(token);
  assert.equal(claimed.bug.claimedBy, ACTOR);
  assert.equal(h.repo.findBug(KEY).claimedBy, ACTOR);
  assert.ok(!storedText(h).includes(token), 'claim token must not reach bugs.sqlite');
  assert.ok(!JSON.stringify(claimed).includes(token), 'claim token must not be returned to the caller');

  await h.writer.addComment({ bugKey: KEY, text: 'під власною орендою' });

  const comment = h.server.mcpCallsOf('comment_problem')[0]!;
  assert.equal(comment.args.claimToken, token, 'own live lease token comes from the fresh read_bug');
  assert.equal(comment.args.reply_to, undefined);
  assert.ok(!storedText(h).includes(token));

  await h.syncer.pullSection(ETCHLY.sectionId);
  assert.ok(!storedText(h).includes(token));
});

test('an expired own lease is not passed and the server decides', async (t) => {
  const h = await synced(t, { claimedBy: ACTOR, claimToken: 'expired-token', claimExpiresAt: new Date(Date.parse(START) - 1000).toISOString() });

  await h.writer.addComment({ bugKey: KEY, text: 'після спливу оренди' });

  assert.equal(h.server.mcpCallsOf('comment_problem')[0]?.args.claimToken, undefined);
  assert.deepEqual(h.visibleTexts(KEY), ['після спливу оренди']);
});

test('a comment to a bug claimed by another actor replies to the last comment of the claim owner', async (t) => {
  const h = await synced(t, {
    claimedBy: CLAIM_OWNER,
    claimExpiresAt: new Date(Date.parse(START) + LEASE_MS).toISOString(),
    comments: [
      { authorId: CLAIM_OWNER, text: 'перший від власника' },
      { authorId: 'human', text: 'людина' },
      { authorId: CLAIM_OWNER, text: 'останній від власника' },
      { authorId: 'human', text: 'ще людина' },
    ],
  });
  const key = SERVER_KEY;
  const lastOwner = h.server.serverComments(key).filter((comment) => comment.authorId === CLAIM_OWNER).at(-1)!;

  const result = await h.writer.addComment({ bugKey: KEY, text: 'відповідь власнику claim' });

  const mutation = h.server.mcpCallsOf('comment_problem')[0]!;
  assert.equal(mutation.args.reply_to, lastOwner.id);
  assert.equal(mutation.args.claimToken, undefined);
  assert.equal(result.comment.replyTo, lastOwner.id);
  assert.equal(h.repo.findBug(KEY).comments.find((comment) => comment.text === 'відповідь власнику claim')?.replyTo, lastOwner.id);
});

test('a foreign claim without an owner comment fails without a mutation or local change', async (t) => {
  const h = await synced(t, { claimedBy: CLAIM_OWNER, claimExpiresAt: new Date(Date.parse(START) + LEASE_MS).toISOString(), comments: [{ authorId: 'human', text: 'людина' }] });
  const before = snapshot(h);

  await assert.rejects(h.writer.addComment({ bugKey: KEY, text: 'нікому відповісти' }), writeError('BUG_WRITE_REPLY_TARGET_MISSING'));

  assert.deepEqual(h.server.mcpCallsOf('comment_problem'), []);
  assert.equal(h.server.mutations, 0);
  assert.equal(snapshot(h), before);
});

const rejections: readonly [string, () => BugServerError, number | null][] = [
  ['revision-conflict', revisionConflict, 409],
  ['lease-required', leaseRequired, 409],
  ['access-denied', accessDenied, 403],
  ['not-found', notFound, 404],
  ['invalid-input', invalidInput, 422],
  ['bug-storage-unavailable', storageUnavailable, 503],
];

for (const [code, error, status] of rejections) {
  for (const tool of ['comment_problem', 'set_problem_status'] as const) {
    test(`a ${code} refusal of ${tool} is a command error without local changes or retries`, async (t) => {
      const h = await synced(t);
      const before = snapshot(h);
      h.server.failNextMcp(tool, error());

      const write = tool === 'comment_problem' ? h.writer.addComment({ bugKey: KEY, text: 'відхилено' }) : h.writer.setStatus({ bugKey: KEY, status: 'closed' });

      await assert.rejects(write, (failure: unknown) => {
        writeError('BUG_WRITE_REJECTED', code)(failure);
        assert.equal((failure as BugWriteError).status, status);
        if (code === 'bug-storage-unavailable') assert.equal((failure as BugWriteError).retryAfterMs, 5000);
        return true;
      });
      assert.equal(h.server.mcpCallsOf(tool).length, 1, 'raf never retries a write automatically');
      assert.equal(h.server.mutations, 0);
      assert.equal(snapshot(h), before);
    });
  }
}

for (const [name, error] of [['network', networkDown], ['timeout', timedOut]] as const) {
  test(`an unknown result after ${name} is BUG_WRITE_UNKNOWN without local changes or retries`, async (t) => {
    const h = await synced(t);
    const before = snapshot(h);
    h.server.failNextMcp('comment_problem', error());

    await assert.rejects(h.writer.addComment({ bugKey: KEY, text: 'невідомо' }), writeError('BUG_WRITE_UNKNOWN'));

    assert.equal(h.server.mcpCallsOf('comment_problem').length, 1);
    assert.equal(snapshot(h), before);
  });
}

test('a write applied on the server whose answer was lost reaches the local copy only through pull', async (t) => {
  const h = await synced(t);
  const before = snapshot(h);
  h.server.loseNextMcpResponse('comment_problem');

  await assert.rejects(h.writer.addComment({ bugKey: KEY, text: 'застосовано, відповідь втрачено' }), writeError('BUG_WRITE_UNKNOWN'));

  assert.equal(h.server.mutations, 1);
  assert.equal(snapshot(h), before);
  await h.syncer.pullSection(ETCHLY.sectionId);
  assert.deepEqual(h.visibleTexts(KEY), ['застосовано, відповідь втрачено']);
  await h.syncer.pullSection(ETCHLY.sectionId);
  assert.deepEqual(h.visibleTexts(KEY), ['застосовано, відповідь втрачено']);
});

test('each command uses a new operation id and a failed command is not replayed by the next one', async (t) => {
  const h = await synced(t);
  h.server.failNextMcp('comment_problem', networkDown());

  await assert.rejects(h.writer.addComment({ bugKey: KEY, text: 'перша спроба' }), writeError('BUG_WRITE_UNKNOWN'));
  await h.writer.addComment({ bugKey: KEY, text: 'друга команда' });

  const ids = h.server.mcpCallsOf('comment_problem').map((call) => call.args.operation_id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(h.server.mcpCallsOf('comment_problem').map((call) => call.args.comment), ['перша спроба', 'друга команда']);
  assert.deepEqual(h.visibleTexts(KEY), ['друга команда']);
});

test('a failed fresh read sends no mutation and changes nothing locally', async (t) => {
  const h = await synced(t);
  const before = snapshot(h);
  h.server.failNextMcp('read_bug', networkDown());

  await assert.rejects(h.writer.addComment({ bugKey: KEY, text: 'не дійде' }), (error: unknown) => error instanceof BugWriteError);

  assert.deepEqual(h.server.mcpCallsOf('comment_problem'), []);
  assert.equal(snapshot(h), before);
});

const invalidAnswers: readonly [string, BugMcpTool, (result: Record<string, unknown>) => unknown][] = [
  ['ok is not true', 'comment_problem', (result) => ({ ...result, ok: false })],
  ['problem_id differs', 'comment_problem', (result) => ({ ...result, problem_id: 'problem-other' })],
  ['operation_id differs', 'comment_problem', (result) => ({ ...result, operation_id: '00000000-0000-4000-8000-000000000000' })],
  ['comment id differs from comment_id', 'comment_problem', (result) => ({ ...result, comment: { ...(result.comment as object), id: 'srv-c-other' } })],
  ['bug revision differs from revision', 'comment_problem', (result) => ({ ...result, bug: { ...(result.bug as object), revision: 99 } })],
  ['comment is missing', 'comment_problem', (result) => ({ ...result, comment: undefined, comment_id: undefined })],
  ['bug is missing', 'comment_problem', (result) => ({ ...result, bug: undefined })],
  ['not an object', 'comment_problem', () => 'ok'],
  ['status bug is missing', 'set_problem_status', (result) => ({ ...result, bug: undefined })],
  ['status revision differs', 'set_problem_status', (result) => ({ ...result, revision: 99 })],
];

for (const [name, tool, rewrite] of invalidAnswers) {
  test(`an invalid ${tool} answer (${name}) is BUG_WRITE_INVALID_RESPONSE without local changes`, async (t) => {
    const h = await synced(t);
    const before = snapshot(h);
    h.server.rewriteNextMcpResult(tool, rewrite);

    const write = tool === 'comment_problem' ? h.writer.addComment({ bugKey: KEY, text: 'невалідна відповідь' }) : h.writer.setStatus({ bugKey: KEY, status: 'closed' });

    await assert.rejects(write, writeError('BUG_WRITE_INVALID_RESPONSE'));
    assert.equal(snapshot(h), before);
  });
}

test('a bug missing locally is BUG_NOT_FOUND without any network call', async (t) => {
  const h = await synced(t);

  await assert.rejects(h.writer.addComment({ bugKey: canonical(ETCHLY, '999'), text: 'немає жука' }), (error: unknown) => error instanceof BugStoreError && error.code === 'bug-not-found');
  await assert.rejects(h.writer.setStatus({ bugKey: canonical(ETCHLY, '999'), status: 'closed' }), (error: unknown) => error instanceof BugStoreError && error.code === 'bug-not-found');

  assert.deepEqual(h.server.mcpCalls, []);
});

test('an empty comment is refused before any network call', async (t) => {
  const h = await synced(t);

  await assert.rejects(h.writer.addComment({ bugKey: KEY, text: '  \n' }));

  assert.deepEqual(h.server.mcpCalls, []);
  assert.deepEqual(h.visibleTexts(KEY), []);
});

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input instanceof Request ? input.url : input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetch: fetcher };
}

const AUTH: ServerAuth = { origin: 'https://dash.test', project: 'etchly', env: 'prod', token: 'jwt-token', timeoutMs: 1000 };

const rpc = (result: unknown, status = 200): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status, headers: { 'content-type': 'application/json' } });

test('the MCP transport posts a JSON-RPC tools/call with the dash client headers and returns structuredContent', async () => {
  const answer = { contract_version: 2, ok: true, problem_id: 'p-1', operation_id: 'op-1', revision: 4 };
  const { calls, fetch } = fakeFetch(() => rpc({ content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer }));
  const mcp = createHttpBugMcp({ fetch });

  const result = await mcp.call(AUTH, 'set_problem_status', { problem_id: 'p-1', operation_id: 'op-1', expected_revision: 3, status: 'closed' });

  assert.deepEqual(result, answer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://dash.test/internal/mcp/bugs');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer jwt-token');
  assert.equal(headers.get('x-bugs-contract-version'), '2');
  assert.equal(headers.get('mcp-protocol-version'), '2025-11-25');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.match(headers.get('accept') ?? '', /application\/json/);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.method, 'tools/call');
  assert.ok(body.id !== undefined && body.id !== null);
  assert.deepEqual(body.params, { name: 'set_problem_status', arguments: { problem_id: 'p-1', operation_id: 'op-1', expected_revision: 3, status: 'closed' } });
});

test('an MCP isError result becomes a BugServerError with the server code, status and retry_after', async () => {
  const { fetch } = fakeFetch(() => rpc({ isError: true, content: [{ type: 'text', text: 'bug-storage-unavailable' }], structuredContent: { error: 'bug-storage-unavailable', status: 503, retry_after: 7 } }));
  const mcp = createHttpBugMcp({ fetch });

  await assert.rejects(mcp.call(AUTH, 'comment_problem', { problem_id: 'p-1' }), (error: unknown) => {
    assert.ok(error instanceof BugServerError);
    assert.equal(error.code, 'bug-storage-unavailable');
    assert.equal(error.status, 503);
    assert.equal(error.retryAfterMs, 7000);
    return true;
  });
  const conflictFetch = fakeFetch(() => rpc({ isError: true, content: [{ type: 'text', text: 'revision-conflict' }], structuredContent: { error: 'revision-conflict', status: 409 } }));
  await assert.rejects(createHttpBugMcp({ fetch: conflictFetch.fetch }).call(AUTH, 'comment_problem', {}), (error: unknown) => error instanceof BugServerError && error.code === 'revision-conflict' && error.status === 409);
});

test('HTTP refusals, network failures and timeouts of the MCP transport are typed', async () => {
  const unauthorized = fakeFetch(() => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }));
  await assert.rejects(createHttpBugMcp({ fetch: unauthorized.fetch }).call(AUTH, 'read_bug', { id: 'p-1' }), (error: unknown) => error instanceof BugServerError && error.status === 401);

  const offline = fakeFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(createHttpBugMcp({ fetch: offline.fetch }).call(AUTH, 'read_bug', { id: 'p-1' }), (error: unknown) => error instanceof BugServerError && error.status === null && error.code === 'network');

  const slow = fakeFetch(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
  await assert.rejects(createHttpBugMcp({ fetch: slow.fetch }).call(AUTH, 'read_bug', { id: 'p-1' }), (error: unknown) => error instanceof BugServerError && error.status === null && error.code === 'timeout');

  const garbage = fakeFetch(() => new Response('not json', { status: 200 }));
  await assert.rejects(createHttpBugMcp({ fetch: garbage.fetch }).call(AUTH, 'read_bug', { id: 'p-1' }));

  const rpcError = fakeFetch(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'unknown-tool' } }), { status: 200 }));
  await assert.rejects(createHttpBugMcp({ fetch: rpcError.fetch }).call(AUTH, 'read_bug', { id: 'p-1' }));
});
