import type { DatabaseSync } from 'node:sqlite';

export function initializeQaStartupContext(database: DatabaseSync): DatabaseSync {
  return database;
}
