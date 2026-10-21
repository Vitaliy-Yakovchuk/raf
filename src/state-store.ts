import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRepository, SessionTransaction, SessionRecord, PendingIntent } from "./session-state.ts";

export type RunnerInitialState = { id: string; initialEnabled: boolean };

export type QuotaState = {
  snapshot: unknown;
  observedAt: string | null;
  lastAttemptAt: string;
  error: string | null;
};

export type CommandTiming = { averageMs: number; updatedAt: string };

export interface StateStore {
  sessionRepository: SessionRepository;
  close(): void;
  getRunnerEnabled(id: string): boolean | undefined;
  initializeRunners(entries: RunnerInitialState[]): void;
  setRunnerEnabled(id: string, enabled: boolean): void;
  setQuotaSnapshot(runner: string, value: unknown, observedAt: string): void;
  recordQuotaError(runner: string, message: string, attemptedAt: string): void;
  getQuota(runner: string): QuotaState | undefined;
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
      db.exec("PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000; PRAGMA journal_size_limit = 4194304");
      const version = () => Number(db.prepare("PRAGMA user_version").get()?.user_version);
      if (version() > 2) throw new Error("Unsupported state store schema version");
      if (version() < 2) {
        transaction(() => {

          const current = version();
          if (current > 2) throw new Error("Unsupported state store schema version");
          if (current === 2) return;
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
          db.exec(`
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
        });
      }
    });
  } catch (error) {
    try { db.close(); } catch {                                        }
    throw error;
  }

  const sessionRepository: SessionRepository = {
    transaction<T>(action: (tx: SessionTransaction) => T): T {
      return operation("sessionTransaction", () => transaction(() => {
        let active = true;
        const access = <R>(operation: () => R): R => {
          if (!active) throw new Error("Session transaction is closed");
          return operation();
        };
        const tx: SessionTransaction = {
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
          putReservation: reservation => access(() => {
            db.prepare(`INSERT INTO admission_reservations(run_id, payload) VALUES (?, ?)
              ON CONFLICT(run_id) DO UPDATE SET payload = excluded.payload`).run(reservation.runId, JSON.stringify(reservation));
          }),
          deleteReservation: runId => access(() => { db.prepare("DELETE FROM admission_reservations WHERE run_id = ?").run(runId); }),
          putPending: intent => access(() => {
            db.prepare(`INSERT INTO pending_intents(id, payload) VALUES (?, ?)
              ON CONFLICT(id) DO NOTHING`).run(intent.id, JSON.stringify(intent));
          }),
          deletePending: id => access(() => { db.prepare("DELETE FROM pending_intents WHERE id = ?").run(id); }),
          listPending: () => access(() => db.prepare("SELECT payload FROM pending_intents").all().map(row => JSON.parse(row.payload as string) as PendingIntent)),
          applyEffects: effects => access(() => {
            if (effects.length) throw new Error("Unknown domain effect");
          }),
        };
        try { return action(tx); } finally { active = false; }
      }, false));
    },
  };

  return {
    sessionRepository,
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
