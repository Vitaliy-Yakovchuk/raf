export interface RafTemporarySocketScope {
  readonly address: string;
  readonly cwd: string;
}

export interface RafTemporarySocketRequest {
  readonly runId: string;
  readonly directory: string;
  readonly basename: string;
  readonly serverCwd: string;
  readonly clientCwd: string;
}

export interface RafTemporarySocketEndpoint {
  readonly bind: RafTemporarySocketScope;
  readonly connect: RafTemporarySocketScope;
  readonly ownedResources: readonly string[];
  cleanup(): Promise<void>;
}

export async function createRafTemporarySocketEndpoint(
  request: RafTemporarySocketRequest,
): Promise<RafTemporarySocketEndpoint> {
  throw new Error('NotImplemented');
}
