import type { TaskReservationSet } from "./task-reservations.ts";
import type { EventRegistryPorts, EventTransaction, PendingEvent } from "./event-registry.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ReminderService, type Reminder, type ReminderRepository, type ReminderTransaction } from "./reminders.ts";
import type { ReminderSessionEffect } from "./reminder-repository.ts";
import type { SessionRepository, SessionTransaction, SessionRecord, PendingIntent, AdmissionReservation } from "./session-state.ts";

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

export interface StateStore {
  eventRepository: Pick<EventRegistryPorts, 'transaction'>;
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

export function openStateStore(path: string): StateStore {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("An explicit database path is required");
  }


  function operation<T>(name: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      const source = error as { code?: string; errcode?: number };
      if (source?.code?.startsWith("ERR_SQLITE")) {
        throw Object.assign(new Error(`State store ${name} failed (SQLite ${source.errcode ?? source.code})`), {
          code: source.code,
          errcode: source.errcode,
          operation: name,
        });
      }
      throw error;
    }
  }

  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = operation("open", () => new DatabaseSync(path, { timeout: 250 }));
  function transaction<T>(action: () => T, immediate = true): T {
    db.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("State transactions must be synchronous");
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {                                      }
      throw error;
    }
  }

  try {
    operation("initialize", () => {


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
      const version = () => Number(db.prepare("PRAGMA user_version").get()?.user_version);
      if (version() > 7) throw new Error("Unsupported state store schema version");
      if (version() < 7) {
        transaction(() => {

          const current = version();
          if (current > 7) throw new Error("Unsupported state store schema version");
          if (current === 7) return;
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
          }
          if (current < 2) db.exec(`
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
          `);
          if (current < 3) db.exec(`
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
          `);
          if (current < 4) db.exec(`
            ALTER TABLE pending_intents ADD COLUMN run_id TEXT;
            UPDATE pending_intents SET run_id = json_extract(payload, '$.runId');
            PRAGMA user_version = 4;
          `);
          if (current < 5) db.exec(`
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
          `);
          if (current < 6) db.exec(`
            CREATE TABLE resource_wait_state (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
              last_grant REAL NOT NULL
            ) STRICT;
            PRAGMA user_version = 6;
          `);
          db.exec(`
            CREATE TABLE quota_leases (
              key TEXT PRIMARY KEY NOT NULL,
              token TEXT NOT NULL,
              pid INTEGER NOT NULL,
              expires_at TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 7;
          `);
        });
      }
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
      remove: id => access(() => { db.prepare("DELETE FROM reminders WHERE id = ?").run(id); }),
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
        if (!reservation.tasks.length) tx.deleteTaskReservation(owner.runId);
      }),
      deleteTaskReservation: runId => access(() => { db.prepare("DELETE FROM task_reservation_runs WHERE run_id = ?").run(runId); }),
      getSession: runId => access(() => {
        const row = db.prepare("SELECT payload FROM sessions WHERE run_id = ?").get(runId);
        return row ? JSON.parse(row.payload as string) as SessionRecord : undefined;
      }),
      listSessions: () => access(() => db.prepare("SELECT payload FROM sessions").all().map(row => JSON.parse(row.payload as string) as SessionRecord)),
      putSession: session => access(() => {
        db.prepare(`INSERT INTO sessions(run_id, address_id, state, finished_at, payload) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET address_id = excluded.address_id, state = excluded.state,
          finished_at = excluded.finished_at, payload = excluded.payload`).run(
            session.runId, session.addressId, session.state, session.finishedAt ?? null, JSON.stringify(session));
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
    transaction: action => operation("sessionTransaction", () => transaction(() => withSessionTransaction(action), false)),
  };
  const taskReservationRepository: StateStore["taskReservationRepository"] = {
    transaction: action => operation("taskReservationTransaction", () => transaction(() => withSessionTransaction(action))),
  };

  const eventRepository: StateStore['eventRepository'] = {
    transaction: action => operation("eventTransaction", () => transaction(() => {
      let active = true;
      const access = <R>(operation: () => R): R => {
        if (!active) throw new Error("Event transaction is closed");
        return operation();
      };
      const tx: EventTransaction = {
        listPending: () => access(() => db.prepare("SELECT payload FROM pending_intents").all().flatMap(row => {
          const intent = JSON.parse(row.payload as string) as PendingIntent;
          const event = intent.payload as { kind?: unknown; id?: unknown } | null;
          if (!event || typeof event.kind !== 'string' || typeof event.id !== 'string' || intent.event !== event.kind) return [];
          return [{ key: intent.id, event: { kind: event.kind, id: event.id } }];
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
          const intent: PendingIntent = { id: fact.key, runId: null, event: fact.event.kind, payload: { ...fact.event } };
          db.prepare("INSERT INTO pending_intents(id, run_id, payload) VALUES (?, ?, ?)").run(intent.id, null, JSON.stringify(intent));
        }),
        deletePending: key => access(() => { db.prepare("DELETE FROM pending_intents WHERE id = ?").run(key); }),
        applyReminderEvent: event => access(() => {
          const service = new ReminderService({ repository: { transaction: withReminderTransaction },
            now: () => new Date().toISOString(), nextId: () => { throw new Error("Event dispatch cannot create reminders"); },
            approvedEventKinds: [event.kind, 'reminder.activated', 'reminder.closed'] });
          service.applyEvent(event);
          return 'delivered' as const;
        }),
      };
      try { return action(tx); } finally { active = false; }
    })),
  };

  return {
    eventRepository,
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
