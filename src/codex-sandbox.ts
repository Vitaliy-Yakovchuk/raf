import type { Invocation, NativeSandboxScope } from './runner-protocols.ts';

export interface CodexSandboxRequest {
  readonly runId: string;
  readonly invocation: Invocation;
  readonly scope: NativeSandboxScope;
  readonly cwd: string;
  readonly runDirectory: string;
  readonly writableDirectories: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}

export interface PreparedCodexSandbox {
  readonly invocation: Invocation;
  readonly environment: Readonly<Record<string, string>>;
  readonly toolSandbox: Invocation;
  readonly policyPaths: readonly string[];
  cleanup(): Promise<void>;
}

export async function prepareCodexSandbox(
  request: CodexSandboxRequest,
): Promise<PreparedCodexSandbox> {
  throw new Error('NotImplemented');
}
