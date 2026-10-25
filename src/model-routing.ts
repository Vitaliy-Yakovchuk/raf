export interface ModelDefinition {
  id: string;
  version: string;
  runner: string;
  effort: string;
  complexity: string;
  enabled: boolean;
  quotaPool?: string;
}

export interface ModelCatalog {
  version: number;
  runners: { id: string; initialEnabled: boolean }[];
  models: ModelDefinition[];
  routing: {
    complexityOrder: string[];
    taskClassification: Record<string, string[]>;
    runnerPreferences: { complexity: string; runners: string[] }[];
    modelTransitions: { from: string; to: string[] }[];
    roleModelBindings: Record<string, string[]>;
  };
}

export interface RoutingSnapshot {
  runnerEnabled: Record<string, boolean>;
  cliAvailable: Record<string, boolean>;
  cliReasons?: Record<string, string>;
  quotas: { runner: string; pool: string; status: 'available' | 'exhausted' | 'unknown' }[];
  cliWarnings?: Readonly<Record<string, readonly string[]>>;
}

export interface ModelRequest {
  complexity: string;
  role?: string;
  previousModel?: string;
}

export interface ModelAvailability {
  runner: string;
  model: string;
  effort: string;
  configuredComplexity: string;
  supportedComplexities: string[];
  enabled: boolean;
  available: boolean;
  quota: 'available' | 'exhausted' | 'unknown';
  reasons: string[];
  warnings: readonly string[];
}

export type ModelSelection =
  | { status: 'selected'; runner: string; model: string; effort: string; reason: string; quota: 'available' | 'unknown' }
  | { status: 'waiting'; code: 'NO_ENABLED_MODELS' | 'NO_SUITABLE_CAPACITY'; reason: string };

export function classifyModelTask(catalog: ModelCatalog, task: string): string | null {
  throw new Error('NotImplemented');
}

export function selectModel(catalog: ModelCatalog, snapshot: RoutingSnapshot, request: ModelRequest): ModelSelection {
  const availability = listModelAvailability(catalog, snapshot);
  if (!availability.some(model => model.enabled)) {
    return { status: 'waiting', code: 'NO_ENABLED_MODELS', reason: 'No enabled models or runners in the current configuration.' };
  }
  const bindings = request.role === undefined ? undefined : catalog.routing.roleModelBindings[request.role];
  const transitions = catalog.routing.modelTransitions.find(entry => entry.from === request.previousModel)?.to ?? [];
  const runners = catalog.routing.runnerPreferences.find(entry => entry.complexity === request.complexity)?.runners ?? [];
  const rank = (values: string[], value: string) => {
    const index = values.indexOf(value);
    return index < 0 ? values.length : index;
  };
  const candidates = availability.filter(model => model.available
    && model.supportedComplexities.includes(request.complexity)
    && (bindings === undefined || bindings.includes(model.model)));
  candidates.sort((a, b) => rank(transitions, a.model) - rank(transitions, b.model)
    || rank(runners, a.runner) - rank(runners, b.runner)
    || rank(bindings ?? [], a.model) - rank(bindings ?? [], b.model));
  const selected = candidates[0];
  if (!selected) {
    return { status: 'waiting', code: 'NO_SUITABLE_CAPACITY', reason: `No suitable capacity for complexity ${request.complexity} under the configured policy. ${availability.map(model => `${model.model}: ${model.reasons.join(', ') || 'does not match request'}`).join('; ')}` };
  }
  return {
    status: 'selected', runner: selected.runner, model: selected.model, effort: selected.effort,
    quota: selected.quota === 'available' ? 'available' : 'unknown',
    reason: `Selected ${selected.model} on ${selected.runner} for ${request.complexity} by configured policy and catalog order; quota ${selected.quota}.`,
  };
}

export function listModelAvailability(catalog: ModelCatalog, snapshot: RoutingSnapshot): ModelAvailability[] {
  return catalog.models.map(model => {
    const runner = catalog.runners.find(entry => entry.id === model.runner);
    const runnerEnabled = runner !== undefined && (snapshot.runnerEnabled[model.runner] ?? runner.initialEnabled);
    const enabled = model.enabled && runnerEnabled;
    const quotas = snapshot.quotas.filter(entry => entry.runner === model.runner && entry.pool === (model.quotaPool ?? model.id));
    const quota = quotas.some(entry => entry.status === 'exhausted') ? 'exhausted'
      : quotas.length > 0 && quotas.every(entry => entry.status === 'available') ? 'available' : 'unknown';
    const complexityIndex = catalog.routing.complexityOrder.indexOf(model.complexity);
    const supportedComplexities = complexityIndex < 0 ? [] : catalog.routing.complexityOrder.slice(0, complexityIndex + 1);
    const reasons: string[] = [];
    if (!model.enabled) reasons.push('Model disabled by configuration');
    if (!runnerEnabled) reasons.push('Runner disabled or absent from catalog');
    if (!snapshot.cliAvailable[model.runner]) reasons.push(snapshot.cliReasons?.[model.runner] ?? 'CLI unavailable');
    if (complexityIndex < 0) reasons.push('Unknown configured complexity');
    if (quota !== 'available') reasons.push(`Quota ${quota}`);
    return {
      runner: model.runner, model: model.id, effort: model.effort, configuredComplexity: model.complexity,
      supportedComplexities, enabled, quota, reasons, warnings: [...(snapshot.cliWarnings?.[model.runner] ?? [])],
      available: enabled && snapshot.cliAvailable[model.runner] === true && complexityIndex >= 0 && quota !== 'exhausted',
    };
  });
}
