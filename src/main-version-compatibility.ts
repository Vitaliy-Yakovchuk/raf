import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { canonicalStatePath, stateFailure } from "./state-migration-guard.ts";
import { inspectStateSchema } from "./state-schema.ts";

export type CompatibilityContext = {
  kind: "isolated-qa";
  home: string;
  codeRoot: string;
};

export type ClientSchemaContract = {
  id: string;
  schemaVersions: readonly number[];
  readableFormats: readonly number[];
  requiredColumns: readonly string[];
};

export type CompatibilityClient = {
  contract: ClientSchemaContract;
  probe: (database: DatabaseSync) => void;
};

export type OpenCompatibilityDatabase = {
  path: string;
  context: CompatibilityContext;
  client: ClientSchemaContract;
};

export type ReleaseCompatibilityRequest = {
  path: string;
  context: CompatibilityContext;
  current: CompatibilityClient;
  candidate: CompatibilityClient;
};

export type CompatibilityDecision = {
  compatible: boolean;
  requiresStop: boolean;
  reasonCodes: readonly string[];
  checkedClients: readonly string[];
};

export type ExplicitCompatibilityMigration = {
  path: string;
  context: CompatibilityContext;
  fromVersion: number;
  toVersion: number;
  backupPath: string;
  clients: readonly CompatibilityClient[];
  statements: readonly string[];
  beforeCommit?: () => void;
};

export type CompatibilityMigrationResult = {
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  backupPath: string;
};

export type ContractCompatibilityRequest = ReleaseCompatibilityRequest & {
  retiringClient: ClientSchemaContract;
  liveClientIds: readonly string[];
  removedColumns: readonly string[];
  nextRelease: boolean;
};

export class MainVersionCompatibility {
  openExisting(request: OpenCompatibilityDatabase): DatabaseSync {
    verifyOrigin(request.path, request.context);
    const inspected = inspectStateSchema(request.path);
    checkVersion(inspected.version, request.client);
    const identity = statSync(request.path);
    const database = new DatabaseSync(request.path);
    try {
      verifyIdentity(database, request.path, request.context, identity);
      checkDatabase(database, request.client);
      return database;
    } catch (error) { database.close(); throw error; }
  }

  checkRelease(request: ReleaseCompatibilityRequest): CompatibilityDecision {
    const checked: string[] = [];
    try {
      verifyOrigin(request.path, request.context);
      withSnapshot(request.path, request.context, snapshot => {
        exerciseClients(snapshot, [request.current, request.candidate], checked);
      });
      return decision([], checked);
    } catch (error) { return decision([errorCode(error)], checked); }
  }

  migrateExplicitly(request: ExplicitCompatibilityMigration): CompatibilityMigrationResult {
    verifyOrigin(request.path, request.context);
    if (!Number.isSafeInteger(request.fromVersion) || !Number.isSafeInteger(request.toVersion) ||
        request.fromVersion < 1 || request.toVersion <= request.fromVersion || request.toVersion > 0x7fffffff) {
      throw failure("MIGRATION_DOWNGRADE_REFUSED", "Migration requires explicit increasing schema versions");
    }
    if (!request.backupPath) throw failure("MIGRATION_BACKUP_REQUIRED", "A separate preimage backup is required");
    verifyBackupPath(request);
    const result = { fromVersion: request.fromVersion, toVersion: request.toVersion, backupPath: request.backupPath };
    const identity = statSync(request.path);
    const source = new DatabaseSync(request.path);
    let transaction = false;
    try {
      try { source.exec("BEGIN IMMEDIATE"); transaction = true; }
      catch (error) {
        if (isBusy(error)) throw failure("MIGRATION_BUSY", "Another writer or migration owns the database");
        throw error;
      }
      verifyIdentity(source, request.path, request.context, identity);
      const current = schemaVersion(source);
      if (current !== request.fromVersion && current !== request.toVersion) {
        throw failure("MIGRATION_VERSION_CONFLICT", `Expected ${request.fromVersion} or ${request.toVersion}, found ${current}`);
      }
      if (request.clients.length < 2 || request.clients.some(client =>
        !client.contract.schemaVersions.includes(request.fromVersion) || !client.contract.schemaVersions.includes(request.toVersion))) {
        throw failure("MIGRATION_CLIENT_INCOMPATIBLE", "Both neighboring clients must support source and target schemas");
      }
      withSnapshot(request.path, request.context, snapshot => {
        try {
          exerciseClients(snapshot, request.clients, []);
          if (current === request.fromVersion) {
            applyMigration(snapshot, request);
            exerciseClients(snapshot, request.clients, []);
          }
        } catch (error) {
          throw failure("MIGRATION_CLIENT_INCOMPATIBLE", `Compatibility proof failed: ${errorCode(error)}`);
        }
      });
      if (current === request.toVersion) {
        verifyBackup(request.backupPath, request.fromVersion);
        source.exec("ROLLBACK"); transaction = false;
        return { ...result, migrated: false };
      }
      if (existsSync(request.backupPath)) throw failure("MIGRATION_BACKUP_INVALID", "Backup already exists; use a new backup path");
      let reserved = false;
      try {
        closeSync(openSync(request.backupPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
        reserved = true;
        const reader = new DatabaseSync(request.path, { readOnly: true });
        try { reader.prepare("VACUUM main INTO ?").run(request.backupPath); } finally { reader.close(); }
        const copy = new DatabaseSync(request.backupPath);
        try {
          const revision = Number(source.prepare("PRAGMA schema_version").get()?.schema_version);
          (copy as DatabaseSync & { enableDefensive(enabled: boolean): void }).enableDefensive(false);
          copy.exec(`PRAGMA schema_version = ${revision}`);
          (copy as DatabaseSync & { enableDefensive(enabled: boolean): void }).enableDefensive(true);
        } finally { copy.close(); }
        verifyBackup(request.backupPath, request.fromVersion);
      } catch (error) {
        if (reserved) rmSync(request.backupPath, { force: true });
        throw failure("MIGRATION_BACKUP_FAILED", `Cannot create verified preimage backup: ${errorCode(error)}`);
      }
      verifyIdentity(source, request.path, request.context, identity);
      applyMigration(source, request);
      request.beforeCommit?.();
      verifyIdentity(source, request.path, request.context, identity);
      if (schemaVersion(source) !== request.toVersion) throw failure("MIGRATION_VERSION_CONFLICT", "Target version changed before commit");
      source.exec("COMMIT"); transaction = false;
      return { ...result, migrated: true };
    } finally {
      if (transaction) { try { source.exec("ROLLBACK"); } catch {} }
      source.close();
    }
  }

  checkContract(request: ContractCompatibilityRequest): CompatibilityDecision {
    const reasons: string[] = [];
    if (request.liveClientIds.includes(request.retiringClient.id)) reasons.push("CONTRACT_READERS_ACTIVE");
    if (!request.nextRelease) reasons.push("CONTRACT_TOO_EARLY");
    if ([request.current, request.candidate].some(client => client.contract.requiredColumns.some(column =>
      request.removedColumns.some(removed => column === removed || column.split(".").at(-1) === removed)))) {
      reasons.push("CONTRACT_NEIGHBOR_DEPENDENCY");
    }
    const release = this.checkRelease(request);
    return decision([...reasons, ...release.reasonCodes], [...release.checkedClients]);
  }
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function errorCode(error: unknown): string {
  return (error as { code?: string })?.code ?? "CLIENT_PROBE_FAILED";
}

function decision(reasons: string[], checked: string[]): CompatibilityDecision {
  return { compatible: reasons.length === 0, requiresStop: reasons.length !== 0,
    reasonCodes: [...new Set(reasons)], checkedClients: [...new Set(checked)] };
}

function inside(path: string, root: string): boolean { return path.startsWith(root + sep); }

function verifyOrigin(path: string, context: CompatibilityContext): void {
  const refuse = () => { throw stateFailure("STATE_CONTEXT_REFUSED", "Compatibility checks require canonical isolated QA paths and the actual code origin"); };
  if (!context || context.kind !== "isolated-qa" || !isAbsolute(context.home) || !isAbsolute(path) ||
      !isAbsolute(context.codeRoot)) refuse();
  const workingHome = userInfo().homedir;
  const workingState = join(workingHome, ".raf");
  if (context.home === workingHome || context.home === workingState || inside(context.home, workingState) ||
      inside(workingState, context.home) || !inside(path, context.home)) refuse();
  if (canonicalStatePath(context.home) !== context.home || canonicalStatePath(path) !== path ||
      canonicalStatePath(context.codeRoot) !== context.codeRoot ||
      realpathSync(fileURLToPath(new URL("../", import.meta.url))) !== context.codeRoot) refuse();
  for (const file of [path, path + "-wal", path + "-shm"]) {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.nlink !== 1 || canonicalStatePath(file) !== file) refuse();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!existsSync(path)) refuse();
}

function schemaVersion(database: DatabaseSync): number {
  return Number(database.prepare("PRAGMA user_version").get()?.user_version);
}

function verifyIdentity(database: DatabaseSync, path: string, context: CompatibilityContext, identity: { dev: number; ino: number }): void {
  verifyOrigin(path, context);
  const opened = String(database.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file);
  const actual = statSync(path);
  if (opened !== path || actual.dev !== identity.dev || actual.ino !== identity.ino) {
    throw stateFailure("STATE_CONTEXT_REFUSED", "Opened database identity changed");
  }
}

function checkVersion(version: number, client: ClientSchemaContract): void {
  if (!Number.isSafeInteger(version) || version < 1 || !client.schemaVersions.includes(version)) {
    throw failure("SCHEMA_UNSUPPORTED", `${client.id} does not support schema ${version}`);
  }
}

function quoteIdentifier(value: string): string { return '"' + value.replaceAll('"', '""') + '"'; }

function checkDatabase(database: DatabaseSync, client: ClientSchemaContract): void {
  checkVersion(schemaVersion(database), client);
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const columns = new Set<string>();
  for (const table of tables) {
    const name = String(table.name);
    const names = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all().map(column => String(column.name));
    for (const column of names) { columns.add(column); columns.add(`${name}.${column}`); }
    for (const format of names.filter(column => column === "format" || column === "format_version")) {
      const values = database.prepare(`SELECT DISTINCT ${quoteIdentifier(format)} AS format FROM ${quoteIdentifier(name)}`).all();
      if (values.some(row => typeof row.format !== "number" || !client.readableFormats.includes(row.format))) {
        throw failure("FORMAT_UNSUPPORTED", `${client.id} cannot read a stored format in ${name}`);
      }
    }
  }
  if (client.requiredColumns.some(column => !columns.has(column))) throw failure("SCHEMA_MISMATCH", `${client.id} requires missing columns`);
}

function withSnapshot<T>(path: string, context: CompatibilityContext, action: (snapshot: DatabaseSync) => T): T {
  verifyOrigin(path, context);
  const directory = mkdtempSync(join(context.home, ".compatibility-"));
  const snapshotPath = join(directory, "snapshot.sqlite");
  try {
    const reader = new DatabaseSync(path, { readOnly: true });
    try { reader.prepare("VACUUM main INTO ?").run(snapshotPath); } finally { reader.close(); }
    const snapshot = new DatabaseSync(snapshotPath);
    try { return action(snapshot); } finally { snapshot.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function exerciseClients(database: DatabaseSync, clients: readonly CompatibilityClient[], checked: string[]): void {
  for (const order of [clients, [...clients].reverse()]) {
    database.exec("SAVEPOINT compatibility_probes");
    try {
      for (const client of order) {
        checkDatabase(database, client.contract);
        try { client.probe(database); }
        catch { throw failure("CLIENT_PROBE_FAILED", `Real read/write probe failed for ${client.contract.id}`); }
        checked.push(client.contract.id);
      }
      for (const client of clients) checkDatabase(database, client.contract);
    } finally { database.exec("ROLLBACK TO compatibility_probes; RELEASE compatibility_probes"); }
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return code !== undefined && [5, 6].includes(code & 255);
}

function verifyBackupPath(request: ExplicitCompatibilityMigration): void {
  const path = request.backupPath;
  const workingState = join(userInfo().homedir, ".raf");
  if (!isAbsolute(path) || canonicalStatePath(path) !== path || path === workingState || inside(path, workingState) ||
      [request.path, request.path + "-wal", request.path + "-shm"].includes(path) ||
      canonicalStatePath(dirname(path)) !== dirname(path)) {
    throw failure("MIGRATION_BACKUP_INVALID", "Backup requires a separate canonical QA path");
  }
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile()) throw failure("MIGRATION_BACKUP_FAILED", "Backup destination is not a regular file");
    if (info.nlink !== 1) throw failure("MIGRATION_BACKUP_INVALID", "Backup has filesystem aliases");
  }
}

function verifyBackup(path: string, version: number): void {
  const backup = new DatabaseSync(path, { readOnly: true });
  try {
    if (schemaVersion(backup) !== version || backup.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw failure("MIGRATION_BACKUP_INVALID", "Backup integrity or source version differs");
    }
  } finally { backup.close(); }
}

function applyMigration(database: DatabaseSync, request: ExplicitCompatibilityMigration): void {
  for (const statement of request.statements) {
    if (!/^\s*(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/i.test(statement) ||
        /\b(?:COMMIT|ROLLBACK|BEGIN|END|ATTACH|DETACH|VACUUM|PRAGMA)\b/i.test(statement)) {
      throw failure("MIGRATION_VERSION_CONFLICT", "Migration statements must preserve the owning transaction");
    }
    database.exec(statement);
  }
  database.exec(`PRAGMA user_version = ${request.toVersion}`);
}
