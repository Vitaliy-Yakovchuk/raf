import { readFileSync } from 'node:fs';

export interface ResourceThresholds {
  readonly maxNormalizedLoad: number;
  readonly minRamFraction: number;
  readonly minRamBytes: number;
  readonly minDiskFraction: number;
  readonly minDiskBytes: number;
}

export interface FlowPolicy {
  readonly version: 1;
  readonly unitTests: {
    readonly timeoutMs: number;
    readonly optimizeAfterTimeouts: number;
    readonly maxGroupTimeouts: number;
  };
  readonly resources: {
    readonly normal: ResourceThresholds;
    readonly hotfix: ResourceThresholds;
    readonly home: { readonly minDiskBytes: number };
  };
  readonly retention: {
    readonly closedRemindersMs: number;
    readonly finishedSessionsMs: number;
  };
  readonly documents: {
    readonly architectureMaxLines: number;
    readonly statusMaxLines: number;
    readonly minArchitectureDiagrams: number;
  };
}

export function loadFlowPolicy(path?: string): FlowPolicy {
  const source = path ?? new URL('../../conf/flow.json', import.meta.url);
  const fail = (field: string): never => { throw new Error(`Invalid flow policy: ${field}`); };
  let policy: unknown;
  try {
    policy = JSON.parse(readFileSync(source, 'utf8'));
  } catch (cause) {
    throw new Error(`Cannot load flow policy from ${source}`, { cause });
  }
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(field);
    return value as Record<string, unknown>;
  };
  const number = (value: unknown, field: string, integer = false, maximum = Infinity): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum ||
      (integer && !Number.isSafeInteger(value))) return fail(field);
    return value;
  };
  const root = object(policy, 'root');
  if (root.version !== 1) fail('version');
  const unitTests = object(root.unitTests, 'unitTests');
  for (const key of ['timeoutMs', 'optimizeAfterTimeouts', 'maxGroupTimeouts']) number(unitTests[key], `unitTests.${key}`, true);
  if ((unitTests.optimizeAfterTimeouts as number) >= (unitTests.maxGroupTimeouts as number)) fail('unitTests.optimizeAfterTimeouts must precede maxGroupTimeouts');
  const resources = object(root.resources, 'resources');
  for (const profile of ['normal', 'hotfix']) {
    const thresholds = object(resources[profile], `resources.${profile}`);
    number(thresholds.maxNormalizedLoad, `resources.${profile}.maxNormalizedLoad`);
    for (const key of ['minRamFraction', 'minDiskFraction']) number(thresholds[key], `resources.${profile}.${key}`, false, 1);
    for (const key of ['minRamBytes', 'minDiskBytes']) number(thresholds[key], `resources.${profile}.${key}`);
  }
  const normal = resources.normal as unknown as ResourceThresholds;
  const hotfix = resources.hotfix as unknown as ResourceThresholds;
  if (hotfix.maxNormalizedLoad < normal.maxNormalizedLoad) fail('resources.hotfix.maxNormalizedLoad is stricter than normal');
  for (const key of ['minRamFraction', 'minRamBytes', 'minDiskFraction', 'minDiskBytes'] as const) {
    if (hotfix[key] > normal[key]) fail(`resources.hotfix.${key} is stricter than normal`);
  }
  const retention = object(root.retention, 'retention');
  for (const key of ['closedRemindersMs', 'finishedSessionsMs']) number(retention[key], `retention.${key}`, true);
  const documents = object(root.documents, 'documents');
  for (const key of ['architectureMaxLines', 'statusMaxLines', 'minArchitectureDiagrams']) number(documents[key], `documents.${key}`, true);
  return policy as FlowPolicy;
}
