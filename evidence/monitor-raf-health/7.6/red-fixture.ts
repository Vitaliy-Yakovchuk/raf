import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { openStateStore } from '../../src/state-store.ts';
import { observeRafHealthCpu } from '../../src/health-cpu.ts';
import { settleRafHealthSummary } from '../../src/health-summary.ts';
import type { RafCostKey } from '../../src/raf-cost-profile.ts';

export function summaryCpuFixture(t: TestContext) {
  const epoch = Date.UTC(2026, 9, 26);
  let elapsed = 0;
  const at = (ms: number) => new Date(epoch + ms).toISOString();
  t.mock.timers.enable({ apis: ['Date'], now: epoch });
  t.mock.method(process.hrtime, 'bigint', () => BigInt(100000 + elapsed) * 1000000n);
  const root = mkdtempSync(join(tmpdir(), 'raf-summary-cpu-'));
  const path = join(root, 'state.sqlite');
  let store = openStateStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const configuration = { health: { cpuWindowMs: 100, cpuThresholdCores: 1, summaryIntervalMs: 600 } };
  const advance = (ms: number) => { elapsed = ms; t.mock.timers.setTime(epoch + ms); };
  const sample = (start: number, end: number, scope: RafCostKey['scope'] = 'command', user = 20, system = 5) => {
    store.costProfileRepository.recordSample!({ scope, command: scope === 'command' ? 'agent ps' : null,
      stage: 'handler', executor: 'self', startedAt: at(start), completedAt: at(end), wallMs: end - start,
      cpu: { userMs: user, systemMs: system, source: 'process.cpuUsage', unavailableReason: null } });
  };
  const cpu = () => observeRafHealthCpu({ ...store.healthCpu.domain(), enabled: true, entry: 'runtime', configuration }, {
    readProfile: async () => store.healthCpu.readProfile(), transaction: async action => store.healthCpu.transaction(action),
    reportUnavailable: reason => { throw new Error(reason); },
  });
  const summary = () => settleRafHealthSummary({ enabled: true, entry: 'runtime', now: at(elapsed), configuration }, {
    transaction: async action => store.healthSummary.transaction(action), deliverPendingToCurrentMain: async () => {},
    reportUnavailable: reason => { throw new Error(reason); },
  });
  return { at, advance, sample, cpu, summary, store: () => store,
    reopen() { store.close(); store = openStateStore(path); } };
}
