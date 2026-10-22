import type { Invocation, NativeSandboxScope } from './runner-protocols.ts';

export interface CodexRafCommandAccessRequest {
  readonly invocation: Invocation;
  readonly scope: NativeSandboxScope;
  readonly cwd: string;
  readonly runDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface PreparedCodexRafCommandAccess {
  readonly invocation: Invocation;
  readonly environment: Readonly<Record<string, string>>;
  cleanup(): Promise<void>;
}

export async function prepareCodexRafCommandAccess(
  request: CodexRafCommandAccessRequest,
): Promise<PreparedCodexRafCommandAccess> {
  throw new Error('NotImplemented');
}
