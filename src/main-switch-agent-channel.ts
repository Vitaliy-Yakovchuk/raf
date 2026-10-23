export type ChannelIdentity = Readonly<{
  agentId: string;
  runId: string;
  runnerSessionId: string;
}>;

export type AgentChannelGrant = Readonly<{
  identity: ChannelIdentity;
  issuedPrefix: string;
  issuedSlot: string;
  workspace: string;
  allowedSubcommands: readonly ("message" | "ps")[];
  routing: "trusted-facade" | "legacy";
}>;

export type PublishedChannelGeneration = Readonly<{
  publicationId: string;
  slot: string;
  root: string;
  entrypoint: string;
  executable: string;
  commit: string;
  sourceFingerprint: string;
  buildFingerprint: string;
  catalogFingerprint: string;
}>;

export type ChannelPublicationRegistry = Readonly<{
  revision: string;
  activePublicationId: string;
  publications: readonly PublishedChannelGeneration[];
}>;

export type ChannelGenerationLease = Readonly<{
  generation: PublishedChannelGeneration;
  release(): Promise<void>;
}>;

export type AgentChannelRequest = Readonly<{
  command: string;
  callerPid: number;
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export type ChannelCommandOutput = Readonly<{
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}>;

export type PinnedChannelExecution = Readonly<{
  generation: PublishedChannelGeneration;
  executable: string;
  argv: readonly string[];
  cwd: string;
  sender: ChannelIdentity;
  shell: false;
}>;

export interface AgentChannelPorts {
  verifyCaller(callerPid: number): Promise<ChannelIdentity | null>;
  loadGrant(identity: ChannelIdentity): Promise<AgentChannelGrant | null>;
  readPublicationRegistry(): Promise<ChannelPublicationRegistry>;
  pinGeneration(
    generation: PublishedChannelGeneration,
    registryRevision: string,
  ): Promise<ChannelGenerationLease>;
  executePinned(input: PinnedChannelExecution): Promise<ChannelCommandOutput>;
}

export async function routeAgentChannelCommand(
  request: AgentChannelRequest,
  ports: AgentChannelPorts,
): Promise<ChannelCommandOutput> {
  throw new Error("NotImplemented");
}

export type ChannelSlotReader = Readonly<{
  id: string;
  slot: string;
  live: boolean;
  kind: "operation" | "legacy-channel" | "redirectable-channel";
  safeRouting: boolean;
}>;

export type ChannelSlotReuse = Readonly<{
  reusable: boolean;
  blockingReaderIds: readonly string[];
}>;

export function assessAgentChannelSlotReuse(input: Readonly<{
  slot: string;
  readers: readonly ChannelSlotReader[];
}>): ChannelSlotReuse {
  throw new Error("NotImplemented");
}

export type AgentNativePolicyInput = Readonly<{
  mainCopies: readonly [string, string];
  logicalMain: string;
  activationMetadata: readonly string[];
  writableRoots: readonly string[];
  exactWritableFiles: readonly string[];
  denyReadPaths: readonly string[];
  denyConnectPaths: readonly string[];
  issuedCommandPrefixes: readonly string[];
}>;

export type AgentNativePolicy = Readonly<{
  providerRequired: true;
  readOnlyPaths: readonly string[];
  writableRoots: readonly string[];
  exactWritableFiles: readonly string[];
  denyReadPaths: readonly string[];
  denyConnectPaths: readonly string[];
  issuedCommandPrefixes: readonly string[];
}>;

export interface AgentNativePolicyPorts {
  canonicalPath(path: string): Promise<string>;
}

export async function compileAgentChannelNativePolicy(
  input: AgentNativePolicyInput,
  ports: AgentNativePolicyPorts,
): Promise<AgentNativePolicy> {
  throw new Error("NotImplemented");
}

export type NativeChannelProbeRequest = Readonly<{
  policy: AgentNativePolicy;
  executable: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export async function runAgentChannelNativeProbe(
  input: NativeChannelProbeRequest,
): Promise<ChannelCommandOutput> {
  throw new Error("NotImplemented");
}
