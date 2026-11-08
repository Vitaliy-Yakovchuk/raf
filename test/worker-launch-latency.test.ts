import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';
import { outputFixture } from './codex-command-output-fixture.ts';
import { verifyLiveVolumeBudget } from './launch-live-volume-fixture.ts';

test('hook inspection preserves the isolated runner daemon mode and still verifies the real hook', async t => {
  const f = await outputFixture(t);
  const observed = join(f.root, 'inspection-args.json');
  const executable = join(f.root, 'inspect-codex');
  await writeFile(executable, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2)));
const child = spawn(${JSON.stringify(f.request.invocation.executable)}, process.argv.slice(2), {stdio:'inherit'});
child.once('error', error => { throw error; });
child.once('exit', code => process.exit(code ?? 1));
`, { mode: 0o700 });
  const prepared = await prepareCodexRafCommandAccess({ ...f.request, invocation: {
    ...f.request.invocation, executable,
  } });
  try {
    assert.equal(prepared.unavailable, undefined, prepared.unavailable);
    const args = JSON.parse(await readFile(observed, 'utf8'));
    assert.ok(args.includes('--no-daemon'), 'hook inspection must not start or connect to the shared daemon');
    assert.ok(prepared.invocation.args.some(arg => arg.startsWith('hooks.state=')), 'the effective hook still requires its inspected trust hash');
  } finally { await prepared.cleanup(); }
});

test('warm production launch with live planning volume, telemetry and five agents stays within the RAF budget', verifyLiveVolumeBudget);
