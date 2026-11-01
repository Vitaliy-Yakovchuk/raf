import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLease } from '../src/hotfix-host.ts';

test('[hotfix-pure] reader lease released between readdir and read is skipped, not an error', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reader-lease-'));
  try {
    const path = join(directory, 'lease.json');
    writeFileSync(path, JSON.stringify({ pid: 1, start: 'x', root: '/r' }));
    assert.deepEqual(await readLease(path), { pid: 1, start: 'x', root: '/r' });
    rmSync(path);
    assert.equal(await readLease(path), undefined);
    writeFileSync(path, '{');
    await assert.rejects(readLease(path), SyntaxError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
