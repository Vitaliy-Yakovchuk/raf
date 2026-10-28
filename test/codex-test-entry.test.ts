import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';
import { bootstrapFixture } from './helpers/test-run-bootstrap-fixture.ts';

for (const phase of ['qa', 'implement']) {
  test(`Codex ${phase} test run keeps activation control read-only while running the privileged test entry`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'raf-test-entry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, 'work');
    const runDirectory = join(root, 'run');
    const control = join(root, '.git/modules/raf/raf-hotfix');
    const production = join(root, 'raf-main-a');
    const entry = join(production, 'bin/raf.ts');
    await Promise.all([cwd, runDirectory, control, production].map(path => mkdir(path, { recursive: true })));
    const prepared = await prepareCodexSandbox({
      runId: randomUUID(), cwd, runDirectory,
      invocation: { executable: '/bin/true', args: ['--sandbox', 'workspace-write'], liveTaskVerified: true },
      writableDirectories: [cwd], readOnlyDirectories: [production, control],
      scope: { hidden: [], readable: [], tmuxDirectory: runDirectory, excludedCommands: [`node '${entry}' test run`] },
      environment: { ...process.env },
    });
    t.after(() => prepared.cleanup());
    const policy = JSON.parse(await readFile(join(prepared.policyPaths[0], 'policy.json'), 'utf8'));
    const f = await bootstrapFixture(t, 'healthy', { phase, control, accessControl() {
      if (policy.filesystem[control] !== 'write') throw Object.assign(new Error(`EROFS: access ${control}`), { code: 'EROFS' });
    } });
    const result = await f.run();
    assert.deepEqual(result, f.execution, `${phase} must reach test execution without PRODUCTION_ENTRY_FAILED: ${result.stderr}`);
    assert.equal(f.calls.retain, 1);
    assert.equal(f.calls.runtime, 1);
    assert.equal(f.calls.release, 0);
    assert.equal(policy.filesystem[control], 'read');
    assert.equal(policy.filesystem[production], 'read');
    assert.ok(prepared.toolSandbox.args.some(arg => arg.includes(`${JSON.stringify(control)}="read"`)));
  });
}
