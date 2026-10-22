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
import type { Duplex } from 'node:stream';
import { buildCatalog } from '../src/bootstrap.ts';

const rafRoot = fileURLToPath(new URL('..', import.meta.url));
const realConf = join(rafRoot, '..', 'conf');
const secretName = 'DASH_BUGS_QA_QA';
const bugKey = 'projects/qa/bug#101';
const problemId = JSON.stringify(['web', 'qa', '101']);
const actor = 'raf:bugs';
const mcpPath = '/internal/mcp/bugs';
const statuses = ['open', 'in_progress', 'awaiting_verification', 'closed'];
const leaseMs = 30 * 60 * 1000;

interface ServerComment {
  readonly id: string;
  readonly author_id: string;
  readonly author_kind: string;
  readonly text: string;
  readonly reply_to: string | null;
  readonly created_at: string;
}

interface ToolFailure {
  readonly error: string;
  readonly status: number;
}

class ToolError extends Error {
  readonly failure: ToolFailure;
  constructor(failure: ToolFailure) {
    super(failure.error);
    this.failure = failure;
  }
}

class FakeDash {
  readonly secret = randomBytes(32).toString('hex');
  readonly key: string;
  readonly cert: string;
  port = 0;
  revision = 1;
  status = 'open';
  claimedBy: string | null = null;
  claimToken: string | null = null;
  claimExpiresAt: string | null = null;
  comments: ServerComment[] = [];
  journal: { cursor: string; problem_id: string; kind: string; payload: unknown }[] = [];
  requests: { method: string; path: string; status: number; tool: string | null }[] = [];
  tools: { name: string; args: Record<string, any> }[] = [];
  rejections: ToolFailure[] = [];
  online = false;
  private claims = 0;
  private server: Server;
  private sockets = new Set<Duplex>();

  constructor(directory: string) {
    const keyPath = join(directory, 'dash.key');
    const certPath = join(directory, 'dash.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    this.key = readFileSync(keyPath, 'utf8');
    this.cert = certPath;
    this.server = createServer({ key: this.key, cert: readFileSync(certPath) }, (request, response) => { void this.handle(request, response); });
    this.server.on('connection', socket => {
      if (!this.online) { socket.destroy(); return; }
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.journal.push({ cursor: '1', problem_id: problemId, kind: 'bug.created', payload: {} });
  }

  async start(): Promise<void> {
    await new Promise<void>((done, fail) => { this.server.once('error', fail); this.server.listen(0, '127.0.0.1', () => { this.server.off('error', fail); done(); }); });
    this.port = (this.server.address() as { port: number }).port;
    this.online = true;
  }

  goOffline(): void {
    this.online = false;
    for (const socket of this.sockets) socket.destroy();
  }

  goOnline(): void {
    this.online = true;
  }

  async close(): Promise<void> {
    this.goOffline();
    await new Promise<void>(done => this.server.close(() => done()));
  }

  humanComment(text: string): ServerComment {
    return this.addComment('owner@example.test', 'person', text, null);
  }

  mcpRequests(): number {
    return this.requests.filter(request => request.path === mcpPath).length;
  }

  private addComment(author: string, kind: string, text: string, replyTo: string | null): ServerComment {
    const comment = { id: `c${this.comments.length + 1}`, author_id: author, author_kind: kind, text, reply_to: replyTo, created_at: new Date().toISOString() };
    this.comments.push(comment);
    this.changed('comment.added');
    return comment;
  }

  private changed(kind: string): void {
    this.revision += 1;
    this.journal.push({ cursor: String(this.journal.length + 1), problem_id: problemId, kind, payload: {} });
  }

  private header() {
    return {
      key: { source: 'web', owner: 'qa', id: '101' }, problem_id: problemId, revision: this.revision, status: this.status, state: 'triage',
      created_at: '2026-10-22T00:00:00.000Z', claimed_by: this.claimedBy, claim_expires_at: this.claimExpiresAt,
      ...(this.claimedBy === actor && this.claimToken ? { claim_token: this.claimToken } : {}),
    };
  }

  private detail() {
    return { ...this.header(), comments: this.comments, attachments: [] };
  }

  private verified(request: IncomingMessage): Record<string, unknown> | null {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || request.headers['x-bugs-contract-version'] !== '2') return null;
    const [head, body, signature] = header.slice(7).split('.');
    if (!head || !body || !signature) return null;
    const key = createHash('sha256').update(`dashboard-bugs:${this.secret}`).digest();
    const expected = createHmac('sha256', key).update(`${head}.${body}`).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (claims.aud !== 'dashboard-bugs' || claims.purpose !== 'bugs-api' || claims.contract_version !== 2 || claims.actor !== actor ||
        claims.project !== 'qa' || claims.env !== 'dev' || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
    return claims;
  }

  private grants(claims: Record<string, unknown>): unknown[] {
    return Array.isArray(claims.grants) ? claims.grants : [];
  }

  private send(response: ServerResponse, status: number, body: unknown, request: { method: string; path: string; tool: string | null }): void {
    this.requests.push({ ...request, status });
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private tool(name: string, args: Record<string, any>, claims: Record<string, unknown>): unknown {
    this.tools.push({ name, args });
    if (name === 'read_bug') {
      if (args.id !== problemId) throw new ToolError({ error: 'not-found', status: 404 });
      return this.detail();
    }
    if (name !== 'comment_problem' && name !== 'set_problem_status') throw new ToolError({ error: 'invalid-input', status: 422 });
    if (claims.scope !== 'write' || !this.grants(claims).includes('bugs:write')) throw new ToolError({ error: 'access-denied', status: 403 });
    if (args.problem_id !== problemId) throw new ToolError({ error: 'not-found', status: 404 });
    const rejection = this.rejections.shift();
    if (rejection) throw new ToolError(rejection);
    if (typeof args.operation_id !== 'string' || !args.operation_id || typeof args.expected_revision !== 'number') throw new ToolError({ error: 'invalid-input', status: 422 });
    if (args.expected_revision !== this.revision) throw new ToolError({ error: 'revision-conflict', status: 409 });
    const leaseActive = this.claimedBy !== null && this.claimExpiresAt !== null && Date.parse(this.claimExpiresAt) > Date.now();
    if (leaseActive && this.claimedBy === actor && args.claimToken !== this.claimToken) throw new ToolError({ error: 'lease-required', status: 409 });
    const base = { contract_version: 2, ok: true, problem_id: problemId, operation_id: args.operation_id };
    if (name === 'comment_problem') {
      if (typeof args.comment !== 'string' || !args.comment.trim()) throw new ToolError({ error: 'invalid-input', status: 422 });
      const comment = this.addComment(actor, 'agent', args.comment, typeof args.reply_to === 'string' ? args.reply_to : null);
      return { ...base, revision: this.revision, comment_id: comment.id, comment, bug: this.header() };
    }
    if (!statuses.includes(args.status)) throw new ToolError({ error: 'invalid-input', status: 422 });
    this.status = args.status;
    if (args.status === 'in_progress') {
      this.claims += 1;
      this.claimedBy = actor;
      this.claimToken = `qa-claim-${this.claims}-${randomBytes(8).toString('hex')}`;
      this.claimExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    } else if (this.claimedBy === actor) {
      this.claimedBy = null;
      this.claimToken = null;
      this.claimExpiresAt = null;
    }
    this.changed('status.changed');
    return { ...base, revision: this.revision, bug: this.header() };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `https://127.0.0.1:${this.port}`);
    const method = request.method ?? 'GET';
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const claims = this.verified(request);
    if (method === 'POST' && url.pathname === mcpPath) {
      const rpc = JSON.parse(raw) as { id: unknown; method: string; params: { name: string; arguments?: Record<string, any> } };
      const meta = { method, path: url.pathname, tool: rpc.params?.name ?? null };
      if (!claims || rpc.method !== 'tools/call' || request.headers['mcp-protocol-version'] !== '2025-11-25') return this.send(response, 401, { error: 'unauthenticated' }, meta);
      try {
        const answer = this.tool(rpc.params.name, rpc.params.arguments ?? {}, claims);
        return this.send(response, 200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer } }, meta);
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return this.send(response, 200, { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: error.failure.error }], structuredContent: error.failure } }, meta);
      }
    }
    const meta = { method, path: url.pathname, tool: null };
    if (!claims || method !== 'GET' || url.searchParams.get('project') !== 'qa' || url.searchParams.get('env') !== 'dev' || !this.grants(claims).includes('bugs:read')) {
      return this.send(response, 401, { error: 'unauthorized' }, meta);
    }
    if (url.pathname === '/api/bugs') return this.send(response, 200, { bugs: [this.detail()], nextCursor: null }, meta);
    if (url.pathname === '/api/bugs/events') {
      const cursor = Number(url.searchParams.get('cursor') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const after = this.journal.filter(event => Number(event.cursor) > cursor);
      const events = after.slice(0, limit);
      return this.send(response, 200, { events, cursor: events.at(-1)?.cursor ?? String(cursor), has_more: after.length > events.length }, meta);
    }
    if (url.pathname === `/api/bugs/${encodeURIComponent(problemId)}`) return this.send(response, 200, this.detail(), meta);
    return this.send(response, 404, { error: 'not-found' }, meta);
  }
}

interface Environment {
  readonly directory: string;
  readonly root: string;
  readonly home: string;
  readonly catalog: string;
  readonly cert: string;
  readonly config: { readonly requestTimeoutMs: number; readonly pollIntervalMs: number };
}

interface DashEndpoint {
  readonly port: number;
  readonly secret: string;
  readonly cert: string;
}

function prepare(dash: DashEndpoint, directory: string, overrides: Record<string, unknown> = {}): Environment {
  const root = join(directory, 'root');
  const home = join(directory, 'home');
  cpSync(realConf, join(root, 'conf'), { recursive: true });
  const settings = JSON.parse(readFileSync(join(realConf, 'raf.json'), 'utf8'));
  const config = { requestTimeoutMs: 3000, pollIntervalMs: 400 };
  settings.bugs = {
    ...settings.bugs, origin: `https://127.0.0.1:${dash.port}`, ...config,
    retry: { initialDelayMs: 300, multiplier: 2, maxDelayMs: 1200 },
    sections: [{ project: 'qa', env: 'dev', stand: 'qa', secret: secretName }], ...overrides,
  };
  writeFileSync(join(root, 'conf', 'raf.json'), JSON.stringify(settings, null, 2));
  mkdirSync(join(home, '.raf'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.raf', 'secrets.json'), JSON.stringify({
    version: 1, records: [{ name: secretName, kind: 'env', value: dash.secret, source: 'qa', updatedAt: new Date().toISOString() }],
  }), { mode: 0o600 });
  const catalog = join(directory, 'catalog.json');
  const constants = JSON.parse(readFileSync(join(root, 'conf', 'raf-constants.json'), 'utf8'));
  buildCatalog(join(root, 'conf'), catalog, constants.commands.map((command: { path: string[] }) => command.path.join(' ')));
  return { directory, root, home, catalog, cert: dash.cert, config };
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
      QA_HOME: environment.home, QA_CATALOG: environment.catalog, NODE_EXTRA_CA_CERTS: environment.cert,
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
  private readonly dash: DashEndpoint;
  constructor(environment: Environment, dash: DashEndpoint) {
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

  async ready(): Promise<void> {
    const pid = this.child?.pid;
    await until('service reports ready', async () => {
      const record = readRecord(this.environment);
      return record?.state === 'ready' && record.pid === pid;
    }, this);
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

function readRecord(environment: Environment): { state: string; pid: number } | null {
  try { return JSON.parse(readFileSync(join(environment.home, '.raf', 'service.json'), 'utf8')); } catch { return null; }
}

async function show(environment: Environment): Promise<any> {
  const result = await cli(environment, ['bug', 'show', '--bug', bugKey]);
  assert.equal(result.code, 0, `bug show failed: ${result.stderr}`);
  return result.json.bug;
}

async function syncState(environment: Environment): Promise<any> {
  const result = await cli(environment, ['bug', 'list']);
  assert.equal(result.code, 0, result.stderr);
  return result.json.sync[0];
}

function commentsWithText(bug: any, text: string): any[] {
  return bug.comments.filter((comment: any) => comment.text === text);
}

async function addComment(environment: Environment, text: string) {
  const file = join(environment.directory, `comment-${createHash('sha256').update(text).digest('hex').slice(0, 8)}.txt`);
  writeFileSync(file, text);
  return cli(environment, ['bug', 'comment', 'add', '--bug', bugKey, '--text-file', file]);
}

function errorCode(result: { code: number; stdout: string; stderr: string }): string {
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.stdout, '');
  return JSON.parse(result.stderr).code;
}

function storedBytes(environment: Environment): string {
  return ['', '-wal', '-shm'].map(suffix => join(environment.home, '.raf', `bugs.sqlite${suffix}`))
    .filter(path => existsSync(path)).map(path => readFileSync(path).toString('latin1')).join('');
}

test('QA 3.1: real bugs.sqlite, real raf service process and a controlled HTTPS dash', { timeout: 600000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-bs31-'));
  const dash = new FakeDash(directory);
  await dash.start();
  const environment = prepare(dash, directory);
  const service = new Service(environment, dash);
  const socket = join(environment.home, '.raf', 'service.sock');
  t.after(async () => {
    if (service.child) await service.stop('SIGKILL');
    await dash.close();
    if (!process.env.QA_KEEP) rmSync(directory, { recursive: true, force: true });
  });

  await t.test('service performs the initial sync into a separate bugs.sqlite', async () => {
    service.start();
    await service.ready();
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
      assert.ok(!tables.some(name => ['bugs', 'comments', 'notices', 'outbox'].includes(name)), `state.sqlite must not hold bug tables: ${tables}`);
    } finally { state.close(); }
    const stopped = await service.stop('SIGTERM');
    assert.equal(stopped.code, 0, `graceful stop: ${JSON.stringify(stopped)}\n${service.log()}`);
    assert.equal(readRecord(environment)?.state, 'stopped');
  });

  const stoppedText = `QA 3.1 synchronous comment ${randomBytes(4).toString('hex')}`;

  await t.test('comment add and status set with the service stopped go to MCP Dash, are visible at once and start no service', async () => {
    const record = readFileSync(join(environment.home, '.raf', 'service.json'), 'utf8');
    const starts = service.starts;
    const requests = dash.requests.length;
    const written = await addComment(environment, stoppedText);
    assert.equal(written.code, 0, written.stderr);
    const server = dash.comments.find(comment => comment.text === stoppedText);
    assert.ok(server, 'comment reached the server');
    assert.equal(written.json.commentId, server.id);
    assert.equal(written.json.revision, dash.revision);
    for (const field of ['accepted', 'delivered', 'delivery', 'state', 'notice']) assert.equal(written.json[field], undefined, field);
    const afterComment = await show(environment);
    assert.equal(afterComment.revision, dash.revision);
    assert.deepEqual(commentsWithText(afterComment, stoppedText).map(comment => comment.serverId), [server.id]);

    const claimed = await cli(environment, ['bug', 'status', 'set', '--bug', bugKey, '--status', 'in_progress']);
    assert.equal(claimed.code, 0, claimed.stderr);
    assert.equal(dash.status, 'in_progress');
    assert.equal(dash.claimedBy, actor);
    assert.equal(claimed.json.status, 'in_progress');
    assert.equal(claimed.json.revision, dash.revision);
    const afterStatus = await show(environment);
    assert.equal(afterStatus.status, 'in_progress');
    assert.equal(afterStatus.claimedBy, actor);
    assert.equal(afterStatus.revision, dash.revision);
    assert.ok(dash.claimToken);
    for (const text of [claimed.stdout, JSON.stringify(afterStatus), storedBytes(environment)]) assert.ok(!text.includes(dash.claimToken), 'claim token is never printed or stored');

    const claimedText = `${stoppedText} under own claim`;
    const underClaim = await addComment(environment, claimedText);
    assert.equal(underClaim.code, 0, underClaim.stderr);
    assert.equal(dash.tools.at(-1)!.args.claimToken, dash.claimToken, 'own lease token comes from a fresh read_bug');

    const window = dash.requests.slice(requests);
    assert.deepEqual(window.map(request => request.tool), ['read_bug', 'comment_problem', 'read_bug', 'set_problem_status', 'read_bug', 'comment_problem']);
    assert.ok(window.every(request => request.path === mcpPath && request.status === 200), JSON.stringify(window));
    const operations = dash.tools.filter(call => call.name !== 'read_bug').map(call => call.args.operation_id);
    assert.equal(new Set(operations).size, operations.length, 'a new operation id per command');
    assert.equal(service.starts, starts);
    assert.equal(service.child, undefined);
    assert.equal(existsSync(socket), false, 'no service socket appears');
    assert.equal(readFileSync(join(environment.home, '.raf', 'service.json'), 'utf8'), record, 'service record untouched');
  });

  await t.test('a server refusal is a command error and leaves the local base untouched', async () => {
    const before = await show(environment);
    const revision = dash.revision;
    dash.rejections.push({ error: 'revision-conflict', status: 409 });
    assert.equal(errorCode(await addComment(environment, 'QA 3.1 refused comment')), 'BUG_WRITE_REJECTED');
    assert.equal(errorCode(await cli(environment, ['bug', 'status', 'set', '--bug', bugKey, '--status', 'no_such_status'])), 'BUG_WRITE_REJECTED');
    assert.equal(dash.revision, revision);
    assert.deepEqual(await show(environment), before);
  });

  await t.test('offline server: the write result is unknown, the pull failure is visible and survives a restart', async () => {
    dash.goOffline();
    const before = await show(environment);
    assert.equal(errorCode(await addComment(environment, 'QA 3.1 offline comment')), 'BUG_WRITE_UNKNOWN');
    assert.deepEqual(await show(environment), before, 'an unknown write changes nothing locally');
    const serverChange = dash.humanComment('QA 3.1 human comment while raf is offline');
    service.start();
    await service.ready();
    const failing = await until('pull fails while offline', async () => {
      const sync = await syncState(environment);
      return sync.lastErrorCode === 'network' && sync.consecutiveFailures >= 1 ? sync : null;
    }, service);
    assert.equal(failing.lastErrorCode, 'network');
    const stopped = await service.stop('SIGTERM');
    assert.equal(stopped.code, 0, service.log());
    assert.equal((await syncState(environment)).lastErrorCode, 'network', 'the failure stays visible after the service stops');
    dash.goOnline();
    service.start();
    await service.ready();
    const recovered = await until('pull recovers and catches up', async () => {
      const bug = await show(environment);
      return bug.revision === dash.revision && commentsWithText(bug, serverChange.text).length === 1 ? bug : null;
    }, service);
    assert.equal((await syncState(environment)).lastErrorCode, null);
    assert.equal(commentsWithText(recovered, stoppedText).length, 1);
  });

  await t.test('a write while the service pulls is visible at once and the following pulls neither roll it back nor duplicate it', async () => {
    const text = `QA 3.1 comment while the service runs ${randomBytes(4).toString('hex')}`;
    const written = await addComment(environment, text);
    assert.equal(written.code, 0, written.stderr);
    const immediate = commentsWithText(await show(environment), text);
    assert.deepEqual(immediate.map(comment => comment.serverId), [written.json.commentId]);
    const human = dash.humanComment('QA 3.1 human reply after the write');
    const events = () => dash.requests.filter(request => request.path === '/api/bugs/events').length;
    const settled = await until('the service pulls the human reply', async () => {
      const bug = await show(environment);
      return bug.revision === dash.revision && commentsWithText(bug, human.text).length === 1 ? events() : null;
    }, service);
    await until('two more poll cycles pass', async () => events() >= settled + 2, service);
    const bug = await show(environment);
    assert.equal(bug.revision, dash.revision);
    assert.equal(commentsWithText(bug, text).length, 1);
    assert.equal(bug.status, dash.status);
  });

  await t.test('final state: every server comment exactly once locally and the service never writes', async step => {
    const bug = await show(environment);
    step.diagnostic(JSON.stringify({ serviceStarts: service.starts, serverRevision: dash.revision, tools: dash.tools.map(call => call.name), requests: dash.requests.length }));
    assert.equal(bug.revision, dash.revision);
    assert.deepEqual(bug.comments.map((comment: any) => comment.serverId).sort(), dash.comments.map(comment => comment.id).sort());
    assert.equal(new Set(dash.comments.map(comment => comment.text)).size, dash.comments.length);
    assert.equal(dash.tools.filter(call => call.name !== 'read_bug').length, 6, 'only the six CLI write commands reached a mutating tool');
    assert.ok(dash.requests.every(request => request.status !== 401), 'every request carried a valid JWT');
    const stopped = await service.stop('SIGTERM');
    assert.equal(stopped.code, 0, service.log());
  });
});

interface PagedAttachment {
  readonly id: string;
  readonly content: Buffer;
}

interface PagedBug {
  readonly rawId: string;
  revision: number;
  comments: ServerComment[];
  attachments: PagedAttachment[];
  deleted: boolean;
  hidden: boolean;
}

interface PagedRequest {
  readonly path: string;
  readonly cursor: string | null;
  readonly commentsCursor: string | null;
  status: number;
}

class PagedDash {
  readonly secret = randomBytes(32).toString('hex');
  readonly cert: string;
  port = 0;
  online = false;
  bugs: PagedBug[] = [];
  journal: { cursor: string; problem_id: string; kind: string; payload: unknown }[] = [];
  requests: PagedRequest[] = [];
  intercept: ((request: PagedRequest) => 'fail' | 'hang' | null) | null = null;
  private held: ServerResponse[] = [];
  private comments = 0;
  private server: Server;
  private sockets = new Set<Duplex>();

  constructor(directory: string) {
    const keyPath = join(directory, 'dash.key');
    this.cert = join(directory, 'dash.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', this.cert, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    this.server = createServer({ key: readFileSync(keyPath), cert: readFileSync(this.cert) }, (request, response) => { void this.handle(request, response); });
    this.server.on('connection', socket => {
      if (!this.online) { socket.destroy(); return; }
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((done, fail) => { this.server.once('error', fail); this.server.listen(0, '127.0.0.1', () => { this.server.off('error', fail); done(); }); });
    this.port = (this.server.address() as { port: number }).port;
    this.online = true;
  }

  goOffline(): void {
    this.online = false;
    for (const socket of this.sockets) socket.destroy();
  }

  goOnline(): void {
    this.online = true;
  }

  release(): void {
    for (const response of this.held.splice(0)) response.destroy();
  }

  async close(): Promise<void> {
    this.release();
    this.goOffline();
    await new Promise<void>(done => this.server.close(() => done()));
  }

  addBug(rawId: string, texts: readonly string[], attachment = false): void {
    const bug: PagedBug = { rawId, revision: 1, comments: [], attachments: [], deleted: false, hidden: false };
    for (const text of texts) bug.comments.push(this.comment(text));
    if (attachment) bug.attachments.push({ id: `a${rawId}`, content: randomBytes(96) });
    this.bugs.push(bug);
    this.event(bug, 'bug.created');
  }

  humanComment(rawId: string, text: string): ServerComment {
    const bug = this.bug(rawId);
    const comment = this.comment(text);
    bug.comments.push(comment);
    bug.revision += 1;
    this.event(bug, 'comment.added');
    return comment;
  }

  deleteComment(rawId: string, id: string): void {
    const bug = this.bug(rawId);
    bug.comments = bug.comments.filter(comment => comment.id !== id);
    bug.revision += 1;
    this.event(bug, 'comment.deleted');
  }

  deleteBug(rawId: string): void {
    const bug = this.bug(rawId);
    bug.deleted = true;
    this.event(bug, 'bug.deleted', { deleted: true });
  }

  hideBug(rawId: string): void {
    const bug = this.bug(rawId);
    bug.hidden = true;
    this.event(bug, 'bug.hidden');
  }

  visible(): PagedBug[] {
    return this.bugs.filter(bug => !bug.deleted && !bug.hidden);
  }

  bug(rawId: string): PagedBug {
    const bug = this.bugs.find(candidate => candidate.rawId === rawId);
    assert.ok(bug, `server bug ${rawId}`);
    return bug;
  }

  since(mark: number, path: string): PagedRequest[] {
    return this.requests.slice(mark).filter(request => request.path === path);
  }

  private comment(text: string): ServerComment {
    this.comments += 1;
    return { id: `pc${this.comments}`, author_id: 'owner@example.test', author_kind: 'person', text, reply_to: null, created_at: new Date().toISOString() };
  }

  private event(bug: PagedBug, kind: string, payload: unknown = {}): void {
    this.journal.push({ cursor: String(this.journal.length + 1), problem_id: problemOf(bug.rawId), kind, payload });
  }

  private header(bug: PagedBug) {
    return {
      key: { source: 'web', owner: 'qa', id: bug.rawId }, problem_id: problemOf(bug.rawId), revision: bug.revision, status: 'open', state: 'triage',
      created_at: '2026-10-22T00:00:00.000Z', claimed_by: null, claim_expires_at: null,
    };
  }

  private detail(bug: PagedBug, commentsCursor: string | null, limit: number) {
    const offset = commentsCursor ? Number(commentsCursor.slice(1)) : 0;
    const attachments = offset === 0 ? bug.attachments.map(attachment => ({
      id: attachment.id, kind: 'image', mime: 'application/octet-stream', bytes: attachment.content.length,
      sha256: createHash('sha256').update(attachment.content).digest('hex'),
    })) : [];
    return {
      ...this.header(bug), comments: bug.comments.slice(offset, offset + limit), attachments,
      nextCommentsCursor: offset + limit < bug.comments.length ? `C${offset + limit}` : null, nextAttachmentsCursor: null,
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `https://127.0.0.1:${this.port}`);
    for await (const _ of request) { }
    const segments = url.pathname.split('/').slice(1).map(segment => decodeURIComponent(segment));
    const path = url.pathname === '/api/bugs/events' || segments.length <= 2 ? url.pathname : `/api/bugs/${segments.slice(2).join('/')}`;
    const record: PagedRequest = { path, cursor: url.searchParams.get('cursor'), commentsCursor: url.searchParams.get('commentsCursor'), status: 0 };
    this.requests.push(record);
    const reply = (status: number, body: unknown, type = 'application/json') => {
      record.status = status;
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': type });
      response.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const claims = verifiedClaims(request, this.secret);
    if (!claims || request.method !== 'GET' || url.searchParams.get('project') !== 'qa' || url.searchParams.get('env') !== 'dev' ||
        !(Array.isArray(claims.grants) && claims.grants.includes('bugs:read'))) return reply(401, { error: 'unauthorized' });
    const verdict = this.intercept?.(record) ?? null;
    if (verdict === 'fail') return reply(503, { error: 'unavailable' });
    if (verdict === 'hang') { this.held.push(response); return; }
    const limit = Number(url.searchParams.get('limit') ?? '50');
    if (url.pathname === '/api/bugs') {
      const offset = record.cursor ? Number(record.cursor.slice(1)) : 0;
      const visible = this.visible();
      return reply(200, {
        bugs: visible.slice(offset, offset + limit).map(bug => this.header(bug)),
        nextCursor: offset + limit < visible.length ? `L${offset + limit}` : null,
      });
    }
    if (url.pathname === '/api/bugs/events') {
      const cursor = Number(record.cursor ?? '0');
      const after = this.journal.filter(event => Number(event.cursor) > cursor);
      const events = after.slice(0, limit);
      return reply(200, { events, cursor: events.at(-1)?.cursor ?? String(cursor), has_more: after.length > events.length });
    }
    const bug = this.visible().find(candidate => problemOf(candidate.rawId) === segments[2]);
    if (!bug) return reply(404, { error: 'not-found' });
    if (segments.length === 3) return reply(200, this.detail(bug, record.commentsCursor, limit));
    const attachment = segments[3] === 'attachments' ? bug.attachments.find(candidate => candidate.id === segments[4]) : undefined;
    if (!attachment) return reply(404, { error: 'attachment-not-found' });
    return reply(200, attachment.content, 'application/octet-stream');
  }
}

function problemOf(rawId: string): string {
  return JSON.stringify(['web', 'qa', rawId]);
}

function verifiedClaims(request: IncomingMessage, secret: string): Record<string, unknown> | null {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || request.headers['x-bugs-contract-version'] !== '2') return null;
  const [head, body, signature] = header.slice(7).split('.');
  if (!head || !body || !signature) return null;
  const key = createHash('sha256').update(`dashboard-bugs:${secret}`).digest();
  const expected = createHmac('sha256', key).update(`${head}.${body}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (claims.aud !== 'dashboard-bugs' || claims.purpose !== 'bugs-api' || claims.contract_version !== 2 || claims.actor !== actor ||
      claims.project !== 'qa' || claims.env !== 'dev' || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

const pagedKey = (rawId: string) => `projects/qa/bug#${rawId}`;

async function showPaged(environment: Environment, rawId: string): Promise<any> {
  const result = await cli(environment, ['bug', 'show', '--bug', pagedKey(rawId)]);
  assert.equal(result.code, 0, `bug show ${rawId} failed: ${result.stderr}`);
  return result.json.bug;
}

async function listed(environment: Environment): Promise<{ bugs: any[]; sync: any }> {
  const bugs: any[] = [];
  let cursor: string | null = null;
  let sync: any;
  do {
    const result = await cli(environment, ['bug', 'list', ...(cursor ? ['--cursor', cursor] : [])]);
    assert.equal(result.code, 0, result.stderr);
    bugs.push(...result.json.bugs);
    sync ??= result.json.sync[0];
    cursor = result.json.nextCursor;
  } while (cursor);
  return { bugs, sync };
}

async function mirrors(environment: Environment, dash: PagedDash, rawIds: readonly string[]): Promise<boolean> {
  for (const rawId of rawIds) {
    const server = dash.bug(rawId);
    const local = await showPaged(environment, rawId);
    if (local.revision !== server.revision || local.presence !== 'present' || !local.detailComplete) return false;
    if (JSON.stringify(local.comments.map((comment: any) => comment.serverId)) !== JSON.stringify(server.comments.map(comment => comment.id))) return false;
    if (JSON.stringify(local.attachments.map((attachment: any) => attachment.serverId)) !== JSON.stringify(server.attachments.map(attachment => attachment.id))) return false;
  }
  return true;
}

test('QA 3.1: paged pull resumes from the saved position after page failures, offline and service restarts; server deletions reach the local copy', { timeout: 600000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-bs31p-'));
  const dash = new PagedDash(directory);
  dash.addBug('201', ['201 first'], true);
  dash.addBug('202', ['202 first', '202 second'], true);
  dash.addBug('203', ['203 c1', '203 c2', '203 c3', '203 c4', '203 c5']);
  dash.addBug('204', []);
  dash.addBug('205', ['205 first']);
  await dash.start();
  const environment = prepare(dash, directory, { pageLimit: 2 });
  const service = new Service(environment, dash);
  const all = ['201', '202', '203', '204', '205'];
  t.after(async () => {
    if (service.child) await service.stop('SIGKILL');
    await dash.close();
    if (!process.env.QA_KEEP) rmSync(directory, { recursive: true, force: true });
  });

  let missedDuringSnapshot: ServerComment | undefined;

  await t.test('snapshot: a failing second list page keeps the first page and the list position; retries do not restart the snapshot', async () => {
    dash.intercept = request => request.path === '/api/bugs' && request.cursor === 'L2' ? 'fail' : null;
    service.start();
    await service.ready();
    const failing = await until('second list page fails repeatedly', async () => {
      const state = await listed(environment);
      return state.sync.listCursor === 'L2' && state.sync.lastErrorCode === 'unavailable' && state.sync.consecutiveFailures >= 2 ? state : null;
    }, service);
    assert.equal(failing.sync.snapshotComplete, false);
    assert.equal(failing.sync.phase, 'snapshot');
    assert.deepEqual(failing.bugs.map(bug => bug.key), [pagedKey('201'), pagedKey('202')]);
    assert.ok(await mirrors(environment, dash, ['201', '202']), 'the stored first page is complete');
    const cursors = dash.since(0, '/api/bugs').map(request => request.cursor);
    assert.equal(cursors[0], null);
    assert.ok(cursors.slice(1).every(cursor => cursor === 'L2'), `retries resume at L2: ${cursors}`);
    assert.deepEqual(dash.since(0, '/api/bugs/events').map(request => request.cursor), ['0', '2', '4'], 'journal head found page by page once');
    missedDuringSnapshot = dash.humanComment('201', 'human comment on an already stored bug during the snapshot');
  });

  await t.test('restart between pages: after SIGTERM and after SIGKILL inside a page the snapshot continues from the stored cursor', async () => {
    assert.equal((await service.stop('SIGTERM')).code, 0, service.log());
    const restart = dash.requests.length;
    dash.intercept = request => request.path === '/api/bugs' && request.cursor === 'L4' ? 'hang' : null;
    service.start();
    await service.ready();
    await until('the service is inside the third list page', async () => dash.since(restart, '/api/bugs').some(request => request.cursor === 'L4'), service);
    assert.deepEqual(dash.since(restart, '/api/bugs').map(request => request.cursor), ['L2', 'L4']);
    assert.equal(dash.since(restart, '/api/bugs/events').length, 0, 'the stored journal head is reused');
    await service.stop('SIGKILL');
    dash.release();
    dash.intercept = null;
    const crashed = await listed(environment);
    assert.equal(crashed.sync.listCursor, 'L4');
    assert.equal(crashed.sync.snapshotComplete, false);
    assert.deepEqual(crashed.bugs.map(bug => bug.key), ['201', '202', '203', '204'].map(pagedKey));
    const resume = dash.requests.length;
    service.start();
    await service.ready();
    await until('snapshot completes and the incremental pull catches up', async () => {
      const state = await listed(environment);
      return state.sync.snapshotComplete && state.sync.phase === 'incremental' && state.sync.journalCursor === String(dash.journal.length) &&
        await mirrors(environment, dash, all);
    }, service);
    assert.deepEqual(dash.since(resume, '/api/bugs').map(request => request.cursor), ['L4']);
    assert.equal(dash.since(resume, '/api/bugs/events')[0]?.cursor, '5', 'incremental starts at the journal head taken before the snapshot');
    const local = await showPaged(environment, '201');
    assert.equal(local.comments.filter((comment: any) => comment.serverId === missedDuringSnapshot!.id).length, 1);
    const pages = dash.requests.filter(request => request.path === `/api/bugs/${problemOf('203')}`).map(request => request.commentsCursor);
    assert.ok(pages.includes('C2') && pages.includes('C4'), `comments of 203 are read page by page: ${pages}`);
    assert.deepEqual((await listed(environment)).bugs.map(bug => bug.key), all.map(pagedKey));
  });

  await t.test('incremental: a failing journal page, an offline server and restarts continue from the stored journal cursor', async () => {
    const start = Number((await listed(environment)).sync.journalCursor);
    assert.equal(start, dash.journal.length);
    dash.intercept = request => request.path === '/api/bugs/events' && request.cursor === String(start + 2) ? 'fail' : null;
    const added = ['202', '203', '204', '205', '201'].map(rawId => ({ rawId, comment: dash.humanComment(rawId, `incremental ${rawId}`) }));
    const halfway = await until('second journal page fails', async () => {
      const state = await listed(environment);
      return state.sync.journalCursor === String(start + 2) && state.sync.lastErrorCode === 'unavailable' ? state : null;
    }, service);
    assert.equal(halfway.sync.phase, 'incremental');
    const has = async (entry: { rawId: string; comment: ServerComment }) =>
      (await showPaged(environment, entry.rawId)).comments.filter((comment: any) => comment.serverId === entry.comment.id).length;
    assert.deepEqual(await Promise.all(added.map(has)), [1, 1, 0, 0, 0], 'only the first journal page is applied');
    assert.equal((await service.stop('SIGTERM')).code, 0, service.log());
    dash.intercept = null;
    dash.goOffline();
    service.start();
    await service.ready();
    await until('pull fails while the server is offline', async () => {
      const state = await listed(environment);
      return state.sync.lastErrorCode === 'network' && state.sync.consecutiveFailures >= 1 ? state : null;
    }, service);
    assert.equal((await service.stop('SIGTERM')).code, 0, service.log());
    const offline = await listed(environment);
    assert.equal(offline.sync.journalCursor, String(start + 2), 'offline keeps the stored journal cursor');
    assert.equal(offline.sync.lastErrorCode, 'network');
    dash.goOnline();
    const resume = dash.requests.length;
    service.start();
    await service.ready();
    await until('pull resumes and catches up', async () => {
      const state = await listed(environment);
      return state.sync.journalCursor === String(dash.journal.length) && state.sync.lastErrorCode === null && await mirrors(environment, dash, all);
    }, service);
    assert.equal(dash.since(resume, '/api/bugs/events')[0]?.cursor, String(start + 2));
    assert.deepEqual(await Promise.all(added.map(has)), [1, 1, 1, 1, 1]);
  });

  await t.test('server deletions: a deleted bug and comment disappear, a hidden bug is marked missing, cached bytes of the deleted bug are removed', async () => {
    const cached = await cli(environment, ['bug', 'attachment', 'get', '--bug', pagedKey('202'), '--attachment', 'a202']);
    assert.equal(cached.code, 0, cached.stderr);
    const cachedPath: string = cached.json.path;
    assert.ok(existsSync(cachedPath), cachedPath);
    const removedComment = dash.bug('203').comments[1];
    dash.deleteBug('202');
    dash.deleteComment('203', removedComment.id);
    dash.hideBug('205');
    await until('deletions reach the local copy', async () => {
      const state = await listed(environment);
      const presence = Object.fromEntries(state.bugs.map(bug => [bug.key, bug.presence]));
      return state.sync.journalCursor === String(dash.journal.length) && !(pagedKey('202') in presence) && presence[pagedKey('205')] === 'missing' &&
        await mirrors(environment, dash, ['201', '203', '204']);
    }, service);
    assert.equal(errorCode(await cli(environment, ['bug', 'show', '--bug', pagedKey('202')])), 'BUG_NOT_FOUND');
    const comments = (await showPaged(environment, '203')).comments.map((comment: any) => comment.serverId);
    assert.ok(!comments.includes(removedComment.id));
    assert.equal((await showPaged(environment, '205')).presence, 'missing');
    const other = await cli(environment, ['bug', 'attachment', 'get', '--bug', pagedKey('201'), '--attachment', 'a201']);
    assert.equal(other.code, 0, other.stderr);
    assert.equal(existsSync(cachedPath), false, 'cached bytes of the deleted bug are removed');
    assert.ok(existsSync(other.json.path));
  });

  await t.test('final state after another restart: no resurrected, duplicated or missing records', async step => {
    assert.equal((await service.stop('SIGTERM')).code, 0, service.log());
    const restart = dash.requests.length;
    service.start();
    await service.ready();
    await until('two more poll cycles pass', async () => dash.since(restart, '/api/bugs/events').length >= 2, service);
    const state = await listed(environment);
    step.diagnostic(JSON.stringify({ serviceStarts: service.starts, journal: dash.journal.length, requests: dash.requests.length }));
    assert.deepEqual(state.bugs.map(bug => [bug.key, bug.presence]), [['201', 'present'], ['203', 'present'], ['204', 'present'], ['205', 'missing']]
      .map(([rawId, presence]) => [pagedKey(rawId), presence]));
    assert.equal(state.sync.journalCursor, String(dash.journal.length));
    assert.ok(await mirrors(environment, dash, ['201', '203', '204']));
    assert.ok(dash.requests.every(request => request.status !== 401), 'every request carried a valid JWT');
    assert.equal((await service.stop('SIGTERM')).code, 0, service.log());
  });
});
