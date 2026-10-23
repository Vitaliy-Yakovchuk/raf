export type DiagnosticTestId = { file: string; name: string };
export type DiagnosticLocation = { file: string; line: number | null; column: number | null };
export type DiagnosticOrigin = 'test-body' | 'import' | 'collection' | 'hook' | 'fixture-setup' | 'unknown';
export type DiagnosticKind = 'assertion' | 'test-failure' | 'setup' | 'protocol' | 'runner' | 'preflight';
export type DiagnosticLimits = {
  maxEntries: number;
  maxMessageBytes: number;
  maxStackFrames: number;
  maxStackBytes: number;
  maxTotalBytes: number;
  maxProtocolLineBytes: number;
  maxStderrBytes: number;
  redactionPatterns: string[];
};
export type DiagnosticPaths = { workspace: string; qaHome: string; fixtureRoots: string[] };
export type DiagnosticFailure = {
  test: DiagnosticTestId | null;
  origin: DiagnosticOrigin;
  error: unknown;
  location?: DiagnosticLocation | null;
};
export type NodeDiagnosticEvent = {
  type: 'test:fail';
  data: {
    file?: string;
    name?: string;
    line?: number;
    column?: number;
    details: { error?: unknown; diagnosticOrigin?: DiagnosticOrigin };
  };
};
export type InlineDiagnostic = {
  kind: DiagnosticKind;
  test: DiagnosticTestId | null;
  errorName?: string;
  errorCode?: string;
  message: string;
  location: DiagnosticLocation | null;
  stack: string[];
  redacted: boolean;
  truncated: boolean;
  unavailableReason?: string;
};
export type DiagnosticSummary = {
  totalEntries: number;
  retainedEntries: number;
  omittedEntries: number;
  truncated: boolean;
  redacted: boolean;
};
export type DiagnosticEnvironmentInput = {
  executable: string;
  runtimeVersion: string;
  adapter: string;
  isolation: string;
  configurationBytes: { flow: Uint8Array; testRuns: Uint8Array; projects: Uint8Array };
  tmpPath: string;
  privateRunTmp: boolean;
};
export type DiagnosticEnvironmentSummary = {
  executable: string;
  runtimeVersion: string;
  adapter: string;
  isolation: string;
  configurationFingerprints: { flow: string; testRuns: string; projects: string };
  tmpPathBytes: number;
  privateRunTmp: boolean;
};
export type DiagnosticRunFacts = {
  runId: string;
  outcome: string;
  failureKinds: string[];
  knownRed: DiagnosticTestId[];
  unexecuted: DiagnosticTestId[];
  unknown: DiagnosticTestId[];
  timeoutCount: number;
  timedOut: boolean;
  cleanup: string;
  evidence: string[];
};
export type DiagnosticAttachment = {
  diagnostics: InlineDiagnostic[];
  diagnosticSummary: DiagnosticSummary;
  environmentSummary: DiagnosticEnvironmentSummary;
};
export type DiagnosticReadState = {
  protocolBufferedBytes: number;
  stderrBufferedBytes: number;
  protocolRejected: boolean;
  stderrTruncated: boolean;
};
export type DiagnosticDisposition = { failureKind: 'assertions' | 'setup' | null; knownRed: DiagnosticTestId | null };

export function validateDiagnosticLimits(value: unknown): DiagnosticLimits {
  throw new Error('NotImplemented');
}

export function diagnosticFailureFromNodeEvent(event: NodeDiagnosticEvent): DiagnosticFailure | null {
  throw new Error('NotImplemented');
}

export function buildDiagnosticEnvironment(input: DiagnosticEnvironmentInput): DiagnosticEnvironmentSummary {
  throw new Error('NotImplemented');
}

export class TestRunDiagnostics {
  constructor(limits: DiagnosticLimits, paths: DiagnosticPaths) {
    throw new Error('NotImplemented');
  }

  failure(input: DiagnosticFailure): DiagnosticDisposition {
    throw new Error('NotImplemented');
  }

  preflight(error: unknown): void {
    throw new Error('NotImplemented');
  }

  protocolChunk(chunk: Uint8Array): void {
    throw new Error('NotImplemented');
  }

  stderrChunk(chunk: Uint8Array): void {
    throw new Error('NotImplemented');
  }

  childExit(input: { exitCode: number | null; signal: string | null; validProtocol: boolean }): void {
    throw new Error('NotImplemented');
  }

  recoveredDetailsUnavailable(reason: string): void {
    throw new Error('NotImplemented');
  }

  readState(): DiagnosticReadState {
    throw new Error('NotImplemented');
  }

  attach<T extends DiagnosticRunFacts>(facts: T, environment: DiagnosticEnvironmentSummary): T & DiagnosticAttachment {
    throw new Error('NotImplemented');
  }
}

export type DiagnosticDeliveryPorts<T> = {
  emitTransport: (result: T) => Promise<void>;
  replaceLastAggregateResult: (result: T) => Promise<void>;
};

export async function deliverDiagnosticResult<T extends DiagnosticRunFacts & DiagnosticAttachment>(
  result: T,
  ports: DiagnosticDeliveryPorts<T>,
): Promise<void> {
  throw new Error('NotImplemented');
}

export type RunTemporaryConfiguration = { root: string; minimumNestedSocketPathBytes: number };
export type RunTemporaryIdentity = { path: string; realpath: string; device: string; inode: string; uid: number; mode: number; symlink: boolean; runId?: string };
export type RunTemporaryReservation = { runId: string; temporary: RunTemporaryIdentity };
export type RunTemporaryContext = {
  runId: string;
  uid: number;
  qaHome: string;
  statePath: string;
  stateTmpPath: string;
  workspace: string;
  workingStatePath: string;
};
export type RunTemporaryPorts = {
  socketPathCapacityBytes: () => number;
  inspect: (path: string) => Promise<RunTemporaryIdentity | null>;
  createPrivateDirectory: (root: string, runId: string) => Promise<RunTemporaryIdentity>;
  saveReservation: (reservation: RunTemporaryReservation) => Promise<void>;
  removeOwnedDirectory: (identity: RunTemporaryIdentity) => Promise<void>;
};
export type PreparedRunTemporary = {
  reservation: RunTemporaryReservation;
  environment: { HOME: string; RAF_QA_HOME: string; TMPDIR: string };
  statePath: string;
  stateTmpPath: string;
};
export function validateRunTemporaryConfiguration(value: unknown): RunTemporaryConfiguration {
  throw new Error('NotImplemented');
}

export async function prepareRunTemporaryDirectory(
  configuration: RunTemporaryConfiguration,
  context: RunTemporaryContext,
  ports: RunTemporaryPorts,
): Promise<PreparedRunTemporary> {
  throw new Error('NotImplemented');
}

export async function cleanupRunTemporaryDirectory(
  reservation: RunTemporaryReservation,
  treeTerminated: boolean,
  ports: RunTemporaryPorts,
): Promise<{ cleanup: 'complete' | 'incomplete'; diagnostic: InlineDiagnostic | null }> {
  throw new Error('NotImplemented');
}
