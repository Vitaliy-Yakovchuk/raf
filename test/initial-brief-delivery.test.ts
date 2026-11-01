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
  assert.match(outcome.result.stderr, /Native initial brief acceptance cannot be verified on unknown_screen/, JSON.stringify(outcome));
  await assertFailedLaunchCleaned(f, outcome, 'delivery');
  const session = f.inspect().sessions[0];
  for (const reason of [session.abortReason, JSON.parse(outcome.result.stderr).message]) {
    assert.match(reason ?? '', /deliveryEvidence=/, 'diagnostic survives in durable session and CLI result');
    assert.doesNotMatch(reason ?? '', /private-owner|example\.test|\/private\/customer|private-api-value|private-bearer-value/i);
  }
  const screen = await readFile(join(f.tmpRoot, '.last-screens', session.runId, 'last-screen.txt'), 'utf8');
  assert.match(screen, /Unknown native transition/);
  assert.doesNotMatch(screen, /private-owner|example\.test|\/private\/customer|private-api-value|private-bearer-value/i);
});

test('initial brief acceptance continues after transitionMs while the owned runner remains alive', async t => {
  const f = await agentRunFixture(t, 'success', { startupMs: 20000, transitionMs: 500, overallMs: 30000 }, 'codex', { productionQa: true, commands: ['agent message', 'agent ps'] });
  const executable = join(f.directory, 'bin', 'codex');
  const script = await readFile(executable, 'utf8');
  const start = "    assignment = candidate;\n    console.log('\\n• Working";
  assert.ok(script.includes(start));
  await writeFile(executable, script.replace(start, "    assignment = candidate;\n    await new Promise(resolve => setTimeout(resolve, 1500));\n    console.log('\\n• Working").replaceAll("process.stdin.on('data', chunk => {", "process.stdin.on('data', async chunk => {"));
  const outcome = await f.run('slow-delivery-agent');
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
});
