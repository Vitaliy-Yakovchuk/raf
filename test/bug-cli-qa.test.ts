import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startBugSyncService, type BugSyncService, type MainNotifier } from '../src/bug-sync.ts';
import { FakeBugServer, networkDown, serverKey } from './bug-sync-fixture.ts';

const rafDevelop = fileURLToPath(new URL('../', import.meta.url));
const realConf = fileURLToPath(new URL('../../conf/', import.meta.url));
const constants = JSON.parse(readFileSync(join(realConf, 'raf-constants.json'), 'utf8'));
const APPROVED = ['bug list', 'bug show', 'bug comment add', 'bug attachment get'];
const ETCHLY = { project: 'etchly', env: 'prod', stand: 'prod', secret: 'DASH_BUGS_PROD_ETCHLY' };
const CRM = { project: 'crm', env: 'dev', stand: 'dev1', secret: 'DASH_BUGS_DEV1_CRM' };
const ETCHLY_KEY = 'projects/etchly/bug#344';
const CRM_KEY = 'projects/crm/bug#344';
const COMMENT = 'QA 3.4: локальний коментар\nдругий рядок — «лапки», emoji 🐞 і пробіли  в кінці  ';
const ATTACHMENT = Buffer.from('hello attachment');

interface Workspace {
  readonly base: string;
  readonly root: string;
  readonly home: string;
  readonly rafHome: string;
  readonly fetchLog: string;
  readonly preload: string;
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function workspace(): Workspace {
  const base = mkdtempSync(join(tmpdir(), 'raf-qa34-'));
  const root = join(base, 'root');
  const home = join(base, 'home');
  const rafHome = join(home, '.raf');
  mkdirSync(join(root, 'conf'), { recursive: true });
  mkdirSync(rafHome, { recursive: true, mode: 0o700 });
  symlinkSync(rafDevelop, join(root, 'raf-develop'));
  const settings = JSON.parse(readFileSync(join(realConf, 'raf.json'), 'utf8'));
  settings.bugs = { ...settings.bugs, attachmentCacheMaxBytes: 1_000_000, sections: [ETCHLY, CRM] };
  writeFileSync(join(root, 'conf', 'raf.json'), JSON.stringify(settings, null, 2));
  const secrets = [ETCHLY, CRM].map(section => ({
    name: section.secret, kind: 'env', value: `qa34-${section.secret}-${'x'.repeat(40)}`, source: 'qa34', updatedAt: '2026-10-22T00:00:00.000Z',
  }));
  writeFileSync(join(rafHome, 'secrets.json'), JSON.stringify({ version: 1, records: secrets }), { mode: 0o600 });
  chmodSync(join(rafHome, 'secrets.json'), 0o600);
  const fetchLog = join(base, 'fetch.log');
  writeFileSync(fetchLog, '');
  const preload = join(base, 'offline.mjs');
  writeFileSync(preload, [
    "import { appendFileSync } from 'node:fs';",
    'globalThis.fetch = async input => {',
    '  appendFileSync(process.env.QA_FETCH_LOG, String(input && input.url ? input.url : input) + "\\n");',
    "  throw new TypeError('fetch failed: network disabled by qa34');",
    '};',
  ].join('\n'));
  return { base, root, home, rafHome, fetchLog, preload };
}

function cli(ws: Workspace, argv: readonly string[], input?: string): CliResult {
  const result = spawnSync(process.execPath, [
    '--preserve-symlinks', '--preserve-symlinks-main', '--import', ws.preload, join(ws.root, 'raf-develop', 'bin', 'raf.ts'), ...argv,
  ], { env: { ...process.env, HOME: ws.home, QA_FETCH_LOG: ws.fetchLog }, input: input ?? '', encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function ok(result: CliResult): any {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function failed(result: CliResult, code: string, command: string): any {
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.stdout, '', 'a failure must not print a success payload');
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, code, result.stderr);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.remediation.some((step: string) => step === `raf help ${command}`), result.stderr);
  return error;
}

function fetches(ws: Workspace): string[] {
  return readFileSync(ws.fetchLog, 'utf8').split('\n').filter(Boolean);
}

function rafEntries(ws: Workspace): string[] {
  return readdirSync(ws.rafHome).sort();
}

function assertNoService(ws: Workspace): void {
  const unexpected = rafEntries(ws).filter(name => !/^(bugs\.sqlite(-wal|-shm)?|secrets\.json|attachments)$/.test(name));
  assert.deepEqual(unexpected, [], 'bug commands must not create state.sqlite or service files');
}

class MainInbox {
  readonly messages: { to: string; text: string }[] = [];
  available = false;
  readonly notifier: MainNotifier = {
    notify: async notice => {
      if (!this.available) throw new Error('Shared main delivery transport is unavailable or unverified');
      const text = `Bug comment conflict ${notice.kind} for ${notice.bugKey}, operation ${notice.operationId}; the local comment is kept undelivered until main decides: ${notice.text}`;
      this.messages.push({ to: 'main', text });
    },
  };
}

async function serviceCycle(ws: Workspace, server: FakeBugServer, inbox: MainInbox): Promise<void> {
  let wake: (() => Promise<void>) | undefined;
  const service: BugSyncService | null = await startBugSyncService({
    orchestratorRoot: ws.root, homeDirectory: ws.home, stateDirectory: ws.rafHome, now: () => Date.now(),
    schedule: (_at, next) => { wake = next; return () => { wake = undefined; }; },
    notifier: inbox.notifier, server, onError: error => { throw error; },
  });
  assert.ok(service, 'test conf has bugs section');
  try {
    assert.ok(wake);
    await wake();
  } finally {
    await service.stop();
  }
}

test('QA 3.4: approved bug commands through the real CLI with an isolated HOME and test conf', async t => {
  const ws = workspace();
  t.after(() => rmSync(ws.base, { recursive: true, force: true }));
  const server = new FakeBugServer();
  const inbox = new MainInbox();

  await t.test('catalog holds exactly the four approved bug commands and help is detailed', () => {
    const catalogBug = constants.commands.filter((command: { path: string[] }) => command.path[0] === 'bug').map((command: { path: string[] }) => command.path.join(' '));
    assert.deepEqual(catalogBug, APPROVED);
    const group = ok(cli(ws, ['help', 'bug']));
    assert.deepEqual(group.commands.map((command: { handlerName: string }) => command.handlerName), APPROVED);
    for (const name of APPROVED) {
      const viaFlag = ok(cli(ws, [...name.split(' '), '--help']));
      const viaHelp = ok(cli(ws, ['help', ...name.split(' ')]));
      assert.deepEqual(viaFlag, viaHelp);
      assert.equal(viaFlag.commands.length, 1);
      const command = viaFlag.commands[0];
      assert.equal(command.handlerName, name);
      for (const field of ['description', 'output', 'errors', 'prerequisites', 'sideEffects']) {
        assert.ok(typeof command.metadata[field] === 'string' && command.metadata[field].length > 20, `${name} help ${field}`);
      }
      for (const parameter of command.parameters) assert.ok(parameter.description.length > 5 && parameter.option.startsWith('--'));
      assert.match(command.metadata.prerequisites, /служба raf не потрібна/);
    }
    assert.match(ok(cli(ws, ['bug', 'comment', 'add', '--help'])).commands[0].metadata.output, /не є серверним підтвердженням/);
    assert.deepEqual(fetches(ws), []);
    assertNoService(ws);
  });

  await t.test('empty local base works without the service and without network', () => {
    const list = ok(cli(ws, ['bug', 'list']));
    assert.deepEqual(list, { source: 'local', bugs: [], nextCursor: null, sync: [] });
    assert.deepEqual(fetches(ws), []);
    assertNoService(ws);
  });

  await t.test('the sync service fills the separate bug base from a controlled dash, then stops', async () => {
    server.seedBug(ETCHLY, {
      rawId: '344', comments: [{ authorId: 'owner@example.test', text: 'server comment' }],
      attachments: [{ id: 'att-1', bytes: ATTACHMENT.length, sha256: createHash('sha256').update(ATTACHMENT).digest('hex') }],
    });
    server.seedBug(CRM, { rawId: '344' });
    await serviceCycle(ws, server, inbox);
    const list = ok(cli(ws, ['bug', 'list']));
    assert.deepEqual(list.bugs.map((bug: { key: string }) => bug.key).sort(), [CRM_KEY, ETCHLY_KEY]);
    assert.equal(list.sync.length, 2);
    assert.ok(list.sync.every((state: { snapshotComplete: boolean }) => state.snapshotComplete));
    const filtered = ok(cli(ws, ['bug', 'list', '--project', 'projects/crm']));
    assert.deepEqual(filtered.bugs.map((bug: { key: string }) => bug.key), [CRM_KEY]);
    const shown = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    assert.equal(shown.bug.presence, 'present');
    assert.deepEqual(shown.bug.comments.map((comment: { text: string }) => comment.text), ['server comment']);
    assert.equal(shown.bug.attachments[0].serverId, 'att-1');
    assert.equal(shown.bug.attachments[0].cacheState, 'absent');
    assert.ok(!existsSync(join(ws.rafHome, 'attachments')) || readdirSync(join(ws.rafHome, 'attachments')).length === 0, 'no attachment prefetch');
    assert.deepEqual(fetches(ws), []);
    assertNoService(ws);
  });

  let operationId = '';
  await t.test('comment add accepts locally with the service stopped and no network, and does not claim delivery', () => {
    const textFile = join(ws.base, 'comment.txt');
    writeFileSync(textFile, COMMENT);
    const accepted = ok(cli(ws, ['bug', 'comment', 'add', '--bug', ETCHLY_KEY, '--text-file', textFile]));
    assert.equal(accepted.source, 'local');
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.delivered, false);
    assert.equal(accepted.delivery, 'pending');
    assert.equal(accepted.state, 'pending');
    assert.match(accepted.notice, /асинхронно/);
    operationId = accepted.operationId;
    assert.match(operationId, /^[0-9a-f-]{36}$/);
    const fromStdin = ok(cli(ws, ['bug', 'comment', 'add', '--bug', CRM_KEY, '--text-file', '-'], 'stdin коментар'));
    assert.equal(fromStdin.delivered, false);
    assert.notEqual(fromStdin.operationId, operationId);
    const shown = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    const local = shown.bug.comments.find((comment: { origin: string }) => comment.origin === 'local');
    assert.equal(local.text, COMMENT);
    assert.equal(local.serverId, null);
    assert.equal(local.delivery.operationId, operationId);
    assert.equal(local.delivery.state, 'pending');
    assert.equal(local.delivery.serverCommentId, null);
    const crm = ok(cli(ws, ['bug', 'show', '--bug', CRM_KEY]));
    assert.deepEqual(crm.bug.comments.map((comment: { text: string }) => comment.text), ['stdin коментар']);
    const list = ok(cli(ws, ['bug', 'list']));
    assert.equal(list.bugs.find((bug: { key: string }) => bug.key === ETCHLY_KEY).pendingOperations, 1);
    assert.deepEqual(fetches(ws), []);
    assertNoService(ws);
    assert.equal(server.callsOf('comment').length, 0);
  });

  await t.test('a failed network send after restart keeps the comment pending and undelivered', async () => {
    server.failNext('comment', networkDown());
    server.failNext('comment', networkDown());
    await serviceCycle(ws, server, inbox);
    const shown = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    const local = shown.bug.comments.find((comment: { origin: string }) => comment.origin === 'local');
    assert.equal(local.text, COMMENT);
    assert.equal(local.serverId, null);
    assert.equal(local.delivery.state, 'unknown');
    assert.ok(local.delivery.attempts >= 1);
    assert.equal(server.serverComments(serverKey(ETCHLY, '344')).length, 1);
  });

  await t.test('server deletion with a pending comment keeps the text and makes the conflict visible to main', async () => {
    server.deleteBug(serverKey(ETCHLY, '344'));
    inbox.available = false;
    await serviceCycle(ws, server, inbox);
    const first = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    assert.equal(first.bug.presence, 'deleted');
    const local = first.bug.comments.find((comment: { origin: string }) => comment.origin === 'local');
    assert.equal(local.text, COMMENT);
    assert.equal(local.delivery.state, 'conflict');
    assert.equal(local.delivery.conflict, 'bug-deleted');
    assert.equal(local.serverId, null);
    assert.equal(first.bug.conflicts.length, 1);
    assert.equal(first.bug.conflicts[0].kind, 'bug-deleted');
    assert.equal(first.bug.conflicts[0].noticedAt, null, 'notice stays pending while main delivery is unavailable');
    assert.equal(inbox.messages.length, 0);
    const listed = ok(cli(ws, ['bug', 'list'])).bugs.find((bug: { key: string }) => bug.key === ETCHLY_KEY);
    assert.equal(listed.presence, 'deleted');
    assert.equal(listed.conflicts, 1);
    assert.equal(listed.pendingOperations, 1);

    inbox.available = true;
    await serviceCycle(ws, server, inbox);
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0]!.to, 'main');
    assert.ok(inbox.messages[0]!.text.includes(COMMENT), 'main sees the full undelivered text');
    assert.ok(inbox.messages[0]!.text.includes(operationId) && inbox.messages[0]!.text.includes('bug-deleted') && inbox.messages[0]!.text.includes(ETCHLY_KEY));
    await serviceCycle(ws, server, inbox);
    assert.equal(inbox.messages.length, 1, 'notice is not duplicated');
    const after = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    assert.ok(after.bug.conflicts[0].noticedAt);
    assert.equal(after.bug.comments.find((comment: { origin: string }) => comment.origin === 'local').text, COMMENT);
    assert.equal(server.mutations, 0, 'raf does not restore or deliver to the deleted bug');
  });

  await t.test('impossible or unimplemented operations fail with a JSON error, never a success payload', () => {
    const textFile = join(ws.base, 'comment2.txt');
    writeFileSync(textFile, 'ще один');
    const deleted = failed(cli(ws, ['bug', 'comment', 'add', '--bug', ETCHLY_KEY, '--text-file', textFile]), 'BUG_NOT_FOUND', 'bug comment add');
    assert.equal(deleted.details.found.presence, 'deleted');
    assert.equal(ok(cli(ws, ['bug', 'list'])).bugs.find((bug: { key: string }) => bug.key === ETCHLY_KEY).pendingOperations, 1);
    failed(cli(ws, ['bug', 'show', '--bug', 'projects/etchly/bug#999']), 'BUG_NOT_FOUND', 'bug show');
    failed(cli(ws, ['bug', 'show', '--bug', 'etchly#1']), 'INVALID_BUG_KEY', 'bug show');
    failed(cli(ws, ['bug', 'show']), 'MISSING_REQUIRED', 'bug show');
    failed(cli(ws, ['bug', 'list', '--limit', '0']), 'INVALID_VALUE', 'bug list');
    failed(cli(ws, ['bug', 'list', '--limit', '51']), 'INVALID_VALUE', 'bug list');
    for (const unknown of [['bug', 'comment', 'delete', '--bug', CRM_KEY], ['bug', 'sync'], ['bug', 'update', '--bug', CRM_KEY], ['bug', 'comment', 'edit']]) {
      const result = cli(ws, unknown);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).code, 'UNKNOWN_COMMAND');
    }
    const empty = join(ws.base, 'empty.txt');
    writeFileSync(empty, '  \n');
    failed(cli(ws, ['bug', 'comment', 'add', '--bug', CRM_KEY, '--text-file', empty]), 'COMMENT_TEXT_EMPTY', 'bug comment add');
    const binary = join(ws.base, 'binary.txt');
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
    failed(cli(ws, ['bug', 'comment', 'add', '--bug', CRM_KEY, '--text-file', binary]), 'COMMENT_TEXT_INVALID', 'bug comment add');
    failed(cli(ws, ['bug', 'comment', 'add', '--bug', CRM_KEY, '--text-file', join(ws.base, 'missing.txt')]), 'COMMENT_TEXT_UNREADABLE', 'bug comment add');
    assert.equal(ok(cli(ws, ['bug', 'list'])).bugs.find((bug: { key: string }) => bug.key === CRM_KEY).pendingOperations, 1);
    assert.deepEqual(fetches(ws), []);
    assertNoService(ws);
  });

  await t.test('attachment get without network fails explicitly without a fake local path', async () => {
    server.seedBug(ETCHLY, {
      rawId: '345', attachments: [{ id: 'att-2', bytes: ATTACHMENT.length, sha256: createHash('sha256').update(ATTACHMENT).digest('hex') }],
    });
    await serviceCycle(ws, server, inbox);
    const before = fetches(ws).length;
    const error = failed(cli(ws, ['bug', 'attachment', 'get', '--bug', 'projects/etchly/bug#345', '--attachment', 'att-2']), 'ATTACHMENT_FETCH_FAILED', 'bug attachment get');
    assert.ok(!JSON.stringify(error).includes(join(ws.rafHome, 'attachments', '')), 'no local path in the failure');
    assert.equal(fetches(ws).length, before + 1, 'exactly one explicit request for the bytes');
    const shown = ok(cli(ws, ['bug', 'show', '--bug', 'projects/etchly/bug#345']));
    assert.equal(shown.bug.attachments[0].cacheState, 'absent');
    const files = existsSync(join(ws.rafHome, 'attachments')) ? readdirSync(join(ws.rafHome, 'attachments'), { recursive: true }) : [];
    assert.deepEqual(files.filter(name => !String(name).startsWith('.')), []);
    failed(cli(ws, ['bug', 'attachment', 'get', '--bug', 'projects/etchly/bug#345', '--attachment', 'nope']), 'ATTACHMENT_NOT_FOUND', 'bug attachment get');
    assertNoService(ws);
  });
});
