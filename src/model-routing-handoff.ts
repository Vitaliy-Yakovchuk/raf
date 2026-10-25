import type { AdapterObservation } from './agent-adapters.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import type { ModelCatalog, ModelRequest, ModelSelection, RoutingSnapshot } from './model-routing.ts';
import { selectModel } from './model-routing.ts';
import type { ProcessObservation, SessionRecord } from './session-state.ts';

export type ModelHandoffObservation = AdapterObservation & { quotaPool?: string };

export interface ModelHandoffRequest {
  session: SessionRecord;
  signal: { runId: string; observation: ModelHandoffObservation };
  ownerAction: 'continue' | 'paused' | 'stopped';
  startupCleanup?: { retrySafe: boolean; pending: readonly string[] };
}

export interface ModelHandoffReportCheck {
  runId: string;
  status: 'succeeded' | 'failed' | 'missing' | 'rejected' | 'pending';
  reason: string;
}

export interface ModelHandoffLaunch {
  predecessorRunId: string;
  causeModel?: string;
  assignment: AssignmentSnapshot;
  selection: Extract<ModelSelection, { status: 'selected' }>;
  evidence: readonly string[];
  cause: ModelHandoffObservation;
}

export interface ModelHandoffPorts {
  currentSession(addressId: string): Promise<SessionRecord | null>;
  inspect(session: SessionRecord): Promise<ProcessObservation>;
  checkFinalReport(session: SessionRecord): Promise<ModelHandoffReportCheck>;
  finalize(session: SessionRecord): Promise<{ finalized: boolean; claimsReleased: boolean; reason: string }>;
  readCurrentWork(session: SessionRecord): Promise<
    | { status: 'ready'; assignment: AssignmentSnapshot; request: ModelRequest; evidence: readonly string[] }
    | { status: 'changed'; reason: string }
  >;
  readRouting(): Promise<{ catalog: ModelCatalog; snapshot: RoutingSnapshot }>;
  launchNew(input: ModelHandoffLaunch): Promise<
    | { status: 'started'; session: SessionRecord }
    | { status: 'blocked'; reason: string }
  >;
}

export type ModelHandoffResult =
  | { status: 'ignored' | 'waiting' | 'complete'; predecessorRunId: string; reason: string }
  | { status: 'started'; predecessorRunId: string; session: SessionRecord; reason: string };

export async function handoffModelRun(request: ModelHandoffRequest, ports: ModelHandoffPorts): Promise<ModelHandoffResult> {
  const { session, signal } = request;
  const result = (status: 'ignored' | 'waiting' | 'complete', reason: string): ModelHandoffResult => ({ status, predecessorRunId: session.runId, reason });
  if (signal.runId !== session.runId) return result('ignored', 'Observation belongs to another runId');
  if (session.addressId === 'main' || session.activity?.type === 'main') return result('ignored', 'Main lifecycle cannot be handed off');
  if (request.ownerAction !== 'continue') return result('ignored', `Owner ${request.ownerAction} execution`);
  if (signal.observation.status === 'starting' || signal.observation.status === 'ready') return result('ignored', 'Runner has not reported a terminal failure or exit');
  const cause = signal.observation.status === 'exited'
    ? `Runner exited with code ${signal.observation.exitCode ?? 'unknown'}` : signal.observation.reason;
  try {
    const current = await ports.currentSession(session.addressId);
    if (!current || current.runId !== session.runId) return result('ignored', 'Address no longer belongs to the observed runId');
    const report = await ports.checkFinalReport(session);
    if (report.runId !== session.runId) return result('waiting', 'Final report identity does not match the predecessor runId');
    if (report.status === 'pending') return result('waiting', `Final report check pending: ${report.reason}`);
    if (current.state === 'reserved' && !current.process) {
      if (!request.startupCleanup?.retrySafe || request.startupCleanup.pending.length) return result('waiting', `Startup cleanup is not confirmed: ${cause}`);
    } else {
      const observed = await ports.inspect(current);
      if (observed.state !== 'exited') return result('waiting', observed.state === 'unknown' ? `Process exit unknown: ${observed.error}` : `Predecessor process still alive: ${cause}`);
    }
    const finalized = await ports.finalize(current);
    if (!finalized.finalized || !finalized.claimsReleased) return result('waiting', finalized.reason);
    if (report.status === 'succeeded') return result('complete', `Accepted succeeded report: ${report.reason}`);
    const work = await ports.readCurrentWork(session);
    if (work.status === 'changed') return result('waiting', work.reason);
    if (!work.assignment.changes.some(change => change.items.length)) return result('complete', 'No unfinished OpenSpec items remain');
    const { catalog, snapshot } = await ports.readRouting();
    const causeModel = session.launchContext?.selection.model ?? work.request.previousModel;
    const selection = selectModel({ ...catalog, models: catalog.models.filter(model => model.id !== causeModel) }, snapshot, { ...work.request, previousModel: causeModel });
    if (selection.status === 'waiting') return result('waiting', `${cause}; ${selection.reason}`);
    const latest = await ports.currentSession(session.addressId);
    if (!latest || latest.runId !== session.runId) return result('waiting', 'Address ownership changed before launch');
    const launched = await ports.launchNew({ predecessorRunId: session.runId, causeModel, assignment: work.assignment, selection, evidence: work.evidence, cause: signal.observation });
    if (launched.status === 'blocked') return result('waiting', launched.reason);
    if (launched.session.runId === session.runId || launched.session.launchContext?.reportPath === session.launchContext?.reportPath && session.launchContext?.reportPath !== undefined) return result('waiting', 'Successor must have a new runId and report path');
    return { status: 'started', predecessorRunId: session.runId, session: launched.session, reason: `${cause}; ${selection.reason}` };
  } catch (error) {
    return result('waiting', `${cause}; ${error instanceof Error ? error.message : String(error)}`);
  }
}
