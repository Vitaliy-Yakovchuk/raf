import { activeRafCost, rafCostBoundary } from './raf-cost-runtime.ts';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { lstat, readlink, readFile, realpath } from 'node:fs/promises';
import { availableParallelism, loadavg, totalmem, platform, hostname } from 'node:os';
import { posix } from 'node:path';
import type { AdapterCommandExecutor } from './agent-adapters.ts';
import type { WorkspaceRoutingDependencies } from './workspace-routing.ts';
import type { ResourceMeasurement } from './resource-admission.ts';
import type { ProcessIdentity, ProcessObservation } from './session-state.ts';
import { admitGit } from './git.ts';

export const executeCommand: AdapterCommandExecutor = async command => {
  if (basename(command.executable) === 'git') admitGit(command.args);
  const profile = activeRafCost();
  const helper = profile?.helperExecutables.includes(basename(command.executable));
  const start = helper ? rafCostBoundary() : undefined;
  const execute = () => new Promise<import('./agent-adapters.ts').AdapterCommandResult>((resolve, reject) => {
  const child = spawn(command.executable, [...command.args], { cwd: command.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...(command.environment ?? process.env), LC_ALL: 'C' } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  child.on('error', reject);
  child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
  child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
  child.stdin.end(command.stdin ?? '');
  });
  try { return profile ? await profile.measure('child-wait', execute) : await execute(); }
  finally {
    if (profile && start && helper) {
      const end = rafCostBoundary();
      try { profile.profiler.recordChild({ stage: 'child-wait', startedAt: start.utc, completedAt: end.utc, wallMs: Math.max(0, end.monotonicMs - start.monotonicMs),
        cpu: { userMs: null, systemMs: null, source: null, unavailableReason: 'Per-child OS CPU accounting unavailable from spawn' } }, 'helper'); }
      catch (error) { profile.reportStorageFailure(error); }
    }
  }
};

export async function readMachineBootIdentity(execute: AdapterCommandExecutor = executeCommand): Promise<{ machineId: string; bootId: string }> {
  let machineId: string;
  let bootId: string;
  if (platform() === 'darwin') {
    const result = await execute({ executable: 'sysctl', args: ['-n', 'kern.boottime'] });
    if (result.exitCode !== 0) throw new Error('Cannot establish OS boot identity');
    machineId = hostname();
    bootId = result.stdout.trim();
  } else if (platform() === 'linux') {
    machineId = (await readFile('/etc/machine-id', 'utf8')).trim();
    bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } else throw new Error('Unsupported OS boot identity');
  if (!machineId || !bootId) throw new Error('Missing machine or boot identity');
  return { machineId, bootId };
}

export function createWorkspacePorts(): WorkspaceRoutingDependencies {
  return {
    async pathKind(path) {
      try { const stat = await lstat(path); return stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
    },
    readLink: readlink,
    realPath: realpath,
  };
}

export interface ProcessScanDependencies { execute?: AdapterCommandExecutor; now?: () => string; platform?: () => NodeJS.Platform; readProcessStat?: (pid: number) => Promise<string>; }

export async function observeKnownProcesses(identities: readonly ProcessIdentity[], dependencies: ProcessScanDependencies = {}): Promise<ProcessObservation[]> {
  if (!identities.length) return [];
  const observedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const unknown = (error: string): ProcessObservation => ({ state: 'unknown', observedAt, error });
  const exited = (evidence: string): ProcessObservation => ({ state: 'exited', observedAt, exitCode: null, evidence });
  const valid = (identity: ProcessIdentity) => Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    !!identity.evidence.command && Number.isFinite(Date.parse(identity.startedAt));
  const pids = [...new Set(identities.filter(valid).map(identity => identity.pid))];
  const facts = new Map<number, { start: string; command: string } | ProcessObservation>();
  const host = dependencies.platform?.() ?? platform();
  const readStat = dependencies.readProcessStat ?? (pid => fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'));
  const stamp = async (pid: number) => {
    const source = await readStat(pid);
    const match = source.match(/^(\d+) \(.*\) ([\s\S]+)$/);
    const fields = match?.[2].trim().split(/\s+/);
    if (Number(match?.[1]) !== pid || !fields || !/^\d+$/.test(fields[19] ?? '') || fields.length < 20) throw new Error('Malformed targeted process stat');
    return fields[19];
  };
  const before = new Map<number, string>();
  await Promise.all(pids.map(async pid => {
    if (host !== 'linux') { before.set(pid, ''); return; }
    try { before.set(pid, await stamp(pid)); }
    catch (error) { facts.set(pid, (error as NodeJS.ErrnoException).code === 'ENOENT' ? exited('PID absent before targeted observation') : unknown(String(error))); }
  }));
  const selected = pids.filter(pid => before.has(pid));
  if (selected.length) {
    try {
      const result = await (dependencies.execute ?? executeCommand)({ executable: 'ps', args: ['-ww', '-p', selected.join(','), '-o', 'pid=,lstart=,command='] });
      if (result.exitCode !== 0 && !(result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim())) throw new Error('Targeted process observation failed: ' + result.stderr);
      const rows = new Map<number, { start: string; command: string }>();
      for (const line of result.stdout.split('\n').filter(line => line.trim())) {
        const match = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
        if (!match || !Number.isFinite(Date.parse(match[2])) || rows.has(Number(match[1])) || !before.has(Number(match[1]))) throw new Error('Malformed targeted process observation');
        rows.set(Number(match[1]), { start: match[2], command: match[3] });
      }
      await Promise.all(selected.map(async pid => {
        try {
          const proof = before.get(pid) ?? '';
          const after = host === 'linux' ? await stamp(pid) : '';
          if (proof !== after) facts.set(pid, exited('Process identity changed during targeted observation'));
          else if (rows.has(pid)) facts.set(pid, rows.get(pid)!);
          else if (proof === '') facts.set(pid, exited('PID absent from targeted process observation'));
          else facts.set(pid, unknown('PID present in targeted stat but absent from process observation'));
        } catch (error) { facts.set(pid, (error as NodeJS.ErrnoException).code === 'ENOENT' ? exited('PID absent from targeted process observation') : unknown('Process disappeared or became unreadable during targeted observation: ' + String(error))); }
      }));
    } catch (error) { for (const pid of selected) facts.set(pid, unknown(String(error))); }
  }
  return identities.map(identity => {
    if (!valid(identity)) return unknown('Missing process identity evidence');
    const fact = facts.get(identity.pid)!;
    if ('state' in fact) return fact;
    if (Date.parse(fact.start) !== Date.parse(identity.startedAt) || fact.command !== identity.evidence.command) return exited('Process identity mismatch: PID reused');
    return { state: 'alive', observedAt, identity };
  });
}

export async function observeProcessSnapshot(dependencies: ProcessScanDependencies = {}): Promise<(identities: readonly ProcessIdentity[]) => ProcessObservation[]> {
  const observedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const unknown = (error: string): ProcessObservation => ({ state: 'unknown', observedAt, error });
  try {
    const result = await (dependencies.execute ?? executeCommand)({ executable: 'ps', args: ['-ww', '-axo', 'pid=,lstart=,command='] });
    if (result.exitCode !== 0) return identities => identities.map(() => unknown('Process scan failed'));
    const rows = new Map<number, { start: string; command: string }>();
    for (const line of result.stdout.split('\n').filter(line => line.trim())) {
      const match = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      if (!match) return identities => identities.map(() => unknown('Malformed process scan'));
      rows.set(Number(match[1]), { start: match[2].replace(/\s+/g, ' '), command: match[3] });
    }
    return identities => identities.map(identity => {
      const expected = identity.evidence.command;
      if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !expected || !Number.isFinite(Date.parse(identity.startedAt))) return unknown('Missing process identity evidence');
      if (Date.parse(observedAt) < Date.parse(identity.startedAt)) return unknown('Process snapshot predates process start; take a fresh process scan');
      const row = rows.get(identity.pid);
      if (!row) return { state: 'exited', observedAt, exitCode: null, evidence: 'PID absent from successful process scan' };
      if (Date.parse(row.start) !== Date.parse(identity.startedAt) || row.command !== expected) return { state: 'exited', observedAt, exitCode: null, evidence: 'Process identity mismatch: PID reused' };
      return { state: 'alive', observedAt, identity };
    });
  } catch { return identities => identities.map(() => unknown('Process scan failed')); }
}

export async function observeProcesses(identities: readonly ProcessIdentity[], dependencies: ProcessScanDependencies = {}): Promise<ProcessObservation[]> {
  if (!identities.length) return [];
  return (await observeProcessSnapshot(dependencies))(identities);
}

export interface ResourceSnapshot { measurement: ResourceMeasurement; reasons: string[]; fileSystemByPath: Record<string, string>; }
export interface ResourceSnapshotOptions { machineId: string; paths: readonly string[]; }
export interface ResourceProbeDependencies {
  platform: () => string;
  loadAverage1m: () => number;
  availableCores: () => number;
  totalRamBytes: () => number;
  readFile: (path: string) => Promise<string>;
  execute: AdapterCommandExecutor;
}
export interface ResourceSnapshotReader { read(): Promise<ResourceSnapshot>; }

export function createResourceSnapshotReader(options: ResourceSnapshotOptions, dependencies?: ResourceProbeDependencies): ResourceSnapshotReader {
  const deps = dependencies ?? { platform, loadAverage1m: () => loadavg()[0], availableCores: availableParallelism, totalRamBytes: totalmem, readFile: (path: string) => readFile(path, 'utf8'), execute: executeCommand };
  let inflight: Promise<ResourceSnapshot> | undefined;
  async function probe(): Promise<ResourceSnapshot> {
    const reasons: string[] = [];
    const measurement: ResourceMeasurement = { machineId: options.machineId, loadAverage1m: NaN, availableCores: NaN, totalRamBytes: NaN, availableRamBytes: NaN, memoryPressure: 'unknown', fileSystems: [] };
    const fileSystemByPath: Record<string, string> = {};
    const command = async (executable: string, args: string[]) => { const result = await deps.execute({ executable, args }); if (result.exitCode !== 0) throw new Error(`${executable} probe failed`); return result.stdout; };
    try { measurement.loadAverage1m = deps.loadAverage1m(); measurement.availableCores = deps.availableCores(); measurement.totalRamBytes = deps.totalRamBytes(); } catch { reasons.push('Host resource measurements unavailable'); }
    try {
      if (deps.platform() === 'darwin') {
        const [vm, pressure] = await Promise.all([command('vm_stat', []), command('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])]);
        const page = Number(vm.match(/page size of (\d+) bytes/)?.[1]);
        const pages = (label: string) => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1]);
        measurement.availableRamBytes = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page;
        measurement.memoryPressure = pressure.trim() === '4' ? 'critical' : ['1', '2'].includes(pressure.trim()) ? 'normal' : 'unknown';
      } else if (deps.platform() === 'linux') {
        try {
          const psi = await deps.readFile('/proc/pressure/memory');
          const pressureRows = psi.trim().split('\n');
          const parsedPressure = pressureRows.length === 2 && ['some', 'full'].every(kind => pressureRows.some(row => {
            const match = row.match(/^(some|full) avg10=(\d+(?:\.\d+)?) avg60=(\d+(?:\.\d+)?) avg300=(\d+(?:\.\d+)?) total=(\d+)$/);
            return match?.[1] === kind && match.slice(2).every(value => Number.isFinite(Number(value)));
          }));
          measurement.memoryPressure = parsedPressure ? 'normal' : 'unknown';
          if (!parsedPressure) reasons.push('Malformed PSI in /proc/pressure/memory');
        } catch { reasons.push('PSI source /proc/pressure/memory unavailable'); }
        const mem = await deps.readFile('/proc/meminfo');
        measurement.totalRamBytes = Number(mem.match(/^MemTotal:\s+(\d+) kB/m)?.[1]) * 1024;
        measurement.availableRamBytes = Number(mem.match(/^MemAvailable:\s+(\d+) kB/m)?.[1]) * 1024;
        const membership = await deps.readFile('/proc/self/cgroup');
        const relative = membership.match(/^0::(.*)$/m)?.[1];
        if (relative === undefined) throw new Error('Unsupported cgroup hierarchy');
        const mountInfo = await deps.readFile('/proc/self/mountinfo');
        const mount = mountInfo.split('\n').find(line => line.includes(' - cgroup2 '))?.split(' ');
        if (!mount) throw new Error('Cgroup mount unavailable');
        const root = mount[3];
        const mountPoint = mount[4];
        if (relative !== root && !relative.startsWith(root.replace(/\/$/, '') + '/')) throw new Error('Cgroup membership outside mount');
        let directory = posix.join(mountPoint, relative.slice(root === '/' ? 1 : root.length)).replace(/\/$/, '');
        while (directory === mountPoint || directory.startsWith(mountPoint + '/')) {
          const isRoot = directory === mountPoint;
          const readCgroupValue = (file: string) => deps.readFile(`${directory}/${file}`).catch(error => {
            if (isRoot && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'max';
            throw error;
          });
          const [cpu, memory, current] = await Promise.all([readCgroupValue('cpu.max'), readCgroupValue('memory.max'), readCgroupValue('memory.current')]);
          const [quota, period] = cpu.trim().split(/\s+/);
          if (quota !== 'max') measurement.availableCores = Math.min(measurement.availableCores, Number(quota) / Number(period));
          if (memory.trim() !== 'max') {
            measurement.totalRamBytes = Math.min(measurement.totalRamBytes, Number(memory));
            measurement.availableRamBytes = Math.min(measurement.availableRamBytes, Math.max(0, Number(memory) - Number(current)));
          }
          if (isRoot) break;
          directory = posix.dirname(directory);
        }
      } else reasons.push('Unsupported resource probe platform');
    } catch { reasons.push('Memory or environment resource probe unavailable'); measurement.memoryPressure = 'unknown'; }
    try {
      if (options.paths.length) {
        const output = await command('df', ['-Pk', ...new Set(options.paths)]);
        const volumes = output.trim().split('\n').slice(1).map(line => {
          const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/);
          if (!match) throw new Error('Malformed filesystem measurement');
          return { id: match[1], totalBytes: Number(match[2]) * 1024, availableBytes: Number(match[4]) * 1024, mount: match[5] };
        });
        for (const [index, path] of [...new Set(options.paths)].entries()) {
          const absolute = posix.resolve(path);
          const volume = volumes.length === new Set(options.paths).size ? volumes[index] : volumes.filter(volume => absolute === volume.mount || absolute.startsWith(volume.mount.replace(/\/$/, '') + '/')).sort((a, b) => b.mount.length - a.mount.length)[0];
          if (!volume) { reasons.push(`Filesystem probe unavailable: ${path}`); continue; }
          fileSystemByPath[path] = volume.id;
          if (!measurement.fileSystems.some(fs => fs.id === volume.id)) measurement.fileSystems.push({ id: volume.id, totalBytes: volume.totalBytes, availableBytes: volume.availableBytes });
        }
      }
    } catch { reasons.push('Filesystem probe unavailable'); }
    for (const key of ['loadAverage1m', 'availableCores', 'totalRamBytes', 'availableRamBytes'] as const) if (!Number.isFinite(measurement[key]) || measurement[key] < 0) reasons.push(`Invalid ${key}`);
    if (measurement.memoryPressure === 'unknown') reasons.push('Memory pressure unknown');
    return { measurement, reasons, fileSystemByPath };
  }
  return { read() { if (!inflight) inflight = probe().finally(() => { inflight = undefined; }); return inflight; } };
}
