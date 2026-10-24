import { TestRunDiagnostics } from './test-run-diagnostics.ts';
import type { DiagnosticLimits } from './test-run-diagnostics.ts';
import type { TestRunGroup, TestRunGroupKey, TestRunResult, TestRunTransaction, TestRunStatePort } from './test-runs.ts';

export type StateAccessFailure = {
  store: 'control' | 'unit';
  operation: 'open';
  path: string;
  errorCode: string;
  sqliteCode: number | null;
  message: string;
};
export type StateSnapshot = {
  stateAccess: StateAccessFailure | null;
  groupSnapshot: 'unavailable' | 'absent' | 'loaded';
  groupState: TestRunResult['groupState'] | null;
  timeoutCount: number | null;
};
export type StateRecoveryResult = Omit<TestRunResult, 'groupState' | 'timeoutCount'> & StateSnapshot;
export type RecoveryInFlight = NonNullable<TestRunGroup['inFlight']> & {
  phase: string | null;
  callerPhase: string | null;
  selection: TestRunResult['selection'];
  command: TestRunResult['command'];
  testKind: TestRunResult['testKind'];
  timeoutPolicy: TestRunResult['timeoutPolicy'];
  startedAt: string | null;
  finishedAtMs: number | null;
  deadlineObservedAtMs: number | null;
  ownerIdentity: string | null;
};
export type RecoveryDelivery = {
  runId: string;
  pending: boolean;
  receiptId: string | null;
  returned: boolean;
  forwardedToMain: boolean;
};
export type RecoveryGroup = Omit<TestRunGroup, 'inFlight' | 'lastResult'> & {
  inFlight: RecoveryInFlight | null;
  lastResult: StateRecoveryResult | null;
  delivery: RecoveryDelivery | null;
};
export type RecoveryTransaction = Omit<TestRunTransaction, 'get' | 'put' | 'list'> & {
  get(key: TestRunGroupKey): RecoveryGroup | null;
  put(group: RecoveryGroup): void;
  list(project: string, workspace: string): RecoveryGroup[];
};
export type RecoveryStatePort = {
  transaction<T>(operation: (transaction: RecoveryTransaction) => T): Promise<T>;
};
export type StateOpenPorts = {
  guard(store: 'control' | 'unit', path: string): Promise<void>;
  open(store: 'control' | 'unit', path: string): Promise<RecoveryStatePort>;
  limits: DiagnosticLimits;
};
export type StateRead = StateSnapshot & { group: RecoveryGroup | null; errorCode: string | null };
export type RecoveryObservation = {
  owner: 'lost' | 'alive' | 'unknown';
  tree: 'alive' | 'dead' | 'unknown' | 'pid-reused';
  identity: string | null;
  finishedAtMs: number | null;
  deadlineObservedAtMs: number | null;
  interrupted: boolean;
};
export type RecoveryReply = {
  result: StateRecoveryResult | null;
  stderr: string;
  cliCode: number;
  delivery: RecoveryDelivery | null;
  recovery: {
    runId: string | null;
    processIdentity: string | null;
    deadlineMs: number | null;
    reason: string;
    needsMain: boolean;
  };
};
export type StateRecoveryPorts = {
  state: RecoveryStatePort;
  observe(run: RecoveryInFlight): Promise<RecoveryObservation>;
  cleanup(run: RecoveryInFlight): Promise<TestRunResult['cleanup']>;
  release(runId: string, processIdentity: string | null): Promise<boolean>;
  returnResult(result: StateRecoveryResult): Promise<{ returned: boolean }>;
  messageMain(evidence: RecoveryReply): Promise<{
    accepted: boolean;
    receiptId: string | null;
    forwarded: boolean;
  }>;
};
export async function readTestRunState(
  input: { store: 'control' | 'unit'; path: string; key: TestRunGroupKey },
  ports: StateOpenPorts,
): Promise<StateRead> {
  const unavailable: StateRead = { stateAccess: null, groupSnapshot: 'unavailable', groupState: null, timeoutCount: null, group: null, errorCode: null };
  try { await ports.guard(input.store, input.path); }
  catch (error) { return { ...unavailable, errorCode: errorCode(error) }; }
  let state: RecoveryStatePort;
  try { state = await ports.open(input.store, input.path); }
  catch (error) { return { ...unavailable, errorCode: errorCode(error), stateAccess: stateOpenFailure(input.store, input.path, error, ports.limits) }; }
  if (input.store !== 'unit') return unavailable;
  try {
    const group = await state.transaction(tx => tx.get(input.key));
    return { stateAccess: null, errorCode: null, group, groupSnapshot: group ? 'loaded' : 'absent', groupState: group?.state ?? 'idle', timeoutCount: group?.timeoutCount ?? 0 };
  } catch (error) { return { ...unavailable, errorCode: errorCode(error) }; }
}
export function applyTestRunStateSnapshot(result: TestRunResult, read: StateRead): StateRecoveryResult {
  const snapshot = { ...result, stateAccess: read.stateAccess, groupSnapshot: read.groupSnapshot, groupState: read.groupState, timeoutCount: read.timeoutCount };
  if (read.errorCode) {
    snapshot.errorCode = read.errorCode; snapshot.outcome = 'refused'; snapshot.failureKinds = ['refusal']; snapshot.exitCode = null; snapshot.timedOut = false; snapshot.cleanup = { complete: true, remainingPids: [] }; snapshot.nextAction = 'reconcile';
    if (read.stateAccess) { const message = read.stateAccess.message; const redacted = /<(?:redacted|external|qa-home)/.test(message); snapshot.diagnostics = [{ kind: 'preflight', test: null, errorCode: read.errorCode, message, location: null, stack: [], redacted, truncated: false }]; snapshot.diagnosticSummary = { totalEntries: 1, retainedEntries: 1, omittedEntries: 0, truncated: false, redacted }; }
  }
  return snapshot;
}
export async function recoverTestRun(
  input: { key: TestRunGroupKey; authorized: boolean; nowMs: number },
  ports: StateRecoveryPorts,
): Promise<RecoveryReply> {
  if (!input.authorized) throw Object.assign(new Error('Recovery requires an authorized caller'), { code: 'CALLER_UNAUTHORIZED' });
  return serialized(ports.state, async () => {
    let group = await ports.state.transaction(tx => tx.get(input.key));
    let flight = group?.inFlight ?? null;
    const reply: RecoveryReply = { result: null, stderr: '', cliCode: 1, delivery: group?.delivery ?? null, recovery: { runId: flight?.runId ?? group?.delivery?.runId ?? null, processIdentity: flight?.processIdentity ?? null, deadlineMs: flight?.deadlineMs ?? null, reason: 'No pending result', needsMain: false } };
    if (!group) return reply;
    const pending = group.delivery?.pending && group.lastResult?.runId === group.delivery.runId;
    if (!flight && !pending) return reply;
    if (flight && group.lastResult?.runId === flight.runId && group.lastResult.cleanup.complete && !flight.recoveryReleasePending) {
      group = await ports.state.transaction(tx => { const current = tx.get(input.key); if (current?.inFlight?.runId !== flight!.runId || current.lastResult?.runId !== flight!.runId) return null; current.delivery ??= delivery(flight!.runId); tx.put(current); return current; });
      if (!group) return reply;
      flight = null;
    }
    if (flight) {
      const observed = await ports.observe(flight);
      const identityMatches = !!flight.processIdentity && observed.identity === flight.processIdentity;
      if (observed.owner !== 'lost' || !identityMatches || ['unknown', 'pid-reused'].includes(observed.tree)) {
        reply.recovery.reason = 'Owner or process identity requires reconcile'; reply.recovery.needsMain = true;
        return forward(reply, ports);
      }
      if (observed.tree === 'alive' && input.nowMs < flight.deadlineMs) {
        reply.recovery.reason = 'Original tree is alive before its saved deadline; final result unavailable'; reply.recovery.needsMain = true;
        return forward(reply, ports);
      }
      const observedRun = await ports.state.transaction(tx => {
        const current = tx.get(input.key);
        if (current?.inFlight?.runId !== flight!.runId || current.inFlight.processIdentity !== flight!.processIdentity) return null;
        current.inFlight.finishedAtMs ??= observed.finishedAtMs;
        current.inFlight.deadlineObservedAtMs ??= observed.deadlineObservedAtMs;
        if (observed.tree === 'alive' && input.nowMs >= flight!.deadlineMs) current.inFlight.deadlineObservedAtMs ??= input.nowMs;
        current.inFlight.recoveryReleasePending = true;
        tx.put(current); return current.inFlight;
      });
      if (!observedRun) { reply.recovery.reason = 'Recovery fence changed'; reply.recovery.needsMain = true; return reply; }
      const cleanup = await ports.cleanup(observedRun);
      group = await ports.state.transaction(tx => {
        const current = tx.get(input.key);
        if (!current?.inFlight || current.inFlight.runId !== flight!.runId || current.inFlight.processIdentity !== flight!.processIdentity) return null;
        const saved = current.inFlight;
        saved.finishedAtMs ??= observed.finishedAtMs;
        saved.deadlineObservedAtMs ??= observed.deadlineObservedAtMs;
        if (observed.tree === 'alive' && input.nowMs >= saved.deadlineMs) saved.deadlineObservedAtMs ??= input.nowMs;
        const recorded = current.lastResult?.runId === saved.runId;
        if (!recorded) {
          const timeout = saved.deadlineObservedAtMs !== null && saved.deadlineObservedAtMs >= saved.deadlineMs && !(saved.finishedAtMs !== null && saved.finishedAtMs < saved.deadlineMs);
          if (timeout) current.timeoutCount++;
          current.lastResult = lostResult(current, saved, timeout, observed.interrupted, cleanup, input.nowMs);
        }
        current.delivery ??= delivery(saved.runId);
        if (current.delivery.runId !== saved.runId) current.delivery = delivery(saved.runId);
        if (!cleanup.complete || cleanup.remainingPids.length) current.state = 'reconcile';
        tx.put(current); return current;
      });
      if (!group) { reply.recovery.reason = 'Recovery fence changed'; reply.recovery.needsMain = true; return reply; }
      if (!cleanup.complete || cleanup.remainingPids.length) {
        reply.result = group.lastResult; reply.delivery = group.delivery; reply.recovery.reason = 'Original tree cleanup incomplete'; reply.recovery.needsMain = true;
        return forward(reply, ports);
      }
      if (!await ports.release(flight.runId, flight.processIdentity)) {
        reply.result = group.lastResult; reply.delivery = group.delivery; reply.recovery.reason = 'Original resource fence requires reconcile'; reply.recovery.needsMain = true;
        return forward(reply, ports);
      }
      group = await ports.state.transaction(tx => { const current = tx.get(input.key); if (current?.inFlight?.runId !== flight!.runId || current.inFlight.processIdentity !== flight!.processIdentity) return null; current.inFlight = null; current.state = current.lastResult!.groupState!; tx.put(current); return current; });
      if (!group) return reply;
    }
    if (!group.lastResult || group.lastResult.runId !== group.delivery?.runId) return reply;
    reply.result = structuredClone(group.lastResult); reply.delivery = structuredClone(group.delivery);
    reply.recovery.runId = reply.result.runId; reply.recovery.reason = 'Recovered original result';
    let returned = false;
    try { returned = (await ports.returnResult(reply.result)).returned; } catch { }
    if (returned) {
      reply.delivery!.returned = true; reply.delivery!.pending = false;
    } else {
      reply.recovery.needsMain = true;
      await forward(reply, ports);
    }
    await ports.state.transaction(tx => {
      const current = tx.get(input.key);
      if (current?.lastResult?.runId !== reply.result!.runId || current.delivery?.runId !== reply.result!.runId) return;
      current.delivery = reply.delivery; tx.put(current);
    });
    reply.cliCode = reply.result.outcome === 'passed' && reply.result.groupSnapshot === 'loaded' && reply.result.cleanup.complete && !reply.result.timedOut && !reply.result.cleanup.remainingPids.length && !reply.result.knownRed.length && !reply.result.unexecuted.length && !reply.result.unknown.length ? 0 : 1;
    return reply;
  });
}
export async function acknowledgeTestRunDelivery(
  result: Pick<TestRunResult, 'runId' | 'project' | 'workspace' | 'group'>,
  state: TestRunStatePort,
): Promise<void> {
  await state.transaction(tx => {
    const key = { project: result.project, workspace: result.workspace, group: result.group };
    const group = tx.get(key);
    if (group?.lastResult?.runId === result.runId && group.delivery?.runId === result.runId) { group.delivery.pending = false; group.delivery.returned = true; tx.put(group); }
  });
}
export async function cleanupDeliveredTestRunGroups(
  activeChanges: readonly string[], key: TestRunGroupKey, ports: StateRecoveryPorts,
): Promise<void> {
  await ports.state.transaction(tx => {
    for (const group of tx.list(key.project, key.workspace)) {
      if (!activeChanges.includes(group.key.group.split('/')[0]) && !group.inFlight && !group.delivery?.pending) tx.delete(group.key);
    }
  });
}
export function encodeStateRecoveryReply(reply: RecoveryReply): string {
  decodeStateRecoveryReply(reply);
  return JSON.stringify(reply);
}
export function decodeStateRecoveryReply(value: unknown): RecoveryReply {
  const reply = typeof value === 'string' ? JSON.parse(value) : value;
  if (!reply || typeof reply !== 'object' || ![0, 1].includes(reply.cliCode) || typeof reply.stderr !== 'string' || !reply.recovery || typeof reply.recovery.reason !== 'string' || typeof reply.recovery.needsMain !== 'boolean') throw new Error('Invalid recovery reply');
  if (reply.result !== null) validateStateRecoveryResult(reply.result);
  if (reply.delivery !== null && (!reply.delivery || typeof reply.delivery.runId !== 'string' || !['pending', 'returned', 'forwardedToMain'].every(field => typeof reply.delivery[field] === 'boolean') || reply.delivery.receiptId !== null && typeof reply.delivery.receiptId !== 'string')) throw new Error('Invalid result delivery');
  return reply;
}

function errorCode(error: unknown): string { return typeof (error as any)?.code === 'string' ? (error as any).code : 'STATE_FAILED'; }
export function stateOpenFailure(store: 'control' | 'unit', path: string, error: unknown, limits: DiagnosticLimits): StateAccessFailure {
  const diagnostics = new TestRunDiagnostics(limits, { workspace: '', qaHome: '', fixtureRoots: [] });
  diagnostics.preflight(error);
  let message = diagnostics.attach({} as any, {} as any).diagnostics[0]?.message ?? 'Native state open details unavailable';
  if (/^State store open failed(?: \(SQLite [^)]+\))?$/.test(message)) message = 'Native state open details unavailable';
  return { store, operation: 'open', path, errorCode: errorCode(error), sqliteCode: Number.isSafeInteger((error as any)?.errcode) ? (error as any).errcode : null, message };
}
export function validateStateRecoveryResult(result: any): asserts result is StateRecoveryResult {
  if (!result || !['unavailable', 'absent', 'loaded'].includes(result.groupSnapshot) || !Object.hasOwn(result, 'stateAccess')) throw new Error('Incomplete state snapshot');
  if (result.groupSnapshot === 'unavailable') {
    if (result.groupState !== null || result.timeoutCount !== null || result.outcome === 'passed') throw new Error('Unavailable group snapshot');
  } else if (!['idle', 'running', 'optimize', 'confirm-known-red', 'unverified-remainder', 'reconcile', 'complete', 'incomplete'].includes(result.groupState) || !Number.isSafeInteger(result.timeoutCount) || result.timeoutCount < 0) throw new Error('Invalid group snapshot');
  if (result.groupSnapshot === 'absent' && (result.timeoutCount !== 0 || result.groupState !== 'idle')) throw new Error('Invalid absent group snapshot');
  const a = result.stateAccess;
  if (a !== null && (!a || !['control', 'unit'].includes(a.store) || a.operation !== 'open' || typeof a.path !== 'string' || !a.path.startsWith('/') || typeof a.errorCode !== 'string' || typeof a.message !== 'string' || a.sqliteCode !== null && !Number.isSafeInteger(a.sqliteCode))) throw new Error('Invalid state access failure');
}
const locks = new WeakMap<object, Promise<unknown>>();
async function serialized<T>(state: object, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(state) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(state, next);
  try { return await next; } finally { if (locks.get(state) === next) locks.delete(state); }
}
function delivery(runId: string): RecoveryDelivery { return { runId, pending: true, receiptId: null, returned: false, forwardedToMain: false }; }
async function forward(reply: RecoveryReply, ports: StateRecoveryPorts): Promise<RecoveryReply> {
  try {
    const receipt = await ports.messageMain(reply);
    if (reply.delivery) {
      reply.delivery.receiptId = receipt.receiptId;
      reply.delivery.forwardedToMain = receipt.accepted && receipt.forwarded;
      if (reply.delivery.forwardedToMain) reply.delivery.pending = false;
    }
  } catch { }
  return reply;
}
function lostResult(group: RecoveryGroup, flight: RecoveryInFlight, timeout: boolean, interrupted: boolean, cleanup: TestRunResult['cleanup'], now: number): StateRecoveryResult {
  const integration = flight.testKind === 'integration';
  const startedAt = flight.startedAt ?? (flight.startedAtMs !== undefined ? new Date(flight.startedAtMs).toISOString() : '');
  return { runId: flight.runId, project: group.key.project, workspace: group.key.workspace, group: group.key.group, phase: flight.phase ?? 'recovery', callerPhase: flight.callerPhase, testKind: flight.testKind, timeoutPolicy: flight.timeoutPolicy,
    profileId: group.profileId ?? null, selection: flight.selection ?? group.selection, command: flight.command ?? null, startedAt, durationMs: flight.startedAtMs === undefined ? 0 : Math.max(0, (flight.finishedAtMs ?? now) - flight.startedAtMs),
    outcome: timeout ? 'timed-out' : interrupted ? 'interrupted' : 'setup-failed', failureKinds: timeout ? ['timeout'] : interrupted ? ['interruption'] : ['setup'], exitCode: null, signal: null, timedOut: timeout, cleanup,
    passed: [], knownRed: group.knownRed, unexecuted: group.unexecuted, unknown: group.unknown ?? [], removed: [], groupState: integration ? 'incomplete' : 'reconcile', timeoutCount: group.timeoutCount, nextAction: integration ? 'complete-integration' : 'reconcile',
    stateAccess: null, groupSnapshot: 'loaded', hintIds: [], hints: [], evidence: [], diagnostics: [{ kind: 'runner', test: null, message: 'Original runner protocol unavailable after owner loss', location: null, stack: [], redacted: false, truncated: false, unavailableReason: 'Original exit code and protocol unavailable' }], diagnosticSummary: { totalEntries: 1, retainedEntries: 1, omittedEntries: 0, truncated: false, redacted: false }, environmentSummary: { executable: '', runtimeVersion: '', adapter: 'unavailable', isolation: 'unavailable', configurationFingerprints: { flow: '', testRuns: '', projects: '' }, tmpPathBytes: 0, privateRunTmp: false } };
}
