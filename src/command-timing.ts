import type { CompiledCommand } from './catalog.ts';
import type { StateStore } from './state-store.ts';
import { commandFailure, failureContext, redactDiagnostic } from './cli-contract.ts';

export function validateCommandTiming(value: unknown): asserts value is { emaAlpha: number; sqliteOnlyMeanBudgetMs: number } {
  const timing = value as { emaAlpha?: number; sqliteOnlyMeanBudgetMs?: number } | null | undefined;
  const invalid = !Number.isFinite(timing?.emaAlpha) || timing!.emaAlpha! <= 0 || timing!.emaAlpha! > 1
    ? 'emaAlpha' : !Number.isFinite(timing?.sqliteOnlyMeanBudgetMs) || timing!.sqliteOnlyMeanBudgetMs! <= 0
      ? 'sqliteOnlyMeanBudgetMs' : undefined;
  if (invalid) throw commandFailure({ code: 'CONFIGURATION_INVALID', message: `Invalid commandTiming.${invalid}`,
    stage: 'configuration', source: 'raf.json', sourceCode: null, reason: `Invalid commandTiming.${invalid}`,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true,
    remediation: [`Виправте conf/raf.json#/commandTiming/${invalid}.`] });
}

export function recordCommandTiming(store: StateStore, command: CompiledCommand | undefined, startedAtMs: number, now: () => number, alpha: number): void {
  if (command && command.handlerName !== 'help') {
    const name = command.path.join(' ');
    if (command.metadata.recordDuration === false) {
      if (name === 'resource wait') return;
      throw new Error(`Command duration cannot be disabled for ${name}`);
    }
    const durationMs = now() - startedAtMs;
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('Duration must be finite and nonnegative');
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new Error('Alpha must be in (0, 1]');
    store.recordCommandDuration(name, durationMs, alpha);
  }
}

export function commandTimingFailure(error: unknown, original?: unknown): Error {
  const primary = failureContext(original);
  const diagnostic = String(redactDiagnostic(error instanceof Error ? error.message : String(error), primary?.secrets));
  const message = `Command timing storage failed: ${diagnostic}`;
  if (primary) return commandFailure({ ...primary, message: `${primary.message}; ${message}` });
  return commandFailure({ code: 'TIMING_FAILED', message, stage: 'timing', source: 'command-timing', sourceCode: null,
    reason: message, received: null, expected: null, found: null, completed: [], pending: [], retrySafe: false,
    remediation: ['Перевірте доступність SQLite; перед повтором перевірте результат основної операції.'] });
}
