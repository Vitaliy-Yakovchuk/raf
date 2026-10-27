import { isDeepStrictEqual } from 'node:util';
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
  current?(): unknown;
}

const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const address = (dependency: TestRunConfigurationDependency) => dependency.file + '#' + dependency.pointer;

export function testRunConfigurationManifest(scope: TestRunConfigurationScope): TestRunConfigurationDependency[] {
  const dependencies: TestRunConfigurationDependency[] = [];
  const add = (file: TestRunConfigurationFile, ...pointers: string[]) => {
    dependencies.push(...pointers.map(pointer => ({ file, pointer })));
  };
  const project = escape(scope.project);
  add('conf/test-runs.json', `/projects/${project}/profiles/${escape(scope.profileId)}`,
    `/projects/${project}/groups/${escape(scope.group)}`, `/phases/${escape(scope.phase)}`, '/diagnostics', '/temporaryArtifacts');
  add('conf/projects.json', ...['path', 'profile', 'branchPaths'].map(key => `/projects/${project}/${key}`),
    `/profiles/${escape(scope.projectProfileId)}`);
  add('conf/flow.json', scope.testKind === 'integration' ? '/integrationTests/timeoutMs' : '/unitTests',
    `/resources/${scope.resourceLevel}`, '/resources/home');
  add('conf/raf-constants.json', `/agentPhases/${scope.agentPhaseIndex}`, `/commands/${scope.commandIndex}`);
  add('conf/raf.json', '/resourceWait');
  if (scope.runner !== undefined) add('conf/raf.json', `/runnerProtocols/${escape(scope.runner)}`);
  return dependencies;
}

function failure(): TestRunConfigurationFailure {
  return Object.assign(new Error('Test configuration could not be verified'), {
    code: 'CONFIGURATION_INVALID' as const, changedPointers: [] as string[], unreadableFiles: [] as TestRunConfigurationFile[],
    missingPointers: [] as string[], inconsistentFiles: [] as TestRunConfigurationFile[],
  });
}

function reject(error: TestRunConfigurationFailure): void {
  if (!error.changedPointers.length && !error.unreadableFiles.length && !error.missingPointers.length && !error.inconsistentFiles.length) return;
  error.message = ['CONFIGURATION_INVALID',
    ...(['changedPointers', 'unreadableFiles', 'missingPointers', 'inconsistentFiles'] as const)
      .filter(key => error[key].length).map(key => `${key}: ${error[key].join(', ')}`)].join('; ');
  throw error;
}

function normalize(value: ConfigurationValue): ConfigurationValue {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}

function lookup(value: ConfigurationValue, pointer: string): { value: ConfigurationValue } | null {
  if (pointer === '') return { value };
  if (!pointer.startsWith('/')) return null;
  for (const token of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(token)) return null;
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return null;
    value = (value as Record<string, ConfigurationValue>)[key];
  }
  return { value };
}

async function readSnapshot(dependencies: readonly TestRunConfigurationDependency[], reader: TestRunConfigurationReader) {
  const error = failure();
  const documents = new Map<TestRunConfigurationFile, ConfigurationValue>();
  const texts = new Map<TestRunConfigurationFile, string>();
  const revisions = new Map<TestRunConfigurationFile, string>();
  const files = [...new Set(dependencies.map(dependency => dependency.file))];
  for (const file of files) {
    try {
      const read = await reader.read(file);
      documents.set(file, JSON.parse(read.text));
      texts.set(file, read.text);
      revisions.set(file, read.revision);
    } catch { error.unreadableFiles.push(file); }
  }
  for (const file of files) {
    if (!revisions.has(file)) continue;
    try { if (await reader.revision(file) !== revisions.get(file)) error.inconsistentFiles.push(file); }
    catch { error.unreadableFiles.push(file); }
  }
  const snapshot: TestRunConfigurationSnapshot = { version: 1, dependencies: [] };
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    if (seen.has(address(dependency))) continue;
    seen.add(address(dependency));
    if (!documents.has(dependency.file) || error.unreadableFiles.includes(dependency.file) || error.inconsistentFiles.includes(dependency.file)) continue;
    const found = lookup(documents.get(dependency.file)!, dependency.pointer);
    if (!found) error.missingPointers.push(address(dependency));
    else snapshot.dependencies.push({ ...dependency, value: normalize(found.value) });
  }
  return { snapshot, error, documents, texts };
}

export async function captureTestRunConfiguration(
  dependencies: readonly TestRunConfigurationDependency[],
  reader: TestRunConfigurationReader,
): Promise<TestRunConfigurationSnapshot> {
  const { snapshot, error } = await readSnapshot(dependencies, reader);
  reject(error);
  return snapshot;
}

function changed(before: ConfigurationValue, after: ConfigurationValue, pointer: string, missing: string[]): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap(key => {
      const path = `${pointer}/${escape(key)}`;
      if (!Object.hasOwn(after, key) && !Array.isArray(before)) { missing.push(path); return []; }
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) return [path];
      return changed((before as Record<string, ConfigurationValue>)[key], (after as Record<string, ConfigurationValue>)[key], path, missing);
    });
  }
  return [pointer];
}

export async function assertTestRunConfigurationUnchanged(
  snapshot: TestRunConfigurationSnapshot,
  reader: TestRunConfigurationReader,
  options?: { refreshTestRuns(configuration: ConfigurationValue, text: string): void },
): Promise<void> {
  if (snapshot.version !== 1) throw Object.assign(failure(), { message: 'CONFIGURATION_INVALID: unsupported snapshot version' });
  const current = await readSnapshot(snapshot.dependencies, reader);
  for (const dependency of snapshot.dependencies) {
    const actual = current.snapshot.dependencies.find(entry => address(entry) === address(dependency));
    if (actual) current.error.changedPointers.push(...changed(dependency.value, actual.value, address(dependency), current.error.missingPointers));
  }
  current.error.changedPointers = [...new Set(current.error.changedPointers)];
  if (options) {
    current.error.changedPointers = current.error.changedPointers.filter(pointer => !pointer.startsWith('conf/test-runs.json#'));
    current.error.missingPointers = current.error.missingPointers.filter(pointer => !pointer.startsWith('conf/test-runs.json#'));
  }
  reject(current.error);
  if (options && current.documents.has('conf/test-runs.json')) options.refreshTestRuns(current.documents.get('conf/test-runs.json')!, current.texts.get('conf/test-runs.json')!);
}
