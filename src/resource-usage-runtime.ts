import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, lstatSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionRecord } from './session-state.ts';
import { ResourceUsageRepository, ResourceUsageTracker } from './resource-usage.ts';
import type { UsageConfiguration, UsageContext, UsageDiskReading, UsageFile, UsageMeasurementPort, UsageProcessIdentity } from './resource-usage.ts';

export const usageConfigurationRoot = fileURLToPath(new URL('../../', import.meta.url));
export const readUsageConfiguration = (root: string): UsageConfiguration => ({
  flow: JSON.parse(readFileSync(join(root, 'conf/flow.json'), 'utf8')),
  raf: JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8')),
});
export function usageProcessIdentity(pid: number): UsageProcessIdentity | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || !fields[19]) return null;
    return { pid, startTicks: fields[19], bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  } catch { return null; }
}
const sameProcess = (a: UsageProcessIdentity | null, b: UsageProcessIdentity | null) => !!a && !!b && a.pid === b.pid && a.startTicks === b.startTicks && a.bootId === b.bootId;
const under = (path: string, directory: string) => path === directory || path.startsWith(directory.replace(/\/$/, '') + '/');

export function createUsageMeasurement(repository: ResourceUsageRepository): UsageMeasurementPort {
  const disk = (context: UsageContext, processes: UsageProcessIdentity[], baseline = false): UsageDiskReading[] => {
    const owned = context.attributedPaths ?? [];
    return context.requiredFileSystems.map(volume => {
      const files: UsageFile[] = [];
      const reasons: string[] = baseline ? [] : ['Changes in shared development directories cannot be fully attributed to this run'];
      const devices = new Set(volume.paths.flatMap(path => { try { return [String(statSync(path).dev)]; } catch { reasons.push('Filesystem path unavailable'); return []; } }));
      const attributed = owned.some(path => {
        for (let ancestor = path;; ancestor = dirname(ancestor)) {
          try { return devices.has(String(statSync(ancestor).dev)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) return false; }
        }
      });
      if (!attributed) reasons.push('No run-owned output scope is available on this filesystem');
      const record = (path: string, actual = path) => {
        const info = statSync(actual);
        if (!info.isFile() || !devices.has(String(info.dev))) return;
        files.push({ fileSystemId: volume.id, deviceId: String(info.dev), inode: String(info.ino), path,
          allocatedBytes: info.blocks * 512, logicalBytes: info.size, attribution: info.nlink > 1 ? { kind: 'shared' } : { kind: 'run', key: { kind: context.identity.kind, id: context.identity.id } } });
      };
      const walk = (path: string) => {
        try {
          const info = lstatSync(path);
          if (info.isSymbolicLink()) return;
          if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
          else record(path);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reasons.push('Run-owned files could not be inspected'); }
      };
      for (const directory of owned) walk(directory);
      for (const process of processes) {
        try {
          if (!sameProcess(process, usageProcessIdentity(process.pid))) { reasons.push('Process identity changed during disk sample'); continue; }
          for (const fd of readdirSync(`/proc/${process.pid}/fd`)) {
            try {
              const path = readlinkSync(`/proc/${process.pid}/fd/${fd}`).replace(/ \(deleted\)$/, '');
              if (owned.some(directory => under(path, directory))) record(path, `/proc/${process.pid}/fd/${fd}`);
            } catch { reasons.push('Open file changed during sample'); }
          }
        } catch { reasons.push('Open files unavailable'); }
      }
      return { fileSystemId: volume.id, files, complete: baseline && !reasons.length, reasons: [...new Set(reasons)] };
    });
  };
  return {
    baseline: context => ({ at: Date.now(), disk: disk(context, [], true) }),
    sample: (identity, at) => {
      const context = repository.get(identity)?.context;
      const reasons: string[] = [];
      const rows: { identity: UsageProcessIdentity; parent: UsageProcessIdentity | null; rssBytes: number }[] = [];
      const root = identity.root;
      if (root && root.bootId === identity.bootId && sameProcess(root, usageProcessIdentity(root.pid))) {
        const candidates = new Map<number, { identity: UsageProcessIdentity; parentPid: number }>();
        for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
          try {
            const pid = Number(name), process = usageProcessIdentity(pid);
            if (!process) { reasons.push('Process scan could not establish every process identity'); continue; }
            const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
            candidates.set(pid, { identity: process, parentPid: Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1]) });
          } catch { reasons.push('Process scan was incomplete'); }
        }
        const included = new Set([root.pid]);
        for (let size = -1; size !== included.size;) { size = included.size; for (const [pid, row] of candidates) if (included.has(row.parentPid)) included.add(pid); }
        for (const pid of included) {
          try {
            const row = candidates.get(pid);
            if (!row || !sameProcess(row.identity, usageProcessIdentity(pid))) throw new Error('Identity changed');
            const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
            if (!match) throw new Error('RSS unavailable');
            if (!sameProcess(row.identity, usageProcessIdentity(pid))) throw new Error('Identity changed after RSS read');
            rows.push({ identity: row.identity, parent: pid === root.pid ? null : candidates.get(row.parentPid)?.identity ?? null, rssBytes: Number(match[1]) * 1024 });
          } catch { reasons.push('A process disappeared or RSS was unavailable during sample'); }
        }
        if (!sameProcess(root, usageProcessIdentity(root.pid))) { rows.length = 0; reasons.push('Root identity changed during sample'); }
      } else reasons.push('Root process identity is unavailable or changed');
      return { identity, at, ram: rows.length ? { method: 'rss-sampled', processes: rows, complete: !reasons.length, reasons } : null,
        disk: context ? disk(context, rows.map(row => row.identity)) : [], reasons };
    },
  };
}

const runtimes = new WeakMap<DatabaseSync, { tracker: ResourceUsageTracker; repository: ResourceUsageRepository; measurement: UsageMeasurementPort }>();
export function runtimeResourceUsage(database: DatabaseSync, root = usageConfigurationRoot) {
  let runtime = runtimes.get(database);
  if (!runtime) {
    const repository = new ResourceUsageRepository(database);
    const measurement = createUsageMeasurement(repository);
    runtime = { repository, measurement, tracker: new ResourceUsageTracker({ repository, measurement, configuration: readUsageConfiguration(root) }) };
    for (const record of repository.listActive()) if (record.startedAt !== null) runtime.tracker.reconcile(record.context.identity, {
      at: Date.now(), state: 'unknown', reasons: ['Usage observer reattached; the interval since the previous persisted sample is unverified'],
    });
    runtimes.set(database, runtime);
  }
  return runtime;
}

export function accountSessionUsage(database: DatabaseSync, session: SessionRecord, root = usageConfigurationRoot): void {
  const context = session.launchContext?.resourceUsageContext;
  const old = database.prepare('SELECT payload FROM resource_usage WHERE kind = ? AND run_id = ?').get('agent', session.runId);
  if (!context && !old) return;
  const { tracker, repository, measurement } = runtimeResourceUsage(database, root);
  const at = Date.now();
  let record = repository.get({ kind: 'agent', id: session.runId });
  if (!record && context) record = tracker.prepare(context, true, at);
  if (!record || record.finishedAt !== null) return;
  if (session.state === 'running' && session.process && (record.startedAt === null || record.context.identity.root === null)) {
    const process = usageProcessIdentity(session.process.pid);
    let verified = false;
    if (process && process.bootId === record.context.identity.bootId) {
      try {
        const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
        const boot = Number(readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
        verified = hz > 0 && Math.abs(boot * 1000 + Number(process.startTicks) / hz * 1000 - Date.parse(session.process.startedAt)) < 1000;
      } catch {}
    }
    const startedAt = Date.parse(session.process.startedAt);
    if (Number.isFinite(startedAt)) tracker.started({ ...record.context.identity, root: verified ? process : null }, startedAt);
    record = repository.get(record.context.identity)!;
  }
  const identity = record.context.identity;
  if (record.startedAt !== null) {
    try { tracker.observe(measurement.sample(identity, at)); }
    catch { tracker.observe({ identity, at, ram: null, disk: [], reasons: ['Agent lifecycle measurement unavailable'] }); }
  }
  if (session.state === 'running' && session.observation?.state === 'unknown') tracker.reconcile(identity, { at, state: 'unknown', reasons: [session.observation.error] });
  if (session.state === 'exited' || session.state === 'finished') tracker.finish(identity, { at,
    reason: record.startedAt === null ? 'spawn-failure' : session.observation?.state === 'exited' ? session.observation.finishReason ?? (session.observation.exitCode === null ? 'death' : 'exit') : 'death',
    verifiedComplete: false, reasons: ['Agent lifecycle ended; final continuous peak is unverified'] });
}
