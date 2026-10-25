import type { TestKind } from './test-run-integration-profiles.ts';

export type TestRunConfigurationFile =
  | 'conf/test-runs.json'
  | 'conf/projects.json'
  | 'conf/flow.json'
  | 'conf/raf-constants.json'
  | 'conf/raf.json';

export type ConfigurationValue = null | boolean | number | string | ConfigurationValue[] | { [key: string]: ConfigurationValue };

export interface TestRunConfigurationDependency {
  file: TestRunConfigurationFile;
  pointer: string;
}

export interface TestRunConfigurationScope {
  project: string;
  profileId: string;
  group: string;
  phase: string;
  testKind: TestKind;
  resourceLevel: 'normal' | 'hotfix';
  projectProfileId: string;
  agentPhaseIndex: number;
  commandIndex: number;
  runner?: string;
}

export interface TestRunConfigurationReader {
  read(file: TestRunConfigurationFile): Promise<{ text: string; revision: string }>;
  revision(file: TestRunConfigurationFile): Promise<string>;
}

export interface TestRunConfigurationSnapshot {
  version: 1;
  dependencies: (TestRunConfigurationDependency & { value: ConfigurationValue })[];
}

export type TestRunConfigurationFailure = Error & {
  code: 'CONFIGURATION_INVALID';
  changedPointers: string[];
  unreadableFiles: TestRunConfigurationFile[];
  missingPointers: string[];
  inconsistentFiles: TestRunConfigurationFile[];
};

export interface TestRunConfigurationDependencyPort {
  capture(): Promise<TestRunConfigurationSnapshot>;
  recheck(snapshot: TestRunConfigurationSnapshot, at: 'reservation' | 'spawn'): Promise<void>;
}

export function testRunConfigurationManifest(scope: TestRunConfigurationScope): TestRunConfigurationDependency[] {
  throw new Error('NotImplemented');
}

export async function captureTestRunConfiguration(
  dependencies: readonly TestRunConfigurationDependency[],
  reader: TestRunConfigurationReader,
): Promise<TestRunConfigurationSnapshot> {
  throw new Error('NotImplemented');
}

export async function assertTestRunConfigurationUnchanged(
  snapshot: TestRunConfigurationSnapshot,
  reader: TestRunConfigurationReader,
): Promise<void> {
  throw new Error('NotImplemented');
}
