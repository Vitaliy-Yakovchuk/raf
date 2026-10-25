import type { CompiledCommand } from './catalog.ts';
import type { StateStore } from './state-store.ts';
import { commandFailure, failureContext, redactDiagnostic } from './cli-contract.ts';

export function recordCommandTiming(store: StateStore, command: CompiledCommand | undefined, startedAtMs: number, now: () => number, alpha: number): void {
  if (command && command.handlerName !== 'help' && command.metadata.recordDuration !== false) {
    store.recordCommandDuration(command.path.join(' '), Math.max(0, now() - startedAtMs), alpha);
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
