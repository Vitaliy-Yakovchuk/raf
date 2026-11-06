import type { DatabaseSync } from 'node:sqlite';
import { pendingStartupContextRunIds } from '../src/startup-context.ts';

export function initializeQaStartupContext(database: DatabaseSync): DatabaseSync {
  pendingStartupContextRunIds(database);
  return database;
}
