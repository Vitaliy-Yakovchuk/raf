import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

type Inspection = 'quiescent' | 'incompatible' | 'unknown';
type ProcessEntry = { uid: number; identity?: string };
type Capture = { code: number; stdout: string; stderr: string; helperPid: number };

function capture(executable: string, args: string[]): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed || error.signal)) { reject(error); return; }
      if (!child.pid) { reject(new Error('Process inspection helper identity unavailable')); return; }
      resolve({ code: error?.code ?? 0, stdout, stderr, helperPid: child.pid });
    });
  });
}

async function processes(uid: number, run: typeof capture): Promise<Map<number, ProcessEntry>> {
  const result = await run('/bin/ps', ['-axo', 'pid=,uid=,lstart=,comm=']);
  if (result.code !== 0 || result.stderr.trim()) throw new Error('Incomplete process snapshot');
  const rows = new Map<number, ProcessEntry>();
  for (const line of result.stdout.split('\n').filter(line => line.trim())) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!row) throw new Error('Malformed process snapshot');
    const pid = Number(row[1]), owner = Number(row[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(owner) || rows.has(pid)) throw new Error('Ambiguous process snapshot');
    if (pid === process.pid || pid === result.helperPid) continue;
    if (owner !== uid) { rows.set(pid, { uid: owner }); continue; }
    const identity = /^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(row[3]);
    if (!identity || !Number.isFinite(Date.parse(identity[1] + ' UTC'))) throw new Error('Unproved process identity');
    rows.set(pid, { uid: owner, identity: identity[1].replace(/\s+/g, ' ') + '\0' + identity[2] });
  }
  return rows;
}

function targets(statePath: string) {
  const values = [statePath, statePath + '-wal', statePath + '-shm'].map(path => {
    try {
      const info = statSync(path, { bigint: true });
      if (!info.isFile()) throw new Error('State target is not a regular file');
      return `${info.dev}:${info.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  });
  return { identities: new Set(values.filter((value): value is string => value !== null)), stamp: JSON.stringify(values) };
}

function descriptors(stdout: string, eligible: Set<number>, uid: number, identities: Set<string>) {
  if (stdout && !stdout.endsWith('\0\n')) throw new Error('Truncated descriptor inventory');
  const covered = new Set<number>();
  let owner: number | undefined;
  let processUid: number | undefined;
  let file: { kind?: string; device?: string; inode?: string } | undefined;
  let held = false;
  const finishFile = () => {
    if (!file) return;
    if (!file.kind || /unknown|unkn|\?/i.test(file.kind)) throw new Error('Unproved descriptor type');
    if (file.kind === 'REG') {
      if (!file.device || !file.inode) throw new Error('Incomplete regular-file identity');
      if (identities.has(`${BigInt(file.device)}:${BigInt(file.inode)}`)) held = true;
    }
    file = undefined;
  };
  const finishProcess = () => {
    finishFile();
    if (owner !== undefined && processUid !== uid) throw new Error('Unproved descriptor owner');
  };
  for (const token of stdout.split('\0')) {
    const field = token.replace(/^\n/, '');
    if (!field) continue;
    const value = field.slice(1);
    switch (field[0]) {
      case 'p': {
        finishProcess();
        if (!/^\d+$/.test(value)) throw new Error('Malformed descriptor process');
        owner = Number(value);
        if (!eligible.has(owner) || covered.has(owner)) throw new Error('Unexpected descriptor process');
        covered.add(owner); processUid = undefined;
        break;
      }
      case 'u':
        if (owner === undefined || file || processUid !== undefined || !/^\d+$/.test(value)) throw new Error('Malformed descriptor owner');
        processUid = Number(value);
        if (processUid !== uid) throw new Error('Descriptor owner changed');
        break;
      case 'f':
        finishFile();
        if (owner === undefined || processUid !== uid || !value || /[\r\n]/.test(value)) throw new Error('Unproved descriptor');
        file = {};
        break;
      case 't':
        if (!file || file.kind || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Malformed descriptor type');
        file.kind = value;
        break;
      case 'D':
        if (!file || file.device || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Malformed descriptor device');
        file.device = value;
        break;
      case 'i':
        if (!file || file.inode || !/^\d+$/.test(value)) throw new Error('Malformed descriptor inode');
        file.inode = value;
        break;
      default: throw new Error('Unknown descriptor inventory field');
    }
  }
  finishProcess();
  return { covered, held };
}

export async function inspectDarwinMigrationClients(statePath: string, run: typeof capture = capture): Promise<Inspection> {
  try {
    const uid = process.getuid?.();
    if (uid === undefined || !Number.isSafeInteger(uid)) return 'unknown';
    const initialTargets = targets(statePath);
    const before = await processes(uid, run);
    const eligible = new Set([...before].filter(([, row]) => row.uid === uid).map(([pid]) => pid));
    let covered = new Set<number>();
    if (eligible.size) {
      const result = await run('/usr/sbin/lsof', ['-nP', '-a', '-u', String(uid), '-p', [...eligible].join(','), '-F0pufDit']);
      if (result.stderr.trim() || result.code !== 0 && !(result.code === 1 && result.stdout === '')) return 'unknown';
      const inspection = descriptors(result.stdout, eligible, uid, initialTargets.identities);
      if (inspection.held) return 'incompatible';
      covered = inspection.covered;
    }
    const after = await processes(uid, run);
    if (initialTargets.stamp !== targets(statePath).stamp) return 'unknown';
    for (const [pid, row] of after) {
      if (row.uid !== uid) continue;
      if (before.get(pid)?.identity !== row.identity || !covered.has(pid)) return 'unknown';
    }
    for (const pid of eligible) {
      const row = after.get(pid);
      if (row && row.uid !== uid) return 'unknown';
    }
    return 'quiescent';
  } catch { return 'unknown'; }
}
