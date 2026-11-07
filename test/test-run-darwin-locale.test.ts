import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { darwinTestRows, darwinTestStart, darwinTestTree } from '../src/test-run-darwin-process.ts';

test('Darwin test identities use the same C locale under an en_NZ caller', t => {
  const previous = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  process.env.LANG = process.env.LC_ALL = 'en_NZ.UTF-8';
  const date = (options: any) => options.env.LC_ALL === 'C' ? 'Thu Nov  5 09:33:35 2026' : 'Thu  5 Nov 09:33:35 2026';
  t.mock.method(childProcess, 'spawnSync', (file: string, argv: string[], options: any) => {
    assert.equal(file, 'ps');
    assert.deepEqual(argv, ['-p', '42', '-o', 'stat=,lstart=']);
    assert.equal(options.env.TZ, 'UTC');
    return { status: 0, stdout: `S ${date(options)}\n` };
  });
  t.mock.method(childProcess, 'execFileSync', (file: string, argv: string[], options: any) => {
    assert.equal(file, 'ps');
    assert.deepEqual(argv, ['-axo', 'pid=,ppid=,pgid=,stat=,rss=,lstart=']);
    assert.equal(options.env.TZ, 'UTC');
    return `42 1 42 S 100 ${date(options)}\n43 42 43 S 200 ${date(options)}\n44 42 42 Z 0 ${date(options)}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const start = 'darwin-utc:Thu Nov 5 09:33:35 2026';
  assert.equal(darwinTestStart(42), start);
  assert.deepEqual(darwinTestRows(), [
    { pid: 42, parent: 1, group: 42, start, ramBytes: 102400 },
    { pid: 43, parent: 42, group: 43, start, ramBytes: 204800 },
  ]);
  assert.deepEqual(darwinTestTree(42).map(row => ({ pid: row.pid, start: row.start })), [{ pid: 42, start }, { pid: 43, start }]);
});
