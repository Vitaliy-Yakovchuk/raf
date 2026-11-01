import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { execute, type ExecutionResult } from '../src/cli.ts';
import { createBugHandlers, bugCommands, type BugCommandPorts } from '../src/bug-cli.ts';
import { createAttachmentCache, loadAttachmentCacheSettings } from '../src/bug-attachment-cache.ts';
import { BugStoreError, type BugListFilter, type BugRepository, type BugView } from '../src/bug-store.ts';
import { BugSyncConfigError, BugWriteError, type BugWriter, type CommentWriteInput, type StatusWriteInput } from '../src/bug-sync.ts';
import { FakeDownloads, bytesOf, createWorkspace, seedAttachment, seedBug, sectionId, sha256, testClock, type CacheWorkspace } from './bug-attachment-cache-fixture.ts';

const confRoot = new URL('../../conf/', import.meta.url);
const constants = JSON.parse(readFileSync(new URL('raf-constants.json', confRoot), 'utf8'));
const models = JSON.parse(readFileSync(new URL('models.json', confRoot), 'utf8'));
const projects = JSON.parse(readFileSync(new URL('projects.json', confRoot), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects);
const NOW = new Date(Date.UTC(2026, 9, 22, 9, 0, 0));
const KEY = 'projects/raf/bug#bug-1';
const APPROVED = ['bug list', 'bug show', 'bug comment add', 'bug status set', 'bug attachment get'];

function success(result: ExecutionResult): any {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function failure(result: ExecutionResult, code: string): any {
  assert.equal(result.exitCode, 1, result.stdout);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, code, result.stderr);
  assert.ok(Array.isArray(error.remediation) && error.remediation.length >= 2, result.stderr);
  assert.ok(error.remediation.some((step: string) => step.startsWith('raf help bug')), result.stderr);
  assert.equal(typeof error.details.reason, 'string');
  return error;
}

interface Harness {
  readonly ws: CacheWorkspace;
  readonly downloads: FakeDownloads;
  readonly comments: CommentWriteInput[];
  readonly statuses: StatusWriteInput[];
  readonly filters: BugListFilter[];
  writeError: Error | null;
  readonly texts: Map<string, Uint8Array>;
  closed: number;
  run(argv: readonly string[]): Promise<ExecutionResult>;
}

function bugView(): BugView {
  return {
    key: KEY, serverKey: { project: 'raf', env: 'prod', source: 'dash', owner: 'owner', rawId: 'bug-1' }, sectionId,
    problemId: 'problem-bug-1', revision: 7, status: 'open', state: 'new', claimedBy: null, presence: 'present', presenceAt: null,
    detailComplete: true, detailErrorCode: null, payload: {}, syncedAt: NOW.toISOString(), comments: [], attachments: [],
  } as unknown as BugView;
}

const SERVER_COMMENT = { commentPk: 5, serverId: 'srv-c-42', authorId: 'raf:bugs', authorKind: 'agent', text: 'Перевірено на dev1.\n', replyTo: null, createdAt: NOW.toISOString() };

function harness(t: TestContext, maxBytes = 1000): Harness {
  const ws = createWorkspace(maxBytes);
  t.after(() => ws.close());
  const downloads = new FakeDownloads();
  const clock = testClock(NOW.getTime());
  seedBug(ws.database);
  const h: Harness = {
    ws, downloads, comments: [], statuses: [], filters: [], texts: new Map(), closed: 0, writeError: null,
    run: argv => execute(argv, catalog, createBugHandlers(ports)),
  };
  const repository = {
    path: ws.databasePath,
    database: ws.database,
    sections: () => [{ sectionId, project: 'raf', env: 'prod', stand: 'prod', canonicalProject: 'projects/raf', origin: 'https://dash.invalid', actor: 'raf:bugs', claimsFingerprint: 'claims-1' }],
    findBug(key: string) {
      if (key === 'projects/raf/bug#broken') throw new BugStoreError('invalid-bug-key', `Некоректний ключ ${key}.`);
      if (key !== KEY) throw new BugStoreError('bug-not-found', `Жука ${key} немає в локальній базі.`, { key });
      return bugView();
    },
    listBugs(filter: BugListFilter) {
      h.filters.push(filter);
      return { bugs: [{ key: KEY, sectionId, revision: 7, status: 'open', presence: 'present' }], nextCursor: null, sync: [] };
    },
    close() { h.closed += 1; },
  } as unknown as BugRepository;
  const writer: BugWriter = {
    async addComment(input) {
      repository.findBug(input.bugKey);
      h.comments.push(input);
      if (h.writeError) throw h.writeError;
      const bug = { ...bugView(), revision: 8, comments: [SERVER_COMMENT] } as unknown as BugView;
      return { bugKey: input.bugKey, operationId: 'op-1', commentId: SERVER_COMMENT.serverId, revision: 8, comment: SERVER_COMMENT as unknown as BugView['comments'][number], bug };
    },
    async setStatus(input) {
      repository.findBug(input.bugKey);
      h.statuses.push(input);
      if (h.writeError) throw h.writeError;
      const bug = { ...bugView(), revision: 8, status: input.status } as unknown as BugView;
      return { bugKey: input.bugKey, operationId: 'op-2', revision: 8, status: input.status, bug };
    },
  };
  const ports: BugCommandPorts = {
    loadConfig: () => ({ ...ws.config(), pageLimit: 20 }),
    openRepository: () => repository,
    claims: async () => ws.claims,
    openCache: (repo, config, claims) => createAttachmentCache({
      database: repo.database, settings: loadAttachmentCacheSettings(ws.confDir, ws.rafHome), config, claims,
      download: downloads.download, now: clock.now, sleep: async ms => { ws.sleeps.push(ms); },
    }),
    writer: () => writer,
    readText: async file => {
      const bytes = h.texts.get(file);
      if (!bytes) throw new Error(`ENOENT: ${file}`);
      return bytes;
    },
    now: () => NOW,
  };
  return h;
}

test('the five approved bug commands are compiled from the JSON catalog with handlers', () => {
  assert.deepEqual([...bugCommands], APPROVED);
  assert.deepEqual(catalog.commands.filter(command => command.path[0] === 'bug').map(command => command.handlerName), APPROVED);
  for (const command of catalog.commands.filter(command => command.path[0] === 'bug')) {
    assert.equal(command.metadata.requiresService, undefined, command.handlerName);
    for (const field of ['description', 'output', 'errors', 'prerequisites', 'sideEffects']) assert.equal(typeof command.metadata[field], 'string', `${command.handlerName} ${field}`);
  }
  assert.deepEqual(Object.keys(createBugHandlers({} as BugCommandPorts)).sort(), [...bugCommands].sort());
});

test('help for bug commands comes from the catalog with parameters, output and errors', async t => {
  const h = harness(t);
  const help = success(await h.run(['help', 'bug']));
  assert.deepEqual(help.commands.map((command: { path: string[] }) => command.path.join(' ')), APPROVED);
  const add = success(await h.run(['bug', 'comment', 'add', '--help'])).commands[0];
  assert.deepEqual(add.parameters.map((parameter: { option: string; requirement: string }) => [parameter.option, parameter.requirement]), [['--bug', 'required'], ['--text-file', 'required']]);
  assert.match(add.metadata.output, /серверним comment_id/);
  assert.match(add.metadata.output, /код 0 лише після відповіді сервера/);
  assert.match(add.metadata.errors, /BUG_WRITE_UNKNOWN/);
  assert.match(add.metadata.sideEffects, /comment_problem/);
  assert.match(add.metadata.prerequisites, /служба raf не потрібна/);
  const status = success(await h.run(['bug', 'status', 'set', '--help'])).commands[0];
  assert.deepEqual(status.parameters.map((parameter: { option: string; requirement: string }) => [parameter.option, parameter.requirement]), [['--bug', 'required'], ['--status', 'required'], ['--text-file', 'optional']]);
  assert.match(status.metadata.sideEffects, /set_problem_status/);
  assert.match(status.metadata.prerequisites, /служба raf не потрібна/);
  for (const command of [add, status]) assert.doesNotMatch(JSON.stringify(command.metadata), /pending|outbox|асинхронно/);
  assert.equal(h.closed, 0);
});

test('bug list reads the local store with filters and a page limit bounded by conf', async t => {
  const h = harness(t);
  const page = success(await h.run(['bug', 'list', '--project', 'projects/raf', '--status', 'open', '--cursor', 'c1', '--limit', '5']));
  assert.equal(page.source, 'local');
  assert.deepEqual(page.bugs.map((bug: { key: string }) => bug.key), [KEY]);
  assert.deepEqual(h.filters, [{ canonicalProject: 'projects/raf', status: 'open', cursor: 'c1', limit: 5 }]);
  success(await h.run(['bug', 'list']));
  assert.deepEqual(h.filters[1], { cursor: null, limit: 20 });
  for (const limit of ['21', '0', '-1', '2.5', 'many']) {
    const error = failure(await h.run(['bug', 'list', '--limit', limit]), 'INVALID_VALUE');
    assert.equal(error.details.received, limit);
    assert.equal(error.details.expected, '1..20');
    assert.equal(error.details.command, 'bug list');
  }
  assert.equal(h.filters.length, 2);
  assert.equal(h.closed, 7);
});

test('bug show returns the local bug and maps store errors to explicit codes', async t => {
  const h = harness(t);
  const shown = success(await h.run(['bug', 'show', '--bug', KEY]));
  assert.equal(shown.source, 'local');
  assert.equal(shown.bug.key, KEY);
  const missing = failure(await h.run(['bug', 'show', '--bug', 'projects/raf/bug#404']), 'BUG_NOT_FOUND');
  assert.equal(missing.details.sourceCode, 'bug-not-found');
  assert.equal(missing.details.source, 'bug-store');
  assert.deepEqual(missing.details.found, { key: 'projects/raf/bug#404' });
  assert.match(missing.remediation[0], /raf bug list/);
  failure(await h.run(['bug', 'show', '--bug', 'projects/raf/bug#broken']), 'INVALID_BUG_KEY');
  failure(await h.run(['bug', 'show']), 'MISSING_REQUIRED');
  assert.equal(h.closed, 3);
});

test('bug comment add writes through the MCP writer and returns the server comment only after success', async t => {
  const h = harness(t);
  h.texts.set('/tmp/comment.txt', Buffer.from('Перевірено на dev1.\n'));
  h.texts.set('-', Buffer.from('Текст зі stdin'));
  const written = success(await h.run(['bug', 'comment', 'add', '--bug', KEY, '--text-file', '/tmp/comment.txt']));
  assert.equal(written.bugKey, KEY);
  assert.equal(written.commentId, 'srv-c-42');
  assert.equal(written.revision, 8);
  assert.equal(written.operationId, 'op-1');
  assert.equal(written.comment.serverId, 'srv-c-42');
  assert.equal(written.bug.revision, 8);
  for (const field of ['accepted', 'delivered', 'delivery', 'state', 'notice']) assert.equal(written[field], undefined, field);
  assert.deepEqual(h.comments[0], { bugKey: KEY, text: 'Перевірено на dev1.\n' });
  success(await h.run(['bug', 'comment', 'add', '--bug', KEY, '--text-file', '-']));
  assert.deepEqual(h.comments[1], { bugKey: KEY, text: 'Текст зі stdin' });
  assert.equal(h.closed, 2);
});

const writeFailures: readonly [string, () => Error, string, string | null][] = [
  ['stale revision', () => new BugWriteError('BUG_WRITE_REJECTED', 'Сервер відхилив застарілу ревізію.', { serverCode: 'revision-conflict', status: 409 }), 'BUG_WRITE_REJECTED', 'revision-conflict'],
  ['lease', () => new BugWriteError('BUG_WRITE_REJECTED', 'Потрібна оренда.', { serverCode: 'lease-required', status: 409 }), 'BUG_WRITE_REJECTED', 'lease-required'],
  ['access', () => new BugWriteError('BUG_WRITE_REJECTED', 'Доступ заборонено.', { serverCode: 'access-denied', status: 403 }), 'BUG_WRITE_REJECTED', 'access-denied'],
  ['unknown result', () => new BugWriteError('BUG_WRITE_UNKNOWN', 'Результат запису невідомий.', { serverCode: 'timeout', status: null }), 'BUG_WRITE_UNKNOWN', 'timeout'],
  ['invalid answer', () => new BugWriteError('BUG_WRITE_INVALID_RESPONSE', 'Невалідна відповідь MCP.'), 'BUG_WRITE_INVALID_RESPONSE', null],
  ['no claim owner comment', () => new BugWriteError('BUG_WRITE_REPLY_TARGET_MISSING', 'Немає коментаря власника claim.'), 'BUG_WRITE_REPLY_TARGET_MISSING', null],
  ['bug missing locally', () => new BugStoreError('bug-not-found', `Жука ${KEY} немає в локальній базі.`, { key: KEY }), 'BUG_NOT_FOUND', 'bug-not-found'],
];

for (const [name, error, code, sourceCode] of writeFailures) {
  test(`bug comment add and bug status set report a ${name} failure as ${code} without a success payload`, async t => {
    const h = harness(t);
    h.texts.set('ok.txt', Buffer.from('ok'));
    h.writeError = error();
    const comment = failure(await h.run(['bug', 'comment', 'add', '--bug', KEY, '--text-file', 'ok.txt']), code);
    const status = failure(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'closed']), code);
    for (const reported of [comment, status]) {
      if (sourceCode !== null) assert.equal(reported.details.sourceCode, sourceCode);
      assert.doesNotMatch(JSON.stringify(reported), /token/i);
    }
    assert.equal(h.comments.length, 1);
    assert.equal(h.statuses.length, 1);
    assert.equal(h.closed, 2);
  });
}

test('bug status set passes the status to the writer without its own status list', async t => {
  const h = harness(t);
  const closed = success(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'closed']));
  assert.equal(closed.bugKey, KEY);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.revision, 8);
  assert.equal(closed.bug.status, 'closed');
  success(await h.run(['bug', 'status', 'set', '--bug', KEY, '--status', 'some_future_status']));
  assert.deepEqual(h.statuses, [{ bugKey: KEY, status: 'closed' }, { bugKey: KEY, status: 'some_future_status' }]);
  failure(await h.run(['bug', 'status', 'set', '--bug', KEY]), 'MISSING_REQUIRED');
  failure(await h.run(['bug', 'status', 'set', '--status', 'closed']), 'MISSING_REQUIRED');
  assert.equal(h.statuses.length, 2);
});

test('bug comment add rejects unreadable, empty or non UTF-8 text before touching the store', async t => {
  const h = harness(t);
  h.texts.set('empty.txt', Buffer.from(' \n\t'));
  h.texts.set('latin1.txt', Buffer.from([0xc3, 0x28, 0x41]));
  const unreadable = failure(await h.run(['bug', 'comment', 'add', '--bug', KEY, '--text-file', 'absent.txt']), 'COMMENT_TEXT_UNREADABLE');
  assert.equal(unreadable.details.received, 'absent.txt');
  failure(await h.run(['bug', 'comment', 'add', '--bug', KEY, '--text-file', 'empty.txt']), 'COMMENT_TEXT_EMPTY');
  failure(await h.run(['bug', 'comment', 'add', '--bug', KEY, '--text-file', 'latin1.txt']), 'COMMENT_TEXT_INVALID');
  h.texts.set('ok.txt', Buffer.from('ok'));
  failure(await h.run(['bug', 'comment', 'add', '--bug', 'projects/raf/bug#404', '--text-file', 'ok.txt']), 'BUG_NOT_FOUND');
  failure(await h.run(['bug', 'status', 'set', '--bug', 'projects/raf/bug#404', '--status', 'closed']), 'BUG_NOT_FOUND');
  assert.deepEqual(h.comments, []);
  assert.deepEqual(h.statuses, []);
  assert.equal(h.closed, 5);
});

test('bug attachment get downloads on first request and serves the cache afterwards', async t => {
  const h = harness(t);
  const body = bytesOf(64, 9);
  seedAttachment(h.ws.database, 1, 'att-1', body, { mime: 'image/png' });
  h.downloads.serve('att-1', body);
  const first = success(await h.run(['bug', 'attachment', 'get', '--bug', KEY, '--attachment', 'att-1']));
  assert.equal(first.source, 'download');
  assert.equal(first.bug, KEY);
  assert.equal(first.attachment, 'att-1');
  assert.equal(first.mime, 'image/png');
  assert.equal(first.sha256, sha256(body));
  assert.deepEqual(readFileSync(first.path), body);
  assert.ok(first.path.startsWith(h.ws.cacheDirectory));
  const again = success(await h.run(['bug', 'attachment', 'get', '--bug', KEY, '--attachment', 'att-1']));
  assert.equal(again.source, 'cache');
  assert.equal(again.path, first.path);
  assert.equal(h.downloads.callsFor('att-1'), 1);
  assert.equal(h.closed, 2);
});

test('bug attachment get reports cache failures without a path', async t => {
  const h = harness(t, 100);
  const missing = failure(await h.run(['bug', 'attachment', 'get', '--bug', KEY, '--attachment', 'nope']), 'ATTACHMENT_NOT_FOUND');
  assert.equal(missing.details.path, undefined);
  seedAttachment(h.ws.database, 1, 'big', bytesOf(100, 1));
  const large = failure(await h.run(['bug', 'attachment', 'get', '--bug', KEY, '--attachment', 'big']), 'ATTACHMENT_TOO_LARGE');
  assert.match(large.remediation[0], /attachmentCacheMaxBytes/);
  seedAttachment(h.ws.database, 1, 'denied', bytesOf(10, 2));
  h.downloads.failAlways('denied', 403);
  const denied = failure(await h.run(['bug', 'attachment', 'get', '--bug', KEY, '--attachment', 'denied']), 'ATTACHMENT_ACCESS_DENIED');
  assert.doesNotMatch(JSON.stringify(denied), /token:/);
  assert.equal(h.downloads.calls.length, 1);
  failure(await h.run(['bug', 'attachment', 'get', '--bug', 'projects/raf/bug#404', '--attachment', 'nope']), 'BUG_NOT_FOUND');
});

test('configuration and unexpected failures stay explicit and close the store', async t => {
  const h = harness(t);
  const broken = createBugHandlers({
    loadConfig: () => { throw new BugSyncConfigError('pageLimit', 'conf/raf.json#/bugs/pageLimit має бути додатним цілим.'); },
    openRepository: () => { throw new Error('unreachable'); },
    claims: async () => h.ws.claims, openCache: () => { throw new Error('unreachable'); }, writer: () => { throw new Error('unreachable'); }, readText: async () => new Uint8Array(), now: () => NOW,
  });
  const config = failure(await execute(['bug', 'list'], catalog, broken), 'BUG_CONFIG_INVALID');
  assert.equal(config.details.sourceCode, 'pageLimit');
  assert.equal(config.details.retrySafe, false);
  let closed = 0;
  const failing = createBugHandlers({
    loadConfig: () => h.ws.config(),
    openRepository: () => ({ listBugs: () => { throw new Error('disk I/O error'); }, close: () => { closed += 1; } }) as unknown as BugRepository,
    claims: async () => h.ws.claims, openCache: () => { throw new Error('unreachable'); }, writer: () => { throw new Error('unreachable'); }, readText: async () => new Uint8Array(), now: () => NOW,
  });
  const unexpected = failure(await execute(['bug', 'list'], catalog, failing), 'BUG_COMMAND_FAILED');
  assert.match(unexpected.message, /disk I\/O error/);
  assert.equal(unexpected.details.retrySafe, null);
  assert.equal(closed, 1);
});

test('production bug commands are dispatched without the raf service', () => {
  const source = readFileSync(new URL('../src/production-entry.ts', import.meta.url), 'utf8');
  const branch = source.slice(source.indexOf("if (name.startsWith('bug '))"), source.indexOf("if (name === 'resource wait')"));
  assert.match(branch, /createBugHandlers/);
  assert.doesNotMatch(branch, /openProductionRuntime|createServiceHandlers|service/);
  const cli = readFileSync(new URL('../src/bug-cli.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/bug-production.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(cli, /service-entry|production-service|background-runtime|openStateStore/);
});
