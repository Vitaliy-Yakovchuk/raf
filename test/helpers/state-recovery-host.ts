import type { RecoveryGroup, RecoveryInFlight, StateRecoveryResult } from '../../src/test-run-state-recovery.ts';

export type HostCommand = {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};
export type HostIdentity = { pid: number; start: string; boot: string };
export type HostSnapshot = {
  group: RecoveryGroup;
  originalRun: RecoveryInFlight;
  controlStatePath: string;
  unitStatePath: string;
  wrapper: HostIdentity;
  tree: HostIdentity[];
  caller: { agentId: string; runId: string; identity: HostIdentity };
  generation: string;
  sha: string;
  dirtyPaths: string[];
  spawnCount: number;
  releaseCount: number;
};
export type HostExecution = {
  result: StateRecoveryResult;
  stderr: string;
  cliCode: number;
  argv: string[];
  cwd: string;
};
export type HostCheckpoint = {
  name: 'after-spawn' | 'before-commit' | 'after-commit-before-delivery';
  runId: string;
  atMs: number;
};
export type StateRecoveryHost = {
  command: HostCommand;
  deadlineMs: number;
  home: string;
  root: string;
  checkpointPath: string;
  childReleasePath: string;
  evidencePath: string;
  snapshot(): Promise<HostSnapshot>;
  reconcile(): Promise<HostExecution>;
  normal(mode: 'passed' | 'refused'): Promise<HostExecution>;
  restartRecipient(): Promise<void>;
  cleanupClosedChange(): Promise<void>;
  setMainAvailability(availability: 'unavailable' | 'accepted' | 'forwarded'): Promise<void>;
  markExitTimeUnknown(): Promise<void>;
  awaitTreeExit(): Promise<void>;
  awaitOriginalDeadline(): Promise<void>;
  finish(): Promise<{ remainingOwned: HostIdentity[]; operationalStateOpened: boolean }>;
};
export async function prepareStateRecoveryHost(input: {
  root: string;
  testKind: 'unit' | 'integration';
  checkpoint: HostCheckpoint['name'];
  child: 'early-exit' | 'alive-through-deadline';
  initialTimeoutCount: 1;
}): Promise<StateRecoveryHost> {
  throw new Error('NotImplemented');
}
