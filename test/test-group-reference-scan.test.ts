import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

test('reference scan workers load in ESM and return literal, nested and Unicode keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'raf-reference-scan-'));
  try {
    const paths = [join(root, 'first.md'), join(root, 'second.md')];
    writeFileSync(paths[0], 'fix-x/a.b/c fix-x/key+[]');
    writeFileSync(paths[1], 'fix-x/дія fix-x/axb-only');
    const keys = ['fix-x/a', 'fix-x/a.b', 'fix-x/a.b/c', 'fix-x/key+[]', 'fix-x/дія', 'fix-x/a.b-only', 'fix-x/missing'];
    const files = [...paths, join(root, 'unreadable.md')].map(path => ({ path, size: 100 }));
    const moduleUrl = new URL('../src/test-group-reference-scan.ts', import.meta.url).href;
    const script = `
      import { scanTestGroupReferences } from ${JSON.stringify(moduleUrl)};
      const found = await scanTestGroupReferences(${JSON.stringify(files)}, ${JSON.stringify(keys)});
      console.log(JSON.stringify([...found].sort()));
    `;
    let output = '';
    await assert.doesNotReject(async () => {
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script]);
      assert.equal(result.stderr, '');
      output = result.stdout;
    }, 'the reference scan must complete without a worker module-scope error');
    assert.deepEqual(JSON.parse(output), keys.slice(0, 5).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
