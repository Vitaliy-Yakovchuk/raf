import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { execute, type ExecutionResult } from '../src/cli.ts';
import { createBugHandlers, type BugCommandPorts } from '../src/bug-cli.ts';
import type { BugRepository } from '../src/bug-store.ts';
import { BugWriteError, type BugWriter, type ClaimsIssuer, type StatusWriteInput, type StatusWriteResult } from '../src/bug-sync.ts';
import {
  ACTOR,
  CLAIM_OWNER,
  ETCHLY,
  LEASE_MS,
  START,
  canonical,
  createBugHarness,
  revisionConflict,
  serverKey,
  type BugHarness,
  type SeedBug,
} from './bug-sync-fixture.ts';

const KEY = canonical(ETCHLY, '344');
const SERVER_KEY = serverKey(ETCHLY, '344');
const REASON = 'дубль звіту, виправляти нічого';
const confRoot = new URL('../../conf/', import.meta.url);
const constants = JSON.parse(readFileSync(new URL('raf-constants.json', confRoot), 'utf8'));
const models = JSON.parse(readFileSync(new URL('models.json', confRoot), 'utf8'));
const projects = JSON.parse(readFileSync(new URL('projects.json', confRoot), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects);

async function synced(t: TestContext, seed: Partial<SeedBug> = {}): Promise<BugHarness> {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, { rawId: '344', ...seed });
  const outcome = await h.syncer.pullSection(ETCHLY.sectionId);
  assert.equal(outcome.errorCode, null);
  return h;
}

function stored(h: BugHarness): string {
  const dump = (table: string) => JSON.stringify(h.repo.database.prepare(`SELECT * FROM ${table}`).all());
  return dump('bugs') + dump('comments');
}

function serverBug(h: BugHarness): { status: string; claimedBy: string | null; revision: number; claimToken: string | null } {
  const bug = h.server.state(SERVER_KEY);
  return { status: bug.status, claimedBy: bug.claimedBy, revision: bug.revision, claimToken: bug.claimToken };
}

const writeError = (code: string, serverCode: string | null = null) => (error: unknown): boolean => {
  assert.ok(error instanceof BugWriteError, `expected BugWriteError, got ${String(error)}`);
  assert.equal(error.code, code);
  if (serverCode !== null) assert.equal(error.serverCode, serverCode);
  return true;
};

function liveLease(owner: string, token: string): Pick<SeedBug, 'claimedBy' | 'claimToken' | 'claimExpiresAt' | 'status'> {
  return {
    status: 'in_progress',
    claimedBy: owner,
    claimToken: token,
    claimExpiresAt: new Date(Date.parse(START) + LEASE_MS).toISOString(),
  };
}

test('fixed and rejected take a dash claim, send the reason and leave the lease released', async (t) => {
  for (const status of ['rejected', 'fixed'] as const) {
    await t.test(status, async () => {
      const h = await synced(t);
      const beforeLocal = stored(h);

      const result = await h.writer.setStatus({ bugKey: KEY, status, reason: REASON });

      assert.deepEqual(h.server.mcpCalls.map((call) => call.tool), ['read_bug', 'set_problem_status', 'set_problem_status']);
      const [claim, terminal] = h.server.mcpCallsOf('set_problem_status');
      assert.equal(claim!.args.status, 'in_progress');
      assert.equal(claim!.args.claimToken, undefined);
      assert.equal(claim!.args.reason, undefined);
      assert.equal(claim!.auth.token.split('|')[1], 'write');
      assert.equal(terminal!.args.status, status);
      assert.equal(terminal!.args.reason, REASON);
      assert.equal(typeof terminal!.args.claimToken, 'string');
      assert.equal(terminal!.args.expected_revision, claim!.args.expected_revision as number + 1);
      assert.equal(h.server.mcpCallsOf('release_problem').length, 0);
      const token = String(terminal!.args.claimToken);
      assert.equal(result.status, status);
      assert.equal(result.bug.status, status);
      assert.equal(result.bug.claimedBy, null);
      assert.equal(h.repo.findBug(KEY).status, status);
      assert.equal(h.repo.findBug(KEY).claimedBy, null);
      assert.equal(serverBug(h).claimedBy, null);
      assert.equal(serverBug(h).status, status);
      assert.equal(JSON.stringify(result).includes(token), false);
      assert.equal(stored(h).includes(token), false);
      assert.notEqual(stored(h), beforeLocal);
    });
  }
});

test('fixed without a reason still takes and releases the lease', async (t) => {
  const h = await synced(t);

  const result = await h.writer.setStatus({ bugKey: KEY, status: 'fixed' });

  const [claim, terminal] = h.server.mcpCallsOf('set_problem_status');
  assert.equal(claim!.args.status, 'in_progress');
  assert.equal(terminal!.args.status, 'fixed');
  assert.equal(terminal!.args.reason, undefined);
  assert.equal(typeof terminal!.args.claimToken, 'string');
  assert.equal(result.status, 'fixed');
  assert.equal(result.bug.claimedBy, null);
  assert.equal(serverBug(h).claimedBy, null);
  assert.equal(stored(h).includes(String(terminal!.args.claimToken)), false);
});

test('an existing own lease is reused and the terminal status releases it', async (t) => {
  const h = await synced(t, liveLease(ACTOR, 'own-token'));

  const result = await h.writer.setStatus({ bugKey: KEY, status: 'rejected', reason: REASON });

  assert.deepEqual(h.server.mcpCalls.map((call) => call.tool), ['read_bug', 'set_problem_status']);
  const terminal = h.server.mcpCallsOf('set_problem_status')[0]!;
  assert.equal(terminal.args.status, 'rejected');
  assert.equal(terminal.args.reason, REASON);
  assert.equal(terminal.args.claimToken, 'own-token');
  assert.equal(h.server.mcpCallsOf('release_problem').length, 0);
  assert.equal(result.bug.claimedBy, null);
  assert.equal(serverBug(h).status, 'rejected');
  assert.equal(serverBug(h).claimedBy, null);
  assert.equal(JSON.stringify(result).includes('own-token'), false);
  assert.equal(stored(h).includes('own-token'), false);
});

test('a live foreign lease stays lease-required and the command writes nothing', async (t) => {
  const h = await synced(t, liveLease(CLAIM_OWNER, 'foreign-token'));
  const beforeLocal = stored(h);
  const beforeServer = serverBug(h);

  await assert.rejects(
    h.writer.setStatus({ bugKey: KEY, status: 'rejected', reason: REASON }),
    writeError('BUG_WRITE_REJECTED', 'lease-required'),
  );

  assert.equal(h.server.mcpCallsOf('set_problem_status')[0]?.args.status, 'in_progress');
  assert.equal(h.server.mcpCallsOf('release_problem').length, 0);
  assert.equal(stored(h), beforeLocal);
  assert.deepEqual(serverBug(h), beforeServer);
});

test('a refused terminal status releases only the lease this command took', async (t) => {
  const h = await synced(t);
  const beforeLocal = stored(h);
  h.server.failNextMcp('set_problem_status', revisionConflict(), 1);

  await assert.rejects(
    h.writer.setStatus({ bugKey: KEY, status: 'rejected', reason: REASON }),
    writeError('BUG_WRITE_REJECTED', 'revision-conflict'),
  );

  const [claim, terminal] = h.server.mcpCallsOf('set_problem_status');
  const release = h.server.mcpCallsOf('release_problem')[0];
  assert.equal(claim!.args.status, 'in_progress');
  assert.equal(terminal!.args.status, 'rejected');
  assert.equal(terminal!.args.reason, REASON);
  assert.equal(release?.args.claimToken, terminal!.args.claimToken);
  assert.equal(release?.args.reason, REASON);
  assert.equal(release?.args.expected_revision, terminal!.args.expected_revision);
  assert.equal(stored(h), beforeLocal);
  assert.equal(serverBug(h).claimedBy, null);
  assert.equal(serverBug(h).status, 'new');
  assert.equal(stored(h).includes(String(terminal!.args.claimToken)), false);
});

test('rejected without a reason is invalid-input and the lease taken for the attempt is released', async (t) => {
  const h = await synced(t);
  const beforeLocal = stored(h);

  await assert.rejects(h.writer.setStatus({ bugKey: KEY, status: 'rejected' }), writeError('BUG_WRITE_REJECTED', 'invalid-input'));

  assert.equal(h.server.mcpCallsOf('set_problem_status')[0]?.args.status, 'in_progress');
  const release = h.server.mcpCallsOf('release_problem')[0];
  assert.equal(typeof release?.args.claimToken, 'string');
  assert.equal(typeof release?.args.reason, 'string');
  assert.equal(stored(h), beforeLocal);
  assert.equal(serverBug(h).claimedBy, null);
  assert.notEqual(serverBug(h).status, 'in_progress');
});

test('a status other than fixed or rejected stays a single set_problem_status', async (t) => {
  const h = await synced(t);

  const result = await h.writer.setStatus({ bugKey: KEY, status: 'closed', reason: 'нотатка' });

  assert.deepEqual(h.server.mcpCalls.map((call) => call.tool), ['read_bug', 'set_problem_status']);
  const mutation = h.server.mcpCallsOf('set_problem_status')[0]!;
  assert.equal(mutation.args.status, 'closed');
  assert.equal(mutation.args.reason, 'нотатка');
  assert.equal(mutation.args.claimToken, undefined);
  assert.equal(h.server.mcpCallsOf('release_problem').length, 0);
  assert.equal(result.status, 'closed');
});

test('unknown status is still the server refusal and does not take a lease first', async (t) => {
  const h = await synced(t);
  const before = stored(h);

  await assert.rejects(h.writer.setStatus({ bugKey: KEY, status: 'no-such-status' }), writeError('BUG_WRITE_REJECTED', 'invalid-input'));

  assert.deepEqual(h.server.mcpCalls.map((call) => call.tool), ['read_bug', 'set_problem_status']);
  assert.equal(h.server.mcpCallsOf('set_problem_status')[0]?.args.status, 'no-such-status');
  assert.equal(h.server.mcpCallsOf('release_problem').length, 0);
  assert.equal(stored(h), before);
});

function cliSuccess(result: ExecutionResult): Record<string, unknown> {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function cliFailure(result: ExecutionResult, code: string): Record<string, unknown> {
  assert.equal(result.exitCode, 1, result.stdout);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr) as { code: string };
  assert.equal(error.code, code, result.stderr);
  return error as unknown as Record<string, unknown>;
}

function cliHarness(t: TestContext): { statuses: StatusWriteInput[]; texts: Map<string, Uint8Array>; run(argv: readonly string[]): Promise<ExecutionResult> } {
  const statuses: StatusWriteInput[] = [];
  const texts = new Map<string, Uint8Array>();
  const writer: BugWriter = {
    async addComment() { throw new Error('comment is not used'); },
    async setStatus(input) {
      statuses.push(input);
      const bug = { key: input.bugKey, revision: 2, status: input.status, claimedBy: null, comments: [], attachments: [] };
      return { bugKey: input.bugKey, operationId: 'op-status', revision: 2, status: input.status, bug } as StatusWriteResult;
    },
  };
  const ports: BugCommandPorts = {
    loadConfig: () => ({ pageLimit: 20 }) as BugCommandPorts['loadConfig'] extends () => infer T ? T : never,
    openRepository: () => ({ close() {} }) as BugRepository,
    claims: async () => ({}) as ClaimsIssuer,
    openCache: () => { throw new Error('cache is not used'); },
    writer: () => writer,
    readText: async (file) => {
      const bytes = texts.get(file);
      if (!bytes) throw new Error(`ENOENT: ${file}`);
      return bytes;
    },
    now: () => new Date(START),
  };
  const handlers = createBugHandlers(ports);
  t.after(() => undefined);
  return { statuses, texts, run: (argv) => execute(argv, catalog, handlers) };
}

test('bug status set help keeps --text-file optional', async (t) => {
  const h = cliHarness(t);
  const help = cliSuccess(await h.run(['bug', 'status', 'set', '--help']));
  const command = (help.commands as { parameters: { option: string; requirement: string }[] }[])[0]!;
  assert.deepEqual(command.parameters.map((parameter) => [parameter.option, parameter.requirement]), [
    ['--bug', 'required'],
    ['--status', 'required'],
    ['--text-file', 'optional'],
  ]);
});

test('bug status set passes --text-file as the reason and still accepts a status without it', async (t) => {
  const h = cliHarness(t);
  h.texts.set('reason.txt', Buffer.from(`${REASON}\n`));
  h.texts.set('-', Buffer.from('зі stdin'));
  h.texts.set('note.txt', Buffer.from('нотатка'));
  h.texts.set('blank.txt', Buffer.from(' \n\t'));
  h.texts.set('latin1.txt', Buffer.from([0xc3, 0x28, 0x41]));

  const rejected = cliSuccess(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'rejected', '--text-file', 'reason.txt']));
  assert.equal(rejected.status, 'rejected');
  const fixed = cliSuccess(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'fixed', '--text-file', '-']));
  assert.equal(fixed.status, 'fixed');
  cliSuccess(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'closed']));
  cliSuccess(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'closed', '--text-file', 'note.txt']));
  cliSuccess(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'rejected', '--text-file', 'blank.txt']));
  cliFailure(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'rejected', '--text-file', 'absent.txt']), 'COMMENT_TEXT_UNREADABLE');
  cliFailure(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'fixed', '--text-file', 'latin1.txt']), 'COMMENT_TEXT_INVALID');

  assert.deepEqual(h.statuses, [
    { bugKey: KEY, status: 'rejected', reason: `${REASON}\n` },
    { bugKey: KEY, status: 'fixed', reason: 'зі stdin' },
    { bugKey: KEY, status: 'closed' },
    { bugKey: KEY, status: 'closed', reason: 'нотатка' },
    { bugKey: KEY, status: 'rejected', reason: ' \n\t' },
  ]);
});
