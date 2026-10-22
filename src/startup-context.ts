import type { DatabaseSync } from 'node:sqlite';

export interface ContextMeasurement<T> {
  readonly value: T | null;
  readonly reason: string | null;
}

export interface StartupContextSource {
  readonly name: string;
  readonly path?: string;
  readonly tokens: ContextMeasurement<number>;
}

export interface StartupContextAssessment {
  readonly unnecessary: readonly { readonly source: string; readonly reason: string }[];
  readonly missing: readonly { readonly description: string; readonly foundAt: string }[];
}

export interface StartupContextTrace {
  readonly runId: string;
  readonly agentType: string;
  readonly runner: 'claude' | 'codex';
  readonly phase: string;
  readonly autoloaded: {
    readonly systemPrompt: ContextMeasurement<number>;
    readonly instructions: ContextMeasurement<readonly StartupContextSource[]>;
    readonly skills: ContextMeasurement<readonly StartupContextSource[]>;
    readonly mcpServers: ContextMeasurement<readonly StartupContextSource[]>;
    readonly memory: ContextMeasurement<readonly StartupContextSource[]>;
  };
  readonly reads: readonly {
    readonly tool: string;
    readonly target: string;
    readonly resultBytes: ContextMeasurement<number>;
  }[];
  readonly brief: {
    readonly tokens: number;
    readonly parts: readonly { readonly source: string; readonly tokens: number }[];
  };
  readonly tokens: {
    readonly startupInput: ContextMeasurement<number>;
    readonly totalInput: ContextMeasurement<number>;
    readonly cacheReadInput: ContextMeasurement<number>;
    readonly cacheWriteInput: ContextMeasurement<number>;
  };
  readonly boundary: {
    readonly kind: 'file-write' | 'raf-side-effect' | 'response' | 'run-ended';
    readonly eventIndex: number;
  };
  readonly context: StartupContextAssessment | null;
}

export interface StartupContextCapture {
  readonly runId: string;
  readonly agentType: string;
  readonly runner: 'claude' | 'codex';
  readonly phase: string;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly briefParts: readonly { readonly source: string; readonly text: string }[];
  readonly report?: { readonly context?: StartupContextAssessment };
}

export interface StartupContextCapturePorts {
  estimateTokens(text: string): number;
}

export interface StartupContextDueEvent {
  readonly id: string;
  readonly event: 'context-review.due';
  readonly to: string;
  readonly runIds: readonly string[];
  readonly createdAt: string;
}

export interface StartupContextCompletion {
  readonly runId: string;
  readonly phase: string;
  readonly trace: StartupContextTrace | null;
  readonly finishedAt: string;
  readonly flowPath: string;
  readonly mainAddress: string;
}

export function captureStartupContext(input: StartupContextCapture, ports: StartupContextCapturePorts): StartupContextTrace {
  throw new Error('NotImplemented');
}

export function saveStartupContextTrace(database: DatabaseSync, trace: StartupContextTrace): void {
  throw new Error('NotImplemented');
}

export function readStartupContextTrace(database: DatabaseSync, runId: string): StartupContextTrace | null {
  throw new Error('NotImplemented');
}

export function recordStartupContextCompletion(database: DatabaseSync, input: StartupContextCompletion): StartupContextDueEvent | null {
  throw new Error('NotImplemented');
}

export function pendingStartupContextRunIds(database: DatabaseSync): readonly string[] {
  throw new Error('NotImplemented');
}

export function listStartupContextReviewEvents(database: DatabaseSync): readonly StartupContextDueEvent[] {
  throw new Error('NotImplemented');
}

export function bindStartupContextReview(database: DatabaseSync, input: { readonly eventId: string; readonly reviewRunId: string; readonly phase: 'context-review' }): void {
  throw new Error('NotImplemented');
}

export function closeStartupContextReview(database: DatabaseSync, input: { readonly reviewRunId: string; readonly closedAt: string }): void {
  throw new Error('NotImplemented');
}

export function pruneStartupContextTraces(database: DatabaseSync, input: { readonly now: string; readonly flowPath: string }): readonly string[] {
  throw new Error('NotImplemented');
}
