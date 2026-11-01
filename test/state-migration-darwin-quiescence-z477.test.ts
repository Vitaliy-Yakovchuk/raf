import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectDarwinMigrationClients } from '../src/state-migration-darwin.ts';

const uid = process.getuid?.() ?? 0;
const started = 'Mon Oct 26 20:40:00 2026';

function ps(rows: { pid: number; command: string; start?: string }[]) {
  return rows.map(row => `${row.pid} ${uid} ${row.start ?? started} ${row.command}\n`).join('');
}

function header(pid: number) {
  return `p${pid}\0u${uid}\0\n`;
}

function nofd(pid: number) {
  return `${header(pid)}fNOFD\0\n`;
}

function untyped(pid: number, extra = '') {
  return `${header(pid)}fcwd\0tunknown\0${extra}\n`;
}

function regular(pid: number, kind: string, device: bigint, inode: bigint) {
  return `${header(pid)}f4\0t${kind}\0D0x${device.toString(16)}\0i${inode}\0\n`;
}

function run(psOut: string | string[], lsof?: { code: number; stdout: string; stderr?: string }) {
  const snapshots = Array.isArray(psOut) ? [...psOut] : [psOut, psOut];
  return async (executable: string) => {
    if (executable === '/bin/ps') {
      const stdout = snapshots.shift() ?? snapshots[0] ?? psOut[0];
      return { code: 0, stdout: typeof stdout === 'string' ? stdout : '', stderr: '', helperPid: 7 };
    }
    if (executable === '/usr/sbin/lsof') return { code: lsof?.code ?? 0, stdout: lsof?.stdout ?? '', stderr: lsof?.stderr ?? '', helperPid: 8 };
    throw new Error(`unexpected inspection command ${executable}`);
  };
}

function stateFile() {
  const root = mkdtempSync(join(tmpdir(), 'z477-darwin-'));
  const path = join(root, 'state.sqlite');
  writeFileSync(path, 'not-a-client');
  const info = statSync(path, { bigint: true });
  return { root, path, device: info.dev, inode: info.ino, remove: () => rmSync(root, { recursive: true, force: true }) };
}

test('lsof exit 1 with an empty stderr and no state holder is quiescent', async () => {
  const state = stateFile();
  try {
    const result = await inspectDarwinMigrationClients(state.path, run(ps([{ pid: 4100, command: '(sd-pam)' }]), {
      code: 1, stdout: nofd(4100), stderr: '',
    }));
    assert.equal(result, 'quiescent');
  } finally { state.remove(); }
});

test('untyped descriptors of a proved non-raf process do not make a quiet inventory unknown', async () => {
  const state = stateFile();
  try {
    const result = await inspectDarwinMigrationClients(state.path, run(ps([{ pid: 4101, command: 'systemd' }]), {
      code: 0, stdout: untyped(4101),
    }));
    assert.equal(result, 'quiescent');
  } finally { state.remove(); }
});

test('lsof exit 1 still reports a regular-file holder as incompatible', async () => {
  const state = stateFile();
  try {
    const stdout = nofd(4100) + regular(4102, 'REG', state.device, state.inode);
    const result = await inspectDarwinMigrationClients(state.path, run(ps([
      { pid: 4100, command: '(sd-pam)' },
      { pid: 4102, command: 'node' },
    ]), { code: 1, stdout, stderr: '' }));
    assert.equal(result, 'incompatible');
  } finally { state.remove(); }
});

test('a Darwin VREG holder is incompatible', async () => {
  const state = stateFile();
  try {
    const result = await inspectDarwinMigrationClients(state.path, run(ps([{ pid: 4102, command: 'node' }]), {
      code: 0, stdout: regular(4102, 'VREG', state.device, state.inode),
    }));
    assert.equal(result, 'incompatible');
  } finally { state.remove(); }
});

test('an untyped descriptor whose dev:ino is the state file is incompatible', async () => {
  const state = stateFile();
  try {
    const marker = `D0x${state.device.toString(16)}\0i${state.inode}\0`;
    const result = await inspectDarwinMigrationClients(state.path, run(ps([{ pid: 4102, command: 'systemd' }]), {
      code: 0, stdout: untyped(4102, marker),
    }));
    assert.equal(result, 'incompatible');
  } finally { state.remove(); }
});

test('an untyped descriptor of node, raf, bun or deno stays unknown', async () => {
  const state = stateFile();
  try {
    for (const command of ['node', 'nodejs', 'raf', 'bun', 'deno', 'node-20']) {
      const result = await inspectDarwinMigrationClients(state.path, run(ps([{ pid: 4102, command }]), {
        code: 0, stdout: untyped(4102),
      }));
      assert.equal(result, 'unknown', command);
    }
  } finally { state.remove(); }
});

test('lsof stderr or a non-inventory exit stays unknown', async () => {
  const state = stateFile();
  try {
    const quiet = ps([{ pid: 4100, command: '(sd-pam)' }]);
    const stderr = await inspectDarwinMigrationClients(state.path, run(quiet, { code: 1, stdout: nofd(4100), stderr: 'lsof: WARNING\n' }));
    assert.equal(stderr, 'unknown');
    const failed = await inspectDarwinMigrationClients(state.path, run(quiet, { code: 2, stdout: nofd(4100), stderr: '' }));
    assert.equal(failed, 'unknown');
    const truncated = await inspectDarwinMigrationClients(state.path, run(quiet, { code: 0, stdout: `p4100\0u${uid}`, stderr: '' }));
    assert.equal(truncated, 'unknown');
  } finally { state.remove(); }
});

test('a same-uid process whose identity changes during inspection stays unknown', async () => {
  const state = stateFile();
  try {
    const other = regular(4102, 'REG', 1n, 1n);
    assert.notEqual(`${state.device}:${state.inode}`, '1:1');
    const result = await inspectDarwinMigrationClients(state.path, run([
      ps([{ pid: 4102, command: 'node' }]),
      ps([{ pid: 4102, command: 'node', start: 'Mon Oct 26 20:41:00 2026' }]),
    ], { code: 0, stdout: other }));
    assert.equal(result, 'unknown');
  } finally { state.remove(); }
});

test('a Darwin fileport VREG without dev:ino is not an unknown client when nothing holds the state', async () => {
  const state = stateFile();
  try {
    assert.notEqual(`${state.device}:${state.inode}`, '1:1');
    const stdout = `${header(4100)}f fp.\0tVREG\0\nf4\0tVREG\0D0x1\0i1\0\n`;
    const quiet = ps([{ pid: 4100, command: 'distnoted' }]);
    const result = await inspectDarwinMigrationClients(state.path, run(quiet, { code: 0, stdout }));
    assert.equal(result, 'quiescent');
    const runtime = await inspectDarwinMigrationClients(state.path, run(ps([{ pid: 4102, command: 'node' }]), {
      code: 0, stdout: `${header(4102)}f fp.\0tVREG\0\nf4\0tVREG\0D0x1\0i1\0\n`,
    }));
    assert.equal(runtime, 'quiescent');
  } finally { state.remove(); }
});

test('a proved non-client omitted from a quiet Darwin fd inventory is not unknown', async () => {
  const state = stateFile();
  try {
    assert.notEqual(`${state.device}:${state.inode}`, '1:1');
    const stdout = `${header(4102)}f4\0tVREG\0D0x1\0i1\0\n`;
    const result = await inspectDarwinMigrationClients(state.path, run(ps([
      { pid: 4100, command: 'WindowServer' },
      { pid: 4102, command: 'node' },
    ]), { code: 0, stdout }));
    assert.equal(result, 'quiescent');
  } finally { state.remove(); }
});

test('no other same-uid process is quiescent without asking lsof', async () => {
  const state = stateFile();
  try {
    let lsof = 0;
    const result = await inspectDarwinMigrationClients(state.path, async executable => {
      if (executable === '/usr/sbin/lsof') lsof += 1;
      if (executable === '/bin/ps') return { code: 0, stdout: `${process.pid} ${uid} ${started} node\n`, stderr: '', helperPid: 7 };
      throw new Error(`unexpected inspection command ${executable}`);
    });
    assert.equal(result, 'quiescent');
    assert.equal(lsof, 0);
  } finally { state.remove(); }
});
