import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import { runTestRunCli } from '../src/test-run-cli.ts';
import { outputFixture, outputTimeout } from './codex-command-output-fixture.ts';
import { files, policy, RunHarness } from './helpers/test-run-fixture.ts';

test('codex test run keeps complete JSON above 65 KiB after replay and announces its readable path before large output', { timeout: outputTimeout }, async t => {
  const f = await outputFixture(t, { runDirectoryInState: true });
  f.request.scope.excludedCommands.push(`${f.rafCommand} test run`);
  const prepared = await f.prepare();
  const artifacts: string[] = [];
  for (const large of [true, false]) {
    const harness = new RunHarness();
    if (large) {
      const ids = Array.from({ length: 512 }, (_, index) => ({ file: files[0], name: `${index}: Україна ${'result '.repeat(32)}` }));
      harness.events = [...ids.map(id => ({ kind: 'assertion-failed' as const, test: id })), { kind: 'complete', expected: ids }];
      harness.exit.exitCode = 17;
    }
    let json = '';
    const code = await runTestRunCli(['--project', 'raf', '--phase', 'red', '--group', 'add-raf-test-run/unit', '--files', files[0]], {
      config: harness.config, policy, context: harness.context, runtime: harness.ports,
      stdout: text => { json += text; }, stderr: () => {},
    });
    const expected = JSON.parse(json);
    const stdout = Buffer.from(json);
    if (large) assert.ok(stdout.length > 65 * 1024);
    const stderr = Buffer.from('original diagnostic\n'.repeat(large ? 8192 : 1));
    await f.configure(stdout, stderr, code);
    const hook = await f.hook(prepared, `${f.rafCommand} test run --project raf --phase hotfix --group fix-raf-truncated-test-result/unit`);
    assert.equal(hook.result.code, 0);
    assert.ok(hook.replay);
    const result = await f.replay(prepared, hook.replay);
    assert.equal(result.code, code);
    assert.deepEqual(result.stdout, stdout, 'existing JSON stdout remains byte-for-byte compatible');
    const announcement = /^RAF test run result: (.+)\n/u.exec(result.stderr.toString());
    assert.ok(announcement, 'a short path must precede stderr diagnostics even when stdout is truncated');
    const artifact = announcement[1];
    assert.equal(dirname(artifact), f.runDirectory, 'result belongs to the caller run, accessible inside its sandbox');
    assert.deepEqual(result.stderr.subarray(Buffer.byteLength(announcement[0])), stderr);
    assert.ok(result.stderr.subarray(0, 1024).includes(Buffer.from(artifact)));
    assert.deepEqual(await readFile(artifact), stdout);
    assert.deepEqual(JSON.parse(await readFile(artifact, 'utf8')), expected);
    assert.equal((await stat(artifact)).mode & 0o777, 0o600);
    artifacts.push(artifact);
  }
  assert.notEqual(artifacts[0], artifacts[1], 'later commands cannot overwrite prior results');
  assert.equal((await f.calls()).length, 2, 'each test run executes once');
  await prepared.cleanup();
  for (const artifact of artifacts) assert.ok(JSON.parse(await readFile(artifact, 'utf8')).runId, 'transport cleanup preserves saved JSON');
});
