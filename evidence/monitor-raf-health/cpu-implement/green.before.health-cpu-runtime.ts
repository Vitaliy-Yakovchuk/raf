import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeRafHealthCpu, type RafHealthCpuAssessment } from './health-cpu.ts';
import { loadEventCatalog, validateEventId } from './event-catalog.ts';
import { createEventRegistry } from './event-registry.ts';
import type { StateStore } from './state-store.ts';

export async function settleRuntimeHealthCpu(store: StateStore, root: string): Promise<RafHealthCpuAssessment | null> {
  try {
    const catalog = loadEventCatalog(root);
    if (!catalog.events.some(event => event.id === 'raf.cpu-exceeded')) return null;
    const domain = store.healthCpu.domain();
    const configuration = JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8'));
    const assessment = await observeRafHealthCpu({ ...domain, enabled: true, entry: 'runtime', configuration }, {
      readProfile: async () => store.healthCpu.readProfile(),
      transaction: async action => store.healthCpu.transaction(action),
      reportUnavailable: reason => process.emitWarning(reason),
    });
    const registry = createEventRegistry(catalog, {
      validateId: (kind, id) => validateEventId(catalog, kind, id),
      transaction: action => store.eventRepository.transaction(action),
    });
    try { registry.dispatch(); } catch (error) { process.emitWarning(String(error)); }
    return assessment;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.emitWarning(reason);
    return { availability: 'unavailable', reason, startedAt: null, completedAt: new Date().toISOString(), wallMs: null,
      cpuUserMs: null, cpuSystemMs: null, cores: null, thresholdCores: null, exceeded: false, sources: [], scopes: null, error: null };
  }
}
