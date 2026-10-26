import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterCommand } from './agent-adapters.ts';
import type { OwnedSessionStartChannel, PrepareSessionStartChannel, SessionStartOrigin } from './agy-session-start.ts';
import type { ProcessIdentity } from './session-state.ts';

const clockTicks = 100;
const hookWaitMs = 2000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hookSource(inbox: string): string {
  return `import { existsSync, writeFileSync } from 'node:fs';
const inbox = ${JSON.stringify(inbox)};
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let payload = null;
try { payload = JSON.parse(raw); } catch { payload = null; }
const name = String(process.pid);
writeFileSync(inbox + '/' + name + '.json', JSON.stringify({ pid: process.pid, payload }));
const ack = inbox + '/' + name + '.ack';
const deadline = Date.now() + ${hookWaitMs};
while (!existsSync(ack) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
process.stdout.write('{}');
`;
}

async function startUnixMs(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
    const btime = Number((await readFile('/proc/stat', 'utf8')).match(/^btime (\d+)$/m)?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    return (btime + ticks / clockTicks) * 1000;
  } catch { return null; }
}

async function hookBelongsToOwned(pid: number, scriptPath: string, owned: ProcessIdentity): Promise<boolean | 'retry'> {
  let cmdline: string;
  try { cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'retry'; }
  if (!cmdline.includes(scriptPath)) return false;
  let current = pid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 8 && current > 1 && !seen.has(current); depth += 1) {
    seen.add(current);
    let status: string;
    try { status = await readFile(`/proc/${current}/status`, 'utf8'); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'retry'; }
    const parent = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(parent)) return false;
    if (parent === owned.pid) {
      const start = await startUnixMs(owned.pid);
      if (start === null || !Number.isFinite(Date.parse(owned.startedAt))) return 'retry';
      return Math.abs(start - Date.parse(owned.startedAt)) < 2000;
    }
    current = parent;
  }
  return false;
}

export const prepareOwnedAgySessionStartChannel: PrepareSessionStartChannel = async input => {
  const writerGeneration = randomUUID();
  const root = join(input.runDirectory, 'agy-session-start', writerGeneration);
  const workspace = join(root, 'workspace');
  const scriptPath = join(workspace, '.agents', 'session-start.mjs');
  const inbox = join(root, 'private', 'inbox');
  const ownedProcessPath = join(input.runDirectory, 'owned-process.json');
  await mkdir(join(workspace, '.agents'), { recursive: true, mode: 0o700 });
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await writeFile(scriptPath, hookSource(inbox), { mode: 0o700 });
  const bare = (value: string) => /^[A-Za-z0-9_./:+-]+$/.test(value);
  const command = bare(process.execPath) && bare(scriptPath) ? `${process.execPath} ${scriptPath}` : `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  await writeFile(join(workspace, '.agents', 'hooks.json'), `${JSON.stringify({ 'raf-owned-session-start': { SessionStart: [{ type: 'command', command }] } })}\n`, { mode: 0o600 });
  const args = [...input.invocation.args];
  if (!args.some((arg, index) => arg === '--add-dir' && args[index + 1] === workspace)) args.push('--add-dir', workspace);
  const invocation: AdapterCommand = { ...input.invocation, args };
  const listeners = new Set<(payload: unknown) => Promise<void>>();
  const origins = new WeakMap<object, SessionStartOrigin>();
  const seen = new Set<string>();
  let closed = false;
  let pumping = false;
  const originFor = async (pid: number): Promise<SessionStartOrigin | null | 'retry'> => {
    let owned: ProcessIdentity;
    try { owned = JSON.parse(await readFile(ownedProcessPath, 'utf8')) as ProcessIdentity; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'retry' : null; }
    if (!owned || typeof owned.pid !== 'number' || typeof owned.startedAt !== 'string') return null;
    const matched = await hookBelongsToOwned(pid, scriptPath, owned);
    if (matched === 'retry') return 'retry';
    if (!matched) return null;
    return { runId: input.runId, workspace: input.workspace, process: owned, writerGeneration };
  };
  const pump = async () => {
    if (closed) return;
    let names: string[];
    try { names = await readdir(inbox); } catch { return; }
    for (const name of names) {
      if (closed || !name.endsWith('.json') || seen.has(name)) continue;
      let record: { pid?: unknown; payload?: unknown };
      try { record = JSON.parse(await readFile(join(inbox, name), 'utf8')) as { pid?: unknown; payload?: unknown }; }
      catch { continue; }
      const payload = record.payload;
      const ack = join(inbox, name.replace(/\.json$/, '.ack'));
      if (typeof record.pid !== 'number' || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
        seen.add(name);
        await writeFile(ack, 'ok').catch(() => undefined);
        continue;
      }
      const origin = await originFor(record.pid);
      if (origin === 'retry') continue;
      seen.add(name);
      if (origin) origins.set(payload, origin);
      await writeFile(ack, 'ok').catch(() => undefined);
      for (const listener of [...listeners]) {
        try { await listener(payload); }
        catch (error) { process.stderr.write(`agy SessionStart listener failed: ${error instanceof Error ? error.message : String(error)}\n`); }
      }
    }
  };
  const timer = setInterval(() => {
    if (pumping || closed) return;
    pumping = true;
    void pump().finally(() => { pumping = false; });
  }, 20);
  timer.unref();
  const channel: OwnedSessionStartChannel = {
    invocation,
    writerGeneration,
    async verifyOrigin(payload: unknown): Promise<SessionStartOrigin | null> {
      if (!payload || typeof payload !== 'object') return null;
      const origin = origins.get(payload);
      if (!origin || origin.runId !== input.runId || origin.workspace !== input.workspace || origin.writerGeneration !== writerGeneration) return null;
      return origin;
    },
    subscribe(listener: (payload: unknown) => Promise<void>) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await rm(root, { recursive: true, force: true });
    },
  };
  return channel;
};
