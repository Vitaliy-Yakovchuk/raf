import { loadCompiledCatalog } from './compiled-catalog.ts';
import type { CompiledCatalog } from './catalog.ts';
import { confirmReportWithRetry, confirmationTransient, confirmationStateTransient, type ConfirmationBudget, type ConfirmationStepResult } from './report-confirmation-retry.ts';
import type { ReportRejectionSnapshot } from './report-rejection.ts';
import { validStartupContextAssessment, type StartupContextAssessment } from './startup-context.ts';
import { isAbsolute, join } from 'node:path';
import type { AssignmentSnapshot, AssignmentVerification } from './assignment.ts';
import type { TaskCheckboxCommit, TaskCheckboxReportPort } from './task-checkbox-report.ts';
import type { ReportedCommit, ReportedCommitRequestContext, ReportedCommitAcceptancePorts } from './reported-commits-contract.ts';
import { validReportedCommits } from './reported-commits.ts';
import { waitForConfirmationInput, type ConfirmationInputs } from './report-confirmation-inputs.ts';

export type AgentReportStatus = 'succeeded' | 'failed';
export interface AgentReport {
  readonly status: AgentReportStatus;
  readonly answer: string;
  readonly context?: StartupContextAssessment;
  readonly commits?: readonly ReportedCommit[];
  readonly changes: readonly {
    readonly id: string;
    readonly items: readonly { readonly id: string; readonly status: AgentReportStatus; readonly reason?: string }[];
    readonly archive?: string;
  }[];
  readonly [extra: string]: unknown;
}
export interface ReportValidationContext extends ReportedCommitRequestContext {
  readonly catalog?: Pick<CompiledCatalog, 'reportStatuses'>;
}
export interface AgentReportRequest extends ReportValidationContext {
  readonly tmpRoot: string;
  readonly runId: string;
  readonly address: string;
  readonly assignment: AssignmentSnapshot;
}
export interface AgentReportExit { readonly code: number | null; readonly signal: string | null; }
export interface AgentReportResult {
  readonly runId: string;
  readonly id: string;
  readonly event: 'agent.succeeded' | 'agent.failed';
  readonly status: AgentReportStatus;
  readonly at: string;
  readonly report?: AgentReport;
  readonly exit?: AgentReportExit;
  readonly checkboxCommits?: readonly TaskCheckboxCommit[];
}
export interface ReportConfirmationRetryPorts {
  readonly runner: string;
  protocol(): Promise<unknown>;
  readonly inputs?: ConfirmationInputs;
}
export interface AgentReportPorts extends Partial<TaskCheckboxReportPort>, Partial<ReportedCommitAcceptancePorts> {
  readonly acceptResult?: (result: AgentReportResult) => Promise<void>;
  readonly fs: {
    mkdir(path: string): Promise<void>;
    readText(path: string): Promise<string | null>;
    readBytes?(path: string): Promise<Uint8Array | null>;
    removeTree(path: string): Promise<void>;
  };
  watch(directory: string, listener: (event: 'create' | 'modify' | 'rename', filename: string) => Promise<void>): () => void;
  readonly process: { onExit(listener: (exit: AgentReportExit) => Promise<void>): () => void };
  readonly confirmationRetry?: ReportConfirmationRetryPorts;
  now(): string;
  verifyAssignmentCompletion(snapshot: AssignmentSnapshot, archiveClaims: Readonly<Record<string, string>>): Promise<AssignmentVerification>;
  result(result: AgentReportResult): Promise<void>;
  diagnostic(reason: string, snapshot?: ReportRejectionSnapshot): Promise<void>;
}
export interface AgentReportWatcher {
  readonly path: string;
  finish(exit: AgentReportExit): Promise<void>;
  dispose(): Promise<void>;
}
export type PendingAgentReportPorts = Pick<AgentReportPorts, 'acceptResult' | 'confirmationRetry' | 'now' | 'verifyAssignmentCompletion' | 'diagnostic' | 'confirmTaskCheckboxes' | keyof ReportedCommitAcceptancePorts> & { readonly fs: Pick<AgentReportPorts['fs'], 'readText' | 'readBytes'> };
function agentReportIssues(value: unknown, assignment: AssignmentSnapshot, context?: ReportValidationContext): string[] {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const statuses = (context?.catalog ?? loadCompiledCatalog()).reportStatuses;
  const status = (value: unknown) => statuses.some(row => row.id === value);
  const expectedStatuses = statuses.map(row => row.id).join(' or ');
  const issues: string[] = [];
  const issue = (field: string, reason: string) => { issues.push(`${field}: ${reason}`); };
  if (!record(value)) return ['report: expected an object'];
  if (!status(value.status)) issue('status', `expected ${expectedStatuses}`);
  if (typeof value.answer !== 'string') issue('answer', 'expected a string');
  if (value.context !== undefined && !validStartupContextAssessment(value.context)) issue('context', 'invalid startup context assessment');
  if (context?.reportedCommits && !validReportedCommits(value.commits)) issue('commits', 'expected valid reported commits with repository and full lowercase sha');
  const expectedChanges = assignment.changes.map(change => change.id);
  if (!Array.isArray(value.changes)) {
    issue('changes', `expected an array for assigned changes ${JSON.stringify(expectedChanges)}`);
    return issues;
  }
  if (value.changes.length !== expectedChanges.length) issue('changes', `expected ${expectedChanges.length} assigned changes, received ${value.changes.length}`);
  const changes = new Set<string>();
  for (const [changeIndex, change] of value.changes.entries()) {
    const field = `changes[${changeIndex}]`;
    if (!record(change)) { issue(field, 'expected a change object'); continue; }
    if (typeof change.id !== 'string') { issue(`${field}.id`, 'expected a string'); continue; }
    if (changes.has(change.id)) issue(`${field}.id`, `duplicate change ${change.id}`);
    changes.add(change.id);
    const assigned = assignment.changes.find(row => row.id === change.id);
    if (!assigned) issue(`${field}.id`, `unassigned change ${change.id}; expected ${JSON.stringify(expectedChanges)}`);
    if (change.archive !== undefined && (typeof change.archive !== 'string' || !change.archive)) issue(`${field}.archive`, `${change.id}: expected a nonempty archive string`);
    if (!Array.isArray(change.items)) { issue(`${field}.items`, `${change.id}: expected an array`); continue; }
    const expectedItems = assigned?.items.map(item => `${change.id}:${item.id}`) ?? [];
    if (assigned && assigned.items.length !== change.items.length) issue(`${field}.items`, `expected ${assigned.items.length} items ${JSON.stringify(expectedItems)}, received ${change.items.length}`);
    const items = new Set<string>();
    for (const [itemIndex, item] of change.items.entries()) {
      const itemField = `${field}.items[${itemIndex}]`;
      if (!record(item)) { issue(itemField, `${change.id}: expected an item object`); continue; }
      if (typeof item.id !== 'string') { issue(`${itemField}.id`, `${change.id}: expected a string`); continue; }
      const identity = `${change.id}:${item.id}`;
      if (items.has(item.id)) issue(`${itemField}.id`, `duplicate item ${identity}`);
      items.add(item.id);
      if (!assigned?.items.some(row => row.id === item.id)) issue(`${itemField}.id`, `unassigned item ${identity}; expected assigned items ${JSON.stringify(expectedItems)}`);
      if (!status(item.status)) issue(`${itemField}.status`, `${identity}: expected ${expectedStatuses}`);
      if (item.reason !== undefined && typeof item.reason !== 'string') issue(`${itemField}.reason`, `${identity}: expected a string`);
      if (value.status === 'succeeded' && item.status !== 'succeeded') issue(`${itemField}.status`, `${identity}: succeeded report requires succeeded items`);
    }
    for (const item of assigned?.items ?? []) if (!items.has(item.id)) issue(`${field}.items`, `missing assigned item ${change.id}:${item.id}`);
  }
  for (const change of assignment.changes) if (!changes.has(change.id)) issue('changes', `missing assigned change ${change.id} with items ${change.items.map(item => `${change.id}:${item.id}`).join(', ')}`);
  return issues;
}
export function validAgentReport(value: unknown, assignment: AssignmentSnapshot, context?: ReportValidationContext): value is AgentReport {
  return agentReportIssues(value, assignment, context).length === 0;
}
function reportEvent(context: ReportValidationContext, status: string): AgentReportResult['event'] {
  const event = (context.catalog ?? loadCompiledCatalog()).reportStatuses.find(row => row.id === status)?.event;
  if (!event) throw new Error(`Compiled report status ${status} has no event`);
  return event as AgentReportResult['event'];
}
const acceptanceQueues = new Map<string, Promise<unknown>>();
const rejectedResults = new WeakMap<AgentReportResult, Set<string>>();
const verifiedSnapshots = new WeakMap<AgentReportResult, { request: AgentReportRequest; content: string; bytes: Uint8Array; result: string }>();
function reportDiagnosticText(request: AgentReportRequest, reason: string): string {
  return `Agent: ${request.address}\nItems: ${request.assignment.changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)).join(', ')}\nReport: ${join(request.tmpRoot, request.runId, `${request.address}.json`)}\nReason: ${reason}`;
}
async function sameReportBytes(path: string, bytes: Uint8Array, content: string, ports: PendingAgentReportPorts): Promise<boolean> {
  if (!ports.fs.readBytes) return await ports.fs.readText(path) === content;
  const current = await ports.fs.readBytes(path);
  return current !== null && Buffer.from(bytes).equals(current);
}
async function verifyCurrentReport(request: AgentReportRequest, path: string, ports: PendingAgentReportPorts): Promise<void> {
  if (request.reportedCommits?.runId !== request.runId || request.reportedCommits.reportPath !== path
    || !ports.isCurrentReport || !await ports.isCurrentReport(request.runId, path)) throw new Error('Reported commits do not match the current run/report path');
}
export async function verifyPendingAgentReportFreshness(request: AgentReportRequest, result: AgentReportResult, ports: PendingAgentReportPorts): Promise<void> {
  try {
    const snapshot = verifiedSnapshots.get(result);
    if (!snapshot || snapshot.request !== request || snapshot.result !== JSON.stringify(result)) throw new Error('Report has no verified snapshot in this process');
    const path = join(request.tmpRoot, request.runId, `${request.address}.json`);
    if (!await sameReportBytes(path, snapshot.bytes, snapshot.content, ports)) throw new Error('Report snapshot changed before durable worker acceptance; retry the complete report');
    await verifyCurrentReport(request, path, ports);
  } catch (error) {
    if (confirmationTransient(error)) throw error;
    const transient = confirmationStateTransient(error);
    if (transient) throw transient;
    await rejectPendingAgentReport(request, result, ports, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
export async function rejectPendingAgentReport(request: AgentReportRequest, result: AgentReportResult, ports: PendingAgentReportPorts, reason: string): Promise<void> {
  const snapshot = verifiedSnapshots.get(result);
  if (!result.report || !snapshot || snapshot.request !== request) return;
  if (rejectedResults.get(result)?.has(reason)) return;
  const message = reportDiagnosticText(request, reason);
  await ports.diagnostic(message, { reportPath: join(request.tmpRoot, request.runId, `${request.address}.json`), bytes: snapshot.bytes, reason: message });
  const reasons = rejectedResults.get(result) ?? new Set<string>();
  reasons.add(reason);
  rejectedResults.set(result, reasons);
}

class ReportReadError extends Error {}
export async function readPendingAgentReport(request: AgentReportRequest, ports: PendingAgentReportPorts): Promise<AgentReportResult | null> {
  if (ports.confirmationRetry) {
    try { return await readRetryReport(request, ports); }
    catch (error) {
      if (!(error instanceof ReportReadError)) throw error;
      const reason = reportDiagnosticText(request, error.message);
      await ports.diagnostic(reason, { reportPath: join(request.tmpRoot, request.runId, `${request.address}.json`), bytes: null, reason });
      return null;
    }
  }
  const key = request.assignment.root;
  const diagnostics: { reason: string; snapshot?: ReportRejectionSnapshot }[] = [];
  const previous = acceptanceQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => readReportSnapshot(request, {
    ...ports,
    diagnostic: async (reason, snapshot) => { diagnostics.push({ reason, snapshot }); },
  }));
  acceptanceQueues.set(key, next);
  let result: AgentReportResult | null;
  try { result = await next; } finally { if (acceptanceQueues.get(key) === next) acceptanceQueues.delete(key); }
  for (const diagnostic of diagnostics) await ports.diagnostic(diagnostic.reason, diagnostic.snapshot);
  return result;
}
const retryAttempts = new Set<string>();
const retryAttemptListeners = new Map<string, Set<() => void>>();
function confirmationInputsWithQueue(root: string, inputs: ConfirmationInputs | undefined): ConfirmationInputs | undefined {
  if (!inputs) return undefined;
  return {
    snapshot: async () => JSON.stringify([await inputs.snapshot(), retryAttempts.has(root)]),
    async subscribe(listener) {
      let listeners = retryAttemptListeners.get(root);
      if (!listeners) { listeners = new Set(); retryAttemptListeners.set(root, listeners); }
      listeners.add(listener);
      const remove = () => {
        listeners.delete(listener);
        if (!listeners.size && retryAttemptListeners.get(root) === listeners) retryAttemptListeners.delete(root);
      };
      try {
        const stop = await inputs.subscribe(listener);
        return () => { try { stop(); } finally { remove(); } };
      } catch (error) { remove(); throw error; }
    },
  };
}
async function readRetryReport(request: AgentReportRequest, ports: PendingAgentReportPorts): Promise<AgentReportResult | null> {
  const path = join(request.tmpRoot, request.runId, `${request.address}.json`);
  if (!isAbsolute(request.tmpRoot) || ![request.runId, request.address].every(value => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))) throw new Error('Invalid report directory, run ID or address');
  const validationContext = { ...request, catalog: request.catalog ?? loadCompiledCatalog() };
  const retry = ports.confirmationRetry!;
  const protocol = await retry.protocol();
  let content = '';
  let report: AgentReport;
  let bytes = new Uint8Array();
  let result: AgentReportResult | null = null;
  let ownsAttempt = false;
  let checkboxCommits: readonly TaskCheckboxCommit[] | undefined;
  let budget: ConfirmationBudget;
  const archives = () => Object.fromEntries(report.changes.filter(change => change.archive !== undefined).map(change => [change.id, change.archive!]));
  const details = (verification: AssignmentVerification) => verification.issues.map(issue => `${issue.change}:${issue.requestedItems.join(',')}: ${issue.reason}; Remedy: ${issue.remedy}`).join('\n');
  const rejectStep = (reason: string): ConfirmationStepResult => ({ kind: 'rejected', failure: { code: 'REPORT_UNVERIFIED', reason } });
  const runStep = async (operation: () => Promise<ConfirmationStepResult>): Promise<ConfirmationStepResult> => {
    try { return await operation(); }
    catch (caught) { const error = confirmationStateTransient(caught) ?? caught; return confirmationTransient(error) ? { kind: 'transient', cause: error.cause, reason: error.message } : rejectStep(error instanceof Error ? error.message : String(error)); }
  };
  const beforeWrite = async () => {
    if (ports.isCurrentReport && !await ports.isCurrentReport(request.runId, path) || !await sameReportBytes(path, bytes, content, ports)) throw new Error('Report snapshot changed before write');
  };
  const inputs = confirmationInputsWithQueue(request.assignment.root, retry.inputs);
  let inputSnapshot = await inputs?.snapshot();
  const outcome = await confirmReportWithRetry({ runId: request.runId, reportPath: path, runner: retry.runner,
    route: 'reconciliation', trigger: 'snapshot', launchIdentity: JSON.stringify(request.assignment) }, {
    now: () => performance.now(), sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    ...(inputs ? { waitForChange: async (deadline: number) => {
      await waitForConfirmationInput(inputs, inputSnapshot!, deadline);
      inputSnapshot = await inputs.snapshot();
    } } : {}),
    runnerProtocol: () => protocol,
    currentRun: async () => ({ runId: request.runId, state: !ports.isCurrentReport || await ports.isCurrentReport(request.runId, path) ? 'open' : 'closed' }),
    readReport: async () => {
      let raw: Uint8Array | null;
      try { raw = ports.fs.readBytes ? await ports.fs.readBytes(path) : await ports.fs.readText(path).then(text => text === null ? null : Buffer.from(text)); }
      catch (error) { throw new ReportReadError(`Cannot read report: ${String(error)}`); }
      if (raw === null) return { kind: 'absent' };
      const text = Buffer.from(raw).toString('utf8');
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { return { kind: 'invalid', bytes: text, failure: { code: 'REPORT_INVALID', reason: 'Incomplete or invalid report JSON' } }; }
      if (!validAgentReport(value, request.assignment, validationContext)) return { kind: 'invalid', bytes: text, failure: { code: 'REPORT_INVALID', reason: agentReportIssues(value, request.assignment, validationContext).join('\n') } };
      if (!content) { content = text; bytes = Uint8Array.from(raw); report = value; }
      return { kind: 'candidate', candidate: { bytes: text, status: value.status, items: value.changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)), commits: request.reportedCommits ? value.commits! : [] } };
    },
    enterAttempt: async context => {
      budget = context.budget;
      if (retryAttempts.has(request.assignment.root)) return { kind: 'transient', cause: 'writer-busy', reason: 'Report confirmation queue is busy' };
      retryAttempts.add(request.assignment.root); ownsAttempt = true;
      return { kind: 'ok' };
    },
    releaseAttempt: async () => {
      if (ownsAttempt) {
        retryAttempts.delete(request.assignment.root); ownsAttempt = false;
        for (const listener of [...retryAttemptListeners.get(request.assignment.root) ?? []]) listener();
      }
    },
    confirmCheckboxes: async () => runStep(async () => {
      if (!ports.confirmTaskCheckboxes) return { kind: 'ok' };
      const confirmation = await ports.confirmTaskCheckboxes(request, report, budget, beforeWrite);
      checkboxCommits = confirmation.commits;
      if (confirmation.transient) return { kind: 'transient', cause: confirmation.transient, reason: details(confirmation) };
      if (!confirmation.ok) return rejectStep(`Task checkbox confirmation failed: ${details(confirmation)}`);
      return { kind: 'ok' };
    }),
    finalCheck: async () => runStep(async () => {
      if (report.status === 'succeeded') {
        const verification = await ports.verifyAssignmentCompletion(request.assignment, archives());
        if (!verification.ok) return rejectStep(`Assignment completion is not confirmed: ${details(verification)}`);
      }
      return { kind: 'ok' };
    }),
    accept: async () => runStep(async () => {
      await beforeWrite();
      result = { runId: request.runId, id: request.address, event: reportEvent(validationContext, report.status), status: report.status, at: ports.now(), report, ...(checkboxCommits ? { checkboxCommits } : {}) };
      verifiedSnapshots.set(result, { request, content, bytes, result: JSON.stringify(result) });
      await ports.acceptResult?.(result);
      return { kind: 'ok' };
    }),
    reject: async (_request, snapshot, failure) => {
      const reason = reportDiagnosticText(request, failure.reason);
      await ports.diagnostic(reason, { reportPath: path, bytes: Buffer.from(snapshot), reason });
    },
    finishNoReport: async () => {},
  });
  if (outcome.kind === 'superseded' && content && !await sameReportBytes(path, bytes, content, ports)) return readRetryReport(request, ports);
  if (outcome.kind === 'configuration-error') throw new Error(`Invalid report confirmation budget at ${outcome.pointer}`);
  return outcome.kind === 'accepted' && !ports.acceptResult ? result : null;
}
async function readReportSnapshot(request: AgentReportRequest, ports: PendingAgentReportPorts): Promise<AgentReportResult | null> {
  const component = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
  if (!isAbsolute(request.tmpRoot) || !component(request.runId) || !component(request.address)) throw new Error('Invalid report directory, run ID or address');
  const path = join(request.tmpRoot, request.runId, `${request.address}.json`);
  let bytes: Uint8Array | null = null;
  const diagnostic = (reason: string) => {
    const message = reportDiagnosticText(request, reason);
    return ports.diagnostic(message, { reportPath: path, bytes, reason: message });
  };
  const issueText = (issues: AssignmentVerification['issues']) => issues.map(issue => `${issue.requestedItems.map(id => `${issue.change}:${id}`).join(', ')}: ${issue.reason}\nActual items: ${JSON.stringify(issue.foundItems.filter(item => issue.requestedItems.includes(item.id)))}\nArchives: ${JSON.stringify(issue.archives)}\nRemedy: ${issue.remedy}`).join('\n');
  let content: string | null;
  try {
    if (ports.fs.readBytes) {
      const raw = await ports.fs.readBytes(path);
      bytes = raw === null ? null : Uint8Array.from(raw);
      content = bytes === null ? null : Buffer.from(bytes).toString('utf8');
    } else {
      content = await ports.fs.readText(path);
      bytes = content === null ? null : Buffer.from(content, 'utf8');
    }
  }
  catch (error) { await diagnostic(`Cannot read report: ${String(error)}`); return null; }
  if (content === null) return null;
  let report: unknown;
  try { report = JSON.parse(content); }
  catch { await diagnostic('Incomplete or invalid report JSON'); return null; }
  if (!validAgentReport(report, request.assignment, request)) { await diagnostic(agentReportIssues(report, request.assignment, request).join('\n')); return null; }
  const archives = Object.fromEntries(report.changes.filter(change => change.archive !== undefined).map(change => [change.id, change.archive!]));
  if (request.reportedCommits) {
    try { await verifyCurrentReport(request, path, ports); }
    catch (error) { if (confirmationTransient(error)) throw error; await diagnostic(`Report run verification failed (${request.runId}): ${String(error)}`); return null; }
  }
  let checkboxCommits: readonly TaskCheckboxCommit[] | undefined;
  if (report.status === 'succeeded') {
    let verification: AssignmentVerification;
    try {
      if (ports.confirmTaskCheckboxes) {
        const confirmation = await ports.confirmTaskCheckboxes(request, report);
        checkboxCommits = confirmation.commits;
        if (!confirmation.ok) {
          await diagnostic(`Task checkbox confirmation failed: ${issueText(confirmation.issues)}`);
          return null;
        }
      }
      verification = await ports.verifyAssignmentCompletion(request.assignment, archives);
    }
    catch (error) { if (confirmationTransient(error)) throw error; await diagnostic(`Assignment verification failed: ${String(error)}`); return null; }
    if (!verification.ok) { await diagnostic(`Assignment completion is not confirmed: ${issueText(verification.issues)}`); return null; }
  }
  if (request.reportedCommits) {
    try {
      await verifyCurrentReport(request, path, ports);
      if (!await sameReportBytes(path, bytes!, content, ports)) { await diagnostic('Report snapshot changed during acceptance; retry the complete report'); return null; }
    } catch (error) { await diagnostic(`Report final verification failed: ${String(error)}`); return null; }
  }
  const result: AgentReportResult = { runId: request.runId, id: request.address, event: reportEvent(request, report.status), status: report.status, at: ports.now(), report, ...(checkboxCommits ? { checkboxCommits } : {}) };
  verifiedSnapshots.set(result, { request, content, bytes: bytes!, result: JSON.stringify(result) });
  return result;
}
export async function createAgentReportWatcher(request: AgentReportRequest, ports: AgentReportPorts): Promise<AgentReportWatcher> {
  const delivered = new Set<string>();
  const diagnostic = ports.diagnostic;
  ports = { ...ports, diagnostic: async (reason, snapshot) => {
    const key = snapshot ? JSON.stringify([snapshot.reportPath, snapshot.bytes === null ? null : Buffer.from(snapshot.bytes).toString('base64'), snapshot.reason]) : undefined;
    if (key && delivered.has(key)) return;
    await diagnostic(reason, snapshot);
    if (key) delivered.add(key);
  } };
  const component = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
  if (!isAbsolute(request.tmpRoot) || !component(request.runId) || !component(request.address)) throw new Error('Invalid report directory, run ID or address');
  const directory = join(request.tmpRoot, request.runId);
  const filename = `${request.address}.json`;
  const path = join(directory, filename);
  await ports.fs.mkdir(directory);
  let accepted = false;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let unwatch = () => {};
  let unsubscribe = () => {};
  const serial = (operation: () => Promise<void>) => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const publish = async (result: AgentReportResult) => {
    try {
      await ports.result(result);
      accepted = true;
    } catch (error) {
      if (!result.report) throw error;
      await rejectPendingAgentReport(request, result, ports, error instanceof Error ? error.message : String(error));
    }
  };
  const read = async () => {
    if (accepted || closed) return;
    const result = await readPendingAgentReport(request, ports.confirmationRetry ? { ...ports, acceptResult: async result => { await ports.acceptResult?.(result); await ports.result(result); accepted = true; } } : ports);
    if (result) await publish(result);
  };
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try { unwatch(); } finally { try { unsubscribe(); } finally { await ports.fs.removeTree(directory); } }
  };
  const finish = (exit: AgentReportExit) => serial(async () => {
    if (closed) return;
    await read();
    if (!accepted) await publish({ runId: request.runId, id: request.address, event: 'agent.failed', status: 'failed', at: ports.now(), exit });
    await cleanup();
  });
  try {
    unwatch = ports.watch(directory, async (_event, changed) => {
      if (changed === filename || changed === path) await serial(read);
    });
    unsubscribe = ports.process.onExit(finish);
    await serial(read);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { path, finish, dispose: () => serial(cleanup) };
}
