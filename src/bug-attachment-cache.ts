import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BugSectionView, ServerBugKey } from './bug-store.ts';
import { BugSyncConfigError, ClaimsError, type BugSyncConfig, type ClaimsIssuer, type ServerAuth } from './bug-sync.ts';

export interface AttachmentCacheSettings {
  readonly maxBytes: number;
  readonly directory: string;
}

export interface AttachmentRef {
  readonly bugPk: number;
  readonly serverId: string;
}

export type AttachmentPresence = 'present' | 'deleted' | 'missing';

export interface AttachmentMetadata {
  readonly bugPk: number;
  readonly commentPk: number | null;
  readonly serverId: string;
  readonly kind: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly presence: AttachmentPresence;
}

export interface AttachmentDownloadRequest {
  readonly auth: ServerAuth;
  readonly sectionId: string;
  readonly key: ServerBugKey;
  readonly bugPk: number;
  readonly serverId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly signal: AbortSignal;
}

export type AttachmentDownloadResult =
  | { readonly ok: true; readonly body: AsyncIterable<Uint8Array> }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly retryAfterMs: number | null };

export type AttachmentDownloader = (request: AttachmentDownloadRequest) => Promise<AttachmentDownloadResult>;

export interface AttachmentCacheOptions {
  readonly database: DatabaseSync;
  readonly settings: AttachmentCacheSettings;
  readonly config: BugSyncConfig;
  readonly claims: ClaimsIssuer;
  readonly download: AttachmentDownloader;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface AttachmentAccess {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mime: string;
  readonly source: 'cache' | 'download';
}

export interface EvictionReport {
  readonly evicted: readonly AttachmentRef[];
  readonly cachedBytes: number;
}

export interface ReconcileReport {
  readonly missingFiles: readonly AttachmentRef[];
  readonly removedOrphans: number;
  readonly cachedBytes: number;
}

export type AttachmentCacheErrorCode =
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_ACCESS_DENIED'
  | 'ATTACHMENT_SECTION_UNAVAILABLE'
  | 'ATTACHMENT_INTEGRITY_FAILED'
  | 'ATTACHMENT_FETCH_FAILED'
  | 'ATTACHMENT_TOO_LARGE';

export class AttachmentCacheError extends Error {
  readonly code: AttachmentCacheErrorCode;

  constructor(code: AttachmentCacheErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentCacheError';
    this.code = code;
  }
}

export interface AttachmentCache {
  get(ref: AttachmentRef): Promise<AttachmentAccess>;
  enforceBudget(): Promise<EvictionReport>;
  reconcile(): Promise<ReconcileReport>;
  cachedBytes(): number;
}

interface AttachmentRow {
  readonly attachment_pk: number;
  readonly bug_pk: number;
  readonly server_id: string;
  readonly mime: string | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly presence: string;
  readonly cache_state: string;
  readonly cache_file: string | null;
  readonly cache_bytes: number | null;
  readonly cache_sha256: string | null;
  readonly fetch_owner: string | null;
  readonly section_id: string;
  readonly project: string;
  readonly env: string;
  readonly source: string;
  readonly owner: string;
  readonly raw_id: string;
  readonly bug_presence: string;
  readonly s_project: string;
  readonly s_env: string;
  readonly stand: string;
  readonly canonical_project: string;
  readonly origin: string;
  readonly actor: string;
  readonly claims_fingerprint: string | null;
}

type DownloadOutcome =
  | { readonly kind: 'done'; readonly temporary: string }
  | { readonly kind: 'retry'; readonly code: AttachmentCacheErrorCode; readonly reason: string; readonly retryAfterMs: number | null }
  | { readonly kind: 'fatal'; readonly error: AttachmentCacheError };

const activeOwners = new Map<string, Promise<void>>();
const sha256Pattern = /^[0-9a-f]{64}$/;
const cacheFilePattern = /^[0-9]+-[0-9a-f-]{36}$/;
const partFilePattern = /^\.([0-9]+-[0-9a-f-]{36})\.[0-9a-f-]{36}\.part$/;
const attachmentQuery = `SELECT a.attachment_pk, a.bug_pk, a.server_id, a.mime, a.bytes, a.sha256, a.presence, a.cache_state, a.cache_file,
  a.cache_bytes, a.cache_sha256, a.fetch_owner, b.section_id, b.project, b.env, b.source, b.owner, b.raw_id, b.presence AS bug_presence,
  s.project AS s_project, s.env AS s_env, s.stand, s.canonical_project, s.origin, s.actor, s.claims_fingerprint
  FROM attachments a JOIN bugs b ON b.bug_pk = a.bug_pk JOIN sections s ON s.section_id = b.section_id
  WHERE a.bug_pk = ? AND a.server_id = ?`;

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function inside(directory: string, path: string): boolean {
  const relation = relative(directory, path);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

export function loadAttachmentCacheSettings(confDir: string, rafHome: string): AttachmentCacheSettings {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(confDir, 'raf.json'), 'utf8')); }
  catch { throw new BugSyncConfigError('raf.json', `Не вдалося прочитати валідний ${join(confDir, 'raf.json')}.`); }
  const bugs = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).bugs : undefined;
  if (!bugs || typeof bugs !== 'object' || Array.isArray(bugs)) throw new BugSyncConfigError('bugs', 'conf/raf.json#/bugs має бути об’єктом.');
  const { attachmentCacheMaxBytes: maxBytes, attachmentsDirectory: name } = bugs as Record<string, unknown>;
  if (!positiveInteger(maxBytes)) throw new BugSyncConfigError('bugs.attachmentCacheMaxBytes', 'conf/raf.json#/bugs/attachmentCacheMaxBytes має бути додатним цілим числом байтів.');
  if (typeof name !== 'string' || !name.trim() || name.includes('\0') || isAbsolute(name)) {
    throw new BugSyncConfigError('bugs.attachmentsDirectory', 'conf/raf.json#/bugs/attachmentsDirectory має бути відносною назвою теки в ~/.raf.');
  }
  const home = resolve(rafHome);
  const directory = resolve(home, name);
  if (!inside(home, directory)) throw new BugSyncConfigError('bugs.attachmentsDirectory', 'conf/raf.json#/bugs/attachmentsDirectory має лишатися всередині ~/.raf.');
  return { maxBytes, directory };
}

export function applyAttachmentMetadata(database: DatabaseSync, metadata: AttachmentMetadata): void {
  if (!Number.isSafeInteger(metadata.bugPk) || typeof metadata.serverId !== 'string' || !metadata.serverId
    || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || !sha256Pattern.test(metadata.sha256)
    || !['present', 'deleted', 'missing'].includes(metadata.presence)) {
    throw new TypeError(`Некоректні метадані вкладення ${String(metadata.serverId)}.`);
  }
  database.prepare(`INSERT INTO attachments (bug_pk, comment_pk, server_id, kind, mime, bytes, sha256, presence, cache_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'absent')
    ON CONFLICT(bug_pk, server_id) DO UPDATE SET comment_pk = excluded.comment_pk, kind = excluded.kind, mime = excluded.mime,
      bytes = excluded.bytes, sha256 = excluded.sha256, presence = excluded.presence`)
    .run(metadata.bugPk, metadata.commentPk, metadata.serverId, metadata.kind, metadata.mime, metadata.bytes, metadata.sha256, metadata.presence);
}

function ownerAlive(owner: string | null): boolean {
  if (!owner) return false;
  if (activeOwners.has(owner)) return true;
  const match = /^([0-9]+)-/.exec(owner);
  if (!match) return false;
  const pid = Number(match[1]);
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAttachmentCache(options: AttachmentCacheOptions): AttachmentCache {
  const { database, settings, config } = options;
  const directory = resolve(settings.directory);
  const timestamp = () => options.now().toISOString();
  const transaction = <T>(action: () => T): T => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  };
  const load = (ref: AttachmentRef) => database.prepare(attachmentQuery).get(ref.bugPk, ref.serverId) as unknown as AttachmentRow | undefined;
  const filePath = (name: string | null): string | null => {
    if (name === null || !cacheFilePattern.test(name)) return null;
    const path = resolve(directory, name);
    return inside(directory, path) ? path : null;
  };
  const release = (pk: number) => database.prepare(`UPDATE attachments SET cache_state = 'absent', cache_file = NULL, cache_bytes = NULL,
    cache_sha256 = NULL, fetch_owner = NULL, fetch_started_at = NULL WHERE attachment_pk = ?`).run(pk);
  const releaseOwned = (pk: number, owner: string) => database.prepare(`UPDATE attachments SET cache_state = 'absent', cache_file = NULL,
    cache_bytes = NULL, cache_sha256 = NULL, fetch_owner = NULL, fetch_started_at = NULL WHERE attachment_pk = ? AND fetch_owner = ?`).run(pk, owner);
  const removeFiles = async (paths: readonly string[]) => {
    for (const path of paths) await rm(path, { force: true });
  };
  const regularFileSize = async (path: string): Promise<number | null> => {
    try {
      const stats = await lstat(path);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  };
  const fileDigest = async (path: string): Promise<string | null> => {
    try {
      const handle = await open(path, 'r');
      try {
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
        return hash.digest('hex');
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  };
  const sweepStale = (pk: number, keep: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const entry of entries) if (entry !== keep && entry.startsWith(`${pk}-`) && cacheFilePattern.test(entry)) rmSync(join(directory, entry), { force: true });
  };
  const total = () => Number((database.prepare(`SELECT COALESCE(SUM(cache_bytes), 0) AS total FROM attachments WHERE cache_state = 'ready'`).get() as { total: number | bigint }).total);
  const sectionView = (row: AttachmentRow): BugSectionView => ({
    sectionId: row.section_id, project: row.s_project, env: row.s_env, stand: row.stand, canonicalProject: row.canonical_project,
    origin: row.origin, actor: row.actor, claimsFingerprint: row.claims_fingerprint ?? '',
  });
  const requireSection = (row: AttachmentRow) => {
    if (!config.sections.some(section => section.project === row.s_project && section.env === row.s_env)) {
      throw new AttachmentCacheError('ATTACHMENT_SECTION_UNAVAILABLE', `Розділ ${row.section_id} відсутній у conf/raf.json#/bugs/sections; доступ до вкладення ${row.server_id} закрито.`);
    }
  };
  const authorize = async (row: AttachmentRow): Promise<ServerAuth> => {
    requireSection(row);
    try {
      const issued = await options.claims.issue(sectionView(row), 'read');
      return { origin: config.origin, project: row.s_project, env: row.s_env, token: issued.token, timeoutMs: config.requestTimeoutMs };
    } catch (error) {
      if (error instanceof ClaimsError) throw new AttachmentCacheError('ATTACHMENT_SECTION_UNAVAILABLE', `Розділ ${row.section_id} недоступний (${error.code}); вкладення ${row.server_id} не видається.`);
      throw error;
    }
  };
  const evict = (protect: number | null): { evicted: AttachmentRef[]; files: string[]; cachedBytes: number } => transaction(() => {
    let cached = total();
    const evicted: AttachmentRef[] = [];
    const files: string[] = [];
    if (cached < settings.maxBytes) return { evicted, files, cachedBytes: cached };
    const rows = database.prepare(`SELECT attachment_pk, bug_pk, server_id, cache_file, cache_bytes FROM attachments
      WHERE cache_state = 'ready' AND attachment_pk IS NOT ? ORDER BY last_read_at ASC, attachment_pk ASC`).all(protect) as unknown as
      { attachment_pk: number; bug_pk: number; server_id: string; cache_file: string | null; cache_bytes: number | null }[];
    for (const row of rows) {
      if (cached < settings.maxBytes) break;
      release(row.attachment_pk);
      cached -= Number(row.cache_bytes ?? 0);
      evicted.push({ bugPk: row.bug_pk, serverId: row.server_id });
      const path = filePath(row.cache_file);
      if (path) files.push(path);
    }
    return { evicted, files, cachedBytes: cached };
  });
  const enforce = async (protect: number | null): Promise<EvictionReport> => {
    const { evicted, files, cachedBytes } = evict(protect);
    await removeFiles(files);
    return { evicted, cachedBytes };
  };
  const delay = (attempt: number, retryAfterMs: number | null) => {
    const backoff = Math.min(config.retry.initialDelayMs * config.retry.multiplier ** attempt, config.retry.maxDelayMs);
    return retryAfterMs !== null && retryAfterMs > backoff ? retryAfterMs : backoff;
  };
  const retryLimit = () => {
    let attempts = 1;
    for (let next = config.retry.initialDelayMs; next < config.retry.maxDelayMs; next *= config.retry.multiplier) attempts += 1;
    return attempts;
  };
  const fetchOnce = async (row: AttachmentRow, owner: string): Promise<DownloadOutcome> => {
    let auth: ServerAuth;
    try { auth = await authorize(row); }
    catch (error) { if (error instanceof AttachmentCacheError) return { kind: 'fatal', error }; throw error; }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`Немає відповіді сервера ${config.requestTimeoutMs} мс`)), config.requestTimeoutMs);
    };
    const temporary = join(directory, `.${owner}.${randomUUID()}.part`);
    let written = false;
    try {
      arm();
      const result = await options.download({
        auth, sectionId: row.section_id, key: { project: row.project, env: row.env, source: row.source, owner: row.owner, rawId: row.raw_id },
        bugPk: row.bug_pk, serverId: row.server_id, bytes: row.bytes, sha256: row.sha256, signal: controller.signal,
      });
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) return { kind: 'fatal', error: new AttachmentCacheError('ATTACHMENT_ACCESS_DENIED', `Сервер відмовив у доступі до вкладення ${row.server_id} (HTTP ${result.status}, ${result.code}).`) };
        if (result.status === 404 || result.status === 410) return { kind: 'fatal', error: new AttachmentCacheError('ATTACHMENT_NOT_FOUND', `Сервер не знайшов вкладення ${row.server_id} (HTTP ${result.status}, ${result.code}).`) };
        if (!retryableStatus(result.status)) return { kind: 'fatal', error: new AttachmentCacheError('ATTACHMENT_FETCH_FAILED', `Завантаження вкладення ${row.server_id} відхилено (HTTP ${result.status}, ${result.code}).`) };
        return { kind: 'retry', code: 'ATTACHMENT_FETCH_FAILED', reason: `HTTP ${result.status} ${result.code}`, retryAfterMs: result.retryAfterMs };
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      written = true;
      const hash = createHash('sha256');
      let received = 0;
      try {
        for await (const chunk of result.body) {
          if (controller.signal.aborted) throw controller.signal.reason;
          received += chunk.byteLength;
          if (received > row.bytes) break;
          hash.update(chunk);
          await handle.write(chunk);
          arm();
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (received !== row.bytes) return { kind: 'retry', code: 'ATTACHMENT_INTEGRITY_FAILED', reason: `отримано ${received} байтів замість ${row.bytes}`, retryAfterMs: null };
      if (hash.digest('hex') !== row.sha256) return { kind: 'retry', code: 'ATTACHMENT_INTEGRITY_FAILED', reason: 'SHA-256 отриманих байтів не збігається з метаданими', retryAfterMs: null };
      written = false;
      return { kind: 'done', temporary };
    } catch (error) {
      return { kind: 'retry', code: 'ATTACHMENT_FETCH_FAILED', reason: describe(error), retryAfterMs: null };
    } finally {
      clearTimeout(timer);
      if (written) await rm(temporary, { force: true });
    }
  };
  const fetchAndPublish = async (ref: AttachmentRef, row: AttachmentRow, owner: string): Promise<AttachmentAccess | null> => {
    const limit = retryLimit();
    let outcome: DownloadOutcome | undefined;
    try {
      for (let attempt = 0; ; attempt += 1) {
        outcome = await fetchOnce(row, owner);
        if (outcome.kind !== 'retry' || attempt + 1 >= limit) break;
        await options.sleep(delay(attempt, outcome.retryAfterMs));
      }
    } catch (error) {
      transaction(() => releaseOwned(row.attachment_pk, owner));
      throw error;
    }
    if (outcome.kind !== 'done') {
      transaction(() => releaseOwned(row.attachment_pk, owner));
      if (outcome.kind === 'fatal') throw outcome.error;
      throw new AttachmentCacheError(outcome.code, `Не вдалося отримати вкладення ${row.server_id} після ${limit} спроб: ${outcome.reason}.`);
    }
    const name = `${row.attachment_pk}-${randomUUID()}`;
    const target = join(directory, name);
    const temporary = outcome.temporary;
    let published: boolean;
    try {
      published = transaction(() => {
        const current = load(ref);
        const valid = !!current && current.attachment_pk === row.attachment_pk && current.cache_state === 'fetching' && current.fetch_owner === owner
          && current.bytes === row.bytes && current.sha256 === row.sha256 && current.presence === 'present' && current.bug_presence === 'present';
        if (!valid) {
          if (current?.fetch_owner === owner) releaseOwned(row.attachment_pk, owner);
          return false;
        }
        renameSync(temporary, target);
        try {
          database.prepare(`UPDATE attachments SET cache_state = 'ready', cache_file = ?, cache_bytes = ?, cache_sha256 = ?, last_read_at = ?,
            fetch_owner = NULL, fetch_started_at = NULL WHERE attachment_pk = ?`).run(name, row.bytes, row.sha256, timestamp(), row.attachment_pk);
          sweepStale(row.attachment_pk, name);
        } catch (error) {
          rmSync(target, { force: true });
          throw error;
        }
        return true;
      });
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    if (!published) return null;
    await enforce(row.attachment_pk);
    return { path: target, bytes: row.bytes, sha256: row.sha256, mime: row.mime ?? '', source: 'download' };
  };
  const hit = async (ref: AttachmentRef, row: AttachmentRow): Promise<AttachmentAccess | null> => {
    const path = filePath(row.cache_file);
    const valid = path !== null && row.cache_bytes === row.bytes && row.cache_sha256 === row.sha256
      && await regularFileSize(path) === row.bytes && await fileDigest(path) === row.sha256;
    const stale: string[] = [];
    const access = transaction(() => {
      const current = load(ref);
      if (!current || current.cache_state !== 'ready' || current.cache_file !== row.cache_file) return undefined;
      if (!valid) {
        release(current.attachment_pk);
        if (path) stale.push(path);
        return null;
      }
      database.prepare('UPDATE attachments SET last_read_at = ? WHERE attachment_pk = ?').run(timestamp(), current.attachment_pk);
      return { path: path!, bytes: current.bytes, sha256: current.sha256, mime: current.mime ?? '', source: 'cache' as const };
    });
    await removeFiles(stale);
    if (access) await enforce(row.attachment_pk);
    return access ?? null;
  };
  const wait = async (owner: string) => {
    const running = activeOwners.get(owner);
    if (running) await running.catch(() => undefined);
    else await new Promise(done => setTimeout(done, config.retry.initialDelayMs));
  };
  const get = async (ref: AttachmentRef): Promise<AttachmentAccess> => {
    for (;;) {
      const row = load(ref);
      if (!row) throw new AttachmentCacheError('ATTACHMENT_NOT_FOUND', `Вкладення ${ref.serverId} жука ${ref.bugPk} відсутнє в локальній базі жуків.`);
      if (row.presence !== 'present' || row.bug_presence !== 'present') {
        const stale = transaction(() => {
          const current = load(ref);
          if (!current || current.cache_state !== 'ready') return null;
          release(current.attachment_pk);
          return filePath(current.cache_file);
        });
        if (stale) await rm(stale, { force: true });
        throw new AttachmentCacheError('ATTACHMENT_NOT_FOUND', `Вкладення ${ref.serverId} або його жук позначені на сервері як ${row.presence !== 'present' ? row.presence : row.bug_presence}.`);
      }
      if (row.bytes >= settings.maxBytes) {
        throw new AttachmentCacheError('ATTACHMENT_TOO_LARGE', `Вкладення ${ref.serverId} має ${row.bytes} байтів, що не менше бюджету кешу ${settings.maxBytes} (conf/raf.json#/bugs/attachmentCacheMaxBytes).`);
      }
      requireSection(row);
      if (row.cache_state === 'ready') {
        await authorize(row);
        const access = await hit(ref, row);
        if (access) return access;
        continue;
      }
      const owner = `${process.pid}-${randomUUID()}`;
      const decision = transaction((): 'reload' | { readonly wait: string } | { readonly claimed: AttachmentRow } => {
        const current = load(ref);
        if (!current || current.cache_state === 'ready') return 'reload';
        if (current.cache_state === 'fetching' && ownerAlive(current.fetch_owner)) return { wait: current.fetch_owner! };
        database.prepare(`UPDATE attachments SET cache_state = 'fetching', cache_file = NULL, cache_bytes = NULL, cache_sha256 = NULL,
          fetch_owner = ?, fetch_started_at = ? WHERE attachment_pk = ?`).run(owner, timestamp(), current.attachment_pk);
        return { claimed: current };
      });
      if (decision === 'reload') continue;
      if ('wait' in decision) {
        await wait(decision.wait);
        continue;
      }
      let finish!: () => void;
      activeOwners.set(owner, new Promise<void>(done => { finish = done; }));
      try {
        const access = await fetchAndPublish(ref, decision.claimed, owner);
        if (access) return access;
      } finally {
        activeOwners.delete(owner);
        finish();
      }
    }
  };
  const reconcile = async (): Promise<ReconcileReport> => {
    const missingFiles: AttachmentRef[] = [];
    let removedOrphans = 0;
    const rows = database.prepare(`SELECT attachment_pk, bug_pk, server_id, bytes, sha256, cache_state, cache_file, cache_bytes, cache_sha256, fetch_owner
      FROM attachments WHERE cache_state != 'absent' OR cache_file IS NOT NULL`).all() as unknown as
      { attachment_pk: number; bug_pk: number; server_id: string; bytes: number; sha256: string; cache_state: string; cache_file: string | null;
        cache_bytes: number | null; cache_sha256: string | null; fetch_owner: string | null }[];
    const sizes = new Map<number, number | null>();
    for (const row of rows) if (row.cache_state === 'ready') sizes.set(row.attachment_pk, filePath(row.cache_file) ? await regularFileSize(filePath(row.cache_file)!) : null);
    transaction(() => {
      for (const row of rows) {
        const current = database.prepare('SELECT cache_state, cache_file, fetch_owner FROM attachments WHERE attachment_pk = ?').get(row.attachment_pk) as
          { cache_state: string; cache_file: string | null; fetch_owner: string | null } | undefined;
        if (!current || current.cache_state !== row.cache_state || current.cache_file !== row.cache_file || current.fetch_owner !== row.fetch_owner) continue;
        if (row.cache_state === 'fetching') {
          if (!ownerAlive(row.fetch_owner)) release(row.attachment_pk);
        } else if (row.cache_state === 'ready') {
          if (sizes.get(row.attachment_pk) !== row.bytes || row.cache_bytes !== row.bytes || row.cache_sha256 !== row.sha256) {
            release(row.attachment_pk);
            missingFiles.push({ bugPk: row.bug_pk, serverId: row.server_id });
          }
        } else release(row.attachment_pk);
      }
      const referenced = new Set((database.prepare(`SELECT cache_file FROM attachments WHERE cache_state = 'ready' AND cache_file IS NOT NULL`).all() as { cache_file: string }[])
        .map(row => row.cache_file));
      let entries: string[] = [];
      try { entries = readdirSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const entry of entries) {
        if (referenced.has(entry)) continue;
        const part = partFilePattern.exec(entry);
        if (part && ownerAlive(part[1])) continue;
        rmSync(join(directory, entry), { recursive: true, force: true });
        removedOrphans += 1;
      }
    });
    return { missingFiles, removedOrphans, cachedBytes: total() };
  };
  return {
    get,
    enforceBudget: () => enforce(null),
    reconcile,
    cachedBytes: total,
  };
}
