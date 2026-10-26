import { measureRafCost } from './raf-cost-runtime.ts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { openSecretsStore, SecretsStoreError } from './secrets-store.ts';
import { BugStoreError, openBugStore, resolveBugStorePath } from './bug-store.ts';
import type { SecretsStore } from './secrets-store.ts';
import type {
  BugRepository,
  BugView,
  CommentView,
  NoticeKind,
  ServerBugDetail,
  BugSectionInput,
  BugSectionView,
  ServerAttachment,
  ServerBugKey,
  ServerComment,
  SyncPhase,
  WrittenBugHeader,
} from './bug-store.ts';

export interface BugSectionConfig {
  readonly project: string;
  readonly env: string;
  readonly stand: string;
  readonly secret: string;
}

export interface BugRetryConfig {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
}

export interface BugSyncConfig {
  readonly fileName: string;
  readonly origin: string;
  readonly actor: string;
  readonly sections: readonly BugSectionConfig[];
  readonly tokenLifetimeSeconds: number;
  readonly pollIntervalMs: number;
  readonly pageLimit: number;
  readonly requestTimeoutMs: number;
  readonly retry: BugRetryConfig;
}

export type BugSyncConfigErrorCode = 'invalid-config';

export class BugSyncConfigError extends Error {
  readonly code: BugSyncConfigErrorCode;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'BugSyncConfigError';
    this.code = 'invalid-config';
    this.field = field;
  }
}

export interface Clock {
  now(): Date;
}

export type ClaimsScope = 'read' | 'write';

export interface IssuedClaims {
  readonly token: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
}

export type ClaimsErrorCode = 'secret-missing' | 'secret-invalid';

export class ClaimsError extends Error {
  readonly code: ClaimsErrorCode;
  readonly sectionId: string;

  constructor(code: ClaimsErrorCode, sectionId: string, message: string) {
    super(message);
    this.name = 'ClaimsError';
    this.code = code;
    this.sectionId = sectionId;
  }
}

export interface ClaimsIssuer {
  fingerprint(section: BugSectionView, scope: ClaimsScope): string;
  issue(section: BugSectionView, scope: ClaimsScope): Promise<IssuedClaims>;
}

export interface ClaimsIssuerDependencies {
  readonly secrets: Pick<SecretsStore, 'select'>;
  readonly config: BugSyncConfig;
  readonly clock: Clock;
}

export interface ServerAuth {
  readonly origin: string;
  readonly project: string;
  readonly env: string;
  readonly token: string;
  readonly timeoutMs: number;
}

export interface ServerBugSummary {
  readonly key: ServerBugKey;
  readonly problemId: string;
  readonly revision: number;
}

export interface ServerBugListPage {
  readonly bugs: readonly ServerBugSummary[];
  readonly nextCursor: string | null;
}

export interface ServerBugHeader {
  readonly key: ServerBugKey;
  readonly problemId: string;
  readonly revision: number;
  readonly status: string;
  readonly state: string;
  readonly createdAt: string;
  readonly claimedBy: string | null;
  readonly payload: unknown;
}

export interface ServerBugDetailPage {
  readonly bug: ServerBugHeader;
  readonly comments: readonly ServerComment[];
  readonly attachments: readonly ServerAttachment[];
  readonly nextCommentsCursor: string | null;
  readonly nextAttachmentsCursor: string | null;
}

export interface ServerJournalEvent {
  readonly cursor: string;
  readonly problemId: string;
  readonly key: ServerBugKey;
  readonly kind: string;
  readonly payload: unknown;
}

export interface ServerJournalPage {
  readonly events: readonly ServerJournalEvent[];
  readonly cursor: string;
  readonly hasMore: boolean;
}

export interface DetailPageRequest {
  readonly commentsCursor: string | null;
  readonly attachmentsCursor: string | null;
  readonly limit: number;
}

export class BugServerError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(status: number | null, code: string, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'BugServerError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface BugServerPort {
  query(auth: ServerAuth, input: { readonly cursor: string | null; readonly limit: number }): Promise<ServerBugListPage>;
  read(auth: ServerAuth, key: ServerBugKey, input: DetailPageRequest): Promise<ServerBugDetailPage>;
  events(auth: ServerAuth, input: { readonly cursor: string; readonly limit: number }): Promise<ServerJournalPage>;
}

export interface MainNotice {
  readonly noticeKey: string;
  readonly kind: NoticeKind;
  readonly bugKey: string;
  readonly commentId: string | null;
}

export interface MainNotifier {
  notify(notice: MainNotice): Promise<void>;
}

export interface SectionPullOutcome {
  readonly sectionId: string;
  readonly phase: SyncPhase;
  readonly snapshotComplete: boolean;
  readonly errorCode: string | null;
}

export interface BugSyncerDependencies {
  readonly repository: BugRepository;
  readonly server: BugServerPort;
  readonly claims: ClaimsIssuer;
  readonly notifier: MainNotifier;
  readonly clock: Clock;
  readonly config: BugSyncConfig;
}

export interface BugSyncer {
  registerSections(): readonly BugSectionView[];
  pullSection(sectionId: string): Promise<SectionPullOutcome>;
  deliverNotices(): Promise<number>;
  runCycle(): Promise<void>;
}

const SECTION_NAME = /^[a-z][a-z0-9-]*$/;
const STAND_NAME = /^[a-z][a-z0-9]*$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TOKEN_LIFETIME_SECONDS = 900;
const MAX_PAGE_LIMIT = 50;
const READ_GRANTS = ['bugs:read', 'bugs:agent'] as const;
const WRITE_GRANTS = ['bugs:read', 'bugs:agent', 'bugs:write'] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(source: Record<string, unknown>, field: string, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new BugSyncConfigError(`${path}${field}`, `${path}${field} must be a positive integer`);
  return value;
}

function nonEmpty(source: Record<string, unknown>, field: string, path: string, pattern?: RegExp): string {
  const value = source[field];
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.includes('\0') || (pattern && !pattern.test(value))) {
    throw new BugSyncConfigError(`${path}${field}`, `${path}${field} is invalid`);
  }
  return value;
}

export function loadBugSyncConfig(raw: unknown): BugSyncConfig {
  const source = plainObject(raw) && plainObject(raw.bugs) && raw.fileName === undefined ? raw.bugs : raw;
  if (!plainObject(source)) throw new BugSyncConfigError('bugs', 'bugs configuration must be an object');
  const fileName = nonEmpty(source, 'fileName', '');
  if (['.', '..'].includes(fileName) || basename(fileName) !== fileName || /[\\/]/.test(fileName)) throw new BugSyncConfigError('fileName', 'bugs.fileName must be a plain file name');
  const originText = nonEmpty(source, 'origin', '');
  let origin: string;
  try {
    const url = new URL(originText);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('origin');
    origin = url.origin;
  } catch {
    throw new BugSyncConfigError('origin', 'bugs.origin must be an https origin');
  }
  const actor = nonEmpty(source, 'actor', '');
  if (!Array.isArray(source.sections) || !source.sections.length) throw new BugSyncConfigError('sections', 'sections must be a non-empty array');
  const seen = new Set<string>();
  const sections = source.sections.map((entry: unknown, index: number): BugSectionConfig => {
    const path = `sections[${index}].`;
    if (!plainObject(entry)) throw new BugSyncConfigError('sections', `sections[${index}] must be an object`);
    let section: BugSectionConfig;
    try {
      section = {
        project: nonEmpty(entry, 'project', path, SECTION_NAME), env: nonEmpty(entry, 'env', path, SECTION_NAME),
        stand: nonEmpty(entry, 'stand', path, STAND_NAME), secret: nonEmpty(entry, 'secret', path, SECRET_NAME),
      };
    } catch (error) {
      throw new BugSyncConfigError('sections', error instanceof Error ? error.message : `sections[${index}] is invalid`);
    }
    const id = bugSectionId(section);
    if (seen.has(id)) throw new BugSyncConfigError('sections', `Duplicate section ${id}`);
    seen.add(id);
    return section;
  });
  const tokenLifetimeSeconds = positiveInteger(source, 'tokenLifetimeSeconds', '', MAX_TOKEN_LIFETIME_SECONDS);
  const pollIntervalMs = positiveInteger(source, 'pollIntervalMs', '');
  const pageLimit = positiveInteger(source, 'pageLimit', '', MAX_PAGE_LIMIT);
  const requestTimeoutMs = positiveInteger(source, 'requestTimeoutMs', '');
  if (!plainObject(source.retry)) throw new BugSyncConfigError('retry', 'retry must be an object');
  const initialDelayMs = positiveInteger(source.retry, 'initialDelayMs', 'retry.');
  const maxDelayMs = positiveInteger(source.retry, 'maxDelayMs', 'retry.');
  const multiplier = source.retry.multiplier;
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1) throw new BugSyncConfigError('retry.multiplier', 'retry.multiplier must be a number not less than 1');
  if (maxDelayMs < initialDelayMs) throw new BugSyncConfigError('retry.maxDelayMs', 'retry.maxDelayMs must not be less than initialDelayMs');
  return {
    fileName, origin, actor, sections, tokenLifetimeSeconds, pollIntervalMs, pageLimit, requestTimeoutMs,
    retry: { initialDelayMs, maxDelayMs, multiplier },
  };
}

export function bugSectionId(section: Pick<BugSectionConfig, 'project' | 'env'>): string {
  if (!section || typeof section.project !== 'string' || !SECTION_NAME.test(section.project) || typeof section.env !== 'string' || !SECTION_NAME.test(section.env)) {
    throw new BugSyncConfigError('section', 'Section project and env must be lowercase identifiers');
  }
  return `${section.project}:${section.env}`;
}

export function describeBugSection(config: BugSyncConfig, section: BugSectionConfig, claimsFingerprint: string): BugSectionInput {
  return {
    sectionId: bugSectionId(section), project: section.project, env: section.env, stand: section.stand,
    canonicalProject: `projects/${section.project}`, origin: config.origin, actor: config.actor, claimsFingerprint,
  };
}

function sectionConfig(config: BugSyncConfig, section: Pick<BugSectionView, 'project' | 'env'>): BugSectionConfig | undefined {
  return config.sections.find(entry => entry.project === section.project && entry.env === section.env);
}

function serviceClaims(config: BugSyncConfig, section: Pick<BugSectionView, 'project' | 'env'>, scope: ClaimsScope) {
  return {
    contract_version: 2, purpose: 'bugs-api', iss: config.origin, aud: 'dashboard-bugs', project: section.project, env: section.env,
    actor: config.actor, owner: config.actor, level: 'agent', grants: [...(scope === 'write' ? WRITE_GRANTS : READ_GRANTS)], scope,
  };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

export function createClaimsIssuer(dependencies: ClaimsIssuerDependencies): ClaimsIssuer {
  const { secrets, config, clock } = dependencies;
  const fingerprint = (section: BugSectionView, scope: ClaimsScope) =>
    createHash('sha256').update(JSON.stringify(serviceClaims(config, section, scope))).digest('hex');
  return {
    fingerprint,
    async issue(section, scope) {
      const entry = sectionConfig(config, section);
      const sectionId = bugSectionId(section);
      if (!entry) throw new ClaimsError('secret-missing', sectionId, `Section ${sectionId} is not configured in conf/raf.json#/bugs/sections`);
      let value: string | undefined;
      try {
        value = (await secrets.select([entry.secret])).env[entry.secret];
      } catch (error) {
        if (error instanceof SecretsStoreError && error.code === 'missing-secret') throw new ClaimsError('secret-missing', sectionId, `Secret ${entry.secret} for section ${sectionId} is missing`);
        if (error instanceof SecretsStoreError && error.code === 'expired-secret') throw new ClaimsError('secret-invalid', sectionId, `Secret ${entry.secret} for section ${sectionId} has expired`);
        throw error;
      }
      const secret = typeof value === 'string' ? value.trim() : '';
      if (!secret) throw new ClaimsError('secret-missing', sectionId, `Secret ${entry.secret} for section ${sectionId} is missing`);
      if (secret.length < 32) throw new ClaimsError('secret-invalid', sectionId, `Secret ${entry.secret} for section ${sectionId} does not meet the minimum length`);
      const iat = Math.floor(clock.now().getTime() / 1000);
      const exp = iat + config.tokenLifetimeSeconds;
      const payload = { ...serviceClaims(config, section, scope), iat, exp };
      const signingInput = `${base64url(JSON.stringify({ alg: 'HS256' }))}.${base64url(JSON.stringify(payload))}`;
      const key = createHash('sha256').update(`dashboard-bugs:${secret}`).digest();
      const signature = createHmac('sha256', key).update(signingInput).digest('base64url');
      return { token: `${signingInput}.${signature}`, fingerprint: fingerprint(section, scope), expiresAt: new Date(exp * 1000).toISOString() };
    },
  };
}

function problemKey(value: unknown, scope: { project: string; env: string }): ServerBugKey | null {
  if (plainObject(value) && typeof value.source === 'string' && typeof value.owner === 'string' && typeof value.id === 'string') {
    return { project: String(value.project ?? scope.project), env: String(value.env ?? scope.env), source: value.source, owner: value.owner, rawId: value.id };
  }
  if (typeof value !== 'string') return null;
  let tuple: unknown;
  try { tuple = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every(item => typeof item === 'string' && item)) return null;
  return { project: scope.project, env: scope.env, source: tuple[0], owner: tuple[1], rawId: tuple[2] };
}

function problemId(key: ServerBugKey): string {
  return JSON.stringify([key.source, key.owner, key.rawId]);
}

function invalidResponse(message: string): never {
  throw new BugServerError(null, 'invalid-response', message);
}

function mapAttachment(value: unknown, commentId: string | null): ServerAttachment {
  if (!plainObject(value) || typeof value.id !== 'string' || typeof value.sha256 !== 'string' || typeof value.bytes !== 'number') invalidResponse('Invalid attachment metadata');
  return { id: value.id, commentId, kind: String(value.kind ?? ''), mime: String(value.mime ?? ''), bytes: value.bytes, sha256: value.sha256 };
}

function mapDetail(value: unknown, scope: { project: string; env: string }): ServerBugDetailPage {
  if (!plainObject(value)) invalidResponse('Bug detail must be an object');
  const key = problemKey(value.key, scope) ?? problemKey(value.problem_id, scope);
  if (!key || typeof value.revision !== 'number') invalidResponse('Bug detail lacks key or revision');
  const { comments: rawComments, attachments: rawAttachments, nextCommentsCursor, nextAttachmentsCursor, ...header } = value;
  const comments = (Array.isArray(rawComments) ? rawComments : []).map((comment: unknown): ServerComment => {
    if (!plainObject(comment) || typeof comment.id !== 'string') invalidResponse('Invalid comment');
    return {
      id: comment.id, authorId: String(comment.author_id ?? ''), authorKind: String(comment.author_kind ?? ''), text: String(comment.text ?? ''),
      replyTo: typeof comment.reply_to === 'string' ? comment.reply_to : null, createdAt: String(comment.created_at ?? ''), payload: comment,
    };
  });
  const attachments = new Map<string, ServerAttachment>();
  for (const attachment of Array.isArray(rawAttachments) ? rawAttachments : []) {
    const mapped = mapAttachment(attachment, null);
    attachments.set(mapped.id, mapped);
  }
  for (const comment of comments) {
    const nested = (comment.payload as Record<string, unknown>).attachments;
    for (const attachment of Array.isArray(nested) ? nested : []) {
      const mapped = mapAttachment(attachment, comment.id);
      attachments.set(mapped.id, mapped);
    }
  }
  return {
    bug: {
      key, problemId: typeof value.problem_id === 'string' ? value.problem_id : problemId(key), revision: value.revision,
      status: String(value.status ?? ''), state: String(value.state ?? ''), createdAt: String(value.created_at ?? ''),
      claimedBy: typeof value.claimed_by === 'string' && value.claimed_by ? value.claimed_by : null, payload: header,
    },
    comments, attachments: [...attachments.values()],
    nextCommentsCursor: typeof nextCommentsCursor === 'string' && nextCommentsCursor ? nextCommentsCursor : null,
    nextAttachmentsCursor: typeof nextAttachmentsCursor === 'string' && nextAttachmentsCursor ? nextAttachmentsCursor : null,
  };
}

function retryAfter(response: Response, body: Record<string, unknown>): number | null {
  const fromBody = body.retry_after ?? body.retryAfter;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return fromBody * 1000;
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export function createHttpBugServer(options: { readonly fetch?: typeof fetch } = {}): BugServerPort {
  const fetcher = options.fetch ?? globalThis.fetch;
  async function call(auth: ServerAuth, path: string, query: Record<string, unknown>, init: RequestInit = {}): Promise<unknown> {
    const params = new URLSearchParams({ project: auth.project, env: auth.env });
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(name, String(value));
    const headers = new Headers(init.headers);
    headers.set('x-bugs-contract-version', '2');
    headers.set('authorization', `Bearer ${auth.token}`);
    headers.set('accept', 'application/json');
    let response: Response;
    try {
      response = await fetcher(`${auth.origin}${path}?${params}`, { ...init, headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(auth.timeoutMs) });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new BugServerError(null, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', 'Bug server request failed');
    }
    let body: unknown = null;
    const raw = await response.text().catch(() => '');
    if (raw) { try { body = JSON.parse(raw); } catch { body = null; } }
    if (!response.ok) {
      const details = plainObject(body) ? body : {};
      const code = typeof details.error === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(details.error) ? details.error : `http-${response.status}`;
      throw new BugServerError(response.status, code, `Bug server responded ${response.status} ${code}`, retryAfter(response, details));
    }
    if (body === null) invalidResponse('Bug server returned a non-JSON response');
    return body;
  }
  const bugPath = (key: ServerBugKey, suffix = '') => `/api/bugs/${encodeURIComponent(problemId(key))}${suffix}`;
  return {
    async query(auth, input) {
      const page = await call(auth, '/api/bugs', { limit: input.limit, cursor: input.cursor ?? undefined });
      if (!plainObject(page) || !Array.isArray(page.bugs)) invalidResponse('Invalid bug list page');
      return {
        bugs: page.bugs.map(bug => {
          const detail = mapDetail(bug, auth);
          return { key: detail.bug.key, problemId: detail.bug.problemId, revision: detail.bug.revision };
        }),
        nextCursor: typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null,
      };
    },
    async read(auth, key, input) {
      return mapDetail(await call(auth, bugPath(key), {
        limit: input.limit, commentsCursor: input.commentsCursor ?? undefined, attachmentsCursor: input.attachmentsCursor ?? undefined,
      }), auth);
    },
    async events(auth, input) {
      const page = await call(auth, '/api/bugs/events', { cursor: input.cursor, limit: input.limit });
      if (!plainObject(page) || !Array.isArray(page.events) || typeof page.cursor !== 'string' || typeof page.has_more !== 'boolean') invalidResponse('Invalid journal page');
      return {
        events: page.events.map(event => {
          if (!plainObject(event) || typeof event.cursor !== 'string') invalidResponse('Invalid journal event');
          const key = problemKey(event.problem_id, { project: String(event.project ?? auth.project), env: String(event.env ?? auth.env) });
          if (!key) invalidResponse('Journal event lacks a problem key');
          return { cursor: event.cursor, problemId: String(event.problem_id), key, kind: String(event.kind ?? ''), payload: event.payload ?? null };
        }),
        cursor: page.cursor, hasMore: page.has_more,
      };
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof BugServerError || error instanceof ClaimsError || error instanceof BugStoreError || error instanceof BugSyncConfigError) return error.code;
  return 'internal-error';
}

function isAccess(error: unknown): boolean {
  return error instanceof BugServerError && (error.status === 401 || error.status === 403);
}

function isInvalidJournalCursor(error: unknown): boolean {
  return error instanceof BugServerError && (error.status === 422 || (error.status === 410 && error.code === 'cursor-expired'));
}

function deletedMarker(payload: unknown): boolean {
  return plainObject(payload) && payload.deleted === true;
}

function keyId(key: ServerBugKey): string {
  return JSON.stringify([key.project, key.env, key.source, key.owner, key.rawId]);
}

export function createBugSyncer(dependencies: BugSyncerDependencies): BugSyncer {
  const { repository, server, claims, notifier, clock, config } = dependencies;
  const now = () => clock.now().toISOString();

  const views = () => config.sections.map(section => {
    const draft = describeBugSection(config, section, '');
    return describeBugSection(config, section, claims.fingerprint(draft, 'read'));
  });

  function ensureSections(): readonly BugSectionView[] {
    const sections = views();
    for (const section of sections) repository.upsertSection(section);
    return sections;
  }

  function viewFor(sectionId: string): BugSectionView {
    const section = views().find(candidate => candidate.sectionId === sectionId);
    if (!section) throw new BugStoreError('unknown-section', `Section ${sectionId} is not configured in conf/raf.json#/bugs/sections`, { sectionId });
    return section;
  }

  async function authFor(section: BugSectionView, scope: ClaimsScope): Promise<ServerAuth> {
    const issued = await claims.issue(section, scope);
    return { origin: config.origin, project: section.project, env: section.env, token: issued.token, timeoutMs: config.requestTimeoutMs };
  }

  function incomplete(key: ServerBugKey, id: string, code: string, header?: ServerBugHeader | ServerBugSummary): ServerBugDetail {
    const full = header && 'status' in header ? header : undefined;
    return {
      key, problemId: id, revision: header?.revision ?? 0, status: full?.status ?? '', state: full?.state ?? '', createdAt: full?.createdAt ?? '',
      claimedBy: full?.claimedBy ?? null, payload: full?.payload ?? null, comments: [], attachments: [], complete: false, errorCode: code,
    };
  }

  async function readFull(auth: ServerAuth, key: ServerBugKey, id: string, summary?: ServerBugSummary): Promise<ServerBugDetail | 'missing'> {
    const comments: ServerComment[] = [];
    const attachments: ServerAttachment[] = [];
    let commentsCursor: string | null = null;
    let attachmentsCursor: string | null = null;
    let header: ServerBugHeader | undefined;
    try {
      for (let first = true; ; first = false) {
        const page = await server.read(auth, key, { commentsCursor, attachmentsCursor, limit: config.pageLimit });
        if (!header) header = page.bug;
        else if (page.bug.revision !== header.revision) return incomplete(key, id, 'revision-changed', header);
        if (first || commentsCursor !== null) comments.push(...page.comments);
        if (first || attachmentsCursor !== null) attachments.push(...page.attachments);
        commentsCursor = first || commentsCursor !== null ? page.nextCommentsCursor : null;
        attachmentsCursor = first || attachmentsCursor !== null ? page.nextAttachmentsCursor : null;
        if (commentsCursor === null && attachmentsCursor === null) break;
      }
    } catch (error) {
      if (!(error instanceof BugServerError) || isAccess(error) || error.status === null || error.status >= 500 || error.status === 429) throw error;
      if (error.status === 404) return 'missing';
      return incomplete(key, id, error.code, header ?? summary);
    }
    return {
      key: header.key, problemId: header.problemId, revision: header.revision, status: header.status, state: header.state, createdAt: header.createdAt,
      claimedBy: header.claimedBy, payload: header.payload, comments, attachments, complete: true, errorCode: null,
    };
  }

  async function fullListing(auth: ServerAuth): Promise<Set<string>> {
    const keys = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await server.query(auth, { cursor, limit: config.pageLimit });
      for (const bug of page.bugs) keys.add(keyId(bug.key));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return keys;
  }

  async function pull(section: BugSectionView): Promise<void> {
    const auth = await authFor(section, 'read');
    const readFingerprint = claims.fingerprint(section, 'read');
    const apply = (details: ServerBugDetail[], deleted: ServerBugKey[], missing: ServerBugKey[], position: Parameters<BugRepository['applyPullBatch']>[0]['position']) => {
      repository.applyPullBatch({ sectionId: section.sectionId, details, deleted, missing, position, at: now() });
    };
    for (;;) {
      const state = repository.syncState(section.sectionId);
      if (state.phase === 'incremental') {
        let page: ServerJournalPage;
        try {
          page = await server.events(auth, { cursor: state.journalCursor, limit: config.pageLimit });
        } catch (error) {
          if (isInvalidJournalCursor(error)) {
            apply([], [], [], { phase: 'resync', snapshotHead: null, listCursor: null, listClaimsFingerprint: null, snapshotComplete: false });
            continue;
          }
          throw error;
        }
        const order: ServerBugKey[] = [];
        const marked = new Map<string, { key: ServerBugKey; id: string; deleted: boolean }>();
        for (const event of page.events) {
          const id = keyId(event.key);
          const entry = marked.get(id);
          if (!entry) { marked.set(id, { key: event.key, id: event.problemId, deleted: deletedMarker(event.payload) }); order.push(event.key); }
          else entry.deleted ||= deletedMarker(event.payload);
        }
        const details: ServerBugDetail[] = [];
        const deleted: ServerBugKey[] = [];
        const missing: ServerBugKey[] = [];
        for (const key of order) {
          const entry = marked.get(keyId(key))!;
          if (entry.deleted) { deleted.push(key); continue; }
          const detail = await readFull(auth, key, entry.id);
          if (detail === 'missing') missing.push(key);
          else details.push(detail);
        }
        apply(details, deleted, missing, { journalCursor: page.cursor });
        if (!page.hasMore || page.cursor === state.journalCursor) return;
        continue;
      }
      if (state.listClaimsFingerprint === null) {
        let page: ServerJournalPage;
        try {
          page = await server.events(auth, { cursor: state.snapshotHead ?? '0', limit: config.pageLimit });
        } catch (error) {
          if (isInvalidJournalCursor(error) && state.snapshotHead !== null) {
            apply([], [], [], { snapshotHead: null });
            continue;
          }
          throw error;
        }
        if (page.hasMore && page.cursor !== (state.snapshotHead ?? '0')) apply([], [], [], { snapshotHead: page.cursor });
        else apply([], [], [], { phase: state.phase === 'initial' ? 'snapshot' : state.phase, snapshotHead: page.cursor, listCursor: null, listClaimsFingerprint: readFingerprint });
        continue;
      }
      if (state.listClaimsFingerprint !== readFingerprint) {
        apply([], [], [], { listCursor: null, listClaimsFingerprint: readFingerprint });
        continue;
      }
      let page: ServerBugListPage;
      try {
        page = await server.query(auth, { cursor: state.listCursor, limit: config.pageLimit });
      } catch (error) {
        if (error instanceof BugServerError && error.status === 422 && state.listCursor !== null) {
          apply([], [], [], { listCursor: null });
          continue;
        }
        throw error;
      }
      const details: ServerBugDetail[] = [];
      const missing: ServerBugKey[] = [];
      for (const summary of page.bugs) {
        const detail = await readFull(auth, summary.key, summary.problemId, summary);
        if (detail === 'missing') missing.push(summary.key);
        else details.push(detail);
      }
      if (page.nextCursor !== null) {
        apply(details, [], missing, { listCursor: page.nextCursor });
        continue;
      }
      if (state.phase === 'resync') {
        const listed = await fullListing(auth);
        for (const detail of details) listed.add(keyId(detail.key));
        for (const key of repository.presentBugKeys(section.sectionId)) {
          if (!listed.has(keyId(key)) && !missing.some(item => keyId(item) === keyId(key))) missing.push(key);
        }
      }
      apply(details, [], missing, {
        phase: 'incremental', journalCursor: state.snapshotHead ?? '0', snapshotHead: null, listCursor: null, snapshotComplete: true,
      });
      return;
    }
  }

  const syncer: BugSyncer = {
    async pullSection(sectionId) {
      const section = viewFor(sectionId);
      repository.upsertSection(section);
      repository.recordSyncAttempt(sectionId, now());
      let failure: string | null = null;
      try {
        await pull(section);
      } catch (error) {
        failure = errorCode(error);
        repository.recordSyncFailure(sectionId, failure, now());
      }
      const state = repository.syncState(sectionId);
      return { sectionId, phase: state.phase, snapshotComplete: state.snapshotComplete, errorCode: failure };
    },
    async deliverNotices() {
      let delivered = 0;
      for (const notice of repository.pendingNotices()) {
        try {
          await notifier.notify({ noticeKey: notice.noticeKey, kind: notice.kind, bugKey: notice.bugKey, commentId: notice.commentServerId });
        } catch {
          continue;
        }
        repository.markNoticed(notice.noticeKey, now());
        delivered++;
      }
      return delivered;
    },
    registerSections: ensureSections,
    async runCycle() {
      const configured = new Set(views().map(section => section.sectionId));
      for (const section of repository.sections()) {
        if (configured.has(section.sectionId)) await syncer.pullSection(section.sectionId);
      }
      await syncer.deliverNotices();
    },
  };
  return syncer;
}

export interface BugSyncServiceOptions {
  readonly orchestratorRoot: string;
  readonly homeDirectory: string;
  readonly stateDirectory: string;
  readonly now: () => number;
  readonly schedule: (at: number, wake: () => Promise<void>) => () => void;
  readonly notifier: MainNotifier;
  readonly server?: BugServerPort;
  readonly onError?: (error: unknown) => void;
}

export interface BugSyncService {
  readonly syncer: BugSyncer;
  readonly repository: BugRepository;
  stop(): Promise<void>;
}

export async function startBugSyncService(options: BugSyncServiceOptions): Promise<BugSyncService | null> {
  const settings = JSON.parse(await readFile(join(options.orchestratorRoot, 'conf', 'raf.json'), 'utf8'));
  if (!plainObject(settings) || settings.bugs === undefined) return null;
  const config = loadBugSyncConfig(settings.bugs);
  const clock: Clock = { now: () => new Date(options.now()) };
  const secrets = await openSecretsStore({ home: options.homeDirectory });
  const repository = openBugStore(resolveBugStorePath(options.stateDirectory, config.fileName));
  const report = options.onError ?? ((error: unknown) => process.emitWarning(error instanceof Error ? error : String(error)));
  let syncer: BugSyncer;
  try {
    syncer = createBugSyncer({
      repository, server: options.server ?? createHttpBugServer(), claims: createClaimsIssuer({ secrets, config, clock }),
      notifier: options.notifier, clock, config,
    });
    syncer.registerSections();
  } catch (error) {
    repository.close();
    throw error;
  }
  let stopped = false;
  let cancel: (() => void) | undefined;
  let running: Promise<void> | undefined;
  const wake = async () => {
    cancel = undefined;
    if (stopped) return;
    running = measureRafCost('bug-sync', () => syncer.runCycle()).catch(report);
    await running;
    running = undefined;
    if (!stopped) cancel = options.schedule(options.now() + config.pollIntervalMs, wake);
  };
  cancel = options.schedule(options.now(), wake);
  return {
    syncer,
    repository,
    async stop() {
      if (stopped) return;
      stopped = true;
      cancel?.();
      cancel = undefined;
      await running;
      repository.close();
    },
  };
}

export type BugMcpTool = 'read_bug' | 'comment_problem' | 'set_problem_status';

export interface BugMcpPort {
  call(auth: ServerAuth, tool: BugMcpTool, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export const BUG_MCP_PROTOCOL_VERSION = '2025-11-25';
const BUG_MCP_PATH = '/internal/mcp/bugs';
const SERVER_CODE = /^[a-z][a-z0-9-]{0,63}$/;

function rpcPayload(raw: string, contentType: string | null): unknown {
  const parse = (value: string) => { try { return JSON.parse(value); } catch { return undefined; } };
  if (!(contentType ?? '').toLowerCase().includes('text/event-stream')) return parse(raw);
  let last: unknown;
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (data) last = parse(data) ?? last;
  }
  return last;
}

function toolFailure(content: Record<string, unknown>): BugServerError {
  const code = typeof content.error === 'string' && SERVER_CODE.test(content.error) ? content.error : 'tool-error';
  const status = typeof content.status === 'number' && Number.isSafeInteger(content.status) ? content.status : null;
  const after = content.retry_after ?? content.retryAfter;
  const retryAfterMs = typeof after === 'number' && Number.isFinite(after) && after >= 0 ? after * 1000 : null;
  return new BugServerError(status, code, `Dash MCP refused the call: ${code}`, retryAfterMs);
}

export function createHttpBugMcp(options: { readonly fetch?: typeof fetch } = {}): BugMcpPort {
  const fetcher = options.fetch ?? globalThis.fetch;
  let sequence = 0;
  return {
    async call(auth, tool, args) {
      const id = ++sequence;
      let response: Response;
      try {
        response = await fetcher(`${auth.origin.replace(/\/$/, '')}${BUG_MCP_PATH}`, {
          method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(auth.timeoutMs),
          headers: {
            'x-bugs-contract-version': '2', authorization: `Bearer ${auth.token}`, 'content-type': 'application/json',
            accept: 'application/json, text/event-stream', 'mcp-protocol-version': BUG_MCP_PROTOCOL_VERSION,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }),
        });
      } catch (error) {
        const name = (error as { name?: string })?.name;
        throw new BugServerError(null, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', 'Dash MCP request failed');
      }
      let raw: string;
      try { raw = await response.text(); }
      catch (error) {
        const name = (error as { name?: string })?.name;
        throw new BugServerError(null, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', 'Dash MCP response was interrupted');
      }
      const body = rpcPayload(raw, response.headers.get('content-type'));
      if (!response.ok) {
        const details = plainObject(body) ? body : {};
        const code = typeof details.error === 'string' && SERVER_CODE.test(details.error) ? details.error : `http-${response.status}`;
        throw new BugServerError(response.status, code, `Dash MCP responded ${response.status} ${code}`, retryAfter(response, details));
      }
      if (!plainObject(body) || body.jsonrpc !== '2.0' || body.id !== id) invalidResponse('Dash MCP returned an invalid JSON-RPC response');
      if (body.error !== undefined) {
        const message = plainObject(body.error) && typeof body.error.message === 'string' && SERVER_CODE.test(body.error.message) ? body.error.message : 'rpc-error';
        throw new BugServerError(null, message, `Dash MCP rejected the request: ${message}`);
      }
      const result = body.result;
      if (!plainObject(result)) invalidResponse('Dash MCP response lacks a result');
      let content: unknown = result.structuredContent;
      if (content === undefined && Array.isArray(result.content)) {
        const first = result.content.find(item => plainObject(item) && item.type === 'text' && typeof item.text === 'string') as { text: string } | undefined;
        if (first) { try { content = JSON.parse(first.text); } catch { content = result.isError === true ? { error: first.text } : undefined; } }
      }
      if (result.isError === true) throw toolFailure(plainObject(content) ? content : {});
      if (!plainObject(content)) invalidResponse('Dash MCP result lacks structured content');
      return content;
    },
  };
}

export type BugWriteErrorCode = 'BUG_WRITE_UNKNOWN' | 'BUG_WRITE_REJECTED' | 'BUG_WRITE_INVALID_RESPONSE' | 'BUG_WRITE_REPLY_TARGET_MISSING';

export interface BugWriteErrorFacts {
  readonly serverCode?: string | null;
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
}

export class BugWriteError extends Error {
  readonly code: BugWriteErrorCode;
  readonly serverCode: string | null;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(code: BugWriteErrorCode, message: string, facts: BugWriteErrorFacts = {}) {
    super(message);
    this.name = 'BugWriteError';
    this.code = code;
    this.serverCode = facts.serverCode ?? null;
    this.status = facts.status ?? null;
    this.retryAfterMs = facts.retryAfterMs ?? null;
  }
}

export interface BugWriterDependencies {
  readonly repository: BugRepository;
  readonly mcp: BugMcpPort;
  readonly claims: ClaimsIssuer;
  readonly clock: Clock;
  readonly config: BugSyncConfig;
  readonly newOperationId?: () => string;
}

export interface CommentWriteInput {
  readonly bugKey: string;
  readonly text: string;
}

export interface StatusWriteInput {
  readonly bugKey: string;
  readonly status: string;
}

export interface CommentWriteResult {
  readonly bugKey: string;
  readonly operationId: string;
  readonly commentId: string;
  readonly revision: number;
  readonly comment: CommentView;
  readonly bug: BugView;
}

export interface StatusWriteResult {
  readonly bugKey: string;
  readonly operationId: string;
  readonly revision: number;
  readonly status: string;
  readonly bug: BugView;
}

export interface BugWriter {
  addComment(input: CommentWriteInput): Promise<CommentWriteResult>;
  setStatus(input: StatusWriteInput): Promise<StatusWriteResult>;
}

interface FreshBug {
  readonly detail: ServerBugDetailPage;
  readonly raw: Record<string, unknown>;
}

function writeFailure(error: unknown, stage: 'read' | 'write'): never {
  if (error instanceof BugWriteError || error instanceof ClaimsError) throw error;
  if (error instanceof BugServerError) {
    if (error.code === 'invalid-response') {
      throw new BugWriteError('BUG_WRITE_INVALID_RESPONSE', `Dash MCP returned an invalid ${stage === 'read' ? 'read_bug' : 'write'} response`);
    }
    const facts = { serverCode: error.code, status: error.status, retryAfterMs: error.retryAfterMs };
    const transport = error.status === null ? ['network', 'timeout'].includes(error.code) : error.status >= 500 && error.code.startsWith('http-');
    if (transport) {
      throw new BugWriteError('BUG_WRITE_UNKNOWN', stage === 'read'
        ? `Dash MCP is unreachable (${error.code}); nothing was written`
        : `The outcome of the write is unknown (${error.code}); if Dash applied it, the next sync brings it`, facts);
    }
    throw new BugWriteError('BUG_WRITE_REJECTED', `Dash refused the ${stage}: ${error.code}`, facts);
  }
  throw error;
}

function receiptInvalid(message: string): never {
  throw new BugWriteError('BUG_WRITE_INVALID_RESPONSE', `Dash MCP returned an invalid write receipt: ${message}`);
}

function sameKey(left: ServerBugKey, right: ServerBugKey): boolean {
  return left.project === right.project && left.env === right.env && left.source === right.source && left.owner === right.owner && left.rawId === right.rawId;
}

function mapComment(value: unknown): ServerComment {
  if (!plainObject(value) || typeof value.id !== 'string' || !value.id) receiptInvalid('comment lacks an id');
  if (typeof value.text !== 'string' || typeof value.created_at !== 'string' || typeof value.author_id !== 'string') receiptInvalid('comment lacks text, author or time');
  return {
    id: value.id, authorId: value.author_id, authorKind: String(value.author_kind ?? ''), text: value.text,
    replyTo: typeof value.reply_to === 'string' ? value.reply_to : null, createdAt: value.created_at, payload: value,
  };
}

export function createBugWriter(dependencies: BugWriterDependencies): BugWriter {
  const { repository, mcp, claims, clock, config } = dependencies;
  const newOperationId = dependencies.newOperationId ?? randomUUID;

  function target(bugKey: string): { bug: BugView; section: BugSectionView } {
    const bug = repository.findBug(bugKey);
    const entry = config.sections.find(item => bugSectionId(item) === bug.sectionId);
    if (!entry) throw new BugStoreError('unknown-section', `Section ${bug.sectionId} of ${bug.key} is not configured in conf/raf.json#/bugs/sections`, { sectionId: bug.sectionId });
    const draft = describeBugSection(config, entry, '');
    return { bug, section: describeBugSection(config, entry, claims.fingerprint(draft, 'read')) };
  }

  async function auth(section: BugSectionView, scope: ClaimsScope): Promise<ServerAuth> {
    const issued = await claims.issue(section, scope);
    return { origin: config.origin, project: section.project, env: section.env, token: issued.token, timeoutMs: config.requestTimeoutMs };
  }

  async function readFresh(section: BugSectionView, bug: BugView, allComments: boolean): Promise<FreshBug> {
    const access = await auth(section, 'read');
    const comments: ServerComment[] = [];
    let first: FreshBug | undefined;
    let commentsCursor: string | null = null;
    try {
      do {
        const args: Record<string, unknown> = { id: bug.problemId, limit: config.pageLimit, ...(commentsCursor ? { commentsCursor } : {}) };
        const raw = await mcp.call(access, 'read_bug', args);
        if (!plainObject(raw)) invalidResponse('read_bug result must be an object');
        const detail = mapDetail(raw, section);
        if (!sameKey(detail.bug.key, bug.serverKey)) invalidResponse('read_bug returned another bug');
        if (!first) first = { detail, raw };
        else if (detail.bug.revision !== first.detail.bug.revision) break;
        comments.push(...detail.comments);
        commentsCursor = allComments ? detail.nextCommentsCursor : null;
      } while (commentsCursor !== null);
    } catch (error) {
      writeFailure(error, 'read');
    }
    return { detail: { ...first!.detail, comments }, raw: first!.raw };
  }

  function ownLease(fresh: FreshBug): string | null {
    const raw = fresh.raw;
    const expires = typeof raw.claim_expires_at === 'string' ? Date.parse(raw.claim_expires_at) : Number.NaN;
    if (raw.claimed_by !== config.actor || typeof raw.claim_token !== 'string' || !raw.claim_token) return null;
    return Number.isFinite(expires) && expires > clock.now().getTime() ? raw.claim_token : null;
  }

  async function mutate(section: BugSectionView, tool: 'comment_problem' | 'set_problem_status', args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const access = await auth(section, 'write');
    let receipt: unknown;
    try { receipt = await mcp.call(access, tool, args); }
    catch (error) { writeFailure(error, 'write'); }
    if (!plainObject(receipt)) receiptInvalid('not an object');
    return receipt;
  }

  function receiptHeader(receipt: Record<string, unknown>, bug: BugView, section: BugSectionView, operationId: string): WrittenBugHeader {
    if (receipt.contract_version !== 2) receiptInvalid('contract_version is not 2');
    if (receipt.ok !== true) receiptInvalid('ok is not true');
    if (receipt.problem_id !== bug.problemId) receiptInvalid('problem_id does not match the bug');
    if (receipt.operation_id !== operationId) receiptInvalid('operation_id does not match the request');
    const revision = receipt.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) receiptInvalid('revision is not a non-negative integer');
    if (!plainObject(receipt.bug)) receiptInvalid('bug is missing');
    if (receipt.bug.revision !== revision) receiptInvalid('bug.revision differs from revision');
    let page: ServerBugDetailPage;
    try { page = mapDetail(receipt.bug, section); }
    catch { receiptInvalid('bug lacks key or revision'); }
    if (!sameKey(page.bug.key, bug.serverKey)) receiptInvalid('bug belongs to another key');
    if (typeof receipt.bug.status !== 'string' || !receipt.bug.status || typeof receipt.bug.state !== 'string') receiptInvalid('bug lacks status or state');
    return page.bug;
  }

  function store(bug: BugView, header: WrittenBugHeader, comment: ServerComment | null): BugView {
    return repository.applyWriteReceipt({ bugKey: bug.key, bug: header, comment, at: clock.now().toISOString() });
  }

  return {
    async addComment(input) {
      const body = typeof input?.text === 'string' ? input.text : '';
      if (!body.trim() || body.includes('\0')) throw new BugStoreError('invalid-comment', 'Comment text must be non-empty', {});
      const { bug, section } = target(input.bugKey);
      const peek = await readFresh(section, bug, false);
      const claimedBy = peek.detail.bug.claimedBy;
      const foreign = claimedBy !== null && claimedBy !== config.actor;
      const fresh = foreign && peek.detail.nextCommentsCursor !== null ? await readFresh(section, bug, true) : peek;
      let replyTo: string | null = null;
      if (foreign) {
        const owned = fresh.detail.comments.filter(comment => comment.authorId === claimedBy);
        const last = owned.reduce<ServerComment | null>((latest, comment) => !latest || comment.createdAt >= latest.createdAt ? comment : latest, null);
        if (!last) {
          throw new BugWriteError('BUG_WRITE_REPLY_TARGET_MISSING',
            `Bug ${bug.key} is claimed by ${claimedBy}, who has no comment to reply to; nothing was written`, { serverCode: null });
        }
        replyTo = last.id;
      }
      const claimToken = ownLease(fresh);
      const operationId = newOperationId();
      const receipt = await mutate(section, 'comment_problem', {
        problem_id: bug.problemId, operation_id: operationId, expected_revision: fresh.detail.bug.revision, comment: body,
        ...(replyTo ? { reply_to: replyTo } : {}), ...(claimToken ? { claimToken } : {}),
      });
      const header = receiptHeader(receipt, bug, section, operationId);
      if (typeof receipt.comment_id !== 'string' || !receipt.comment_id) receiptInvalid('comment_id is missing');
      if (!plainObject(receipt.comment) || receipt.comment.id !== receipt.comment_id) receiptInvalid('comment.id differs from comment_id');
      const comment = mapComment(receipt.comment);
      const view = store(bug, header, comment);
      const written = view.comments.find(item => item.serverId === comment.id);
      if (!written) throw new BugStoreError('invalid-receipt', `Comment ${comment.id} was not recorded locally`, { bugKey: bug.key });
      return { bugKey: view.key, operationId, commentId: comment.id, revision: header.revision, comment: written, bug: view };
    },
    async setStatus(input) {
      const status = typeof input?.status === 'string' ? input.status : '';
      if (!status.trim() || status !== status.trim() || status.includes('\0')) {
        throw new BugWriteError('BUG_WRITE_REJECTED', 'Status must be a non-empty bugs-api status', { serverCode: 'invalid-input' });
      }
      const { bug, section } = target(input.bugKey);
      const fresh = await readFresh(section, bug, false);
      const claimToken = ownLease(fresh);
      const operationId = newOperationId();
      const receipt = await mutate(section, 'set_problem_status', {
        problem_id: bug.problemId, operation_id: operationId, expected_revision: fresh.detail.bug.revision, status,
        ...(claimToken ? { claimToken } : {}),
      });
      const header = receiptHeader(receipt, bug, section, operationId);
      const view = store(bug, header, null);
      return { bugKey: view.key, operationId, revision: header.revision, status: header.status, bug: view };
    },
  };
}
