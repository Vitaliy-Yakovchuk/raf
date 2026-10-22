import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  createAttachmentCache,
  loadAttachmentCacheSettings,
  type AttachmentCache,
  type AttachmentDownloader,
  type AttachmentDownloadRequest,
  type AttachmentRef,
} from '../src/bug-attachment-cache.ts';
import { openBugStore, type BugSectionView } from '../src/bug-store.ts';
import { ClaimsError, type BugSyncConfig, type ClaimsIssuer, type ClaimsScope, type IssuedClaims } from '../src/bug-sync.ts';

export const sectionId = 'dash-prod-raf';
export const sectionSecret = 'DASH_BUGS_PROD_RAF';
export const testRetry = { initialDelayMs: 10, multiplier: 2, maxDelayMs: 40 } as const;
export const defaultRequestTimeoutMs = 2000;


export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function bytesOf(size: number, seed: number): Buffer {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 31 + seed * 17) % 251;
  return buffer;
}

export function openBugsDatabase(path: string): DatabaseSync {
  return openBugStore(path).database;
}

export interface CacheWorkspace {
  readonly root: string;
  readonly rafHome: string;
  readonly confDir: string;
  readonly cacheDirectory: string;
  readonly databasePath: string;
  readonly database: DatabaseSync;
  readonly connections: DatabaseSync[];
  readonly claims: FakeClaims;
  readonly sleeps: number[];
  connect(): DatabaseSync;
  writeBudget(maxBytes: number): void;
  writeConf(change: ConfChange): void;
  config(): BugSyncConfig;
  close(): void;
}

export interface ConfChange {
  readonly maxBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly sections?: readonly { readonly project: string; readonly env: string; readonly stand: string; readonly secret: string }[];
}

interface TestBugsConf {
  readonly fileName: string;
  readonly attachmentsDirectory: string;
  readonly attachmentCacheMaxBytes: number;
  readonly origin: string;
  readonly actor: string;
  readonly tokenLifetimeSeconds: number;
  readonly pollIntervalMs: number;
  readonly pageLimit: number;
  readonly requestTimeoutMs: number;
  readonly retry: typeof testRetry;
  readonly sections: NonNullable<ConfChange['sections']>;
}

export function createWorkspace(maxBytes: number): CacheWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'raf-bug-cache-'));
  const rafHome = join(root, 'home', '.raf');
  const confDir = join(root, 'conf');
  mkdirSync(rafHome, { recursive: true });
  mkdirSync(confDir, { recursive: true });
  const databasePath = join(rafHome, 'bugs.sqlite');
  const database = openBugsDatabase(databasePath);
  const connections = [database];
  let conf: TestBugsConf = {
    fileName: 'bugs.sqlite',
    attachmentsDirectory: 'attachments',
    attachmentCacheMaxBytes: maxBytes,
    origin: 'https://dash.invalid',
    actor: 'raf:bugs',
    tokenLifetimeSeconds: 600,
    pollIntervalMs: 60_000,
    pageLimit: 50,
    requestTimeoutMs: defaultRequestTimeoutMs,
    retry: testRetry,
    sections: [{ project: 'raf', env: 'prod', stand: 'prod', secret: sectionSecret }],
  };
  const writeConf = (change: ConfChange) => {
    conf = {
      ...conf,
      attachmentCacheMaxBytes: change.maxBytes ?? conf.attachmentCacheMaxBytes,
      requestTimeoutMs: change.requestTimeoutMs ?? conf.requestTimeoutMs,
      sections: change.sections ?? conf.sections,
    };
    writeFileSync(join(confDir, 'raf.json'), JSON.stringify({ bugs: conf }));
  };
  const workspace: CacheWorkspace = {
    root,
    rafHome,
    confDir,
    cacheDirectory: join(rafHome, 'attachments'),
    databasePath,
    database,
    connections,
    claims: new FakeClaims(),
    sleeps: [],
    connect() {
      const connection = openBugsDatabase(databasePath);
      connections.push(connection);
      return connection;
    },
    writeBudget(budget: number) {
      writeConf({ maxBytes: budget });
    },
    writeConf,
    config() {
      const { fileName, origin, actor, sections, tokenLifetimeSeconds, pollIntervalMs, pageLimit, requestTimeoutMs, retry } = conf;
      return { fileName, origin, actor, sections, tokenLifetimeSeconds, pollIntervalMs, pageLimit, requestTimeoutMs, retry };
    },
    close() {
      for (const connection of connections) {
        try { connection.close(); } catch { }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  writeConf({});
  return workspace;
}

export function testClock(startMs = Date.UTC(2026, 9, 22, 8, 0, 0)) {
  let current = startMs;
  return {
    now: () => new Date(current),
    ms: () => current,
    advance(stepMs = 60_000) {
      current += stepMs;
      return current;
    },
  };
}

export type TestClock = ReturnType<typeof testClock>;

export function openCache(
  workspace: CacheWorkspace,
  downloads: FakeDownloads,
  clock: TestClock,
  database: DatabaseSync = workspace.database,
): AttachmentCache {
  const settings = loadAttachmentCacheSettings(workspace.confDir, workspace.rafHome);
  return createAttachmentCache({
    database,
    settings,
    config: workspace.config(),
    claims: workspace.claims,
    download: downloads.download,
    now: clock.now,
    sleep: async (ms: number) => {
      workspace.sleeps.push(ms);
    },
  });
}

export function seedBug(database: DatabaseSync, rawId = 'bug-1'): number {
  database.prepare(`INSERT OR IGNORE INTO sections (section_id, project, env, stand, canonical_project, origin, actor, claims_fingerprint)
    VALUES (?, 'raf', 'prod', 'prod', 'raf', 'https://dash.invalid', 'raf-system', 'claims-1')`).run(sectionId);
  const result = database.prepare(`INSERT INTO bugs (section_id, project, env, source, owner, raw_id, problem_id, canonical_project, revision, status, state, payload, presence)
    VALUES (?, 'raf', 'prod', 'dash', 'owner', ?, ?, 'raf', 1, 'open', 'new', '{}', 'present')`).run(sectionId, rawId, `problem-${rawId}`);
  return Number(result.lastInsertRowid);
}

export function seedComment(database: DatabaseSync, bugPk: number, text: string): number {
  const result = database.prepare(`INSERT INTO comments (bug_pk, server_id, origin, author_id, author_kind, text, created_at, payload)
    VALUES (?, ?, 'server', 'raf-system', 'agent', ?, '2026-10-22T08:00:00.000Z', '{}')`)
    .run(bugPk, `c-${text}`, text);
  return Number(result.lastInsertRowid);
}

export interface SeedOptions {
  readonly commentPk?: number | null;
  readonly presence?: 'present' | 'deleted' | 'missing';
  readonly kind?: string;
  readonly mime?: string;
}

export function seedAttachment(database: DatabaseSync, bugPk: number, serverId: string, body: Uint8Array, options: SeedOptions = {}): AttachmentRef {
  database.prepare(`INSERT INTO attachments (bug_pk, comment_pk, server_id, kind, mime, bytes, sha256, presence, cache_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'absent')`)
    .run(bugPk, options.commentPk ?? null, serverId, options.kind ?? 'file', options.mime ?? 'application/octet-stream', body.length, sha256(body), options.presence ?? 'present');
  return { bugPk, serverId };
}

export interface AttachmentRow {
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
  readonly last_read_at: unknown;
  readonly fetch_owner: string | null;
}

export function attachmentRow(database: DatabaseSync, ref: AttachmentRef): AttachmentRow | undefined {
  return database.prepare('SELECT * FROM attachments WHERE bug_pk = ? AND server_id = ?').get(ref.bugPk, ref.serverId) as AttachmentRow | undefined;
}

export function readAtMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const numeric = Number(value);
    return Number.isFinite(numeric) && /^\d+$/.test(value) ? numeric : Date.parse(value);
  }
  return Number.NaN;
}

export function resolveCacheFile(workspace: CacheWorkspace, cacheFile: string): string {
  return isAbsolute(cacheFile) ? cacheFile : join(workspace.cacheDirectory, cacheFile);
}

export function isInside(directory: string, path: string): boolean {
  const relation = relative(directory, path);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

export function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files.sort();
}

export function readyRows(database: DatabaseSync): AttachmentRow[] {
  return database.prepare("SELECT * FROM attachments WHERE cache_state = 'ready' ORDER BY attachment_pk").all() as unknown as AttachmentRow[];
}

export function indexProblems(workspace: CacheWorkspace): string[] {
  const problems: string[] = [];
  const rows = workspace.database.prepare('SELECT * FROM attachments ORDER BY attachment_pk').all() as unknown as AttachmentRow[];
  const referenced = new Set<string>();
  for (const row of rows) {
    const label = `${row.bug_pk}/${row.server_id}`;
    if (row.cache_state === 'fetching') problems.push(`${label}: fetching після завершення операцій`);
    if (row.cache_state === 'absent' && row.cache_file !== null) problems.push(`${label}: absent із cache_file`);
    if (row.cache_state !== 'ready') continue;
    if (row.cache_file === null) {
      problems.push(`${label}: ready без cache_file`);
      continue;
    }
    const path = resolveCacheFile(workspace, row.cache_file);
    referenced.add(path);
    if (!isInside(workspace.cacheDirectory, path)) problems.push(`${label}: файл поза кешем`);
    if (!existsSync(path)) problems.push(`${label}: ready без файла`);
    else if (statSync(path).size !== row.bytes) problems.push(`${label}: розмір файла не збігається`);
    if (row.cache_bytes !== row.bytes) problems.push(`${label}: cache_bytes не збігається`);
    if (row.cache_sha256 !== row.sha256) problems.push(`${label}: cache_sha256 не збігається`);
  }
  for (const file of filesUnder(workspace.cacheDirectory)) {
    if (!referenced.has(file)) problems.push(`${relative(workspace.cacheDirectory, file)}: файл без ready-запису`);
  }
  return problems;
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export class FakeClaims implements ClaimsIssuer {
  readonly issued: { readonly sectionId: string; readonly scope: ClaimsScope }[] = [];
  private readonly missing = new Set<string>();

  removeSecret(sectionKey: string): void {
    this.missing.add(sectionKey);
  }

  restoreSecret(sectionKey: string): void {
    this.missing.delete(sectionKey);
  }

  tokenFor(section: Pick<BugSectionView, 'sectionId'>, scope: ClaimsScope): string {
    return `token:${section.sectionId}:${scope}`;
  }

  fingerprint(section: BugSectionView, scope: ClaimsScope): string {
    return `fingerprint:${section.sectionId}:${scope}`;
  }

  async issue(section: BugSectionView, scope: ClaimsScope): Promise<IssuedClaims> {
    if (this.missing.has(section.sectionId)) throw new ClaimsError('secret-missing', section.sectionId, `Немає секрету розділу ${section.sectionId}.`);
    this.issued.push({ sectionId: section.sectionId, scope });
    return { token: this.tokenFor(section, scope), fingerprint: this.fingerprint(section, scope), expiresAt: '2026-10-22T09:00:00.000Z' };
  }
}

export function expectedDelays(count: number, retry: typeof testRetry = testRetry): number[] {
  const delays: number[] = [];
  let delay: number = retry.initialDelayMs;
  for (let index = 0; index < count; index += 1) {
    delays.push(delay);
    delay = Math.min(delay * retry.multiplier, retry.maxDelayMs);
  }
  return delays;
}

export interface PlannedResponse {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly hang?: boolean;
  readonly body?: Uint8Array;
  readonly failAfterBytes?: number;
  readonly gate?: Promise<void>;
  readonly started?: () => void;
}

const chunkSize = 7;

async function* streamOf(body: Uint8Array, response: PlannedResponse): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    if (response.failAfterBytes !== undefined && offset >= response.failAfterBytes) throw new Error('connection reset by fake server');
    yield body.subarray(offset, offset + chunkSize);
    if (offset === 0 && response.gate) await response.gate;
  }
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fallback = setTimeout(() => reject(new Error('fake download was never aborted')), 3 * defaultRequestTimeoutMs);
    fallback.unref();
    signal.addEventListener('abort', () => {
      clearTimeout(fallback);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

export class FakeDownloads {
  readonly calls: AttachmentDownloadRequest[] = [];
  private readonly bodies = new Map<string, Uint8Array>();
  private readonly failures = new Map<string, number>();
  private readonly plans = new Map<string, PlannedResponse[]>();

  serve(serverId: string, body: Uint8Array): void {
    this.bodies.set(serverId, body);
  }

  plan(serverId: string, response: PlannedResponse): void {
    const queue = this.plans.get(serverId) ?? [];
    queue.push(response);
    this.plans.set(serverId, queue);
  }

  failAlways(serverId: string, status: number): void {
    this.failures.set(serverId, status);
  }

  callsFor(serverId: string): number {
    return this.calls.filter((call) => call.serverId === serverId).length;
  }

  readonly download: AttachmentDownloader = async (request) => {
    this.calls.push(request);
    const failure = this.failures.get(request.serverId);
    if (failure !== undefined) return { ok: false, status: failure, code: `HTTP_${failure}`, retryAfterMs: null };
    const planned = this.plans.get(request.serverId)?.shift();
    const response: PlannedResponse = planned ?? { body: this.bodies.get(request.serverId) };
    response.started?.();
    if (response.hang) return untilAborted(request.signal);
    if (response.status !== undefined) return { ok: false, status: response.status, code: `HTTP_${response.status}`, retryAfterMs: response.retryAfterMs ?? null };
    const body = response.body ?? this.bodies.get(request.serverId);
    if (body === undefined) return { ok: false, status: 404, code: 'HTTP_404', retryAfterMs: null };
    return { ok: true, body: streamOf(body, response) };
  };
}
