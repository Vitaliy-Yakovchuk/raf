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
  tasks: readonly ResourceTaskReference[];
  fileSystemIds: readonly string[];
}

export interface TestProfileResourceEstimateInput {
  testRuns: unknown;
  project: string;
  profileId: string;
  fileSystemIds: readonly string[];
}

export function resolveAgentResourceEstimate(
  input: AgentResourceEstimateInput,
): ResourceEstimateResolution {
  throw new Error("NotImplemented");
}

export function resolveTestProfileResourceEstimate(
  input: TestProfileResourceEstimateInput,
): ResourceEstimateResolution {
  throw new Error("NotImplemented");
}
