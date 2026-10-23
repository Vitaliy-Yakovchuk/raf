import { validStartupContextAssessment, type StartupContextAssessment } from './startup-context.ts';
import { isAbsolute, join } from 'node:path';
import type { AssignmentSnapshot, AssignmentVerification } from './assignment.ts';
import type { TaskCheckboxCommit, TaskCheckboxReportPort } from './task-checkbox-report.ts';
import type { ReportedCommit, ReportedCommitRequestContext, ReportedCommitAcceptancePorts } from './reported-commits-contract.ts';
import { validReportedCommits, validateReportedCommitGroups } from './reported-commits.ts';

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
export interface AgentReportRequest extends ReportedCommitRequestContext {
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
export interface AgentReportPorts extends Partial<TaskCheckboxReportPort>, Partial<ReportedCommitAcceptancePorts> {
  readonly fs: {
    mkdir(path: string): Promise<void>;
    readText(path: string): Promise<string | null>;
    removeTree(path: string): Promise<void>;
  };
  watch(directory: string, listener: (event: 'create' | 'modify' | 'rename', filename: string) => Promise<void>): () => void;
  readonly process: { onExit(listener: (exit: AgentReportExit) => Promise<void>): () => void };
  now(): string;
  verifyAssignmentCompletion(snapshot: AssignmentSnapshot, archiveClaims: Readonly<Record<string, string>>): Promise<AssignmentVerification>;
  result(result: AgentReportResult): Promise<void>;
  diagnostic(reason: string): Promise<void>;
}
export interface AgentReportWatcher {
  readonly path: string;
  finish(exit: AgentReportExit): Promise<void>;
  dispose(): Promise<void>;
}
export type PendingAgentReportPorts = Pick<AgentReportPorts, 'now' | 'verifyAssignmentCompletion' | 'diagnostic' | 'confirmTaskCheckboxes' | keyof ReportedCommitAcceptancePorts> & { readonly fs: Pick<AgentReportPorts['fs'], 'readText'> };
export function validAgentReport(value: unknown, assignment: AssignmentSnapshot, context?: ReportedCommitRequestContext): value is AgentReport {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const status = (value: unknown) => value === 'succeeded' || value === 'failed';
  const valid = (value: unknown): value is AgentReport => {
    if (!record(value) || !status(value.status) || typeof value.answer !== 'string' || !Array.isArray(value.changes) || value.changes.length !== assignment.changes.length) return false;
    if (value.context !== undefined && !validStartupContextAssessment(value.context)) return false;
    if (context?.reportedCommits && !validReportedCommits(value.commits)) return false;
    const changes = new Set<string>();
    for (const change of value.changes) {
      if (!record(change) || typeof change.id !== 'string' || changes.has(change.id) || !Array.isArray(change.items) || (change.archive !== undefined && (typeof change.archive !== 'string' || !change.archive))) return false;
      changes.add(change.id);
      const assigned = assignment.changes.find(row => row.id === change.id);
      if (!assigned || assigned.items.length !== change.items.length) return false;
      const items = new Set<string>();
      for (const item of change.items) {
        if (!record(item) || typeof item.id !== 'string' || items.has(item.id) || !assigned.items.some(row => row.id === item.id) || !status(item.status)) return false;
        if (item.reason !== undefined && typeof item.reason !== 'string') return false;
        if (item.status === 'failed' && (typeof item.reason !== 'string' || !item.reason.trim())) return false;
        if (value.status === 'succeeded' && item.status !== 'succeeded') return false;
        items.add(item.id);
      }
    }
    return true;
  };
  return valid(value);
}
const acceptanceQueues = new Map<string, Promise<unknown>>();
const verifiedSnapshots = new WeakMap<AgentReportResult, { request: AgentReportRequest; content: string; result: string }>();
async function verifyCurrentReport(request: AgentReportRequest, path: string, ports: PendingAgentReportPorts): Promise<void> {
  if (request.reportedCommits?.runId !== request.runId || request.reportedCommits.reportPath !== path
    || !ports.isCurrentReport || !await ports.isCurrentReport(request.runId, path)) throw new Error('Reported commits do not match the current run/report path');
}
export async function verifyPendingAgentReportFreshness(request: AgentReportRequest, result: AgentReportResult, ports: PendingAgentReportPorts): Promise<void> {
  const snapshot = verifiedSnapshots.get(result);
  if (!snapshot || snapshot.request !== request || snapshot.result !== JSON.stringify(result)) throw new Error('Report has no verified snapshot in this process');
  const path = join(request.tmpRoot, request.runId, `${request.address}.json`);
  if (await ports.fs.readText(path) !== snapshot.content) throw new Error('Report snapshot changed before durable worker acceptance; retry the complete report');
  await verifyCurrentReport(request, path, ports);
  if (!ports.readTaskCheckboxCommits) throw new Error('Reported commit acceptance ports are unavailable');
  await validateReportedCommitGroups(request.reportedCommits!, result.report!.commits!, await ports.readTaskCheckboxCommits(request.runId));
}
export async function readPendingAgentReport(request: AgentReportRequest, ports: PendingAgentReportPorts): Promise<AgentReportResult | null> {
  const key = request.assignment.root;
  const previous = acceptanceQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => readReportSnapshot(request, ports));
  acceptanceQueues.set(key, next);
  try { return await next; } finally { if (acceptanceQueues.get(key) === next) acceptanceQueues.delete(key); }
}
async function readReportSnapshot(request: AgentReportRequest, ports: PendingAgentReportPorts): Promise<AgentReportResult | null> {
  const component = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
  if (!isAbsolute(request.tmpRoot) || !component(request.runId) || !component(request.address)) throw new Error('Invalid report directory, run ID or address');
  const path = join(request.tmpRoot, request.runId, `${request.address}.json`);
  const diagnostic = (reason: string) => ports.diagnostic(`Agent: ${request.address}\nItems: ${request.assignment.changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)).join(', ')}\nReport: ${path}\nReason: ${reason}`);
  const concise = (reason: string) => reason.replace(/\s+/g, ' ').slice(0, 512);
  let content: string | null;
  try { content = await ports.fs.readText(path); }
  catch (error) { await diagnostic(`Cannot read report: ${concise(String(error))}`); return null; }
  if (content === null) return null;
  let report: unknown;
  try { report = JSON.parse(content); }
  catch { await diagnostic('Incomplete or invalid report JSON'); return null; }
  if (!validAgentReport(report, request.assignment, request)) { await diagnostic('Invalid report or assignment mismatch'); return null; }
  const archives = Object.fromEntries(report.changes.filter(change => change.archive !== undefined).map(change => [change.id, change.archive!]));
  let verifiedSource: AssignmentVerification | undefined;
  if (request.reportedCommits) {
    try {
      await verifyCurrentReport(request, path, ports);
      verifiedSource = await ports.verifyAssignmentSourceIdentity?.(request.assignment, archives);
      if (!verifiedSource?.ok) throw new Error('Assignment source identity changed or is unavailable');
      if (!ports.readTaskCheckboxCommits || !ports.reconcileReportedCommitIndex) throw new Error('Reported commit acceptance ports are unavailable');
      const checkbox = await ports.readTaskCheckboxCommits(request.runId);
      const groups = await validateReportedCommitGroups(request.reportedCommits, report.commits!, checkbox);
      for (const group of groups) {
        await verifyCurrentReport(request, path, ports);
        await validateReportedCommitGroups(request.reportedCommits, report.commits!, await ports.readTaskCheckboxCommits(request.runId));
        await ports.reconcileReportedCommitIndex(group);
      }
    } catch (error) { await diagnostic(`Reported commit validation/repair failed (${request.runId}): ${concise(String(error))}`); return null; }
  }
  let checkboxCommits: readonly TaskCheckboxCommit[] | undefined;
  if (report.status === 'succeeded') {
    let verification: AssignmentVerification;
    try {
      if (ports.confirmTaskCheckboxes) {
        const confirmation = await ports.confirmTaskCheckboxes(request, report, verifiedSource);
        checkboxCommits = confirmation.commits;
        if (!confirmation.ok || confirmation.awaitingArchive) {
          await diagnostic(confirmation.awaitingArchive ? 'Awaiting executor sync/archive and an exact archive claim in the same report' : `Task checkbox confirmation failed: ${confirmation.issues.map(issue => concise(issue.reason)).join('; ')}`);
          return null;
        }
      }
      verification = await ports.verifyAssignmentCompletion(request.assignment, archives);
    }
    catch (error) { await diagnostic(`Assignment verification failed: ${concise(String(error))}`); return null; }
    if (!verification.ok) { await diagnostic(`Assignment completion is not confirmed: ${[...new Set(verification.issues.map(issue => concise(issue.reason)))].join('; ')}`); return null; }
  }
  if (request.reportedCommits) {
    try {
      await verifyCurrentReport(request, path, ports);
      if (await ports.fs.readText(path) !== content) { await diagnostic('Report snapshot changed during acceptance; retry the complete report'); return null; }
      await validateReportedCommitGroups(request.reportedCommits, report.commits!, await ports.readTaskCheckboxCommits!(request.runId));
    } catch (error) { await diagnostic(`Report final verification failed: ${concise(String(error))}`); return null; }
  }
  const result: AgentReportResult = { runId: request.runId, id: request.address, event: report.status === 'succeeded' ? 'agent.succeeded' : 'agent.failed', status: report.status, at: ports.now(), report, ...(checkboxCommits ? { checkboxCommits } : {}) };
  if (request.reportedCommits) verifiedSnapshots.set(result, { request, content, result: JSON.stringify(result) });
  return result;
}
export async function createAgentReportWatcher(request: AgentReportRequest, ports: AgentReportPorts): Promise<AgentReportWatcher> {
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
    await ports.result(result);
    accepted = true;
  };
  const read = async () => {
    if (accepted || closed) return;
    const result = await readPendingAgentReport(request, ports);
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
