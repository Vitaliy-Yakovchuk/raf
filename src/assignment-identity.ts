import { createHash } from 'node:crypto';
import { constants, type BigIntStats, type BigIntStatsFs } from 'node:fs';
import { lstat, statfs, realpath, open, readdir, mkdtemp, mkdir, writeFile, readFile, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep, dirname } from 'node:path';
import { readAssignmentTasks, type AssignmentSnapshot } from './assignment.ts';
import type { AdapterCommandExecutor } from './agent-adapters.ts';
import type { ReservedTaskResolution, ReservedTaskSnapshot } from './task-reservations.ts';
import { executeCommand } from './os-runtime.ts';

type Guard = { path: string; stat: BigIntStats; handle: FileHandle; entries?: string[] };
type Source = { path: string; instance: string; location: 'active' | 'archive' };
const safeName = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const failure = (code: 'TASK_IDENTITY_INVALID' | 'TASK_SOURCE_UNKNOWN', reason: string) => Object.assign(new Error(reason), { code });
const tuple = (stat: BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs].map(String);
const signature = (stat: BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size, stat.mode].map(String).join(':');
const instance = (root: string, stat: BigIntStats) => JSON.stringify(['raf-local-change-v1', root, ...tuple(stat)]);
const fingerprint = (project: string, root: string, change: string, source: string, id: string, description: string) => createHash('sha256').update(JSON.stringify(['raf-task-fingerprint-v1', project, root, change, source, id, description])).digest('hex');
const supportedFilesystems = new Set(['darwin:26', `linux:${0xEF53n}`, `linux:${0x01021994n}`]);
const frozenTask = (task: ReservedTaskSnapshot): ReservedTaskSnapshot => Object.freeze({ key: Object.freeze({ ...task.key }), changeInstance: task.changeInstance, fingerprint: task.fingerprint });

export function createAssignmentIdentityAdapter(
  projectRoots: Readonly<Record<string, string>>,
  options: {
    execute?: AdapterCommandExecutor;
    lstat?: (path: string) => Promise<BigIntStats>;
    statfs?: (path: string) => Promise<BigIntStatsFs>;
    platform?: NodeJS.Platform;
  } = {},
): {
  capture(project: string, assignment: AssignmentSnapshot): Promise<readonly ReservedTaskSnapshot[]>;
  resolveTasks(tasks: readonly ReservedTaskSnapshot[]): Promise<readonly ReservedTaskResolution[]>;
} {
  const roots = Object.assign(Object.create(null), projectRoots) as Record<string, string>;
  const execute = options.execute ?? executeCommand;
  const inspect = options.lstat ?? (path => lstat(path, { bigint: true }));
  const filesystem = options.statfs ?? (path => statfs(path, { bigint: true }));
  const platform = options.platform ?? process.platform;

  async function rootFor(project: string): Promise<string> {
    if (!Object.hasOwn(roots, project) || !isAbsolute(roots[project])) throw failure('TASK_IDENTITY_INVALID', `Unknown canonical project ${project}`);
    return realpath(roots[project]);
  }

  function decode(value: string, root: string): void {
    let data: unknown;
    try { data = JSON.parse(value); } catch { throw failure('TASK_IDENTITY_INVALID', 'Malformed serialized source identity'); }
    if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'raf-local-change-v1' || data[1] !== root || !data.slice(2).every(part => typeof part === 'string' && /^(0|[1-9][0-9]*)$/.test(part)) || BigInt(data[3]) <= 0n || BigInt(data[4]) <= 0n || JSON.stringify(data) !== value) throw failure('TASK_IDENTITY_INVALID', 'Malformed source identity or canonical root mismatch');
  }

  async function guarded<T>(root: string, action: (access: {
    inspectPath(path: string, optional?: boolean): Promise<BigIntStats | undefined>;
    probe(path: string, optional?: boolean): Promise<BigIntStats | undefined>;
    entries(path: string): Promise<string[]>;
    bytes(path: string, optional?: boolean): Promise<Buffer | undefined>;
    verify(): Promise<void>;
  }) => Promise<T>): Promise<T> {
    const guards = new Map<string, Guard>();
    const absent = new Set<string>();
    const contained = (path: string) => { const part = relative(root, path); if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error(`Path outside canonical root: ${path}`); };
    const observed = new Map<string, BigIntStats>();
    async function probe(path: string, optional = false): Promise<BigIntStats | undefined> {
      contained(path);
      const known = guards.get(path)?.stat ?? observed.get(path);
      if (known) return known;
      if (path !== root) {
        const parent = await inspectPath(dirname(path), optional);
        if (!parent) { absent.add(path); return undefined; }
        if (!parent.isDirectory()) throw new Error(`Non-directory parent: ${dirname(path)}`);
      }
      let stat: BigIntStats;
      try { stat = await inspect(path); }
      catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') { absent.add(path); return undefined; } throw error; }
      const type = (await filesystem(path)).type;
      if (typeof type !== 'bigint' || !supportedFilesystems.has(`${platform}:${type}`) || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || typeof stat.dev !== 'bigint' || stat.dev < 0n || typeof stat.ino !== 'bigint' || stat.ino <= 0n || typeof stat.birthtimeNs !== 'bigint' || stat.birthtimeNs <= 0n || typeof stat.ctimeNs !== 'bigint' || typeof stat.mtimeNs !== 'bigint') throw new Error(`Unsupported local source on platform ${platform} with filesystem type 0x${typeof type === 'bigint' ? type.toString(16) : String(type)}: ${path}`);
      observed.set(path, stat);
      return stat;
    }
    async function inspectPath(path: string, optional = false): Promise<BigIntStats | undefined> {
      const known = guards.get(path);
      if (known) return known.stat;
      const stat = await probe(path, optional);
      if (!stat) return undefined;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : 0));
      try {
        if (signature(await handle.stat({ bigint: true })) !== signature(stat) || signature(await inspect(path)) !== signature(stat)) throw new Error(`Source changed while opening: ${path}`);
        guards.set(path, { path, stat, handle });
      } catch (error) { await handle.close(); throw error; }
      return stat;
    }
    async function entries(path: string): Promise<string[]> {
      const stat = await inspectPath(path);
      if (!stat?.isDirectory()) throw new Error(`Expected source directory: ${path}`);
      const guard = guards.get(path)!;
      const names = (await readdir(path)).sort();
      if (guard.entries && JSON.stringify(guard.entries) !== JSON.stringify(names)) throw new Error(`Directory entries changed: ${path}`);
      guard.entries = names;
      return [...names];
    }
    async function bytes(path: string, optional = false): Promise<Buffer | undefined> {
      const stat = await inspectPath(path, optional);
      if (!stat) return undefined;
      if (!stat.isFile()) throw new Error(`Expected regular source file: ${path}`);
      return guards.get(path)!.handle.readFile();
    }
    async function verify(): Promise<void> {
      for (const guard of guards.values()) {
        if (signature(await guard.handle.stat({ bigint: true })) !== signature(guard.stat) || signature(await inspect(guard.path)) !== signature(guard.stat)) throw new Error(`Source read race: ${guard.path}`);
        if (guard.entries && JSON.stringify((await readdir(guard.path)).sort()) !== JSON.stringify(guard.entries)) throw new Error(`Directory read race: ${guard.path}`);
      }
      for (const [path, stat] of observed) if (!guards.has(path) && signature(await inspect(path)) !== signature(stat)) throw new Error(`Source candidate race: ${path}`);
      for (const path of absent) {
        try { await inspect(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        throw new Error(`Previously absent source input appeared: ${path}`);
      }
    }
    try {
      await inspectPath(root);
      const result = await action({ inspectPath, probe, entries, bytes, verify });
      await verify();
      return result;
    } finally { await Promise.all([...guards.values()].map(guard => guard.handle.close())); }
  }

  async function readSource<T>(root: string, change: string, choose: (access: Parameters<Parameters<typeof guarded>[1]>[0]) => Promise<Source>, consume: (source: Source, rows: Awaited<ReturnType<typeof readAssignmentTasks>>) => T): Promise<T> {
    return guarded(root, async access => {
      const source = await choose(access);
      const view = await mkdtemp(join(tmpdir(), 'raf-assignment-read-'));
      try {
        const target = join(view, 'openspec', 'changes', change);
        await mkdir(target, { recursive: true, mode: 0o700 });
        async function copy(path: string, destination: string, optional = true): Promise<void> {
          const content = await access.bytes(path, optional);
          if (content !== undefined) { await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, content, { mode: 0o600 }); }
        }
        await copy(join(source.path, 'tasks.md'), join(target, 'tasks.md'), false);
        await copy(join(source.path, '.openspec.yaml'), join(target, '.openspec.yaml'));
        await copy(join(root, 'openspec', 'config.yaml'), join(view, 'openspec', 'config.yaml'));
        await copy(join(root, 'openspec', 'config.yml'), join(view, 'openspec', 'config.yml'));
        const localSchema = join(root, 'openspec', 'schemas', 'spec-driven', 'schema.yaml');
        if (await access.inspectPath(localSchema, true)) throw new Error('Project-local schema overrides require a verified input plan');
        for (const artifact of ['proposal.md', 'design.md']) await copy(join(source.path, artifact), join(target, artifact));
        async function copySpecs(path: string, destination: string): Promise<void> {
          const stat = await access.inspectPath(path, true);
          if (!stat) return;
          if (!stat.isDirectory()) throw new Error(`Expected specs directory: ${path}`);
          for (const name of await access.entries(path)) {
            const child = join(path, name);
            const childStat = await access.inspectPath(child);
            if (childStat!.isDirectory()) await copySpecs(child, join(destination, name));
            else if (name.endsWith('.md')) await copy(child, join(destination, name), false);
          }
        }
        await copySpecs(join(source.path, 'specs'), join(target, 'specs'));
        await access.verify();
        const version = await execute({ executable: 'openspec', args: ['--version'], cwd: view });
        if (version.exitCode !== 0 || version.stdout.trim() !== '1.14.3') throw new Error('Unverified OpenSpec version; the supported read plan requires 1.14.3');
        const readRows = () => readAssignmentTasks(view, change, {
          cli: { async exec(args, cwd) {
            const result = await execute({ executable: 'openspec', args, cwd });
            if (result.exitCode === 0) {
              let data: any;
              try { data = JSON.parse(result.stdout); } catch { return result; }
              if ((options.execute === undefined || data.schemaName !== undefined) && data.schemaName !== 'spec-driven') throw new Error(`Unsupported apply schema: ${data.schemaName}`);
              if (data.references?.length) throw new Error('Linked OpenSpec reference inputs require a verified read plan');
              if (data.unavailableTrackingFiles?.length) throw new Error('OpenSpec tracking inputs unavailable');
            }
            return result;
          } },
          fs: { readText: path => readFile(path, 'utf8') },
        });
        let rows: Awaited<ReturnType<typeof readAssignmentTasks>>;
        if (options.execute === undefined) {
          const resolution = await execute({ executable: 'openspec', args: ['schema', 'which', 'spec-driven', '--json'], cwd: view });
          if (resolution.exitCode !== 0) throw new Error(`Cannot verify package schema: ${resolution.stderr || resolution.stdout}`);
          const schema = JSON.parse(resolution.stdout);
          if (schema.source !== 'package' || schema.name !== 'spec-driven' || typeof schema.path !== 'string' || !isAbsolute(schema.path)) throw new Error('Unverified user or external schema override; only the package spec-driven read plan is supported');
          const schemaRoot = await realpath(schema.path);
          rows = await guarded(schemaRoot, async schemaAccess => {
            const content = await schemaAccess.bytes(join(schemaRoot, 'schema.yaml'));
            if (!content || createHash('sha256').update(content).digest('hex') !== 'b6f28f305ab7f33b061949251bba82c79de66c82424cfed60582327db3f888f2') throw new Error('Unverified package schema inputs for the supported OpenSpec 1.14.3 read plan');
            const destination = join(view, 'openspec', 'schemas', 'spec-driven');
            await mkdir(destination, { recursive: true, mode: 0o700 });
            await writeFile(join(destination, 'schema.yaml'), content, { mode: 0o600 });
            await schemaAccess.verify();
            return readRows();
          });
        } else rows = await readRows();
        await access.verify();
        return consume(source, rows);
      } finally { await rm(view, { recursive: true, force: true }); }
    });
  }

  return {
    async capture(project, assignment) {
      const selection = structuredClone(assignment);
      const context = `${project} assignment`;
      try {
        if (!selection || !isAbsolute(selection.root) || !Array.isArray(selection.changes) || !selection.changes.length) throw failure('TASK_IDENTITY_INVALID', 'Empty or invalid assignment');
        const seen = new Set<string>();
        for (const change of selection.changes) {
          if (!safeName(change.id) || seen.has(change.id) || !Array.isArray(change.items) || !change.items.length || new Set(change.items.map(item => item.id)).size !== change.items.length || change.items.some(item => typeof item.id !== 'string' || !item.id || typeof item.description !== 'string' || !item.description)) throw failure('TASK_IDENTITY_INVALID', 'Invalid, duplicate or traversal selection');
          seen.add(change.id);
        }
        const root = await rootFor(project);
        let selectedRoot: string;
        try { selectedRoot = await realpath(selection.root); }
        catch { throw failure('TASK_IDENTITY_INVALID', 'Assignment root cannot resolve to canonical project root'); }
        if (selectedRoot !== root) throw failure('TASK_IDENTITY_INVALID', 'Assignment root differs from canonical project root');
        const result: ReservedTaskSnapshot[] = [];
        for (const change of selection.changes) {
          const captured = await readSource(root, change.id, async access => {
            const path = join(root, 'openspec', 'changes', change.id);
            const stat = await access.inspectPath(path);
            if (!stat?.isDirectory()) throw new Error(`Source is not a regular directory: ${path}`);
            return { path, instance: instance(root, stat), location: 'active' };
          }, (source, rows) => change.items.map(item => {
            const matches = rows.filter(row => row.id === item.id);
            if (matches.length !== 1 || matches[0].description !== item.description || matches[0].done) throw failure('TASK_IDENTITY_INVALID', `Selected ${change.id}/${item.id} is missing, ambiguous, changed or completed`);
            return frozenTask({ key: { project, changeId: change.id, taskId: item.id }, changeInstance: source.instance, fingerprint: fingerprint(project, root, change.id, source.instance, item.id, matches[0].description) });
          }));
          result.push(...captured);
        }
        return Object.freeze(result);
      } catch (error) {
        if ((error as { code?: string }).code === 'TASK_IDENTITY_INVALID') throw failure('TASK_IDENTITY_INVALID', `${context}: ${message(error)}`);
        throw failure('TASK_SOURCE_UNKNOWN', `${context}: ${message(error)}; main must verify the source and retry`);
      }
    },
    async resolveTasks(tasks) {
      const requested = tasks.map(task => frozenTask(task));
      const counts = new Map<string, number>();
      const key = (task: ReservedTaskSnapshot) => JSON.stringify([task.key.project, task.key.changeId, task.changeInstance, task.key.taskId]);
      for (const task of requested) counts.set(key(task), (counts.get(key(task)) ?? 0) + 1);
      const results: ReservedTaskResolution[] = [];
      for (const task of requested) {
        const context = `${task.key.project}/${task.key.changeId}/${task.key.taskId}`;
        try {
          if (!safeName(task.key.changeId) || typeof task.key.project !== 'string' || typeof task.key.taskId !== 'string' || !task.key.taskId || typeof task.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(task.fingerprint) || counts.get(key(task)) !== 1) throw failure('TASK_IDENTITY_INVALID', 'Malformed or duplicate selected snapshot');
          if (!Object.hasOwn(roots, task.key.project)) throw failure('TASK_IDENTITY_INVALID', 'Unknown canonical project');
          let encoded: unknown;
          try { encoded = JSON.parse(task.changeInstance); } catch { throw failure('TASK_IDENTITY_INVALID', 'Malformed serialized source identity'); }
          if (!Array.isArray(encoded) || typeof encoded[1] !== 'string' || !isAbsolute(encoded[1])) throw failure('TASK_IDENTITY_INVALID', 'Malformed serialized source identity');
          decode(task.changeInstance, encoded[1]);
          const root = await rootFor(task.key.project);
          decode(task.changeInstance, root);
          const resolution = await readSource(root, task.key.changeId, async access => {
            const active = join(root, 'openspec', 'changes', task.key.changeId);
            const matches: Source[] = [];
            let replacement = false;
            const consider = async (path: string, location: 'active' | 'archive', relevant: boolean, optional = false) => {
              const stat = await access.probe(path, optional);
              if (!stat) return;
              if (!stat.isDirectory()) throw new Error(`Non-directory source candidate: ${path}`);
              if (instance(root, stat) !== task.changeInstance) { if (relevant) replacement = true; return; }
              const opened = await access.inspectPath(path);
              const identity = instance(root, opened!);
              if (identity !== task.changeInstance) throw new Error(`Source changed while opening: ${path}`);
              matches.push({ path, instance: identity, location });
            };
            await consider(active, 'active', true, true);
            const archive = join(root, 'openspec', 'changes', 'archive');
            const archiveStat = await access.inspectPath(archive, true);
            if (archiveStat) {
              for (const name of await access.entries(archive)) {
                const path = join(archive, name);
                const stat = await access.probe(path);
                if (stat!.isFile()) continue;
                await consider(path, 'archive', name === task.key.changeId || (/^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === task.key.changeId));
              }
            }
            if (matches.length > 1) throw new Error('Ambiguous exact source directory identity');
            if (!matches.length) {
              await access.verify();
              if (replacement) throw failure('TASK_IDENTITY_INVALID', 'Original source replaced or copied; no exact directory instance found');
              throw new Error('Original source directory is missing');
            }
            return matches[0];
          }, (source, rows): ReservedTaskResolution => {
            const matches = rows.filter(row => row.id === task.key.taskId);
            if (matches.length !== 1 || fingerprint(task.key.project, root, task.key.changeId, task.changeInstance, task.key.taskId, matches[0].description) !== task.fingerprint) return { state: 'mismatch', requested: task, reason: `${context}: task number/description/fingerprint changed; main must reconcile the original assignment` };
            if (source.location === 'archive' && (!rows.length || rows.some(row => !row.done) || new Set(rows.map(row => row.id)).size !== rows.length)) return { state: 'mismatch', requested: task, reason: `${context}: archive contains open or ambiguous tasks; main must reconcile` };
            return { state: matches[0].done ? 'completed' : 'open', task, location: source.location };
          });
          results.push(resolution);
        } catch (error) {
          results.push({ state: (error as { code?: string }).code === 'TASK_IDENTITY_INVALID' ? 'mismatch' : 'unknown', requested: task, reason: `${context}: ${message(error)}; main must verify the source and retry` });
        }
      }
      return Object.freeze(results);
    },
  };
}
