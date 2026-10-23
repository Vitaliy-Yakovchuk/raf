import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AdapterCommandExecutor } from './agent-adapters.ts';
import type { ProtocolSettings } from './runner-protocols.ts';

export interface RunnerPathEnvironment {
  readonly PATH?: string;
}

export interface RunnerPathPorts {
  isExecutableFile(path: string): Promise<boolean>;
}

export type RunnerExecutableResolution =
  | { readonly status: 'resolved'; readonly path: string }
  | { readonly status: 'missing'; readonly reason: string };

export type RunnerAvailability =
  | { readonly runner: string; readonly available: true; readonly path: string; readonly version: string; readonly warnings: readonly string[] }
  | { readonly runner: string; readonly available: false; readonly reason: string };

export interface RunnerAvailabilityDependencies {
  readonly env: RunnerPathEnvironment;
  readonly execute: AdapterCommandExecutor;
  readonly ports?: Partial<RunnerPathPorts>;
}

const defaultPorts: RunnerPathPorts = {
  isExecutableFile: async path => {
    try { return (await stat(path)).isFile() && (await access(path, constants.X_OK), true); }
    catch { return false; }
  },
};

export async function resolveRunnerExecutable(runner: string, executable: string, env: RunnerPathEnvironment, ports: Partial<RunnerPathPorts> = {}): Promise<RunnerExecutableResolution> {
  const isExecutableFile = ports.isExecutableFile ?? defaultPorts.isExecutableFile;
  if (executable.includes('/')) {
    if (!isAbsolute(executable)) return { status: 'missing', reason: `RUNNER_PROTOCOL_UNAVAILABLE: runner ${runner}: шлях команди ${executable} має бути назвою без / або абсолютним шляхом` };
    return await isExecutableFile(executable) ? { status: 'resolved', path: executable } : { status: 'missing', reason: `Runner ${runner}: команда ${executable} не є виконуваним файлом` };
  }
  if (!executable) return { status: 'missing', reason: `Runner ${runner}: назву команди не задано` };
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, executable);
    if (await isExecutableFile(candidate)) return { status: 'resolved', path: candidate };
  }
  return { status: 'missing', reason: `Runner ${runner}: команду ${executable} не знайдено в PATH` };
}

export async function probeRunnerAvailability(settings: Pick<ProtocolSettings, 'runner' | 'executable' | 'version'>, dependencies: RunnerAvailabilityDependencies): Promise<RunnerAvailability> {
  const runner = settings.runner;
  if (typeof settings.executable !== 'string' || typeof settings.version !== 'string' || !settings.version.trim()) return { runner, available: false, reason: `Runner ${runner}: протокол не задає executable і version` };
  const resolution = await resolveRunnerExecutable(runner, settings.executable, dependencies.env, dependencies.ports);
  if (resolution.status === 'missing') return { runner, available: false, reason: resolution.reason };
  let result;
  try { result = await dependencies.execute({ executable: resolution.path, args: ['--version'] }); }
  catch (error) { return { runner, available: false, reason: `Runner ${runner}: ${resolution.path} --version не виконано: ${error instanceof Error ? error.message : String(error)}` }; }
  if (result.exitCode !== 0 || !result.stdout.trim().split(/\s+/).includes(settings.version)) return { runner, available: false, reason: `Runner ${runner}: версія не перевірена: очікується ${settings.version}, ${resolution.path} --version повернув код ${result.exitCode} і вивід ${JSON.stringify(result.stdout.trim())}` };
  return { runner, available: true, path: resolution.path, version: settings.version };
}
