import type { TestRunCliPorts } from './test-run-cli.ts';
import type { TestRunConfig, TestRunGroupKey } from './test-runs.ts';

export interface SandboxProcessIdentity {
  readonly pid: number;
  readonly startedAt: string;
}

export interface SandboxTestAssignment {
  readonly runId: string;
  readonly agentId: string;
  readonly type: string;
  readonly phase: string;
  readonly project: string;
  readonly workspace: string;
  readonly branch: string;
  readonly changes: readonly string[];
  readonly delegatedByMain?: boolean;
}

export interface SandboxTestSession {
  readonly process: SandboxProcessIdentity;
  readonly state: 'running' | 'finished';
  readonly assignment: SandboxTestAssignment;
}

export interface SandboxTestControlSnapshot {
  readonly ancestors: readonly SandboxProcessIdentity[];
  readonly sessions: readonly SandboxTestSession[];
  readonly workspaces: readonly {
    readonly project: string;
    readonly workspace: string;
    readonly branch: string;
    readonly actualBranch: string;
  }[];
  readonly activeChanges: readonly string[];
  readonly groups: readonly TestRunGroupKey[];
}

export interface SandboxCommandRequest {
  readonly command: string;
  readonly cwd: string;
}

export interface SandboxCommandReply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SandboxUnitContext = Omit<TestRunCliPorts, 'stdout' | 'stderr'>;

export interface SandboxTestRunPorts {
  readonly caller: SandboxProcessIdentity;
  readonly entrypoint: readonly string[];
  control(caller: SandboxProcessIdentity): Promise<SandboxTestControlSnapshot>;
  unitContext(key: TestRunGroupKey): Promise<SandboxUnitContext>;
  communicate(argv: readonly string[], caller: SandboxTestAssignment): Promise<SandboxCommandReply>;
}

export interface SandboxRafCommandAccess {
  readonly raf_command: string;
  readonly raf_subcommands: readonly string[];
  readonly hostCommands: readonly string[];
}

export interface SandboxTestRunEvidence {
  readonly command: string;
  readonly workspace: string;
  readonly sha: string;
  readonly dirtyPaths: readonly string[];
  readonly artifact: string;
  readonly reply: SandboxCommandReply | null;
  readonly transportError?: string;
}

export async function runSandboxTestCommand(
  request: SandboxCommandRequest,
  ports: SandboxTestRunPorts,
): Promise<SandboxCommandReply> {
  throw new Error('NotImplemented');
}

export function sandboxRafCommandAccess(
  assignment: SandboxTestAssignment,
  runner: 'codex' | 'claude',
  entrypoint: readonly string[],
  phases: TestRunConfig['phases'],
): SandboxRafCommandAccess {
  throw new Error('NotImplemented');
}

export function formatSandboxTestRunEvidence(evidence: SandboxTestRunEvidence): string {
  throw new Error('NotImplemented');
}
