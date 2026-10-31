import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import { SecretsStoreError, type SecretsStore } from './secrets-store.ts';

export type SecretConsumerRefusalCode =
  | 'missing'
  | 'empty'
  | 'expired'
  | 'invalid'
  | 'env-collision'
  | 'unsafe-file-binding'
  | 'missing-output-adapter';

export interface SecretConsumerFileTarget {
  readonly name: string;
  readonly envName: string;
  readonly path?: string;
}

export interface SecretConsumerRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly names: readonly string[];
  readonly fileTargets: readonly SecretConsumerFileTarget[];
  readonly signal: AbortSignal;
}

export interface SecretConsumerSpawnRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly signal: AbortSignal;
  readonly stdout: 'pipe';
  readonly stderr: 'pipe';
}

export interface SecretConsumerChild {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export type SecretConsumerSpawn = (request: SecretConsumerSpawnRequest) => SecretConsumerChild | Promise<SecretConsumerChild>;

export interface SecretConsumerDiscardOutput {
  readonly mode: 'discard';
}

export interface SecretConsumerRedactingOutput {
  readonly mode: 'redact';
  readonly publish: (text: string, stream: 'stdout' | 'stderr') => void;
}

export type SecretConsumerOutput = SecretConsumerDiscardOutput | SecretConsumerRedactingOutput;

export interface SecretConsumerDependencies {
  readonly select: SecretsStore['select'];
  readonly spawn: SecretConsumerSpawn;
  readonly privateDirectory: string;
  readonly output: SecretConsumerOutput | null;
  readonly removeOwned: (directory: string) => Promise<void>;
}

export type SecretConsumerPrimaryOutcome =
  | { readonly status: 'exited'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly status: 'refused'; readonly code: SecretConsumerRefusalCode; readonly message: string }
  | { readonly status: 'spawn-failed'; readonly code: 'spawn-exception'; readonly message: string }
  | { readonly status: 'cancelled'; readonly code: 'aborted'; readonly message: string };

export type SecretConsumerOutcome =
  | SecretConsumerPrimaryOutcome
  | {
    readonly status: 'cleanup-failed';
    readonly code: 'cleanup-error';
    readonly message: string;
    readonly primary: SecretConsumerPrimaryOutcome;
  };

const refusalText: Record<SecretConsumerRefusalCode, string> = {
  missing: 'A requested secret is missing.',
  empty: 'A requested secret is empty.',
  expired: 'A requested secret has expired.',
  invalid: 'The secret consumer request is invalid.',
  'env-collision': 'Secret environment targets collide.',
  'unsafe-file-binding': 'The file binding is unsafe.',
  'missing-output-adapter': 'A safe output adapter is required.',
};

function refused(code: SecretConsumerRefusalCode): SecretConsumerPrimaryOutcome {
  return { status: 'refused', code, message: refusalText[code] };
}

function cancelled(): SecretConsumerPrimaryOutcome {
  return { status: 'cancelled', code: 'aborted', message: 'The secret consumer was cancelled.' };
}

function spawnFailed(): SecretConsumerPrimaryOutcome {
  return { status: 'spawn-failed', code: 'spawn-exception', message: 'The child process failed to start.' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function storeFailure(error: unknown): SecretConsumerRefusalCode {
  const code = error instanceof SecretsStoreError ? error.code
    : isRecord(error) && typeof error.code === 'string' ? error.code : '';
  if (code === 'missing-secret') return 'missing';
  if (code === 'expired-secret') return 'expired';
  return 'invalid';
}

function redactToken(secrets: readonly string[]): string {
  for (const candidate of ['[redacted]', '••••']) {
    if (!secrets.some(secret => secret.length > 0 && candidate.includes(secret))) return candidate;
  }
  return '';
}

function redactComplete(text: string, secrets: readonly string[]): string {
  const ordered = [...secrets].filter(secret => secret.length > 0).sort((left, right) => right.length - left.length);
  if (ordered.length === 0) return text;
  const token = redactToken(ordered);
  let result = '';
  let index = 0;
  while (index < text.length) {
    const matched = ordered.find(secret => text.startsWith(secret, index));
    if (matched) {
      result += token;
      index += matched.length;
    } else {
      result += text[index];
      index += 1;
    }
  }
  return result;
}

function holdLength(text: string, secrets: readonly string[]): number {
  const limit = Math.min(text.length, Math.max(0, ...secrets.map(secret => secret.length)) - 1);
  for (let length = limit; length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (secrets.some(secret => secret.startsWith(suffix))) return length;
  }
  return 0;
}

class OutputChannel {
  private pending = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly secrets: readonly string[];
  private readonly output: SecretConsumerOutput;

  constructor(secrets: readonly string[], output: SecretConsumerOutput) {
    this.secrets = secrets;
    this.output = output;
  }

  push(chunk: Buffer | string, stream: 'stdout' | 'stderr'): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.pending += this.decoder.write(buffer);
    this.flush(stream, false);
  }

  end(stream: 'stdout' | 'stderr'): void {
    this.pending += this.decoder.end();
    this.flush(stream, true);
  }

  private flush(stream: 'stdout' | 'stderr', final: boolean): void {
    if (this.output.mode === 'discard') {
      this.pending = '';
      return;
    }
    this.pending = redactComplete(this.pending, this.secrets);
    if (!final) {
      const held = holdLength(this.pending, this.secrets);
      const ready = this.pending.slice(0, this.pending.length - held);
      this.pending = this.pending.slice(this.pending.length - held);
      if (ready.length > 0) this.output.publish(ready, stream);
      return;
    }
    if (this.pending.length > 0) this.output.publish(this.pending, stream);
    this.pending = '';
  }
}

async function readStream(stream: Readable, channel: OutputChannel, name: 'stdout' | 'stderr'): Promise<void> {
  for await (const chunk of stream) channel.push(chunk as Buffer | string, name);
  channel.end(name);
}

function shapeInvalid(request: SecretConsumerRequest, dependencies: SecretConsumerDependencies): boolean {
  if (!isRecord(request) || !isRecord(dependencies)) return true;
  if (typeof request.executable !== 'string' || request.executable.length === 0 || request.executable.includes('\0')) return true;
  if (!Array.isArray(request.argv) || request.argv.some(item => typeof item !== 'string' || item.includes('\0'))) return true;
  if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || request.cwd.includes('\0') || request.cwd.split(/[\\/]/).includes('..')) return true;
  if (!isRecord(request.baseEnv) || Object.entries(request.baseEnv).some(([key, value]) => !envName(key) || typeof value !== 'string' || value.includes('\0'))) return true;
  if (!Array.isArray(request.names) || request.names.some(name => typeof name !== 'string')) return true;
  if (!Array.isArray(request.fileTargets)) return true;
  if (request.fileTargets.some(target => !isRecord(target) || typeof target.name !== 'string' || typeof target.envName !== 'string' ||
    (target.path !== undefined && typeof target.path !== 'string'))) return true;
  if (!isRecord(request.signal) || typeof request.signal.aborted !== 'boolean' || typeof request.signal.addEventListener !== 'function') return true;
  if (typeof dependencies.select !== 'function' || typeof dependencies.spawn !== 'function' || typeof dependencies.removeOwned !== 'function') return true;
  if (typeof dependencies.privateDirectory !== 'string' || !isAbsolute(dependencies.privateDirectory) || dependencies.privateDirectory.includes('\0')) return true;
  return false;
}

function outputMissing(output: SecretConsumerOutput | null): boolean {
  if (output === null) return true;
  if (output.mode === 'discard') return false;
  return output.mode !== 'redact' || typeof output.publish !== 'function';
}

interface PreparedFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly envName: string;
}

function decodeFile(contentBase64: string): Buffer | null {
  if (!contentBase64 || Buffer.from(contentBase64, 'base64').toString('base64') !== contentBase64) return null;
  return Buffer.from(contentBase64, 'base64');
}

function planFiles(
  request: SecretConsumerRequest,
  selection: Awaited<ReturnType<SecretsStore['select']>>,
  root: string,
): PreparedFile[] | SecretConsumerRefusalCode {
  const occupied = new Set(Object.keys(request.baseEnv));
  for (const name of Object.keys(selection.env)) {
    const value = selection.env[name];
    if (typeof value !== 'string') return 'invalid';
    if (value.length === 0) return 'empty';
    if (!envName(name) || occupied.has(name)) return occupied.has(name) ? 'env-collision' : 'invalid';
    occupied.add(name);
  }
  if (!Array.isArray(selection.files)) return 'invalid';
  const files = new Map<string, { readonly bytes: Buffer }>();
  for (const file of selection.files) {
    if (!isRecord(file) || typeof file.name !== 'string' || typeof file.contentBase64 !== 'string' || files.has(file.name)) return 'invalid';
    if (file.contentBase64.length === 0) return 'empty';
    const bytes = decodeFile(file.contentBase64);
    if (!bytes) return 'invalid';
    if (bytes.length === 0) return 'empty';
    files.set(file.name, { bytes });
  }
  const seen = new Set<string>();
  const paths = new Set<string>();
  const planned: PreparedFile[] = [];
  for (const target of request.fileTargets) {
    if (seen.has(target.name)) return 'invalid';
    seen.add(target.name);
    const file = files.get(target.name);
    if (!file) return selection.env[target.name] === undefined ? 'invalid' : 'env-collision';
    if (!envName(target.envName) || occupied.has(target.envName)) return occupied.has(target.envName) ? 'env-collision' : 'unsafe-file-binding';
    const path = target.path ?? join(root, `${randomUUID()}.secret`);
    if (!isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) return 'unsafe-file-binding';
    const resolved = resolve(path);
    const rel = relative(root, resolved);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || paths.has(resolved)) return 'unsafe-file-binding';
    paths.add(resolved);
    occupied.add(target.envName);
    planned.push({ path: resolved, bytes: file.bytes, envName: target.envName });
  }
  if ([...files.keys()].some(name => !seen.has(name))) return 'unsafe-file-binding';
  return planned;
}

async function privateRoot(directory: string): Promise<string | SecretConsumerRefusalCode> {
  let stat;
  try { stat = await lstat(directory); }
  catch { return 'unsafe-file-binding'; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return 'unsafe-file-binding';
  let canonical: string;
  try { canonical = await realpath(directory); }
  catch { return 'unsafe-file-binding'; }
  if (relative(canonical, resolve(directory)) !== '') return 'unsafe-file-binding';
  return canonical;
}

async function writeOwned(root: string, file: PreparedFile, created: string[]): Promise<SecretConsumerRefusalCode | undefined> {
  const rel = relative(root, file.path);
  const segments = rel.split(sep);
  const name = segments.pop();
  if (!name || name === '.' || name === '..') return 'unsafe-file-binding';
  try {
    const existing = await lstat(file.path);
    if (existing.isSymbolicLink() || existing.isDirectory() || !existing.isFile()) return 'unsafe-file-binding';
    return 'unsafe-file-binding';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unsafe-file-binding';
  }
  let directory = root;
  for (const segment of segments) {
    directory = join(directory, segment);
    let stat;
    try { stat = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unsafe-file-binding';
      try { await mkdir(directory, { mode: 0o700 }); }
      catch { return 'unsafe-file-binding'; }
      created.push(directory);
      try { stat = await lstat(directory); }
      catch { return 'unsafe-file-binding'; }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return 'unsafe-file-binding';
  }
  const handle = await open(file.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  created.push(file.path);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) return 'unsafe-file-binding';
    await handle.chmod(0o600);
    await handle.writeFile(file.bytes);
    await handle.chmod(0o600);
  } finally { await handle.close(); }
  return undefined;
}

async function finish(primary: SecretConsumerPrimaryOutcome, dependencies: SecretConsumerDependencies, owned: boolean): Promise<SecretConsumerOutcome> {
  if (!owned) return primary;
  try {
    await dependencies.removeOwned(dependencies.privateDirectory);
    return primary;
  } catch {
    return { status: 'cleanup-failed', code: 'cleanup-error', message: 'Cleaning up private secret files failed.', primary };
  }
}

export async function runSecretConsumer(request: SecretConsumerRequest, dependencies: SecretConsumerDependencies): Promise<SecretConsumerOutcome> {
  if (shapeInvalid(request, dependencies)) return refused('invalid');
  if (outputMissing(dependencies.output)) return refused('missing-output-adapter');
  if (request.signal.aborted) return finish(cancelled(), dependencies, true);

  let selection: Awaited<ReturnType<SecretsStore['select']>>;
  try { selection = await dependencies.select(request.names); }
  catch (error) { return refused(storeFailure(error)); }
  if (request.signal.aborted) return finish(cancelled(), dependencies, true);

  const root = await privateRoot(dependencies.privateDirectory);
  if (typeof root !== 'string') return refused(root);
  const planned = planFiles(request, selection, root);
  if (typeof planned === 'string') return refused(planned);
  if (request.signal.aborted) return cancelled();

  const created: string[] = [];
  const secrets = [
    ...Object.values(selection.env),
    ...planned.flatMap(file => [file.bytes.toString('utf8'), file.bytes.toString('base64')]),
  ].filter(secret => secret.length > 0);
  try {
    for (const file of planned) {
      if (request.signal.aborted) return finish(cancelled(), dependencies, created.length > 0);
      const failure = await writeOwned(root, file, created);
      if (failure) return finish(refused(failure), dependencies, created.length > 0);
    }
  } catch {
    return finish(refused('unsafe-file-binding'), dependencies, created.length > 0);
  }
  if (request.signal.aborted) return finish(cancelled(), dependencies, created.length > 0);

  const env: Record<string, string> = { ...request.baseEnv };
  for (const [key, value] of Object.entries(selection.env)) env[key] = value;
  for (const file of planned) env[file.envName] = file.path;

  let child: SecretConsumerChild;
  try {
    child = await dependencies.spawn({
      executable: request.executable,
      argv: request.argv,
      cwd: request.cwd,
      env,
      shell: false,
      signal: request.signal,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return finish(request.signal.aborted ? cancelled() : spawnFailed(), dependencies, true);
  }

  const output = dependencies.output;
  if (output === null) return finish(refused('missing-output-adapter'), dependencies, true);
  const stdout = new OutputChannel(secrets, output);
  const stderr = new OutputChannel(secrets, output);
  const stop = () => { try { child.kill('SIGTERM'); } catch { return undefined; } };
  if (request.signal.aborted) stop();
  else request.signal.addEventListener('abort', stop, { once: true });
  let primary: SecretConsumerPrimaryOutcome;
  try {
    const exited = await Promise.all([
      readStream(child.stdout, stdout, 'stdout'),
      readStream(child.stderr, stderr, 'stderr'),
      child.exited,
    ]).then(([, , status]) => status);
    primary = request.signal.aborted
      ? cancelled()
      : { status: 'exited', exitCode: exited.exitCode, signal: exited.signal };
  } catch {
    if (request.signal.aborted) stop();
    try {
      const status = await child.exited;
      primary = request.signal.aborted ? cancelled() : { status: 'exited', exitCode: status.exitCode, signal: status.signal };
    } catch {
      primary = request.signal.aborted ? cancelled() : spawnFailed();
    }
  } finally {
    request.signal.removeEventListener('abort', stop);
  }
  return finish(primary, dependencies, true);
}
