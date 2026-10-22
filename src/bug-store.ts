import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BUG_STORE_SCHEMA_VERSION = 1;

export type BugPresence = 'present' | 'deleted' | 'missing';
export type SyncPhase = 'initial' | 'snapshot' | 'incremental' | 'resync';
export type OutboxState = 'pending' | 'sending' | 'unknown' | 'delivered' | 'conflict';
export type ConflictKind = 'bug-deleted' | 'bug-missing' | 'conflict-409' | 'access' | 'claims-changed';
export type CommentOrigin = 'server' | 'local';
export type AttachmentCacheState = 'absent' | 'fetching' | 'ready';

export type BugStoreErrorCode =
  | 'unsafe-path'
  | 'unsupported-version'
  | 'unknown-section'
  | 'invalid-bug-key'
  | 'bug-not-found'
  | 'ambiguous-bug'
  | 'invalid-comment'
  | 'operation-not-found'
  | 'invalid-cursor';

export class BugStoreError extends Error {
  readonly code: BugStoreErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: BugStoreErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'BugStoreError';
    this.code = code;
    this.details = details;
  }
}

export interface ServerBugKey {
  readonly project: string;
  readonly env: string;
  readonly source: string;
  readonly owner: string;
  readonly rawId: string;
}

export interface CanonicalBugKey {
  readonly canonicalProject: string;
  readonly rawId: string;
}

export interface ServerComment {
  readonly id: string;
  readonly authorId: string;
  readonly authorKind: string;
  readonly text: string;
  readonly replyTo: string | null;
  readonly createdAt: string;
  readonly payload: unknown;
}

export interface ServerAttachment {
  readonly id: string;
  readonly commentId: string | null;
  readonly kind: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ServerBugDetail {
  readonly key: ServerBugKey;
  readonly problemId: string;
  readonly revision: number;
  readonly status: string;
  readonly state: string;
  readonly createdAt: string;
  readonly claimedBy: string | null;
  readonly payload: unknown;
  readonly comments: readonly ServerComment[];
  readonly attachments: readonly ServerAttachment[];
  readonly complete: boolean;
  readonly errorCode: string | null;
}

export interface BugSectionInput {
  readonly sectionId: string;
  readonly project: string;
  readonly env: string;
  readonly stand: string;
  readonly canonicalProject: string;
  readonly origin: string;
  readonly actor: string;
  readonly claimsFingerprint: string;
}

export type BugSectionView = BugSectionInput;

export interface SyncStateView {
  readonly sectionId: string;
  readonly phase: SyncPhase;
  readonly journalCursor: string;
  readonly snapshotHead: string | null;
  readonly listCursor: string | null;
  readonly listClaimsFingerprint: string | null;
  readonly snapshotComplete: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastErrorCode: string | null;
  readonly consecutiveFailures: number;
}

export interface SyncPosition {
  readonly phase?: SyncPhase;
  readonly journalCursor?: string;
  readonly snapshotHead?: string | null;
  readonly listCursor?: string | null;
  readonly listClaimsFingerprint?: string | null;
  readonly snapshotComplete?: boolean;
}

export interface PullBatch {
  readonly sectionId: string;
  readonly details: readonly ServerBugDetail[];
  readonly deleted: readonly ServerBugKey[];
  readonly missing: readonly ServerBugKey[];
  readonly position: SyncPosition;
  readonly at: string;
}

export interface ConflictView {
  readonly operationId: string;
  readonly bugKey: string;
  readonly kind: ConflictKind;
  readonly observed: unknown;
  readonly detectedAt: string;
  readonly noticeKey: string;
  readonly noticedAt: string | null;
}

export interface PullBatchResult {
  readonly conflicts: readonly ConflictView[];
  readonly linkCandidates: readonly string[];
}

export interface DeliveryView {
  readonly operationId: string;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly lastStatus: number | null;
  readonly serverCommentId: string | null;
  readonly linkResolved: boolean;
  readonly conflict: ConflictKind | null;
}

export interface CommentView {
  readonly commentPk: number;
  readonly serverId: string | null;
  readonly origin: CommentOrigin;
  readonly authorId: string;
  readonly authorKind: string;
  readonly text: string;
  readonly replyTo: string | null;
  readonly createdAt: string;
  readonly delivery: DeliveryView | null;
}

export interface AttachmentView {
  readonly serverId: string;
  readonly commentServerId: string | null;
  readonly kind: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly presence: BugPresence;
  readonly cacheState: AttachmentCacheState;
}

export interface BugView {
  readonly key: string;
  readonly serverKey: ServerBugKey;
  readonly sectionId: string;
  readonly problemId: string;
  readonly revision: number;
  readonly status: string;
  readonly state: string;
  readonly claimedBy: string | null;
  readonly presence: BugPresence;
  readonly presenceAt: string | null;
  readonly detailComplete: boolean;
  readonly detailErrorCode: string | null;
  readonly payload: unknown;
  readonly syncedAt: string | null;
  readonly comments: readonly CommentView[];
  readonly attachments: readonly AttachmentView[];
  readonly conflicts: readonly ConflictView[];
}

export interface BugSummaryView {
  readonly key: string;
  readonly sectionId: string;
  readonly revision: number;
  readonly status: string;
  readonly presence: BugPresence;
  readonly pendingOperations: number;
  readonly conflicts: number;
}

export interface BugListFilter {
  readonly canonicalProject?: string;
  readonly status?: string;
  readonly cursor?: string | null;
  readonly limit: number;
}

export interface BugListPage {
  readonly bugs: readonly BugSummaryView[];
  readonly nextCursor: string | null;
  readonly sync: readonly SyncStateView[];
}

export interface LocalCommentInput {
  readonly bugKey: string;
  readonly text: string;
  readonly authorId: string;
  readonly authorKind: string;
  readonly claimsFingerprint: string;
  readonly at: string;
}

export interface LocalCommentReceipt {
  readonly bugKey: string;
  readonly commentPk: number;
  readonly operationId: string;
  readonly state: 'pending';
  readonly delivered: false;
  readonly expectedRevision: number;
  readonly replyTo: string | null;
}

export interface CommentRequestBody {
  readonly operation_id: string;
  readonly expected_revision: number;
  readonly text: string;
  readonly reply_to?: string;
}

export interface OutboxView {
  readonly operationId: string;
  readonly kind: 'comment.add';
  readonly bugKey: string;
  readonly serverKey: ServerBugKey;
  readonly sectionId: string;
  readonly commentPk: number;
  readonly requestJson: string;
  readonly expectedRevision: number;
  readonly claimsFingerprint: string;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastStatus: number | null;
  readonly serverCommentId: string | null;
  readonly deliveredRevision: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SendFailure {
  readonly status: number | null;
  readonly code: string;
  readonly nextAttemptAt: string;
  readonly at: string;
}

export interface DeliveryConfirmation {
  readonly serverCommentId: string | null;
  readonly revision: number;
  readonly at: string;
}

export interface ConflictInput {
  readonly kind: ConflictKind;
  readonly observed: unknown;
  readonly status: number | null;
  readonly at: string;
}

export interface BugStoreOptions {
  readonly beforeOutboxInsert?: () => void;
}

export interface BugRepository {
  readonly path: string;
  readonly database: DatabaseSync;
  schemaVersion(): number;
  upsertSection(section: BugSectionInput): void;
  sections(): readonly BugSectionView[];
  syncState(sectionId: string): SyncStateView;
  recordSyncAttempt(sectionId: string, at: string): void;
  recordSyncFailure(sectionId: string, code: string, at: string): void;
  applyPullBatch(batch: PullBatch): PullBatchResult;
  presentBugKeys(sectionId: string): readonly ServerBugKey[];
  findBug(canonicalKey: string): BugView;
  listBugs(filter: BugListFilter): BugListPage;
  addLocalComment(input: LocalCommentInput): LocalCommentReceipt;
  outbox(operationId: string): OutboxView | undefined;
  listOutbox(): readonly OutboxView[];
  dueOperations(at: string): readonly OutboxView[];
  markSending(operationId: string, at: string): boolean;
  markUnknown(operationId: string, failure: SendFailure): void;
  confirmDelivery(operationId: string, confirmation: DeliveryConfirmation): void;
  markConflict(operationId: string, conflict: ConflictInput): ConflictView;
  recoverInterruptedSends(at: string): number;
  conflicts(): readonly ConflictView[];
  pendingNotices(): readonly ConflictView[];
  markNoticed(noticeKey: string, at: string): void;
  close(): void;
}

const CANONICAL_KEY = /^(projects\/[a-z0-9][a-z0-9._-]*)\/bug#([^\s#/\\\0]+)$/;
const ACTIVE_STATES: readonly OutboxState[] = ['pending', 'unknown'];

export function parseCanonicalBugKey(value: string): CanonicalBugKey {
  const match = typeof value === 'string' ? CANONICAL_KEY.exec(value) : null;
  if (!match) throw new BugStoreError('invalid-bug-key', 'Bug key must have the form projects/<project>/bug#<number>', { received: value });
  return { canonicalProject: match[1], rawId: match[2] };
}

export function formatCanonicalBugKey(key: CanonicalBugKey): string {
  const value = `${key?.canonicalProject}/bug#${key?.rawId}`;
  parseCanonicalBugKey(value);
  return value;
}

export function resolveBugStorePath(rafHome: string, fileName: string): string {
  if (typeof rafHome !== 'string' || !isAbsolute(rafHome) || rafHome.includes('\0')) {
    throw new BugStoreError('unsafe-path', 'The raf home directory must be an absolute path', { rafHome });
  }
  if (typeof fileName !== 'string' || !fileName || ['.', '..'].includes(fileName) || basename(fileName) !== fileName || /[\\/\0]/.test(fileName)) {
    throw new BugStoreError('unsafe-path', 'The bug database file name must be a plain file name', { fileName });
  }
  return join(rafHome, fileName);
}

type Row = Record<string, unknown>;

const SCHEMA_V1 = `
  CREATE TABLE sections (
    section_id TEXT PRIMARY KEY NOT NULL,
    project TEXT NOT NULL,
    env TEXT NOT NULL,
    stand TEXT NOT NULL,
    canonical_project TEXT NOT NULL,
    origin TEXT NOT NULL,
    actor TEXT NOT NULL,
    claims_fingerprint TEXT NOT NULL,
    UNIQUE(project, env)
  ) STRICT;
  CREATE TABLE sync_state (
    section_id TEXT PRIMARY KEY NOT NULL REFERENCES sections(section_id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK(phase IN ('initial', 'snapshot', 'incremental', 'resync')),
    journal_cursor TEXT NOT NULL DEFAULT '0',
    snapshot_head TEXT,
    list_cursor TEXT,
    list_claims_fingerprint TEXT,
    snapshot_complete INTEGER NOT NULL DEFAULT 0 CHECK(snapshot_complete IN (0, 1)),
    last_success_at TEXT,
    last_attempt_at TEXT,
    last_error_code TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE bugs (
    bug_pk INTEGER PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES sections(section_id),
    project TEXT NOT NULL,
    env TEXT NOT NULL,
    source TEXT NOT NULL,
    owner TEXT NOT NULL,
    raw_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    canonical_project TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    state TEXT NOT NULL,
    claimed_by TEXT,
    payload TEXT,
    server_created_at TEXT,
    detail_revision INTEGER,
    detail_complete INTEGER NOT NULL DEFAULT 0 CHECK(detail_complete IN (0, 1)),
    detail_error_code TEXT,
    presence TEXT NOT NULL CHECK(presence IN ('present', 'deleted', 'missing')),
    presence_at TEXT,
    synced_at TEXT,
    UNIQUE(project, env, source, owner, raw_id)
  ) STRICT;
  CREATE INDEX bugs_canonical ON bugs(canonical_project, raw_id);
  CREATE INDEX bugs_section_status ON bugs(section_id, status);
  CREATE TABLE comments (
    comment_pk INTEGER PRIMARY KEY,
    bug_pk INTEGER NOT NULL REFERENCES bugs(bug_pk) ON DELETE CASCADE,
    server_id TEXT,
    origin TEXT NOT NULL CHECK(origin IN ('server', 'local')),
    operation_id TEXT UNIQUE,
    link_candidate_operation_id TEXT,
    author_id TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT,
    created_at TEXT NOT NULL,
    payload TEXT
  ) STRICT;
  CREATE UNIQUE INDEX comments_server_id ON comments(bug_pk, server_id) WHERE server_id IS NOT NULL;
  CREATE INDEX comments_candidate ON comments(link_candidate_operation_id) WHERE link_candidate_operation_id IS NOT NULL;
  CREATE TABLE attachments (
    attachment_pk INTEGER PRIMARY KEY,
    bug_pk INTEGER NOT NULL REFERENCES bugs(bug_pk) ON DELETE CASCADE,
    comment_pk INTEGER REFERENCES comments(comment_pk) ON DELETE SET NULL,
    server_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    presence TEXT NOT NULL CHECK(presence IN ('present', 'deleted', 'missing')),
    cache_state TEXT NOT NULL DEFAULT 'absent' CHECK(cache_state IN ('absent', 'fetching', 'ready')),
    cache_file TEXT,
    cache_bytes INTEGER,
    cache_sha256 TEXT,
    last_read_at TEXT,
    fetch_owner TEXT,
    fetch_started_at TEXT,
    UNIQUE(bug_pk, server_id)
  ) STRICT;
  CREATE INDEX attachments_lru ON attachments(cache_state, last_read_at);
  CREATE TABLE outbox (
    operation_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('comment.add')),
    bug_pk INTEGER NOT NULL REFERENCES bugs(bug_pk),
    comment_pk INTEGER NOT NULL UNIQUE REFERENCES comments(comment_pk),
    section_id TEXT NOT NULL REFERENCES sections(section_id),
    request_json TEXT NOT NULL,
    expected_revision INTEGER NOT NULL,
    claims_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'unknown', 'delivered', 'conflict')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error_code TEXT,
    last_status INTEGER,
    server_comment_id TEXT,
    delivered_revision INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER outbox_request_immutable BEFORE UPDATE OF request_json, operation_id, comment_pk, bug_pk ON outbox
  WHEN NEW.request_json IS NOT OLD.request_json OR NEW.operation_id IS NOT OLD.operation_id OR NEW.comment_pk IS NOT OLD.comment_pk OR NEW.bug_pk IS NOT OLD.bug_pk
  BEGIN SELECT RAISE(ABORT, 'outbox request is immutable'); END;
  CREATE TABLE conflicts (
    operation_id TEXT PRIMARY KEY NOT NULL REFERENCES outbox(operation_id),
    kind TEXT NOT NULL CHECK(kind IN ('bug-deleted', 'bug-missing', 'conflict-409', 'access', 'claims-changed')),
    observed TEXT,
    detected_at TEXT NOT NULL,
    notice_key TEXT NOT NULL UNIQUE,
    noticed_at TEXT
  ) STRICT;
`;

const MIGRATIONS: readonly string[] = [SCHEMA_V1];

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function noticeKey(operationId: string, kind: ConflictKind): string {
  return `bug-conflict:${operationId}:${kind}`;
}

function serverKey(row: Row): ServerBugKey {
  return { project: String(row.project), env: String(row.env), source: String(row.source), owner: String(row.owner), rawId: String(row.raw_id) };
}

function canonicalOf(row: Row): string {
  return `${row.canonical_project}/bug#${row.raw_id}`;
}

export function openBugStore(path: string, options: BugStoreOptions = {}): BugRepository {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0') || (path !== ':memory:' && !isAbsolute(path))) {
    throw new BugStoreError('unsafe-path', 'An absolute bug database path is required', { path });
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 250 });

  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  const version = () => Number(db.prepare('PRAGMA user_version').get()?.user_version);

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const journal = db.prepare('PRAGMA journal_mode').get();
        if (journal?.journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL');
        break;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (attempt >= 4 || (code !== 5 && code !== 6)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL');
    const unsupported = () => new BugStoreError('unsupported-version', 'The bug database schema is newer than this raf supports', { found: version(), supported: BUG_STORE_SCHEMA_VERSION });
    if (version() > BUG_STORE_SCHEMA_VERSION) throw unsupported();
    if (version() < BUG_STORE_SCHEMA_VERSION) {
      transaction(() => {
        const current = version();
        if (current > BUG_STORE_SCHEMA_VERSION) throw unsupported();
        for (let step = current; step < BUG_STORE_SCHEMA_VERSION; step++) {
          db.exec(MIGRATIONS[step]);
          db.exec(`PRAGMA user_version = ${step + 1}`);
        }
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const get = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...(params as never[])) as Row | undefined;
  const all = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...(params as never[])) as Row[];
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...(params as never[]));

  function sectionRow(sectionId: string): Row {
    const row = get('SELECT * FROM sections WHERE section_id = ?', sectionId);
    if (!row) throw new BugStoreError('unknown-section', `Unknown bug section ${sectionId}`, { sectionId });
    return row;
  }

  function syncView(row: Row): SyncStateView {
    return {
      sectionId: String(row.section_id), phase: row.phase as SyncPhase, journalCursor: String(row.journal_cursor),
      snapshotHead: text(row.snapshot_head), listCursor: text(row.list_cursor), listClaimsFingerprint: text(row.list_claims_fingerprint),
      snapshotComplete: row.snapshot_complete === 1, lastSuccessAt: text(row.last_success_at), lastAttemptAt: text(row.last_attempt_at),
      lastErrorCode: text(row.last_error_code), consecutiveFailures: Number(row.consecutive_failures),
    };
  }

  function conflictView(row: Row): ConflictView {
    return {
      operationId: String(row.operation_id), bugKey: canonicalOf(row), kind: row.kind as ConflictKind, observed: parsed(row.observed),
      detectedAt: String(row.detected_at), noticeKey: String(row.notice_key), noticedAt: text(row.noticed_at),
    };
  }

  const CONFLICT_SELECT = `SELECT c.*, b.canonical_project, b.raw_id FROM conflicts c JOIN outbox o ON o.operation_id = c.operation_id JOIN bugs b ON b.bug_pk = o.bug_pk`;

  function outboxView(row: Row): OutboxView {
    return {
      operationId: String(row.operation_id), kind: 'comment.add', bugKey: canonicalOf(row), serverKey: serverKey(row),
      sectionId: String(row.section_id), commentPk: Number(row.comment_pk), requestJson: String(row.request_json),
      expectedRevision: Number(row.expected_revision), claimsFingerprint: String(row.claims_fingerprint), state: row.state as OutboxState,
      attempts: Number(row.attempts), nextAttemptAt: text(row.next_attempt_at), lastErrorCode: text(row.last_error_code),
      lastStatus: row.last_status === null || row.last_status === undefined ? null : Number(row.last_status),
      serverCommentId: text(row.server_comment_id),
      deliveredRevision: row.delivered_revision === null || row.delivered_revision === undefined ? null : Number(row.delivered_revision),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  const OUTBOX_SELECT = `SELECT o.*, b.project, b.env, b.source, b.owner, b.raw_id, b.canonical_project FROM outbox o JOIN bugs b ON b.bug_pk = o.bug_pk`;

  function outboxRow(operationId: string): Row {
    const row = get(`${OUTBOX_SELECT} WHERE o.operation_id = ?`, operationId);
    if (!row) throw new BugStoreError('operation-not-found', `Unknown outbox operation ${operationId}`, { operationId });
    return row;
  }

  function writeConflict(operationId: string, input: ConflictInput): ConflictView {
    const key = noticeKey(operationId, input.kind);
    const existing = get('SELECT notice_key FROM conflicts WHERE operation_id = ?', operationId);
    if (existing?.notice_key === key) {
      run('UPDATE conflicts SET observed = ? WHERE operation_id = ?', json(input.observed), operationId);
    } else {
      run('DELETE FROM conflicts WHERE operation_id = ?', operationId);
      run('INSERT INTO conflicts(operation_id, kind, observed, detected_at, notice_key, noticed_at) VALUES (?, ?, ?, ?, ?, NULL)',
        operationId, input.kind, json(input.observed), input.at, key);
    }
    run(`UPDATE outbox SET state = 'conflict', last_status = ?, last_error_code = ?, next_attempt_at = NULL, updated_at = ? WHERE operation_id = ?`,
      input.status, input.kind, input.at, operationId);
    if (input.kind === 'conflict-409') run('UPDATE comments SET link_candidate_operation_id = NULL WHERE link_candidate_operation_id = ?', operationId);
    return conflictView(get(`${CONFLICT_SELECT} WHERE c.operation_id = ?`, operationId)!);
  }

  function findBugRow(canonicalKey: string): Row {
    const key = parseCanonicalBugKey(canonicalKey);
    const rows = all('SELECT * FROM bugs WHERE canonical_project = ? AND raw_id = ?', key.canonicalProject, key.rawId);
    if (!rows.length) throw new BugStoreError('bug-not-found', `Bug ${canonicalKey} is not in the local bug database`, { bugKey: canonicalKey });
    if (rows.length > 1) {
      throw new BugStoreError('ambiguous-bug', `Bug key ${canonicalKey} matches several server records`, {
        bugKey: canonicalKey, candidates: rows.map(row => serverKey(row)),
      });
    }
    return rows[0];
  }

  function deliveryFor(comment: Row): DeliveryView | null {
    const operationId = text(comment.operation_id);
    if (!operationId) return null;
    const row = get('SELECT o.*, c.kind AS conflict_kind FROM outbox o LEFT JOIN conflicts c ON c.operation_id = o.operation_id WHERE o.operation_id = ?', operationId);
    if (!row) return null;
    return {
      operationId, state: row.state as OutboxState, attempts: Number(row.attempts), lastErrorCode: text(row.last_error_code),
      lastStatus: row.last_status === null ? null : Number(row.last_status), serverCommentId: text(row.server_comment_id),
      linkResolved: false, conflict: (row.conflict_kind ?? null) as ConflictKind | null,
    };
  }

  function bugView(row: Row): BugView {
    const comments = all('SELECT * FROM comments WHERE bug_pk = ? AND link_candidate_operation_id IS NULL ORDER BY created_at, comment_pk', row.bug_pk);
    const serverIds = new Map(all('SELECT comment_pk, server_id FROM comments WHERE bug_pk = ?', row.bug_pk).map(item => [item.comment_pk, text(item.server_id)]));
    return {
      key: canonicalOf(row), serverKey: serverKey(row), sectionId: String(row.section_id), problemId: String(row.problem_id),
      revision: Number(row.revision), status: String(row.status), state: String(row.state), claimedBy: text(row.claimed_by),
      presence: row.presence as BugPresence, presenceAt: text(row.presence_at), detailComplete: row.detail_complete === 1,
      detailErrorCode: text(row.detail_error_code), payload: parsed(row.payload), syncedAt: text(row.synced_at),
      comments: comments.map(comment => ({
        commentPk: Number(comment.comment_pk), serverId: text(comment.server_id), origin: comment.origin as CommentOrigin,
        authorId: String(comment.author_id), authorKind: String(comment.author_kind), text: String(comment.text),
        replyTo: text(comment.reply_to), createdAt: String(comment.created_at), delivery: deliveryFor(comment),
      })),
      attachments: all('SELECT * FROM attachments WHERE bug_pk = ? ORDER BY attachment_pk', row.bug_pk).map(attachment => ({
        serverId: String(attachment.server_id),
        commentServerId: attachment.comment_pk === null ? null : serverIds.get(attachment.comment_pk) ?? null,
        kind: String(attachment.kind), mime: String(attachment.mime), bytes: Number(attachment.bytes), sha256: String(attachment.sha256),
        presence: attachment.presence as BugPresence, cacheState: attachment.cache_state as AttachmentCacheState,
      })),
      conflicts: all(`${CONFLICT_SELECT} WHERE o.bug_pk = ? ORDER BY c.detected_at, c.operation_id`, row.bug_pk).map(conflictView),
    };
  }

  function requestText(requestJson: unknown): string | null {
    const body = parsed(requestJson) as { text?: unknown } | null;
    return body && typeof body.text === 'string' ? body.text : null;
  }

  function resolveDelivered(operationId: string, commentPk: unknown, serverId: string, fields: readonly unknown[]): void {
    run('UPDATE comments SET server_id = ?, created_at = ?, payload = ? WHERE comment_pk = ?', serverId, fields[4], fields[5], commentPk);
    run('DELETE FROM conflicts WHERE operation_id = ?', operationId);
    run('DELETE FROM outbox WHERE operation_id = ?', operationId);
  }

  function applyComments(bugPk: unknown, section: Row, comments: readonly ServerComment[], candidates: string[], at: string): void {
    const incoming = new Set<string>();
    for (const comment of comments) {
      const id = String(comment.id);
      if (incoming.has(id)) continue;
      incoming.add(id);
      const fields = [String(comment.authorId), String(comment.authorKind), String(comment.text), comment.replyTo ?? null, String(comment.createdAt), json(comment.payload)];
      const existing = get('SELECT comment_pk FROM comments WHERE bug_pk = ? AND server_id = ?', bugPk, id);
      if (existing) {
        run('UPDATE comments SET author_id = ?, author_kind = ?, text = ?, reply_to = ?, created_at = ?, payload = ? WHERE comment_pk = ?', ...fields, existing.comment_pk);
        continue;
      }
      if (comment.authorId === section.actor) {
        const pending = all(`SELECT o.operation_id, o.request_json, o.state, o.comment_pk FROM outbox o JOIN comments c ON c.comment_pk = o.comment_pk
          WHERE o.bug_pk = ? AND c.server_id IS NULL ORDER BY o.created_at, o.operation_id`, bugPk)
          .find(row => requestText(row.request_json) === comment.text
            && !get('SELECT 1 AS hit FROM comments WHERE link_candidate_operation_id = ?', row.operation_id));
        if (pending?.state === 'delivered') {
          resolveDelivered(String(pending.operation_id), pending.comment_pk, id, fields);
          continue;
        }
        if (pending) {
          if (ACTIVE_STATES.includes(pending.state as OutboxState)) run('UPDATE outbox SET next_attempt_at = ?, updated_at = ? WHERE operation_id = ?', at, at, pending.operation_id);
          run(`INSERT INTO comments(bug_pk, server_id, origin, operation_id, link_candidate_operation_id, author_id, author_kind, text, reply_to, created_at, payload)
            VALUES (?, ?, 'server', NULL, ?, ?, ?, ?, ?, ?, ?)`, bugPk, id, pending.operation_id, ...fields);
          candidates.push(String(pending.operation_id));
          continue;
        }
      }
      run(`INSERT INTO comments(bug_pk, server_id, origin, operation_id, link_candidate_operation_id, author_id, author_kind, text, reply_to, created_at, payload)
        VALUES (?, ?, 'server', NULL, NULL, ?, ?, ?, ?, ?, ?)`, bugPk, id, ...fields);
    }
    for (const row of all('SELECT comment_pk, server_id FROM comments WHERE bug_pk = ? AND server_id IS NOT NULL', bugPk)) {
      if (incoming.has(String(row.server_id))) continue;
      if (get('SELECT 1 AS hit FROM outbox WHERE comment_pk = ?', row.comment_pk)) continue;
      run('DELETE FROM comments WHERE comment_pk = ?', row.comment_pk);
    }
  }

  function applyAttachments(bugPk: unknown, attachments: readonly ServerAttachment[]): void {
    const incoming = new Set<string>();
    for (const attachment of attachments) {
      const id = String(attachment.id);
      if (incoming.has(id)) continue;
      incoming.add(id);
      const commentPk = attachment.commentId === null || attachment.commentId === undefined ? null
        : get('SELECT comment_pk FROM comments WHERE bug_pk = ? AND server_id = ?', bugPk, String(attachment.commentId))?.comment_pk ?? null;
      const existing = get('SELECT attachment_pk, bytes, sha256 FROM attachments WHERE bug_pk = ? AND server_id = ?', bugPk, id);
      const bytes = Number(attachment.bytes);
      const sha256 = String(attachment.sha256);
      if (!existing) {
        run(`INSERT INTO attachments(bug_pk, comment_pk, server_id, kind, mime, bytes, sha256, presence, cache_state) VALUES (?, ?, ?, ?, ?, ?, ?, 'present', 'absent')`,
          bugPk, commentPk, id, String(attachment.kind), String(attachment.mime), bytes, sha256);
        continue;
      }
      const changed = Number(existing.bytes) !== bytes || existing.sha256 !== sha256;
      run(`UPDATE attachments SET comment_pk = ?, kind = ?, mime = ?, bytes = ?, sha256 = ?, presence = 'present'${changed
        ? `, cache_state = 'absent', cache_file = NULL, cache_bytes = NULL, cache_sha256 = NULL, fetch_owner = NULL, fetch_started_at = NULL` : ''} WHERE attachment_pk = ?`,
      commentPk, String(attachment.kind), String(attachment.mime), bytes, sha256, existing.attachment_pk);
    }
    for (const row of all('SELECT attachment_pk, server_id FROM attachments WHERE bug_pk = ?', bugPk)) {
      if (!incoming.has(String(row.server_id))) run('DELETE FROM attachments WHERE attachment_pk = ?', row.attachment_pk);
    }
  }

  function bugByServerKey(key: ServerBugKey): Row | undefined {
    return get('SELECT * FROM bugs WHERE project = ? AND env = ? AND source = ? AND owner = ? AND raw_id = ?', key.project, key.env, key.source, key.owner, key.rawId);
  }

  function assertSectionKey(section: Row, key: ServerBugKey): void {
    if (!key || key.project !== section.project || key.env !== section.env) {
      throw new BugStoreError('unknown-section', `Bug key does not belong to section ${section.section_id}`, { sectionId: section.section_id, key });
    }
  }

  function removeOrConflict(section: Row, key: ServerBugKey, presence: 'deleted' | 'missing', at: string, conflicts: ConflictView[]): void {
    assertSectionKey(section, key);
    const row = bugByServerKey(key);
    if (!row) return;
    const operations = all('SELECT operation_id, state FROM outbox WHERE bug_pk = ? ORDER BY created_at, operation_id', row.bug_pk);
    if (!operations.length && presence === 'deleted') {
      run('DELETE FROM bugs WHERE bug_pk = ?', row.bug_pk);
      return;
    }
    if (row.presence !== presence) run('UPDATE bugs SET presence = ?, presence_at = ?, synced_at = ? WHERE bug_pk = ?', presence, at, at, row.bug_pk);
    const kind: ConflictKind = presence === 'deleted' ? 'bug-deleted' : 'bug-missing';
    for (const operation of operations) {
      const current = get('SELECT kind FROM conflicts WHERE operation_id = ?', operation.operation_id);
      if (current?.kind === kind) continue;
      conflicts.push(writeConflict(String(operation.operation_id), { kind, observed: { presence, key: serverKey(row) }, status: null, at }));
    }
  }

  function applyDetail(section: Row, detail: ServerBugDetail, at: string, candidates: string[]): void {
    assertSectionKey(section, detail.key);
    const existing = bugByServerKey(detail.key);
    if (!detail.complete) {
      if (existing) {
        run('UPDATE bugs SET detail_complete = 0, detail_error_code = ?, synced_at = ? WHERE bug_pk = ?', detail.errorCode ?? 'incomplete', at, existing.bug_pk);
      } else {
        run(`INSERT INTO bugs(section_id, project, env, source, owner, raw_id, problem_id, canonical_project, revision, status, state, claimed_by, payload,
          server_created_at, detail_revision, detail_complete, detail_error_code, presence, presence_at, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, 'present', ?, ?)`,
        section.section_id, detail.key.project, detail.key.env, detail.key.source, detail.key.owner, detail.key.rawId, String(detail.problemId),
        section.canonical_project, Number(detail.revision ?? 0), String(detail.status ?? ''), String(detail.state ?? ''), detail.claimedBy ?? null,
        json(detail.payload), detail.createdAt ?? null, detail.errorCode ?? 'incomplete', at, at);
      }
      return;
    }
    const values = [String(detail.problemId), section.canonical_project, Number(detail.revision), String(detail.status), String(detail.state),
      detail.claimedBy ?? null, json(detail.payload), detail.createdAt ?? null, Number(detail.revision)];
    let bugPk: unknown;
    if (existing) {
      bugPk = existing.bug_pk;
      run(`UPDATE bugs SET problem_id = ?, canonical_project = ?, revision = ?, status = ?, state = ?, claimed_by = ?, payload = ?, server_created_at = ?,
        detail_revision = ?, detail_complete = 1, detail_error_code = NULL, presence = 'present', presence_at = ?, synced_at = ? WHERE bug_pk = ?`,
      ...values, existing.presence === 'present' ? existing.presence_at : at, at, bugPk);
    } else {
      bugPk = run(`INSERT INTO bugs(section_id, project, env, source, owner, raw_id, problem_id, canonical_project, revision, status, state, claimed_by, payload,
        server_created_at, detail_revision, detail_complete, detail_error_code, presence, presence_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 'present', ?, ?)`,
      section.section_id, detail.key.project, detail.key.env, detail.key.source, detail.key.owner, detail.key.rawId, ...values, at, at).lastInsertRowid;
    }
    applyComments(bugPk, section, detail.comments ?? [], candidates, at);
    applyAttachments(bugPk, detail.attachments ?? []);
  }

  function applyPosition(sectionId: string, position: SyncPosition, at: string): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    const field = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };
    if (position.phase !== undefined) field('phase', position.phase);
    if (position.journalCursor !== undefined) field('journal_cursor', String(position.journalCursor));
    if (position.snapshotHead !== undefined) field('snapshot_head', position.snapshotHead);
    if (position.listCursor !== undefined) field('list_cursor', position.listCursor);
    if (position.listClaimsFingerprint !== undefined) field('list_claims_fingerprint', position.listClaimsFingerprint);
    if (position.snapshotComplete !== undefined) field('snapshot_complete', position.snapshotComplete ? 1 : 0);
    field('last_success_at', at);
    field('last_attempt_at', at);
    sets.push('last_error_code = NULL', 'consecutive_failures = 0');
    run(`UPDATE sync_state SET ${sets.join(', ')} WHERE section_id = ?`, ...params, sectionId);
  }

  const repository: BugRepository = {
    path,
    database: db,
    schemaVersion: version,
    upsertSection(section) {
      transaction(() => {
        run(`INSERT INTO sections(section_id, project, env, stand, canonical_project, origin, actor, claims_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(section_id) DO UPDATE SET project = excluded.project, env = excluded.env, stand = excluded.stand, canonical_project = excluded.canonical_project,
          origin = excluded.origin, actor = excluded.actor, claims_fingerprint = excluded.claims_fingerprint`,
        section.sectionId, section.project, section.env, section.stand, section.canonicalProject, section.origin, section.actor, section.claimsFingerprint);
        run(`INSERT INTO sync_state(section_id, phase, journal_cursor) VALUES (?, 'initial', '0') ON CONFLICT(section_id) DO NOTHING`, section.sectionId);
      });
    },
    sections() {
      return all('SELECT * FROM sections ORDER BY section_id').map(row => ({
        sectionId: String(row.section_id), project: String(row.project), env: String(row.env), stand: String(row.stand),
        canonicalProject: String(row.canonical_project), origin: String(row.origin), actor: String(row.actor), claimsFingerprint: String(row.claims_fingerprint),
      }));
    },
    syncState(sectionId) {
      sectionRow(sectionId);
      return syncView(get('SELECT * FROM sync_state WHERE section_id = ?', sectionId)!);
    },
    recordSyncAttempt(sectionId, at) {
      transaction(() => {
        sectionRow(sectionId);
        run('UPDATE sync_state SET last_attempt_at = ? WHERE section_id = ?', at, sectionId);
      });
    },
    recordSyncFailure(sectionId, code, at) {
      transaction(() => {
        sectionRow(sectionId);
        run('UPDATE sync_state SET last_attempt_at = ?, last_error_code = ?, consecutive_failures = consecutive_failures + 1 WHERE section_id = ?', at, code, sectionId);
      });
    },
    applyPullBatch(batch) {
      return transaction(() => {
        const section = sectionRow(batch.sectionId);
        const conflicts: ConflictView[] = [];
        const candidates: string[] = [];
        for (const detail of batch.details ?? []) applyDetail(section, detail, batch.at, candidates);
        for (const key of batch.deleted ?? []) removeOrConflict(section, key, 'deleted', batch.at, conflicts);
        for (const key of batch.missing ?? []) removeOrConflict(section, key, 'missing', batch.at, conflicts);
        applyPosition(batch.sectionId, batch.position ?? {}, batch.at);
        return { conflicts, linkCandidates: [...new Set(candidates)] };
      });
    },
    presentBugKeys(sectionId) {
      sectionRow(sectionId);
      return all(`SELECT * FROM bugs WHERE section_id = ? AND presence = 'present' ORDER BY bug_pk`, sectionId).map(serverKey);
    },
    findBug(canonicalKey) {
      return bugView(findBugRow(canonicalKey));
    },
    listBugs(filter) {
      const limit = Number(filter?.limit);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new BugStoreError('invalid-cursor', 'List limit must be a positive integer', { limit: filter?.limit });
      let after = 0;
      if (filter.cursor !== undefined && filter.cursor !== null) {
        if (!/^[1-9][0-9]*$/.test(filter.cursor)) throw new BugStoreError('invalid-cursor', 'Invalid bug list cursor', { cursor: filter.cursor });
        after = Number(filter.cursor);
      }
      const where = ['b.bug_pk > ?'];
      const params: unknown[] = [after];
      if (filter.canonicalProject !== undefined) { where.push('b.canonical_project = ?'); params.push(filter.canonicalProject); }
      if (filter.status !== undefined) { where.push('b.status = ?'); params.push(filter.status); }
      const rows = all(`SELECT b.*, (SELECT COUNT(*) FROM outbox o WHERE o.bug_pk = b.bug_pk) AS pending_operations,
        (SELECT COUNT(*) FROM conflicts c JOIN outbox o ON o.operation_id = c.operation_id WHERE o.bug_pk = b.bug_pk) AS conflict_count
        FROM bugs b WHERE ${where.join(' AND ')} ORDER BY b.bug_pk LIMIT ?`, ...params, limit + 1);
      const page = rows.slice(0, limit);
      const sync = filter.canonicalProject === undefined
        ? all('SELECT * FROM sync_state ORDER BY section_id')
        : all('SELECT s.* FROM sync_state s JOIN sections x ON x.section_id = s.section_id WHERE x.canonical_project = ? ORDER BY s.section_id', filter.canonicalProject);
      return {
        bugs: page.map(row => ({
          key: canonicalOf(row), sectionId: String(row.section_id), revision: Number(row.revision), status: String(row.status),
          presence: row.presence as BugPresence, pendingOperations: Number(row.pending_operations), conflicts: Number(row.conflict_count),
        })),
        nextCursor: rows.length > limit ? String(page[page.length - 1].bug_pk) : null,
        sync: sync.map(syncView),
      };
    },
    addLocalComment(input) {
      const body = typeof input?.text === 'string' ? input.text : '';
      if (!body.trim() || body.includes('\0')) throw new BugStoreError('invalid-comment', 'Comment text must be non-empty', {});
      if (typeof input.authorId !== 'string' || !input.authorId.trim() || typeof input.authorKind !== 'string' || !input.authorKind.trim()) {
        throw new BugStoreError('invalid-comment', 'Comment author is required', {});
      }
      if (typeof input.claimsFingerprint !== 'string' || !input.claimsFingerprint) throw new BugStoreError('invalid-comment', 'Claims fingerprint is required', {});
      return transaction(() => {
        const bug = findBugRow(input.bugKey);
        if (bug.presence !== 'present') {
          throw new BugStoreError('bug-not-found', `Bug ${input.bugKey} is ${bug.presence} on the server`, { bugKey: input.bugKey, presence: bug.presence });
        }
        const claimedBy = text(bug.claimed_by);
        const replyTo = claimedBy && claimedBy !== input.authorId
          ? text(get(`SELECT server_id FROM comments WHERE bug_pk = ? AND author_id = ? AND server_id IS NOT NULL AND link_candidate_operation_id IS NULL
              ORDER BY created_at DESC, comment_pk DESC LIMIT 1`, bug.bug_pk, claimedBy)?.server_id)
          : null;
        const operationId = randomUUID();
        const expectedRevision = Number(bug.revision);
        const request: CommentRequestBody = replyTo
          ? { operation_id: operationId, expected_revision: expectedRevision, text: body, reply_to: replyTo }
          : { operation_id: operationId, expected_revision: expectedRevision, text: body };
        const commentPk = Number(run(`INSERT INTO comments(bug_pk, server_id, origin, operation_id, link_candidate_operation_id, author_id, author_kind, text, reply_to, created_at, payload)
          VALUES (?, NULL, 'local', ?, NULL, ?, ?, ?, ?, ?, NULL)`, bug.bug_pk, operationId, input.authorId, input.authorKind, body, replyTo, input.at).lastInsertRowid);
        options.beforeOutboxInsert?.();
        run(`INSERT INTO outbox(operation_id, kind, bug_pk, comment_pk, section_id, request_json, expected_revision, claims_fingerprint, state, attempts,
          next_attempt_at, created_at, updated_at) VALUES (?, 'comment.add', ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        operationId, bug.bug_pk, commentPk, bug.section_id, JSON.stringify(request), expectedRevision, input.claimsFingerprint, input.at, input.at, input.at);
        return { bugKey: canonicalOf(bug), commentPk, operationId, state: 'pending' as const, delivered: false as const, expectedRevision, replyTo };
      });
    },
    outbox(operationId) {
      const row = get(`${OUTBOX_SELECT} WHERE o.operation_id = ?`, operationId);
      return row ? outboxView(row) : undefined;
    },
    listOutbox() {
      return all(`${OUTBOX_SELECT} ORDER BY o.created_at, o.operation_id`).map(outboxView);
    },
    dueOperations(at) {
      return all(`${OUTBOX_SELECT} WHERE o.state IN (${ACTIVE_STATES.map(() => '?').join(', ')}) AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
        ORDER BY o.created_at, o.operation_id`, ...ACTIVE_STATES, at).map(outboxView);
    },
    markSending(operationId, at) {
      return transaction(() => {
        const row = outboxRow(operationId);
        if (!ACTIVE_STATES.includes(row.state as OutboxState)) return false;
        run(`UPDATE outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE operation_id = ?`, at, operationId);
        return true;
      });
    },
    markUnknown(operationId, failure) {
      transaction(() => {
        const row = outboxRow(operationId);
        if (row.state === 'conflict') return;
        run(`UPDATE outbox SET state = 'unknown', last_status = ?, last_error_code = ?, next_attempt_at = ?, updated_at = ? WHERE operation_id = ?`,
          failure.status, failure.code, failure.nextAttemptAt, failure.at, operationId);
      });
    },
    confirmDelivery(operationId, confirmation) {
      transaction(() => {
        const row = outboxRow(operationId);
        const local = get('SELECT * FROM comments WHERE comment_pk = ?', row.comment_pk)!;
        const linked = (confirmation.serverCommentId
          ? get('SELECT * FROM comments WHERE bug_pk = ? AND server_id = ? AND comment_pk <> ?', row.bug_pk, confirmation.serverCommentId, local.comment_pk)
          : undefined) ?? get('SELECT * FROM comments WHERE link_candidate_operation_id = ? ORDER BY comment_pk LIMIT 1', operationId);
        const serverId = confirmation.serverCommentId ?? text(linked?.server_id);
        run('UPDATE comments SET link_candidate_operation_id = NULL WHERE link_candidate_operation_id = ? AND comment_pk <> ?', operationId, linked?.comment_pk ?? -1);
        if (linked) {
          run('UPDATE attachments SET comment_pk = ? WHERE comment_pk = ?', local.comment_pk, linked.comment_pk);
          run('DELETE FROM comments WHERE comment_pk = ?', linked.comment_pk);
          run('UPDATE comments SET server_id = ?, created_at = ?, payload = ? WHERE comment_pk = ?', serverId, linked.created_at, linked.payload, local.comment_pk);
        } else if (serverId) {
          run('UPDATE comments SET server_id = ? WHERE comment_pk = ?', serverId, local.comment_pk);
        }
        if (!serverId) {
          run(`UPDATE outbox SET state = 'delivered', server_comment_id = NULL, delivered_revision = ?, next_attempt_at = NULL, updated_at = ? WHERE operation_id = ?`,
            confirmation.revision, confirmation.at, operationId);
          return;
        }
        run('DELETE FROM conflicts WHERE operation_id = ?', operationId);
        run('DELETE FROM outbox WHERE operation_id = ?', operationId);
      });
    },
    markConflict(operationId, conflict) {
      return transaction(() => {
        outboxRow(operationId);
        return writeConflict(operationId, conflict);
      });
    },
    recoverInterruptedSends(at) {
      return transaction(() => Number(run(`UPDATE outbox SET state = 'unknown', next_attempt_at = ?, updated_at = ? WHERE state = 'sending'`, at, at).changes));
    },
    conflicts() {
      return all(`${CONFLICT_SELECT} ORDER BY c.detected_at, c.operation_id`).map(conflictView);
    },
    pendingNotices() {
      return all(`${CONFLICT_SELECT} WHERE c.noticed_at IS NULL ORDER BY c.detected_at, c.operation_id`).map(conflictView);
    },
    markNoticed(key, at) {
      transaction(() => { run('UPDATE conflicts SET noticed_at = ? WHERE notice_key = ? AND noticed_at IS NULL', at, key); });
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
  return repository;
}
