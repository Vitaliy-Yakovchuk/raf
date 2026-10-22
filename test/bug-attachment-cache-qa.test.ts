import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openBugStore, type ServerAttachment, type ServerBugDetail } from '../src/bug-store.ts';
import { createClaimsIssuer, describeBugSection, loadBugSyncConfig } from '../src/bug-sync.ts';
import { openSecretsStore } from '../src/secrets-store.ts';

const driver = fileURLToPath(new URL('./bug-attachment-cache-qa-driver.ts', import.meta.url));
const realConf = fileURLToPath(new URL('../../conf/raf.json', import.meta.url));
const SECRET_NAME = 'DASH_BUGS_PROD_QA';
const SECRET = 'qa-secret-0123456789abcdef0123456789abcdef';
const BUDGET = 100;
const SIZE = 30;
const KEY1 = 'projects/qa/bug#qa-1';
const KEY2 = 'projects/qa/bug#qa-2';
const AT = '2026-10-22T08:00:00.000Z';

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function body(seed: number, size = SIZE): Buffer {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 13 + seed * 29 + 7) % 256;
  return buffer;
}

interface Plan {
  readonly delayMs?: number;
  readonly stallAfter?: number;
}

class AttachmentServer {
  readonly bodies = new Map<string, Buffer>();
  readonly requests = new Map<string, number>();
  readonly rejected: string[] = [];
  private readonly plans = new Map<string, Plan[]>();
  private readonly stalled: ServerResponse[] = [];
  private readonly key: Buffer;
  server!: Server;
  origin = '';

  constructor(secret: string) {
    this.key = createHash('sha256').update(`dashboard-bugs:${secret}`).digest();
  }

  plan(id: string, plan: Plan): void {
    this.plans.set(id, [...(this.plans.get(id) ?? []), plan]);
  }

  count(id: string): number {
    return this.requests.get(id) ?? 0;
  }

  private authorized(header: string | undefined, project: string | null, env: string | null): boolean {
    const match = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(header ?? '');
    if (!match) return false;
    const expected = createHmac('sha256', this.key).update(`${match[1]}.${match[2]}`).digest('base64url');
    if (expected !== match[3]) return false;
    const claims = JSON.parse(Buffer.from(match[2]!, 'base64url').toString('utf8'));
    return claims.project === project && claims.env === env && claims.scope === 'read' && claims.exp * 1000 > Date.now();
  }

  async start(key: string, cert: string): Promise<void> {
    this.server = createServer({ key, cert }, (request, response) => {
      const url = new URL(request.url ?? '/', 'https://localhost');
      const match = /^\/api\/bugs\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
      if (request.method !== 'GET' || !match) {
        response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not-found"}');
        return;
      }
      const id = decodeURIComponent(match[2]!);
      if (!this.authorized(request.headers.authorization, url.searchParams.get('project'), url.searchParams.get('env'))) {
        this.rejected.push(id);
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      this.requests.set(id, this.count(id) + 1);
      const bytes = this.bodies.get(id);
      if (!bytes) {
        response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"attachment-not-found"}');
        return;
      }
      const plan = this.plans.get(id)?.shift() ?? {};
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
      if (plan.stallAfter !== undefined) {
        response.write(bytes.subarray(0, plan.stallAfter));
        this.stalled.push(response);
        return;
      }
      if (plan.delayMs) setTimeout(() => response.end(bytes), plan.delayMs);
      else response.end(bytes);
    });
    await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
    this.origin = `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const response of this.stalled) response.destroy();
    this.server.closeAllConnections();
    await new Promise<void>(done => this.server.close(() => done()));
  }
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: any;
}

interface Running {
  readonly child: ChildProcess;
  readonly done: Promise<CliResult>;
}

interface AttachmentRow {
  readonly attachment_pk: number;
  readonly bug_pk: number;
  readonly comment_pk: number | null;
  readonly server_id: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly presence: string;
  readonly cache_state: string;
  readonly cache_file: string | null;
  readonly cache_bytes: number | null;
  readonly cache_sha256: string | null;
  readonly last_read_at: string | null;
  readonly fetch_owner: string | null;
}

const workspace = mkdtempSync(join(tmpdir(), 'raf-qa33-'));
const root = join(workspace, 'orchestrator');
const home = join(workspace, 'home');
const rafHome = join(home, '.raf');
const cacheDirectory = join(rafHome, 'attachments');
const databasePath = join(rafHome, 'bugs.sqlite');
const certPath = join(workspace, 'cert.pem');
const server = new AttachmentServer(SECRET);
const running = new Set<ChildProcess>();
const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'].map(letter => `att-${letter}`);
let conf: any;
let baseline: string;

function writeConf(maxBytes: number): void {
  conf.bugs.attachmentCacheMaxBytes = maxBytes;
  writeFileSync(join(root, 'conf', 'raf.json'), JSON.stringify(conf, null, 2));
}

function start(args: readonly string[]): Running {
  const child = spawn(process.execPath, [driver, root, home, ...args], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const done = new Promise<CliResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      running.delete(child);
      let json: any = null;
      const text = (code === 0 ? stdout : stderr).trim();
      try { json = JSON.parse(text); } catch { }
      resolve({ code, stdout, stderr, json });
    });
  });
  return { child, done };
}

function raf(args: readonly string[]): Promise<CliResult> {
  return start(args).done;
}

function get(key: string, id: string): Promise<CliResult> {
  return raf(['bug', 'attachment', 'get', '--bug', key, '--attachment', id]);
}

function ok(result: CliResult): any {
  assert.equal(result.code, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.ok(result.json, result.stdout);
  return result.json;
}

function read<T>(action: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return action(database); }
  finally { database.close(); }
}

function rows(): AttachmentRow[] {
  return read(database => database.prepare('SELECT * FROM attachments ORDER BY server_id').all() as unknown as AttachmentRow[]);
}

function row(id: string): AttachmentRow {
  const found = rows().find(item => item.server_id === id);
  assert.ok(found, `немає рядка ${id}`);
  return found;
}

function ready(): string[] {
  return rows().filter(item => item.cache_state === 'ready').map(item => item.server_id).sort();
}

function cachedBytes(): number {
  return rows().filter(item => item.cache_state === 'ready').reduce((sum, item) => sum + Number(item.cache_bytes), 0);
}

function cacheFiles(): string[] {
  return existsSync(cacheDirectory) ? readdirSync(cacheDirectory).sort() : [];
}

function indexProblems(budget: number): string[] {
  const problems: string[] = [];
  const referenced = new Set<string>();
  for (const item of rows()) {
    if (item.cache_state === 'fetching') problems.push(`${item.server_id}: fetching без живого процесу`);
    if (item.cache_state === 'absent' && item.cache_file !== null)problems.push(`${item.server_id}: absent із cache_file`);
    if (item.cache_state !== 'ready') continue;
    const path = join(cacheDirectory, String(item.cache_file));
    referenced.add(String(item.cache_file));
    if (!existsSync(path)) { problems.push(`${item.server_id}: ready без файла`); continue; }
    if (statSync(path).size !== item.bytes) problems.push(`${item.server_id}: розмір файла`);
    if (sha(readFileSync(path)) !== item.sha256) problems.push(`${item.server_id}: sha256 файла`);
    if (item.cache_bytes !== item.bytes || item.cache_sha256 !== item.sha256) problems.push(`${item.server_id}: індекс cache_*`);
  }
  for (const file of cacheFiles()) if (!referenced.has(file)) problems.push(`${file}: файл без ready-запису`);
  if (cachedBytes() >= budget) problems.push(`кеш ${cachedBytes()} байтів не нижче бюджету ${budget}`);
  return problems;
}

function durableSnapshot(): string {
  return read(database => JSON.stringify({
    bugs: database.prepare('SELECT project, env, source, owner, raw_id, revision, status, presence, payload FROM bugs ORDER BY raw_id').all(),
    comments: database.prepare('SELECT b.raw_id, c.server_id, c.origin, c.operation_id, c.author_id, c.text FROM comments c JOIN bugs b ON b.bug_pk = c.bug_pk ORDER BY b.raw_id, c.comment_pk').all(),
    outbox: database.prepare('SELECT operation_id, state, request_json, expected_revision FROM outbox ORDER BY operation_id').all(),
    attachments: database.prepare('SELECT bug_pk, comment_pk, server_id, kind, mime, bytes, sha256, presence FROM attachments ORDER BY server_id').all(),
  }));
}

function detail(rawId: string, attachments: readonly ServerAttachment[], comments: readonly string[]): ServerBugDetail {
  return {
    key: { project: 'qa', env: 'prod', source: 'dash', owner: 'owner-1', rawId }, problemId: `problem-${rawId}`, revision: 3,
    status: 'open', state: 'new', createdAt: AT, claimedBy: null, payload: { title: `QA ${rawId}` },
    comments: comments.map((id, index) => ({ id, authorId: 'user:qa', authorKind: 'human', text: `коментар ${id}`, replyTo: null, createdAt: AT, payload: { index } })),
    attachments, complete: true, errorCode: null,
  };
}

function attachment(id: string, commentId: string | null): ServerAttachment {
  const bytes = server.bodies.get(id)!;
  return { id, commentId, kind: 'file', mime: 'application/octet-stream', bytes: bytes.length, sha256: sha(bytes) };
}

async function pull(): Promise<void> {
  const config = loadBugSyncConfig(conf.bugs);
  const section = config.sections[0]!;
  const claims = createClaimsIssuer({ secrets: { select: async () => ({ env: { [SECRET_NAME]: SECRET }, files: [] }) }, config, clock: { now: () => new Date() } });
  const repository = openBugStore(databasePath);
  try {
    const view = describeBugSection(config, section, '');
    repository.upsertSection(describeBugSection(config, section, claims.fingerprint(view, 'read')));
    repository.applyPullBatch({
      sectionId: view.sectionId, at: new Date().toISOString(), deleted: [], missing: [], position: { journalCursor: '1', snapshotComplete: true, phase: 'incremental' },
      details: [
        detail('qa-1', [attachment('att-a', null), attachment('att-b', 'c-1'), attachment('att-c', null), attachment('att-d', 'c-2'), attachment('att-big', null),
          ...['att-f', 'att-g', 'att-h', 'att-i'].map(id => attachment(id, null))], ['c-1', 'c-2']),
        detail('qa-2', [attachment('att-e', 'c-3'), ...['att-j', 'att-k', 'att-l', 'att-m'].map(id => attachment(id, null))], ['c-3']),
      ],
    });
  } finally {
    repository.close();
  }
}

function keyOf(id: string): string {
  return ['att-e', 'att-j', 'att-k', 'att-l', 'att-m'].includes(id) ? KEY2 : KEY1;
}

function pause(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms));
}

async function until(condition: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`не дочекались: ${label}`);
    await pause(20);
  }
}

before(async () => {
  mkdirSync(join(root, 'conf'), { recursive: true });
  mkdirSync(rafHome, { recursive: true, mode: 0o700 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', join(workspace, 'key.pem'), '-out', certPath], { stdio: 'ignore' });
  ids.forEach((id, index) => server.bodies.set(id, body(index + 1)));
  server.bodies.set('att-big', body(99, BUDGET));
  await server.start(readFileSync(join(workspace, 'key.pem'), 'utf8'), readFileSync(certPath, 'utf8'));
  conf = JSON.parse(readFileSync(realConf, 'utf8'));
  conf.bugs = {
    ...conf.bugs, origin: server.origin, attachmentCacheMaxBytes: BUDGET, requestTimeoutMs: 5000,
    retry: { initialDelayMs: 50, multiplier: 2, maxDelayMs: 200 },
    sections: [{ project: 'qa', env: 'prod', stand: 'prod', secret: SECRET_NAME }],
  };
  writeConf(BUDGET);
  await (await openSecretsStore({ home, configPath: join(root, 'conf', 'raf.json') }))
    .merge([{ kind: 'env', name: SECRET_NAME, value: SECRET, source: 'qa-33', updatedAt: AT }]);
  await pull();
  writeFileSync(join(workspace, 'comment.txt'), 'Локальний коментар QA 3.3, не має загубитися під час очищення кешу.');
  const added = ok(await raf(['bug', 'comment', 'add', '--bug', KEY1, '--text-file', join(workspace, 'comment.txt')]));
  assert.equal(added.delivery, 'pending');
  baseline = durableSnapshot();
});

after(async () => {
  for (const child of running) child.kill('SIGKILL');
  await server.stop();
  rmSync(workspace, { recursive: true, force: true });
});

test('синхронізація метаданих не завантажує байти й не створює кешу', () => {
  assert.equal(server.requests.size, 0);
  assert.deepEqual(cacheFiles(), []);
  assert.ok(rows().every(item => item.cache_state === 'absent' && item.last_read_at === null));
});

test('досягнення порогу: три вкладення в межах бюджету, файл не менший за бюджет відхиляється без мережі', async () => {
  for (const id of ['att-a', 'att-b', 'att-c']) {
    const access = ok(await get(keyOf(id), id));
    assert.equal(access.source, 'download');
    assert.equal(access.sha256, sha(server.bodies.get(id)!));
    assert.equal(sha(readFileSync(access.path)), access.sha256);
    assert.ok(access.path.startsWith(cacheDirectory + '/'), access.path);
    await pause(5);
  }
  assert.deepEqual(ready(), ['att-a', 'att-b', 'att-c']);
  assert.equal(cachedBytes(), 3 * SIZE);
  const big = await get(KEY1, 'att-big');
  assert.notEqual(big.code, 0);
  assert.equal(big.stdout, '');
  assert.equal(big.json?.code, 'ATTACHMENT_TOO_LARGE', big.stderr);
  assert.equal(server.count('att-big'), 0);
  assert.deepEqual(indexProblems(BUDGET), []);
});

test('cache hit оновлює lastReadAt без мережі; фоновий pull його не змінює; очищення йде за давністю читання', async t => {
  const before = row('att-a').last_read_at!;
  await pause(5);
  const hit = ok(await get(KEY1, 'att-a'));
  assert.equal(hit.source, 'cache');
  assert.equal(server.count('att-a'), 1);
  const after = row('att-a').last_read_at!;
  assert.ok(Date.parse(after) > Date.parse(before), `${before} -> ${after}`);
  t.diagnostic(`att-a lastReadAt ${before} -> ${after}; downloads att-a=${server.count('att-a')}`);
  const snapshot = rows().map(item => [item.server_id, item.cache_state, item.cache_file, item.last_read_at]);
  await pull();
  assert.deepEqual(rows().map(item => [item.server_id, item.cache_state, item.cache_file, item.last_read_at]), snapshot);
  await pause(5);
  const added = ok(await get(KEY1, 'att-d'));
  assert.equal(added.source, 'download');
  assert.deepEqual(ready(), ['att-a', 'att-c', 'att-d']);
  const evicted = row('att-b');
  assert.equal(evicted.cache_state, 'absent');
  assert.equal(evicted.cache_file, null);
  assert.equal(evicted.sha256, sha(server.bodies.get('att-b')!));
  assert.equal(cacheFiles().length, 3);
  assert.deepEqual(indexProblems(BUDGET), []);
  t.diagnostic(`after att-d: ready=${ready().join(',')} evicted=att-b cached=${cachedBytes()}/${BUDGET}`);
});

test('повторне завантаження видаленого з кешу та нової версії вкладення', async () => {
  await pause(5);
  const again = ok(await get(KEY1, 'att-b'));
  assert.equal(again.source, 'download');
  assert.equal(server.count('att-b'), 2);
  assert.equal(sha(readFileSync(again.path)), sha(server.bodies.get('att-b')!));
  assert.deepEqual(ready(), ['att-a', 'att-b', 'att-d']);
  const oldFile = row('att-a').cache_file;
  server.bodies.set('att-a', body(42));
  await pull();
  assert.equal(row('att-a').cache_state, 'absent');
  assert.ok(cacheFiles().includes(String(oldFile)));
  await pause(5);
  const fresh = ok(await get(KEY1, 'att-a'));
  assert.equal(fresh.source, 'download');
  assert.equal(fresh.sha256, sha(body(42)));
  assert.equal(sha(readFileSync(fresh.path)), fresh.sha256);
  assert.ok(!cacheFiles().includes(String(oldFile)), 'стара версія лишилась у кеші');
  assert.deepEqual(indexProblems(BUDGET), []);
  baseline = durableSnapshot();
});

test('конкурентний доступ: кілька процесів одного вкладення завантажують його один раз', async t => {
  server.plan('att-f', { delayMs: 1500 });
  const results = await Promise.all(Array.from({ length: 6 }, () => get(KEY1, 'att-f')));
  const accesses = results.map(ok);
  assert.equal(server.count('att-f'), 1);
  assert.equal(new Set(accesses.map(access => access.path)).size, 1);
  for (const access of accesses) assert.equal(access.sha256, sha(server.bodies.get('att-f')!));
  assert.equal(accesses.filter(access => access.source === 'download').length, 1);
  t.diagnostic(`6 processes att-f: sources=${accesses.map(access => access.source).join(',')} server requests=${server.count('att-f')}`);
  assert.equal(sha(readFileSync(accesses[0].path)), sha(server.bodies.get('att-f')!));
  assert.deepEqual(indexProblems(BUDGET), []);
});

test('конкурентний доступ: паралельні завантаження різних вкладень і читання кешу з очищенням', async t => {
  const distinct = ['att-g', 'att-h', 'att-i', 'att-j', 'att-k', 'att-l'];
  for (const id of distinct) server.plan(id, { delayMs: 300 });
  const hits = ready();
  const jobs = [...distinct, ...hits, ...hits].map(id => get(keyOf(id), id).then(result => ({ id, result })));
  for (const { id, result } of await Promise.all(jobs)) {
    const access = ok(result);
    assert.equal(access.sha256, sha(server.bodies.get(id)!), id);
  }
  for (const id of distinct) assert.equal(server.count(id), 1, id);
  assert.deepEqual(indexProblems(BUDGET), []);
  assert.ok(ready().length <= 3, ready().join(','));
  t.diagnostic(`${jobs.length} processes; final ready=${ready().join(',')} cached=${cachedBytes()}/${BUDGET}`);
});

test('рестарт: процес убито посеред завантаження, наступний виклик відновлює кеш', async () => {
  server.plan('att-m', { stallAfter: 10 });
  const victim = start(['bug', 'attachment', 'get', '--bug', KEY2, '--attachment', 'att-m']);
  await until(() => cacheFiles().some(file => file.endsWith('.part')) && row('att-m').cache_state === 'fetching', 'часткового файла');
  victim.child.kill('SIGKILL');
  const killed = await victim.done;
  assert.equal(killed.code, null);
  assert.equal(row('att-m').cache_state, 'fetching');
  const restarted = ok(await get(KEY2, 'att-m'));
  assert.equal(restarted.source, 'download');
  assert.equal(server.count('att-m'), 2);
  assert.equal(sha(readFileSync(restarted.path)), sha(server.bodies.get('att-m')!));
  assert.ok(!cacheFiles().some(file => file.endsWith('.part')), cacheFiles().join(','));
  assert.deepEqual(indexProblems(BUDGET), []);
});

test('рестарт після часткового очищення: сирітський файл і втрачений файл узгоджуються', async () => {
  const [orphan, lost, alive] = rows().filter(item => item.cache_state === 'ready');
  assert.ok(orphan && lost && alive, ready().join(','));
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`UPDATE attachments SET cache_state = 'absent', cache_file = NULL, cache_bytes = NULL, cache_sha256 = NULL WHERE attachment_pk = ?`).run(orphan.attachment_pk);
  } finally {
    database.close();
  }
  rmSync(join(cacheDirectory, String(lost.cache_file)));
  assert.ok(cacheFiles().includes(String(orphan.cache_file)));
  const hit = ok(await get(keyOf(alive.server_id), alive.server_id));
  assert.equal(hit.source, 'cache');
  assert.ok(!cacheFiles().includes(String(orphan.cache_file)), 'сирітський файл не прибрано');
  assert.equal(row(lost.server_id).cache_state, 'absent');
  assert.deepEqual(indexProblems(BUDGET), []);
  const before = server.count(lost.server_id);
  const restored = ok(await get(keyOf(lost.server_id), lost.server_id));
  assert.equal(restored.source, 'download');
  assert.equal(server.count(lost.server_id), before + 1);
  assert.equal(sha(readFileSync(restored.path)), sha(server.bodies.get(lost.server_id)!));
  assert.deepEqual(indexProblems(BUDGET), []);
});

test('зменшення бюджету в conf застосовується після рестарту наступним читанням', async () => {
  const keep = ready()[0]!;
  writeConf(50);
  await pause(5);
  const hit = ok(await get(keyOf(keep), keep));
  assert.equal(hit.source, 'cache');
  assert.deepEqual(ready(), [keep]);
  assert.deepEqual(indexProblems(50), []);
  writeConf(BUDGET);
});

test('жуки, коментарі, pending-операція та метадані вкладень не загубились', async () => {
  assert.equal(durableSnapshot(), baseline);
  const shown = ok(await raf(['bug', 'show', '--bug', KEY1]));
  const texts = shown.bug.comments.map((comment: { text: string }) => comment.text);
  assert.ok(texts.includes('коментар c-1') && texts.includes('коментар c-2'), texts.join(' | '));
  const local = shown.bug.comments.find((comment: { text: string }) => comment.text.startsWith('Локальний коментар QA 3.3'));
  assert.ok(local, texts.join(' | '));
  assert.equal(shown.bug.attachments.length, 9);
  const outbox = read(database => database.prepare('SELECT state FROM outbox').all() as { state: string }[]);
  assert.deepEqual(outbox.map(item => item.state), ['pending']);
  assert.deepEqual(server.rejected, []);
});
