import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { openStateStore, type StateStore } from "../src/state-store.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "raf-state-store-"));
  const path = join(directory, "state.sqlite");
  const opened = new Set<StateStore>();
  t.after(() => {
    try {
      for (const store of opened) store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    path,
    open(databasePath = path) {
      const store = openStateStore(databasePath);
      opened.add(store);
      return store;
    },
    close(store: StateStore) {
      store.close();
      opened.delete(store);
    },
  };
}

test("a new explicit SQLite database has no invented runner, quota, or timing values", (t) => {
  const db = fixture(t);
  const store = db.open();
  assert.equal(store.getRunnerEnabled("codex"), undefined);
  assert.equal(store.getQuota("codex"), undefined);
  assert.equal(store.getCommandTiming("runner list"), undefined);
  db.close(store);
  assert.equal(readFileSync(db.path).subarray(0, 16).toString(), "SQLite format 3\0");
  const database = new DatabaseSync(db.path, { readOnly: true });
  try {
    assert.equal(Number(database.prepare("PRAGMA user_version").get()!.user_version), 12);
    assert.equal(database.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally {
    database.close();
  }
});

test("creates missing parent directories for the explicitly supplied database", (t) => {
  const db = fixture(t);
  const nested = join(db.path + "-parent", "nested", "state.sqlite");

  const store = db.open(nested);
  store.initializeRunners([{ id: "codex", initialEnabled: true }]);
  db.close(store);
  const reopened = db.open(nested);
  assert.equal(reopened.getRunnerEnabled("codex"), true);
});

test("initial runner defaults seed new IDs without overwriting saved switches", (t) => {
  const db = fixture(t);
  const first = db.open();
  first.initializeRunners([
    { id: "codex", initialEnabled: true },
    { id: "claude", initialEnabled: false },
  ]);
  assert.equal(first.getRunnerEnabled("codex"), true);
  assert.equal(first.getRunnerEnabled("claude"), false);
  first.setRunnerEnabled("codex", false);
  first.setRunnerEnabled("claude", true);
  db.close(first);
  const second = db.open();
  second.initializeRunners([
    { id: "codex", initialEnabled: true },
    { id: "claude", initialEnabled: false },
    { id: "grok", initialEnabled: false },
  ]);
  second.initializeRunners([]);
  assert.equal(second.getRunnerEnabled("codex"), false);
  assert.equal(second.getRunnerEnabled("claude"), true);
  assert.equal(second.getRunnerEnabled("grok"), false);
});

test("switching an unknown runner rejects without creating it or changing other runners", (t) => {
  const db = fixture(t);
  const store = db.open();
  store.initializeRunners([{ id: "codex", initialEnabled: true }]);
  assert.throws(() => store.setRunnerEnabled("unknown", true));
  assert.equal(store.getRunnerEnabled("unknown"), undefined);
  assert.equal(store.getRunnerEnabled("codex"), true);
  db.close(store);
  assert.equal(db.open().getRunnerEnabled("unknown"), undefined);
});

test("SQL-looking identifiers are literal keys for all state domains", (t) => {
  const db = fixture(t);
  const store = db.open();
  const hostile = "x'); DROP TABLE runners; --";
  store.initializeRunners([
    { id: hostile, initialEnabled: false },
    { id: "codex", initialEnabled: true },
  ]);
  store.setRunnerEnabled(hostile, true);
  store.setQuotaSnapshot(hostile, { text: "' OR 1=1 --" }, "2026-10-21T10:00:00.000Z");
  store.recordCommandDuration(hostile, 123, 0.5);
  db.close(store);
  const reopened = db.open();
  assert.equal(reopened.getRunnerEnabled(hostile), true);
  assert.equal(reopened.getRunnerEnabled("codex"), true);
  assert.deepEqual(reopened.getQuota(hostile)?.snapshot, { text: "' OR 1=1 --" });
  assert.equal(reopened.getCommandTiming(hostile)?.averageMs, 123);
});

test("quota reads return the latest persisted snapshot and observation time", (t) => {
  const db = fixture(t);
  const store = db.open();
  store.setQuotaSnapshot("codex", { remaining: 90 }, "2026-10-21T10:00:00.000Z");
  const latest = { pools: [{ name: "shared", remaining: 35 }], resetAt: null };
  const observedAt = "2026-10-21T11:00:00.000Z";
  store.setQuotaSnapshot("codex", latest, observedAt);
  store.setQuotaSnapshot("claude", { remaining: 12 }, observedAt);
  db.close(store);
  const reopened = db.open();
  assert.deepEqual(reopened.getQuota("codex"), {
    snapshot: latest, observedAt, lastAttemptAt: observedAt, error: null,
  });
  assert.deepEqual(reopened.getQuota("claude")?.snapshot, { remaining: 12 });
});

test("quota failures preserve the valid snapshot and success clears the current error", (t) => {
  const db = fixture(t);
  const store = db.open();
  const observedAt = "2026-10-21T10:00:00.000Z";
  const attemptedAt = "2026-10-21T11:00:00.000Z";
  store.setQuotaSnapshot("codex", { remaining: 45 }, observedAt);
  store.recordQuotaError("codex", "timeout", "2026-10-21T10:30:00.000Z");
  store.recordQuotaError("codex", "unrecognized screen", attemptedAt);
  db.close(store);
  const reopened = db.open();
  assert.deepEqual(reopened.getQuota("codex"), {
    snapshot: { remaining: 45 }, observedAt, lastAttemptAt: attemptedAt,
    error: "unrecognized screen",
  });
  const recoveredAt = "2026-10-21T12:00:00.000Z";
  reopened.setQuotaSnapshot("codex", { remaining: 30 }, recoveredAt);
  db.close(reopened);
  assert.deepEqual(db.open().getQuota("codex"), {
    snapshot: { remaining: 30 }, observedAt: recoveredAt,
    lastAttemptAt: recoveredAt, error: null,
  });
});

test("an initial quota failure records unknown observation instead of fabricated capacity", (t) => {
  const db = fixture(t);
  const store = db.open();
  const attemptedAt = "2026-10-21T11:00:00.000Z";
  store.recordQuotaError("codex", "CLI unavailable", attemptedAt);
  db.close(store);
  assert.deepEqual(db.open().getQuota("codex"), {
    snapshot: null, observedAt: null, lastAttemptAt: attemptedAt, error: "CLI unavailable",
  });
});

test("command timing starts with the first duration then persists the EMA", (t) => {
  const db = fixture(t);
  const store = db.open();
  const before = Date.now();
  store.recordCommandDuration("runner list", 100, 0.25);
  const first = store.getCommandTiming("runner list");
  assert.equal(first?.averageMs, 100);
  assert.ok(first && Number.isFinite(Date.parse(first.updatedAt)));
  assert.ok(Date.parse(first.updatedAt) >= before && Date.parse(first.updatedAt) <= Date.now());
  db.close(store);
  const reopened = db.open();
  reopened.recordCommandDuration("runner list", 300, 0.25);
  assert.equal(reopened.getCommandTiming("runner list")?.averageMs, 150);
  reopened.recordCommandDuration("runner list", 50, 0.25);
  reopened.recordCommandDuration("runner status", 0, 1);
  db.close(reopened);
  const final = db.open();
  assert.equal(final.getCommandTiming("runner list")?.averageMs, 125);
  assert.equal(final.getCommandTiming("runner status")?.averageMs, 0);
});

test("invalid durations and coefficients reject without modifying an existing aggregate", (t) => {
  const db = fixture(t);
  const store = db.open();
  store.recordCommandDuration("runner list", 100, 0.5);
  const saved = store.getCommandTiming("runner list");
  for (const duration of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => store.recordCommandDuration("runner list", duration, 0.5));
    assert.deepEqual(store.getCommandTiming("runner list"), saved);
    assert.throws(() => store.recordCommandDuration("new command", duration, 0.5));
    assert.equal(store.getCommandTiming("new command"), undefined);
  }
  for (const alpha of [0, -0.1, 1.1, NaN, Infinity, -Infinity]) {
    assert.throws(() => store.recordCommandDuration("runner list", 200, alpha));
    assert.deepEqual(store.getCommandTiming("runner list"), saved);
  }
});

test("separate open connections observe committed changes without stale defaults", (t) => {
  const db = fixture(t);
  const first = db.open();
  const second = db.open();
  first.initializeRunners([{ id: "codex", initialEnabled: true }]);
  assert.equal(second.getRunnerEnabled("codex"), true);
  second.setRunnerEnabled("codex", false);
  first.initializeRunners([{ id: "codex", initialEnabled: true }]);
  assert.equal(first.getRunnerEnabled("codex"), false);
  first.recordCommandDuration("runner list", 100, 0.5);
  second.recordCommandDuration("runner list", 300, 0.5);
  assert.equal(first.getCommandTiming("runner list")?.averageMs, 200);
});

test("concurrent processes can initialize the same new schema and retain each writer's state", async (t) => {
  const db = fixture(t);
  const moduleUrl = new URL("../src/state-store.ts", import.meta.url).href;
  const children = Array.from({ length: 3 }, (_, index) => {
    const source = `
      import { openStateStore } from ${JSON.stringify(moduleUrl)};
      process.stdin.once('data', () => {
        const store = openStateStore(process.env.RAF_TEST_STATE_PATH);
        try {
          store.initializeRunners([{ id: 'runner-${index}', initialEnabled: true }]);
        } finally { store.close(); }
      });
      process.stdout.write('ready');
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, RAF_TEST_STATE_PATH: db.path },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Child exited before ready: ${stderr}`)));
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`SQLite child failed (${code ?? signal}): ${stderr}`));
      });
    });

    void closed.catch(() => {});
    return { child, ready, closed };
  });
  try {
    await Promise.all(children.map(({ ready }) => ready));
    for (const { child } of children) child.stdin.end("open");
    await Promise.all(children.map(({ closed }) => closed));
    const store = db.open();
    for (let index = 0; index < children.length; index++) {
      assert.equal(store.getRunnerEnabled(`runner-${index}`), true);
    }
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(children.map(({ closed }) => closed));
  }
});
