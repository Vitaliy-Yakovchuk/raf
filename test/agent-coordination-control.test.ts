import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { agentRunFixture as fixture, exists, until } from './agent-run-fixture.ts';

const timeouts = { startupMs: 20000, transitionMs: 5000, overallMs: 30000 };
const failure = (outcome: { result: { stderr: string } | null }) => JSON.parse(outcome.result?.stderr || '{}');
const briefed = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => {
  await until(() => exists(join(f.control, `${id}.brief`)), Boolean, `${id} received its brief`);
  return Number(await fs.readFile(join(f.control, `${id}.brief`), 'utf8'));
};

test('[coordinator-control] a coordinator closes and interrupts its delegated child but not a foreign agent or main', async t => {
  const f = await fixture(t, 'coordinator', timeouts, 'codex', { tasks: 3, commands: ['agent interrupt'], stages: ['coordinator'] });
  const coordinator = await f.run('coord', 'coordinator', ['1.1', '1.2']);
  assert.equal(coordinator.exitCode, 0, JSON.stringify(coordinator));
  await briefed(f, 'coord');
  const child = await f.as('coord', f.runArgs('child', 'implement', ['1.1']));
  assert.equal(child.exitCode, 0, JSON.stringify(child));
  await briefed(f, 'child');
  const other = await f.run('other', 'implement', ['1.3']);
  assert.equal(other.exitCode, 0, JSON.stringify(other));
  await briefed(f, 'other');
  for (const command of ['close', 'interrupt']) {
    const foreign = await f.as('coord', ['agent', command, '--id', 'other']);
    assert.equal(failure(foreign).code, 'CALLER_UNAUTHORIZED', `${command} of a foreign agent: ${JSON.stringify(foreign)}`);
    const main = await f.as('coord', ['agent', command, '--id', 'main']);
    assert.notEqual(main.exitCode, 0, `${command} of main: ${JSON.stringify(main)}`);
    assert.equal(failure(main).code, 'CALLER_UNAUTHORIZED', `${command} of main: ${JSON.stringify(main)}`);
  }
  const interrupted = await f.as('coord', ['agent', 'interrupt', '--id', 'child']);
  assert.notEqual(failure(interrupted).code, 'CALLER_UNAUTHORIZED', JSON.stringify(interrupted));
  const closed = await f.as('coord', ['agent', 'close', '--id', 'child']);
  assert.equal(closed.exitCode, 0, JSON.stringify(closed));
  assert.equal(JSON.parse(closed.result!.stdout).closed, true);
  const sessions = f.inspect().sessions;
  assert.equal(sessions.find(row => row.addressId === 'child')?.state, 'finished');
  assert.equal(sessions.find(row => row.addressId === 'other')?.state, 'running');
  assert.equal(sessions.find(row => row.addressId === 'coord')?.state, 'running');
});

test('[executor-message] an executor brief carries raf only for message and ps; executors message each other and a forged sender is refused', async t => {
  const f = await fixture(t, 'message', timeouts, 'codex', { tasks: 2, commands: ['agent message', 'agent ps'] });
  for (const [id, task] of [['exec-a', '1.1'], ['exec-b', '1.2']]) {
    const launched = await f.run(id, 'implement', [task]);
    assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  }
  const a = await briefed(f, 'exec-a');
  const b = await briefed(f, 'exec-b');
  const brief = await f.input(a);
  assert.match(brief, /"raf_command": "node \/[^"]+\/bin\/raf\.ts"/, 'executor brief names the raf command of its branch');
  assert.match(brief, /"raf_subcommands": \[\s*"agent message",\s*"agent ps"\s*\]/, 'executor raf access is limited to message and ps');
  const listed = await f.as('exec-a', ['agent', 'ps']);
  assert.equal(listed.exitCode, 0, JSON.stringify(listed));
  assert.ok(JSON.parse(listed.result!.stdout).some((row: { id?: string; addressId?: string }) => (row.id ?? row.addressId) === 'exec-b'), listed.result!.stdout);
  const sent = await f.as('exec-a', ['agent', 'message', '--to', 'exec-b', '--text', 'overlap on src/shared.ts']);
  assert.equal(sent.exitCode, 0, JSON.stringify(sent));
  await until(() => f.input(b), text => text.includes('[exec-a] overlap on src/shared.ts'), 'exec-b received the signed message');
  const forged = await f.command(['agent', 'message', '--to', 'exec-b', '--text', 'forged by an outsider']);
  assert.equal(failure(forged).code, 'CALLER_UNVERIFIED', JSON.stringify(forged));
  assert.equal((await f.input(b)).includes('forged by an outsider'), false);
});
