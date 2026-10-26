import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectNativeLaunchProtocol } from '../src/agy-session-start.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const configuration = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
for (const runner of ['grok', 'agy'] as const) {
  test(`Z.458 configured ${runner} supports native task launch`, () => {
    const settings = configuration.runnerProtocols.find((row: ProtocolSettings) => row.runner === runner);
    assert.ok(settings?.native, `${runner} needs its observed native dialect`);
    const protocol = selectNativeLaunchProtocol(settings);
    const invocation = protocol.invocation({ runner, model: runner === 'grok' ? 'grok-4.7' : 'gemini-4-argon-high', effort: 'high' });
    assert.equal(invocation.executable, runner);
    assert.equal(invocation.liveTaskVerified, true);
    if (runner === 'agy') {
      assert.equal(protocol.nativeIdentitySource, 'session_start');
      assert.equal(invocation.args.includes('--conversation'), false);
    } else {
      assert.equal(protocol.nativeIdentitySource, 'assigned');
      assert.ok(invocation.args.includes('--session-id'));
    }
  });
}
