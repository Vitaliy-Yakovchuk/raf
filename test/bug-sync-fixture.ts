import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import {
  openBugStore,
  type BugRepository,
  type BugSectionInput,
  type BugSectionView,
  type BugStoreOptions,
  type CommentRequestBody,
  type LocalCommentReceipt,
  type ServerAttachment,
  type ServerBugDetail,
  type ServerBugKey,
  type ServerComment,
} from '../src/bug-store.ts';
import {
  BugServerError,
  ClaimsError,
  createBugSyncer,
  type BugServerPort,
  type BugSyncConfig,
  type BugSyncer,
  type ClaimsIssuer,
  type ClaimsScope,
  type Clock,
  type DetailPageRequest,
  type IssuedClaims,
  type MainNotice,
  type MainNotifier,
  type ServerAuth,
  type ServerBugDetailPage,
  type ServerBugListPage,
  type ServerJournalEvent,
  type ServerJournalPage,
} from '../src/bug-sync.ts';

export const ACTOR = 'raf:bugs';
export const CLAIM_OWNER = 'conductor:bugs';
export const START = '2026-10-22T10:00:00.000Z';

export function testBugsConf(): Record<string, unknown> {
  return {
    fileName: 'bugs.sqlite',
    attachmentsDirectory: 'attachments',
    attachmentCacheMaxBytes: 1000,
    origin: 'https://dash.test',
    actor: ACTOR,
    tokenLifetimeSeconds: 300,
    pollIntervalMs: 1000,
    pageLimit: 2,
    requestTimeoutMs: 1000,
    retry: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 8000 },
    sections: [
      { project: 'etchly', env: 'prod', stand: 'prod', secret: 'DASH_BUGS_PROD_ETCHLY' },
      { project: 'etchly', env: 'dev', stand: 'dev1', secret: 'DASH_BUGS_DEV1_ETCHLY' },
      { project: 'ramus-cloud', env: 'prod', stand: 'prod', secret: 'DASH_BUGS_PROD_RAMUS_CLOUD' },
    ],
  };
}

export function testConfig(overrides: Partial<BugSyncConfig> = {}): BugSyncConfig {
  const raw = testBugsConf();
  return {
    fileName: raw.fileName as string,
    origin: raw.origin as string,
    actor: raw.actor as string,
    sections: raw.sections as BugSyncConfig['sections'],
    tokenLifetimeSeconds: raw.tokenLifetimeSeconds as number,
    pollIntervalMs: raw.pollIntervalMs as number,
    pageLimit: raw.pageLimit as number,
    requestTimeoutMs: raw.requestTimeoutMs as number,
    retry: raw.retry as BugSyncConfig['retry'],
    ...overrides,
  };
}

export const ETCHLY: BugSectionInput = {
  sectionId: 'etchly:prod',
  project: 'etchly',
  env: 'prod',
  stand: 'prod',
  canonicalProject: 'projects/etchly',
  origin: 'https://dash.test',
  actor: ACTOR,
  claimsFingerprint: 'fp-read-1',
};

export const ETCHLY_DEV: BugSectionInput = { ...ETCHLY, sectionId: 'etchly:dev', env: 'dev', stand: 'dev1' };

export const RAMUS: BugSectionInput = {
  ...ETCHLY,
  sectionId: 'ramus-cloud:prod',
  project: 'ramus-cloud',
  canonicalProject: 'projects/ramus-cloud',
};

export class ManualClock implements Clock {
  private current: number;

  constructor(start: string = START) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  iso(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export class FakeClaims implements ClaimsIssuer {
  private version = 1;
  issueError: Error | null = null;
  readonly missingSecrets = new Set<string>();
  issued = 0;

  setVersion(version: number): void {
    this.version = version;
  }

  fingerprint(section: BugSectionView, scope: ClaimsScope): string {
    return `fp-${scope}-${this.version}-${section.sectionId}`;
  }

  async issue(section: BugSectionView, scope: ClaimsScope): Promise<IssuedClaims> {
    if (this.issueError) throw this.issueError;
    if (this.missingSecrets.has(section.sectionId)) throw new ClaimsError('secret-missing', section.sectionId, `secret for ${section.sectionId} is missing`);
    this.issued += 1;
    const fingerprint = this.fingerprint(section, scope);
    return { token: `fake|${scope}|${fingerprint}`, fingerprint, expiresAt: '2099-01-01T00:00:00.000Z' };
  }
}

export class FakeNotifier implements MainNotifier {
  readonly calls: MainNotice[] = [];
  readonly delivered = new Map<string, MainNotice>();
  private failures = 0;

  failNext(count = 1): void {
    this.failures += count;
  }

  async notify(notice: MainNotice): Promise<void> {
    this.calls.push(notice);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('main delivery unavailable');
    }
    if (!this.delivered.has(notice.noticeKey)) this.delivered.set(notice.noticeKey, notice);
  }
}

type Method = 'query' | 'read' | 'events' | 'comment';

interface FakeBug {
  key: ServerBugKey;
  problemId: string;
  revision: number;
  status: string;
  state: string;
  createdAt: string;
  claimedBy: string | null;
  payload: unknown;
  comments: ServerComment[];
  attachments: ServerAttachment[];
}

interface FakeOperation {
  fingerprint: string;
  body: string;
  response: ServerBugDetailPage;
}

interface FakeFailure {
  method: Method;
  error: Error;
  when: (key: ServerBugKey | null) => boolean;
}

export interface SeedBug {
  rawId: string;
  status?: string;
  claimedBy?: string | null;
  comments?: readonly { authorId: string; text: string }[];
  attachments?: readonly { id: string; commentIndex?: number; bytes: number; sha256: string }[];
}

export interface RecordedCall {
  method: Method;
  auth: ServerAuth;
  key: ServerBugKey | null;
  input: unknown;
}

export interface RecordedComment {
  key: ServerBugKey;
  body: CommentRequestBody;
  raw: string;
}

export function serverKey(section: Pick<BugSectionInput, 'project' | 'env'>, rawId: string): ServerBugKey {
  return { project: section.project, env: section.env, source: 'qa', owner: 'owner-1', rawId };
}

export function canonical(section: Pick<BugSectionInput, 'canonicalProject'>, rawId: string): string {
  return `${section.canonicalProject}/bug#${rawId}`;
}

const keyId = (key: ServerBugKey): string => [key.project, key.env, key.source, key.owner, key.rawId].join('/');

export const notFound = (): BugServerError => new BugServerError(404, 'not-found', 'not found');
export const unauthenticated = (): BugServerError => new BugServerError(401, 'unauthenticated', 'unauthenticated');
export const accessDenied = (): BugServerError => new BugServerError(403, 'access-denied', 'access denied');
export const conflict = (): BugServerError => new BugServerError(409, 'conflict', 'conflict');
export const invalidInput = (): BugServerError => new BugServerError(422, 'invalid-input', 'invalid input');
export const unavailable = (retryAfterMs: number | null = null): BugServerError => new BugServerError(503, 'unavailable', 'unavailable', retryAfterMs);
export const networkDown = (): BugServerError => new BugServerError(null, 'network', 'network down');

export class FakeBugServer implements BugServerPort {
  readonly calls: RecordedCall[] = [];
  readonly commentRequests: RecordedComment[] = [];
  mutations = 0;
  private readonly bugs = new Map<string, FakeBug>();
  private readonly journal: { section: string; event: ServerJournalEvent }[] = [];
  private readonly operations = new Map<string, FakeOperation>();
  private readonly failures: FakeFailure[] = [];
  private readonly invalidJournalCursors = new Set<string>();
  private cursorSeq = 0;
  private commentSeq = 0;
  private problemSeq = 0;
  private listEpoch = 1;
  private lostResponses = 0;
  private appendAfterComment: { authorId: string; text: string } | null = null;
  private gate: Promise<void> | null = null;

  seedBug(section: Pick<BugSectionInput, 'project' | 'env'>, seed: SeedBug): ServerBugKey {
    const key = serverKey(section, seed.rawId);
    this.problemSeq += 1;
    const bug: FakeBug = {
      key,
      problemId: `problem-${this.problemSeq}`,
      revision: 1,
      status: seed.status ?? 'open',
      state: 'new',
      createdAt: START,
      claimedBy: seed.claimedBy ?? null,
      payload: { description: `bug ${seed.rawId}` },
      comments: [],
      attachments: [],
    };
    for (const comment of seed.comments ?? []) bug.comments.push(this.newComment(comment.authorId, comment.text));
    for (const attachment of seed.attachments ?? []) {
      bug.attachments.push({
        id: attachment.id,
        commentId: attachment.commentIndex === undefined ? null : bug.comments[attachment.commentIndex]!.id,
        kind: 'file',
        mime: 'text/plain',
        bytes: attachment.bytes,
        sha256: attachment.sha256,
      });
    }
    this.bugs.set(keyId(key), bug);
    this.emit(bug, 'created', {});
    return key;
  }

  addComment(key: ServerBugKey, authorId: string, text: string): ServerComment {
    const bug = this.require(key);
    const comment = this.newComment(authorId, text);
    bug.comments.push(comment);
    bug.revision += 1;
    this.emit(bug, 'comment', {});
    return comment;
  }

  hideComment(key: ServerBugKey, commentId: string): void {
    const bug = this.require(key);
    bug.comments = bug.comments.filter((comment) => comment.id !== commentId);
    bug.revision += 1;
    this.emit(bug, 'comment', { child_table: 'bug_comments', action: 'delete' });
  }

  setStatus(key: ServerBugKey, status: string): void {
    const bug = this.require(key);
    bug.status = status;
    bug.revision += 1;
    this.emit(bug, 'status', { status });
  }

  claim(key: ServerBugKey, by: string): void {
    const bug = this.require(key);
    bug.claimedBy = by;
    bug.revision += 1;
    this.emit(bug, 'status', { claimed_by: by });
  }

  deleteBug(key: ServerBugKey): void {
    const bug = this.require(key);
    this.bugs.delete(keyId(key));
    this.emit(bug, 'status', { deleted: true });
  }

  eraseBug(key: ServerBugKey): void {
    const bug = this.require(key);
    this.bugs.delete(keyId(key));
    for (let index = this.journal.length - 1; index >= 0; index -= 1) {
      const entry = this.journal[index]!;
      if (entry.event.problemId !== bug.problemId) continue;
      this.invalidJournalCursors.add(entry.event.cursor);
      this.journal.splice(index, 1);
    }
  }

  invalidateListCursors(): void {
    this.listEpoch += 1;
  }

  invalidateJournalCursor(cursor: string): void {
    this.invalidJournalCursors.add(cursor);
  }

  head(section: Pick<BugSectionInput, 'project' | 'env'>): string {
    const events = this.journal.filter((entry) => entry.section === `${section.project}/${section.env}`);
    return events.length === 0 ? '0' : events[events.length - 1]!.event.cursor;
  }

  serverComments(key: ServerBugKey): readonly ServerComment[] {
    return [...this.require(key).comments];
  }

  detail(key: ServerBugKey): ServerBugDetail {
    const bug = this.require(key);
    return {
      key: bug.key,
      problemId: bug.problemId,
      revision: bug.revision,
      status: bug.status,
      state: bug.state,
      createdAt: bug.createdAt,
      claimedBy: bug.claimedBy,
      payload: bug.payload,
      comments: [...bug.comments],
      attachments: [...bug.attachments],
      complete: true,
      errorCode: null,
    };
  }

  failNext(method: Method, error: Error, when: (key: ServerBugKey | null) => boolean = () => true): void {
    this.failures.push({ method, error, when });
  }

  loseNextResponse(): void {
    this.lostResponses += 1;
  }

  appendAfterNextComment(authorId: string, text: string): void {
    this.appendAfterComment = { authorId, text };
  }

  pauseComments(): () => void {
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = null;
      release();
    };
  }

  callsOf(method: Method): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async query(auth: ServerAuth, input: { readonly cursor: string | null; readonly limit: number }): Promise<ServerBugListPage> {
    this.record('query', auth, null, input);
    const fingerprint = this.fingerprint(auth);
    let offset = 0;
    if (input.cursor !== null) {
      const [prefix, epoch, owner, position] = input.cursor.split('|');
      if (prefix !== 'list' || Number(epoch) !== this.listEpoch || owner !== fingerprint) throw invalidInput();
      offset = Number(position);
    }
    const all = this.sectionBugs(auth);
    const page = all.slice(offset, offset + input.limit);
    const next = offset + input.limit < all.length ? `list|${this.listEpoch}|${fingerprint}|${offset + input.limit}` : null;
    return { bugs: page.map((bug) => ({ key: bug.key, problemId: bug.problemId, revision: bug.revision })), nextCursor: next };
  }

  async read(auth: ServerAuth, key: ServerBugKey, input: DetailPageRequest): Promise<ServerBugDetailPage> {
    this.record('read', auth, key, input);
    const bug = this.bugs.get(keyId(key));
    if (!bug || bug.key.project !== auth.project || bug.key.env !== auth.env) throw notFound();
    const first = input.commentsCursor === null && input.attachmentsCursor === null;
    const slice = <T>(items: readonly T[], cursor: string | null, prefix: string): { items: T[]; next: string | null } => {
      if (!first && cursor === null) return { items: [], next: null };
      const start = cursor === null ? 0 : Number(cursor.slice(prefix.length));
      const end = start + input.limit;
      return { items: items.slice(start, end), next: end < items.length ? `${prefix}${end}` : null };
    };
    const comments = slice(bug.comments, input.commentsCursor, 'cm:');
    const attachments = slice(bug.attachments, input.attachmentsCursor, 'at:');
    return {
      bug: this.header(bug),
      comments: comments.items,
      attachments: attachments.items,
      nextCommentsCursor: comments.next,
      nextAttachmentsCursor: attachments.next,
    };
  }

  async events(auth: ServerAuth, input: { readonly cursor: string; readonly limit: number }): Promise<ServerJournalPage> {
    this.record('events', auth, null, input);
    if (this.invalidJournalCursors.has(input.cursor)) throw invalidInput();
    const after = Number(input.cursor);
    const all = this.journal
      .filter((entry) => entry.section === `${auth.project}/${auth.env}` && Number(entry.event.cursor) > after)
      .map((entry) => entry.event);
    const events = all.slice(0, input.limit);
    const cursor = events.length === 0 ? input.cursor : events[events.length - 1]!.cursor;
    return { events, cursor, hasMore: all.length > events.length };
  }

  async comment(auth: ServerAuth, key: ServerBugKey, body: CommentRequestBody): Promise<ServerBugDetailPage> {
    const raw = JSON.stringify(body);
    this.record('comment', auth, key, body);
    this.commentRequests.push({ key, body, raw });
    if (this.gate) await this.gate;
    if (auth.token.split('|')[1] !== 'write') throw accessDenied();
    const fingerprint = this.fingerprint(auth);
    const known = this.operations.get(body.operation_id);
    if (known) {
      if (known.body !== raw || known.fingerprint !== fingerprint) throw conflict();
      return this.deliver(known.response);
    }
    const bug = this.bugs.get(keyId(key));
    if (!bug) throw notFound();
    if (bug.claimedBy !== null && bug.claimedBy !== ACTOR) {
      const target = bug.comments.find((comment) => comment.id === body.reply_to);
      if (!target || target.authorId !== bug.claimedBy) throw conflict();
    }
    if (bug.revision !== body.expected_revision) throw conflict();
    bug.comments.push(this.newComment(ACTOR, body.text, body.reply_to ?? null));
    if (this.appendAfterComment) {
      bug.comments.push(this.newComment(this.appendAfterComment.authorId, this.appendAfterComment.text));
      this.appendAfterComment = null;
    }
    bug.revision += 1;
    this.mutations += 1;
    this.emit(bug, 'comment', {});
    const response: ServerBugDetailPage = {
      bug: this.header(bug),
      comments: [...bug.comments],
      attachments: [...bug.attachments],
      nextCommentsCursor: null,
      nextAttachmentsCursor: null,
    };
    this.operations.set(body.operation_id, { fingerprint, body: raw, response });
    return this.deliver(response);
  }

  private deliver(response: ServerBugDetailPage): ServerBugDetailPage {
    if (this.lostResponses > 0) {
      this.lostResponses -= 1;
      throw networkDown();
    }
    return response;
  }

  private record(method: Method, auth: ServerAuth, key: ServerBugKey | null, input: unknown): void {
    this.calls.push({ method, auth, key, input });
    const index = this.failures.findIndex((failure) => failure.method === method && failure.when(key));
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      if (method === 'comment') this.commentRequests.push({ key: key!, body: input as CommentRequestBody, raw: JSON.stringify(input) });
      throw failure!.error;
    }
  }

  private fingerprint(auth: ServerAuth): string {
    return auth.token.split('|')[2] ?? '';
  }

  private sectionBugs(auth: ServerAuth): FakeBug[] {
    return [...this.bugs.values()]
      .filter((bug) => bug.key.project === auth.project && bug.key.env === auth.env)
      .sort((left, right) => left.key.rawId.localeCompare(right.key.rawId));
  }

  private header(bug: FakeBug): ServerBugDetailPage['bug'] {
    return {
      key: bug.key,
      problemId: bug.problemId,
      revision: bug.revision,
      status: bug.status,
      state: bug.state,
      createdAt: bug.createdAt,
      claimedBy: bug.claimedBy,
      payload: bug.payload,
    };
  }

  private newComment(authorId: string, text: string, replyTo: string | null = null): ServerComment {
    this.commentSeq += 1;
    const id = `srv-c-${this.commentSeq}`;
    return {
      id,
      authorId,
      authorKind: authorId === ACTOR ? 'agent' : 'human',
      text,
      replyTo,
      createdAt: START,
      payload: { id, author_id: authorId, text, reply_to: replyTo },
    };
  }

  private emit(bug: FakeBug, kind: string, payload: unknown): void {
    this.cursorSeq += 1;
    this.journal.push({
      section: `${bug.key.project}/${bug.key.env}`,
      event: { cursor: String(this.cursorSeq), problemId: bug.problemId, key: bug.key, kind, payload },
    });
  }

  private require(key: ServerBugKey): FakeBug {
    const bug = this.bugs.get(keyId(key));
    if (!bug) throw new Error(`fake server has no bug ${keyId(key)}`);
    return bug;
  }
}

export interface BugHarness {
  readonly dir: string;
  readonly path: string;
  readonly config: BugSyncConfig;
  readonly clock: ManualClock;
  readonly server: FakeBugServer;
  readonly claims: FakeClaims;
  readonly notifier: FakeNotifier;
  readonly repo: BugRepository;
  readonly syncer: BugSyncer;
  reopen(options?: BugStoreOptions): void;
  close(): void;
  addComment(bugKey: string, text: string): LocalCommentReceipt;
  visibleTexts(bugKey: string): string[];
}

export function createBugHarness(
  t: TestContext,
  options: { sections?: readonly BugSectionInput[]; config?: Partial<BugSyncConfig>; store?: BugStoreOptions } = {},
): BugHarness {
  const dir = mkdtempSync(join(tmpdir(), 'raf-bug-sync-'));
  const path = join(dir, 'bugs.sqlite');
  const config = testConfig(options.config);
  const clock = new ManualClock();
  const server = new FakeBugServer();
  const claims = new FakeClaims();
  const notifier = new FakeNotifier();
  const sections = options.sections ?? [ETCHLY];
  let repo: BugRepository | null = null;
  let syncer: BugSyncer | null = null;
  const open = (storeOptions: BugStoreOptions = {}): void => {
    repo = openBugStore(path, storeOptions);
    for (const section of sections) repo.upsertSection({ ...section, claimsFingerprint: claims.fingerprint(section, 'read') });
    syncer = createBugSyncer({ repository: repo, server, claims, notifier, clock, config });
  };
  t.after(() => {
    try {
      repo?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  open(options.store);
  const sectionOf = (bugKey: string): BugSectionInput => {
    const found = sections.find((section) => bugKey.startsWith(`${section.canonicalProject}/bug#`));
    if (!found) throw new Error(`no test section for ${bugKey}`);
    return found;
  };
  return {
    dir,
    path,
    config,
    clock,
    server,
    claims,
    notifier,
    get repo() {
      return repo!;
    },
    get syncer() {
      return syncer!;
    },
    reopen(storeOptions: BugStoreOptions = {}) {
      repo?.close();
      repo = null;
      open(storeOptions);
    },
    close() {
      repo?.close();
      repo = null;
    },
    addComment(bugKey: string, text: string) {
      return repo!.addLocalComment({
        bugKey,
        text,
        authorId: ACTOR,
        authorKind: 'agent',
        claimsFingerprint: claims.fingerprint(sectionOf(bugKey), 'write'),
        at: clock.iso(),
      });
    },
    visibleTexts(bugKey: string) {
      return repo!.findBug(bugKey).comments.map((comment) => comment.text);
    },
  };
}

export function detailOf(section: Pick<BugSectionInput, 'project' | 'env'>, rawId: string, overrides: Partial<ServerBugDetail> = {}): ServerBugDetail {
  return {
    key: serverKey(section, rawId),
    problemId: `problem-${section.project}-${section.env}-${rawId}`,
    revision: 1,
    status: 'open',
    state: 'new',
    createdAt: START,
    claimedBy: null,
    payload: { description: `bug ${rawId}` },
    comments: [],
    attachments: [],
    complete: true,
    errorCode: null,
    ...overrides,
  };
}
