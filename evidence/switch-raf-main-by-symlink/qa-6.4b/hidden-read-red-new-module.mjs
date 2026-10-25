import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export function captureStateReadControls(directory) {
  return ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'secrets.json'].map(name => {
    const target = path.join(directory, name), stat = fs.statSync(target);
    assert.ok(stat.isFile(), 'Host read control must be an existing regular file: ' + target);
    return { path: target, dev: stat.dev, ino: stat.ino, regularFile: true };
  });
}

export function assertNativeDenial(result, hiddenRead) {
  assert.equal(result.signal, null, 'A denial must complete without a signal');
  assert.ok(Number.isInteger(result.cliExitCode) && result.cliExitCode !== 0, 'A denial must have a nonzero exit code');
  assert.match(result.stderr, /EACCES|EPERM|EROFS|Permission denied|Read-only file system/, 'Probe must be a permission denial');
}
