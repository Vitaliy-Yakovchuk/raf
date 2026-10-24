import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { aggregateRafCostSample, mergeRafCostRows, createRafCostProfiler, type RafCostKey, type RafCostProfiler, type RafCostProfilePorts, type RafCostProfileRepository, type RafCostRow } from './raf-cost-profile.ts';
import type { StateStore } from './state-store.ts';

export type RafCostBoundary = { monotonicMs: number; utc: string; cpu: NodeJS.CpuUsage };
export const rafCostBoundary = (): RafCostBoundary => ({ monotonicMs: performance.now(), utc: new Date().toISOString(), cpu: process.cpuUsage() });

export function readRafCostPolicy(root = fileURLToPath(new URL('../../', import.meta.url))): RafCostProfilePorts['policy'] {
  const settings = JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8')).costProfile;
  const catalog = JSON.parse(readFileSync(join(root, 'conf/raf-constants.json'), 'utf8'));
  if (!Number.isSafeInteger(settings?.schemaVersion) || settings.schemaVersion <= 0 || !Array.isArray(settings.stages) || !settings.stages.length ||
      settings.stages.some((stage: unknown) => typeof stage !== 'string' || !stage) || new Set(settings.stages).size !== settings.stages.length) throw new Error('Invalid conf/raf.json#/costProfile');
  return { ...settings, commands: catalog.commands.filter((command: any) => command.handlerName !== 'help').map((command: any) => command.path.join(' ')) };
}

const current = new AsyncLocalStorage<RafCostRuntime>();
let background: RafCostRuntime | undefined;
export const activeRafCost = () => current.getStore() ?? background;

export class RafCostRuntime {
  readonly profiler: RafCostProfiler;
  readonly helperExecutables: readonly string[];
  private readonly work = new Map<symbol, string>();
  private idle: string;
  private stopped = false;
  private storageFailure: unknown;
  private readonly pending = new Map<string, RafCostRow>();
  private readonly repository: RafCostProfileRepository;
  constructor(store: StateStore, identity: Pick<RafCostKey, 'scope' | 'command'>, root: string, idle: string, initial = rafCostBoundary(), sqliteStartedAt?: RafCostBoundary) {
    this.idle = idle;
    this.repository = store.costProfileRepository;
    const repository: RafCostProfileRepository = identity.scope === 'command' ? {
      update: (key, change) => {
        const id = JSON.stringify([key.scope, key.command, key.stage, key.executor]);
        this.pending.set(id, change(this.pending.get(id)));
      },
      readRows: () => store.costProfileRepository.readRows(),
    } : store.costProfileRepository;
    if (sqliteStartedAt) {
      repository.update({ ...identity, stage: 'startup/config', executor: 'self' }, previous => aggregateRafCostSample(previous, { ...identity, stage: 'startup/config', executor: 'self', startedAt: initial.utc, completedAt: sqliteStartedAt.utc, wallMs: Math.max(0, sqliteStartedAt.monotonicMs - initial.monotonicMs), cpu: { userMs: (sqliteStartedAt.cpu.user - initial.cpu.user) / 1000, systemMs: (sqliteStartedAt.cpu.system - initial.cpu.system) / 1000, source: 'process.cpuUsage', unavailableReason: null } }));
      initial = sqliteStartedAt;
    }
    const settings = JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8')).costProfile;
    if (!Array.isArray(settings.helperExecutables) || settings.helperExecutables.some((name: unknown) => typeof name !== 'string' || !name)) throw new Error('Invalid conf/raf.json#/costProfile/helperExecutables');
    this.helperExecutables = settings.helperExecutables;
    let firstWall = true, firstCpu = true, firstUtc = true;
    this.profiler = createRafCostProfiler(identity, {
      repository, policy: readRafCostPolicy(root),
      monotonicMs: () => { if (firstWall) { firstWall = false; return initial.monotonicMs; } return performance.now(); },
      utcNow: () => { if (firstUtc) { firstUtc = false; return initial.utc; } return new Date().toISOString(); },
      cpuUsage: () => { const cpu = firstCpu ? initial.cpu : process.cpuUsage(); firstCpu = false; return { userMicros: cpu.user, systemMicros: cpu.system }; },
    });
    this.profiler.start(sqliteStartedAt ? 'sqlite' : 'startup/config');
    this.profiler.transition(idle);
  }
  install(): void { background = this; }
  stage(stage: string): void { this.idle = stage; if (!this.work.size) this.transition(stage); }
  private transition(stage: string): void {
    if (this.stopped || this.storageFailure) return;
    try { this.profiler.transition(stage); }
    catch (error) { this.reportStorageFailure(error); }
  }
  reportStorageFailure(error: unknown): void {
    this.storageFailure ??= error;
    process.emitWarning(error instanceof Error ? error : String(error));
  }
  async measure<T>(stage: string, action: () => Promise<T>): Promise<T> {
    const token = Symbol();
    this.work.set(token, stage);
    this.transition(this.work.size > 1 ? 'shared-work' : stage);
    try { return await current.run(this, action); }
    finally {
      this.work.delete(token);
      this.transition(this.work.size > 1 ? 'shared-work' : this.work.values().next().value ?? this.idle);
    }
  }
  finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (background === this) background = undefined;
    this.profiler.finish();
    for (const contribution of this.pending.values()) this.repository.update(contribution, previous => mergeRafCostRows(previous, contribution));
    this.pending.clear();
    if (this.storageFailure) throw this.storageFailure;
  }
}

export async function measureRafCost<T>(stage: string, action: () => Promise<T>): Promise<T> {
  const profile = activeRafCost();
  return profile ? profile.measure(stage, action) : action();
}
