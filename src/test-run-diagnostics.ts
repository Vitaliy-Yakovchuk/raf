import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
export type DiagnosticTestId = { file: string; name: string };
export type DiagnosticLocation = { file: string; line: number | null; column: number | null };
export type DiagnosticOrigin = 'test-body' | 'import' | 'collection' | 'hook' | 'fixture-setup' | 'unknown';
export type DiagnosticKind = 'assertion' | 'test-failure' | 'setup' | 'protocol' | 'runner' | 'preflight';
export type DiagnosticLimits = {
  maxEntries: number;
  maxMessageBytes: number;
  maxStackFrames: number;
  maxStackBytes: number;
  maxTotalBytes: number;
  maxProtocolLineBytes: number;
  maxStderrBytes: number;
  redactionPatterns: string[];
};
export type DiagnosticPaths = { workspace: string; qaHome: string; fixtureRoots: string[] };
export type DiagnosticFailure = {
  test: DiagnosticTestId | null;
  origin: DiagnosticOrigin;
  error: unknown;
  location?: DiagnosticLocation | null;
};
export type NodeDiagnosticEvent = {
  type: 'test:fail';
  data: {
    file?: string;
    name?: string;
    line?: number;
    column?: number;
    details: { error?: unknown; diagnosticOrigin?: DiagnosticOrigin };
  };
};
export type InlineDiagnostic = {
  kind: DiagnosticKind;
  test: DiagnosticTestId | null;
  errorName?: string;
  errorCode?: string;
  message: string;
  location: DiagnosticLocation | null;
  stack: string[];
  redacted: boolean;
  truncated: boolean;
  unavailableReason?: string;
};
export type DiagnosticSummary = {
  totalEntries: number;
  retainedEntries: number;
  omittedEntries: number;
  truncated: boolean;
  redacted: boolean;
};
export type DiagnosticEnvironmentInput = {
  executable: string;
  runtimeVersion: string;
  adapter: string;
  isolation: string;
  configurationBytes: { flow: Uint8Array; testRuns: Uint8Array; projects: Uint8Array };
  tmpPath: string;
  privateRunTmp: boolean;
};
export type DiagnosticEnvironmentSummary = {
  executable: string;
  runtimeVersion: string;
  adapter: string;
  isolation: string;
  configurationFingerprints: { flow: string; testRuns: string; projects: string };
  tmpPathBytes: number;
  privateRunTmp: boolean;
};
export type DiagnosticRunFacts = {
  runId: string;
  outcome: string;
  failureKinds: string[];
  knownRed: DiagnosticTestId[];
  unexecuted: DiagnosticTestId[];
  unknown: DiagnosticTestId[];
  timeoutCount: number;
  timedOut: boolean;
  cleanup: unknown;
  evidence: string[];
};
export type DiagnosticAttachment = {
  diagnostics: InlineDiagnostic[];
  diagnosticSummary: DiagnosticSummary;
  environmentSummary: DiagnosticEnvironmentSummary;
};
export type DiagnosticReadState = {
  protocolBufferedBytes: number;
  stderrBufferedBytes: number;
  protocolRejected: boolean;
  stderrTruncated: boolean;
};
export type DiagnosticDisposition = { failureKind: 'assertions' | 'setup' | null; knownRed: DiagnosticTestId | null };

const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'CONFIGURATION_INVALID' }); };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const bytes = (s: string) => Buffer.byteLength(s);
const clip = (s: string, n: number): string => { let out = ''; let size = 0; for (const c of s) { size += bytes(c); if (size > n) break; out += c; } return out; };
const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);
function safeError(error: unknown, seen = new Set<unknown>()): any {
  if (!object(error)) return typeof error === 'string' ? error : null;
  if (seen.has(error)) return null;
  seen.add(error);
  const out: Record<string, unknown> = {};
  try {
    for (const key of ['name', 'code', 'failureType', 'diagnosticOrigin', 'generatedMessage', 'operator', 'message', 'stack', 'cause']) {
      let current: object | null = error;
      while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) { if ('value' in descriptor) out[key] = key === 'cause' ? safeError(descriptor.value, seen) : descriptor.value; break; }
        current = Object.getPrototypeOf(current);
      }
    }
  } catch { return null; }
  return out;
}
export function validateDiagnosticLimits(value: unknown): DiagnosticLimits {
  if (!object(value)) return invalid('diagnostics is required');
  for (const key of ['maxEntries', 'maxMessageBytes', 'maxStackFrames', 'maxStackBytes', 'maxTotalBytes', 'maxProtocolLineBytes', 'maxStderrBytes']) if (!Number.isSafeInteger(value[key]) || value[key] <= 0) invalid(`diagnostics/${key}`);
  if (value.maxTotalBytes < bytes(JSON.stringify({ diagnostics: [], diagnosticSummary: { totalEntries: Number.MAX_SAFE_INTEGER, retainedEntries: Number.MAX_SAFE_INTEGER, omittedEntries: Number.MAX_SAFE_INTEGER, truncated: false, redacted: false } })) || value.maxMessageBytes > value.maxTotalBytes || value.maxStackBytes > value.maxTotalBytes) invalid('diagnostics incompatible byte budgets');
  if (!Array.isArray(value.redactionPatterns) || value.redactionPatterns.some((p: unknown) => typeof p !== 'string' || !p)) invalid('diagnostics/redactionPatterns');
  for (const pattern of value.redactionPatterns) try { new RegExp(pattern, 'gu'); } catch { invalid('diagnostics/redactionPatterns'); }
  return value as DiagnosticLimits;
}

export function diagnosticFailureFromNodeEvent(event: NodeDiagnosticEvent): DiagnosticFailure | null {
  const data = event.data;
  const error: any = safeError(data.details?.error);
  if (error?.failureType === 'subtestsFailed') return null;
  const explicit = data.details?.diagnosticOrigin ?? error?.diagnosticOrigin;
  const origin = explicit ?? (error?.failureType === 'testCodeFailure' ? 'test-body' : error?.failureType === 'hookFailed' ? 'hook' : 'unknown');
  const cause = error?.failureType === 'testCodeFailure' && object(error.cause) ? error.cause : error;
  return { test: data.file && data.name ? { file: data.file, name: data.name } : null, origin, error: cause,
    location: data.file && Number.isFinite(data.line) ? { file: data.file, line: data.line!, column: data.column ?? null } : null };
}

export function buildDiagnosticEnvironment(input: DiagnosticEnvironmentInput): DiagnosticEnvironmentSummary {
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  return { executable: input.executable, runtimeVersion: input.runtimeVersion, adapter: input.adapter, isolation: input.isolation,
    configurationFingerprints: { flow: hash(input.configurationBytes.flow), testRuns: hash(input.configurationBytes.testRuns), projects: hash(input.configurationBytes.projects) }, tmpPathBytes: bytes(input.tmpPath), privateRunTmp: input.privateRunTmp };
}

export class TestRunDiagnostics {
  private limits: DiagnosticLimits;
  private paths: DiagnosticPaths;
  private entries: InlineDiagnostic[] = [];
  private total = 0;
  private omittedRedacted = false;
  private state: DiagnosticReadState = { protocolBufferedBytes: 0, stderrBufferedBytes: 0, protocolRejected: false, stderrTruncated: false };
  private protocol = '';
  private stderr = '';
  private decoder = new StringDecoder('utf8');
  private stderrDecoder = new StringDecoder('utf8');
  private discarding = false;
  constructor(limits: DiagnosticLimits, paths: DiagnosticPaths) { this.limits = validateDiagnosticLimits(limits); this.paths = paths; }

  private path(path: string): string {
    if (!isAbsolute(path)) return path;
    for (const [root, marker] of [...this.paths.fixtureRoots.map(root => [root, '<fixture>']), [this.paths.qaHome, '<qa-home>'], [this.paths.workspace, '']] as string[][]) if (root && inside(path, root)) return marker ? marker + (relative(root, path) ? '/' + relative(root, path) : '') : relative(root, path) || '.';
    return '<external>/' + path.split('/').filter(Boolean).pop();
  }
  private clean(value: string): { text: string; redacted: boolean } {
    let s = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    s = s.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '<redacted>');
    s = s.replace(/\b(cookie|set-cookie)\s*[:=][^\r\n]*/gi, '$1: <redacted>');
    s = s.replace(/\b(authorization|cookie|set-cookie|password|passwd|token|api[_-]?key|secret)\b(\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1$2<redacted>');
    s = s.replace(/https?:\/\/[^\s<>"']+/g, raw => { try { const u = new URL(raw); if (u.username || u.password) { u.username = ''; u.password = ''; } if (u.search) u.search = '?<redacted>'; return u.toString(); } catch { return '<redacted-url>'; } });
    for (const pattern of this.limits.redactionPatterns) s = s.replace(new RegExp(pattern, 'gu'), '<redacted>');
    s = s.replace(/(?:file:\/\/)?\/[^\s():<>"']+/g, p => this.path(p.replace(/^file:\/\//, '')));
    return { text: s, redacted: s !== value };
  }
  private add(entry: InlineDiagnostic): void {
    this.total++;
    this.omittedRedacted ||= entry.redacted;
    if (this.entries.length >= this.limits.maxEntries) return;
    this.entries.push(entry);
    const block = this.attach({ runId: '', outcome: '', failureKinds: [], knownRed: [], unexecuted: [], unknown: [], timeoutCount: 0, timedOut: false, cleanup: '', evidence: [] }, {} as DiagnosticEnvironmentSummary);
    if (block.diagnostics.length < this.entries.length) this.entries.pop();
  }
  private diagnostic(kind: DiagnosticKind, input: DiagnosticFailure): InlineDiagnostic {
    let error: any = safeError(input.error);
    const seen = new Set<unknown>();
    while (object(error) && object(error.cause) && !seen.has(error.cause)) { seen.add(error); error = error.cause; }
    const assertion = error?.code === 'ERR_ASSERTION' || error?.name === 'AssertionError';
    const generated = assertion && error?.generatedMessage === true;
    const raw = generated ? `Assertion failed (${typeof error.operator === 'string' ? error.operator.replace(/[^a-zA-Z0-9_=!<>.-]/g, '') : 'assertion'})` : typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : 'Diagnostic details unavailable';
    const clean = this.clean(raw);
    const stackRaw = typeof error?.stack === 'string' ? error.stack.split('\n').filter((s: string) => /^\s*at\s/.test(s)) : [];
    let stack: string[] = [], stackSize = 0, redacted = clean.redacted || generated, truncated = bytes(clean.text) > this.limits.maxMessageBytes;
    let location: DiagnosticLocation | null = null;
    for (const frame of stackRaw) {
      const match = frame.match(/(?:\(|\s)(?:file:\/\/)?(\/[^()]+):(\d+):(\d+)\)?$/);
      if (!location && match && (inside(match[1], this.paths.workspace) || this.paths.fixtureRoots.some(root => inside(match[1], root)))) location = { file: this.path(match[1]), line: Number(match[2]), column: Number(match[3]) };
      const safe = this.clean(frame); redacted ||= safe.redacted;
      if (stack.length >= this.limits.maxStackFrames || bytes(JSON.stringify([...stack, safe.text])) > this.limits.maxStackBytes) { truncated = true; continue; }
      stack.push(safe.text); stackSize += bytes(safe.text);
    }
    if (!location && input.location) location = { ...input.location, file: this.path(input.location.file) };
    const safeField = (v: unknown) => typeof v === 'string' ? clip(this.clean(v).text, this.limits.maxMessageBytes) : undefined;
    return { kind, test: input.test, ...(safeField(error?.name) ? { errorName: safeField(error.name) } : {}), ...(safeField(error?.code) ? { errorCode: safeField(error.code) } : {}), message: clip(clean.text, this.limits.maxMessageBytes), location, stack, redacted, truncated,
      ...(!object(error) && typeof error !== 'string' ? { unavailableReason: 'Runner supplied no safe error details' } : !location && !stack.length ? { unavailableReason: 'Runner supplied no location or stack' } : {}), ...(input.origin === 'unknown' ? { unavailableReason: 'Error origin is unknown' } : {}) };
  }
  failure(input: DiagnosticFailure): DiagnosticDisposition {
    const body = input.origin === 'test-body';
    let error: any = safeError(input.error); const seen = new Set();
    while (error?.cause && !seen.has(error.cause)) { seen.add(error); error = error.cause; }
    const kind: DiagnosticKind = body ? error?.code === 'ERR_ASSERTION' || error?.name === 'AssertionError' ? 'assertion' : 'test-failure' : 'setup';
    this.add(this.diagnostic(kind, input));
    return { failureKind: body ? 'assertions' : 'setup', knownRed: body ? input.test : null };
  }
  inline(entry: InlineDiagnostic): void {
    const safe = this.diagnostic(entry.kind, { test: entry.test, origin: 'test-body', error: { name: entry.errorName, code: entry.errorCode, message: entry.message, stack: entry.stack.join('\n') }, location: entry.location });
    this.add({ ...safe, redacted: safe.redacted || entry.redacted, truncated: safe.truncated || entry.truncated, ...(entry.unavailableReason ? { unavailableReason: this.clean(entry.unavailableReason).text } : {}) });
  }
  preflight(error: unknown): void { this.add(this.diagnostic('preflight', { test: null, origin: 'fixture-setup', error })); }
  protocolChunk(chunk: Uint8Array): void {
    for (const part of this.decoder.write(Buffer.from(chunk)).split(/(?<=\n)/)) {
      if (this.discarding) { if (part.endsWith('\n')) this.discarding = false; continue; }
      if (bytes(this.protocol) + bytes(part) > this.limits.maxProtocolLineBytes) {
        if (!this.state.protocolRejected) this.add(this.diagnostic('protocol', { test: null, origin: 'unknown', error: new Error('Protocol line exceeds configured byte limit') }));
        this.state.protocolRejected = true; this.protocol = ''; this.discarding = !part.endsWith('\n'); continue;
      }
      this.protocol += part;
      if (part.endsWith('\n')) { try { JSON.parse(this.protocol); } catch { if (!this.state.protocolRejected) this.add(this.diagnostic('protocol', { test: null, origin: 'unknown', error: new Error('Invalid runner protocol') })); this.state.protocolRejected = true; } this.protocol = ''; }
    }
    this.state.protocolBufferedBytes = bytes(this.protocol);
  }
  protocolError(message: string): void { this.add(this.diagnostic('protocol', { test: null, origin: 'unknown', error: new Error(message) })); }
  markStderrTruncated(): void { this.state.stderrTruncated = true; }
  stderrText(): string { return this.stderr; }
  stderrChunk(chunk: Uint8Array): void {
    const remaining = this.limits.maxStderrBytes - bytes(this.stderr);
    const decoded = this.stderrDecoder.write(Buffer.from(chunk)); this.stderr += clip(decoded, remaining);
    this.state.stderrTruncated ||= bytes(decoded) > remaining; this.state.stderrBufferedBytes = bytes(this.stderr);
  }
  childExit(input: { exitCode: number | null; signal: string | null; validProtocol: boolean }): void {
    if (!input.validProtocol) { if (!this.state.protocolRejected) this.add({ ...this.diagnostic('protocol', { test: null, origin: 'unknown', error: new Error('Runner exited without valid protocol') }), unavailableReason: 'Valid runner protocol unavailable' }); this.add({ ...this.diagnostic('runner', { test: null, origin: 'unknown', error: this.stderr ? new Error(this.stderr) : null }), truncated: this.state.stderrTruncated }); }
  }
  recoveredDetailsUnavailable(reason: string): void { this.add({ ...this.diagnostic('runner', { test: null, origin: 'unknown', error: null }), unavailableReason: this.clean(reason).text }); }
  readState(): DiagnosticReadState { return { ...this.state }; }
  attach<T extends DiagnosticRunFacts>(facts: T, environment: DiagnosticEnvironmentSummary): T & DiagnosticAttachment {
    let diagnostics = this.entries.map(e => ({ ...e, stack: [...e.stack] }));
    const summary = (): DiagnosticSummary => ({ totalEntries: this.total, retainedEntries: diagnostics.length, omittedEntries: this.total - diagnostics.length, truncated: this.state.stderrTruncated || diagnostics.length < this.total || diagnostics.some(e => e.truncated), redacted: this.omittedRedacted || this.entries.some(e => e.redacted) });
    while (diagnostics.length && bytes(JSON.stringify({ diagnostics, diagnosticSummary: summary() })) > this.limits.maxTotalBytes) diagnostics.pop();
    return { ...facts, diagnostics, diagnosticSummary: summary(), environmentSummary: environment };
  }
}

export type DiagnosticDeliveryPorts<T> = {
  emitTransport: (result: T) => Promise<void>;
  replaceLastAggregateResult: (result: T) => Promise<void>;
};

export async function deliverDiagnosticResult<T extends DiagnosticRunFacts & DiagnosticAttachment>(
  result: T,
  ports: DiagnosticDeliveryPorts<T>,
): Promise<void> {
  const copy = structuredClone(result);
  await ports.replaceLastAggregateResult(copy);
  await ports.emitTransport(structuredClone(copy));
}

export type RunTemporaryConfiguration = { root: string; minimumNestedSocketPathBytes: number };
export type RunTemporaryIdentity = { path: string; realpath: string; device: string; inode: string; uid: number; mode: number; symlink: boolean; runId?: string };
export type RunTemporaryReservation = { runId: string; temporary: RunTemporaryIdentity };
export type RunTemporaryContext = {
  runId: string;
  uid: number;
  qaHome: string;
  statePath: string;
  stateTmpPath: string;
  workspace: string;
  workingStatePath: string;
};
export type RunTemporaryPorts = {
  socketPathCapacityBytes: () => number;
  inspect: (path: string) => Promise<RunTemporaryIdentity | null>;
  createPrivateDirectory: (root: string, runId: string) => Promise<RunTemporaryIdentity>;
  saveReservation: (reservation: RunTemporaryReservation) => Promise<void>;
  removeOwnedDirectory: (identity: RunTemporaryIdentity) => Promise<void>;
};
export type PreparedRunTemporary = {
  reservation: RunTemporaryReservation;
  environment: { HOME: string; RAF_QA_HOME: string; TMPDIR: string };
  statePath: string;
  stateTmpPath: string;
};
const tmpError = (message: string): never => { const diagnostic: InlineDiagnostic = { kind: 'setup', test: null, errorCode: 'TEMPORARY_DIRECTORY_INVALID', message, location: null, stack: [], redacted: false, truncated: false }; throw Object.assign(new Error(message), { code: 'TEMPORARY_DIRECTORY_INVALID', diagnostic }); };
export function validateRunTemporaryConfiguration(value: unknown): RunTemporaryConfiguration {
  if (!object(value) || typeof value.root !== 'string' || !isAbsolute(value.root) || resolve(value.root) !== value.root || !Number.isSafeInteger(value.minimumNestedSocketPathBytes) || value.minimumNestedSocketPathBytes <= 0) return invalid('temporaryArtifacts');
  return value as RunTemporaryConfiguration;
}
export async function prepareRunTemporaryDirectory(configuration: RunTemporaryConfiguration, context: RunTemporaryContext, ports: RunTemporaryPorts): Promise<PreparedRunTemporary> {
  configuration = validateRunTemporaryConfiguration(configuration);
  const capacity = ports.socketPathCapacityBytes();
  const fits = (path: string) => bytes(path) + configuration.minimumNestedSocketPathBytes + 1 <= capacity;
  if (!fits(configuration.root)) tmpError('Configured temporary root exceeds socket pathname capacity');
  const root = await ports.inspect(configuration.root);
  if (!root || root.symlink || root.path !== root.realpath || root.uid !== context.uid && !(root.uid === 0 && (root.mode & 0o1000)) || (root.mode & 0o022) !== 0 && !(root.mode & 0o1000)) tmpError('Temporary root identity or ownership is unsafe');
  const blocked = [context.qaHome, context.statePath, context.stateTmpPath, context.workspace, context.workingStatePath].filter(Boolean);
  if (blocked.some(p => inside(configuration.root, p))) tmpError('Temporary root overlaps protected context');
  const created = await ports.createPrivateDirectory(configuration.root, context.runId);
  if (!inside(created.path, configuration.root) || created.path === configuration.root || !fits(created.path) || created.symlink || created.path !== created.realpath || created.uid !== context.uid || (created.mode & 0o777) !== 0o700 || created.runId && created.runId !== context.runId || blocked.some(p => inside(created.path, p) || inside(p, created.path))) tmpError('Created temporary directory is unsafe or exceeds socket capacity');
  const inspected = await ports.inspect(created.path);
  if (!inspected || inspected.symlink || ['path', 'realpath', 'device', 'inode', 'uid', 'mode'].some(key => (inspected as any)[key] !== (created as any)[key])) tmpError('Created temporary identity changed before reservation');
  const reservation = { runId: context.runId, temporary: { ...created, runId: context.runId } };
  try { await ports.saveReservation(reservation); } catch (error) {
    await cleanupRunTemporaryDirectory(reservation, true, ports);
    throw error;
  }
  return { reservation, environment: { HOME: context.qaHome, RAF_QA_HOME: context.qaHome, TMPDIR: created.path }, statePath: context.statePath, stateTmpPath: context.stateTmpPath };
}
export async function cleanupRunTemporaryDirectory(reservation: RunTemporaryReservation, treeTerminated: boolean, ports: RunTemporaryPorts): Promise<{ cleanup: 'complete' | 'incomplete'; diagnostic: InlineDiagnostic | null }> {
  const incomplete = (): { cleanup: 'incomplete'; diagnostic: InlineDiagnostic } => ({ cleanup: 'incomplete', diagnostic: { kind: 'setup', test: null, message: 'Temporary directory ownership or process termination could not be verified', location: null, stack: [], redacted: false, truncated: false } });
  if (!treeTerminated || reservation.temporary.runId !== reservation.runId) return incomplete();
  try {
    const actual = await ports.inspect(reservation.temporary.path);
    if (!actual) return { cleanup: 'complete', diagnostic: null };
    if (actual.symlink || actual.path !== actual.realpath || (actual.mode & 0o777) !== 0o700 || ['path', 'realpath', 'device', 'inode', 'uid'].some(key => (actual as any)[key] !== (reservation.temporary as any)[key]) || actual.runId !== reservation.runId) return incomplete();
    await ports.removeOwnedDirectory(reservation.temporary);
    return { cleanup: 'complete', diagnostic: null };
  } catch { return incomplete(); }
}
