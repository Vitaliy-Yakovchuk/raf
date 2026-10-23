export interface ResourceTaskReference {
  project: string;
  change: string;
  item: string;
}

export interface ResourceReservationEstimate {
  ramBytes: number;
  diskBytes: Record<string, number>;
}

export type ResourceEstimateResolution =
  | {
      status: "KNOWN";
      reservation: ResourceReservationEstimate;
      sources: string[];
      reason: null;
      confPointer: null;
    }
  | {
      status: "UNKNOWN";
      reservation: null;
      sources: string[];
      reason: string;
      confPointer: string;
    };

export interface AgentResourceEstimateInput {
  flow: unknown;
  type: string;
  project: string;
  tasks: readonly ResourceTaskReference[];
  fileSystemIds: readonly string[];
}

export interface TestProfileResourceEstimateInput {
  testRuns: unknown;
  project: string;
  profileId: string;
  fileSystemIds: readonly string[];
}

export interface ResourceEstimateValues {
  ramBytes: number;
  diskBytesPerFileSystem: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = (base: string, key: string): string => `${base}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
const bytes = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

type Lookup = { status: "found"; value: unknown; path: string } | { status: "missing" | "invalid"; path: string };

function lookup(root: unknown, base: string, keys: readonly string[]): Lookup {
  let value = root;
  let path = base;
  for (const key of keys) {
    if (!record(value)) return { status: "invalid", path: path.endsWith("#") ? path.slice(0, -1) : path };
    path = pointer(path, key);
    if (!Object.hasOwn(value, key)) return { status: "missing", path };
    value = value[key];
  }
  return { status: "found", value, path };
}

export function resourceEstimateInvalidPointer(value: unknown, path: string): string | null {
  if (!record(value)) return path;
  for (const key of ["ramBytes", "diskBytesPerFileSystem"]) {
    if (!Object.hasOwn(value, key) || !bytes(value[key])) return pointer(path, key);
  }
  return null;
}

function unknown(path: string, sources: string[], reason = "Missing or invalid resource estimate"): ResourceEstimateResolution {
  return { status: "UNKNOWN", reservation: null, sources: [...new Set([...sources, path])], reason: `${reason}: ${path}`, confPointer: path };
}

function resolveEstimates(entries: Lookup[], fileSystemIds: readonly string[]): ResourceEstimateResolution {
  const sources: string[] = [];
  if (!Array.isArray(fileSystemIds) || fileSystemIds.length === 0 || fileSystemIds.some(id => typeof id !== "string" || !id.trim())) {
    return unknown("fileSystemIds", sources, "Missing or invalid filesystem identifiers");
  }
  let ramBytes = 0;
  let diskBytesPerFileSystem = 0;
  for (const entry of entries) {
    if (entry.status !== "found") return unknown(entry.path, sources);
    const invalid = resourceEstimateInvalidPointer(entry.value, entry.path);
    if (invalid) return unknown(invalid, sources);
    const value = entry.value as ResourceEstimateValues;
    sources.push(entry.path);
    ramBytes = Math.max(ramBytes, value.ramBytes);
    diskBytesPerFileSystem = Math.max(diskBytesPerFileSystem, value.diskBytesPerFileSystem);
  }
  return { status: "KNOWN", reservation: { ramBytes, diskBytes: Object.fromEntries([...new Set(fileSystemIds)].map(id => [id, diskBytesPerFileSystem])) }, sources: [...new Set(sources)], reason: null, confPointer: null };
}

export function resolveAgentResourceEstimate(input: AgentResourceEstimateInput): ResourceEstimateResolution {
  const base = "conf/flow.json#";
  const select = (project: string, task?: ResourceTaskReference): Lookup => {
    if (input.flow === undefined) return { status: "missing", path: pointer(`${base}/resourceEstimates/agentTypes`, input.type) };
    const candidates = [
      ...(task ? [["resourceEstimates", "projects", project, "agentTasks", task.change, task.item]] : []),
      ["resourceEstimates", "projects", project, "agentTypes", input.type],
      ["resourceEstimates", "agentTypes", input.type],
    ];
    for (const keys of candidates) {
      const entry = lookup(input.flow, base, keys);
      if (entry.status !== "missing") return entry;
    }
    return { status: "missing", path: pointer(`${base}/resourceEstimates/agentTypes`, input.type) };
  };
  const tasks = [...new Map(input.tasks.map(task => [JSON.stringify([task.project, task.change, task.item]), task])).values()];
  return resolveEstimates(tasks.length ? tasks.map(task => select(task.project, task)) : [select(input.project)], input.fileSystemIds);
}

export function resolveTestProfileResourceEstimate(input: TestProfileResourceEstimateInput): ResourceEstimateResolution {
  const base = "conf/test-runs.json#";
  const keys = ["projects", input.project, "profiles", input.profileId, "resourceEstimate"];
  const entry = input.testRuns === undefined ? { status: "missing" as const, path: keys.reduce(pointer, base) } : lookup(input.testRuns, base, keys);
  if (entry.status === "missing") entry.path = keys.reduce(pointer, base);
  return resolveEstimates([entry], input.fileSystemIds);
}
