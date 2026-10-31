import type { Readable } from 'node:stream';
import type { SecretsStore } from './secrets-store.ts';

export type SecretConsumerRefusalCode =
  | 'missing'
  | 'empty'
  | 'expired'
  | 'invalid'
  | 'env-collision'
  | 'unsafe-file-binding'
  | 'missing-output-adapter';

export interface SecretConsumerFileTarget {
  readonly name: string;
  readonly envName: string;
  readonly path?: string;
}

export interface SecretConsumerRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly names: readonly string[];
  readonly fileTargets: readonly SecretConsumerFileTarget[];
  readonly signal: AbortSignal;
}

export interface SecretConsumerSpawnRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly signal: AbortSignal;
  readonly stdout: 'pipe';
  readonly stderr: 'pipe';
}

export interface SecretConsumerChild {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export type SecretConsumerSpawn = (request: SecretConsumerSpawnRequest) => SecretConsumerChild | Promise<SecretConsumerChild>;

export interface SecretConsumerDiscardOutput {
  readonly mode: 'discard';
}

export interface SecretConsumerRedactingOutput {
  readonly mode: 'redact';
  readonly publish: (text: string, stream: 'stdout' | 'stderr') => void;
}

export type SecretConsumerOutput = SecretConsumerDiscardOutput | SecretConsumerRedactingOutput;

export interface SecretConsumerDependencies {
  readonly select: SecretsStore['select'];
  readonly spawn: SecretConsumerSpawn;
  readonly privateDirectory: string;
  readonly output: SecretConsumerOutput | null;
  readonly removeOwned: (directory: string) => Promise<void>;
}

export type SecretConsumerPrimaryOutcome =
  | { readonly status: 'exited'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly status: 'refused'; readonly code: SecretConsumerRefusalCode; readonly message: string }
  | { readonly status: 'spawn-failed'; readonly code: 'spawn-exception'; readonly message: string }
  | { readonly status: 'cancelled'; readonly code: 'aborted'; readonly message: string };

export type SecretConsumerOutcome =
  | SecretConsumerPrimaryOutcome
  | {
    readonly status: 'cleanup-failed';
    readonly code: 'cleanup-error';
    readonly message: string;
    readonly primary: SecretConsumerPrimaryOutcome;
  };

export async function runSecretConsumer(request: SecretConsumerRequest, dependencies: SecretConsumerDependencies): Promise<SecretConsumerOutcome> {
  void request;
  void dependencies;
  throw new Error('NotImplemented');
}
