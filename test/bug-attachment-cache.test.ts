import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AttachmentCacheError,
  applyAttachmentMetadata,
  loadAttachmentCacheSettings,
  type AttachmentAccess,
  type AttachmentCacheErrorCode,
  type AttachmentRef,
} from '../src/bug-attachment-cache.ts';
import {
  FakeDownloads,
  attachmentRow,
  bytesOf,
  createWorkspace,
  defaultRequestTimeoutMs,
  deferred,
  expectedDelays,
  filesUnder,
  indexProblems,
  isInside,
  openCache,
  readAtMs,
  readyRows,
  resolveCacheFile,
  sectionId,
  seedAttachment,
  seedBug,
  seedComment,
  sha256,
  testClock,
  testRetry,
  type CacheWorkspace,
} from './bug-attachment-cache-fixture.ts';

const realConfDir = fileURLToPath(new URL('../../conf/', import.meta.url));

function workspace(t: TestContext, maxBytes: number): CacheWorkspace {
  const created = createWorkspace(maxBytes);
  t.after(() => created.close());
  return created;
}

async function rejectsWith(promise: Promise<unknown>, code: AttachmentCacheErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AttachmentCacheError, `очікувалась AttachmentCacheError, отримано ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function notNotImplemented(error: unknown): boolean {
  return error instanceof Error && !/NotImplemented/.test(error.message);
}

function assertServed(ws: CacheWorkspace, access: AttachmentAccess, body: Uint8Array): void {
  assert.ok(isInside(ws.cacheDirectory, access.path), `шлях поза кешем: ${access.path}`);
  assert.ok(existsSync(access.path), 'виданий шлях не існує');
  assert.deepEqual(readFileSync(access.path), Buffer.from(body));
  assert.equal(access.bytes, body.length);
  assert.equal(access.sha256, sha256(body));
}

function assertConsistent(ws: CacheWorkspace): void {
  assert.deepEqual(indexProblems(ws), []);
}

function seedServed(ws: CacheWorkspace, downloads: FakeDownloads, bugPk: number, serverId: string, size: number, seed: number) {
  const body = bytesOf(size, seed);
  const ref = seedAttachment(ws.database, bugPk, serverId, body);
  downloads.serve(serverId, body);
  return { ref, body };
}

function cachedSum(ws: CacheWorkspace): number {
  return readyRows(ws.database).reduce((sum, row) => sum + (row.cache_bytes ?? 0), 0);
}

function isReady(ws: CacheWorkspace, ref: AttachmentRef): boolean {
  return attachmentRow(ws.database, ref)?.cache_state === 'ready';
}

test('бюджет і тека кешу читаються з conf/raf.json#/bugs', (t) => {
  const ws = workspace(t, 4242);
  const settings = loadAttachmentCacheSettings(ws.confDir, ws.rafHome);
  assert.equal(settings.maxBytes, 4242);
  assert.equal(settings.directory, join(ws.rafHome, 'attachments'));

  const real = JSON.parse(readFileSync(join(realConfDir, 'raf.json'), 'utf8')) as { bugs: { attachmentCacheMaxBytes: number; attachmentsDirectory: string } };
  const realSettings = loadAttachmentCacheSettings(realConfDir, ws.rafHome);
  assert.equal(realSettings.maxBytes, real.bugs.attachmentCacheMaxBytes);
  assert.equal(realSettings.directory, join(ws.rafHome, real.bugs.attachmentsDirectory));
});

test('некоректний бюджет або тека кешу в conf відхиляються явно', (t) => {
  const ws = workspace(t, 100);
  const write = (bugs: Record<string, unknown>) => writeFileSync(join(ws.confDir, 'raf.json'), JSON.stringify({ bugs }));
  const base = { fileName: 'bugs.sqlite', attachmentsDirectory: 'attachments', attachmentCacheMaxBytes: 100 };
  for (const maxBytes of [0, -1, 1.5, '100', null]) {
    write({ ...base, attachmentCacheMaxBytes: maxBytes });
    assert.throws(() => loadAttachmentCacheSettings(ws.confDir, ws.rafHome), notNotImplemented, `maxBytes=${String(maxBytes)}`);
  }
  const { attachmentCacheMaxBytes: _omitted, ...withoutBudget } = base;
  write(withoutBudget);
  assert.throws(() => loadAttachmentCacheSettings(ws.confDir, ws.rafHome), notNotImplemented);
  for (const directory of ['../outside', '/tmp/attachments', '', 'a/../../b']) {
    write({ ...base, attachmentsDirectory: directory });
    assert.throws(() => loadAttachmentCacheSettings(ws.confDir, ws.rafHome), notNotImplemented, `directory=${directory}`);
  }
});

test('no-prefetch: синхронізація метаданих жука й коментаря не завантажує байти', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const commentPk = seedComment(ws.database, bugPk, 'with-file');
  const bugFile = bytesOf(50, 1);
  const commentFile = bytesOf(60, 2);
  downloads.serve('a-bug', bugFile);
  downloads.serve('a-comment', commentFile);
  applyAttachmentMetadata(ws.database, { bugPk, commentPk: null, serverId: 'a-bug', kind: 'file', mime: 'image/png', bytes: bugFile.length, sha256: sha256(bugFile), presence: 'present' });
  applyAttachmentMetadata(ws.database, { bugPk, commentPk, serverId: 'a-comment', kind: 'file', mime: 'text/plain', bytes: commentFile.length, sha256: sha256(commentFile), presence: 'present' });

  const cache = openCache(ws, downloads, clock);
  await cache.reconcile();
  await cache.enforceBudget();

  assert.equal(downloads.calls.length, 0);
  assert.deepEqual(filesUnder(ws.cacheDirectory), []);
  for (const serverId of ['a-bug', 'a-comment']) {
    const row = attachmentRow(ws.database, { bugPk, serverId });
    assert.ok(row, `немає метаданих ${serverId}`);
    assert.equal(row.cache_state, 'absent');
    assert.equal(row.cache_file, null);
    assert.equal(row.last_read_at, null);
  }
  assert.equal(attachmentRow(ws.database, { bugPk, serverId: 'a-comment' })?.comment_pk, commentPk);
  assert.equal(cache.cachedBytes(), 0);
});

test('перший запит завантажує файл у кеш і фіксує lastReadAt', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 90, 3);
  const cache = openCache(ws, downloads, clock);

  const access = await cache.get(ref);

  assert.equal(downloads.calls.length, 1);
  const [call] = downloads.calls;
  assert.equal(call?.sectionId, sectionId);
  assert.deepEqual(call?.key, { project: 'raf', env: 'prod', source: 'dash', owner: 'owner', rawId: 'bug-1' });
  assert.equal(call?.bugPk, bugPk);
  assert.equal(call?.serverId, 'a1');
  assert.equal(call?.bytes, body.length);
  assert.equal(call?.sha256, sha256(body));
  assert.deepEqual(call?.auth, { origin: 'https://dash.invalid', project: 'raf', env: 'prod', token: `token:${sectionId}:read`, timeoutMs: defaultRequestTimeoutMs });
  assert.ok(call?.signal instanceof AbortSignal);
  assert.deepEqual(ws.claims.issued, [{ sectionId, scope: 'read' }]);
  assert.deepEqual(ws.sleeps, []);
  assert.equal(access.source, 'download');
  assert.equal(access.mime, 'application/octet-stream');
  assertServed(ws, access, body);
  const row = attachmentRow(ws.database, ref);
  assert.equal(row?.cache_state, 'ready');
  assert.equal(readAtMs(row?.last_read_at), clock.ms());
  assert.equal(cache.cachedBytes(), body.length);
  assertConsistent(ws);
});

test('повторний запит віддає валідний кеш без мережі й оновлює lastReadAt', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 90, 4);
  const cache = openCache(ws, downloads, clock);

  const first = await cache.get(ref);
  const firstRead = readAtMs(attachmentRow(ws.database, ref)?.last_read_at);
  clock.advance();
  const second = await cache.get(ref);

  assert.equal(downloads.callsFor('a1'), 1);
  assert.equal(second.source, 'cache');
  assert.equal(second.path, first.path);
  assertServed(ws, second, body);
  const secondRead = readAtMs(attachmentRow(ws.database, ref)?.last_read_at);
  assert.equal(secondRead, clock.ms());
  assert.ok(secondRead !== null && firstRead !== null && secondRead > firstRead);

  const restarted = openCache(ws, downloads, clock, ws.connect());
  clock.advance();
  const third = await restarted.get(ref);
  assert.equal(downloads.callsFor('a1'), 1);
  assert.equal(third.source, 'cache');
  assertServed(ws, third, body);
  assertConsistent(ws);
});

test('паралельні запити того самого вкладення в одному процесі завантажують його один раз', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 200, 5);
  const gate = deferred();
  const started = deferred();
  downloads.plan('a1', { body, gate: gate.promise, started: started.resolve });
  const cache = openCache(ws, downloads, clock);

  const pending = [cache.get(ref), cache.get(ref), cache.get(ref)];
  await started.promise;
  assert.equal(attachmentRow(ws.database, ref)?.cache_state, 'fetching');
  gate.resolve();
  const results = await Promise.all(pending);

  assert.equal(downloads.callsFor('a1'), 1);
  for (const access of results) {
    assert.equal(access.path, results[0]!.path);
    assertServed(ws, access, body);
  }
  assertConsistent(ws);
});

test('паралельні запити з двох процесів узгоджують заповнення й публікують лише завершений файл', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 300, 6);
  const gate = deferred();
  const started = deferred();
  downloads.plan('a1', { body, gate: gate.promise, started: started.resolve });
  downloads.plan('a1', { body, gate: gate.promise });
  const first = openCache(ws, downloads, clock);
  const second = openCache(ws, downloads, clock, ws.connect());

  const firstAccess = first.get(ref);
  await started.promise;
  const secondAccess = second.get(ref);
  gate.resolve();
  const results = await Promise.all([firstAccess, secondAccess]);

  assert.ok(downloads.callsFor('a1') >= 1 && downloads.callsFor('a1') <= 2);
  for (const access of results) assertServed(ws, access, body);
  assert.equal(readyRows(ws.database).length, 1);
  assert.equal(filesUnder(ws.cacheDirectory).length, 1);
  assertConsistent(ws);
});

test('коротша за метадані відповідь не стає кешем і не дає шляху', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 100, 7);
  downloads.serve('a1', body.subarray(0, 60));
  const cache = openCache(ws, downloads, clock);

  await rejectsWith(cache.get(ref), 'ATTACHMENT_INTEGRITY_FAILED');
  assert.equal(attachmentRow(ws.database, ref)?.cache_state, 'absent');
  assert.equal(attachmentRow(ws.database, ref)?.last_read_at, null);
  assert.deepEqual(filesUnder(ws.cacheDirectory), []);

  downloads.serve('a1', body);
  const retry = await cache.get(ref);
  assertServed(ws, retry, body);
  assertConsistent(ws);
});

test('довша за метадані відповідь відхиляється без залишків', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 100, 8);
  downloads.serve('a1', Buffer.concat([body, bytesOf(50, 9)]));
  const cache = openCache(ws, downloads, clock);

  await rejectsWith(cache.get(ref), 'ATTACHMENT_INTEGRITY_FAILED');
  assert.equal(attachmentRow(ws.database, ref)?.cache_state, 'absent');
  assert.deepEqual(filesUnder(ws.cacheDirectory), []);
  assertConsistent(ws);
});

test('відповідь із невідповідним sha256 відхиляється без залишків', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref } = seedServed(ws, downloads, bugPk, 'a1', 100, 10);
  downloads.serve('a1', bytesOf(100, 11));
  const cache = openCache(ws, downloads, clock);

  await rejectsWith(cache.get(ref), 'ATTACHMENT_INTEGRITY_FAILED');
  assert.equal(attachmentRow(ws.database, ref)?.cache_state, 'absent');
  assert.deepEqual(filesUnder(ws.cacheDirectory), []);
  assertConsistent(ws);
});

test('обрив потоку повторюється із затримкою з conf і не лишає часткового файла', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 100, 12);
  downloads.plan('a1', { body, failAfterBytes: 30 });
  const cache = openCache(ws, downloads, clock);

  const access = await cache.get(ref);

  assertServed(ws, access, body);
  assert.equal(downloads.callsFor('a1'), 2);
  assert.deepEqual(ws.sleeps, [testRetry.initialDelayMs]);
  assertConsistent(ws);
});

test('тимчасова помилка сервера повторюється, а більший Retry-After має пріоритет', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 100, 13);
  downloads.plan('a1', { status: 503 });
  downloads.plan('a1', { status: 503, retryAfterMs: 35 });
  const cache = openCache(ws, downloads, clock);

  const access = await cache.get(ref);

  assertServed(ws, access, body);
  assert.equal(downloads.callsFor('a1'), 3);
  assert.deepEqual(ws.sleeps, [testRetry.initialDelayMs, 35]);
  assertConsistent(ws);
});

test('стійка тимчасова помилка завершується явною помилкою з затримками за conf', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref } = seedServed(ws, downloads, bugPk, 'a1', 100, 14);
  downloads.failAlways('a1', 503);
  const cache = openCache(ws, downloads, clock);

  await rejectsWith(cache.get(ref), 'ATTACHMENT_FETCH_FAILED');

  assert.ok(ws.sleeps.length >= 1);
  assert.deepEqual(ws.sleeps, expectedDelays(ws.sleeps.length));
  assert.equal(downloads.callsFor('a1'), ws.sleeps.length + 1);
  const row = attachmentRow(ws.database, ref);
  assert.equal(row?.cache_state, 'absent');
  assert.equal(row?.last_read_at, null);
  assert.deepEqual(filesUnder(ws.cacheDirectory), []);
  assertConsistent(ws);
});

test('запит без відповіді переривається за requestTimeoutMs із conf і повторюється', async (t) => {
  const ws = workspace(t, 1000);
  ws.writeConf({ requestTimeoutMs: 50 });
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 100, 15);
  downloads.plan('a1', { hang: true });
  const cache = openCache(ws, downloads, clock);

  const access = await cache.get(ref);

  assertServed(ws, access, body);
  assert.equal(downloads.calls.length, 2);
  assert.equal(downloads.calls[0]?.signal.aborted, true);
  assert.equal(downloads.calls[0]?.auth.timeoutMs, 50);
  assert.deepEqual(ws.sleeps, [testRetry.initialDelayMs]);
  assertConsistent(ws);
});

test('розділ жука відсутній у conf: явна помилка без мережі й без шляху, також для кешу', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const cached = seedServed(ws, downloads, bugPk, 'cached', 50, 16);
  const fresh = seedServed(ws, downloads, bugPk, 'fresh', 50, 17);
  const cache = openCache(ws, downloads, clock);
  await cache.get(cached.ref);
  const readBefore = readAtMs(attachmentRow(ws.database, cached.ref)?.last_read_at);

  ws.writeConf({ sections: [{ project: 'other', env: 'prod', stand: 'prod', secret: 'DASH_BUGS_PROD_OTHER' }] });
  const withoutSection = openCache(ws, downloads, clock, ws.connect());
  clock.advance();
  await rejectsWith(withoutSection.get(fresh.ref), 'ATTACHMENT_SECTION_UNAVAILABLE');
  await rejectsWith(withoutSection.get(cached.ref), 'ATTACHMENT_SECTION_UNAVAILABLE');

  assert.equal(downloads.callsFor('fresh'), 0);
  assert.equal(downloads.callsFor('cached'), 1);
  assert.equal(readAtMs(attachmentRow(ws.database, cached.ref)?.last_read_at), readBefore);
  assert.equal(attachmentRow(ws.database, fresh.ref)?.cache_state, 'absent');
  assertConsistent(ws);
});

test('немає секрету розділу: явна помилка без мережі й без шляху, також для кешу', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const cached = seedServed(ws, downloads, bugPk, 'cached', 50, 18);
  const fresh = seedServed(ws, downloads, bugPk, 'fresh', 50, 19);
  const cache = openCache(ws, downloads, clock);
  await cache.get(cached.ref);
  const readBefore = readAtMs(attachmentRow(ws.database, cached.ref)?.last_read_at);

  ws.claims.removeSecret(sectionId);
  clock.advance();
  await rejectsWith(cache.get(fresh.ref), 'ATTACHMENT_SECTION_UNAVAILABLE');
  await rejectsWith(cache.get(cached.ref), 'ATTACHMENT_SECTION_UNAVAILABLE');

  assert.equal(downloads.callsFor('fresh'), 0);
  assert.equal(downloads.callsFor('cached'), 1);
  assert.equal(readAtMs(attachmentRow(ws.database, cached.ref)?.last_read_at), readBefore);
  assert.deepEqual(ws.sleeps, []);

  ws.claims.restoreSecret(sectionId);
  const restored = await cache.get(fresh.ref);
  assertServed(ws, restored, fresh.body);
  assertConsistent(ws);
});

test('нова версія вкладення (sha256/bytes) не віддає старий кеш', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body: oldBody } = seedServed(ws, downloads, bugPk, 'a1', 100, 13);
  const cache = openCache(ws, downloads, clock);
  await cache.get(ref);

  const newBody = bytesOf(120, 14);
  downloads.serve('a1', newBody);
  applyAttachmentMetadata(ws.database, { bugPk, commentPk: null, serverId: 'a1', kind: 'file', mime: 'application/octet-stream', bytes: newBody.length, sha256: sha256(newBody), presence: 'present' });
  clock.advance();
  const access = await cache.get(ref);

  assert.equal(downloads.callsFor('a1'), 2);
  assert.equal(downloads.calls.at(-1)?.sha256, sha256(newBody));
  assert.equal(access.source, 'download');
  assertServed(ws, access, newBody);
  for (const file of filesUnder(ws.cacheDirectory)) assert.notDeepEqual(readFileSync(file), oldBody);
  assertConsistent(ws);
});

test('синхронізація тієї самої версії зберігає кеш і не змінює lastReadAt', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 100, 15);
  const cache = openCache(ws, downloads, clock);
  await cache.get(ref);
  const before = attachmentRow(ws.database, ref);

  clock.advance();
  applyAttachmentMetadata(ws.database, { bugPk, commentPk: null, serverId: 'a1', kind: 'file', mime: 'image/png', bytes: body.length, sha256: sha256(body), presence: 'present' });

  const after = attachmentRow(ws.database, ref);
  assert.equal(after?.cache_state, 'ready');
  assert.equal(after?.cache_file, before?.cache_file);
  assert.equal(readAtMs(after?.last_read_at), readAtMs(before?.last_read_at));
  assert.equal(downloads.callsFor('a1'), 1);
  assertConsistent(ws);
});

test('пошкоджений або підмінений запис кешу не повертається як валідний', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref, body } = seedServed(ws, downloads, bugPk, 'a1', 100, 16);
  const cache = openCache(ws, downloads, clock);
  const first = await cache.get(ref);

  truncateSync(first.path, 40);
  clock.advance();
  const repaired = await cache.get(ref);
  assertServed(ws, repaired, body);
  assert.equal(downloads.callsFor('a1'), 2);

  const outside = join(ws.root, 'outside.bin');
  writeFileSync(outside, body);
  ws.database.prepare('UPDATE attachments SET cache_file = ? WHERE bug_pk = ? AND server_id = ?').run('../../../outside.bin', bugPk, 'a1');
  clock.advance();
  const guarded = await cache.get(ref);
  assert.notEqual(guarded.path, outside);
  assertServed(ws, guarded, body);
  assert.deepEqual(readFileSync(outside), body);
  assertConsistent(ws);
});

test('path traversal: серверні ідентифікатори не визначають шлях запису', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const hostile = ['../../escape.bin', '/etc/passwd', '..', 'a/../../b', '.\\..\\win'];
  const cache = openCache(ws, downloads, clock);
  const before = filesUnder(ws.root).filter((file) => !isInside(ws.cacheDirectory, file) && !file.startsWith(ws.databasePath));

  for (const [index, serverId] of hostile.entries()) {
    const body = bytesOf(30 + index, 20 + index);
    seedAttachment(ws.database, bugPk, serverId, body, { kind: '../kind', mime: '../../mime' });
    downloads.serve(serverId, body);
    const access = await cache.get({ bugPk, serverId });
    assertServed(ws, access, body);
  }

  const after = filesUnder(ws.root).filter((file) => !isInside(ws.cacheDirectory, file) && !file.startsWith(ws.databasePath));
  assert.deepEqual(after, before);
  assert.equal(existsSync(join(ws.cacheDirectory, '../../escape.bin')), false);
  assertConsistent(ws);
});

test('відмова доступу на завантаженні не створює кеш і не повертає шлях', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const cache = openCache(ws, downloads, clock);
  for (const [status, code] of [[401, 'ATTACHMENT_ACCESS_DENIED'], [403, 'ATTACHMENT_ACCESS_DENIED'], [404, 'ATTACHMENT_NOT_FOUND']] as const) {
    const { ref, body } = seedServed(ws, downloads, bugPk, `denied-${status}`, 50, status);
    downloads.plan(ref.serverId, { status });
    await rejectsWith(cache.get(ref), code);
    const row = attachmentRow(ws.database, ref);
    assert.equal(row?.cache_state, 'absent');
    assert.equal(row?.last_read_at, null);
    assert.equal(row?.sha256, sha256(body));
    assert.equal(row?.presence, 'present');
  }
  assert.deepEqual(ws.sleeps, []);
  assert.deepEqual(filesUnder(ws.cacheDirectory), []);
  assertConsistent(ws);
});

test('відкликане чи невідоме вкладення не віддається з кешу і не завантажується', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const { ref: deletedRef } = seedServed(ws, downloads, bugPk, 'gone', 50, 30);
  const { ref: removedRef } = seedServed(ws, downloads, bugPk, 'removed', 50, 31);
  const cache = openCache(ws, downloads, clock);
  await cache.get(deletedRef);
  await cache.get(removedRef);
  const callsBefore = downloads.calls.length;

  ws.database.prepare("UPDATE attachments SET presence = 'deleted' WHERE bug_pk = ? AND server_id = 'gone'").run(bugPk);
  await rejectsWith(cache.get(deletedRef), 'ATTACHMENT_NOT_FOUND');

  ws.database.prepare("DELETE FROM attachments WHERE bug_pk = ? AND server_id = 'removed'").run(bugPk);
  await rejectsWith(cache.get(removedRef), 'ATTACHMENT_NOT_FOUND');

  await rejectsWith(cache.get({ bugPk, serverId: 'never-synced' }), 'ATTACHMENT_NOT_FOUND');
  await rejectsWith(cache.get({ bugPk: bugPk + 1000, serverId: 'gone' }), 'ATTACHMENT_NOT_FOUND');
  assert.equal(downloads.calls.length, callsBefore);
});

test('поріг бюджету з conf: при досягненні ліміту кеш очищається нижче ліміту', async (t) => {
  const ws = workspace(t, 100);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const a = seedServed(ws, downloads, bugPk, 'a', 40, 40);
  const b = seedServed(ws, downloads, bugPk, 'b', 30, 41);
  const c = seedServed(ws, downloads, bugPk, 'c', 30, 42);
  const cache = openCache(ws, downloads, clock);

  await cache.get(a.ref);
  clock.advance();
  await cache.get(b.ref);
  assert.equal(cache.cachedBytes(), 70);
  clock.advance();
  const access = await cache.get(c.ref);

  assertServed(ws, access, c.body);
  assert.equal(isReady(ws, a.ref), false);
  assert.equal(isReady(ws, b.ref), true);
  assert.equal(isReady(ws, c.ref), true);
  assert.equal(cache.cachedBytes(), 60);
  assert.equal(cachedSum(ws), 60);
  assertConsistent(ws);
});

test('перевищення ліміту очищає найдавніші читання, доки розмір не стане нижче ліміту', async (t) => {
  const ws = workspace(t, 100);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const refs = [0, 1, 2].map((index) => seedServed(ws, downloads, bugPk, `f${index}`, 30, 50 + index));
  const big = seedServed(ws, downloads, bugPk, 'big', 60, 60);
  const cache = openCache(ws, downloads, clock);
  for (const entry of refs) {
    await cache.get(entry.ref);
    clock.advance();
  }
  assert.equal(cache.cachedBytes(), 90);

  await cache.get(big.ref);

  assert.equal(isReady(ws, refs[0]!.ref), false);
  assert.equal(isReady(ws, refs[1]!.ref), false);
  assert.equal(isReady(ws, refs[2]!.ref), true);
  assert.equal(isReady(ws, big.ref), true);
  assert.ok(cache.cachedBytes() < 100);
  assertConsistent(ws);
});

test('LRU за lastReadAt: cache hit оновлює порядок, час завантаження й atime не враховуються', async (t) => {
  const ws = workspace(t, 100);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const a = seedServed(ws, downloads, bugPk, 'a', 40, 70);
  const b = seedServed(ws, downloads, bugPk, 'b', 40, 71);
  const c = seedServed(ws, downloads, bugPk, 'c', 30, 72);
  const cache = openCache(ws, downloads, clock);

  await cache.get(a.ref);
  clock.advance();
  const bAccess = await cache.get(b.ref);
  clock.advance();
  const aHit = await cache.get(a.ref);
  assert.equal(aHit.source, 'cache');
  const future = new Date(clock.ms() + 86_400_000);
  utimesSync(bAccess.path, future, future);
  clock.advance();
  await cache.get(c.ref);

  assert.equal(isReady(ws, a.ref), true);
  assert.equal(isReady(ws, b.ref), false);
  assert.equal(isReady(ws, c.ref), true);
  assert.equal(downloads.callsFor('a'), 1);
  assertConsistent(ws);
});

test('синхронізація метаданих не є читанням і не рятує файл від очищення', async (t) => {
  const ws = workspace(t, 100);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const a = seedServed(ws, downloads, bugPk, 'a', 40, 80);
  const b = seedServed(ws, downloads, bugPk, 'b', 40, 81);
  const c = seedServed(ws, downloads, bugPk, 'c', 30, 82);
  const cache = openCache(ws, downloads, clock);

  await cache.get(a.ref);
  const aRead = readAtMs(attachmentRow(ws.database, a.ref)?.last_read_at);
  clock.advance();
  await cache.get(b.ref);
  clock.advance();
  applyAttachmentMetadata(ws.database, { bugPk, commentPk: null, serverId: 'a', kind: 'file', mime: 'image/png', bytes: a.body.length, sha256: sha256(a.body), presence: 'present' });
  assert.equal(readAtMs(attachmentRow(ws.database, a.ref)?.last_read_at), aRead);
  clock.advance();
  await cache.get(c.ref);

  assert.equal(isReady(ws, a.ref), false);
  assert.equal(isReady(ws, b.ref), true);
  assert.equal(downloads.calls.length, 3);
  assertConsistent(ws);
});

test('очищення видаляє лише байти: метадані, жуки й коментарі лишаються, повторний запит завантажує знову', async (t) => {
  const ws = workspace(t, 100);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const commentPk = seedComment(ws.database, bugPk, 'server-note');
  const a = seedServed(ws, downloads, bugPk, 'a', 60, 90);
  const b = seedServed(ws, downloads, bugPk, 'b', 60, 91);
  const cache = openCache(ws, downloads, clock);
  const aAccess = await cache.get(a.ref);
  clock.advance();
  await cache.get(b.ref);

  const evicted = attachmentRow(ws.database, a.ref);
  assert.equal(evicted?.cache_state, 'absent');
  assert.equal(evicted?.cache_file, null);
  assert.equal(evicted?.presence, 'present');
  assert.equal(evicted?.bytes, a.body.length);
  assert.equal(evicted?.sha256, sha256(a.body));
  assert.equal(existsSync(aAccess.path), false);
  assert.equal((ws.database.prepare('SELECT COUNT(*) AS n FROM bugs').get() as { n: number }).n, 1);
  assert.equal((ws.database.prepare('SELECT text FROM comments WHERE comment_pk = ?').get(commentPk) as { text: string }).text, 'server-note');

  clock.advance();
  const again = await cache.get(a.ref);
  assert.equal(again.source, 'download');
  assertServed(ws, again, a.body);
  assert.equal(downloads.callsFor('a'), 2);
  assertConsistent(ws);
});

test('зменшення бюджету в conf очищає кеш у порядку давності читання', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const entries = ['x', 'y', 'z'].map((serverId, index) => seedServed(ws, downloads, bugPk, serverId, 300, 100 + index));
  const cache = openCache(ws, downloads, clock);
  for (const entry of entries) {
    await cache.get(entry.ref);
    clock.advance();
  }
  assert.equal(cache.cachedBytes(), 900);

  ws.writeBudget(500);
  const reduced = openCache(ws, downloads, clock, ws.connect());
  const report = await reduced.enforceBudget();

  assert.deepEqual(report.evicted, [entries[0]!.ref, entries[1]!.ref]);
  assert.equal(report.cachedBytes, 300);
  assert.equal(reduced.cachedBytes(), 300);
  assert.equal(isReady(ws, entries[2]!.ref), true);
  assertConsistent(ws);
});

test('зменшений бюджет застосовується і при наступній видачі з кешу', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const entries = ['x', 'y', 'z'].map((serverId, index) => seedServed(ws, downloads, bugPk, serverId, 300, 110 + index));
  const cache = openCache(ws, downloads, clock);
  for (const entry of entries) {
    await cache.get(entry.ref);
    clock.advance();
  }

  ws.writeBudget(500);
  const reduced = openCache(ws, downloads, clock, ws.connect());
  const hit = await reduced.get(entries[0]!.ref);

  assertServed(ws, hit, entries[0]!.body);
  assert.equal(hit.source, 'cache');
  assert.ok(reduced.cachedBytes() < 500);
  assert.equal(isReady(ws, entries[0]!.ref), true);
  assert.equal(isReady(ws, entries[1]!.ref), false);
  assertConsistent(ws);
});

test('oversized: вкладення не менше всього бюджету відхиляється без завантаження й без очищення інших', async (t) => {
  const ws = workspace(t, 100);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const small = seedServed(ws, downloads, bugPk, 'small', 40, 120);
  const exact = seedServed(ws, downloads, bugPk, 'exact', 100, 121);
  const huge = seedServed(ws, downloads, bugPk, 'huge', 150, 122);
  const cache = openCache(ws, downloads, clock);
  const smallAccess = await cache.get(small.ref);

  for (const entry of [exact, huge]) {
    clock.advance();
    await rejectsWith(cache.get(entry.ref), 'ATTACHMENT_TOO_LARGE');
    assert.equal(downloads.callsFor(entry.ref.serverId), 0);
    assert.equal(attachmentRow(ws.database, entry.ref)?.cache_state, 'absent');
  }
  assert.equal(isReady(ws, small.ref), true);
  assertServed(ws, smallAccess, small.body);
  assert.equal(cache.cachedBytes(), 40);
  assertConsistent(ws);
});

test('читання під час незавершеного заповнення й очищення не повертає видалений файл і не лишає перевищення', async (t) => {
  const ws = workspace(t, 100);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const a = seedServed(ws, downloads, bugPk, 'a', 60, 130);
  const b = seedServed(ws, downloads, bugPk, 'b', 60, 131);
  const cache = openCache(ws, downloads, clock);
  await cache.get(a.ref);

  const gate = deferred();
  const started = deferred();
  downloads.plan('b', { body: b.body, gate: gate.promise, started: started.resolve });
  clock.advance();
  const bPending = cache.get(b.ref);
  await started.promise;

  await cache.enforceBudget();
  clock.advance();
  const aHit = await cache.get(a.ref).then((access) => ({ access, content: existsSync(access.path) ? readFileSync(access.path) : null }));
  assert.deepEqual(aHit.content, a.body);

  clock.advance();
  gate.resolve();
  const bAccess = await bPending.then((access) => ({ access, content: existsSync(access.path) ? readFileSync(access.path) : null }));
  assert.deepEqual(bAccess.content, b.body);

  await cache.enforceBudget();
  assert.ok(cache.cachedBytes() < 100);
  assert.equal(readyRows(ws.database).length, 1);
  assertConsistent(ws);
});

test('конкурентні видача й очищення з різних процесів не повертають видалений чи неповний файл', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const entries = ['p', 'q', 'r', 's'].map((serverId, index) => seedServed(ws, downloads, bugPk, serverId, 200, 140 + index));
  const reader = openCache(ws, downloads, clock);
  for (const entry of entries) {
    await reader.get(entry.ref);
    clock.advance();
  }

  ws.writeBudget(250);
  const evictor = openCache(ws, downloads, clock, ws.connect());
  const observed = entries.map((entry) => reader.get(entry.ref).then((access) => ({ entry, access, content: existsSync(access.path) ? readFileSync(access.path) : null })));
  const [, ...reads] = await Promise.all([evictor.enforceBudget(), ...observed]);

  for (const read of reads) assert.deepEqual(read.content, read.entry.body);
  await evictor.enforceBudget();
  assert.ok(evictor.cachedBytes() < 250);
  assertConsistent(ws);
});

test('перезапуск після часткового очищення: файл видалено, а індекс ще ready', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const a = seedServed(ws, downloads, bugPk, 'a', 100, 150);
  const b = seedServed(ws, downloads, bugPk, 'b', 100, 151);
  const cache = openCache(ws, downloads, clock);
  const aAccess = await cache.get(a.ref);
  await cache.get(b.ref);

  const lostFile = resolveCacheFile(ws, attachmentRow(ws.database, a.ref)!.cache_file!);
  assert.equal(lostFile, aAccess.path);
  rmSync(lostFile);

  const restarted = openCache(ws, downloads, clock, ws.connect());
  const report = await restarted.reconcile();
  assert.deepEqual(report.missingFiles, [a.ref]);
  assert.equal(report.cachedBytes, 100);
  assert.equal(restarted.cachedBytes(), 100);
  assert.equal(attachmentRow(ws.database, a.ref)?.cache_state, 'absent');
  assertConsistent(ws);

  clock.advance();
  const again = await restarted.get(a.ref);
  assert.equal(again.source, 'download');
  assertServed(ws, again, a.body);
  assertConsistent(ws);
});

test('перезапуск після часткового очищення: індекс оновлено, а файл лишився', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const a = seedServed(ws, downloads, bugPk, 'a', 100, 160);
  const cache = openCache(ws, downloads, clock);
  const aAccess = await cache.get(a.ref);

  ws.database.prepare("UPDATE attachments SET cache_state = 'absent', cache_file = NULL, cache_bytes = NULL, cache_sha256 = NULL WHERE bug_pk = ? AND server_id = 'a'").run(bugPk);
  assert.ok(existsSync(aAccess.path));

  const restarted = openCache(ws, downloads, clock, ws.connect());
  const report = await restarted.reconcile();
  assert.equal(report.removedOrphans, 1);
  assert.equal(report.cachedBytes, 0);
  assert.equal(existsSync(aAccess.path), false);
  assertConsistent(ws);
});

test('без явної звірки перезапущений процес не видає шлях до зниклого файла', async (t) => {
  const ws = workspace(t, 1000);
  const downloads = new FakeDownloads();
  const clock = testClock();
  const bugPk = seedBug(ws.database);
  const a = seedServed(ws, downloads, bugPk, 'a', 100, 170);
  const cache = openCache(ws, downloads, clock);
  const aAccess = await cache.get(a.ref);
  rmSync(aAccess.path);

  const restarted = openCache(ws, downloads, clock, ws.connect());
  clock.advance();
  const again = await restarted.get(a.ref);
  assertServed(ws, again, a.body);
  assert.equal(again.source, 'download');
  assert.equal(downloads.callsFor('a'), 2);
  assertConsistent(ws);
});
