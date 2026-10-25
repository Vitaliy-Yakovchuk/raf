import type { RunnerEvent, TestId } from './test-runs.ts';

type Adapter = 'vitest-events';
export type CanonicalRunnerEvent = Exclude<RunnerEvent, { kind: 'expected' } | { kind: 'complete'; expectedCount: number }>;
const identity = (id: TestId) => JSON.stringify([id.file, id.name]);
const isTestId = (id: any): id is TestId => typeof id?.file === 'string' && typeof id?.name === 'string';

export function* completeRunnerProtocol(expected: Iterable<TestId>, adapter?: Adapter): Generator<RunnerEvent> {
  if (process.env.RAF_TEST_RUN_DIAGNOSTICS_PROTOCOL !== '2') {
    yield { kind: 'complete', expected: [...expected], ...(adapter ? { adapter } : {}) };
    return;
  }
  const seen = new Set<string>();
  for (const test of expected) {
    const key = identity(test);
    if (seen.has(key)) continue;
    seen.add(key);
    yield { kind: 'expected', test };
  }
  yield { kind: 'complete', expectedCount: seen.size, ...(adapter ? { adapter } : {}) };
}

export class RunnerProtocol {
  private expected = new Map<string, TestId>();
  private invalid = false;
  private reject(): never { this.invalid = true; throw new Error('Invalid runner event'); }
  accept(event: any): CanonicalRunnerEvent | null {
    if (!event || !['diagnostic', 'discovered', 'container-complete', 'passed', 'assertion-failed', 'setup-failed', 'file-setup-failed', 'expected', 'complete', 'protocol-error'].includes(event.kind) ||
        event.kind === 'diagnostic' && (!Array.isArray(event.diagnostics) || !Array.isArray(event.evidence) || event.evidence.some((path: unknown) => typeof path !== 'string')) ||
        ['discovered', 'container-complete', 'passed', 'assertion-failed', 'setup-failed', 'expected'].includes(event.kind) && !isTestId(event.test) ||
        event.parent !== undefined && !isTestId(event.parent)) return this.reject();
    if (event.kind === 'expected') {
      const key = identity(event.test);
      if (this.expected.has(key)) return this.reject();
      this.expected.set(key, event.test);
      return null;
    }
    if (event.kind !== 'complete') return event;
    if (this.invalid) return this.reject();
    if ('expectedCount' in event) {
      if ('expected' in event || !Number.isSafeInteger(event.expectedCount) || event.expectedCount < 0 || event.expectedCount !== this.expected.size) return this.reject();
      const complete: CanonicalRunnerEvent = { kind: 'complete', expected: [...this.expected.values()], ...(event.adapter ? { adapter: event.adapter } : {}) };
      this.expected.clear();
      return complete;
    }
    if (this.expected.size || !Array.isArray(event.expected) || !event.expected.every(isTestId)) return this.reject();
    return event;
  }
  finish(): void { if (this.expected.size || this.invalid) this.reject(); }
}

export function normalizeRunnerEvents(events: readonly RunnerEvent[]): CanonicalRunnerEvent[] {
  const protocol = new RunnerProtocol();
  const normalized: CanonicalRunnerEvent[] = [];
  for (const event of events) {
    try { const value = protocol.accept(event); if (value) normalized.push(value); }
    catch { normalized.push({ kind: 'protocol-error', diagnostic: 'Invalid JSON runner protocol' }); }
  }
  try { protocol.finish(); } catch { normalized.push({ kind: 'protocol-error', diagnostic: 'Incomplete runner expected inventory' }); }
  return normalized;
}
