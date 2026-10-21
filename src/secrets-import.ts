import { validateSecretRecords, type SecretRecord, type SecretsStore } from './secrets-store.ts';

export interface ConductorSecretMetadata {
  readonly path?: string;
  readonly root?: 'orchestrator';
  readonly key?: string;
  readonly mode?: string;
  readonly expires?: string;
}

export type ImportedSecretRecord = SecretRecord & { readonly conductor?: ConductorSecretMetadata };

export interface SecretsImportRequest {
  readonly file: string;
}

export interface SecretsImportPorts {
  readText(path: string): Promise<string>;
  readonly store: Pick<SecretsStore, 'merge'>;
}

export interface SecretsImportResult {
  readonly added: readonly string[];
  readonly unchanged: readonly string[];
}

export type SecretsImportErrorCode = 'malformed-source' | 'unsupported-version' | 'unsupported-metadata' | 'invalid-record' | 'source-unavailable';

export class SecretsImportError extends Error {
  readonly code: SecretsImportErrorCode;
  readonly remediation: string;

  constructor(code: SecretsImportErrorCode, message: string, remediation: string) {
    super(message);
    this.name = 'SecretsImportError';
    this.code = code;
    this.remediation = remediation;
  }
}

const failures: Record<SecretsImportErrorCode, [string, string]> = {
  'malformed-source': ['Invalid conductor secrets document.', 'Provide a valid conductor secrets document.'],
  'unsupported-version': ['Unsupported conductor secrets version.', 'Use a supported source version.'],
  'unsupported-metadata': ['Unsupported conductor metadata.', 'Reconcile source metadata with the supported import schema.'],
  'invalid-record': ['Invalid conductor secret record.', 'Correct the record fields and encoding before retrying.'],
  'source-unavailable': ['Cannot read the secrets source.', 'Check the explicitly supplied file and its access permissions.'],
};

function fail(code: SecretsImportErrorCode): never {
  throw new SecretsImportError(code, ...failures[code]);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function known(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('unsupported-metadata');
}

export function parseConductorSecrets(contents: string): readonly ImportedSecretRecord[] {
  let document: unknown;
  try { document = JSON.parse(contents); }
  catch { fail('malformed-source'); }
  if (!object(document)) fail('malformed-source');
  known(document, ['version', 'secrets']);
  if (!('version' in document)) fail('malformed-source');
  if (document.version !== 1) fail('unsupported-version');
  if (!object(document.secrets)) fail('malformed-source');
  const records: ImportedSecretRecord[] = [];
  for (const [name, entry] of Object.entries(document.secrets)) {
    if (!object(entry)) fail('invalid-record');
    known(entry, ['kind', 'value', 'path', 'root', 'key', 'mode', 'source', 'updated', 'expires']);
    if (entry.kind !== 'env' && entry.kind !== 'file') fail('invalid-record');
    if (typeof entry.value !== 'string' || !entry.value || (entry.kind === 'env' && entry.value.includes('\0'))) fail('invalid-record');
    if (entry.kind === 'file' && (!('path' in entry) || !entry.value.isWellFormed())) fail('invalid-record');
    const conductor: Record<string, unknown> = {};
    for (const key of ['path', 'root', 'key', 'mode', 'expires']) {
      if (key in entry) conductor[key] = entry[key];
    }
    const record = {
      name,
      kind: entry.kind,
      source: entry.source,
      updatedAt: entry.updated,
      ...(entry.kind === 'env' ? { value: entry.value } : { contentBase64: Buffer.from(entry.value, 'utf8').toString('base64') }),
      ...(Object.keys(conductor).length ? { conductor } : {}),
      ...('expires' in entry ? { expiresAt: `${entry.expires}T23:59:59.001Z` } : {}),
    };
    try { validateSecretRecords([record]); }
    catch { fail('invalid-record'); }
    records.push(record as ImportedSecretRecord);
  }
  return records;
}

export async function importConductorSecrets(request: SecretsImportRequest, ports: SecretsImportPorts): Promise<SecretsImportResult> {
  if (!request || typeof request.file !== 'string' || !request.file.trim() || request.file.includes('\0')) fail('source-unavailable');
  let contents: string;
  try { contents = await ports.readText(request.file); }
  catch { fail('source-unavailable'); }
  const records = parseConductorSecrets(contents);
  return ports.store.merge(records);
}
