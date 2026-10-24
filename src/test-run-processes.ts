export async function cleanupTestProcessGroup(pid: number, ports: {
  tree(pgid: number): { pid: number; start: string }[];
  start(pid: number): string | null;
  kill(pid: number): void;
  settle(rootSignalled: boolean, signalled: { pid: number; start: string }[]): Promise<void>;
}): Promise<{ complete: boolean; remainingPids: number[] }> {
  const owned = ports.tree(pid);
  let rootSignalled = false;
  const signalled: { pid: number; start: string }[] = [];
  for (const row of owned.reverse()) if (ports.start(row.pid) === row.start) {
    try { ports.kill(row.pid); signalled.push(row); if (row.pid === pid) rootSignalled = true; } catch { }
  }
  try { ports.kill(-pid); rootSignalled = true; } catch { }
  await ports.settle(rootSignalled, signalled);
  const remainingPids = [...new Set([...ports.tree(pid).map(row => row.pid), ...owned.filter(row => ports.start(row.pid) === row.start).map(row => row.pid)])];
  return { complete: remainingPids.length === 0, remainingPids };
}

export async function reconcileTestRunProcess(identity: string | null, deadline: number, ports: {
  now(): number;
  boot(): string;
  start(pid: number): string | null;
  tree(pid: number): { pid: number; start: string }[];
  cleanup(pid: number): Promise<{ complete: boolean; remainingPids: number[] }>;
}): Promise<{ alive: boolean; deadlineReached: boolean; cleanup: { complete: boolean; remainingPids: number[] } }> {
  const deadlineReached = ports.now() >= deadline;
  const gone = { alive: false, deadlineReached: false, cleanup: { complete: true, remainingPids: [] } };
  if (!identity) return { alive: true, deadlineReached, cleanup: { complete: false, remainingPids: [] } };
  let processId: any;
  try { processId = JSON.parse(identity); } catch { return { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [] } }; }
  if (!Number.isSafeInteger(processId?.pid) || processId.pid <= 0 || typeof processId.start !== 'string' || typeof processId.boot !== 'string') return { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [] } };
  const start = ports.start(processId.pid);
  if (processId.boot !== ports.boot()) return gone;
  if (start !== null && start !== processId.start) return { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [] } };
  const alive = start !== null && start === processId.start;
  const remainingPids = ports.tree(processId.pid).map(row => row.pid);
  if (!alive && !remainingPids.length) return gone;
  if (!deadlineReached) return { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids } };
  const cleanup = await ports.cleanup(processId.pid);
  return { alive: !cleanup.complete, deadlineReached: true, cleanup };
}

