import type { StartupContextCapture, StartupContextTrace } from './startup-context.ts';

export type StartupContextRunner = 'claude' | 'codex';

export interface StartupContextJournal {
  readonly events: StartupContextCapture['events'];
  readonly unavailableReason: string | null;
}

export interface StartupContextJournalRequest {
  readonly runner: StartupContextRunner;
  readonly runnerSessionId: string;
  readonly homeDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface StartupContextJournalFilePorts {
  findFiles(pattern: string): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
}

export function normalizeStartupContextJournal(input: {
  readonly runner: StartupContextRunner;
  readonly version: string;
  readonly lines: readonly string[];
}): StartupContextJournal {
  throw new Error('NotImplemented');
}

export async function collectStartupContextJournal(
  input: StartupContextJournalRequest,
  ports?: StartupContextJournalFilePorts,
): Promise<StartupContextJournal> {
  throw new Error('NotImplemented');
}

export function captureStartupContextJournal(
  input: Omit<StartupContextCapture, 'events'> & { readonly journal: StartupContextJournal },
  ports: { estimateTokens(text: string): number },
): StartupContextTrace {
  throw new Error('NotImplemented');
}

export function startupContextRunnerEnvironment(
  runner: string,
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  throw new Error('NotImplemented');
}
