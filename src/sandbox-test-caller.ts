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
  throw new Error('NotImplemented');
}
