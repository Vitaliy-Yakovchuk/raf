import { readFileSync, readdirSync } from 'node:fs';
import { darwinTestBoot, darwinTestRows, darwinTestStart, sameDarwinTestBoot } from './test-run-darwin-process.ts';
import type { TestRunTreeObservation } from './test-run-reservations.ts';

export function observeReservedTestTree(identity: string | null): TestRunTreeObservation {
  const unknown: TestRunTreeObservation = { state: 'unknown', processIdentity: identity, consumed: null };
  if (!identity) return unknown;
  try {
    const root = JSON.parse(identity);
    if (!Number.isSafeInteger(root.pid) || root.pid <= 0 || typeof root.start !== 'string' || !root.start || typeof root.boot !== 'string') return unknown;
    if (process.platform === 'darwin') {
      if (!sameDarwinTestBoot(root.boot, darwinTestBoot())) return { state: 'dead', processIdentity: identity, consumed: null };
      const rows = darwinTestRows();
      const actual = rows.find(row => row.pid === root.pid);
      if (actual && actual.start !== root.start) return unknown;
      const owned = new Set(rows.filter(row => row.group === root.pid).map(row => row.pid));
      if (actual) owned.add(root.pid);
      for (let size = -1; size !== owned.size;) { size = owned.size; for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid); }
      return { state: owned.size ? 'alive' : 'dead', processIdentity: identity,
        consumed: owned.size ? { ramBytes: rows.filter(row => owned.has(row.pid)).reduce((sum, row) => sum + row.ramBytes, 0), diskBytes: {} } : null };
    }
    if (root.boot !== readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()) return { state: 'dead', processIdentity: identity, consumed: null };
    const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        const raw = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        return fields[0] === 'Z' ? [] : [{ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] }];
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    });
    const actual = rows.find(row => row.pid === root.pid);
    if (actual && actual.start !== root.start) return unknown;
    const owned = new Set(rows.filter(row => row.group === root.pid).map(row => row.pid));
    if (actual) owned.add(root.pid);
    for (let size = -1; size !== owned.size;) { size = owned.size; for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid); }
    if (!owned.size) return { state: 'dead', processIdentity: identity, consumed: null };
    let ramBytes = 0;
    for (const pid of owned) {
      const rss = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
      if (!rss) return { state: 'alive', processIdentity: identity, consumed: null };
      ramBytes += Number(rss[1]) * 1024;
    }
    return { state: 'alive', processIdentity: identity, consumed: { ramBytes, diskBytes: {} } };
  } catch { return unknown; }
}

export function testWrapperIdentity(): string {
  if (process.platform === 'darwin') {
    const start = darwinTestStart(process.pid);
    if (!start) throw new Error('Client process absent');
    return JSON.stringify({ pid: process.pid, start, boot: darwinTestBoot() });
  }
  const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return JSON.stringify({ pid: process.pid, start: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
}
