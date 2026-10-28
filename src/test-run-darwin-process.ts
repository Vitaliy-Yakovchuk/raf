import { execFileSync, spawnSync } from 'node:child_process';
import { darwinStart } from './resource-wait-identity.ts';

export function darwinTestBoot(): string {
  return execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).trim();
}

export function darwinTestStart(pid: number): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.status !== 0) throw new Error('Client identity scan failed');
  const row = result.stdout.trim().match(/^(\S+)\s+(.+)$/);
  if (!row) throw new Error('Invalid client process status');
  return /^[ZX]/.test(row[1]) ? null : darwinStart(row[2]);
}

export function darwinTestRows(): { pid: number; parent: number; group: number; start: string; ramBytes: number }[] {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,rss=,lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  return output.split('\n').filter(line => line.trim()).flatMap(line => {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/);
    if (!row) throw new Error('Malformed client identity scan');
    return /^[ZX]/.test(row[4]) ? [] : [{ pid: Number(row[1]), parent: Number(row[2]), group: Number(row[3]), ramBytes: Number(row[5]) * 1024, start: darwinStart(row[6]) }];
  });
}

export function darwinTestTree(pgid: number): { pid: number; start: string }[] {
  const rows = darwinTestRows();
  const owned = new Set([pgid, ...rows.filter(row => row.group === pgid).map(row => row.pid)]);
  for (let size = -1; size !== owned.size;) { size = owned.size; for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid); }
  return rows.filter(row => owned.has(row.pid));
}
