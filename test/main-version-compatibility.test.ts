import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  MainVersionCompatibility,
  type CompatibilityClient,
  type CompatibilityContext,
  type ExplicitCompatibilityMigration,
} from "../src/main-version-compatibility.ts";
import { clientA, contractA, exactLegacyA, guardA, readA, writeA } from "./main-version-fixtures/client-a.ts";
import { clientB, contractB, readB, writeB } from "./main-version-fixtures/client-b.ts";

const expansion = [
  "ALTER TABLE records ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'",
  "CREATE INDEX records_priority ON records(priority, id)",
];

function fixture(t: TestContext, version = 41) {
  const root = mkdtempSync(join(tmpdir(), "raf-mainver-"));
  const home = join(root, "qa-home");
  mkdirSync(join(home, ".raf"), { recursive: true });
  const path = join(home, ".raf", "state.sqlite");
  const backupPath = join(root, "state-before-41.sqlite");
  const active = join(root, "raf-main");
  symlinkSync("slot-A", active);
  const context: CompatibilityContext = { kind: "isolated-qa", home, codeRoot: resolve(import.meta.dirname, "..") };
  const handles: DatabaseSync[] = [];
  t.after(() => {
    for (const handle of handles.reverse()) {
      try { handle.close(); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0");
  db.exec("CREATE TABLE records(id TEXT PRIMARY KEY, body TEXT NOT NULL, format_version INTEGER NOT NULL DEFAULT 1, legacy_note TEXT NOT NULL DEFAULT '')");
  db.exec("INSERT INTO records(id, body) VALUES ('old', 'before either release')");
  db.exec("PRAGMA user_version=41");
  if (version === 42 || version === 43) {
    for (const sql of expansion) db.exec(sql);
    db.exec(`PRAGMA user_version=${version}`);
  }
  if (version === 43) db.exec("ALTER TABLE records DROP COLUMN legacy_note");
  if (![41, 42, 43].includes(version)) db.exec(`PRAGMA user_version=${version}`);
  db.close();
  const track = (database: DatabaseSync): DatabaseSync => {
    handles.push(database);
    return database;
  };
  const inspect = (file = path): DatabaseSync => track(new DatabaseSync(file, { readOnly: true }));
  const gate = new MainVersionCompatibility();
  const open = (client = contractA): DatabaseSync => track(gate.openExisting({ path, context, client }));
  const migration = (overrides: Partial<ExplicitCompatibilityMigration> = {}): ExplicitCompatibilityMigration => ({
    path, context, fromVersion: 41, toVersion: 42, backupPath,
    clients: [clientA, clientB], statements: expansion, ...overrides,
  });
  return { root, home, path, active, backupPath, context, gate, track, inspect, open, migration };
}

function snapshot(database: DatabaseSync) {
  return {
    version: database.prepare("PRAGMA user_version").get()!.user_version,
    ddlRevision: database.prepare("PRAGMA schema_version").get()!.schema_version,
    ddl: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all(),
    rows: database.prepare("SELECT * FROM records ORDER BY id").all(),
  };
}

function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof Error && "code" in error && error.code === expected;
}

function counted(client: CompatibilityClient, calls: string[]): CompatibilityClient {
  return {
    contract: client.contract,
    probe(database) {
      calls.push(client.contract.id);
      client.probe(database);
    },
  };
}

for (const version of [41, 42]) {
  test(`A/B real SQL readers and writers coexist on schema ${version}`, t => {
    const f = fixture(t, version);
    const before = snapshot(f.inspect());
    const calls: string[] = [];
    const decision = f.gate.checkRelease({
      path: f.path, context: f.context, current: counted(clientA, calls), candidate: counted(clientB, calls),
    });
    assert.equal(decision.compatible, true);
    assert.equal(decision.requiresStop, false);
    assert.deepEqual(decision.reasonCodes, []);
    assert.deepEqual([...decision.checkedClients].sort(), [contractA.id, contractB.id].sort());
    assert.ok(calls.includes(contractA.id) && calls.includes(contractB.id), "gate must exercise both real clients");
    assert.deepEqual(snapshot(f.inspect()), before, "gate probes must not leak writes or DDL");
    const a = f.open(contractA);
    const b = f.open(contractB);
    assert.deepEqual(readB(b), [{ id: "old", text: "before either release", priority: "normal" }]);
    writeA(a, "a", "A payload");
    writeB(b, "b", "B payload", version === 42 ? "urgent" : "normal");
    assert.deepEqual(readA(a), [
      { id: "a", text: "A payload" }, { id: "b", text: "B payload" }, { id: "old", text: "before either release" },
    ]);
    assert.deepEqual(readB(b), [
      { id: "a", text: "A payload", priority: "normal" },
      { id: "b", text: "B payload", priority: version === 42 ? "urgent" : "normal" },
      { id: "old", text: "before either release", priority: "normal" },
    ]);
    const after = snapshot(f.inspect());
    assert.equal(after.version, version);
    assert.deepEqual(after.ddl, before.ddl);
    assert.equal(after.ddlRevision, before.ddlRevision);
    assert.equal(after.rows.find(row => row.id === "b")!.format_version, version === 42 ? 2 : 1);
    assert.equal(f.gate.checkRelease({ path: f.path, context: f.context, current: clientB, candidate: clientA }).compatible, true);
    assert.deepEqual(snapshot(f.inspect()), after, "code-only B to A rollback must preserve both writers' records");
  });

  test(`ordinary open and code rollback never change DDL on schema ${version}`, t => {
    const f = fixture(t, version);
    const before = snapshot(f.inspect());
    for (const contract of [contractA, contractB, contractA]) f.open(contract);
    assert.deepEqual(snapshot(f.inspect()), before);
    assert.equal(readlinkSync(f.active), "slot-A");
  });
}

test("B refuses new field use before expansion instead of implicitly applying DDL", t => {
  const f = fixture(t);
  const b = f.open(contractB);
  const before = snapshot(f.inspect());
  assert.throws(() => writeB(b, "early", "B", "urgent"), /Expansion required/);
  assert.deepEqual(snapshot(f.inspect()), before);
});

for (const version of [0, 40, 44, 999]) {
  test(`unknown or unsupported nonempty user_version ${version} is refused before writes`, t => {
    const f = fixture(t, version);
    const before = snapshot(f.inspect());
    assert.throws(() => guardA(f.inspect()), code("SCHEMA_UNSUPPORTED"));
    assert.throws(() => readB(f.inspect()), code("SCHEMA_UNSUPPORTED"));
    for (const client of [contractA, contractB]) {
      assert.throws(() => f.open(client), code("SCHEMA_UNSUPPORTED"));
      assert.deepEqual(snapshot(f.inspect()), before);
    }
    const decision = f.gate.checkRelease({ path: f.path, context: f.context, current: clientA, candidate: clientB });
    assert.equal(decision.compatible, false);
    assert.ok(decision.reasonCodes.includes("SCHEMA_UNSUPPORTED"));
    assert.deepEqual(snapshot(f.inspect()), before);
  });
}

test("a known version with incompatible DDL is refused directly", t => {
  const f = fixture(t, 42);
  const editor = f.track(new DatabaseSync(f.path));
  editor.exec("ALTER TABLE records RENAME COLUMN body TO incompatible_body");
  const before = snapshot(f.inspect());
  for (const contract of [contractA, contractB]) assert.throws(() => f.open(contract), code("SCHEMA_MISMATCH"));
  assert.deepEqual(snapshot(f.inspect()), before);
});

test("unsupported record format is refused even at a known user_version", t => {
  const f = fixture(t, 42);
  f.track(new DatabaseSync(f.path)).exec("INSERT INTO records(id,body,format_version) VALUES ('future','preserve me',99)");
  const before = snapshot(f.inspect());
  assert.throws(() => readA(f.inspect()), code("FORMAT_UNSUPPORTED"));
  assert.throws(() => readB(f.inspect()), code("FORMAT_UNSUPPORTED"));
  for (const contract of [contractA, contractB]) assert.throws(() => f.open(contract), code("FORMAT_UNSUPPORTED"));
  const decision = f.gate.checkRelease({ path: f.path, context: f.context, current: clientA, candidate: clientB });
  assert.equal(decision.compatible, false);
  assert.ok(decision.reasonCodes.includes("FORMAT_UNSUPPORTED"));
  assert.deepEqual(snapshot(f.inspect()), before);
});

test("exact-version A blocks expanded release and requires a compatible bridge first", t => {
  const f = fixture(t, 42);
  const before = snapshot(f.inspect());
  assert.throws(() => exactLegacyA.probe(f.inspect()), code("SCHEMA_UNSUPPORTED"));
  assert.throws(() => f.open(exactLegacyA.contract), code("SCHEMA_UNSUPPORTED"));
  const decision = f.gate.checkRelease({ path: f.path, context: f.context, current: exactLegacyA, candidate: clientB });
  assert.equal(decision.compatible, false);
  assert.equal(decision.requiresStop, true);
  assert.ok(decision.reasonCodes.includes("SCHEMA_UNSUPPORTED"));
  assert.deepEqual(snapshot(f.inspect()), before);
});

test("gate rejects a client whose real probe fails despite a compatible manifest", t => {
  const f = fixture(t, 42);
  const before = snapshot(f.inspect());
  let invoked = false;
  const brokenB: CompatibilityClient = {
    contract: { ...contractB, id: "fixture-broken-B" },
    probe(database) {
      invoked = true;
      writeB(database, "broken-probe", "must roll back");
      assert.equal(readB(database).length, 0, "synthetic incompatible client semantics");
    },
  };
  const decision = f.gate.checkRelease({ path: f.path, context: f.context, current: clientA, candidate: brokenB });
  assert.equal(invoked, true);
  assert.equal(decision.compatible, false);
  assert.ok(decision.reasonCodes.includes("CLIENT_PROBE_FAILED"));
  assert.deepEqual(snapshot(f.inspect()), before);
});

test("explicit expansion backs up the exact preimage and commits DDL/version once", t => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open(contractB);
  writeA(a, "a-before", "before migration A");
  writeB(b, "b-before", "before migration B");
  const before = snapshot(f.inspect());
  let boundary = false;
  const result = f.gate.migrateExplicitly(f.migration({ beforeCommit() {
    boundary = true;
    assert.deepEqual(snapshot(f.inspect(f.backupPath)), before, "backup must precede DDL");
    assert.deepEqual(snapshot(f.inspect()), before, "other connections must not see uncommitted schema/version");
    assert.equal(readlinkSync(f.active), "slot-A");
  } }));
  assert.equal(boundary, true);
  assert.deepEqual(result, { migrated: true, fromVersion: 41, toVersion: 42, backupPath: f.backupPath });
  assert.equal(snapshot(f.inspect()).version, 42);
  assert.ok(snapshot(f.inspect()).rows.every(row => row.priority === "normal"));
  assert.deepEqual(snapshot(f.inspect(f.backupPath)), before);
  const backupBytes = readFileSync(f.backupPath);
  const after = snapshot(f.inspect());
  const again = f.gate.migrateExplicitly(f.migration());
  assert.equal(again.migrated, false);
  assert.deepEqual(snapshot(f.inspect()), after);
  assert.deepEqual(readFileSync(f.backupPath), backupBytes, "retry must not replace pre-migration backup");
  writeA(a, "a-after", "same A connection");
  writeB(b, "b-after", "same B connection", "urgent");
  assert.equal(readA(a).length, 5);
  assert.equal(readB(b).find(row => row.id === "b-after")!.priority, "urgent");
  const reopened = snapshot(f.inspect());
  f.open();
  f.open(contractB);
  assert.deepEqual(snapshot(f.inspect()), reopened, "open must not inherit migration permission");
});

test("failure after DDL but before commit restores the source schema/data and keeps A active", t => {
  const f = fixture(t);
  writeA(f.open(), "a-before", "survive failed expansion");
  const before = snapshot(f.inspect());
  const injected = new Error("fixture failure before commit");
  assert.throws(() => f.gate.migrateExplicitly(f.migration({ beforeCommit() { throw injected; } })), error => error === injected);
  assert.deepEqual(snapshot(f.inspect()), before);
  assert.deepEqual(snapshot(f.inspect(f.backupPath)), before);
  assert.equal(readlinkSync(f.active), "slot-A");
  const reopened = f.open(contractB);
  assert.deepEqual(snapshot(reopened), before);
  assert.throws(() => writeB(reopened, "no-inherited-permission", "B", "urgent"), /Expansion required/);
  assert.deepEqual(snapshot(f.inspect()), before);
});

test("concurrent migration cannot publish a partial schema or run a second DDL transaction", t => {
  const f = fixture(t);
  const before = snapshot(f.inspect());
  let competed = false;
  const outer = f.gate.migrateExplicitly(f.migration({ beforeCommit() {
    assert.deepEqual(snapshot(f.inspect()), before);
    assert.throws(() => f.gate.migrateExplicitly(f.migration({ backupPath: join(f.root, "competitor.sqlite") })), code("MIGRATION_BUSY"));
    competed = true;
    assert.deepEqual(snapshot(f.inspect()), before);
  } }));
  assert.equal(competed, true);
  assert.equal(outer.migrated, true);
  assert.equal(snapshot(f.inspect()).version, 42);
  assert.deepEqual(snapshot(f.inspect(f.backupPath)), before);
  assert.equal(f.gate.migrateExplicitly(f.migration()).migrated, false);
});

test("concurrent A/B connections serialize writes and never lose committed records", t => {
  const f = fixture(t, 42);
  const a = f.open();
  const b = f.open(contractB);
  a.exec("PRAGMA busy_timeout=0");
  b.exec("PRAGMA busy_timeout=0");
  a.exec("BEGIN IMMEDIATE");
  writeA(a, "a-held", "uncommitted A");
  assert.equal(readB(b).some(row => row.id === "a-held"), false);
  assert.throws(() => writeB(b, "b-retry", "B after A", "urgent"), /locked|busy/i);
  a.exec("COMMIT");
  writeB(b, "b-retry", "B after A", "urgent");
  assert.deepEqual(readA(a).map(row => row.id), ["a-held", "b-retry", "old"]);
  assert.deepEqual(readB(b).map(row => row.id), ["a-held", "b-retry", "old"]);
});

test("explicit migration rejects stale source, downgrade, missing backup and incompatible clients", t => {
  const f = fixture(t);
  const before = snapshot(f.inspect());
  const attempts: [Partial<ExplicitCompatibilityMigration>, string][] = [
    [{ fromVersion: 40 }, "MIGRATION_VERSION_CONFLICT"],
    [{ fromVersion: 41, toVersion: 40 }, "MIGRATION_DOWNGRADE_REFUSED"],
    [{ backupPath: "" }, "MIGRATION_BACKUP_REQUIRED"],
    [{ backupPath: f.path }, "MIGRATION_BACKUP_INVALID"],
    [{ clients: [exactLegacyA, clientB] }, "MIGRATION_CLIENT_INCOMPATIBLE"],
  ];
  for (const [options, expected] of attempts) {
    assert.throws(() => f.gate.migrateExplicitly(f.migration(options)), code(expected));
    assert.deepEqual(snapshot(f.inspect()), before);
    assert.equal(readlinkSync(f.active), "slot-A");
  }
});

test("backup creation failure prevents every migration write", t => {
  const f = fixture(t);
  const before = snapshot(f.inspect());
  const occupied = join(f.root, "occupied-backup");
  mkdirSync(occupied);
  assert.throws(() => f.gate.migrateExplicitly(f.migration({ backupPath: occupied })), code("MIGRATION_BACKUP_FAILED"));
  assert.deepEqual(snapshot(f.inspect()), before);
  assert.equal(readlinkSync(f.active), "slot-A");
});

test("a database alias outside isolated QA origin is refused before open or migration", t => {
  const f = fixture(t);
  const other = join(f.root, "other-home");
  mkdirSync(join(other, ".raf"), { recursive: true });
  const alias = join(other, ".raf", "state.sqlite");
  symlinkSync(f.path, alias);
  const context: CompatibilityContext = { ...f.context, home: other };
  const before = snapshot(f.inspect());
  assert.throws(() => f.gate.openExisting({ path: alias, context, client: contractA }), code("STATE_CONTEXT_REFUSED"));
  assert.throws(() => f.gate.migrateExplicitly(f.migration({ path: alias, context })), code("STATE_CONTEXT_REFUSED"));
  assert.deepEqual(snapshot(f.inspect()), before);
});

test("B to A rollback preserves new B records and extended schema without backup restore", t => {
  const f = fixture(t);
  f.gate.migrateExplicitly(f.migration());
  const backupBytes = readFileSync(f.backupPath);
  writeB(f.open(contractB), "b-after-backup", "retain B data", "urgent");
  const before = snapshot(f.inspect());
  const decision = f.gate.checkRelease({ path: f.path, context: f.context, current: clientB, candidate: clientA });
  assert.equal(decision.compatible, true);
  const a = f.open();
  assert.ok(readA(a).some(row => row.id === "b-after-backup" && row.text === "retain B data"));
  assert.deepEqual(snapshot(f.inspect()), before);
  writeA(a, "a-after-rollback", "retain A data too");
  assert.equal(readB(f.open(contractB)).find(row => row.id === "b-after-backup")!.priority, "urgent");
  assert.ok(readB(f.open(contractB)).some(row => row.id === "a-after-rollback"));
  assert.equal(snapshot(f.inspect()).version, 42);
  assert.deepEqual(readFileSync(f.backupPath), backupBytes);
});

const clientC: CompatibilityClient = {
  contract: { ...contractB, id: "fixture-C-contracted", schemaVersions: [42, 43] },
  probe(database) {
    const old = readB(database);
    writeB(database, "gate-c", "C without legacy note", "urgent");
    assert.equal(readB(database).length, old.length + 1);
  },
};

for (const nextRelease of [false, true]) {
  test(`contract is deferred while A remains alive, nextRelease=${nextRelease}`, t => {
    const f = fixture(t, 42);
    const before = snapshot(f.inspect());
    const decision = f.gate.checkContract({
      path: f.path, context: f.context, current: clientB, candidate: clientC,
      retiringClient: contractA, liveClientIds: [contractA.id], removedColumns: ["legacy_note"], nextRelease,
    });
    assert.equal(decision.compatible, false);
    assert.ok(decision.reasonCodes.includes("CONTRACT_READERS_ACTIVE"));
    assert.deepEqual(snapshot(f.inspect()), before);
  });
}

test("contract cannot ship in the expansion release even after A exits", t => {
  const f = fixture(t, 42);
  const before = snapshot(f.inspect());
  const decision = f.gate.checkContract({
    path: f.path, context: f.context, current: clientB, candidate: clientC,
    retiringClient: contractA, liveClientIds: [], removedColumns: ["legacy_note"], nextRelease: false,
  });
  assert.equal(decision.compatible, false);
  assert.ok(decision.reasonCodes.includes("CONTRACT_TOO_EARLY"));
  assert.deepEqual(snapshot(f.inspect()), before);
});

test("a later contracted fixture proves B/C compatibility and C to B rollback after A exits", t => {
  const f = fixture(t, 43);
  const before = snapshot(f.inspect());
  const calls: string[] = [];
  const decision = f.gate.checkContract({
    path: f.path, context: f.context, current: counted(clientB, calls), candidate: counted(clientC, calls),
    retiringClient: contractA, liveClientIds: [], removedColumns: ["legacy_note"], nextRelease: true,
  });
  assert.equal(decision.compatible, true);
  assert.ok(calls.includes(contractB.id) && calls.includes(clientC.contract.id));
  assert.deepEqual(snapshot(f.inspect()), before);
  const b = f.open(contractB);
  assert.throws(() => readA(b), code("SCHEMA_UNSUPPORTED"));
  writeB(b, "c-new", "new C-era record", "urgent");
  const rollback = f.gate.checkRelease({ path: f.path, context: f.context, current: clientC, candidate: clientB });
  assert.equal(rollback.compatible, true);
  assert.deepEqual(readB(f.open(contractB)).find(row => row.id === "c-new"), {
    id: "c-new", text: "new C-era record", priority: "urgent",
  });
  assert.equal(snapshot(f.inspect()).version, 43);
});

test("A exit alone cannot authorize contract while a neighboring client still needs the old column", t => {
  const f = fixture(t, 43);
  const before = snapshot(f.inspect());
  const dependentC: CompatibilityClient = {
    contract: { ...clientC.contract, id: "fixture-C-still-dependent", requiredColumns: [...contractB.requiredColumns, "legacy_note"] },
    probe(database) { database.prepare("SELECT legacy_note FROM records").all(); },
  };
  const decision = f.gate.checkContract({
    path: f.path, context: f.context, current: clientB, candidate: dependentC,
    retiringClient: contractA, liveClientIds: [], removedColumns: ["legacy_note"], nextRelease: true,
  });
  assert.equal(decision.compatible, false);
  assert.ok(decision.reasonCodes.includes("CONTRACT_NEIGHBOR_DEPENDENCY"));
  assert.deepEqual(snapshot(f.inspect()), before);
});
