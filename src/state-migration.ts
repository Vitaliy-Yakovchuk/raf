import { backup, DatabaseSync } from 'node:sqlite';
import { closeSync, constants, openSync, readFileSync, readdirSync, readlinkSync, statSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { openStateStore, STATE_SCHEMA_VERSION } from './state-store.ts';
import { inspectStateSchema } from './state-schema.ts';
import { canonicalStatePath, productionStateContext, stateFailure, verifyStateContext } from './state-migration-guard.ts';
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

async function inspectClients(statePath: string): Promise<'quiescent' | 'incompatible' | 'unknown'> {
  const skipped: { pid: string; identity: string; reason: string }[] = [];
  const skipNonRaf = (pid: string, error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') return false;
    const identities: string[] = [];
    try { identities.push(basename(readlinkSync(`/proc/${pid}/exe`))); } catch {}
    try { identities.push(readFileSync(`/proc/${pid}/comm`, 'utf8').trim()); } catch {}
    if (!identities.length || identities.some(name => /^(?:node|nodejs|raf|bun|deno)(?:$|[-_.\s\d])/i.test(name))) return false;
    skipped.push({ pid, identity: identities[0], reason: code });
    return true;
  };
  const unknown = (pid: string, operation: string, error: unknown): never => {
    throw stateFailure('STATE_MIGRATION_CONFLICT', `Cannot determine client state for pid ${pid} during ${operation}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}; stop clients or restore process inspection access`);
  };
  const identities = [statePath, statePath + '-wal', statePath + '-shm'].flatMap(path => {
    try { const info = statSync(path); return [`${info.dev}:${info.ino}`]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  });
  try {
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name) && Number(name) !== process.pid)) {
      try {
        if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          try {
            const info = statSync(`/proc/${pid}/fd/${fd}`);
            if (identities.includes(`${info.dev}:${info.ino}`)) return 'incompatible';
          } catch (error) {
            if ((error as { code?: string }).code === 'STATE_MIGRATION_CONFLICT') throw error;
            if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'STATE_MIGRATION_CONFLICT') throw error;
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '') && !skipNonRaf(pid, error)) unknown(pid, 'descriptor inspection', error);
      }
    }
    if (skipped.length) process.stderr.write(JSON.stringify({ code: 'STATE_CLIENT_INSPECTION_SKIPPED', processes: skipped }) + '\n');
    return 'quiescent';
  } catch (error) {
    if ((error as { code?: string }).code === 'STATE_MIGRATION_CONFLICT') throw error;
    return 'unknown';
  }
}

function checkIntegrity(db: DatabaseSync, expected: number): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  const results = db.prepare('PRAGMA integrity_check').all();
  if (version !== expected || results.length !== 1 || results[0].integrity_check !== 'ok') {
    throw stateFailure('STATE_MIGRATION_CONFLICT', `Backup/state integrity or version check failed: expected ${expected}, found ${version}`);
  }
}

export async function migrateState(request: StateMigrationRequest, ports: StateMigrationPorts = { inspectClients }): Promise<StateMigrationResult> {
  verifyStateContext(request.context);
  if (!isAbsolute(request.statePath) || request.statePath !== request.context.statePath || canonicalStatePath(request.statePath) !== request.statePath) {
    throw stateFailure('STATE_CONTEXT_REFUSED', `Migration state path differs from context: ${request.statePath}`);
  }
  if (!Number.isSafeInteger(request.fromVersion) || request.fromVersion < 1 || request.fromVersion >= request.toVersion || request.toVersion !== STATE_SCHEMA_VERSION) {
    throw stateFailure('STATE_SCHEMA_UNSUPPORTED', 'Unsupported migration versions or downgrade');
  }
  let backupCanonical: string;
  try { backupCanonical = canonicalStatePath(request.backupPath); }
  catch { throw stateFailure('STATE_MIGRATION_CONFLICT', `Backup path cannot be resolved: ${request.backupPath}`); }
  if (!isAbsolute(request.backupPath) || backupCanonical !== request.backupPath ||
      [request.statePath, request.statePath + '-wal', request.statePath + '-shm'].includes(request.backupPath)) {
    throw stateFailure('STATE_MIGRATION_CONFLICT', 'Backup requires a separate absolute new file without aliases');
  }
  const clientState = await ports.inspectClients(request.statePath);
  if (clientState !== 'quiescent') throw stateFailure('STATE_MIGRATION_CONFLICT', `Cannot migrate: ${clientState} client; stop all raf clients, workers and service and retry`);
  verifyStateContext(request.context);
  const current = inspectStateSchema(request.statePath).version;
  const result = { statePath: request.statePath, backupPath: request.backupPath, fromVersion: request.fromVersion, toVersion: request.toVersion };
  if (current === request.toVersion) {
    const existing = new DatabaseSync(request.statePath, { readOnly: true });
    try { checkIntegrity(existing, request.toVersion); } finally { existing.close(); }
    return { ...result, applied: false };
  }
  if (current > STATE_SCHEMA_VERSION || current === 0) throw stateFailure('STATE_SCHEMA_UNSUPPORTED', `Unsupported source schema ${current}`);
  if (current !== request.fromVersion) throw stateFailure('STATE_MIGRATION_CONFLICT', `Expected version ${request.fromVersion}, found ${current}`);
  let source: DatabaseSync | undefined;
  let reserved = false;
  let complete = false;
  try {
    try {
      const fd = openSync(request.backupPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      reserved = true;
      verifyStateContext(request.context);
      source = new DatabaseSync(request.statePath, { readOnly: true });
      checkIntegrity(source, request.fromVersion);
      await backup(source, request.backupPath);
      const copy = new DatabaseSync(request.backupPath, { readOnly: true });
      try { checkIntegrity(copy, request.fromVersion); } finally { copy.close(); }
      complete = true;
    } catch (error) { throw stateFailure('STATE_MIGRATION_CONFLICT', `Backup failed at ${request.backupPath}: ${(error as NodeJS.ErrnoException).code ?? 'integrity check'}`); }
    source.close();
    if (await ports.inspectClients(request.statePath) !== 'quiescent') throw stateFailure('STATE_MIGRATION_CONFLICT', 'A client appeared during backup; stop clients and retry with a new backup path');
    const store = openStateStore(request.statePath, { context: request.context,
      transfer: { statePath: request.statePath, fromVersion: request.fromVersion, toVersion: request.toVersion } });
    try { checkIntegrity(store.startupContextDatabase, request.toVersion); } finally { store.close(); }
    return { ...result, applied: true };
  } finally {
    try { source?.close(); } catch {}
    if (reserved && !complete) unlinkSync(request.backupPath);
  }
}

export async function runStateMigration(argv: readonly string[]): Promise<number> {
  try {
    const options = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index], value = argv[index + 1];
      if (!['--state', '--from', '--to', '--backup'].includes(key) || options.has(key) || !value) {
        throw stateFailure('STATE_MIGRATION_CONFLICT', 'Usage: node scripts/migrate-state.ts --state <absolute-file> --from <version> --to <version> --backup <new-file>');
      }
      options.set(key, value);
    }
    if (options.size !== 4 || !/^\d+$/.test(options.get('--from')!) || !/^\d+$/.test(options.get('--to')!)) throw stateFailure('STATE_MIGRATION_CONFLICT', 'All four migration arguments and integer versions are required');
    const context = productionStateContext(fileURLToPath(new URL('../../', import.meta.url)), fileURLToPath(import.meta.url), homedir(), 'cli');
    const result = await migrateState({ context, statePath: options.get('--state')!, fromVersion: Number(options.get('--from')),
      toVersion: Number(options.get('--to')), backupPath: options.get('--backup')! });
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: (error as { code?: string }).code ?? 'STATE_MIGRATION_FAILED',
      reason: error instanceof Error ? error.message : 'State migration failed',
      remediation: 'Stop all clients, verify context, explicit versions and a new backup path, then retry the maintenance utility.' }) + '\n');
    return 1;
  }
}
