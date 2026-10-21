import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

export interface SecretFileBinding {
  readonly projectPath: string;
  readonly relativePath: string;
  readonly dotenvKey?: string;
}

export interface ConductorSecretMetadata {
  readonly path?: string;
  readonly root?: 'orchestrator';
  readonly key?: string;
  readonly mode?: string;
  readonly expires?: string;
}

export interface SecretRecordMetadata {
  readonly conductor?: ConductorSecretMetadata;
  readonly name: string;
  readonly source: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export type SecretRecord =
  | (SecretRecordMetadata & { readonly kind: 'env'; readonly value: string })
  | (SecretRecordMetadata & { readonly kind: 'file'; readonly contentBase64: string; readonly bindings?: readonly SecretFileBinding[] });

export type SecretMetadata =
  | (SecretRecordMetadata & { readonly kind: 'env' })
  | (SecretRecordMetadata & { readonly kind: 'file'; readonly bindings?: readonly SecretFileBinding[] });

export interface SecretsDocument {
  readonly version: 1;
  readonly records: readonly SecretRecord[];
}

export interface SelectedSecretFile {
  readonly name: string;
  readonly contentBase64: string;
  readonly bindings?: readonly SecretFileBinding[];
}

export interface SecretsSelection {
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly SelectedSecretFile[];
}

export interface SecretsStore {
  list(): Promise<readonly SecretMetadata[]>;
  merge(records: readonly SecretRecord[]): Promise<{ readonly added: readonly string[]; readonly unchanged: readonly string[] }>;
  select(names: readonly string[]): Promise<SecretsSelection>;
}

export interface SecretsStoreOptions {
  readonly home?: string;
  readonly path?: string;
  readonly configPath?: string;
  readonly now?: () => string;
  readonly beforeReplace?: (paths: { readonly temporaryPath: string; readonly targetPath: string }) => Promise<void>;
}

export type SecretsStoreErrorCode = 'invalid-store' | 'unsupported-version' | 'invalid-record' | 'unsafe-path' | 'conflict' | 'missing-secret' | 'expired-secret' | 'io-error';

export class SecretsStoreError extends Error {
  readonly code: SecretsStoreErrorCode;
  readonly remediation: string;

  constructor(code: SecretsStoreErrorCode, message: string, remediation: string) {
    super(message);
    this.name = 'SecretsStoreError';
    this.code = code;
    this.remediation = remediation;
  }
}

const failures: Record<SecretsStoreErrorCode, [string, string]> = {
  'invalid-store': ['Invalid secrets document.', 'Repair the document using the supported schema.'],
  'unsupported-version': ['Unsupported secrets document version.', 'Use a supported document version.'],
  'invalid-record': ['Invalid secret record.', 'Check record fields, metadata, and encoding.'],
  'unsafe-path': ['Unsafe secrets path.', 'Use regular files in a private directory without symbolic links.'],
  conflict: ['Secret records conflict.', 'Reconcile the source records before retrying.'],
  'missing-secret': ['A requested secret is missing.', 'Provide all requested records before selecting them.'],
  'expired-secret': ['A requested secret has expired.', 'Replace expired credentials before selecting them.'],
  'io-error': ['Secrets storage operation failed.', 'Check filesystem access and retry.'],
};

function fail(code: SecretsStoreErrorCode): never {
  throw new SecretsStoreError(code, ...failures[code]);
}

async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof SecretsStoreError) throw error;
    return fail('io-error');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, allowed: readonly string[], code: SecretsStoreErrorCode): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(code);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const day = Number(value.slice(8, 10));
  const month = Number(value.slice(5, 7));
  const year = Number(value.slice(0, 4));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number(value.slice(11, 13)) < 24 && Number.isFinite(Date.parse(value));
}

function nameValid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function storedNameValid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

function conductorValid(value: unknown, kind: unknown): void {
  if (!object(value)) fail('invalid-record');
  fields(value, ['path', 'root', 'key', 'mode', 'expires'], 'invalid-record');
  if ('root' in value && value.root !== 'orchestrator') fail('invalid-record');
  if ('key' in value && !storedNameValid(value.key)) fail('invalid-record');
  if ('mode' in value && (typeof value.mode !== 'string' || !/^[0-7]{3}$/.test(value.mode))) fail('invalid-record');
  if ('expires' in value && (typeof value.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.expires) || !timestamp(`${value.expires}T00:00:00Z`))) fail('invalid-record');
  if ('path' in value) {
    const path = value.path;
    if (typeof path !== 'string' || !path.trim() || path.includes('\0') || /^(?:[A-Za-z]:|[\\]{1,}|\/\/)/.test(path) || path.split(/[\\/]/).includes('..')) fail('invalid-record');
    if (value.root === 'orchestrator' && !relative(path)) fail('invalid-record');
    if (kind === 'env' && (value.root !== 'orchestrator' || !/^worker\/env\/[^/\\]+\.vars$/.test(path) || !storedNameValid(value.key))) fail('invalid-record');
  }
}

function relative(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') &&
    !/^(?:[\\/]|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).includes('..');
}

export function validateSecretRecords(value: unknown): asserts value is SecretRecord[] {
  if (!Array.isArray(value)) fail('invalid-record');
  const names = new Set<string>();
  for (const record of value) {
    if (!object(record)) fail('invalid-record');
    fields(record, ['name', 'source', 'updatedAt', 'expiresAt', 'conductor', 'kind', ...(record.kind === 'env' ? ['value'] : ['contentBase64', 'bindings'])], 'invalid-record');
    if (!storedNameValid(record.name) || names.has(record.name) || typeof record.source !== 'string' || !record.source.trim() ||
        !timestamp(record.updatedAt) || ('expiresAt' in record && !timestamp(record.expiresAt))) fail('invalid-record');
    names.add(record.name);
    if ('conductor' in record) conductorValid(record.conductor, record.kind);
    if (record.kind === 'env') {
      if (typeof record.value !== 'string' || !record.value || record.value.includes('\0')) fail('invalid-record');
    } else if (record.kind === 'file') {
      if (typeof record.contentBase64 !== 'string' || !record.contentBase64 ||
          Buffer.from(record.contentBase64, 'base64').toString('base64') !== record.contentBase64) fail('invalid-record');
      if ('bindings' in record) {
        if (!Array.isArray(record.bindings)) fail('invalid-record');
        for (const binding of record.bindings) {
          if (!object(binding)) fail('invalid-record');
          fields(binding, ['projectPath', 'relativePath', 'dotenvKey'], 'invalid-record');
          if (!relative(binding.projectPath) || !relative(binding.relativePath) ||
              ('dotenvKey' in binding && !nameValid(binding.dotenvKey))) fail('invalid-record');
        }
      }
    } else fail('invalid-record');
  }
}

async function statPath(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function openSecretsStore(options: SecretsStoreOptions = {}): Promise<SecretsStore> {
  return safe(async () => {
    const target = options.path ?? join(options.home ?? homedir(), '.raf', 'secrets.json');
    if (!isAbsolute(target) || target.includes('\0')) fail('unsafe-path');
    const directory = dirname(target);
    const lockPath = `${target}.lock`;
    const clock = options.now ?? (() => new Date().toISOString());
    let initialDirectory = await statPath(directory);
    if (!initialDirectory) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      initialDirectory = await lstat(directory);
    }
    if (!initialDirectory.isDirectory() || initialDirectory.isSymbolicLink()) fail('unsafe-path');
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await directoryHandle.stat();
      if (opened.ino !== initialDirectory.ino || opened.dev !== initialDirectory.dev) fail('unsafe-path');
      await directoryHandle.chmod(0o700);
    } finally { await directoryHandle.close(); }

    async function checkDirectory(): Promise<void> {
      const current = await lstat(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== initialDirectory!.ino || current.dev !== initialDirectory!.dev) fail('unsafe-path');
    }

    async function checkTarget(): Promise<void> {
      await checkDirectory();
      const current = await statPath(target);
      if (current && (!current.isFile() || current.isSymbolicLink())) fail('unsafe-path');
    }

    async function read(): Promise<SecretsDocument> {
      await checkTarget();
      let handle;
      try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('unsafe-path');
        throw error;
      }
      try {
        if (!(await handle.stat()).isFile()) fail('unsafe-path');
        await checkTarget();
        let document: unknown;
        try { document = JSON.parse(await handle.readFile('utf8')); }
        catch { fail('invalid-store'); }
        if (!object(document)) fail('invalid-store');
        fields(document, ['version', 'records'], 'invalid-store');
        if (!('version' in document)) fail('invalid-store');
        if (document.version !== 1) fail('unsupported-version');
        try { validateSecretRecords(document.records); }
        catch { fail('invalid-store'); }
        await handle.chmod(0o600);
        return document as unknown as SecretsDocument;
      } finally { await handle.close(); }
    }

    async function locked<T>(action: () => Promise<T>): Promise<T> {
      const configuration = JSON.parse(await readFile(options.configPath ?? new URL('../../conf/raf.json', import.meta.url), 'utf8'));
      const timeout = configuration.secrets?.lockWaitTimeoutMs;
      const poll = configuration.secrets?.pollIntervalMs;
      if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(poll) || poll <= 0 || poll > timeout) fail('io-error');
      const deadline = performance.now() + timeout;
      let lock;
      while (!lock) {
        await checkTarget();
        try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await statPath(lockPath);
          if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('unsafe-path');
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new SecretsStoreError('io-error', 'Secrets storage lock wait expired.', 'Verify that the previous writer has ended and recover its lock before retrying.');
          await delay(Math.min(poll, remaining));
        }
      }
      const owned = await lock.stat();
      try { return await action(); }
      finally {
        await lock.close();
        await checkDirectory();
        const current = await statPath(lockPath);
        if (current && current.ino === owned.ino && current.dev === owned.dev && !current.isSymbolicLink()) await unlink(lockPath);
      }
    }

    await read();
    return {
      list: () => safe(async () => (await read()).records.map(record => {
        const { name, kind, source, updatedAt, expiresAt, conductor } = record;
        return { name, kind, source, updatedAt, ...(conductor === undefined ? {} : { conductor }), ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(record.kind === 'file' && record.bindings !== undefined ? { bindings: record.bindings } : {}) };
      })),
      merge: incoming => safe(async () => {
        validateSecretRecords(incoming);
        const records = structuredClone(incoming);
        return locked(async () => {
          const current = await read();
          const byName = new Map(current.records.map(record => [record.name, record]));
          const added: string[] = [];
          const unchanged: string[] = [];
          for (const record of records) {
            const prior = byName.get(record.name);
            if (prior) {
              if (!isDeepStrictEqual(prior, record)) fail('conflict');
              unchanged.push(record.name);
            } else {
              byName.set(record.name, record);
              added.push(record.name);
            }
          }
          if (added.length === 0) return { added, unchanged };
          const temporaryPath = join(directory, `.secrets-${randomUUID()}.tmp`);
          await checkDirectory();
          const temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          const owned = await temporary.stat();
          try {
            try {
              await temporary.chmod(0o600);
              await temporary.writeFile(JSON.stringify({ version: 1, records: [...byName.values()] }));
              await temporary.sync();
            } finally { await temporary.close(); }
            if (options.beforeReplace) {
              try { await options.beforeReplace({ temporaryPath, targetPath: target }); }
              catch { fail('io-error'); }
            }
            await checkTarget();
            const candidate = await lstat(temporaryPath);
            if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.ino !== owned.ino || candidate.dev !== owned.dev) fail('unsafe-path');
            await rename(temporaryPath, target);
          } finally {
            await checkDirectory();
            const leftover = await statPath(temporaryPath);
            if (leftover && leftover.ino === owned.ino && leftover.dev === owned.dev && !leftover.isSymbolicLink()) await unlink(temporaryPath);
          }
          return { added, unchanged };
        });
      }),
      select: names => safe(async () => {
        if (!Array.isArray(names) || !names.every(storedNameValid)) fail('invalid-record');
        const requested = [...new Set(names)];
        const document = await read();
        const now = clock();
        if (!timestamp(now)) fail('invalid-record');
        const env: Record<string, string> = {};
        const files: SelectedSecretFile[] = [];
        for (const name of requested) {
          const record = document.records.find(record => record.name === name);
          if (!record) fail('missing-secret');
          if (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(now)) fail('expired-secret');
          if (record.kind === 'env' && !nameValid(record.name)) fail('invalid-record');
          if (record.kind === 'env') Object.defineProperty(env, record.name, { value: record.value, enumerable: true, configurable: true, writable: true });
          else files.push({ name: record.name, contentBase64: record.contentBase64, ...(record.bindings === undefined ? {} : { bindings: record.bindings }) });
        }
        return { env, files };
      }),
    };
  });
}

