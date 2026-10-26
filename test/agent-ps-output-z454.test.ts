import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppRuntime, type AppRuntimeDependencies, type RuntimeContext } from '../src/app-runtime.ts';
import { execute } from '../src/cli.ts';
import type { CompiledCatalog } from '../src/catalog.ts';
import type { SessionRecord } from '../src/session-state.ts';

const catalog: CompiledCatalog = {
  commands: [{ path: ['agent', 'ps'], handlerName: 'agent ps', parameters: [], valueSources: {}, metadata: {} }],
  reportStatuses: [],
};
const context: RuntimeContext = {
  orchestratorRoot: '/unit', confRoot: '/unit/conf', artifactPath: '/unit/catalog.json',
  statePath: '/unit/state.sqlite', tmpRoot: '/unit/tmp', mode: 'test',
  commandStartedAtMs: 0, commandTimingOwner: 'production', resolveCaller: async () => ({}),
};

function session(index: number, command: string): SessionRecord {
  const process = {
    pid: 1000 + index, startedAt: '2026-10-26T10:00:00.000Z', runner: 'codex',
    runnerSessionId: `native-${index}`, tmuxSession: `tmux-${index}`,
    evidence: { command, machineId: 'unit-machine', bootId: 'unit-boot', tmuxSocket: '/unit/tmux', tmuxPane: `%${index}` },
  };
  return {
    runId: `run-${index}`, addressId: `agent-${index}`, revision: 1, state: 'running', process,
    worker: { ...process, pid: 2000 + index },
    activity: { type: 'hotfix', project: 'raf', features: ['complete-raf-flow-contracts'], phase: 'hotfix', cwd: '/unit/raf-hotfix' },
    observation: { state: 'alive', observedAt: process.startedAt, identity: process },
    launchContext: {
      assignment: { root: '/unit', changes: [], baselineArchives: [] },
      selection: { runner: 'codex', model: 'unit-model', effort: 'unit-effort', reason: 'unit' },
      briefPath: '/unit/brief.md', reportPath: '/unit/report.json', wrapper: process,
      contextReview: { contextReviewId: 'unit', runIds: [], brief: command },
    },
  };
}

async function ps(rows: SessionRecord[]) {
  let reconciliations = 0;
  const dependencies = {
    loadConfiguration: async () => ({ catalog, models: { runners: [] }, commandTiming: { emaAlpha: 0.5, sqliteOnlyMeanBudgetMs: 100 } }),
    openStore: async () => ({ initializeRunners() {}, close() {} }),
    createServices: async () => ({ control: { ps: async () => { reconciliations++; return rows; } } }),
  } as unknown as AppRuntimeDependencies;
  const runtime = createAppRuntime(context, dependencies);
  try {
    const result = await execute(['agent', 'ps'], catalog, runtime.handlers);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(reconciliations, 1, 'The public response must follow actual reconciliation');
    return result;
  } finally { await runtime.close(); }
}

test('Z454 public ps excludes launch settings without changing verified process identities', async () => {
  const settings = 'codex --settings ' + JSON.stringify({ hooks: 'private-hook\n\tУкраїна 😀'.repeat(5000) });
  const row = session(0, settings);
  const before = structuredClone(row);
  const result = await ps([row]);
  const [view] = JSON.parse(result.stdout);
  assert.equal(view.process.evidence.command, undefined, 'Full argv/settings are internal ownership evidence');
  assert.equal(view.observation.identity.evidence.command, undefined, 'The observation must not duplicate full argv');
  assert.equal(view.worker.evidence.command, undefined);
  assert.equal(view.launchContext, undefined, 'Launch inputs and briefs are not an active-session listing');
  assert.deepEqual(view.activity, row.activity);
  assert.equal(view.process.pid, row.process!.pid);
  assert.equal(view.process.evidence.bootId, 'unit-boot');
  assert.equal(view.process.evidence.tmuxPane, '%0');
  assert.equal(view.observation.state, 'alive');
  assert.deepEqual(row, before, 'Public formatting must never mutate durable identity or scanner evidence');
});

test('Z454 ps returns every agent and valid JSON independently of settings size beyond 64 KiB', async () => {
  for (const count of [0, 1, 32, 256]) {
    const small = Array.from({ length: count }, (_, index) => session(index, 'codex'));
    const settings = 'codex --settings ' + JSON.stringify({ config: 'settings\n\t😀'.repeat(10000) });
    const large = Array.from({ length: count }, (_, index) => session(index, settings));
    const compact = await ps(small);
    const expanded = await ps(large);
    const parsed = JSON.parse(expanded.stdout);
    assert.deepEqual(parsed.map((row: SessionRecord) => row.addressId), large.map(row => row.addressId));
    assert.equal(expanded.stdout, compact.stdout, 'Output size must depend on active-session data, not launch settings');
    assert.equal(expanded.stderr, '');
  }
});

test('Z454 public ps preserves pending reconciliation and unknown/exited diagnostic observations', async () => {
  for (const observation of [
    { state: 'unknown' as const, observedAt: '2026-10-26T10:00:00.000Z', error: 'Cannot inspect process' },
    { state: 'exited' as const, observedAt: '2026-10-26T10:00:00.000Z', exitCode: null, evidence: 'Process absent' },
  ]) {
    const row = { ...session(1, 'codex'), observation,
      reconciliation: { code: 'WORKER_RESULT_PENDING', reason: 'Worker is processing its result' },
      resultNotice: { state: 'pending', recipient: 'main' },
    };
    const [view] = JSON.parse((await ps([row])).stdout);
    assert.deepEqual(view.observation, observation);
    assert.deepEqual(view.reconciliation, row.reconciliation);
    assert.deepEqual(view.resultNotice, row.resultNotice);
    assert.equal(view.process.evidence.command, undefined);
  }
});
