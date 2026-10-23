import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { agentRunFixture, assertFailedLaunchCleaned } from './agent-run-fixture.ts';

test('[Z.356] delivery failure retains sanitized last frame and delivery state after cleanup', async t => {
  const f = await agentRunFixture(t, 'delivery', { startupMs: 20000, transitionMs: 5000, overallMs: 30000 }, 'codex', { productionQa: true, commands: ['agent message', 'agent ps'] });
  const executable = join(f.directory, 'bin', 'codex');
  const script = await readFile(executable, 'utf8');
  const secretFrame = 'Unknown native transition\\nAccount: private-owner@example.test\\nWorkspace: /private/customer/project\\napi_key=private-api-value\\nAuthorization: Bearer private-bearer-value';
  assert.ok(script.includes('Unknown native transition'));
  await writeFile(executable, script.replace('Unknown native transition', secretFrame));
  const flowPath = join(f.directory, 'orchestrator', 'conf', 'flow.json');
  const flow = JSON.parse(await readFile(flowPath, 'utf8'));
  for (const threshold of Object.values(flow.resources) as { maxNormalizedLoad: number }[]) threshold.maxNormalizedLoad = Number.MAX_VALUE;
  await writeFile(flowPath, JSON.stringify(flow));
  const outcome = await f.run('delivery-diagnostic-agent');
  assert.match(outcome.result.stderr, /Unknown native input or screen during initial brief submission/, JSON.stringify(outcome));
  await assertFailedLaunchCleaned(f, outcome, 'delivery');
  const session = f.inspect().sessions[0];
  for (const [field, reason] of Object.entries({ abortReason: session.abortReason, message: JSON.parse(outcome.result.stderr).message })) {
    assert.match(reason ?? '', /Unknown native input or screen during initial brief submission/, field);
    assert.doesNotMatch(reason?.split('delivery=')[1]?.split('\n')[0] ?? '', /[0-9a-f]{8}-[0-9a-f-]{27}/i);
    assert.match(reason ?? '', /delivery=/, 'diagnostic survives in durable session and CLI result');
    assert.match(reason ?? '', /Unknown native transition/, 'last frame remains useful after its directory is deleted');
    assert.match(reason ?? '', /awaiting_acceptance/);
    assert.match(reason ?? '', /unknown_screen/);
    assert.match(reason ?? '', /"composer":"missing"/);
    assert.match(reason ?? '', /"retried":false/);
    assert.doesNotMatch(reason ?? '', /private-owner|example\.test|\/private\/customer|private-api-value|private-bearer-value/i);
  }
});
