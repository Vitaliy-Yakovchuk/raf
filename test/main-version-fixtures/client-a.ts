import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { ClientSchemaContract, CompatibilityClient } from "../../src/main-version-compatibility.ts";

export const contractA: ClientSchemaContract = {
  id: "fixture-A-bridge",
  schemaVersions: [41, 42],
  readableFormats: [1, 2],
  requiredColumns: ["id", "body", "format_version", "legacy_note"],
};

export function guardA(database: DatabaseSync, contract = contractA): void {
  const version = Number(database.prepare("PRAGMA user_version").get()!.user_version);
  if (!contract.schemaVersions.includes(version)) {
    throw Object.assign(new Error("A refuses schema"), { code: "SCHEMA_UNSUPPORTED" });
  }
  const formats = database.prepare("SELECT DISTINCT format_version FROM records").all();
  if (formats.some(row => !contract.readableFormats.includes(Number(row.format_version)))) {
    throw Object.assign(new Error("A refuses format"), { code: "FORMAT_UNSUPPORTED" });
  }
}

export function readA(database: DatabaseSync): { id: string; text: string }[] {
  guardA(database);
  return database.prepare("SELECT id, body, legacy_note FROM records ORDER BY id").all().map(row => ({
    id: String(row.id), text: String(row.body),
  }));
}

export function writeA(database: DatabaseSync, id: string, text: string): void {
  guardA(database);
  database.prepare("INSERT INTO records(id, body, format_version) VALUES (?, ?, 1)").run(id, text);
}

export const clientA: CompatibilityClient = {
  contract: contractA,
  probe(database) {
    guardA(database);
    const old = readA(database);
    writeA(database, "gate-a", "written by A");
    assert.deepEqual(readA(database).find(row => row.id === "gate-a"), { id: "gate-a", text: "written by A" });
    assert.ok(old.every(row => readA(database).some(next => next.id === row.id && next.text === row.text)));
  },
};

export const exactLegacyA: CompatibilityClient = {
  contract: { ...contractA, id: "fixture-A-exact", schemaVersions: [41], readableFormats: [1] },
  probe(database) {
    guardA(database, exactLegacyA.contract);
    readA(database);
  },
};
