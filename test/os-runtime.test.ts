import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeCommand, createWorkspacePorts, observeProcesses, createResourceSnapshotReader,
} from '../src/os-runtime.ts';
import type { ResourceProbeDependencies } from '../src/os-runtime.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { ProcessIdentity } from '../src/session-state.ts';

const gib = 1024 ** 3;
const observedAt = '2026-10-21T12:00:00.000Z';
const startedAt = 'Wed Oct 21 11:30:00 2026';
const identity: ProcessIdentity = {
  pid: 2417, startedAt, runner: 'codex', runnerSessionId: 'session-1', tmuxSession: 'agent-a',
  evidence: { command: '/usr/local/bin/codex exec task' },
};
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
const psRow = (pid = 2417, start = startedAt, command = identity.evidence.command) =>
  `${pid} ${start} ${command}\n`;

function probes(platform = 'linux') {
  const calls: AdapterCommand[] = [];
  const files = new Map([
    ['/proc/meminfo', 'MemTotal:       16777216 kB\nMemFree:          1048576 kB\nMemAvailable:   12582912 kB\n'],
    ['/proc/pressure/memory', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
    ['/proc/self/cgroup', '0::/\n'],
    ['/proc/self/mountinfo', '29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n'],
    ['/sys/fs/cgroup/cpu.max', 'max 100000\n'],
    ['/sys/fs/cgroup/memory.max', 'max\n'],
    ['/sys/fs/cgroup/memory.current', '4294967296\n'],
  ]);
  const outputs = new Map([
    ['df', 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 104857600 20971520 83886080 20% /\n/dev/disk1 104857600 20971520 83886080 20% /\n'],
    ['memory_pressure', 'System-wide memory free percentage: 75%\n'],
    ['sysctl', '1\n'],
    ['vm_stat', 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\nPages inactive: 655360.\nPages speculative: 65536.\n'],
  ]);
  const dependencies: ResourceProbeDependencies = {
    platform: () => platform, loadAverage1m: () => 2, availableCores: () => 8,
    totalRamBytes: () => 16 * gib,
    readFile: async path => {
      if (!files.has(path)) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
      return files.get(path)!;
    },
    execute: async command => {
      calls.push(command);
      const name = command.executable.split('/').at(-1)!;
      if (!outputs.has(name)) throw new Error(`Unexpected command ${name}`);
      return ok(outputs.get(name)!);
    },
  };
  return { dependencies, files, outputs, calls };
}

const reader = (dependencies: ResourceProbeDependencies) => createResourceSnapshotReader({ machineId: 'host-a', paths: ['/work', '/tmp'] }, dependencies);

test('executor preserves argv and stdin without shell interpretation', async () => {
  const args = ['$(touch /tmp/raf-must-not-run)', 'semi;colon', 'two words', '"quoted"'];
  const result = await executeCommand({ executable: process.execPath,
    args: ['-e', 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.stringify({args:process.argv.slice(1),stdin:s})))', ...args],
    stdin: 'hello\nworld\n' });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { args, stdin: 'hello\nworld\n' });
});

test('executor exposes nonzero exit and stderr; missing executable rejects', async () => {
  const result = await executeCommand({ executable: process.execPath, args: ['-e', 'process.stderr.write("failed");process.exit(7)'] });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'failed');
  await assert.rejects(executeCommand({ executable: '/nonexistent/raf-command', args: [] }));
});

test('filesystem ports distinguish links including dangling links from their targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-os-'));
  try {
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'file'), 'x');
    await symlink('missing', join(root, 'link'));
    const ports = createWorkspacePorts();
    assert.equal(await ports.pathKind(join(root, 'dir')), 'directory');
    assert.equal(await ports.pathKind(join(root, 'file')), 'file');
    assert.equal(await ports.pathKind(join(root, 'link')), 'symlink');
    assert.equal(await ports.pathKind(join(root, 'missing')), 'missing');
    assert.equal(await ports.readLink(join(root, 'link')), 'missing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('branch port uses argv and cwd, distinguishes detached HEAD and git errors', async () => {
  const calls: AdapterCommand[] = [];
  let response = ok('feature/a\n');
  const ports = createWorkspacePorts(async command => { calls.push(command); return response; });
  assert.equal(await ports.currentBranch('/work space'), 'feature/a');
  assert.equal(calls[0].executable, 'git');
  assert.equal(calls[0].cwd, '/work space');
  assert.ok(calls[0].args.includes('symbolic-ref'));
  response = { exitCode: 1, stdout: '', stderr: '' };
  assert.equal(await ports.currentBranch('/work space'), null);
  response = { exitCode: 128, stdout: '', stderr: 'not a repository' };
  await assert.rejects(ports.currentBranch('/work space'));
});

test('one process scan verifies PID, start time and full command for every identity', async () => {
  let scans = 0;
  const execute: AdapterCommandExecutor = async command => {
    scans++;
    assert.equal(command.executable.split('/').at(-1), 'ps');
    assert.ok(command.args.join(' ').includes('lstart'));
    return ok(psRow() + psRow(2418));
  };
  const results = await observeProcesses([identity, { ...identity, pid: 2418 }], { execute, now: () => observedAt });
  assert.equal(scans, 1);
  assert.deepEqual(results, [identity, { ...identity, pid: 2418 }].map(value => ({ state: 'alive', observedAt, identity: value })));
});

for (const [label, output] of [
  ['missing PID', ''], ['reused PID', psRow(2417, 'Wed Oct 21 11:31:00 2026')],
  ['different command', psRow(2417, startedAt, '/bin/sleep 600')],
] as const) {
  test(`process scan identifies ${label} without trusting tmux`, async () => {
    const [result] = await observeProcesses([identity], { execute: async () => ok(output), now: () => observedAt });
    assert.equal(result.state, 'exited');
  });
}

for (const execute of [
  async () => { throw new Error('permission denied'); },
  async () => ({ exitCode: 1, stdout: '', stderr: 'ps failed' }),
  async () => ok('malformed process table'),
]) {
  test('process probe failures remain unknown, never exited', async () => {
    const [result] = await observeProcesses([identity], { execute, now: () => observedAt });
    assert.equal(result.state, 'unknown');
  });
}

test('missing recorded command evidence is unknown instead of accepting PID alone', async () => {
  const [result] = await observeProcesses([{ ...identity, evidence: {} }], { execute: async () => ok(psRow()), now: () => observedAt });
  assert.equal(result.state, 'unknown');
});

test('Linux uses MemAvailable, PSI and available cores, deduplicating shared disk', async () => {
  const fixture = probes();
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.availableRamBytes, 12 * gib);
  assert.equal(snapshot.measurement.memoryPressure, 'normal');
  assert.equal(snapshot.measurement.loadAverage1m, 2);
  assert.equal(snapshot.measurement.availableCores, 8);
  assert.equal(snapshot.measurement.machineId, 'host-a');
  assert.equal(snapshot.measurement.fileSystems.length, 1);
  assert.equal(snapshot.fileSystemByPath['/work'], snapshot.fileSystemByPath['/tmp']);
  assert.equal(snapshot.measurement.fileSystems[0].availableBytes, 80 * gib);
  assert.deepEqual(snapshot.reasons, []);
});

test('Linux cgroup quota and memory ceiling constrain the host measurements', async () => {
  const fixture = probes();
  fixture.files.set('/sys/fs/cgroup/cpu.max', '150000 100000\n');
  fixture.files.set('/sys/fs/cgroup/memory.max', String(6 * gib));
  fixture.files.set('/sys/fs/cgroup/memory.current', String(5 * gib));
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.availableCores, 1.5);
  assert.equal(snapshot.measurement.totalRamBytes, 6 * gib);
  assert.equal(snapshot.measurement.availableRamBytes, gib);
});

test('macOS uses native pressure evidence and available memory instead of Linux files', async () => {
  const fixture = probes('darwin');
  fixture.dependencies.readFile = async path => { throw new Error(`Unexpected Linux file ${path}`); };
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.availableRamBytes, 12 * gib);
  assert.equal(snapshot.measurement.memoryPressure, 'normal');
  fixture.outputs.set('sysctl', '4\n');
  assert.equal((await reader(fixture.dependencies).read()).measurement.memoryPressure, 'critical');
});

for (const platform of ['linux', 'darwin', 'unsupported']) {
  test(`${platform}: absent pressure evidence fails closed`, async () => {
    const fixture = probes(platform);
    fixture.files.delete('/proc/pressure/memory');
    fixture.outputs.set('sysctl', 'unrecognized');
    fixture.outputs.set('memory_pressure', 'unrecognized');
    const snapshot = await reader(fixture.dependencies).read();
    assert.equal(snapshot.measurement.memoryPressure, 'unknown');
    assert.ok(snapshot.reasons.length > 0);
  });
}

test('missing RAM and failed disk probes are not replaced by zero or healthy defaults', async () => {
  const fixture = probes();
  fixture.files.set('/proc/meminfo', 'MemTotal: 16777216 kB\nMemFree: 1048576 kB\n');
  fixture.dependencies.execute = async () => ({ exitCode: 1, stdout: '', stderr: 'df failed' });
  const snapshot = await reader(fixture.dependencies).read();
  assert.ok(!Number.isFinite(snapshot.measurement.availableRamBytes));
  assert.equal(snapshot.measurement.fileSystems.length, 0);
  assert.ok(snapshot.reasons.length > 0);
});

test('concurrent snapshot readers share probes while later reads obtain fresh measurements', async () => {
  const fixture = probes();
  const source = reader(fixture.dependencies);
  await Promise.all(Array.from({ length: 30 }, () => source.read()));
  const firstCount = fixture.calls.length;
  assert.ok(firstCount > 0);
  await source.read();
  assert.equal(fixture.calls.length, firstCount * 2);
});

test('separate workspace and temp filesystems retain independent capacities', async () => {
  const fixture = probes();
  fixture.outputs.set('df', 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/work 104857600 20971520 83886080 20% /work\n/dev/temp 20971520 19922944 1048576 95% /tmp\n');
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.fileSystems.length, 2);
  assert.notEqual(snapshot.fileSystemByPath['/work'], snapshot.fileSystemByPath['/tmp']);
  const temp = snapshot.measurement.fileSystems.find(volume => volume.id === snapshot.fileSystemByPath['/tmp']);
  assert.equal(temp?.availableBytes, gib);
});

test('invalid cgroup limits do not silently admit using unrestricted host resources', async () => {
  const fixture = probes();
  fixture.files.set('/sys/fs/cgroup/memory.max', 'unreadable');
  const snapshot = await reader(fixture.dependencies).read();
  assert.ok(snapshot.reasons.length > 0);
  assert.ok(!Number.isFinite(snapshot.measurement.availableRamBytes) || snapshot.measurement.memoryPressure === 'unknown');
});

const hostPsi = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=4\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=4\n';
const sessionScope = '/user.slice/user-1000.slice/session-1.scope';

function hostCgroupV2(fixture: ReturnType<typeof probes>) {
  fixture.files.set('/proc/self/cgroup', `0::${sessionScope}\n`);
  for (const name of ['cpu.max', 'memory.max', 'memory.current']) fixture.files.delete(`/sys/fs/cgroup/${name}`);
  for (const directory of ['/user.slice', '/user.slice/user-1000.slice', sessionScope]) {
    fixture.files.set(`/sys/fs/cgroup${directory}/cpu.max`, 'max 100000\n');
    fixture.files.set(`/sys/fs/cgroup${directory}/memory.max`, 'max\n');
    fixture.files.set(`/sys/fs/cgroup${directory}/memory.current`, String(4 * gib));
  }
}

test('Linux PSI with zero current averages is normal despite stalls accumulated since boot', async () => {
  const fixture = probes();
  fixture.files.set('/proc/pressure/memory', hostPsi);
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.memoryPressure, 'normal');
  assert.deepEqual(snapshot.reasons, []);
});

test('Linux PSI with nonzero current averages is normal without a configured critical threshold', async () => {
  const fixture = probes();
  fixture.files.set('/proc/pressure/memory', 'some avg10=7.50 avg60=3.10 avg300=1.00 total=912345\nfull avg10=2.00 avg60=1.00 avg300=0.50 total=400000\n');
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.memoryPressure, 'normal');
  assert.deepEqual(snapshot.reasons, []);
});

for (const pressure of [
  'unrecognized pressure data\n',
  'some avg10=unparsed avg60=0.00 avg300=0.00 total=4\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=4\n',
]) {
  test(`Linux unparseable PSI remains unknown: ${pressure.split('\n')[0]}`, async () => {
    const fixture = probes();
    fixture.files.set('/proc/pressure/memory', pressure);
    const snapshot = await reader(fixture.dependencies).read();
    assert.equal(snapshot.measurement.memoryPressure, 'unknown');
    assert.ok(snapshot.reasons.some(reason => /PSI|\/proc\/pressure\/memory/i.test(reason)));
  });
}

test('Linux cgroup v2 root without cpu.max and memory.max means no root limit, not unknown', async () => {
  const fixture = probes();
  fixture.files.set('/proc/pressure/memory', hostPsi);
  hostCgroupV2(fixture);
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.memoryPressure, 'normal');
  assert.equal(snapshot.measurement.availableCores, 8);
  assert.equal(snapshot.measurement.totalRamBytes, 16 * gib);
  assert.equal(snapshot.measurement.availableRamBytes, 12 * gib);
  assert.deepEqual(snapshot.reasons, []);
});

test('Linux process in the root cgroup without limit files is measured from host values', async () => {
  const fixture = probes();
  for (const name of ['cpu.max', 'memory.max', 'memory.current']) fixture.files.delete(`/sys/fs/cgroup/${name}`);
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.memoryPressure, 'normal');
  assert.equal(snapshot.measurement.availableCores, 8);
  assert.equal(snapshot.measurement.availableRamBytes, 12 * gib);
  assert.deepEqual(snapshot.reasons, []);
});

test('Linux nested cgroup limits still constrain measurements when the root has no limit files', async () => {
  const fixture = probes();
  fixture.files.set('/proc/pressure/memory', hostPsi);
  hostCgroupV2(fixture);
  fixture.files.set('/sys/fs/cgroup/user.slice/cpu.max', '200000 100000\n');
  fixture.files.set(`/sys/fs/cgroup${sessionScope}/memory.max`, String(6 * gib));
  fixture.files.set(`/sys/fs/cgroup${sessionScope}/memory.current`, String(5 * gib));
  const snapshot = await reader(fixture.dependencies).read();
  assert.equal(snapshot.measurement.memoryPressure, 'normal');
  assert.equal(snapshot.measurement.availableCores, 2);
  assert.equal(snapshot.measurement.totalRamBytes, 6 * gib);
  assert.equal(snapshot.measurement.availableRamBytes, gib);
  assert.deepEqual(snapshot.reasons, []);
});

for (const [label, path, code] of [
  ['nested cpu.max', `/sys/fs/cgroup${sessionScope}/cpu.max`, 'EACCES'],
  ['nested memory.max', `/sys/fs/cgroup${sessionScope}/memory.max`, 'EIO'],
  ['nested memory.current', `/sys/fs/cgroup${sessionScope}/memory.current`, 'EACCES'],
  ['root cpu.max', '/sys/fs/cgroup/cpu.max', 'EACCES'],
] as const) {
  test(`Linux unreadable ${label} stays unknown instead of unlimited`, async () => {
    const fixture = probes();
    fixture.files.set('/proc/pressure/memory', hostPsi);
    hostCgroupV2(fixture);
    const read = fixture.dependencies.readFile;
    fixture.dependencies.readFile = async file => {
      if (file === path) throw Object.assign(new Error(`${code} ${file}`), { code });
      return read(file);
    };
    const snapshot = await reader(fixture.dependencies).read();
    assert.equal(snapshot.measurement.memoryPressure, 'unknown');
    assert.ok(snapshot.reasons.length > 0);
  });
}
