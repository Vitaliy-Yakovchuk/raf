import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import type { TestId, TestRunCleanup, TestRunGroup, TestRunGroupKey, TestRunPlan, TestRunResult, UnitTestPolicy } from './test-runs.ts';

export interface QualityFunction {
  id: string;
  path: string;
  startByte: number;
  endByte: number;
}

export interface QualityMutation {
  siteId: string;
  functionId: string;
  path: string;
  startByte: number;
  endByte: number;
  beforeBase64: string;
  afterBase64: string;
}

export interface QualityRequest {
  version: 1;
  mode: 'baseline' | 'mutant';
  source: { baseRevision: string; revision: string; files: { path: string; sha256: string }[] };
  changedFunctions: QualityFunction[];
  baselineRunId?: string;
  mutant?: QualityMutation;
}

export interface QualityInput {
  path: string;
  bytes: Uint8Array;
  realpath: string;
  role: 'source' | 'test' | 'config' | 'dependency' | 'control';
  mode?: number;
}

export interface QualitySnapshot {
  digest: string;
  inputs: QualityInput[];
}

export interface QualityContext {
  runId: string;
  owner: string;
  canonicalWorkspace: string;
  sharedLibrariesRoot?: string;
  profileId: string;
  profileCwd: string;
  selection: TestRunPlan['selection'];
  selectionDigest: string;
  configDigest: string;
  dependencyDigest: string;
  sourceAdapter: { id: string; version: string };
  siteSelector: { id: string; version: string };
}

export interface QualityExecution {
  runId: string;
  owner: string;
  canonicalWorkspace: string;
  executionRoot: string;
  cwd: string;
  sourceSnapshotDigest: string;
  executionSnapshotDigest: string;
  selection: TestRunPlan['selection'];
  inputs: QualityInput[];
  selectedSites: QualityMutation[];
}

export interface QualityBaseline {
  runId: string;
  owner: string;
  sourceSnapshotDigest: string;
  selectionDigest: string;
  configDigest: string;
  dependencyDigest: string;
  producer: { id: string; version: string };
  result: Pick<TestRunResult, 'outcome' | 'exitCode' | 'timedOut' | 'cleanup' | 'unknown' | 'unexecuted'>;
}

export interface QualityTransportPorts {
  snapshot(): Promise<QualitySnapshot>;
  readCurrent(path: string): Promise<Uint8Array>;
  loadBaseline(runId: string): Promise<QualityBaseline | null>;
  selectSites(snapshot: QualitySnapshot, functions: QualityFunction[]): Promise<{ supported: boolean; reason?: string; sites: QualityMutation[] }>;
  createPrivateCopy(snapshot: QualitySnapshot, runId: string, owner: string): Promise<{ root: string; inputs: QualityInput[] }>;
  removePrivateCopy(root: string, owner: string): Promise<void>;
}

export interface QualityLoadedSource {
  path: string;
  resolvedPath: string;
  inputSha256: string;
  transformedSha256: string | null;
  mapping: string | null;
  loaded: boolean;
  stage: 'load' | 'transform';
  runId: string;
}

export interface QualityCoverage {
  runId: string;
  sourceSnapshotDigest: string;
  selectionDigest: string;
  configDigest: string;
  dependencyDigest: string;
  producer: { id: string; version: string; complete: boolean; exitCode: number | null };
  artifact: { path: string; sha256: string; actualSha256: string; format: string; createdByRunId: string } | null;
  functions: { id: string; unit: 'function' | 'line' | 'branch'; hits: number; denominator: number; sourceSha256: string; mapped: boolean }[];
  omissions: string[];
}

export interface QualityCoverageDecision {
  accepted: boolean;
  reason: string | null;
  functions: { id: string; status: 'covered' | 'uncovered' | 'missing' | 'unsupported'; hits: number | null; denominator: number | null }[];
}

export type QualityFailure = 'refusal' | 'setup' | 'compile' | 'assertions' | 'timeout' | 'interruption';
export type MutationDisposition = 'not-applicable' | 'survived' | 'assertion-killed' | 'compile-failed' | 'setup-failed' | 'timed-out' | 'refused' | 'unverified';
export interface QualityRunFacts {
  mode: 'baseline' | 'mutant';
  runId: string;
  target: { path: string; sha256: string };
  baselineGreen: boolean;
  siteCount: number;
  loadedSources: QualityLoadedSource[];
  events: { origin: 'test-body' | 'transform' | 'import' | 'hook' | 'unknown' | 'broker'; test?: TestId; path?: string; inputSha256?: string; message: string }[];
  protocolComplete: boolean;
  cleanup: TestRunCleanup;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  rawUpstreamOutcome?: string;
}

export interface QualityClassification {
  outcome: TestRunResult['outcome'] | 'compile-failed';
  failureKinds: QualityFailure[];
  knownRed: TestId[];
  mutationDisposition: MutationDisposition;
  reason: string | null;
  nextAction: TestRunResult['nextAction'];
  rawUpstreamOutcome?: string;
}

export interface QualityEvidence {
  mode: QualityRequest['mode'] | null;
  baselineRunId: string | null;
  sourceSnapshotDigest: string | null;
  executionSnapshotDigest: string | null;
  mutant: { siteId: string; functionId: string; path: string; beforeSha256: string; afterSha256: string } | null;
  loadedSources: QualityLoadedSource[];
  coverage: QualityCoverage | { unavailableReason: string };
  mutationDisposition: MutationDisposition;
  reason: string | null;
  provenance?: { baseRevision: string; revision: string; profileId: string; configDigest: string; dependencyDigest: string; selectionDigest: string; sourceAdapter: { id: string; version: string }; siteSelector: { id: string; version: string }; startedAt: string; completedAt: string; manifest: { path: string; sha256: string } };
}

export type QualityTestRunResult = Omit<TestRunResult, 'outcome' | 'failureKinds'> & {
  outcome: QualityClassification['outcome'];
  failureKinds: QualityFailure[];
  quality: QualityEvidence;
};

export interface QualityObservation {
  runId: string;
  agentId: string;
  phase: string;
  mode: 'baseline' | 'mutant';
  sourceSnapshotDigest: string;
  executionSnapshotDigest: string;
  classification: QualityClassification;
}

export interface QualityGroup {
  aggregate: TestRunGroup;
  observations: QualityObservation[];
}

export interface QualityRecoveryCopy {
  root: string;
  owner: string;
  runId: string;
  tree: 'terminated' | 'active' | 'unknown';
}

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const reject = (message: string): never => { throw Object.assign(new Error(message), { code: 'QUALITY_REQUEST_INVALID' }); };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('\0');
const safePath = (value: unknown): value is string => text(value) && !isAbsolute(value) && !/[\\:*?\[\]{}]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('-'));
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const span = (value: any) => Number.isSafeInteger(value.startByte) && Number.isSafeInteger(value.endByte) && value.startByte >= 0 && value.endByte > value.startByte;
const keys = (value: Record<string, unknown>, allowed: string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) reject('Unsupported quality request field'); };
const base64 = (value: unknown): value is string => typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value;
const green = (result: QualityBaseline['result']) => result.outcome === 'passed' && result.exitCode === 0 && !result.timedOut && result.cleanup.complete && !result.cleanup.remainingPids.length && !result.unknown.length && !result.unexecuted.length;
export const qualitySnapshotDigest = (inputs: QualityInput[]) => hash(JSON.stringify(inputs.map(input => [input.path, hash(input.bytes)]).sort((a, b) => a[0].localeCompare(b[0]))));

export function unavailableQualityEvidence(reason: string): QualityEvidence {
  return { mode: null, baselineRunId: null, sourceSnapshotDigest: null, executionSnapshotDigest: null, mutant: null, loadedSources: [], coverage: { unavailableReason: reason }, mutationDisposition: 'unverified', reason };
}

export function validateQualityEvidence(evidence: unknown, result: Pick<TestRunResult, 'outcome' | 'cleanup' | 'timedOut' | 'unknown' | 'unexecuted'>): asserts evidence is QualityEvidence {
  if (!object(evidence) || ![null, 'baseline', 'mutant'].includes(evidence.mode) || ![null, 'string'].includes(evidence.baselineRunId === null ? null : typeof evidence.baselineRunId) || !Array.isArray(evidence.loadedSources) || !['not-applicable', 'survived', 'assertion-killed', 'compile-failed', 'setup-failed', 'timed-out', 'refused', 'unverified'].includes(evidence.mutationDisposition)) reject('Incomplete quality evidence');
  for (const key of ['sourceSnapshotDigest', 'executionSnapshotDigest']) if (evidence[key] !== null && evidence[key] !== undefined && (typeof evidence[key] !== 'string' || !/^[a-f0-9]{64}$/.test(evidence[key]))) reject('Invalid quality snapshot evidence');
  if (evidence.mutationDisposition === 'unverified' && !text(evidence.reason)) reject('Unverified quality evidence requires a reason');
  for (const source of evidence.loadedSources) if (!object(source) || !safePath(source.path) || !text(source.resolvedPath) || !text(source.runId) || !/^[a-f0-9]{64}$/.test(source.inputSha256) || typeof source.loaded !== 'boolean' || !['load', 'transform'].includes(source.stage)) reject('Incomplete quality load evidence');
  if (['survived', 'assertion-killed'].includes(evidence.mutationDisposition)) {
    if (evidence.mode !== 'mutant' || !text(evidence.baselineRunId) || !object(evidence.mutant) || !object(evidence.coverage) || !evidence.sourceSnapshotDigest || !evidence.executionSnapshotDigest || !result.cleanup.complete || result.cleanup.remainingPids.length || result.timedOut || result.unknown.length || result.unexecuted.length || result.outcome !== (evidence.mutationDisposition === 'survived' ? 'passed' : 'assertions-failed') || !evidence.loadedSources.some(source => source.loaded && source.stage === 'load' && source.path === evidence.mutant.path)) reject('Incomplete behavioral quality evidence');
  }
}

export function parseQualityRequest(value: unknown): QualityRequest {
  if (!object(value)) return reject('Quality request must be an object');
  keys(value, ['version', 'mode', 'source', 'changedFunctions', 'baselineRunId', 'mutant']);
  if (value.version !== 1 || !['baseline', 'mutant'].includes(value.mode) || !object(value.source)) reject('Unsupported quality request version or mode');
  keys(value.source, ['baseRevision', 'revision', 'files']);
  if (![value.source.baseRevision, value.source.revision].every(oid => typeof oid === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) reject('Full source revision required');
  if (!Array.isArray(value.source.files) || !value.source.files.length) reject('Source files required');
  const files = new Set<string>();
  for (const file of value.source.files) {
    if (!object(file)) reject('Invalid source file');
    keys(file, ['path', 'sha256']);
    if (!safePath(file.path) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || files.has(file.path)) reject('Unsafe or duplicate source path/hash');
    files.add(file.path);
  }
  if (!Array.isArray(value.changedFunctions) || !value.changedFunctions.length) reject('Changed functions required');
  const ids = new Set<string>();
  for (const fn of value.changedFunctions) {
    if (!object(fn)) reject('Invalid changed function');
    keys(fn, ['id', 'path', 'startByte', 'endByte']);
    if (!text(fn.id) || !safePath(fn.path) || !files.has(fn.path) || !span(fn) || ids.has(fn.id)) reject('Invalid or ambiguous function span');
    if (value.changedFunctions.some((other: QualityFunction) => other !== fn && other.path === fn.path && other.startByte === fn.startByte && other.endByte === fn.endByte)) reject('Ambiguous function identity');
    ids.add(fn.id);
  }
  if (value.mode === 'baseline') {
    if ('mutant' in value || 'baselineRunId' in value) reject('Baseline cannot carry mutation or baselineRunId');
  } else {
    const mutant = value.mutant;
    if (!text(value.baselineRunId) || !object(mutant)) reject('Mutant requires a baseline and site');
    keys(mutant, ['siteId', 'functionId', 'path', 'startByte', 'endByte', 'beforeBase64', 'afterBase64']);
    const fn = value.changedFunctions.find((fn: QualityFunction) => fn.id === mutant.functionId);
    if (!text(mutant.siteId) || !fn || !safePath(mutant.path) || fn.path !== mutant.path || !span(mutant) || mutant.startByte < fn.startByte || mutant.endByte > fn.endByte || !base64(mutant.beforeBase64) || !base64(mutant.afterBase64) || Buffer.from(mutant.beforeBase64, 'base64').length !== mutant.endByte - mutant.startByte || mutant.beforeBase64 === mutant.afterBase64) reject('Invalid mutation site/function or replacement bytes');
  }
  return structuredClone(value) as QualityRequest;
}

export async function prepareQualityExecution(input: QualityRequest, context: QualityContext, ports: QualityTransportPorts): Promise<QualityExecution> {
  const request = parseQualityRequest(input);
  const snapshot = await ports.snapshot();
  const seen = new Set<string>();
  for (const file of snapshot.inputs) {
    const sharedDependency = file.role === 'dependency' && context.sharedLibrariesRoot !== undefined && within(file.realpath, context.sharedLibrariesRoot);
    const relativeSnapshotPath = text(file.path) && !isAbsolute(file.path) && !file.path.includes('\\') && file.path.split('/').every(part => !!part && part !== '.' && part !== '..');
    if (!relativeSnapshotPath || seen.has(file.path) || !within(file.realpath, context.canonicalWorkspace) && !sharedDependency) reject('Snapshot path or symlink escapes canonical workspace');
    seen.add(file.path);
    if (hash(await ports.readCurrent(file.path)) !== hash(file.bytes)) reject('Source changed during snapshot seal');
  }
  for (const file of request.source.files) {
    const actual = snapshot.inputs.find(input => input.path === file.path);
    if (!actual || actual.role !== 'source' || hash(actual.bytes) !== file.sha256) reject('Source hash mismatch or non-production target');
  }
  for (const fn of request.changedFunctions) {
    const actual = snapshot.inputs.find(input => input.path === fn.path)!;
    if (fn.endByte > actual.bytes.length) reject('Function span outside source');
  }
  if (request.mode === 'mutant') {
    const baseline = await ports.loadBaseline(request.baselineRunId!);
    if (!baseline || baseline.runId !== request.baselineRunId || baseline.owner !== context.owner) reject('Baseline owner or runId mismatch');
    if (!green(baseline.result)) reject('Baseline is not verified green');
    if (baseline.sourceSnapshotDigest !== snapshot.digest || baseline.selectionDigest !== context.selectionDigest || baseline.configDigest !== context.configDigest || baseline.dependencyDigest !== context.dependencyDigest) reject('Baseline provenance mismatch: source/test/config/dependency/selection');
  }
  const selection = await ports.selectSites(snapshot, request.changedFunctions);
  if (!selection.supported) reject(`Unsupported selector: ${selection.reason ?? 'function/site mapping unavailable'}`);
  for (const site of selection.sites) {
    const fn = request.changedFunctions.find(fn => fn.id === site.functionId);
    if (!fn || fn.path !== site.path || !span(site) || site.startByte < fn.startByte || site.endByte > fn.endByte) reject('Selector site outside changed function');
    const source = snapshot.inputs.find(input => input.path === site.path)!;
    if (!base64(site.beforeBase64) || !base64(site.afterBase64) || !Buffer.from(source.bytes).subarray(site.startByte, site.endByte).equals(Buffer.from(site.beforeBase64, 'base64'))) reject('Selector before bytes mismatch');
  }
  const mutant = request.mutant;
  if (mutant) {
    if (!selection.sites.some(site => ['siteId', 'functionId', 'path', 'startByte', 'endByte', 'beforeBase64', 'afterBase64'].every(key => (site as any)[key] === (mutant as any)[key]))) reject('Mutation identity not confirmed by reviewed selector');
    const actual = snapshot.inputs.find(input => input.path === mutant.path)!;
    if (!Buffer.from(actual.bytes).subarray(mutant.startByte, mutant.endByte).equals(Buffer.from(mutant.beforeBase64, 'base64'))) reject('Mutation before bytes mismatch');
  }
  const copy = await ports.createPrivateCopy(snapshot, context.runId, context.owner);
  try {
    if (within(copy.root, context.canonicalWorkspace) || within(context.canonicalWorkspace, copy.root)) reject('Execution copy must be private and separate from canonical workspace');
    if (copy.inputs.length !== snapshot.inputs.length) reject('Incomplete execution copy');
    const inputs = snapshot.inputs.map(input => {
      const copied = copy.inputs.find(file => file.path === input.path);
      if (!copied || hash(copied.bytes) !== hash(input.bytes)) reject('Execution copy mapping or bytes mismatch');
      const bytes = mutant?.path === input.path ? Buffer.concat([Buffer.from(input.bytes).subarray(0, mutant.startByte), Buffer.from(mutant.afterBase64, 'base64'), Buffer.from(input.bytes).subarray(mutant.endByte)]) : Uint8Array.from(input.bytes);
      return { ...copied, realpath: resolve(copy.root, input.path), bytes };
    });
    const cwd = resolve(copy.root, context.profileCwd);
    if (!within(cwd, copy.root)) reject('Profile cwd outside execution root');
    return { runId: context.runId, owner: context.owner, canonicalWorkspace: context.canonicalWorkspace, executionRoot: copy.root, cwd, sourceSnapshotDigest: snapshot.digest, executionSnapshotDigest: qualitySnapshotDigest(inputs), selection: structuredClone(context.selection), inputs, selectedSites: mutant ? [mutant] : selection.sites };
  } catch (error) { await ports.removePrivateCopy(copy.root, context.owner); throw error; }
}

export function verifyQualityCoverage(coverage: QualityCoverage, baseline: QualityBaseline, functions: QualityFunction[], sourceHashes: Record<string, string>): QualityCoverageDecision {
  const statuses: QualityCoverageDecision['functions'] = functions.map(fn => ({ id: fn.id, status: 'missing', hits: null, denominator: null }));
  const invalid = (reason: string): QualityCoverageDecision => ({ accepted: false, reason, functions: statuses });
  if (!green(baseline.result)) return invalid('Baseline is not verified green');
  if (coverage.runId !== baseline.runId || coverage.sourceSnapshotDigest !== baseline.sourceSnapshotDigest || coverage.selectionDigest !== baseline.selectionDigest || coverage.configDigest !== baseline.configDigest || coverage.dependencyDigest !== baseline.dependencyDigest) return invalid('Coverage provenance mismatch');
  if (!coverage.producer.complete || coverage.producer.exitCode !== 0 || coverage.producer.id !== baseline.producer.id || coverage.producer.version !== baseline.producer.version) return invalid('Coverage producer incomplete, failed or changed');
  if (!coverage.artifact || coverage.artifact.createdByRunId !== baseline.runId || coverage.artifact.sha256 !== coverage.artifact.actualSha256) return invalid('Missing, stale or mismatched coverage artifact');
  let reason: string | null = coverage.omissions.length ? `Partial coverage: ${coverage.omissions.join(', ')}` : null;
  for (const fn of functions) {
    const rows = coverage.functions.filter(row => row.id === fn.id);
    const status = statuses.find(status => status.id === fn.id)!;
    if (!rows.length) { reason ??= 'Missing function in coverage'; continue; }
    const row = rows[0];
    if (rows.length !== 1 || !row.mapped || row.unit !== 'function' || row.sourceSha256 !== sourceHashes[fn.path] || !Number.isFinite(row.hits) || !Number.isFinite(row.denominator) || row.hits < 0 || row.denominator <= 0 || row.hits > row.denominator) { status.status = 'unsupported'; reason ??= 'Unsupported or ambiguous function coverage mapping'; continue; }
    Object.assign(status, { status: row.hits === 0 ? 'uncovered' : 'covered', hits: row.hits, denominator: row.denominator });
  }
  return { accepted: reason === null, reason, functions: statuses };
}

export function classifyQualityRun(facts: QualityRunFacts): QualityClassification {
  const failureKinds: QualityFailure[] = [];
  const add = (kind: QualityFailure) => { if (!failureKinds.includes(kind)) failureKinds.push(kind); };
  const knownRed: TestId[] = [];
  for (const event of facts.events) {
    if (event.origin === 'broker') add('refusal');
    else if (event.origin === 'test-body' && event.test) { add('assertions'); if (!knownRed.some(id => id.file === event.test!.file && id.name === event.test!.name)) knownRed.push(event.test); }
    else if (event.origin === 'transform' && event.path === facts.target.path && event.inputSha256 === facts.target.sha256) add('compile');
    else add('setup');
  }
  if (facts.timedOut) add('timeout');
  if (facts.interrupted) add('interruption');
  const clean = facts.cleanup.complete && !facts.cleanup.remainingPids.length;
  if (!facts.protocolComplete || !clean || facts.exitCode !== 0 && !failureKinds.length) add('setup');
  let outcome: QualityClassification['outcome'] = 'passed';
  if (facts.timedOut) outcome = 'timed-out';
  else if (facts.interrupted) outcome = 'interrupted';
  else if (failureKinds.includes('refusal')) outcome = 'refused';
  else if (failureKinds.includes('setup')) outcome = 'setup-failed';
  else if (failureKinds.includes('compile')) outcome = 'compile-failed';
  else if (knownRed.length) outcome = 'assertions-failed';
  let reason: string | null = null;
  let disposition: MutationDisposition = 'not-applicable';
  if (facts.mode === 'mutant') {
    const loaded = facts.loadedSources.some(source => source.runId === facts.runId && source.path === facts.target.path && source.inputSha256 === facts.target.sha256 && source.loaded && source.stage === 'load');
    if (facts.timedOut) disposition = 'timed-out';
    else if (facts.interrupted || !facts.protocolComplete || !clean) {
      disposition = 'unverified';
      if (!clean) reason = 'Incomplete cleanup';
      else if (!facts.protocolComplete) reason = 'Incomplete runner protocol';
      else reason = 'Interrupted run';
    }
    else if (failureKinds.includes('refusal')) disposition = 'refused';
    else if (failureKinds.includes('setup')) disposition = 'setup-failed';
    else if (failureKinds.includes('compile')) disposition = 'compile-failed';
    else if (!facts.baselineGreen || !facts.siteCount || !loaded) {
      disposition = 'unverified';
      if (!facts.baselineGreen) reason = 'Baseline not green';
      else if (!facts.siteCount) reason = 'Zero selected sites';
      else reason = 'Target bytes not loaded in this run';
    }
    else disposition = knownRed.length ? 'assertion-killed' : 'survived';
  }
  let nextAction: QualityClassification['nextAction'] = 'fix-implementation';
  if (!clean) nextAction = 'reconcile';
  else if (failureKinds.includes('setup') || failureKinds.includes('compile') || failureKinds.includes('refusal')) nextAction = 'fix-setup';
  else if (facts.timedOut || facts.interrupted) nextAction = 'retry';
  else if (outcome === 'passed') nextAction = 'complete';
  return { outcome, failureKinds, knownRed, mutationDisposition: disposition, reason, nextAction, ...(facts.rawUpstreamOutcome !== undefined ? { rawUpstreamOutcome: facts.rawUpstreamOutcome } : {}) };
}

export function recordQualityObservation(group: QualityGroup, key: TestRunGroupKey, observation: QualityObservation, policy: UnitTestPolicy): QualityGroup {
  if (['project', 'workspace', 'group'].some(field => (group.aggregate.key as any)[field] !== (key as any)[field])) reject('Canonical group key mismatch');
  if (!object(observation) || !object(observation.classification) || !Array.isArray(observation.classification.failureKinds) || !Array.isArray(observation.classification.knownRed) || !text(observation.runId) || !['baseline', 'mutant'].includes(observation.mode) || !text(observation.sourceSnapshotDigest) || !text(observation.executionSnapshotDigest)) reject('Incomplete quality evidence/classification');
  const previous = group.observations.find(item => item.runId === observation.runId);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(observation)) reject('Conflicting quality runId');
    return structuredClone(group);
  }
  const flight = group.aggregate.inFlight;
  if (flight && flight.runId !== observation.runId) reject('Group in flight: another run owns reservation');
  const result = structuredClone(group);
  result.observations.push(structuredClone(observation));
  if (observation.classification.failureKinds.includes('timeout')) result.aggregate.timeoutCount++;
  if (observation.mode === 'baseline') result.aggregate.knownRed = structuredClone(observation.classification.knownRed);
  if (result.aggregate.timeoutCount >= policy.maxGroupTimeouts) {
    result.aggregate.state = result.aggregate.knownRed.length ? 'confirm-known-red' : 'unverified-remainder';
  } else if (result.aggregate.timeoutCount >= policy.optimizeAfterTimeouts) {
    result.aggregate.state = 'optimize';
  } else {
    result.aggregate.state = 'idle';
  }
  if (flight?.runId === observation.runId) result.aggregate.inFlight = null;
  return result;
}

export async function recoverQualityCopies(copies: QualityRecoveryCopy[], owner: string, ports: Pick<QualityTransportPorts, 'removePrivateCopy'>): Promise<string[]> {
  const removed: string[] = [];
  for (const copy of copies) if (copy.owner === owner && copy.tree === 'terminated') { await ports.removePrivateCopy(copy.root, owner); removed.push(copy.root); }
  return removed;
}
