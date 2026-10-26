import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEventCatalog } from './event-catalog.ts';
import type { StateStore } from './state-store.ts';
import { settleRafHealthSummary, readRafHealthSummary, type HealthSummaryContext, type HealthSummaryPorts } from './health-summary.ts';

export function runtimeHealthSummary(store: StateStore, root: string, deliver: () => Promise<void> = async () => {}) {
  let configuration: unknown;
  try { configuration = JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8')); } catch {}
  let enabled = false;
  try { enabled = loadEventCatalog(root).events.some(event => event.id === 'raf.health-summary'); } catch (error) { process.emitWarning(String(error)); }
  const context: HealthSummaryContext = { enabled, entry: 'runtime', now: new Date().toISOString(), configuration };
  const ports: HealthSummaryPorts = { transaction: async action => store.healthSummary.transaction(action),
    deliverPendingToCurrentMain: deliver, reportUnavailable: reason => process.emitWarning(reason) };
  return { settle: () => settleRafHealthSummary(context, ports), read: async () => {
    const view = await readRafHealthSummary(context, ports);
    if (enabled && !view.error) {
      try { view.cpu = store.healthCpu.transaction(tx => tx.state.lastAssessment) ?? view.cpu; } catch {}
      try {
        const issues = store.healthSummary.uncertainDeliveries();
        if (issues.length) view.summary.uncertainDeliveries = issues;
      } catch (error) { view.unavailableReason = error instanceof Error ? error.message : String(error); }
    }
    return view;
  } };
}

export function scheduleWorkerHealthSummary(store: StateStore, root: string, settle: () => Promise<unknown>): () => Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let work: Promise<unknown> = Promise.resolve();
  const schedule = async () => {
    const view = await runtimeHealthSummary(store, root).read();
    if (stopped || !view.summary.dueAt) return;
    let delay = Date.parse(view.summary.dueAt) - Date.now();
    if (delay <= 0) {
      const configuration = JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8'));
      delay = configuration.health.summaryIntervalMs;
      if (!Number.isFinite(delay) || delay <= 0) return;
    }
    timer = setTimeout(() => {
      if (stopped) return;
      work = Promise.resolve().then(settle).catch(error => process.emitWarning(String(error))).then(schedule).catch(error => process.emitWarning(String(error)));
    }, Math.min(delay, 2147483647));
    timer.unref();
  };
  work = schedule().catch(error => process.emitWarning(String(error)));
  return async () => { stopped = true; clearTimeout(timer); await work; };
}
