import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import type { RuntimeConfiguration } from '../src/app-runtime.ts';
import type { AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { SessionRecord } from '../src/session-state.ts';

import { fullLaunchContext, syntheticSource } from './agent-ps-projection-contract.ts';
export { assertNoSource, expectedOwnContext, fullLaunchContext, sourceForms, syntheticSource } from './agent-ps-projection-contract.ts';

const boot = { machineId: 'z398-unit-machine', bootId: 'z398-unit-boot' };
const runtimeUrl = new URL('../src/production-runtime.ts?z398-independent-projection', import.meta.url).href;
const osUrl = new URL('../src/os-runtime.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && specifier === './os-runtime.ts') return { url: 'z398-fixture:os', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'z398-fixture:os') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(osUrl)}; export const readMachineBootIdentity = async () => (${JSON.stringify(boot)});` };
    return next(url, context);
  },
});
let createServices: typeof import('../src/production-runtime.ts').createProductionServices;
try { createServices = (await import(runtimeUrl)).createProductionServices; }
finally { hooks.deregister(); }
const root = fileURLToPath(new URL('../../', import.meta.url));
const configuration: RuntimeConfiguration = {
  catalog: { commands: [], reportStatuses: [{ id: 'succeeded', event: 'agent.succeeded' }, { id: 'failed', event: 'agent.failed' }] },
  models: { version: 1, runners: [], models: [], routing: { complexityOrder: [], taskClassification: {}, runnerPreferences: [], modelTransitions: [], roleModelBindings: {} } },
  commandTiming: JSON.parse(await readFile(join(root, 'conf/raf.json'), 'utf8')).commandTiming,
};
const start = 'Sun Oct 25 00:00:00 2026';
const startedAt = new Date(start).toISOString();

export async function projectionFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'raf-z398-unit-'));
  const tmpRoot = join(directory, 'home/.raf/tmp');
  await mkdir(tmpRoot, { recursive: true });
  const store = openStateStore(':memory:');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const processes = new Map<number, { command: string; parent: number }>();
  let callerPid = 0;
  let claimedCaller: unknown;
  let scanError = false;
  let nextPid = 51000;
  const execute: AdapterCommandExecutor = async command => {
    assert.equal(basename(command.executable), 'ps', 'Unit fixture permits process observations only');
    const ancestry = command.args.includes('pid=,ppid=,lstart=,command=');
    if (scanError) throw new Error(syntheticSource);
    assert.ok(ancestry || command.args.includes('pid=,lstart=,command='), 'Known OS observation port');
    const rows = [...processes].map(([pid, row]) => `${pid} ${ancestry ? `${row.parent} ` : ''}${start} ${row.command}`);
    if (ancestry) rows.push(`${process.pid} ${callerPid} ${start} fixture-cli`);
    return { exitCode: 0, stdout: rows.join('\n'), stderr: '' };
  };
  const services = await createServices(store, configuration, {
    orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(directory, 'catalog.json'),
    statePath: join(directory, 'state.sqlite'), tmpRoot, mode: 'production', commandStartedAtMs: 0,
    resolveCaller: async () => claimedCaller,
  }, { execute });
  function seed(addressId: string, runId = `${addressId}-run`, role = 'test-scaffold'): SessionRecord {
    const pid = ++nextPid;
    const command = `z398-unit-agent --run ${runId}`;
    processes.set(pid, { parent: 0, command });
    const row: SessionRecord = {
      runId, addressId, revision: 1, state: 'running',
      activity: { type: role, project: 'raf', features: ['complete-raf-flow-contracts'], phase: role, cwd: directory },
      process: { pid, startedAt, runner: 'codex', runnerSessionId: `native-${runId}`, tmuxSession: addressId,
        evidence: { command, runId, ...boot } },
      launchContext: fullLaunchContext(directory),
    };
    store.sessionRepository.transaction(tx => { tx.putSession(row); tx.putReservation({ runId, resource: 'ram', amount: 1 }); });
    return row;
  }
  const get = (row: SessionRecord) => store.sessionRepository.transaction(tx => tx.getSession(row.runId))!;
  const put = (row: SessionRecord) => store.sessionRepository.transaction(tx => tx.putSession(row));
  return { directory, store, seed, get, put, processes, ps: () => services.control.ps(),
    caller(row?: SessionRecord, claim?: unknown) { callerPid = row?.process?.pid ?? 0; claimedCaller = claim; },
    scanError() { scanError = true; },
  };
}
