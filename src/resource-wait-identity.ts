import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { executeCommand, readMachineBootIdentity } from './os-runtime.ts';
import type { ResourceWaitIdentity, ResourceWaitClientObservation } from './resource-wait-protocol.ts';

let bootIdentity: ReturnType<typeof readMachineBootIdentity> | undefined;

export async function readWaitIdentity(pid = process.pid): Promise<ResourceWaitIdentity> {
  const boot = await (bootIdentity ??= readMachineBootIdentity());
  let startedAt: string;
  if (platform() === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') throw Object.assign(new Error('Client process exited'), { code: 'ESRCH' });
    startedAt = fields[19];
    if (!/^\d+$/.test(startedAt)) throw new Error('Invalid client start ticks');
  } else if (platform() === 'darwin') {
    const result = await executeCommand({ executable: 'ps', args: ['-p', String(pid), '-o', 'stat=,lstart='] });
    if (result.exitCode !== 0 || !result.stdout.trim()) throw Object.assign(new Error('Client process absent'), { code: 'ESRCH' });
    const row = result.stdout.trim().match(/^(\S+)\s+(.+)$/);
    if (!row) throw new Error('Invalid client process status');
    if (/^[ZX]/.test(row[1])) throw Object.assign(new Error('Client process exited'), { code: 'ESRCH' });
    startedAt = row[2].replace(/\s+/g, ' ');
  } else throw new Error('Unsupported client identity platform');
  return { pid, startedAt, ...boot };
}

export async function observeWaitIdentities(identities: readonly ResourceWaitIdentity[]): Promise<ResourceWaitClientObservation[]> {
  if (platform() !== 'darwin') return Promise.all(identities.map(observeWaitIdentity));
  try {
    const boot = await (bootIdentity ??= readMachineBootIdentity());
    const result = await executeCommand({ executable: 'ps', args: ['-axo', 'pid=,stat=,lstart='] });
    if (result.exitCode !== 0) throw new Error('Client identity scan failed');
    const starts = new Map<number, string>();
    for (const line of result.stdout.split('\n').filter(line => line.trim())) {
      const row = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/);
      if (!row) throw new Error('Malformed client identity scan');
      if (!/^[ZX]/.test(row[2])) starts.set(Number(row[1]), row[3].replace(/\s+/g, ' '));
    }
    return identities.map(identity => starts.get(identity.pid) === identity.startedAt && identity.machineId === boot.machineId && identity.bootId === boot.bootId
      ? { state: 'alive', identity } : { state: 'dead', reason: 'Client absent or process/boot identity changed' });
  } catch (error) { return identities.map(() => ({ state: 'unknown', reason: error instanceof Error ? error.message : String(error) })); }
}

export async function observeWaitIdentity(identity: ResourceWaitIdentity): Promise<ResourceWaitClientObservation> {
  try {
    const current = await readWaitIdentity(identity.pid);
    if ((['startedAt', 'machineId', 'bootId'] as const).some(key => current[key] !== identity[key])) return { state: 'dead', reason: 'Client process identity changed (PID reuse or boot)' };
    return { state: 'alive', identity: current };
  } catch (error) {
    return { state: ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'dead' : 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function verifyWaitPeer(socket: import('node:net').Socket, identity: ResourceWaitIdentity, timeoutMs: number): Promise<void> {
  const { spawn } = await import('node:child_process');
  const fd = (socket as unknown as { _handle?: { fd: number } })._handle?.fd;
  if (!Number.isSafeInteger(fd) || fd! < 0 || !identity) throw new Error('Unix peer identity cannot be established');
  const script = `import os,socket,struct,sys
s=socket.socket(fileno=3)
if sys.platform=='linux':
 p,u,g=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
elif sys.platform=='darwin':
 import ctypes
 p=struct.unpack('i',s.getsockopt(0,2,4))[0]
 u=ctypes.c_uint()
 g=ctypes.c_uint()
 if ctypes.CDLL(None,use_errno=True).getpeereid(3,ctypes.byref(u),ctypes.byref(g))!=0: raise OSError(ctypes.get_errno(),'getpeereid')
 u=u.value
else:
 raise RuntimeError('OS peer PID verification unavailable')
print(str(p)+' '+str(u))`;
  const peer = await new Promise<string>((resolve, reject) => {
    const child = spawn('python3', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe', fd!] });
    let output = '';
    let errorOutput = '';
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(stop, timeoutMs);
    socket.once('close', stop);
    child.stdout.on('data', data => { output += data; if (output.length > 1024) stop(); });
    child.stderr.on('data', data => { errorOutput += data; if (errorOutput.length > 4096) stop(); });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); socket.off('close', stop); if (code === 0) resolve(output.trim()); else reject(new Error(`Unix peer verification failed: ${errorOutput.trim() || 'helper interrupted'}`)); });
  });
  const [pid, uid] = peer.split(' ').map(Number);
  if (pid !== identity.pid || uid !== process.getuid?.()) throw new Error('Claimed client PID does not match Unix peer credentials');
}

export async function tryWaitLease(path: string, timeoutMs?: number): Promise<{ release(): Promise<void> } | null> {
  const { open } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const file = await open(path, 'a+', 0o600);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('python3', ['-c', `import fcntl,sys
try: fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(2)`], { stdio: ['ignore', 'ignore', 'ignore', file.fd] });
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGKILL'), Math.max(1, timeoutMs));
      child.once('error', reject);
      child.once('close', code => { if (timer) clearTimeout(timer); resolve(code); });
    });
    if (code === 2) { await file.close(); return null; }
    if (code !== 0) throw new Error('OS service lock unavailable; python3 with fcntl is required');
    let released = false;
    return { release: async () => { if (!released) { released = true; await file.close(); } } };
  } catch (error) { await file.close(); throw error; }
}
