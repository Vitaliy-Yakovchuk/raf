import test from 'node:test';
import assert from 'node:assert/strict';
import { enableCompileCache } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand } from '../src/os-runtime.ts';

test('Node helpers reuse the enabled CLI compile cache in an isolated environment', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'raf-startup-cache-'));
  try {
    enableCompileCache(cache);
    const result = await executeCommand({ executable: process.execPath,
      args: ['--input-type=module', '-e', "import {getCompileCacheDir} from 'node:module'; console.log(JSON.stringify({cache:getCompileCacheDir(), marker:process.env.RAF_FIXTURE_MARKER}));"],
      environment: { RAF_FIXTURE_MARKER: 'isolated' } });
    assert.equal(result.exitCode, 0, result.stderr);
    const child = JSON.parse(result.stdout);
    assert.ok(child.cache, 'helper must enable the parent compile cache before loading its modules');
    assert.equal(child.marker, 'isolated');
  } finally { await rm(cache, { recursive: true, force: true }); }
});

import { verifyLiveStateBudget } from './launch-live-state-fixture.ts';

test('production main CLI stays below three seconds with five active agents and historical state', verifyLiveStateBudget);
