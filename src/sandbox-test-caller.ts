import type { SandboxProcessIdentity, SandboxTestAssignment, SandboxTestControlSnapshot } from './sandbox-test-run.ts';

export interface SandboxCallerProcess extends SandboxProcessIdentity {
  readonly parentPid: number | null;
  readonly machineId: string;
  readonly bootId: string;
  readonly originVerified: boolean;
}

export interface SandboxCallerClaim {
  readonly process: SandboxProcessIdentity & {
    readonly machineId: string;
    readonly bootId: string;
  };
  readonly state: 'running' | 'finished';
  readonly runId: string;
  readonly assignment: SandboxTestAssignment | null;
}

export interface SandboxCallerSnapshot {
  readonly caller: SandboxProcessIdentity;
  readonly machineId: string;
  readonly bootId: string;
  readonly ancestors: readonly SandboxCallerProcess[];
  readonly claims: readonly SandboxCallerClaim[];
}

export interface SandboxCallerControlSnapshot extends SandboxTestControlSnapshot {
  readonly callerEvidence: SandboxCallerSnapshot;
}

export function resolveSandboxTestCaller(snapshot: SandboxCallerSnapshot): SandboxTestAssignment {
  if (!validIdentity(snapshot.caller) || typeof snapshot.machineId !== 'string' || !snapshot.machineId || typeof snapshot.bootId !== 'string' || !snapshot.bootId || !snapshot.ancestors.length || !sameIdentity(snapshot.caller, snapshot.ancestors[0])) refuse('Unknown caller ancestry: host CLI identity is not observable');
  const seen = new Set<number>();
  for (let index = 0; index < snapshot.ancestors.length; index++) {
    const process = snapshot.ancestors[index];
    if (!validIdentity(process) || seen.has(process.pid) || index > 0 && snapshot.ancestors[index - 1].parentPid !== process.pid) refuse('Unknown caller ancestry: broken or reused parent chain');
    seen.add(process.pid);
    if (process.machineId !== snapshot.machineId || process.bootId !== snapshot.bootId) refuse('Caller machine or boot identity mismatch');
    if (process.originVerified !== true) refuse('Caller process origin is unverified');
    const claims = snapshot.claims.filter(claim => claim.process.pid === process.pid);
    if (!claims.length) continue;
    const current = claims.filter(claim => claim.state === 'running' && sameIdentity(claim.process, process) && claim.process.machineId === snapshot.machineId && claim.process.bootId === snapshot.bootId);
    if (current.length > 1) refuse('Ambiguous caller: conflicting live run claims');
    if (!current.length) {
      if (claims.some(claim => claim.state === 'running' && sameIdentity(claim.process, process) && (claim.process.machineId !== snapshot.machineId || claim.process.bootId !== snapshot.bootId))) refuse('Caller machine or boot identity mismatch');
      if (claims.some(claim => sameIdentity(claim.process, process) && claim.process.machineId === snapshot.machineId && claim.process.bootId === snapshot.bootId && claim.state === 'finished')) refuse('Nearest registered caller run is closed');
      refuse('Caller process identity mismatch: PID reused or identity unverified');
    }
    const claim = current[0];
    const assignment = claim.assignment;
    if (!assignment) refuse('Caller immutable assignment is missing');
    if (typeof claim.runId !== 'string' || !claim.runId || claim.runId !== assignment.runId) refuse('Caller runId differs from the immutable assignment');
    if (![assignment.agentId, assignment.type, assignment.phase, assignment.project, assignment.workspace, assignment.branch].every(value => typeof value === 'string' && value.length > 0) || !Array.isArray(assignment.changes) || !assignment.changes.every(value => typeof value === 'string' && value.length > 0)) refuse('Caller immutable assignment is invalid');
    return assignment;
  }
  refuse('Unknown caller ancestry: no registered live caller');
}

export class SandboxCallerRefusal extends Error {
  readonly code = 'CALLER_UNAUTHORIZED';
}

function refuse(reason: string): never { throw new SandboxCallerRefusal(reason); }
const validIdentity = (identity: SandboxProcessIdentity) => identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.startedAt === 'string' && Number.isFinite(Date.parse(identity.startedAt));
const sameIdentity = (left: SandboxProcessIdentity, right: SandboxProcessIdentity) => validIdentity(left) && validIdentity(right) && left.pid === right.pid && Date.parse(left.startedAt) === Date.parse(right.startedAt);
