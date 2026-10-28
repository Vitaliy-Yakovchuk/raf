import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapFixture } from './helpers/test-run-bootstrap-fixture.ts';

for (const permissionCode of ['EROFS', 'EACCES'] as const) {
  test(`main slot test run dispatches once when activation control denies writes with ${permissionCode}`, async t => {
    const f = await bootstrapFixture(t, 'read-only', { permissionCode });
    const result = await f.run();
    assert.deepEqual(result, f.execution, 'read-only main slot clients must reach test run');
    assert.deepEqual(f.calls.access, [], 'client bootstrap does not require control-directory write access');
    assert.equal(f.calls.retain, 1);
    assert.equal(f.calls.runtime, 1);
    assert.equal(f.calls.release, 0, 'no reader lease was created in the read-only control directory');
  });
}

test('writable main slot client retains and releases its reader around dispatch', async t => {
  const f = await bootstrapFixture(t, 'healthy');
  assert.deepEqual(await f.run(), f.execution);
  assert.equal(f.calls.retain, 1);
  assert.equal(f.calls.runtime, 1);
  assert.equal(f.calls.release, 1);
});

test('main slot client preserves non-permission reader failures without dispatch', async t => {
  const f = await bootstrapFixture(t, 'reader-race');
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).outcome, 'refused');
  assert.match(result.stderr, /Generation changed during reader registration/);
  assert.equal(f.calls.retain, 1);
  assert.equal(f.calls.runtime, 0);
  assert.equal(f.calls.release, 0);
});
