export type GenerationId = string;
export type ComponentRole = 'service' | 'worker' | 'notice';
export type FactKind = 'report' | 'event' | 'message' | 'reminder';
export type ProtocolKind = FactKind | 'address';

export interface ProtocolSupport {
  emits: number;
  accepts: number[];
}

export interface MainGeneration {
  id: GenerationId;
  root: string;
  published: boolean;
  protocols: Record<ProtocolKind, ProtocolSupport>;
}

export interface RunnerIdentity {
  address: string;
  runId: string;
  pid: number;
  startedAt: string;
  session: string;
  runnerSessionId: string;
  tmp: string;
  report: string;
}

export interface OwnerToken {
  ownerId: string;
  epoch: number;
}

export interface ComponentOwner extends OwnerToken {
  role: ComponentRole;
  generation: GenerationId;
  phase: 'starting' | 'active' | 'retired';
}

export interface PinnedOperation {
  id: string;
  ownerId: string;
  generation: GenerationId;
  kind: 'cli' | 'bug-sync' | 'resource-wait' | 'worker-import' | 'hook-notice';
}

export interface PendingFact {
  id: string;
  kind: FactKind;
  address: string;
  runId: string;
  generation: GenerationId;
  protocol: number;
  payload: Record<string, unknown>;
}

export interface StoredFact {
  fact: PendingFact;
  status: 'pending' | 'accepted';
  acceptedBy?: OwnerToken;
}

export interface HandoverTransition {
  id: string;
  from: GenerationId;
  to: GenerationId;
  oldOwners: Record<ComponentRole, string>;
  newOwners: Record<ComponentRole, string>;
  status: 'waiting' | 'complete' | 'blocked';
}

export interface HandoverState {
  activeGeneration: GenerationId;
  generations: Record<GenerationId, MainGeneration>;
  owners: Record<string, ComponentOwner>;
  activeOwners: Record<ComponentRole, string>;
  operations: Record<string, PinnedOperation>;
  runners: Record<string, RunnerIdentity>;
  facts: Record<string, StoredFact>;
  transition: HandoverTransition | null;
  resourceWait: { queue: string[]; lastGrant: number };
  bugSync: { cursor: string };
}

export interface HandoverStore {
  read(): Promise<HandoverState>;
  transaction<T>(update: (state: HandoverState) => T): Promise<T>;
}

export interface ReadinessProof extends OwnerToken {
  restored: boolean;
}

export interface HandoverRuntime {
  start(owner: ComponentOwner, duties: string[]): Promise<void>;
  readiness(owner: OwnerToken): Promise<ReadinessProof | null>;
  isAlive(owner: OwnerToken): Promise<boolean>;
  stop(owner: OwnerToken): Promise<void>;
  loadAsset(root: string, kind: 'catalog' | 'module'): Promise<string>;
  acceptFact(owner: OwnerToken, fact: PendingFact, idempotencyKey: string): Promise<void>;
  runnerAction(action: 'kill' | 'restart' | 'remove-tmp', runId: string): Promise<void>;
}

export interface HandoverContext {
  store: HandoverStore;
  runtime: HandoverRuntime;
}

export interface HandoverProgress {
  status: 'waiting' | 'complete' | 'blocked';
  reason?: string;
}

export async function pinMainOperation(
  context: HandoverContext,
  input: { id: string; ownerId: string; kind: PinnedOperation['kind'] },
): Promise<PinnedOperation> {
  throw new Error('NotImplemented');
}

export async function loadPinnedMainAsset(
  context: HandoverContext,
  operationId: string,
  kind: 'catalog' | 'module',
): Promise<string> {
  throw new Error('NotImplemented');
}

export async function finishMainOperation(
  context: HandoverContext,
  operationId: string,
): Promise<void> {
  throw new Error('NotImplemented');
}

export async function beginMainHandover(
  context: HandoverContext,
  targetGeneration: GenerationId,
): Promise<string> {
  throw new Error('NotImplemented');
}

export async function advanceMainHandover(
  context: HandoverContext,
  transitionId: string,
): Promise<HandoverProgress> {
  throw new Error('NotImplemented');
}

export async function recoverMainHandover(
  context: HandoverContext,
): Promise<HandoverProgress> {
  throw new Error('NotImplemented');
}

export async function recordMainFact(
  context: HandoverContext,
  fact: PendingFact,
): Promise<void> {
  throw new Error('NotImplemented');
}

export async function drainMainFacts(
  context: HandoverContext,
  owner: OwnerToken,
): Promise<void> {
  throw new Error('NotImplemented');
}

export async function assertMainSlotReusable(
  context: HandoverContext,
  generation: GenerationId,
): Promise<void> {
  throw new Error('NotImplemented');
}
