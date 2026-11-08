import { selectModel, type ModelCatalog, type ModelRequest, type RoutingSnapshot } from './model-routing.ts';
import type { RunnerAvailability } from './runner-availability.ts';

export async function resolveRunnerRoutingSnapshot(
  catalog: ModelCatalog,
  snapshot: RoutingSnapshot,
  probe: (runner: string) => Promise<RunnerAvailability>,
  selection?: { catalog: ModelCatalog; request: ModelRequest },
): Promise<RoutingSnapshot> {
  const result = { ...snapshot, cliAvailable: {}, cliReasons: {}, cliWarnings: {} } as RoutingSnapshot & {
    cliReasons: Record<string, string>;
    cliWarnings: Record<string, readonly string[]>;
  };
  const record = (availability: RunnerAvailability) => {
    result.cliAvailable[availability.runner] = availability.available;
    if (availability.available) result.cliWarnings[availability.runner] = availability.warnings;
    else result.cliReasons[availability.runner] = availability.reason;
  };
  if (selection) {
    const optimistic = Object.fromEntries(catalog.runners.map(runner => [runner.id, true]));
    for (;;) {
      const candidate = selectModel(selection.catalog, { ...result, cliAvailable: { ...optimistic, ...result.cliAvailable } }, selection.request);
      if (candidate.status !== 'selected') break;
      record(await probe(candidate.runner));
      if (result.cliAvailable[candidate.runner]) return result;
    }
  }
  const remaining = catalog.runners.filter(runner => result.cliAvailable[runner.id] === undefined);
  const results = await Promise.all(remaining.map(runner => probe(runner.id)));
  for (const availability of results) record(availability);
  return result;
}
