import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

const rafRoot = fileURLToPath(new URL('..', import.meta.url));
const realConf = join(rafRoot, '..', 'conf');
const secretName = 'DASH_BUGS_QA_QA';
const bugKey = 'projects/qa/bug#101';
const problemId = JSON.stringify(['web', 'qa', '101']);
const actor = 'raf:bugs';

type Mode = 'normal' | 'delay' | 'hang' | 'hang-before-commit';

interface ServerComment {
  readonly id: string;
  readonly author_id: string;
  readonly author_kind: string;
  readonly text: string;
  readonly created_at: string;
  readonly operation_id: string;
}

class FakeDash {
  readonly secret = randomBytes(32).toString('hex');
  readonly key: string;
  readonly cert: string;
  port = 0;
  revision = 1;
  comments: ServerComment[] = [];
  journal: { cursor: string; problem_id: string; kind: string; payload: unknown }[] = [];
  operations = new Map<string, { fingerprint: string; response: unknown }>();
  posts: { operationId: string; raw: string }[] = [];
  requests: { method: string; path: string; status: number }[] = [];
  held: ServerResponse[] = [];
  mode: Mode = 'normal';
  delayMs = 0;
  online = false;
  private server: Server;
  private sockets = new Set<Socket>();

  constructor(directory: string) {
    const keyPath = join(directory, 'dash.key');
    const certPath = join(directory, 'dash.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    this.key = readFileSync(keyPath, 'utf8');
    this.cert = certPath;
    this.server = createServer({ key: this.key, cert: readFileSync(certPath) }, (request, response) => { void this.handle(request, response); });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.journal.push({ cursor: '1', problem_id: problemId, kind: 'bug.created', payload: {} });
  }

  async start(): Promise<void> {
    await new Promise<void>((done, fail) => { this.server.once('error', fail); this.server.listen(this.port, '127.0.0.1', () => { this.server.off('error', fail); done(); }); });
    this.port = (this.server.address() as { port: number }).port;
    this.online = true;
  }

  async stop(): Promise<void> {
    if (!this.online) return;
    this.online = false;
    const closed = new Promise<void>(done => this.server.close(() => done()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }

  release(): void {
    for (const response of this.held.splice(0)) response.destroy();
  }

  postsFor(operationId: string) {
    return this.posts.filter(post => post.operationId === operationId);
  }

  commentsWithText(text: string) {
    return this.comments.filter(comment => comment.text === text);
  }

  private detail() {
    return {
      key: { source: 'web', owner: 'qa', id: '101' }, problem_id: problemId, revision: this.revision, status: 'open', state: 'triage',
      created_at: '2026-10-22T00:00:00.000Z', claimed_by: null,
      comments: this.comments.map(({ operation_id: _ignored, ...comment }) => comment), attachments: [],
    };
  }

  private authorize(request: IncomingMessage, url: URL, write: boolean): Record<string, unknown> | null {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || request.headers['x-bugs-contract-version'] !== '2') return null;
    const [head, body, signature] = header.slice(7).split('.');
    if (!head || !body || !signature) return null;
    const key = createHash('sha256').update(`dashboard-bugs:${this.secret}`).digest();
    const expected = createHmac('sha256', key).update(`${head}.${body}`).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const grants = Array.isArray(claims.grants) ? claims.grants : [];
    if (claims.aud !== 'dashboard-bugs' || claims.purpose !== 'bugs-api' || claims.contract_version !== 2 || claims.actor !== actor ||
        claims.project !== 'qa' || claims.env !== 'dev' || url.searchParams.get('project') !== 'qa' || url.searchParams.get('env') !== 'dev' ||
        typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() || !grants.includes('bugs:read') || (write && !grants.includes('bugs:write'))) return null;
    return claims;
  }

  private send(response: ServerResponse, status: number, body: unknown, request: { method: string; path: string }): void {
    this.requests.push({ ...request, status });
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `https://127.0.0.1:${this.port}`);
    const method = request.method ?? 'GET';
    const meta = { method, path: url.pathname };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const bugPath = `/api/bugs/${encodeURIComponent(problemId)}`;
    const claims = this.authorize(request, url, method === 'POST');
    if (!claims) return this.send(response, 401, { error: 'unauthorized' }, meta);
    if (method === 'GET' && url.pathname === '/api/bugs') return this.send(response, 200, { bugs: [this.detail()], nextCursor: null }, meta);
    if (method === 'GET' && url.pathname === '/api/bugs/events') {
      const cursor = Number(url.searchParams.get('cursor') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const after = this.journal.filter(event => Number(event.cursor) > cursor);
      const events = after.slice(0, limit);
      return this.send(response, 200, { events, cursor: events.at(-1)?.cursor ?? String(cursor), has_more: after.length > events.length }, meta);
    }
    if (method === 'GET' && url.pathname === bugPath) return this.send(response, 200, this.detail(), meta);
    if (method === 'POST' && url.pathname === `${bugPath}/comments`) {
      const body = JSON.parse(raw) as { operation_id: string; expected_revision: number; text: string };
      this.posts.push({ operationId: body.operation_id, raw });
      const fingerprint = createHash('sha256').update(`${claims.actor}\n${raw}`).digest('hex');
      const known = this.operations.get(body.operation_id);
      if (known) {
        if (known.fingerprint !== fingerprint) return this.send(response, 409, { error: 'idempotency-mismatch' }, meta);
        return this.send(response, 200, known.response, meta);
      }
      if (this.mode === 'hang-before-commit') { this.mode = 'normal'; this.requests.push({ ...meta, status: 0 }); this.held.push(response); return; }
      if (body.expected_revision !== this.revision) return this.send(response, 409, { error: 'revision-conflict', revision: this.revision }, meta);
      this.comments.push({
        id: `c${this.comments.length + 1}`, author_id: String(claims.actor), author_kind: 'agent', text: body.text,
        created_at: new Date().toISOString(), operation_id: body.operation_id,
      });
      this.revision += 1;
      this.journal.push({ cursor: String(this.journal.length + 1), problem_id: problemId, kind: 'comment.added', payload: {} });
      const snapshot = this.detail();
      this.operations.set(body.operation_id, { fingerprint, response: snapshot });
      if (this.mode === 'hang') { this.mode = 'normal'; this.requests.push({ ...meta, status: 0 }); this.held.push(response); return; }
      if (this.mode === 'delay') { this.mode = 'normal'; setTimeout(() => this.send(response, 201, snapshot, meta), this.delayMs); return; }
      return this.send(response, 201, snapshot, meta);
    }
    return this.send(response, 404, { error: 'not-found' }, meta);
  }
}

interface Environment {
  readonly directory: string;
  readonly root: string;
  readonly home: string;
  readonly config: { readonly requestTimeoutMs: number; readonly pollIntervalMs: number };
}

function prepare(dash: FakeDash, directory: string): Environment {
  const root = join(directory, 'root');
  const home = join(directory, 'home');
  cpSync(realConf, join(root, 'conf'), { recursive: true });
  const settings = JSON.parse(readFileSync(join(realConf, 'raf.json'), 'utf8'));
  const config = { requestTimeoutMs: 3000, pollIntervalMs: 400 };
  settings.bugs = {
    ...settings.bugs, origin: `https://127.0.0.1:${dash.port}`, ...config,
    retry: { initialDelayMs: 300, multiplier: 2, maxDelayMs: 1200 },
    sections: [{ project: 'qa', env: 'dev', stand: 'qa', secret: secretName }],
  };
  writeFileSync(join(root, 'conf', 'raf.json'), JSON.stringify(settings, null, 2));
  mkdirSync(join(home, '.raf'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.raf', 'secrets.json'), JSON.stringify({
    version: 1, records: [{ name: secretName, kind: 'env', value: dash.secret, source: 'qa', updatedAt: new Date().toISOString() }],
  }), { mode: 0o600 });
  return { directory, root, home, config };
}

function cleanEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('RAF_') && !name.startsWith('NODE_TEST')) environment[name] = value;
  return { ...environment, ...extra };
}

const cliRunner = `
const { runProductionCli } = await import(process.env.QA_ENTRY);
const result = await runProductionCli(JSON.parse(process.env.QA_ARGV), {
  orchestratorRoot: process.env.QA_ROOT, homeDirectory: process.env.QA_HOME, artifactPath: process.env.QA_CATALOG,
});
if (result.stdout) process.stdout.write(result.stdout + '\\n');
if (result.stderr) process.stderr.write(result.stderr + '\\n');
process.exitCode = result.exitCode;
`;

async function cli(environment: Environment, argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', cliRunner], {
    cwd: rafRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnvironment({
      HOME: environment.home, QA_ENTRY: join(rafRoot, 'src', 'production-entry.ts'), QA_ARGV: JSON.stringify(argv), QA_ROOT: environment.root,
      QA_HOME: environment.home, QA_CATALOG: join(rafRoot, 'dist', 'catalog.json'),
    }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number>(done => child.on('close', value => done(value ?? -1)));
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  return { code, stdout, stderr, json };
}

class Service {
  child: ChildProcess | undefined;
  starts = 0;
  private readonly environment: Environment;
  private readonly dash: FakeDash;
  constructor(environment: Environment, dash: FakeDash) {
    this.environment = environment;
    this.dash = dash;
  }

  start(): void {
    assert.equal(this.child, undefined, 'service already running');
    this.starts += 1;
    const state = join(this.environment.home, '.raf');
    const socket = join(state, 'service.sock');
    if (existsSync(socket)) {
      const record = JSON.parse(readFileSync(join(state, 'service.json'), 'utf8')) as { pid: number };
      let alive = true;
      try { process.kill(record.pid, 0); } catch { alive = false; }
      assert.equal(alive, false, `socket ${socket} belongs to live service PID ${record.pid}`);
      rmSync(socket);
    }
    const log = openSync(join(this.environment.directory, `service-${this.starts}.log`), 'a');
    this.child = spawn(process.execPath, [join(rafRoot, 'bin', 'service.ts')], {
      cwd: rafRoot, stdio: ['ignore', log, log],
      env: cleanEnvironment({
        HOME: this.environment.home, NODE_EXTRA_CA_CERTS: this.dash.cert,
        RAF_ORCHESTRATOR_ROOT: this.environment.root, RAF_HOME_DIRECTORY: this.environment.home, RAF_STATE_DIRECTORY: state,
        RAF_SOCKET_PATH: join(state, 'service.sock'), RAF_MAIN_PATH: rafRoot,
        RAF_SERVICE_HOST_MODULE_PATH: join(rafRoot, 'src', 'production-service-ports.ts'),
      }),
    });
    closeSync(log);
  }

  async stop(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const child = this.child;
    assert.ok(child, 'service is not running');
    this.child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, sig) => done({ code, signal: sig })));
    child.kill(signal);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try { return await exited; } finally { clearTimeout(timer); }
  }

  log(): string {
    let text = '';
    for (let index = 1; index <= this.starts; index++) {
      try { text += readFileSync(join(this.environment.directory, `service-${index}.log`), 'utf8'); } catch { }
    }
    return text;
  }
}

async function until<T>(label: string, probe: () => Promise<T | undefined | null | false>, service?: Service, timeoutMs = 45000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      last = value;
    } catch (error) { last = error; }
    if (service?.child && (service.child.exitCode !== null || service.child.signalCode !== null)) {
      throw new Error(`${label}: service exited unexpectedly\n${service.log()}`);
    }
    if (Date.now() > deadline) throw new Error(`${label}: timed out; last=${last instanceof Error ? last.message : JSON.stringify(last)}\n${service?.log() ?? ''}`);
    await new Promise(done => setTimeout(done, 200));
  }
}

async function show(environment: Environment): Promise<any> {
  const result = await cli(environment, ['bug', 'show', '--bug', bugKey]);
  assert.equal(result.code, 0, `bug show failed: ${result.stderr}`);
  return result.json.bug;
}

function commentsWithText(bug: any, text: string): any[] {
  return bug.comments.filter((comment: any) => comment.text === text);
}

function outboxRows(environment: Environment): { operation_id: string; state: string; attempts: number; request_json: string }[] {
  const database = new DatabaseSync(join(environment.home, '.raf', 'bugs.sqlite'), { readOnly: true });
  try { return database.prepare('SELECT operation_id, state, attempts, request_json FROM outbox ORDER BY created_at').all() as any; }
  finally { database.close(); }
}

async function addComment(environment: Environment, text: string): Promise<any> {
  const file = join(environment.directory, `comment-${createHash('sha256').update(text).digest('hex').slice(0, 8)}.txt`);
  writeFileSync(file, text);
  const result = await cli(environment, ['bug', 'comment', 'add', '--bug', bugKey, '--text-file', file]);
  assert.equal(result.code, 0, `bug comment add failed: ${result.stderr}`);
  assert.equal(result.json.accepted, true);
  assert.equal(result.json.delivered, false);
  assert.equal(result.json.delivery, 'pending');
  assert.match(result.json.operationId, /^[0-9a-f-]{36}$/);
  return result.json;
}

async function syncedRevision(environment: Environment, dash: FakeDash, service: Service): Promise<void> {
  await until('local revision catches up with the server', async () => (await show(environment)).revision === dash.revision, service);
}

async function confirmed(environment: Environment, text: string, service: Service): Promise<any> {
  return until(`comment "${text}" confirmed with a server id`, async () => {
    const matches = commentsWithText(await show(environment), text);
    return matches.length === 1 && matches[0].serverId && matches[0].delivery === null ? matches[0] : null;
  }, service);
}

function assertSingleDelivery(dash: FakeDash, environment: Environment, bug: any, text: string, operationId: string, minimumPosts: number): void {
  const posts = dash.postsFor(operationId);
  assert.ok(posts.length >= minimumPosts, `expected at least ${minimumPosts} POSTs for ${operationId}, got ${posts.length}`);
  assert.equal(new Set(posts.map(post => post.raw)).size, 1, 'every retry must send the identical request body');
  assert.equal(JSON.parse(posts[0].raw).operation_id, operationId);
  assert.equal(dash.posts.filter(post => JSON.parse(post.raw).text === text && post.operationId !== operationId).length, 0, 'no new operation id for the same comment');
  assert.equal(dash.commentsWithText(text).length, 1, 'server holds exactly one comment');
  const local = commentsWithText(bug, text);
  assert.equal(local.length, 1, 'local copy holds exactly one visible comment');
  assert.equal(local[0].serverId, dash.commentsWithText(text)[0].id);
  assert.equal(outboxRows(environment).filter(row => row.operation_id === operationId).length, 0, 'outbox cleared after confirmed delivery');
}

test('QA 3.1: real bugs.sqlite, real raf service process and a controlled HTTPS dash', { timeout: 600000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-bs31-'));
  const dash = new FakeDash(directory);
  await dash.start();
  const environment = prepare(dash, directory);
  const service = new Service(environment, dash);
  t.after(async () => {
    if (service.child) await service.stop('SIGKILL');
    dash.release();
    await dash.stop();
    if (!process.env.QA_KEEP) rmSync(directory, { recursive: true, force: true });
  });

  await t.test('service performs the initial sync into a separate bugs.sqlite', async () => {
    service.start();
    const listed = await until('bug appears in raf bug list', async () => {
      const result = await cli(environment, ['bug', 'list']);
      assert.equal(result.code, 0, result.stderr);
      return result.json.bugs.length === 1 && result.json.sync[0]?.snapshotComplete ? result.json : null;
    }, service);
    assert.equal(listed.bugs[0].key, bugKey);
    assert.equal(listed.source, 'local');
    assert.equal(listed.sync[0].sectionId, 'qa:dev');
    assert.equal(listed.sync[0].phase, 'incremental');
    const state = new DatabaseSync(join(environment.home, '.raf', 'state.sqlite'), { readOnly: true });
    try {
      const tables = (state.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name);
      assert.ok(!tables.some(name => ['bugs', 'comments', 'outbox'].includes(name)), `state.sqlite must not hold bug tables: ${tables}`);
    } finally { state.close(); }
    const stopped = await service.stop('SIGTERM');
    assert.equal(stopped.code, 0, `graceful stop: ${JSON.stringify(stopped)}\n${service.log()}`);
  });

  const offlineText = `QA 3.1 offline comment ${randomBytes(4).toString('hex')}`;
  let offlineReceipt: any;

  await t.test('comment added through raf is visible locally before any send', async () => {
    const postsBefore = dash.posts.length;
    offlineReceipt = await addComment(environment, offlineText);
    const bug = await show(environment);
    const local = commentsWithText(bug, offlineText);
    assert.equal(local.length, 1);
    assert.equal(local[0].origin, 'local');
    assert.equal(local[0].serverId, null);
    assert.equal(local[0].delivery.operationId, offlineReceipt.operationId);
    assert.equal(local[0].delivery.state, 'pending');
    assert.equal(local[0].delivery.attempts, 0);
    assert.equal(dash.posts.length, postsBefore, 'nothing is sent while the service is stopped');
  });

  await t.test('offline server: pending survives retries and a service restart', async () => {
    await dash.stop();
    service.start();
    const failing = await until('send attempts fail while offline', async () => {
      const local = commentsWithText(await show(environment), offlineText)[0];
      return local?.delivery?.state === 'unknown' && local.delivery.attempts >= 2 ? local : null;
    }, service);
    assert.equal(failing.serverId, null);
    assert.equal(failing.delivery.operationId, offlineReceipt.operationId);
    assert.equal(failing.delivery.lastErrorCode, 'network');
    const listed = await cli(environment, ['bug', 'list']);
    assert.equal(listed.json.sync[0].lastErrorCode, 'network', 'pull failure is visible, not reported as success');
    assert.ok(listed.json.sync[0].consecutiveFailures >= 1);
    assert.equal(listed.json.bugs[0].pendingOperations, 1);
    const stopped = await service.stop('SIGTERM');
    assert.equal(stopped.code, 0, service.log());
    const rows = outboxRows(environment);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation_id, offlineReceipt.operationId);
    assert.notEqual(rows[0].state, 'delivered');
    assert.equal(dash.posts.length, 0, 'offline server received nothing');
    await dash.start();
    service.start();
    const delivered = await confirmed(environment, offlineText, service);
    assert.equal(delivered.origin, 'local');
    await until('two more poll cycles pass', async () => dash.requests.filter(request => request.path === '/api/bugs/events').length >= 4 &&
      (await show(environment)).revision === dash.revision, service);
    const settled = dash.requests.filter(request => request.path === '/api/bugs/events').length;
    await until('further poll cycles pass', async () => dash.requests.filter(request => request.path === '/api/bugs/events').length >= settled + 2, service);
    assertSingleDelivery(dash, environment, await show(environment), offlineText, offlineReceipt.operationId, 1);
  });

  await t.test('long server response: timeout, identical replay, no duplicate', async () => {
    await syncedRevision(environment, dash, service);
    dash.mode = 'delay';
    dash.delayMs = environment.config.requestTimeoutMs * 2;
    const text = `QA 3.1 delayed response ${randomBytes(4).toString('hex')}`;
    const receipt = await addComment(environment, text);
    const visible = commentsWithText(await show(environment), text);
    assert.equal(visible.length, 1, 'visible immediately after add while the service runs');
    await until('first POST times out and is retried', async () => dash.postsFor(receipt.operationId).length >= 2, service);
    const bug = await (async () => { await confirmed(environment, text, service); return show(environment); })();
    assertSingleDelivery(dash, environment, bug, text, receipt.operationId, 2);
  });

  for (const scenario of [
    { mode: 'hang' as const, label: 'service crash after the server committed, before the response' },
    { mode: 'hang-before-commit' as const, label: 'service crash while the request is in flight, before the server committed' },
  ]) {
    await t.test(scenario.label, async () => {
      await syncedRevision(environment, dash, service);
      dash.mode = scenario.mode;
      const text = `QA 3.1 ${scenario.mode} ${randomBytes(4).toString('hex')}`;
      const receipt = await addComment(environment, text);
      await until('server holds the in-flight POST', async () => dash.held.length === 1 && dash.postsFor(receipt.operationId).length === 1, service);
      await until('outbox row is in state sending', async () => outboxRows(environment).find(row => row.operation_id === receipt.operationId)?.state === 'sending', service);
      const killed = await service.stop('SIGKILL');
      assert.equal(killed.signal, 'SIGKILL');
      dash.release();
      const local = commentsWithText(await show(environment), text);
      assert.equal(local.length, 1, 'comment survives the crash');
      assert.equal(local[0].serverId, null);
      assert.equal(local[0].delivery.operationId, receipt.operationId);
      assert.equal(local[0].delivery.state, 'sending');
      assert.equal(dash.commentsWithText(text).length, scenario.mode === 'hang' ? 1 : 0);
      service.start();
      await confirmed(environment, text, service);
      assertSingleDelivery(dash, environment, await show(environment), text, receipt.operationId, 2);
    });
  }

  await t.test('final state: every comment exactly once on the server and locally', async step => {
    const bug = await show(environment);
    step.diagnostic(JSON.stringify({
      serviceStarts: service.starts, serverRevision: dash.revision,
      operations: dash.comments.map(comment => ({ text: comment.text, serverId: comment.id, posts: dash.postsFor(comment.operation_id).length })),
      requests: dash.requests.length,
    }));
    assert.equal(bug.revision, dash.revision);
    assert.equal(bug.comments.length, dash.comments.length);
    assert.equal(new Set(dash.comments.map(comment => comment.text)).size, dash.comments.length);
    assert.deepEqual(bug.comments.map((comment: any) => comment.serverId).sort(), dash.comments.map(comment => comment.id).sort());
    assert.equal(outboxRows(environment).length, 0);
    assert.equal(bug.conflicts.length, 0);
    assert.ok(dash.requests.every(request => request.status !== 401), 'all service requests carried a valid JWT');
    const stopped = await service.stop('SIGTERM');
    assert.equal(stopped.code, 0, service.log());
  });
});
