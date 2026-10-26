import { watch } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentReportRequest } from './agent-report.ts';

export interface ConfirmationInputs {
  snapshot(): Promise<string>;
  subscribe(listener: () => void): Promise<() => void>;
}

export function reportConfirmationInputs(request: AgentReportRequest): ConfirmationInputs {
  let directories = new Set<string>();
  const root = request.assignment.root;
  const changes = join(root, 'openspec/changes');
  const archive = join(changes, 'archive');
  const ids = request.assignment.changes.map(change => change.id);
  return {
    async snapshot() {
      const entries: [string, string][] = [];
      const nextDirectories = new Set<string>();
      const inspect = async (path: string, tree = false): Promise<boolean> => {
        nextDirectories.add(dirname(path));
        let stat;
        try { stat = await lstat(path, { bigint: true }); }
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { entries.push([path, 'absent']); return false; } throw error; }
        if (stat.isDirectory()) {
          nextDirectories.add(path);
          entries.push([path, [stat.dev, stat.ino, stat.mode].join(':')]);
          if (tree) for (const name of (await readdir(path).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; })).sort()) await inspect(join(path, name), true);
        } else entries.push([path, [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')]);
        return stat.isDirectory();
      };
      const inspectSource = async (path: string) => {
        if (!await inspect(path)) return;
        for (const name of ['tasks.md', 'proposal.md', 'design.md', '.openspec.yaml']) await inspect(join(path, name));
        await inspect(join(path, 'specs'), true);
      };
      for (const id of ids) await inspectSource(join(changes, id));
      nextDirectories.add(changes);
      nextDirectories.add(archive);
      const archived = await readdir(archive).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const name of archived.sort()) if (ids.some(id => name === id || /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === id)) await inspectSource(join(archive, name));
      for (const path of ['conf/raf.json', 'conf/projects.json', 'conf/flow.json', 'openspec/config.yaml', 'openspec/config.yml', 'openspec/schemas/spec-driven/schema.yaml']) await inspect(join(root, path));
      for (const repository of request.reportedCommits?.repositories ?? []) {
        for (const name of ['HEAD', 'index', 'index.lock', 'raf-task-checkbox.lock']) await inspect(join(repository.gitDirectory, name));
        for (const name of ['packed-refs', 'refs']) await inspect(join(repository.commonDirectory, name), name === 'refs');
      }
      directories = nextDirectories;
      return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
    },
    async subscribe(listener) {
      const watchers: ReturnType<typeof watch>[] = [];
      const watched = new Set<string>();
      try {
        for (let path of directories) {
          while (!watched.has(path)) {
            try {
              const watcher = watch(path, listener);
              watcher.on('error', error => process.emitWarning(String(error)));
              watchers.push(watcher); watched.add(path); break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
              path = dirname(path);
            }
          }
        }
      } catch (error) { for (const watcher of watchers) watcher.close(); throw error; }
      return () => { for (const watcher of watchers) watcher.close(); };
    },
  };
}

export async function onConfirmationInputChange(inputs: ConfirmationInputs, before: string, listener: (error?: unknown) => void): Promise<() => void> {
  let stopped = false;
  let checking = false;
  let again = false;
  let unsubscribe = () => {};
  const stop = () => { stopped = true; unsubscribe(); };
  const check = async () => {
    again = true;
    if (checking || stopped) return;
    checking = true;
    try {
      while (again && !stopped) {
        again = false;
        if (await inputs.snapshot() !== before && !stopped) { stop(); listener(); }
      }
    } catch (error) { if (!stopped) { stop(); listener(error); } }
    finally { checking = false; }
  };
  unsubscribe = await inputs.subscribe(() => { void check(); });
  if (stopped) unsubscribe();
  await check();
  return stop;
}

export async function waitForConfirmationInput(inputs: ConfirmationInputs, before: string, deadline: number): Promise<void> {
  let stop = () => {};
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
      void onConfirmationInputChange(inputs, before, error => error ? reject(error) : resolve()).then(dispose => { if (finished) dispose(); else stop = dispose; }, reject);
    });
  } finally { finished = true; if (timer) clearTimeout(timer); stop(); }
}
