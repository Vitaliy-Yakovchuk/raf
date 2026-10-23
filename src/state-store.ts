import type { LaunchQueueTransaction, LaunchQueueState } from './launch-queue-events.ts';
import type { ResourceWaitLastGrant } from './resource-wait-protocol.ts';
import type { ReportRejectionSnapshot } from './report-rejection.ts';
import type { TaskReservationSet } from "./task-reservations.ts";
import type { PendingEvent } from "./event-registry.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalStatePath, stateFailure, verifyStateContext } from "./state-migration-guard.ts";
import { inspectStateSchema } from './state-schema.ts';
import { ReminderService, type Reminder, type ReminderRepository, type ReminderTransaction } from "./reminders.ts";
import type { ReminderSessionEffect } from "./reminder-repository.ts";
import type { SessionRepository, SessionTransaction, SessionRecord, PendingIntent, AdmissionReservation } from "./session-state.ts";
import { createResultNotice, createReportRejectionNotice, type ResultNotice } from './launcher-notice.ts';
import { settleStartupContextReview } from './startup-context.ts';

export type RunnerInitialState = { id: string; initialEnabled: boolean };

export type QuotaState = {
  snapshot: unknown;
  observedAt: string | null;
  lastAttemptAt: string;
  error: string | null;
};

export type CommandTiming = { averageMs: number; updatedAt: string };

type TaskReservationTransaction = SessionTransaction & {
  listTaskReservations(): TaskReservationSet[];
  putTaskReservation(reservation: TaskReservationSet): void;
  deleteTaskReservation(runId: string): void;
};

export type ReminderDeliveryMark = { reminderId: string; key: string; receiptId: string; deliveredAt: string };

export type ClosureNotice = { id: string; runId: string; address: string; recipient: string; text: string };

export type DeliveryClaimOwner = { token: string; pid: number; processStart: string | null };

export type DeliveryOwnerProbe = (owner: DeliveryClaimOwner) => boolean;

export function reminderDeliveryKey(reminder: Pick<Reminder, 'assignedTo' | 'text' | 'at'>): string {
  return JSON.stringify([reminder.assignedTo, reminder.text, reminder.at]);
}

export interface StateStore {
  readonly startupContextDatabase: DatabaseSync;
  resultNotices: {
    stageReportDiagnostic(runId: string, reason: string): void;
    stageReportRejection(runId: string, snapshot: ReportRejectionSnapshot): void;
    list(): ResultNotice[];
    claim(id: string, owner: DeliveryClaimOwner, claimedAt: string, isOwnerAlive: DeliveryOwnerProbe): ResultNotice | undefined;
    complete(id: string, token: string, error: string | null): void;
  };
  reminderDeliveries: {
    get(reminderId: string): ReminderDeliveryMark | undefined;
    mark(value: ReminderDeliveryMark): boolean;
    claim(reminderId: string, owner: DeliveryClaimOwner, claimedAt: string, isOwnerAlive: DeliveryOwnerProbe): { reminder: Reminder; key: string } | undefined;
    confirm(value: ReminderDeliveryMark, token: string): boolean;
    release(reminderId: string, token: string): void;
  };
  closureNotices: {
    stage(): ClosureNotice[];
    listUndelivered(): ClosureNotice[];
    claim(id: string, owner: DeliveryClaimOwner, claimedAt: string, isOwnerAlive: DeliveryOwnerProbe): ClosureNotice | undefined;
    markDelivered(id: string, receiptId: string, deliveredAt: string, token?: string): boolean;
    release(id: string, token: string): void;
    discard(id: string): void;
  };
  eventRepository: { transaction<T>(action: (tx: LaunchQueueTransaction) => T): T };
  claimResourceWaitEpoch(epoch: string): void;
  readResourceWaitGrant(): ResourceWaitLastGrant | null;
  commitResourceWaitGrant(change: { expectedEpoch: string; previous: ResourceWaitLastGrant | null; next: ResourceWaitLastGrant }): 'committed' | 'not-committed';
  getResourceWaitLastGrant(): number | null;
  saveResourceWaitLastGrant(at: number): void;
  taskReservationRepository: { transaction<T>(action: (tx: TaskReservationTransaction) => T): T };
  sessionRepository: SessionRepository;
  reminderRepository: ReminderRepository;
  close(): void;
  getRunnerEnabled(id: string): boolean | undefined;
  initializeRunners(entries: RunnerInitialState[]): void;
  setRunnerEnabled(id: string, enabled: boolean): void;
  setQuotaSnapshot(runner: string, value: unknown, observedAt: string): void;
  recordQuotaError(runner: string, message: string, attemptedAt: string): void;
  getQuota(runner: string): QuotaState | undefined;
  acquireQuotaLease(key: string, token: string, pid: number, expiresAt: string, isStale: (holder: { pid: number; expiresAt: string }) => boolean): boolean;
  releaseQuotaLease(key: string, token: string): void;
  recordCommandDuration(command: string, durationMs: number, alpha: number): void;
  getCommandTiming(command: string): CommandTiming | undefined;
}

export const STATE_SCHEMA_VERSION = 14;
export const STATE_SCHEMA_SUPPORTED_VERSIONS = [12, 13, 14] as const;

export async function retryStateOperation<T>(action: () => T, budget: { transitionMs: number; pollMs: number }): Promise<T> {
  if (![budget.transitionMs, budget.pollMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('SQLite retry requires a positive transition and polling budget');
  const deadline = Date.now() + budget.transitionMs;
  for (;;) {
    try { return action(); }
    catch (error) {
      const source = error as { code?: string; errcode?: number };
      if (!source?.code?.startsWith('ERR_SQLITE') || ![5, 6].includes((source.errcode ?? 0) & 255)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(budget.pollMs, remaining)));
      if (Date.now() >= deadline) throw error;
    }
  }
}

export function openStateStore(path: string, options?: import('./state-migration-guard.ts').StateStoreOpenOptions): StateStore {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("An explicit database path is required");
  }

  const checkContext = () => {
    if (!options?.context) return;
    verifyStateContext(options.context);
    if (path !== options.context.statePath || canonicalStatePath(path) !== path) {
      throw stateFailure('STATE_CONTEXT_REFUSED', `State path ${path} differs from resolved context ${options.context.statePath}`);
    }
  };
  checkContext();
  const permit = options?.transfer;
  if (permit && (permit.toVersion !== STATE_SCHEMA_VERSION || !Number.isSafeInteger(permit.fromVersion) ||
      permit.fromVersion < 1 || permit.fromVersion >= permit.toVersion)) {
    throw stateFailure('STATE_SCHEMA_UNSUPPORTED', 'Unsupported transfer versions or downgrade');
  }
  if (permit && (path === ':memory:' || permit.statePath !== path || !requireAbsolute(path))) {
    throw stateFailure('STATE_MIGRATION_CONFLICT', 'Transfer permit must name this exact absolute state path');
  }
  function requireAbsolute(value: string) { return resolve(value) === value; }
  const checkVersion = ({ version, objects }: { version: number; objects: unknown }) => {
    if (!Number.isSafeInteger(version) || version < 0 || version > STATE_SCHEMA_VERSION || version === 0 && objects) {
      throw stateFailure('STATE_SCHEMA_UNSUPPORTED', `Unsupported state schema at ${path}: version ${version}; target ${STATE_SCHEMA_VERSION}`);
    }
    if (permit && version !== permit.fromVersion && version !== permit.toVersion) {
      throw stateFailure('STATE_MIGRATION_CONFLICT', `State ${path} is at ${version}; expected ${permit.fromVersion} or ${permit.toVersion}`);
    }
    if (!permit && version > 0 && !STATE_SCHEMA_SUPPORTED_VERSIONS.includes(version as 12 | 13 | 14)) {
      throw stateFailure('STATE_MIGRATION_REQUIRED', `State ${path} is at version ${version}; explicit migration to ${STATE_SCHEMA_VERSION} required`);
    }
    return version;
  };
  const checkSchema = (database: DatabaseSync) => checkVersion({
    version: Number(database.prepare('PRAGMA user_version').get()?.user_version),
    objects: database.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get(),
  });
  if (path !== ':memory:' && existsSync(path)) {
    checkContext();
    checkVersion(inspectStateSchema(path));
  }


  function operation<T>(name: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      const source = error as { code?: string; errcode?: number; message?: string };
      if (source?.code?.startsWith("ERR_SQLITE")) {
        throw Object.assign(new Error(`State store ${name} failed (SQLite ${source.errcode ?? source.code}): ${source.message ?? String(error)}`, { cause: error }), {
          code: source.code,
          errcode: source.errcode,
          operation: name,
        });
      }
      throw error;
    }
  }

  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  checkContext();
  const beforeOpen = path !== ':memory:' && existsSync(path) ? statSync(path) : undefined;
  const db = operation("open", () => new DatabaseSync(path, { timeout: 250 }));
  try {
    checkContext();
    if (options?.context) {
      const openedPath = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
      const actual = statSync(String(openedPath));
      if (canonicalStatePath(String(openedPath)) !== options.context.statePath ||
          beforeOpen && (beforeOpen.dev !== actual.dev || beforeOpen.ino !== actual.ino)) {
        throw stateFailure('STATE_CONTEXT_REFUSED', `Opened state identity differs from ${path}`);
      }
    }
    checkSchema(db);
  } catch (error) { db.close(); throw error; }
  let transactionDepth = 0;
  function transaction<T>(action: () => T, immediate = true): T {
    const savepoint = transactionDepth ? `raf_nested_${transactionDepth}` : null;
    db.exec(savepoint ? `SAVEPOINT ${savepoint}` : immediate ? "BEGIN IMMEDIATE" : "BEGIN");
    transactionDepth++;
    try {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("State transactions must be synchronous");
      db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec(savepoint ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
        if (savepoint) db.exec(`RELEASE ${savepoint}`);
      } catch {                                      }
      throw error;
    } finally { transactionDepth--; }
  }

  try {
    operation("initialize", () => {


      const version = () => Number(db.prepare("PRAGMA user_version").get()?.user_version);
      checkSchema(db);
      if (version() === 0 || permit && version() < STATE_SCHEMA_VERSION) {
        transaction(() => {

          checkContext();
          const current = checkSchema(db);
          if (current === STATE_SCHEMA_VERSION) return;
          if (current === 0) {
          db.exec(`
            CREATE TABLE runners (
              id TEXT PRIMARY KEY NOT NULL,
              enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
            ) STRICT;
            CREATE TABLE quotas (
              runner TEXT PRIMARY KEY NOT NULL,
              snapshot TEXT,
              observed_at TEXT,
              last_attempt_at TEXT NOT NULL,
              error TEXT
            ) STRICT;
            CREATE TABLE command_timings (
              command TEXT PRIMARY KEY NOT NULL,
              average_ms REAL NOT NULL CHECK(average_ms >= 0),
              updated_at TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 1;
          `);
          options?.afterMigrationStep?.(1);
          }
          if (current < 2) { db.exec(`
            CREATE TABLE sessions (
              run_id TEXT PRIMARY KEY NOT NULL,
              address_id TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('reserved', 'running', 'exited', 'finished')),
              finished_at TEXT,
              payload TEXT NOT NULL
            ) STRICT;
            CREATE UNIQUE INDEX sessions_active_address ON sessions(address_id) WHERE state != 'finished';
            CREATE INDEX sessions_retention ON sessions(state, finished_at);
            CREATE TABLE admission_reservations (
              run_id TEXT PRIMARY KEY NOT NULL,
              payload TEXT NOT NULL
            ) STRICT;
            CREATE TABLE pending_intents (
              id TEXT PRIMARY KEY NOT NULL,
              payload TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 2;
          `); options?.afterMigrationStep?.(2); }
          if (current < 3) { db.exec(`
            CREATE TABLE reminders (
              id TEXT PRIMARY KEY NOT NULL,
              created_for TEXT NOT NULL,
              assigned_to TEXT NOT NULL,
              at TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'closed')),
              closed_at TEXT,
              payload TEXT NOT NULL
            ) STRICT;
            CREATE INDEX reminders_due ON reminders(state, at);
            CREATE INDEX reminders_retention ON reminders(state, closed_at);
            PRAGMA user_version = 3;
          `); options?.afterMigrationStep?.(3); }
          if (current < 4) { db.exec(`
            ALTER TABLE pending_intents ADD COLUMN run_id TEXT;
            UPDATE pending_intents SET run_id = json_extract(payload, '$.runId');
            PRAGMA user_version = 4;
          `); options?.afterMigrationStep?.(4); }
          if (current < 5) { db.exec(`
            CREATE TABLE task_reservation_runs (
              run_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(run_id) ON DELETE CASCADE,
              address_id TEXT NOT NULL,
              fence TEXT UNIQUE NOT NULL,
              revision INTEGER NOT NULL CHECK(revision >= 0),
              machine_id TEXT NOT NULL,
              boot_id TEXT NOT NULL,
              stage TEXT NOT NULL CHECK(stage IN ('starting', 'handoff', 'running')),
              starter TEXT NOT NULL,
              wrapper TEXT,
              agent TEXT
            ) STRICT;
            CREATE TABLE task_reservations (
              project TEXT NOT NULL,
              change_instance TEXT NOT NULL,
              task_id TEXT NOT NULL,
              change_id TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              run_id TEXT NOT NULL REFERENCES task_reservation_runs(run_id) ON DELETE CASCADE,
              PRIMARY KEY(project, change_instance, task_id)
            ) STRICT;
            CREATE INDEX task_reservations_run ON task_reservations(run_id);
            CREATE TRIGGER task_reservations_session_finished AFTER UPDATE OF state ON sessions
              WHEN NEW.state = 'finished' BEGIN
                DELETE FROM task_reservation_runs WHERE run_id = NEW.run_id;
              END;
            PRAGMA user_version = 5;
          `); options?.afterMigrationStep?.(5); }
          if (current < 6) { db.exec(`
            CREATE TABLE resource_wait_state (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
              last_grant REAL NOT NULL
            ) STRICT;
            PRAGMA user_version = 6;
          `); options?.afterMigrationStep?.(6); }
          if (current < 7) { db.exec(`
            CREATE TABLE quota_leases (
              key TEXT PRIMARY KEY NOT NULL,
              token TEXT NOT NULL,
              pid INTEGER NOT NULL,
              expires_at TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 7;
          `); options?.afterMigrationStep?.(7); }
          if (current < 8) { db.exec(`
            CREATE TABLE reminder_deliveries (
              reminder_id TEXT PRIMARY KEY NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
              delivery_key TEXT NOT NULL,
              receipt_id TEXT NOT NULL,
              delivered_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE closure_notices (
              id TEXT PRIMARY KEY NOT NULL,
              run_id TEXT NOT NULL,
              address_id TEXT NOT NULL,
              recipient TEXT NOT NULL,
              text TEXT NOT NULL,
              receipt_id TEXT,
              delivered_at TEXT
            ) STRICT;
            CREATE INDEX closure_notices_undelivered ON closure_notices(delivered_at);
            PRAGMA user_version = 8;
          `); options?.afterMigrationStep?.(8); }
          if (current < 9) { db.exec(`
            CREATE TABLE delivery_claims (
              target TEXT PRIMARY KEY NOT NULL,
              delivery_key TEXT NOT NULL,
              token TEXT NOT NULL,
              pid INTEGER NOT NULL,
              process_start TEXT,
              claimed_at TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 9;
          `); options?.afterMigrationStep?.(9); }
          if (current < 10) { db.exec(`
            CREATE TABLE result_notices (
              id TEXT PRIMARY KEY NOT NULL,
              run_id TEXT NOT NULL,
              payload TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 10;
          `);
          options?.afterMigrationStep?.(10); }
          if (current < 11) { db.exec(`
            CREATE TABLE test_run_groups (
              project TEXT NOT NULL,
              workspace TEXT NOT NULL,
              group_id TEXT NOT NULL,
              payload TEXT NOT NULL,
              PRIMARY KEY (project, workspace, group_id)
            ) STRICT;
            PRAGMA user_version = 11;
          `);
          options?.afterMigrationStep?.(11); }
          if (current < 12) { db.exec(`
            CREATE TABLE resource_wait_protocol_state (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
              epoch TEXT NOT NULL,
              grant_json TEXT
            ) STRICT;
            INSERT INTO resource_wait_protocol_state(singleton, epoch, grant_json)
              SELECT 1, '', json_object('requestId','legacy','serviceEpoch','legacy','grantedAt',last_grant,'bootIdentity','legacy','monotonicAt',0) FROM resource_wait_state WHERE singleton=1;
            PRAGMA user_version = 12;
          `);
          options?.afterMigrationStep?.(12); }
          if (current < 13) { db.exec(`
            CREATE TABLE agent_launch_queues (
              state_domain TEXT NOT NULL,
              machine_id TEXT NOT NULL,
              queue_id TEXT NOT NULL UNIQUE,
              PRIMARY KEY (state_domain, machine_id)
            ) STRICT;
            CREATE TABLE agent_launch_queue_entries (
              request_id TEXT PRIMARY KEY NOT NULL,
              run_id TEXT NOT NULL UNIQUE,
              agent_id TEXT NOT NULL UNIQUE,
              payload TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 13;
          `);
          options?.afterMigrationStep?.(13); }
          if (current < 14) { db.exec(`
            ALTER TABLE agent_launch_queues ADD COLUMN payload TEXT;
            PRAGMA user_version = 14;
          `);
          options?.afterMigrationStep?.(14); }
        });
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const journal = db.prepare("PRAGMA journal_mode").get();
          if (journal?.journal_mode !== "wal") db.exec("PRAGMA journal_mode = WAL");
          break;
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (attempt >= 4 || (code !== 5 && code !== 6)) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000; PRAGMA journal_size_limit = 4194304");

    });
  } catch (error) {
    try { db.close(); } catch {                                        }
    throw error;
  }

  function withReminderTransaction<T>(action: (tx: ReminderTransaction) => T): T {
    let active = true;
    const access = <R>(action: () => R): R => {
      if (!active) throw new Error("Reminder transaction is closed");
      return action();
    };
    const tx: ReminderTransaction = {
      get: id => access(() => {
        const row = db.prepare("SELECT payload FROM reminders WHERE id = ?").get(id);
        return row ? JSON.parse(row.payload as string) as Reminder : undefined;
      }),
      list: () => access(() => db.prepare("SELECT payload FROM reminders").all().map(row => JSON.parse(row.payload as string) as Reminder)),
      save: reminder => access(() => {
        const existing = tx.get(reminder.id);
        if (existing && existing.createdFor !== reminder.createdFor) throw new Error("Original reminder address is immutable");
        db.prepare(`INSERT INTO reminders(id, created_for, assigned_to, at, state, closed_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET assigned_to = excluded.assigned_to, at = excluded.at,
          state = excluded.state, closed_at = excluded.closed_at, payload = excluded.payload`).run(
            reminder.id, reminder.createdFor, reminder.assignedTo, reminder.at, reminder.state, reminder.closedAt, JSON.stringify(reminder));
      }),
      remove: id => access(() => {
        db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
        db.prepare("DELETE FROM delivery_claims WHERE target = ?").run(`reminder:${id}`);
      }),
      session: address => access(() => {
        const row = db.prepare("SELECT state FROM sessions WHERE address_id = ? ORDER BY state = 'finished' LIMIT 1").get(address);
        return row ? { active: row.state !== 'finished' } : undefined;
      }),
      emit: event => access(() => {
        const reminder = tx.get(event.id);
        if (!reminder) throw new Error("Unknown reminder event object");
        const session = db.prepare("SELECT run_id FROM sessions WHERE address_id = ? AND state != 'finished'").get(reminder.assignedTo);
        const intent: PendingIntent = { id: `${event.kind}:${event.id}`, runId: session?.run_id as string ?? null,
          event: event.kind, payload: { ...event, address: reminder.assignedTo } };
        db.prepare("INSERT INTO pending_intents(id, run_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").run(intent.id, intent.runId, JSON.stringify(intent));
      }),
    };
    try { return action(tx); } finally { active = false; }
  }

  const reminderRepository: ReminderRepository = {
    transaction: action => operation("reminderTransaction", () => transaction(() => withReminderTransaction(action))),
  };

  function withSessionTransaction<T>(action: (tx: TaskReservationTransaction) => T): T {
    let active = true;
    const access = <R>(operation: () => R): R => {
      if (!active) throw new Error("Session transaction is closed");
      return operation();
    };
    const tx: TaskReservationTransaction = {
      listTaskReservations: () => access(() => db.prepare("SELECT * FROM task_reservation_runs ORDER BY run_id").all().map(row => ({
        lease: { owner: { runId: row.run_id as string, addressId: row.address_id as string, fence: row.fence as string }, revision: row.revision as number },
        boot: { machineId: row.machine_id as string, bootId: row.boot_id as string },
        stage: row.stage as TaskReservationSet["stage"],
        starter: JSON.parse(row.starter as string),
        ...(row.wrapper === null ? {} : { wrapper: JSON.parse(row.wrapper as string) }),
        ...(row.agent === null ? {} : { agent: JSON.parse(row.agent as string) }),
        tasks: db.prepare("SELECT * FROM task_reservations WHERE run_id = ? ORDER BY project, change_instance, task_id").all(row.run_id).map(task => ({
          key: { project: task.project as string, changeId: task.change_id as string, taskId: task.task_id as string },
          changeInstance: task.change_instance as string, fingerprint: task.fingerprint as string,
        })),
      }))),
      putTaskReservation: reservation => access(() => {
        const { owner, revision } = reservation.lease;
        const session = tx.getSession(owner.runId);
        if (!session || session.addressId !== owner.addressId || session.state === "finished") throw new Error("Task reservation requires its active session");
        db.prepare(`INSERT INTO task_reservation_runs(run_id, address_id, fence, revision, machine_id, boot_id, stage, starter, wrapper, agent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET
          address_id = excluded.address_id, fence = excluded.fence, revision = excluded.revision, machine_id = excluded.machine_id,
          boot_id = excluded.boot_id, stage = excluded.stage, starter = excluded.starter, wrapper = excluded.wrapper, agent = excluded.agent`).run(
            owner.runId, owner.addressId, owner.fence, revision, reservation.boot.machineId, reservation.boot.bootId, reservation.stage,
            JSON.stringify(reservation.starter), reservation.wrapper ? JSON.stringify(reservation.wrapper) : null, reservation.agent ? JSON.stringify(reservation.agent) : null);
        db.prepare("DELETE FROM task_reservations WHERE run_id = ?").run(owner.runId);
        const insert = db.prepare("INSERT INTO task_reservations(project, change_instance, task_id, change_id, fingerprint, run_id) VALUES (?, ?, ?, ?, ?, ?)");
        for (const task of reservation.tasks) insert.run(task.key.project, task.changeInstance, task.key.taskId, task.key.changeId, task.fingerprint, owner.runId);
      }),
      deleteTaskReservation: runId => access(() => { db.prepare("DELETE FROM task_reservation_runs WHERE run_id = ?").run(runId); }),
      getSession: runId => access(() => {
        const row = db.prepare("SELECT payload FROM sessions WHERE run_id = ?").get(runId);
        return row ? JSON.parse(row.payload as string) as SessionRecord : undefined;
      }),
      listSessions: () => access(() => db.prepare("SELECT payload FROM sessions").all().map(row => JSON.parse(row.payload as string) as SessionRecord)),
      putSession: session => access(() => {
        if (session.state === 'finished') settleStartupContextReview(db, { reviewRunId: session.runId, status: session.result?.status ?? 'failed', finishedAt: session.finishedAt! });
        db.prepare(`INSERT INTO sessions(run_id, address_id, state, finished_at, payload) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET address_id = excluded.address_id, state = excluded.state,
          finished_at = excluded.finished_at, payload = excluded.payload`).run(
            session.runId, session.addressId, session.state, session.finishedAt ?? null, JSON.stringify(session));
        const notice = createResultNotice(session);
        if (notice) {
          if (notice.recipientRunId === null) {
            const recipient = tx.listSessions().find(row => row.addressId === notice.recipient && row.state === 'running');
            notice.recipientRunId = recipient?.runId ?? null;
          }
          db.prepare("INSERT INTO result_notices(id, run_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").run(notice.id, notice.runId, JSON.stringify(notice));
        }
        if (session.state === 'finished') db.prepare("UPDATE result_notices SET payload = json_set(payload, '$.source.state', 'finished', '$.source.revision', ?, '$.source.finishedAt', ?) WHERE run_id = ?").run(session.revision, session.finishedAt ?? null, session.runId);
      }),
      deleteSession: runId => access(() => { db.prepare("DELETE FROM sessions WHERE run_id = ?").run(runId); }),
      listReservations: () => access(() => db.prepare("SELECT payload FROM admission_reservations").all().map(row => JSON.parse(row.payload as string) as AdmissionReservation)),
      putReservation: reservation => access(() => {
        db.prepare(`INSERT INTO admission_reservations(run_id, payload) VALUES (?, ?)
          ON CONFLICT(run_id) DO UPDATE SET payload = excluded.payload`).run(reservation.runId, JSON.stringify(reservation));
      }),
      deleteReservation: runId => access(() => { db.prepare("DELETE FROM admission_reservations WHERE run_id = ?").run(runId); }),
      putPending: intent => access(() => {
        db.prepare(`INSERT INTO pending_intents(id, run_id, payload) VALUES (?, ?, ?)
          ON CONFLICT(id) DO NOTHING`).run(intent.id, intent.runId, JSON.stringify(intent));
      }),
      deletePending: id => access(() => { db.prepare("DELETE FROM pending_intents WHERE id = ?").run(id); }),
      listPending: () => access(() => db.prepare("SELECT payload FROM pending_intents").all().map(row => JSON.parse(row.payload as string) as PendingIntent)),
      applyEffects: effects => access(() => {
        for (const effect of effects) {
          if (effect.domain !== 'reminders') throw new Error("Unknown domain effect");
          const payload = effect.payload as ReminderSessionEffect['payload'];
          if (!payload || payload.operation !== 'session-ended' || !payload.end || !Number.isFinite(Date.parse(payload.at)))
            throw new Error("Invalid reminder session effect");
          const session = tx.getSession(payload.runId);
          if (!session || session.addressId !== payload.end.address) throw new Error("Reminder effect session address mismatch");
          if (payload.end.confirmedSucceeded && session.result?.status !== 'succeeded')
            throw new Error("Confirmed success requires an accepted session result");
          const service = new ReminderService({
            repository: { transaction: withReminderTransaction }, now: () => payload.at,
            nextId: () => { throw new Error("Session effects cannot create reminders"); },
            approvedEventKinds: ['reminder.closed'],
          });
          const result = service.sessionEnded({ ...payload.end, confirmedSucceeded: session.result?.status === 'succeeded' });
          if (!result.allowed) throw new Error("Session has unfinished reminders");
        }
      }),
    };
    try { return action(tx); } finally { active = false; }
  }

  const sessionRepository: SessionRepository = {
    transaction: (action, mode) => operation("sessionTransaction", () => {
      if (mode === 'read') db.exec('PRAGMA query_only = ON');
      try { return transaction(() => withSessionTransaction(action), mode !== 'read'); }
      finally { if (mode === 'read') db.exec('PRAGMA query_only = OFF'); }
    }),
  };
  const taskReservationRepository: StateStore["taskReservationRepository"] = {
    transaction: action => operation("taskReservationTransaction", () => transaction(() => withSessionTransaction(action))),
  };

  function stageClosureNotices(intents: readonly PendingIntent[]): ClosureNotice[] {
    const staged: ClosureNotice[] = [];
    const closures = intents.filter(intent => intent.event === 'agent.closed' && typeof intent.runId === 'string');
    if (!closures.length) return staged;
    const sessions = db.prepare("SELECT payload FROM sessions").all().map(row => JSON.parse(row.payload as string) as SessionRecord);
    const insert = db.prepare("INSERT INTO closure_notices(id, run_id, address_id, recipient, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING");
    const projectOf = (intent: PendingIntent, closed: SessionRecord): string | undefined => {
      const payload = intent.payload as { project?: unknown; activity?: { project?: unknown; session?: { activity?: { project?: unknown } } } } | null;
      const candidates = [payload?.project, payload?.activity?.project, payload?.activity?.session?.activity?.project, closed.activity?.project];
      return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    };
    for (const intent of closures) {
      const closed = sessions.find(session => session.runId === intent.runId);
      if (!closed || closed.state !== 'finished') continue;
      const project = projectOf(intent, closed);
      if (!project) continue;
      for (const recipient of sessions) {
        if (recipient.state === 'finished' || recipient.addressId === closed.addressId || recipient.activity?.project !== project) continue;
        const value: ClosureNotice = { id: `${closed.runId}:closed:${recipient.addressId}`, runId: closed.runId, address: closed.addressId, recipient: recipient.addressId,
          text: `Agent ${closed.addressId} of project ${project} is finally closed.` };
        if (Number(insert.run(value.id, value.runId, value.address, value.recipient, value.text).changes) > 0) staged.push(value);
      }
    }
    return staged;
  }

  const requireQueueSchema = () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) < 14) throw stateFailure('STATE_MIGRATION_REQUIRED', 'Launch queue events require explicit state schema migration to 14');
  };
  const eventRepository: StateStore['eventRepository'] = {
    transaction: action => operation("eventTransaction", () => transaction(() => {
      let active = true;
      const access = <R>(operation: () => R): R => {
        if (!active) throw new Error("Event transaction is closed");
        return operation();
      };
      const tx: LaunchQueueTransaction = {
        loadQueue: identity => access(() => {
          requireQueueSchema();
          const row = db.prepare('SELECT queue_id, payload FROM agent_launch_queues WHERE state_domain=? AND machine_id=?').get(identity.stateDomain, identity.machineId);
          if (!row) return undefined;
          return row.payload ? JSON.parse(row.payload as string) as LaunchQueueState : { queueId: row.queue_id as string, generation: 0, entries: [], hadFailure: false };
        }),
        saveQueue: (identity, state) => access(() => {
          requireQueueSchema();
          const result = db.prepare(`INSERT INTO agent_launch_queues(state_domain, machine_id, queue_id, payload) VALUES (?, ?, ?, ?)
            ON CONFLICT(state_domain, machine_id) DO UPDATE SET payload=excluded.payload WHERE queue_id=excluded.queue_id`)
            .run(identity.stateDomain, identity.machineId, state.queueId, JSON.stringify(state));
          if (Number(result.changes) !== 1) throw new Error('Launch queue identity changed');
        }),
        listPending: () => access(() => db.prepare("SELECT payload FROM pending_intents").all().flatMap(row => {
          const intent = JSON.parse(row.payload as string) as PendingIntent;
          if (intent.event === 'context-review.due' && !(intent.payload as { mainDelivered?: boolean })?.mainDelivered) return [];
          const event = intent.payload as { kind?: unknown; id?: unknown } | null;
          if (!event || typeof event.kind !== 'string' || typeof event.id !== 'string' || intent.event !== event.kind) return [];
          return [{ key: intent.id, event: { kind: event.kind, id: event.id }, ...('data' in event ? { data: event.data } : {}) }];
        })),
        savePending: fact => access(() => {
          if (!fact || typeof fact.key !== 'string' || !fact.key.trim() ||
              typeof fact.event?.kind !== 'string' || !fact.event.kind.trim() || typeof fact.event.id !== 'string' || !fact.event.id.trim()) throw new Error("Invalid pending event");
          const existing = db.prepare("SELECT payload FROM pending_intents WHERE id = ?").get(fact.key);
          if (existing) {
            const intent = JSON.parse(existing.payload as string) as PendingIntent;
            const event = intent.payload as PendingEvent['event'] | null;
            if (intent.event !== fact.event.kind || event?.kind !== fact.event.kind || event?.id !== fact.event.id) throw new Error("Conflicting pending event key");
            return;
          }
          const intent: PendingIntent = { id: fact.key, runId: null, event: fact.event.kind, payload: { ...fact.event, ...(fact.data !== undefined ? { data: fact.data } : {}) } };
          db.prepare("INSERT INTO pending_intents(id, run_id, payload) VALUES (?, ?, ?)").run(intent.id, null, JSON.stringify(intent));
        }),
        deletePending: key => access(() => {
          const row = db.prepare("SELECT payload FROM pending_intents WHERE id = ?").get(key);
          if (row) stageClosureNotices([JSON.parse(row.payload as string) as PendingIntent]);
          db.prepare("DELETE FROM pending_intents WHERE id = ?").run(key);
        }),
        applyReminderEvent: (event, at) => access(() => {
          const service = new ReminderService({ repository: { transaction: withReminderTransaction },
            now: () => at ?? new Date().toISOString(), nextId: () => { throw new Error("Event dispatch cannot create reminders"); },
            approvedEventKinds: [event.kind, 'reminder.activated', 'reminder.closed'] });
          service.applyEvent(event);
          return 'delivered' as const;
        }),
      };
      try { return action(tx); } finally { active = false; }
    })),
  };

  const notice = (row: Record<string, unknown>): ClosureNotice => ({ id: row.id as string, runId: row.run_id as string,
    address: row.address_id as string, recipient: row.recipient as string, text: row.text as string });
  const claimOwner = (row: Record<string, unknown>): DeliveryClaimOwner => ({ token: row.token as string, pid: row.pid as number, processStart: row.process_start as string | null });
  const takeClaim = (target: string, key: string, owner: DeliveryClaimOwner, claimedAt: string, isOwnerAlive: DeliveryOwnerProbe): boolean => {
    const held = db.prepare("SELECT delivery_key, token, pid, process_start FROM delivery_claims WHERE target = ?").get(target);
    if (held && (held.token === owner.token || (held.delivery_key === key && isOwnerAlive(claimOwner(held))))) return false;
    db.prepare(`INSERT INTO delivery_claims(target, delivery_key, token, pid, process_start, claimed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(target) DO UPDATE SET delivery_key = excluded.delivery_key, token = excluded.token, pid = excluded.pid,
      process_start = excluded.process_start, claimed_at = excluded.claimed_at`).run(target, key, owner.token, owner.pid, owner.processStart, claimedAt);
    return true;
  };
  const holds = (target: string, token: string, key?: string): boolean => {
    const held = db.prepare("SELECT delivery_key, token FROM delivery_claims WHERE target = ?").get(target);
    return !!held && held.token === token && (key === undefined || held.delivery_key === key);
  };
  const reminderDeliveries: StateStore['reminderDeliveries'] = {
    get: reminderId => operation("getReminderDelivery", () => {
      const row = db.prepare("SELECT delivery_key, receipt_id, delivered_at FROM reminder_deliveries WHERE reminder_id = ?").get(reminderId);
      return row ? { reminderId, key: row.delivery_key as string, receiptId: row.receipt_id as string, deliveredAt: row.delivered_at as string } : undefined;
    }),
    mark: value => operation("markReminderDelivery", () => transaction(() => {
      if (!db.prepare("SELECT 1 FROM reminders WHERE id = ?").get(value.reminderId)) return false;
      db.prepare(`INSERT INTO reminder_deliveries(reminder_id, delivery_key, receipt_id, delivered_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(reminder_id) DO UPDATE SET delivery_key = excluded.delivery_key, receipt_id = excluded.receipt_id, delivered_at = excluded.delivered_at`).run(
          value.reminderId, value.key, value.receiptId, value.deliveredAt);
      return true;
    })),
    claim: (reminderId, owner, claimedAt, isOwnerAlive) => operation("claimReminderDelivery", () => transaction(() => {
      const row = db.prepare("SELECT payload FROM reminders WHERE id = ?").get(reminderId);
      if (!row) return undefined;
      const reminder = JSON.parse(row.payload as string) as Reminder;
      if (reminder.state !== 'active') return undefined;
      const key = reminderDeliveryKey(reminder);
      const mark = db.prepare("SELECT delivery_key FROM reminder_deliveries WHERE reminder_id = ?").get(reminderId);
      if (mark?.delivery_key === key) return undefined;
      return takeClaim(`reminder:${reminderId}`, key, owner, claimedAt, isOwnerAlive) ? { reminder, key } : undefined;
    })),
    confirm: (value, token) => operation("confirmReminderDelivery", () => transaction(() => {
      const target = `reminder:${value.reminderId}`;
      if (!holds(target, token, value.key)) return false;
      db.prepare("DELETE FROM delivery_claims WHERE target = ?").run(target);
      if (!db.prepare("SELECT 1 FROM reminders WHERE id = ?").get(value.reminderId)) return false;
      db.prepare(`INSERT INTO reminder_deliveries(reminder_id, delivery_key, receipt_id, delivered_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(reminder_id) DO UPDATE SET delivery_key = excluded.delivery_key, receipt_id = excluded.receipt_id, delivered_at = excluded.delivered_at`).run(
          value.reminderId, value.key, value.receiptId, value.deliveredAt);
      return true;
    })),
    release: (reminderId, token) => operation("releaseReminderDelivery", () => {
      db.prepare("DELETE FROM delivery_claims WHERE target = ? AND token = ?").run(`reminder:${reminderId}`, token);
    }),
  };
  const closureNotices: StateStore['closureNotices'] = {
    stage: () => operation("stageClosureNotices", () => transaction(() => {
      db.prepare("DELETE FROM closure_notices WHERE delivered_at IS NOT NULL AND run_id NOT IN (SELECT run_id FROM sessions)").run();
      return stageClosureNotices(db.prepare("SELECT payload FROM pending_intents").all().map(row => JSON.parse(row.payload as string) as PendingIntent));
    })),
    listUndelivered: () => operation("listClosureNotices", () => db.prepare("SELECT * FROM closure_notices WHERE delivered_at IS NULL ORDER BY rowid").all().map(notice)),
    claim: (id, owner, claimedAt, isOwnerAlive) => operation("claimClosureNotice", () => transaction(() => {
      const row = db.prepare("SELECT * FROM closure_notices WHERE id = ? AND delivered_at IS NULL").get(id);
      if (!row) return undefined;
      return takeClaim(`notice:${id}`, id, owner, claimedAt, isOwnerAlive) ? notice(row) : undefined;
    })),
    markDelivered: (id, receiptId, deliveredAt, token) => operation("markClosureNotice", () => transaction(() => {
      const target = `notice:${id}`;
      if (token !== undefined && !holds(target, token)) return false;
      if (token !== undefined) db.prepare("DELETE FROM delivery_claims WHERE target = ?").run(target);
      return Number(db.prepare("UPDATE closure_notices SET receipt_id = ?, delivered_at = ? WHERE id = ? AND delivered_at IS NULL").run(receiptId, deliveredAt, id).changes) > 0;
    })),
    release: (id, token) => operation("releaseClosureNotice", () => {
      db.prepare("DELETE FROM delivery_claims WHERE target = ? AND token = ?").run(`notice:${id}`, token);
    }),
    discard: id => operation("discardClosureNotice", () => transaction(() => {
      db.prepare("DELETE FROM closure_notices WHERE id = ? AND delivered_at IS NULL").run(id);
      db.prepare("DELETE FROM delivery_claims WHERE target = ?").run(`notice:${id}`);
    })),
  };

  const readResultNotice = (id: string): ResultNotice | undefined => {
    const row = db.prepare("SELECT payload FROM result_notices WHERE id = ?").get(id);
    return row ? JSON.parse(row.payload as string) as ResultNotice : undefined;
  };
  const resultNotices: StateStore['resultNotices'] = {
    stageReportRejection: (runId, snapshot) => operation("stageReportRejection", () => transaction(() => {
      const row = db.prepare("SELECT payload FROM sessions WHERE run_id = ?").get(runId);
      if (!row) return;
      const session = JSON.parse(row.payload as string) as SessionRecord;
      if (session.result || session.reportAcceptance || !['running', 'exited'].includes(session.state)) return;
      if (session.launchContext && session.launchContext.reportPath !== snapshot.reportPath) return;
      if (db.prepare("SELECT 1 FROM sessions WHERE address_id = ? AND run_id <> ? AND state <> 'finished'").get(session.addressId, runId)) return;
      const notice = createReportRejectionNotice(session, snapshot);
      const recipient = db.prepare("SELECT state FROM sessions WHERE run_id = ? AND address_id = ?").get(notice.recipientRunId, notice.recipient);
      if (!recipient || recipient.state !== 'running') notice.lastError = `Recipient session is not active: ${notice.recipient || 'unknown'} (${notice.recipientRunId ?? 'unresolved run'})`;
      const inserted = db.prepare("INSERT INTO result_notices(id, run_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").run(notice.id, runId, JSON.stringify(notice));
      if (!Number(inserted.changes)) return;
      const intent: PendingIntent = { id: notice.id, runId, event: 'agent.report-rejected', payload: { kind: 'agent.report-rejected', id: session.addressId } };
      db.prepare("INSERT INTO pending_intents(id, run_id, payload) VALUES (?, ?, ?)").run(intent.id, runId, JSON.stringify(intent));
    })),
    stageReportDiagnostic: (runId, reason) => {
      const session = sessionRepository.transaction(tx => tx.getSession(runId), 'read');
      if (session?.launchContext) resultNotices.stageReportRejection(runId, { reportPath: session.launchContext.reportPath, bytes: null, reason });
    },
    list: () => operation("listResultNotices", () => transaction(() => {
      db.prepare("DELETE FROM result_notices WHERE run_id NOT IN (SELECT run_id FROM sessions) AND json_extract(payload, '$.state') = 'delivered'").run();
      return db.prepare("SELECT payload FROM result_notices ORDER BY rowid").all().map(row => JSON.parse(row.payload as string) as ResultNotice);
    })),
    claim: (id, owner, claimedAt, isOwnerAlive) => operation("claimResultNotice", () => transaction(() => {
      const notice = readResultNotice(id);
      if (!notice || notice.state !== 'pending' || !takeClaim(`result:${id}`, id, owner, claimedAt, isOwnerAlive)) return undefined;
      notice.attempts++;
      if (notice.recipientRunId === null && !notice.id.startsWith(`${notice.runId}:report-rejected:`)) {
        const row = db.prepare("SELECT run_id FROM sessions WHERE address_id = ? AND state = 'running'").get(notice.recipient);
        notice.recipientRunId = row?.run_id as string ?? null;
      }
      db.prepare("UPDATE result_notices SET payload = ? WHERE id = ?").run(JSON.stringify(notice), id);
      return notice;
    })),
    complete: (id, token, error) => operation("completeResultNotice", () => transaction(() => {
      if (!holds(`result:${id}`, token)) return;
      const notice = readResultNotice(id);
      if (notice) {
        notice.state = error === null ? 'delivered' : 'pending';
        notice.lastError = error;
        db.prepare("UPDATE result_notices SET payload = ? WHERE id = ?").run(JSON.stringify(notice), id);
      }
      db.prepare("DELETE FROM delivery_claims WHERE target = ? AND token = ?").run(`result:${id}`, token);
    })),
  };

  return {
    startupContextDatabase: db,
    resultNotices,
    reminderDeliveries,
    closureNotices,
    eventRepository,
    claimResourceWaitEpoch(epoch) {
      if (!epoch) throw new Error('Missing service epoch');
      operation('claimResourceWaitEpoch', () => db.prepare('INSERT INTO resource_wait_protocol_state(singleton, epoch) VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch').run(epoch));
    },
    readResourceWaitGrant() {
      return operation('readResourceWaitGrant', () => {
        const row = db.prepare('SELECT grant_json FROM resource_wait_protocol_state WHERE singleton=1').get();
        if (row?.grant_json == null) return null;
        const grant = JSON.parse(String(row.grant_json));
        if (!grant || typeof grant !== 'object' || Array.isArray(grant) ||
            !['requestId', 'serviceEpoch', 'bootIdentity'].every(key => typeof grant[key] === 'string' && grant[key].trim()) ||
            !Number.isFinite(grant.grantedAt) || !Number.isFinite(grant.monotonicAt)) throw new Error('Invalid persisted resource wait lastGrant');
        return grant;
      });
    },
    commitResourceWaitGrant(change) {
      return operation('commitResourceWaitGrant', () => transaction(() => {
        const row = db.prepare('SELECT epoch, grant_json FROM resource_wait_protocol_state WHERE singleton=1').get();
        if (row?.epoch !== change.expectedEpoch || JSON.stringify(row.grant_json == null ? null : JSON.parse(String(row.grant_json))) !== JSON.stringify(change.previous) || change.next.serviceEpoch !== change.expectedEpoch) return 'not-committed';
        db.prepare('UPDATE resource_wait_protocol_state SET grant_json=? WHERE singleton=1 AND epoch=?').run(JSON.stringify(change.next), change.expectedEpoch);
        return 'committed';
      }));
    },
    getResourceWaitLastGrant() {
      return operation("getResourceWaitLastGrant", () => {
        const row = db.prepare("SELECT last_grant FROM resource_wait_state WHERE singleton = 1").get();
        if (!row) return null;
        if (typeof row.last_grant !== 'number' || !Number.isFinite(row.last_grant)) throw new Error("Invalid persisted resource grant time");
        return row.last_grant;
      });
    },
    saveResourceWaitLastGrant(at) {
      if (!Number.isFinite(at)) throw new Error("Resource grant time must be finite");
      operation("saveResourceWaitLastGrant", () => {
        db.prepare("INSERT INTO resource_wait_state(singleton, last_grant) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET last_grant = excluded.last_grant").run(at);
      });
    },
    taskReservationRepository,
    sessionRepository,
    reminderRepository,
    close() {
      operation("close", () => db.close());
    },
    getRunnerEnabled(id) {
      return operation("getRunnerEnabled", () => {
        const row = db.prepare("SELECT enabled FROM runners WHERE id = ?").get(id);
        return row ? row.enabled === 1 : undefined;
      });
    },
    initializeRunners(entries) {
      operation("initializeRunners", () => transaction(() => {
        const insert = db.prepare("INSERT INTO runners (id, enabled) VALUES (?, ?) ON CONFLICT(id) DO NOTHING");
        for (const entry of entries) insert.run(entry.id, entry.initialEnabled ? 1 : 0);
      }));
    },
    setRunnerEnabled(id, enabled) {
      operation("setRunnerEnabled", () => {
        const result = db.prepare("UPDATE runners SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
        if (result.changes === 0) throw new Error("Unknown runner ID");
      });
    },
    setQuotaSnapshot(runner, value, observedAt) {
      let snapshot: string | undefined;
      try { snapshot = JSON.stringify(value); } catch { throw new Error("Quota snapshot must be JSON serializable"); }
      if (snapshot === undefined) throw new Error("Quota snapshot must be JSON serializable");
      operation("setQuotaSnapshot", () => db.prepare(`
        INSERT INTO quotas (runner, snapshot, observed_at, last_attempt_at, error) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(runner) DO UPDATE SET snapshot = excluded.snapshot,
          observed_at = excluded.observed_at, last_attempt_at = excluded.last_attempt_at, error = NULL
      `).run(runner, snapshot, observedAt, observedAt));
    },
    recordQuotaError(runner, message, attemptedAt) {
      operation("recordQuotaError", () => db.prepare(`
        INSERT INTO quotas (runner, snapshot, observed_at, last_attempt_at, error) VALUES (?, NULL, NULL, ?, ?)
        ON CONFLICT(runner) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, error = excluded.error
      `).run(runner, attemptedAt, message));
    },
    acquireQuotaLease(key, token, pid, expiresAt, isStale) {
      return operation("acquireQuotaLease", () => transaction(() => {
        const row = db.prepare("SELECT pid, expires_at FROM quota_leases WHERE key = ?").get(key);
        if (row && !isStale({ pid: row.pid as number, expiresAt: row.expires_at as string })) return false;
        db.prepare("INSERT INTO quota_leases (key, token, pid, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET token = excluded.token, pid = excluded.pid, expires_at = excluded.expires_at").run(key, token, pid, expiresAt);
        return true;
      }));
    },
    releaseQuotaLease(key, token) {
      operation("releaseQuotaLease", () => db.prepare("DELETE FROM quota_leases WHERE key = ? AND token = ?").run(key, token));
    },
    getQuota(runner) {
      return operation("getQuota", () => {
        const row = db.prepare("SELECT snapshot, observed_at, last_attempt_at, error FROM quotas WHERE runner = ?").get(runner);
        if (!row) return undefined;
        return {
          snapshot: row.snapshot === null ? null : JSON.parse(row.snapshot as string),
          observedAt: row.observed_at as string | null,
          lastAttemptAt: row.last_attempt_at as string,
          error: row.error as string | null,
        };
      });
    },
    recordCommandDuration(command, durationMs, alpha) {
      if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("Duration must be finite and nonnegative");
      if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new Error("Alpha must be in (0, 1]");
      operation("recordCommandDuration", () => db.prepare(`
        INSERT INTO command_timings (command, average_ms, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(command) DO UPDATE SET average_ms = ? * excluded.average_ms + (1 - ?) * command_timings.average_ms,
          updated_at = excluded.updated_at
      `).run(command, durationMs, new Date().toISOString(), alpha, alpha));
    },
    getCommandTiming(command) {
      return operation("getCommandTiming", () => {
        const row = db.prepare("SELECT average_ms, updated_at FROM command_timings WHERE command = ?").get(command);
        return row ? { averageMs: row.average_ms as number, updatedAt: row.updated_at as string } : undefined;
      });
    },
  };
}
