import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { agentRunFixture as fixture, alive, exists, runnerScript, until } from './agent-run-fixture.ts';

test('[agent-close-exit] agent close waits for the runner process that outlives its tmux pane (t4-06: ≈750 ms after SIGHUP)', async t => {
  const f = await fixture(t, 'close', { startupMs: 20000, transitionMs: 5000, overallMs: 30000 }, 'codex', { productionQa: true });
  const lingering = runnerScript.replace('setInterval(() => {}, 1000);', "setInterval(() => {}, 1000);\nprocess.on('SIGHUP', () => setTimeout(() => process.exit(129), 750));");
  assert.notEqual(lingering, runnerScript);
  await fs.writeFile(join(f.directory, 'bin', 'codex'), `#!${process.execPath}\n${lingering}`, { mode: 0o700 });
  const launched = await f.run('linger-agent');
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const runId = JSON.parse(launched.result.stdout).runId;
  await until(() => exists(join(f.control, 'linger-agent.brief')), Boolean, 'runner received brief');
  await fs.writeFile(join(f.control, 'linger-agent.close'), 'close');
  const code = await until(async () => await exists(join(f.control, 'linger-agent.close.code')) ? (await fs.readFile(join(f.control, 'linger-agent.close.code'), 'utf8')).trim() : null, value => value !== null, 'agent close finished');
  const printed = await fs.readFile(join(f.control, 'linger-agent.close.out'), 'utf8');
  assert.equal(code, '0', printed);
  assert.equal(JSON.parse(JSON.parse(printed).stdout).closed, true, printed);
  assert.deepEqual((await f.runners()).filter(alive), []);
  const snapshot = f.inspect();
  assert.equal(snapshot.sessions.find(row => row.runId === runId)?.state, 'finished');
  assert.deepEqual(snapshot.claims, []);
  assert.deepEqual(snapshot.admission, []);
  assert.deepEqual(await f.runDirectories(), []);
});
