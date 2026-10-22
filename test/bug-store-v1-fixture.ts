import { DatabaseSync } from 'node:sqlite';

const BUG_STORE_SCHEMA_V1 = `
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

export interface V1Seed {
  readonly sectionId: string;
  readonly project: string;
  readonly env: string;
  readonly canonicalProject: string;
  readonly rawId: string;
  readonly claimToken: string;
  readonly at: string;
}

export interface V1LocalComment {
  readonly operationId: string;
  readonly text: string;
  readonly state: 'pending' | 'sending' | 'unknown' | 'delivered' | 'conflict';
  readonly serverId: string | null;
}

export function createV1BugDatabase(path: string, seed: V1Seed, locals: readonly V1LocalComment[] = []): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(BUG_STORE_SCHEMA_V1);
    db.prepare('INSERT INTO sections VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(seed.sectionId, seed.project, seed.env, seed.env, seed.canonicalProject, 'https://dash.test', 'raf:bugs', 'fp-read-1');
    db.prepare("INSERT INTO sync_state (section_id, phase, journal_cursor, snapshot_complete) VALUES (?, 'incremental', '7', 1)").run(seed.sectionId);
    const payload = JSON.stringify({ description: `bug ${seed.rawId}`, claim_token: seed.claimToken });
    const bug = db.prepare(`INSERT INTO bugs (section_id, project, env, source, owner, raw_id, problem_id, canonical_project, revision, status, state, claimed_by, payload,
      server_created_at, detail_revision, detail_complete, presence, synced_at) VALUES (?, ?, ?, 'qa', 'owner-1', ?, ?, ?, 4, 'in_progress', 'new', 'raf:bugs', ?, ?, 4, 1, 'present', ?)`)
      .run(seed.sectionId, seed.project, seed.env, seed.rawId, `problem-${seed.rawId}`, seed.canonicalProject, payload, seed.at, seed.at);
    const bugPk = Number(bug.lastInsertRowid);
    db.prepare(`INSERT INTO comments (bug_pk, server_id, origin, author_id, author_kind, text, created_at, payload) VALUES (?, 'srv-c-1', 'server', 'human', 'human', 'серверний', ?, ?)`)
      .run(bugPk, seed.at, JSON.stringify({ id: 'srv-c-1', claim_token: seed.claimToken }));
    for (const local of locals) {
      const comment = db.prepare(`INSERT INTO comments (bug_pk, server_id, origin, operation_id, author_id, author_kind, text, created_at, payload) VALUES (?, ?, 'local', ?, 'raf:bugs', 'agent', ?, ?, NULL)`)
        .run(bugPk, local.serverId, local.operationId, local.text, seed.at);
      db.prepare(`INSERT INTO outbox (operation_id, kind, bug_pk, comment_pk, section_id, request_json, expected_revision, claims_fingerprint, state, attempts, server_comment_id, created_at, updated_at)
        VALUES (?, 'comment.add', ?, ?, ?, ?, 4, 'fp-write-1', ?, 1, ?, ?, ?)`)
        .run(local.operationId, bugPk, Number(comment.lastInsertRowid), seed.sectionId, JSON.stringify({ operation_id: local.operationId, expected_revision: 4, text: local.text }), local.state, local.serverId, seed.at, seed.at);
    }
    db.exec('PRAGMA user_version = 1');
  } finally {
    db.close();
  }
}
