import type { ChildExit, RunnerClassification, TestId, TestRunCommand, TestRunPlan, TestRunProfile, UnitTestPolicy } from './test-runs.ts';
import type { DiagnosticAttachment, DiagnosticLimits, DiagnosticOrigin, DiagnosticPaths } from './test-run-diagnostics.ts';

export type EtchlyTestRunProfile = Omit<TestRunProfile, 'exactIds' | 'resultAdapter'> & {
  exactIds: 'node-test-name' | 'vitest-test-name' | null;
  resultAdapter: 'node-test-events' | 'vitest-events';
};

export interface EtchlyInventoryFact {
  file: string;
  profileId: string | null;
  classification: string;
}

export interface EtchlyInventorySnapshot {
  profiles: Record<string, readonly string[]>;
  sourceHashes: Record<string, string>;
}

export interface EtchlyEnvironmentFacts {
  workspace: string;
  branch: string;
  expectedLibrary: string;
  actualLibrary: string | null;
  libraryBranch: string | null;
  nodeAvailable: boolean;
  vitestAvailable: boolean;
  adapterCompatible: boolean;
  preloadAvailable: boolean;
  aliasesAvailable: boolean;
  configAvailable: boolean;
  happyDomRequired: boolean;
  happyDomAvailable: boolean;
  isolatedHome: boolean;
  stateOrigin: boolean;
  privateTmpWritable: boolean;
  browserRequired: boolean;
  trustedBrowserCache: string | null;
  requestedBrowserCache: string | null;
  browserAvailable: boolean;
}

export interface EtchlyPreparedEnvironment {
  HOME: string;
  TMPDIR: string;
  PLAYWRIGHT_BROWSERS_PATH?: string;
}

export type VitestLifecycleEvent =
  | { kind: 'collected'; tests: TestId[] }
  | { kind: 'started' | 'passed'; test: TestId }
  | { kind: 'failed'; test: TestId | null; origin: DiagnosticOrigin; error: unknown }
  | { kind: 'skipped'; test: TestId; reason: 'declared' | 'first-failure' }
  | { kind: 'finished' }
  | { kind: 'protocol-error'; message: string };

export type VitestClassification = RunnerClassification & Pick<DiagnosticAttachment, 'diagnostics' | 'diagnosticSummary'>;

export function auditEtchlyInventory(
  configured: EtchlyInventorySnapshot,
  observed: readonly EtchlyInventoryFact[],
  currentSourceHashes: Readonly<Record<string, string>>,
): void {
  throw new Error('NotImplemented');
}

export function prepareEtchlyEnvironment(
  facts: EtchlyEnvironmentFacts,
  privatePaths: { home: string; tmp: string },
): EtchlyPreparedEnvironment {
  throw new Error('NotImplemented');
}

export function planVitestInvocations(
  plan: TestRunPlan,
  profile: EtchlyTestRunProfile,
  policy: UnitTestPolicy,
  trustedReporter: string,
  knownRed: readonly TestId[],
): TestRunCommand[] {
  throw new Error('NotImplemented');
}

export function classifyVitestResult(
  events: readonly VitestLifecycleEvent[],
  exit: ChildExit,
  profileCwd: string,
  limits: DiagnosticLimits,
  paths: DiagnosticPaths,
): VitestClassification {
  throw new Error('NotImplemented');
}
