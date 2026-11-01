import { readFileSync, readdirSync } from 'node:fs';
import type { TestRunTreeObservation } from './test-run-reservations.ts';

export function observeReservedTestTree(identity: string | null): TestRunTreeObservation {
  const unknown: TestRunTreeObservation = { state: 'unknown', processIdentity: identity, consumed: null };
  if (!identity) return unknown;
  try {
    const root = JSON.parse(identity);
    if (!Number.isSafeInteger(root.pid) || root.pid <= 0 || typeof root.start !== 'string' || !root.start || typeof root.boot !== 'string') return unknown;
    if (root.boot !== readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()) return { state: 'dead', processIdentity: identity, consumed: null };
    const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        const raw = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        return fields[0] === 'Z' ? [] : [{ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] }];
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ESRCH') return [];
        throw error;
      }
    });
    const actual = rows.find(row => row.pid === root.pid);
    if (actual && actual.start !== root.start) return unknown;
    const owned = new Set(rows.filter(row => row.group === root.pid).map(row => row.pid));
    if (actual) owned.add(root.pid);
    for (let size = -1; size !== owned.size;) { size = owned.size; for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid); }
    if (!owned.size) return { state: 'dead', processIdentity: identity, consumed: null };
    let ramBytes = 0;
    let aliveCount = 0;
    for (const pid of owned) {
      try {
        const rss = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
        if (!rss) return { state: 'alive', processIdentity: identity, consumed: null };
        ramBytes += Number(rss[1]) * 1024;
        aliveCount++;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ESRCH') continue;
        throw error;
      }
    }
    if (!aliveCount) return { state: 'dead', processIdentity: identity, consumed: null };
    return { state: 'alive', processIdentity: identity, consumed: { ramBytes, diskBytes: {} } };
  } catch { return unknown; }
}

export function testWrapperIdentity(): string {
  const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return JSON.stringify({ pid: process.pid, start: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
}
