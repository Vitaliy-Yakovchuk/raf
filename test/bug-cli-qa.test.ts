import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCatalog } from '../src/bootstrap.ts';
import { BugServerError, startBugSyncService, type BugMcpTool, type BugSyncService, type MainNotice, type MainNotifier, type ServerAuth } from '../src/bug-sync.ts';
import { ACTOR, FakeBugServer, revisionConflict, serverKey, storageUnavailable } from './bug-sync-fixture.ts';

const rafDevelop = fileURLToPath(new URL('../', import.meta.url));
const realConf = fileURLToPath(new URL('../../conf/', import.meta.url));
const constants = JSON.parse(readFileSync(join(realConf, 'raf-constants.json'), 'utf8'));
const APPROVED = ['bug list', 'bug show', 'bug comment add', 'bug status set', 'bug attachment get'];
const MCP_PATH = '/internal/mcp/bugs';
const ETCHLY = { project: 'etchly', env: 'prod', stand: 'prod', secret: 'DASH_BUGS_PROD_ETCHLY' };
const CRM = { project: 'crm', env: 'dev', stand: 'dev1', secret: 'DASH_BUGS_DEV1_CRM' };
const ETCHLY_KEY = 'projects/etchly/bug#344';
const CRM_KEY = 'projects/crm/bug#344';
const COMMENT = 'QA 3.4: синхронний коментар\nдругий рядок — «лапки», emoji 🐞 і пробіли  в кінці  ';
const ATTACHMENT = Buffer.from('hello attachment');
const REQUEST_TIMEOUT_MS = 1500;
const OWNER = 'owner@example.test';

type McpFault = { readonly kind: 'hang' } | { readonly kind: 'drop-after-apply' } | { readonly kind: 'http'; readonly status: number; readonly body: string };

interface Workspace {
  readonly base: string;
  readonly root: string;
  readonly home: string;
  readonly rafHome: string;
  readonly fetchLog: string;
  readonly preload: string;
  readonly secrets: ReadonlyMap<string, string>;
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
  const develop = join(root, 'raf-develop');
  mkdirSync(develop);
  for (const entry of readdirSync(rafDevelop)) if (entry !== 'dist') symlinkSync(join(rafDevelop, entry), join(develop, entry));
  buildCatalog(realConf, join(develop, 'dist', 'catalog.json'), constants.commands.map((command: { path: string[] }) => command.path.join(' ')));
  const settings = JSON.parse(readFileSync(join(realConf, 'raf.json'), 'utf8'));
  settings.bugs = { ...settings.bugs, attachmentCacheMaxBytes: 1_000_000, requestTimeoutMs: REQUEST_TIMEOUT_MS, sections: [ETCHLY, CRM] };
  writeFileSync(join(root, 'conf', 'raf.json'), JSON.stringify(settings, null, 2));
  const secrets = [ETCHLY, CRM].map(section => ({
    name: section.secret, kind: 'env', value: `qa34-${section.secret}-${'x'.repeat(40)}`, source: 'qa34', updatedAt: '2026-10-22T00:00:00.000Z',
  }));
  writeFileSync(join(rafHome, 'secrets.json'), JSON.stringify({ version: 1, records: secrets }), { mode: 0o600 });
  const secretValues = new Map(secrets.map(record => [record.name, record.value]));
  chmodSync(join(rafHome, 'secrets.json'), 0o600);
  const fetchLog = join(base, 'fetch.log');
  writeFileSync(fetchLog, '');
  const preload = join(base, 'offline.mjs');
  writeFileSync(preload, [
    "import { appendFileSync } from 'node:fs';",
    'const realFetch = globalThis.fetch;',
    'globalThis.fetch = async (input, init) => {',
    '  const url = String(input && input.url ? input.url : input);',
    '  appendFileSync(process.env.QA_FETCH_LOG, url + "\\n");',
    `  if (process.env.QA_MCP_URL && new URL(url).pathname === '${MCP_PATH}') return realFetch(process.env.QA_MCP_URL, init);`,
    "  throw new TypeError('fetch failed: network disabled by qa34');",
    '};',
  ].join('\n'));
  return { base, root, home, rafHome, fetchLog, preload, secrets: secretValues };
}

function cliArgs(ws: Workspace, argv: readonly string[]): string[] {
  return ['--preserve-symlinks', '--preserve-symlinks-main', '--import', ws.preload, join(ws.root, 'raf-develop', 'bin', 'raf.ts'), ...argv];
}

function cli(ws: Workspace, argv: readonly string[], input?: string, timeout = 60_000): CliResult {
  const result = spawnSync(process.execPath, cliArgs(ws, argv), { env: { ...process.env, HOME: ws.home, QA_FETCH_LOG: ws.fetchLog }, input: input ?? '', encoding: 'utf8', timeout });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function cliWithDash(ws: Workspace, dash: McpDash, argv: readonly string[], input?: string): Promise<CliResult> {
  const child = spawn(process.execPath, cliArgs(ws, argv), {
    env: { ...process.env, HOME: ws.home, QA_FETCH_LOG: ws.fetchLog, QA_MCP_URL: dash.url }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (input !== undefined) child.stdin!.end(input);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(done => child.on('close', value => done(value)));
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

class McpDash {
  readonly requests: { tool: string; contractVersion: string | undefined; protocolVersion: string | undefined; scope: unknown }[] = [];
  url = '';
  private readonly http: Server;
  private readonly server: FakeBugServer;
  private readonly secrets: ReadonlyMap<string, string>;

  constructor(server: FakeBugServer, secrets: ReadonlyMap<string, string>) {
    this.server = server;
    this.secrets = secrets;
    this.http = createServer((request, response) => { void this.handle(request, response); });
  }

  async start(): Promise<void> {
    await new Promise<void>(done => this.http.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.http.address() as { port: number }).port}${MCP_PATH}`;
  }

  async stop(): Promise<void> {
    this.http.closeAllConnections();
    await new Promise<void>(done => this.http.close(() => done()));
  }

  tools(): string[] {
    return this.requests.map(request => request.tool);
  }

  private readonly faults: { tool: string; fault: McpFault }[] = [];

  fault(tool: BugMcpTool, fault: McpFault): void {
    this.faults.push({ tool, fault });
  }

  private verified(header: string): Record<string, unknown> | null {
    const [head, body, signature] = header.replace(/^Bearer /, '').split('.');
    if (!head || !body || !signature) return null;
    const given = Buffer.from(signature, 'base64url');
    for (const secret of this.secrets.values()) {
      const key = createHash('sha256').update(`dashboard-bugs:${secret}`).digest();
      const expected = createHmac('sha256', key).update(`${head}.${body}`).digest();
      if (given.length === expected.length && timingSafeEqual(given, expected)) return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    }
    return null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const claims = this.verified(request.headers.authorization ?? '');
    const tool = rpc.params?.name as BugMcpTool;
    this.requests.push({
      tool, contractVersion: request.headers['x-bugs-contract-version'] as string | undefined,
      protocolVersion: request.headers['mcp-protocol-version'] as string | undefined, scope: claims?.scope,
    });
    const reply = (result: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    };
    if (!claims || claims.actor !== ACTOR || request.method !== 'POST' || rpc.method !== 'tools/call') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthenticated' }));
      return;
    }
    const auth: ServerAuth = { origin: 'qa34', project: String(claims.project), env: String(claims.env), token: `qa34|${String(claims.scope)}|mcp`, timeoutMs: 0 };
    const index = this.faults.findIndex(item => item.tool === tool);
    const fault = index >= 0 ? this.faults.splice(index, 1)[0]!.fault : null;
    if (fault?.kind === 'http') {
      response.writeHead(fault.status, { 'content-type': 'application/json' });
      response.end(fault.body);
      return;
    }
    if (fault?.kind === 'hang') {
      await new Promise(done => setTimeout(done, REQUEST_TIMEOUT_MS * 3));
      if (!response.destroyed) response.destroy();
      return;
    }
    try {
      const answer = await this.server.mcp.call(auth, tool, rpc.params.arguments ?? {});
      if (fault?.kind === 'drop-after-apply') {
        response.socket?.destroy();
        return;
      }
      reply({ content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer });
    } catch (error) {
      if (!(error instanceof BugServerError)) throw error;
      const retryAfter = error.retryAfterMs === null ? {} : { retry_after: error.retryAfterMs / 1000 };
      reply({ isError: true, content: [{ type: 'text', text: error.code }], structuredContent: { error: error.code, status: error.status, ...retryAfter } });
    }
  }
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

function assertNotOnDisk(ws: Workspace, needle: string): void {
  for (const entry of readdirSync(ws.rafHome, { recursive: true })) {
    const file = join(ws.rafHome, String(entry));
    try { assert.ok(!readFileSync(file).includes(needle), `${needle} leaked into ${file}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error; }
  }
}

const TOKEN_TEXT = /claim[-_]?token/i;

class MainInbox {
  readonly notices: MainNotice[] = [];
  readonly notifier: MainNotifier = { notify: async notice => { this.notices.push(notice); } };
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
  const server = new FakeBugServer();
  const dash = new McpDash(server, ws.secrets);
  await dash.start();
  t.after(async () => {
    await dash.stop();
    rmSync(ws.base, { recursive: true, force: true });
  });
  const inbox = new MainInbox();

  await t.test('catalog holds exactly the five approved bug commands and help is detailed', () => {
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
      assert.doesNotMatch(JSON.stringify(command.metadata), /outbox|pending|асинхронно/);
    }
    assert.match(ok(cli(ws, ['bug', 'comment', 'add', '--help'])).commands[0].metadata.output, /серверним comment_id/);
    assert.match(ok(cli(ws, ['bug', 'status', 'set', '--help'])).commands[0].metadata.sideEffects, /set_problem_status/);
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

  await t.test('without network comment add and status set fail as BUG_WRITE_UNKNOWN after one MCP request each, change nothing and start no service', () => {
    const textFile = join(ws.base, 'offline.txt');
    writeFileSync(textFile, 'офлайн коментар');
    const before = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    const comment = failed(cli(ws, ['bug', 'comment', 'add', '--bug', ETCHLY_KEY, '--text-file', textFile]), 'BUG_WRITE_UNKNOWN', 'bug comment add');
    const status = failed(cli(ws, ['bug', 'status', 'set', '--bug', ETCHLY_KEY, '--status', 'closed']), 'BUG_WRITE_UNKNOWN', 'bug status set');
    for (const error of [comment, status]) assert.doesNotMatch(JSON.stringify(error), /token/i);
    const requests = fetches(ws);
    assert.equal(requests.length, 2, 'one read_bug attempt per command, no retries and no mutation');
    assert.ok(requests.every(url => new URL(url).pathname === MCP_PATH), requests.join('\n'));
    assert.deepEqual(ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY])), before);
    assert.equal(server.mutations, 0);
    assertNoService(ws);
  });

  let commentId = '';
  await t.test('comment add and status set reach the MCP fake with the service stopped and are visible locally at once', async () => {
    const callsBefore = server.calls.length;
    const fetchedBefore = fetches(ws).length;
    const textFile = join(ws.base, 'comment.txt');
    writeFileSync(textFile, COMMENT);
    const written = ok(await cliWithDash(ws, dash, ['bug', 'comment', 'add', '--bug', ETCHLY_KEY, '--text-file', textFile]));
    const etchly = server.state(serverKey(ETCHLY, '344'));
    assert.equal(written.bugKey, ETCHLY_KEY);
    assert.equal(written.revision, etchly.revision);
    commentId = written.commentId;
    assert.equal(server.serverComments(serverKey(ETCHLY, '344')).at(-1)!.id, commentId);
    assert.equal(written.comment.serverId, commentId);
    assert.equal(written.comment.text, COMMENT);
    for (const field of ['accepted', 'delivered', 'delivery', 'state', 'notice']) assert.equal(written[field], undefined, field);
    const shown = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    assert.equal(shown.bug.revision, etchly.revision);
    assert.equal(shown.bug.comments.find((comment: { serverId: string }) => comment.serverId === commentId)?.text, COMMENT);
    assert.equal(shown.bug.comments.filter((comment: { text: string }) => comment.text === COMMENT).length, 1);

    const status = ok(await cliWithDash(ws, dash, ['bug', 'status', 'set', '--bug', CRM_KEY, '--status', 'awaiting_verification']));
    const crm = server.state(serverKey(CRM, '344'));
    assert.equal(crm.status, 'awaiting_verification');
    assert.equal(status.status, 'awaiting_verification');
    assert.equal(status.revision, crm.revision);
    const crmShown = ok(cli(ws, ['bug', 'show', '--bug', CRM_KEY]));
    assert.equal(crmShown.bug.status, 'awaiting_verification');
    assert.equal(crmShown.bug.revision, crm.revision);

    assert.deepEqual(dash.tools(), ['read_bug', 'comment_problem', 'read_bug', 'set_problem_status']);
    assert.deepEqual(dash.requests.map(request => request.scope), ['read', 'write', 'read', 'write']);
    assert.ok(dash.requests.every(request => request.contractVersion === '2' && request.protocolVersion === '2025-11-25'));
    const operations = server.mcpCalls.filter(call => call.tool !== 'read_bug').map(call => call.args.operation_id);
    assert.equal(new Set(operations).size, 2);
    assert.ok(fetches(ws).slice(fetchedBefore).every(url => new URL(url).pathname === MCP_PATH));
    assert.equal(server.calls.length, callsBefore, 'a write command does not pull');
    assertNoService(ws);
  });

  await t.test('a server refusal is a command error and leaves the local base untouched', async () => {
    const before = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    const mutations = server.mutations;
    server.failNextMcp('comment_problem', revisionConflict());
    const textFile = join(ws.base, 'refused.txt');
    writeFileSync(textFile, 'відхилений коментар');
    const refused = failed(await cliWithDash(ws, dash, ['bug', 'comment', 'add', '--bug', ETCHLY_KEY, '--text-file', textFile]), 'BUG_WRITE_REJECTED', 'bug comment add');
    assert.equal(refused.details.sourceCode, 'revision-conflict');
    const invalid = failed(await cliWithDash(ws, dash, ['bug', 'status', 'set', '--bug', ETCHLY_KEY, '--status', 'no_such_status']), 'BUG_WRITE_REJECTED', 'bug status set');
    assert.equal(invalid.details.sourceCode, 'invalid-input');
    assert.equal(server.mutations, mutations);
    assert.deepEqual(ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY])), before);
    assertNoService(ws);
  });

  await t.test('the next pull converges with the server without duplicating the synchronous comment', async () => {
    server.addComment(serverKey(ETCHLY, '344'), 'owner@example.test', 'reply after the write');
    const mcpCalls = server.mcpCalls.length;
    await serviceCycle(ws, server, inbox);
    const shown = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    const etchly = server.state(serverKey(ETCHLY, '344'));
    assert.equal(shown.bug.revision, etchly.revision);
    assert.deepEqual(shown.bug.comments.map((comment: { serverId: string }) => comment.serverId).sort(), server.serverComments(serverKey(ETCHLY, '344')).map(comment => comment.id).sort());
    assert.equal(shown.bug.comments.filter((comment: { serverId: string }) => comment.serverId === commentId).length, 1);
    assert.equal(ok(cli(ws, ['bug', 'show', '--bug', CRM_KEY])).bug.status, 'awaiting_verification');
    assert.equal(server.mcpCalls.length, mcpCalls, 'the service never calls MCP');
    assert.equal(server.callsOf('comment').length, 0);
    assertNoService(ws);
  });

  await t.test('impossible or unimplemented operations fail with a JSON error, never a success payload', () => {
    const fetchedBefore = fetches(ws).length;
    const textFile = join(ws.base, 'comment2.txt');
    writeFileSync(textFile, 'ще один');
    failed(cli(ws, ['bug', 'comment', 'add', '--bug', 'projects/etchly/bug#999', '--text-file', textFile]), 'BUG_NOT_FOUND', 'bug comment add');
    failed(cli(ws, ['bug', 'status', 'set', '--bug', 'projects/etchly/bug#999', '--status', 'closed']), 'BUG_NOT_FOUND', 'bug status set');
    failed(cli(ws, ['bug', 'status', 'set', '--bug', ETCHLY_KEY]), 'MISSING_REQUIRED', 'bug status set');
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
    assert.deepEqual(fetches(ws).slice(fetchedBefore), [], 'refused before any network request');
    assertNoService(ws);
  });

  await t.test('own claim through status set in_progress: the claim token reaches Dash but is never printed or stored', async () => {
    server.now = () => Date.now();
    const crmKey = serverKey(CRM, '344');
    const claimed = await cliWithDash(ws, dash, ['bug', 'status', 'set', '--bug', CRM_KEY, '--status', 'in_progress']);
    assert.equal(ok(claimed).status, 'in_progress');
    const token = server.state(crmKey).claimToken;
    assert.equal(server.state(crmKey).claimedBy, ACTOR);
    assert.ok(token);
    assert.doesNotMatch(claimed.stdout, TOKEN_TEXT);
    const shown = cli(ws, ['bug', 'show', '--bug', CRM_KEY]);
    assert.equal(ok(shown).bug.status, 'in_progress');
    assert.doesNotMatch(shown.stdout, TOKEN_TEXT);

    const text = 'коментар під власною орендою через stdin';
    const commented = await cliWithDash(ws, dash, ['bug', 'comment', 'add', '--bug', CRM_KEY, '--text-file', '-'], text);
    const written = ok(commented);
    assert.equal(written.comment.text, text);
    assert.equal(server.mcpCallsOf('comment_problem').at(-1)!.args.claimToken, token, 'own lease token is sent with the write');
    assert.doesNotMatch(commented.stdout, TOKEN_TEXT);
    assert.equal(ok(cli(ws, ['bug', 'show', '--bug', CRM_KEY])).bug.comments.filter((comment: { serverId: string }) => comment.serverId === written.commentId).length, 1);

    const released = await cliWithDash(ws, dash, ['bug', 'status', 'set', '--bug', CRM_KEY, '--status', 'awaiting_verification']);
    assert.equal(ok(released).status, 'awaiting_verification');
    assert.equal(server.mcpCallsOf('set_problem_status').at(-1)!.args.claimToken, token);
    assert.equal(server.state(crmKey).claimedBy, null);
    assert.equal(ok(cli(ws, ['bug', 'show', '--bug', CRM_KEY])).bug.revision, server.state(crmKey).revision);
    assertNotOnDisk(ws, token);
    assertNoService(ws);
  });

  await t.test('foreign claim: a comment replies to the claim owner, impossible writes are refused without local changes', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const held = server.seedBug(ETCHLY, {
      rawId: '346', claimedBy: OWNER, claimExpiresAt: future,
      comments: [{ authorId: OWNER, text: 'я над цим працюю' }, { authorId: 'someone@example.test', text: 'інша думка' }],
    });
    server.seedBug(ETCHLY, { rawId: '347', claimedBy: 'other@example.test', claimExpiresAt: future, comments: [{ authorId: 'someone@example.test', text: 'не власник оренди' }] });
    await serviceCycle(ws, server, inbox);
    const heldKey = 'projects/etchly/bug#346';
    const orphanKey = 'projects/etchly/bug#347';
    const ownerComment = server.serverComments(held).find(comment => comment.authorId === OWNER)!;

    const reply = ok(await cliWithDash(ws, dash, ['bug', 'comment', 'add', '--bug', heldKey, '--text-file', '-'], 'відповідь власнику оренди'));
    const sent = server.mcpCallsOf('comment_problem').at(-1)!.args;
    assert.equal(sent.reply_to, ownerComment.id);
    assert.equal(sent.claimToken, undefined, 'no token for a foreign lease');
    assert.equal(reply.comment.replyTo, ownerComment.id);
    assert.equal(ok(cli(ws, ['bug', 'show', '--bug', heldKey])).bug.comments.filter((comment: { serverId: string }) => comment.serverId === reply.commentId).length, 1);

    const mutations = server.mutations;
    const beforeHeld = ok(cli(ws, ['bug', 'show', '--bug', heldKey]));
    const beforeOrphan = ok(cli(ws, ['bug', 'show', '--bug', orphanKey]));
    const status = failed(await cliWithDash(ws, dash, ['bug', 'status', 'set', '--bug', heldKey, '--status', 'closed']), 'BUG_WRITE_REJECTED', 'bug status set');
    assert.equal(status.details.sourceCode, 'lease-required');
    assert.match(status.remediation[0], /оренд/);
    const orphan = failed(await cliWithDash(ws, dash, ['bug', 'comment', 'add', '--bug', orphanKey, '--text-file', '-'], 'нема кому відповісти'), 'BUG_WRITE_REPLY_TARGET_MISSING', 'bug comment add');
    assert.equal(orphan.details.found.localChanges, false);
    assert.equal(server.mutations, mutations);
    assert.deepEqual(server.mcpCalls.slice(-2).map(call => call.tool), ['set_problem_status', 'read_bug'], 'no mutation without a reply target');
    assert.deepEqual(ok(cli(ws, ['bug', 'show', '--bug', heldKey])), beforeHeld);
    assert.deepEqual(ok(cli(ws, ['bug', 'show', '--bug', orphanKey])), beforeOrphan);
    assertNoService(ws);
  });

  await t.test('slow, failing or malformed Dash MCP: command error without local changes; a write Dash applied arrives only by pull', async () => {
    const etchlyKey = serverKey(ETCHLY, '344');
    const before = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    const mutations = server.mutations;

    dash.fault('read_bug', { kind: 'hang' });
    const started = Date.now();
    const slow = failed(await cliWithDash(ws, dash, ['bug', 'status', 'set', '--bug', ETCHLY_KEY, '--status', 'closed']), 'BUG_WRITE_UNKNOWN', 'bug status set');
    const elapsed = Date.now() - started;
    assert.equal(slow.details.sourceCode, 'timeout');
    assert.ok(elapsed >= REQUEST_TIMEOUT_MS && elapsed < REQUEST_TIMEOUT_MS * 3, `timeout from conf requestTimeoutMs: ${elapsed} ms`);

    dash.fault('read_bug', { kind: 'http', status: 503, body: '' });
    const gateway = failed(await cliWithDash(ws, dash, ['bug', 'comment', 'add', '--bug', ETCHLY_KEY, '--text-file', '-'], 'шлюз недоступний'), 'BUG_WRITE_UNKNOWN', 'bug comment add');
    assert.equal(gateway.details.sourceCode, 'http-503');

    dash.fault('read_bug', { kind: 'http', status: 401, body: JSON.stringify({ error: 'unauthenticated' }) });
    const denied = failed(await cliWithDash(ws, dash, ['bug', 'status', 'set', '--bug', ETCHLY_KEY, '--status', 'closed']), 'BUG_WRITE_REJECTED', 'bug status set');
    assert.equal(denied.details.sourceCode, 'unauthenticated');
    assert.equal(denied.details.found.status, 401);

    server.failNextMcp('comment_problem', storageUnavailable());
    const busy = failed(await cliWithDash(ws, dash, ['bug', 'comment', 'add', '--bug', ETCHLY_KEY, '--text-file', '-'], 'сховище зайняте'), 'BUG_WRITE_REJECTED', 'bug comment add');
    assert.equal(busy.details.sourceCode, 'bug-storage-unavailable');
    assert.equal(busy.details.found.retryAfterMs, 5000);
    assert.equal(server.mutations, mutations);
    assert.deepEqual(ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY])), before);

    const lostText = 'Dash застосував, але відповідь обірвалась';
    dash.fault('comment_problem', { kind: 'drop-after-apply' });
    const lost = failed(await cliWithDash(ws, dash, ['bug', 'comment', 'add', '--bug', ETCHLY_KEY, '--text-file', '-'], lostText), 'BUG_WRITE_UNKNOWN', 'bug comment add');
    assert.equal(lost.details.retrySafe, false, 'unknown outcome is not marked safe to retry');
    server.rewriteNextMcpResult('set_problem_status', result => ({ ...result, operation_id: 'someone-else' }));
    failed(await cliWithDash(ws, dash, ['bug', 'status', 'set', '--bug', ETCHLY_KEY, '--status', 'closed']), 'BUG_WRITE_INVALID_RESPONSE', 'bug status set');
    assert.equal(server.mutations, mutations + 2, 'Dash applied both writes');
    assert.deepEqual(ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY])), before, 'nothing is written locally without a valid receipt');

    await serviceCycle(ws, server, inbox);
    const after = ok(cli(ws, ['bug', 'show', '--bug', ETCHLY_KEY]));
    assert.equal(after.bug.revision, server.state(etchlyKey).revision);
    assert.equal(after.bug.status, 'closed');
    assert.equal(after.bug.comments.filter((comment: { text: string }) => comment.text === lostText).length, 1);
    assertNoService(ws);
  });

  await t.test('attachment get without network fails explicitly without a fake local path', async st => {
    server.seedBug(ETCHLY, {
      rawId: '345', attachments: [{ id: 'att-2', bytes: ATTACHMENT.length, sha256: createHash('sha256').update(ATTACHMENT).digest('hex') }],
    });
    await serviceCycle(ws, server, inbox);
    const before = fetches(ws).length;
    const started = Date.now();
    const error = failed(cli(ws, ['bug', 'attachment', 'get', '--bug', 'projects/etchly/bug#345', '--attachment', 'att-2'], undefined, 180_000), 'ATTACHMENT_FETCH_FAILED', 'bug attachment get');
    const elapsedMs = Date.now() - started;
    assert.ok(!JSON.stringify(error).includes(join(ws.rafHome, 'attachments', '')), 'no local path in the failure');
    const requests = fetches(ws).slice(before);
    const retry = JSON.parse(readFileSync(join(ws.root, 'conf', 'raf.json'), 'utf8')).bugs.retry;
    let limit = 1;
    let backoffMs = 0;
    for (let next = retry.initialDelayMs; next < retry.maxDelayMs; next *= retry.multiplier) { limit += 1; backoffMs += next; }
    assert.equal(requests.length, limit, 'bounded retries from conf retry');
    assert.ok(requests.every(url => url.includes('/attachments/att-2?')));
    assert.ok(elapsedMs >= backoffMs && elapsedMs < backoffMs + 30_000, `failure after bounded backoff: ${elapsedMs} ms`);
    st.diagnostic(`attachment get offline: ${requests.length} requests, ${elapsedMs} ms before ATTACHMENT_FETCH_FAILED`);
    const shown = ok(cli(ws, ['bug', 'show', '--bug', 'projects/etchly/bug#345']));
    assert.equal(shown.bug.attachments[0].cacheState, 'absent');
    const files = existsSync(join(ws.rafHome, 'attachments')) ? readdirSync(join(ws.rafHome, 'attachments'), { recursive: true }) : [];
    assert.deepEqual(files.filter(name => !String(name).startsWith('.')), []);
    failed(cli(ws, ['bug', 'attachment', 'get', '--bug', 'projects/etchly/bug#345', '--attachment', 'nope']), 'ATTACHMENT_NOT_FOUND', 'bug attachment get');
    assertNoService(ws);
  });
});
