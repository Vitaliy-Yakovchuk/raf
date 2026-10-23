import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { ClientSchemaContract, CompatibilityClient } from "../../src/main-version-compatibility.ts";

export const contractB: ClientSchemaContract = {
  id: "fixture-B-priority",
  schemaVersions: [41, 42, 43],
  readableFormats: [1, 2],
  requiredColumns: ["id", "body", "format_version"],
};

function versionB(database: DatabaseSync): number {
  const version = Number(database.prepare("PRAGMA user_version").get()!.user_version);
  if (!contractB.schemaVersions.includes(version)) {
    throw Object.assign(new Error("B refuses schema"), { code: "SCHEMA_UNSUPPORTED" });
  }
  return version;
}

export function readB(database: DatabaseSync): { id: string; text: string; priority: string }[] {
  const version = versionB(database);
  const rows = database.prepare(version === 41
    ? "SELECT id, body, format_version, 'normal' AS priority FROM records ORDER BY id"
    : "SELECT id, body, format_version, priority FROM records ORDER BY id").all();
  return rows.map(row => {
    if (!contractB.readableFormats.includes(Number(row.format_version))) {
      throw Object.assign(new Error("B refuses format"), { code: "FORMAT_UNSUPPORTED" });
    }
    return { id: String(row.id), text: String(row.body), priority: String(row.priority) };
  });
}

export function writeB(database: DatabaseSync, id: string, text: string, priority = "normal"): void {
  if (versionB(database) === 41) {
    if (priority !== "normal") throw new Error("Expansion required before priority use");
    database.prepare("INSERT INTO records(id, body, format_version) VALUES (?, ?, 1)").run(id, text);
  } else {
    database.prepare("INSERT INTO records(id, body, format_version, priority) VALUES (?, ?, 2, ?)").run(id, text, priority);
  }
}

export const clientB: CompatibilityClient = {
  contract: contractB,
  probe(database) {
    const old = readB(database);
    const priority = versionB(database) === 42 ? "urgent" : "normal";
    writeB(database, "gate-b", "written by B", priority);
    assert.deepEqual(readB(database).find(row => row.id === "gate-b"), {
      id: "gate-b", text: "written by B", priority,
    });
    assert.ok(old.every(row => readB(database).some(next => next.id === row.id && next.text === row.text && next.priority === row.priority)));
  },
};
