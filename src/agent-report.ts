import { isAbsolute, join } from 'node:path';
import type { AssignmentSnapshot, AssignmentVerification } from './assignment.ts';

export type AgentReportStatus = 'succeeded' | 'failed';
export interface AgentReport {
  readonly status: AgentReportStatus;
  readonly answer: string;
  readonly changes: readonly {
    readonly id: string;
    readonly items: readonly { readonly id: string; readonly status: AgentReportStatus; readonly reason?: string }[];
    readonly archive?: string;
  }[];
  readonly [extra: string]: unknown;
}
export interface AgentReportRequest {
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
}
export interface AgentReportPorts {
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
  diagnostic(reason: string, verification?: AssignmentVerification): Promise<void>;
}
export interface AgentReportWatcher {
  readonly path: string;
  finish(exit: AgentReportExit): Promise<void>;
  dispose(): Promise<void>;
}
export type PendingAgentReportPorts = Pick<AgentReportPorts, 'now' | 'verifyAssignmentCompletion' | 'diagnostic'> & { readonly fs: Pick<AgentReportPorts['fs'], 'readText'> };
export async function readPendingAgentReport(request: AgentReportRequest, ports: PendingAgentReportPorts): Promise<AgentReportResult | null> {
  const component = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
  if (!isAbsolute(request.tmpRoot) || !component(request.runId) || !component(request.address)) throw new Error('Invalid report directory, run ID or address');
  const path = join(request.tmpRoot, request.runId, `${request.address}.json`);
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const status = (value: unknown) => value === 'succeeded' || value === 'failed';
  const valid = (value: unknown): value is AgentReport => {
    if (!record(value) || !status(value.status) || typeof value.answer !== 'string' || !Array.isArray(value.changes) || value.changes.length !== request.assignment.changes.length) return false;
    const changes = new Set<string>();
    for (const change of value.changes) {
      if (!record(change) || typeof change.id !== 'string' || changes.has(change.id) || !Array.isArray(change.items) || (change.archive !== undefined && (typeof change.archive !== 'string' || !change.archive))) return false;
      changes.add(change.id);
      const assigned = request.assignment.changes.find(row => row.id === change.id);
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
  let content: string | null;
  try { content = await ports.fs.readText(path); }
  catch (error) { await ports.diagnostic(`Cannot read report: ${String(error)}`); return null; }
  if (content === null) return null;
  let report: unknown;
  try { report = JSON.parse(content); }
  catch { await ports.diagnostic('Incomplete or invalid report JSON'); return null; }
  if (!valid(report)) { await ports.diagnostic('Invalid report or assignment mismatch'); return null; }
  if (report.status === 'succeeded') {
    let verification: AssignmentVerification;
    try { verification = await ports.verifyAssignmentCompletion(request.assignment, Object.fromEntries(report.changes.filter(change => change.archive !== undefined).map(change => [change.id, change.archive!]))); }
    catch (error) { await ports.diagnostic(`Assignment verification failed: ${String(error)}`); return null; }
    if (!verification.ok) { await ports.diagnostic('Assignment completion is not confirmed', verification); return null; }
  }
  return { runId: request.runId, id: request.address, event: report.status === 'succeeded' ? 'agent.succeeded' : 'agent.failed', status: report.status, at: ports.now(), report };
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
