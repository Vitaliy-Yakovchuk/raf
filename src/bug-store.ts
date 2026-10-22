import { mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BUG_STORE_SCHEMA_VERSION = 2;

export type BugPresence = 'present' | 'missing';
export type SyncPhase = 'initial' | 'snapshot' | 'incremental' | 'resync';
export type AttachmentCacheState = 'absent' | 'fetching' | 'ready';
export type NoticeKind = 'new-bug' | 'human-comment';

export type BugStoreErrorCode =
  | 'unsafe-path'
  | 'unsupported-version'
  | 'unknown-section'
  | 'invalid-bug-key'
  | 'bug-not-found'
  | 'ambiguous-bug'
  | 'invalid-comment'
  | 'invalid-cursor'
  | 'invalid-receipt'
  | 'undelivered-local-comments';

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

export interface PullBatchResult {
  readonly applied: number;
  readonly skippedOlder: number;
}

export interface CommentView {
  readonly commentPk: number;
  readonly serverId: string;
  readonly authorId: string;
  readonly authorKind: string;
  readonly text: string;
  readonly replyTo: string | null;
  readonly createdAt: string;
}

export interface AttachmentView {
  readonly serverId: string;
  readonly commentServerId: string | null;
  readonly kind: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly presence: string;
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
}

export interface BugSummaryView {
  readonly key: string;
  readonly sectionId: string;
  readonly revision: number;
  readonly status: string;
  readonly presence: BugPresence;
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

export interface NoticeView {
  readonly noticeKey: string;
  readonly kind: NoticeKind;
  readonly bugKey: string;
  readonly commentServerId: string | null;
  readonly createdAt: string;
  readonly noticedAt: string | null;
}

export interface NoticeCandidate {
  readonly noticeKey: string;
  readonly kind: NoticeKind;
  readonly commentServerId: string | null;
}

const HUMAN_AUTHOR_KIND = 'person';

export function noticeKey(kind: NoticeKind, problemId: string, commentServerId: string | null): string {
  if (typeof problemId !== 'string' || !problemId) throw new TypeError('Notice key needs a problem id');
  if (kind === 'new-bug') return `bug-new:${problemId}`;
  if (kind === 'human-comment') {
    if (typeof commentServerId !== 'string' || !commentServerId) throw new TypeError('Human comment notice key needs a comment id');
    return `bug-comment:${problemId}:${commentServerId}`;
  }
  throw new TypeError(`Unknown notice kind ${String(kind)}`);
}

export function noticeCandidates(knownCommentIds: ReadonlySet<string> | null, detail: ServerBugDetail): readonly NoticeCandidate[] {
  const problemId = String(detail.problemId);
  if (knownCommentIds === null) return [{ noticeKey: noticeKey('new-bug', problemId, null), kind: 'new-bug', commentServerId: null }];
  const candidates: NoticeCandidate[] = [];
  const seen = new Set<string>();
  for (const comment of detail.comments ?? []) {
    const id = String(comment.id);
    if (comment.authorKind !== HUMAN_AUTHOR_KIND || knownCommentIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    candidates.push({ noticeKey: noticeKey('human-comment', problemId, id), kind: 'human-comment', commentServerId: id });
  }
  return candidates;
}

export interface WrittenBugHeader {
  readonly key: ServerBugKey;
  readonly problemId: string;
  readonly revision: number;
  readonly status: string;
  readonly state: string;
  readonly createdAt: string;
  readonly claimedBy: string | null;
  readonly payload: unknown;
}

export interface WriteReceiptInput {
  readonly bugKey: string;
  readonly bug: WrittenBugHeader;
  readonly comment: ServerComment | null;
  readonly at: string;
}

export interface UndeliveredLocalComment {
  readonly bugKey: string;
  readonly text: string;
  readonly operationId: string | null;
  readonly state: string | null;
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
  applyWriteReceipt(input: WriteReceiptInput): BugView;
  pendingNotices(): readonly NoticeView[];
  markNoticed(noticeKey: string, at: string): void;
  close(): void;
}

const CANONICAL_KEY = /^(projects\/[a-z0-9][a-z0-9._-]*)\/bug#([^\s#/\\\0]+)$/;

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

const SECTIONS_DDL = `
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
`;

const bugsTable = (name: string) => `
  CREATE TABLE ${name} (
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
    presence TEXT NOT NULL CHECK(presence IN ('present', 'missing')),
    presence_at TEXT,
    synced_at TEXT,
    UNIQUE(project, env, source, owner, raw_id)
  ) STRICT;
`;

const commentsTable = (name: string) => `
  CREATE TABLE ${name} (
    comment_pk INTEGER PRIMARY KEY,
    bug_pk INTEGER NOT NULL REFERENCES bugs(bug_pk) ON DELETE CASCADE,
    server_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT,
    created_at TEXT NOT NULL,
    payload TEXT,
    UNIQUE(bug_pk, server_id)
  ) STRICT;
`;

const ATTACHMENTS_DDL = `
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
`;

const BUG_INDEXES = `
  CREATE INDEX bugs_canonical ON bugs(canonical_project, raw_id);
  CREATE INDEX bugs_section_status ON bugs(section_id, status);
`;

const NOTICES_DDL = `
  CREATE TABLE notices (
    notice_key TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('new-bug', 'human-comment')),
    bug_pk INTEGER NOT NULL REFERENCES bugs(bug_pk) ON DELETE CASCADE,
    comment_server_id TEXT,
    created_at TEXT NOT NULL,
    noticed_at TEXT
  ) STRICT;
  CREATE INDEX notices_pending ON notices(noticed_at, created_at);
`;

const SCHEMA_V2 = `${SECTIONS_DDL}${bugsTable('bugs')}${BUG_INDEXES}${commentsTable('comments')}${ATTACHMENTS_DDL}${NOTICES_DDL}`;

const MIGRATION_V1_TO_V2 = `
  DROP TABLE conflicts;
  DROP TABLE outbox;
  DELETE FROM attachments WHERE bug_pk IN (SELECT bug_pk FROM bugs WHERE presence = 'deleted');
  DELETE FROM comments WHERE bug_pk IN (SELECT bug_pk FROM bugs WHERE presence = 'deleted');
  DELETE FROM bugs WHERE presence = 'deleted';
  ${bugsTable('bugs_v2')}
  INSERT INTO bugs_v2 SELECT bug_pk, section_id, project, env, source, owner, raw_id, problem_id, canonical_project, revision, status, state, claimed_by,
    CASE WHEN payload IS NOT NULL AND json_valid(payload) AND json_type(payload) = 'object' THEN json_remove(payload, '$.claim_token') ELSE payload END,
    server_created_at, detail_revision, detail_complete, detail_error_code, presence, presence_at, synced_at FROM bugs;
  ${commentsTable('comments_v2')}
  INSERT INTO comments_v2 SELECT comment_pk, bug_pk, server_id, author_id, author_kind, text, reply_to, created_at,
    CASE WHEN payload IS NOT NULL AND json_valid(payload) AND json_type(payload) = 'object' THEN json_remove(payload, '$.claim_token') ELSE payload END FROM comments;
  DROP TABLE comments;
  DROP TABLE bugs;
  ALTER TABLE bugs_v2 RENAME TO bugs;
  ALTER TABLE comments_v2 RENAME TO comments;
  ${BUG_INDEXES}
  ${NOTICES_DDL}
`;

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function withoutClaimToken(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'claim_token')) return payload;
  const { claim_token: _token, ...rest } = payload as Record<string, unknown>;
  return rest;
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function serverKey(row: Row): ServerBugKey {
  return { project: String(row.project), env: String(row.env), source: String(row.source), owner: String(row.owner), rawId: String(row.raw_id) };
}

function canonicalOf(row: Row): string {
  return `${row.canonical_project}/bug#${row.raw_id}`;
}

function sameServerKey(left: ServerBugKey, right: ServerBugKey): boolean {
  return left.project === right.project && left.env === right.env && left.source === right.source && left.owner === right.owner && left.rawId === right.rawId;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function undeliveredComments(db: DatabaseSync): UndeliveredLocalComment[] {
  if (!hasTable(db, 'comments')) return [];
  const outbox = hasTable(db, 'outbox');
  const rows = db.prepare(outbox
    ? `SELECT b.canonical_project, b.raw_id, c.text, o.operation_id, o.state, o.request_json FROM comments c JOIN bugs b ON b.bug_pk = c.bug_pk
        LEFT JOIN outbox o ON o.comment_pk = c.comment_pk WHERE c.server_id IS NULL OR (o.operation_id IS NOT NULL AND o.state <> 'delivered')
        UNION ALL
        SELECT b.canonical_project, b.raw_id, NULL AS text, o.operation_id, o.state, o.request_json FROM outbox o JOIN bugs b ON b.bug_pk = o.bug_pk
        WHERE o.state <> 'delivered' AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.comment_pk = o.comment_pk)
        ORDER BY 1, 2, 4`
    : `SELECT b.canonical_project, b.raw_id, c.text, NULL AS operation_id, NULL AS state, NULL AS request_json FROM comments c JOIN bugs b ON b.bug_pk = c.bug_pk
        WHERE c.server_id IS NULL ORDER BY 1, 2`).all() as Row[];
  return rows.map(row => {
    const request = parsed(row.request_json) as { text?: unknown } | null;
    return {
      bugKey: canonicalOf(row), text: text(row.text) ?? (typeof request?.text === 'string' ? request.text : ''),
      operationId: text(row.operation_id), state: text(row.state),
    };
  });
}

export function openBugStore(path: string): BugRepository {
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
  const unsupported = () => new BugStoreError('unsupported-version', 'The bug database schema is newer than this raf supports', { found: version(), supported: BUG_STORE_SCHEMA_VERSION });
  const refuseUndelivered = (comments: readonly UndeliveredLocalComment[]) => new BugStoreError('undelivered-local-comments',
    `The bug database holds ${comments.length} local comment(s) that never reached the server; main must resolve them by hand before raf can open it`,
    { path, comments });

  try {
    if (version() > BUG_STORE_SCHEMA_VERSION) throw unsupported();
    if (version() === 1) {
      const pending = undeliveredComments(db);
      if (pending.length) throw refuseUndelivered(pending);
    }
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
    db.exec('PRAGMA synchronous = FULL');
    if (version() < BUG_STORE_SCHEMA_VERSION) {
      db.exec('PRAGMA foreign_keys = OFF');
      transaction(() => {
        const current = version();
        if (current > BUG_STORE_SCHEMA_VERSION) throw unsupported();
        if (current === BUG_STORE_SCHEMA_VERSION) return;
        if (current === 0) {
          db.exec(SCHEMA_V2);
        } else {
          const pending = undeliveredComments(db);
          if (pending.length) throw refuseUndelivered(pending);
          db.exec(MIGRATION_V1_TO_V2);
          const broken = db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length) throw new Error(`Bug database migration left ${broken.length} dangling reference(s)`);
        }
        db.exec(`PRAGMA user_version = ${BUG_STORE_SCHEMA_VERSION}`);
      });
    }
    db.exec('PRAGMA foreign_keys = ON');
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

  function commentView(comment: Row): CommentView {
    return {
      commentPk: Number(comment.comment_pk), serverId: String(comment.server_id), authorId: String(comment.author_id),
      authorKind: String(comment.author_kind), text: String(comment.text), replyTo: text(comment.reply_to), createdAt: String(comment.created_at),
    };
  }

  function bugView(row: Row): BugView {
    const comments = all('SELECT * FROM comments WHERE bug_pk = ? ORDER BY comment_pk', row.bug_pk);
    const serverIds = new Map(comments.map(item => [item.comment_pk, String(item.server_id)]));
    return {
      key: canonicalOf(row), serverKey: serverKey(row), sectionId: String(row.section_id), problemId: String(row.problem_id),
      revision: Number(row.revision), status: String(row.status), state: String(row.state), claimedBy: text(row.claimed_by),
      presence: row.presence as BugPresence, presenceAt: text(row.presence_at), detailComplete: row.detail_complete === 1,
      detailErrorCode: text(row.detail_error_code), payload: parsed(row.payload), syncedAt: text(row.synced_at),
      comments: comments.map(commentView),
      attachments: all('SELECT * FROM attachments WHERE bug_pk = ? ORDER BY attachment_pk', row.bug_pk).map(attachment => ({
        serverId: String(attachment.server_id),
        commentServerId: attachment.comment_pk === null ? null : serverIds.get(attachment.comment_pk) ?? null,
        kind: String(attachment.kind), mime: String(attachment.mime), bytes: Number(attachment.bytes), sha256: String(attachment.sha256),
        presence: String(attachment.presence), cacheState: attachment.cache_state as AttachmentCacheState,
      })),
    };
  }

  function commentFields(comment: ServerComment): unknown[] {
    return [String(comment.authorId), String(comment.authorKind), String(comment.text), comment.replyTo ?? null, String(comment.createdAt), json(withoutClaimToken(comment.payload))];
  }

  function upsertComment(bugPk: unknown, comment: ServerComment): void {
    run(`INSERT INTO comments(bug_pk, server_id, author_id, author_kind, text, reply_to, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bug_pk, server_id) DO UPDATE SET author_id = excluded.author_id, author_kind = excluded.author_kind, text = excluded.text,
      reply_to = excluded.reply_to, created_at = excluded.created_at, payload = excluded.payload`, bugPk, String(comment.id), ...commentFields(comment));
  }

  function applyComments(bugPk: unknown, comments: readonly ServerComment[]): void {
    const ordered = new Map<string, ServerComment>();
    for (const comment of comments) if (!ordered.has(String(comment.id))) ordered.set(String(comment.id), comment);
    for (const row of all('SELECT comment_pk, server_id FROM comments WHERE bug_pk = ?', bugPk)) {
      if (!ordered.has(String(row.server_id))) run('DELETE FROM comments WHERE comment_pk = ?', row.comment_pk);
    }
    const kept = all('SELECT server_id FROM comments WHERE bug_pk = ? ORDER BY comment_pk', bugPk).map(row => String(row.server_id));
    const incoming = [...ordered.keys()];
    if (kept.some((id, index) => incoming[index] !== id)) run('DELETE FROM comments WHERE bug_pk = ?', bugPk);
    for (const comment of ordered.values()) upsertComment(bugPk, comment);
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

  function removeBug(section: Row, key: ServerBugKey, presence: 'deleted' | 'missing', at: string): void {
    assertSectionKey(section, key);
    const row = bugByServerKey(key);
    if (!row) return;
    if (presence === 'deleted') {
      run('DELETE FROM bugs WHERE bug_pk = ?', row.bug_pk);
      return;
    }
    if (row.presence !== 'missing') run(`UPDATE bugs SET presence = 'missing', presence_at = ?, synced_at = ? WHERE bug_pk = ?`, at, at, row.bug_pk);
  }

  function applyDetail(section: Row, detail: ServerBugDetail, at: string): boolean {
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
        json(withoutClaimToken(detail.payload)), detail.createdAt ?? null, detail.errorCode ?? 'incomplete', at, at);
      }
      return true;
    }
    if (existing && Number(detail.revision) < Number(existing.revision)) return false;
    const values = [String(detail.problemId), section.canonical_project, Number(detail.revision), String(detail.status), String(detail.state),
      detail.claimedBy ?? null, json(withoutClaimToken(detail.payload)), detail.createdAt ?? null, Number(detail.revision)];
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
    applyComments(bugPk, detail.comments ?? []);
    applyAttachments(bugPk, detail.attachments ?? []);
    return true;
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

  function recordNotices(detail: ServerBugDetail, knownCommentIds: ReadonlySet<string> | null, at: string): void {
    const bug = bugByServerKey(detail.key);
    if (!bug) return;
    for (const candidate of noticeCandidates(knownCommentIds, detail)) {
      if (candidate.kind === 'human-comment' && !get('SELECT 1 AS hit FROM comments WHERE bug_pk = ? AND server_id = ?', bug.bug_pk, candidate.commentServerId)) continue;
      run(`INSERT INTO notices(notice_key, kind, bug_pk, comment_server_id, created_at, noticed_at) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(notice_key) DO NOTHING`, candidate.noticeKey, candidate.kind, bug.bug_pk, candidate.commentServerId, at);
    }
  }

  function noticeView(row: Row): NoticeView {
    return {
      noticeKey: String(row.notice_key), kind: row.kind as NoticeKind, bugKey: canonicalOf(row), commentServerId: text(row.comment_server_id),
      createdAt: String(row.created_at), noticedAt: text(row.noticed_at),
    };
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
        const announce = get('SELECT phase FROM sync_state WHERE section_id = ?', batch.sectionId)?.phase === 'incremental';
        let applied = 0;
        let skippedOlder = 0;
        for (const detail of batch.details ?? []) {
          const before = announce ? bugByServerKey(detail.key) : undefined;
          const known = before ? new Set(all('SELECT server_id FROM comments WHERE bug_pk = ?', before.bug_pk).map(row => String(row.server_id))) : null;
          if (!applyDetail(section, detail, batch.at)) {
            skippedOlder++;
            continue;
          }
          applied++;
          if (announce) recordNotices(detail, known, batch.at);
        }
        for (const key of batch.deleted ?? []) removeBug(section, key, 'deleted', batch.at);
        for (const key of batch.missing ?? []) removeBug(section, key, 'missing', batch.at);
        applyPosition(batch.sectionId, batch.position ?? {}, batch.at);
        return { applied, skippedOlder };
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
      const rows = all(`SELECT b.* FROM bugs b WHERE ${where.join(' AND ')} ORDER BY b.bug_pk LIMIT ?`, ...params, limit + 1);
      const page = rows.slice(0, limit);
      const sync = filter.canonicalProject === undefined
        ? all('SELECT * FROM sync_state ORDER BY section_id')
        : all('SELECT s.* FROM sync_state s JOIN sections x ON x.section_id = s.section_id WHERE x.canonical_project = ? ORDER BY s.section_id', filter.canonicalProject);
      return {
        bugs: page.map(row => ({
          key: canonicalOf(row), sectionId: String(row.section_id), revision: Number(row.revision), status: String(row.status),
          presence: row.presence as BugPresence,
        })),
        nextCursor: rows.length > limit ? String(page[page.length - 1].bug_pk) : null,
        sync: sync.map(syncView),
      };
    },
    applyWriteReceipt(input) {
      const header = input?.bug;
      const revision = Number(header?.revision);
      if (!header || !Number.isSafeInteger(revision) || revision < 0 || typeof header.status !== 'string' || typeof header.state !== 'string') {
        throw new BugStoreError('invalid-receipt', 'Write receipt lacks a valid bug state', { bugKey: input?.bugKey });
      }
      const comment = input.comment;
      if (comment !== null && (typeof comment?.id !== 'string' || !comment.id)) throw new BugStoreError('invalid-receipt', 'Write receipt lacks a valid comment', { bugKey: input.bugKey });
      return transaction(() => {
        const row = findBugRow(input.bugKey);
        if (!header.key || !sameServerKey(serverKey(row), header.key)) {
          throw new BugStoreError('invalid-receipt', `Write receipt belongs to another bug than ${input.bugKey}`, { bugKey: input.bugKey, received: header.key ?? null });
        }
        if (revision >= Number(row.revision)) {
          run(`UPDATE bugs SET problem_id = ?, revision = ?, status = ?, state = ?, claimed_by = ?, payload = ?, server_created_at = COALESCE(?, server_created_at),
            presence = 'present', presence_at = CASE WHEN presence = 'present' THEN presence_at ELSE ? END, synced_at = ? WHERE bug_pk = ?`,
          String(header.problemId), revision, header.status, header.state, header.claimedBy ?? null, json(withoutClaimToken(header.payload)),
          header.createdAt || null, input.at, input.at, row.bug_pk);
        }
        if (comment) {
          run(`INSERT INTO comments(bug_pk, server_id, author_id, author_kind, text, reply_to, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bug_pk, server_id) DO NOTHING`, row.bug_pk, comment.id, ...commentFields(comment));
        }
        return bugView(get('SELECT * FROM bugs WHERE bug_pk = ?', row.bug_pk)!);
      });
    },
    pendingNotices() {
      return all(`SELECT n.*, b.canonical_project, b.raw_id FROM notices n JOIN bugs b ON b.bug_pk = n.bug_pk
        WHERE n.noticed_at IS NULL ORDER BY n.created_at, n.notice_key`).map(noticeView);
    },
    markNoticed(key, at) {
      transaction(() => { run('UPDATE notices SET noticed_at = ? WHERE notice_key = ? AND noticed_at IS NULL', at, key); });
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
  return repository;
}
