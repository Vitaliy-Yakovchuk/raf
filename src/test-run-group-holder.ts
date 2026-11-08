import { observeReservedTestTree } from './test-run-resource-process.ts';

export interface TestRunGroupHolder {
  runId: string;
  agentId?: string | null;
  processIdentity: string | null;
  ownerIdentity?: string | null;
  wrapperIdentity?: string;
  startedAt?: string | null;
  startedAtMs?: number;
  deadlineMs: number | null;
}

export type GroupProcessState = 'alive' | 'gone' | 'unknown';
export type ObserveGroupProcess = (identity: string | null) => GroupProcessState;
export interface TestRunGroupOwner {
  runId: string;
  agentId: string | null;
  processIdentity: string | null;
  ownerIdentity: string | null;
  processState: GroupProcessState;
  startedAt: string | null;
  deadlineMs: number | null;
}

function observeGroupProcess(identity: string | null): GroupProcessState {
  const observation = observeReservedTestTree(identity);
  if (observation.state === 'dead') return 'gone';
  return observation.state;
}

export function testRunGroupInFlightError(group: string, holder: TestRunGroupHolder, observe: ObserveGroupProcess = observeGroupProcess): Error & { code: string; inFlight: TestRunGroupOwner } {
  const ownerIdentity = holder.ownerIdentity ?? holder.wrapperIdentity ?? null;
  const processState = observe(holder.processIdentity ?? ownerIdentity);
  let startedAt = holder.startedAt ?? null;
  if (!startedAt && holder.startedAtMs !== undefined) startedAt = new Date(holder.startedAtMs).toISOString();
  const inFlight: TestRunGroupOwner = {
    runId: holder.runId, agentId: holder.agentId ?? null, processIdentity: holder.processIdentity,
    ownerIdentity, processState, startedAt, deadlineMs: holder.deadlineMs,
  };
  const owner = holder.agentId ?? 'unknown agent';
  let message: string;
  if (processState === 'alive') {
    message = `Group ${group} is occupied by live run ${holder.runId}, agent ${owner}; raf verified the process on the host. Wait for it to finish, then retry the same command.`;
  } else if (processState === 'gone') {
    message = `Group ${group} run ${holder.runId}, agent ${owner}: the process is gone (verified by raf on the host); retry the same command, raf will recover the group.`;
  } else {
    message = `Group ${group} is occupied by runId ${holder.runId}, agent ${owner}; raf could not verify the process on the host. Reconcile the saved identity before retrying.`;
  }
  return Object.assign(new Error(`GROUP_IN_FLIGHT: ${message}`), { code: 'GROUP_IN_FLIGHT', inFlight });
}
