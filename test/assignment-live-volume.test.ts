import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand } from '../src/os-runtime.ts';

test('internal OpenSpec reads opt out of telemetry without changing HOME or caller environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-openspec-environment-'));
  try {
    const executable = join(root, 'openspec');
    await writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({telemetry:process.env.OPENSPEC_TELEMETRY,home:process.env.HOME,marker:process.env.RAF_FIXTURE_MARKER}));\n`, { mode: 0o700 });
    const environment = { HOME: root, OPENSPEC_TELEMETRY: '1', RAF_FIXTURE_MARKER: 'retained' };
    const result = await executeCommand({ executable, args: ['--version'], environment });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { telemetry: '0', home: root, marker: 'retained' });
    assert.equal(environment.OPENSPEC_TELEMETRY, '1');
    const other = await executeCommand({ executable: process.execPath, args: ['--input-type=module', '-e', 'console.log(process.env.OPENSPEC_TELEMETRY)'], environment });
    assert.equal(other.stdout.trim(), '1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { verifyLiveVolumeBudget } from './launch-live-volume-fixture.ts';

test('production main CLI stays below three seconds with live planning volume and telemetry configuration', verifyLiveVolumeBudget);
