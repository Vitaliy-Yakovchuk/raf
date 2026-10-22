import type { StateContext } from './state-migration-guard.ts';

export interface StateMigrationRequest {
  context: StateContext;
  statePath: string;
  fromVersion: number;
  toVersion: number;
  backupPath: string;
}

export interface StateMigrationPorts {
  inspectClients(statePath: string): Promise<'quiescent' | 'incompatible' | 'unknown'>;
}

export interface StateMigrationResult {
  statePath: string;
  backupPath: string;
  fromVersion: number;
  toVersion: number;
  applied: boolean;
}

export async function migrateState(request: StateMigrationRequest, ports?: StateMigrationPorts): Promise<StateMigrationResult> {
  throw new Error('NotImplemented');
}

export async function runStateMigration(argv: readonly string[]): Promise<number> {
  throw new Error('NotImplemented');
}
