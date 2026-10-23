import type { DatabaseSync } from "node:sqlite";

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
  openExisting(_request: OpenCompatibilityDatabase): DatabaseSync {
    throw new Error("NotImplemented");
  }

  checkRelease(_request: ReleaseCompatibilityRequest): CompatibilityDecision {
    throw new Error("NotImplemented");
  }

  migrateExplicitly(_request: ExplicitCompatibilityMigration): CompatibilityMigrationResult {
    throw new Error("NotImplemented");
  }

  checkContract(_request: ContractCompatibilityRequest): CompatibilityDecision {
    throw new Error("NotImplemented");
  }
}
