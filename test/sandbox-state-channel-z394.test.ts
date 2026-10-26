import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { stateChannelFixture, timeoutMs } from './support/sandbox-state-channel-z394-mocks.ts';

const options = { timeout: timeoutMs };

for (const suffix of ['agent ps', "agent message --to peer --text 'unit message'", 'test run --project raf --phase red --group complete-raf-flow-contracts/z394'] as const) {
  test(`[z394] production launch issues ${suffix.split(' --')[0]} through host-only state and returns its exact result`, options, async t => {
    const f = await stateChannelFixture(t);
    f.hostReply = { stdout: '{"hostOnly":true,"receipt":"unit"}\n', stderr: 'unit host stderr\n', code: suffix.startsWith('test run') ? 17 : 0 };
    const failure = await f.run(async ports => {
      const input = f.prepareRequests[0];
      assert.equal(f.prepareRequests.length, 1);
      assert.deepEqual(input.publication, { orchestratorRoot: f.context.orchestratorRoot, homeDirectory: f.stateContext.homeDirectory, runId: f.request.runId, agentId: f.request.address });
      assert.equal(input.cwd, f.request.cwd);
      assert.equal(input.runDirectory, f.runDirectory);
      assert.ok(input.scope.hidden.includes(join(f.stateContext.homeDirectory, '.raf')));
      assert.ok(input.scope.hidden.includes(f.context.tmpRoot));
      assert.deepEqual(input.scope.readable, [f.runDirectory]);
      assert.deepEqual(input.scope.excludedCommands, ['agent ps', 'agent message', 'test run'].map(command => `${f.prefix} ${command}:*`));
      assert.deepEqual(f.sandbox.scope, input.scope, 'channel installation must preserve the enforced state deny scope');
      assert.ok(!f.sandbox.writableDirectories.includes(join(f.stateContext.homeDirectory, '.raf')));
      await ports.transport.startWithoutInput(f.request, join(f.runDirectory, f.request.address + '.json'));
      const invocation = f.calls.find(call => call.args.includes('new-session'));
      assert.ok(invocation, 'production transport must receive the prepared runner');
      assert.ok(JSON.stringify(invocation).includes('hooks.PreToolUse='));
      const statePaths = [f.context.statePath, f.context.statePath + '-wal', f.context.statePath + '-shm'];
      assert.deepEqual(await f.probeDirectState(statePaths), statePaths.map(path => ({ path, code: 'EACCES' })));
      assert.deepEqual(f.directDenials, statePaths);
      const command = `${f.prefix} ${suffix}`;
      const accepted = await f.invoke(command);
      assert.equal(typeof accepted.replacement, 'string', accepted.stderr);
      assert.notEqual(accepted.replacement, command);
      const result = await f.evaluate(accepted.replacement!);
      assert.deepEqual(result, f.hostReply);
      assert.equal(f.hostCalls.length, 1);
      assert.equal(f.generationSpawns.length, 1);
      const host = f.generationSpawns[0];
      assert.equal(host.executable, process.execPath);
      assert.equal(host.args[0], join(f.generationRoot, 'bin/raf.ts'));
      assert.equal(host.options.cwd, f.request.cwd);
      assert.equal(host.options.env.HOME, f.stateContext.homeDirectory);
      assert.equal(host.options.shell, false);
      assert.equal(f.generationReleased, 1);
      const hookOpen = f.stateOpens.filter(open => open.options?.context?.homeDirectory === f.stateContext.homeDirectory);
      assert.equal(hookOpen.length, 2, 'worker and verified host caller each open only their trusted context');
      assert.ok(hookOpen.every(open => open.path === f.context.statePath));
    });
    assert.equal(failure, f.cutoff);
    assert.equal(f.sandboxCleaned, 1);
  });
}

test('[z394] production launch propagates channel preparation failure before runner start or brief delivery', options, async t => {
  const f = await stateChannelFixture(t);
  f.prepareFailure = new Error('unit exact issued channel unavailable');
  assert.equal(await f.run(), f.prepareFailure);
  assert.equal(f.prepareRequests.length, 1);
  assert.equal(f.driveCount, 0, 'launch wrapper cannot start with text-only RAF permission');
  assert.equal(f.calls.some(call => call.executable === 'tmux'), false, 'no runner start, buffer paste or brief submission');
  assert.deepEqual(f.hostCalls, []);
  assert.equal(f.sandboxCleaned, 1);
});

test('[z394] only the issued prefix and subcommand reach the host from a production launch', options, async t => {
  const f = await stateChannelFixture(t);
  assert.equal(await f.run(async () => {
    const allowed = `${f.prefix} agent ps`;
    for (const denied of [
      `env UNIT=1 ${allowed}`, `cd '${f.request.cwd}' && ${allowed}`,
      `${allowed} | cat`, `${allowed}; true`, `${allowed} $(true)`,
      `node /unissued/bin/raf.ts agent ps`, `${f.prefix} agent run --id another`,
      `${f.prefix} agent close --id another`, `${f.prefix} test unknown`,
    ]) {
      assert.deepEqual((await f.invoke(denied)).response, {}, denied);
      assert.equal(f.hostCalls.length, 0, 'denied syntax must never acquire host privilege');
    }
    const accepted = await f.invoke(`'node' '${f.prefix.slice(5)}' agent ps`);
    assert.equal(typeof accepted.replacement, 'string');
    const result = await f.evaluate(accepted.replacement!);
    assert.equal(result.code, 0);
    assert.equal(f.hostCalls.length, 1, 'equivalent literal quoting keeps the issued executable');
    assert.equal(f.generationSpawns.length, 1);
  }), f.cutoff);
});

test('[z394] result delivery loss after a host invocation returns failure without original fallback or host retry', options, async t => {
  const f = await stateChannelFixture(t);
  assert.equal(await f.run(async () => {
    const command = `${f.prefix} agent message --to peer --text 'delivered once'`;
    const accepted = await f.invoke(command, true);
    assert.equal(f.hostCalls.length, 1);
    assert.equal(f.generationSpawns.length, 1);
    assert.match(accepted.stderr, /unit delivery lost after host close/);
    assert.equal(typeof accepted.replacement, 'string');
    assert.notEqual(accepted.replacement, command);
    const result = await f.evaluate(accepted.replacement!);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unit delivery lost after host close/);
    assert.match(result.stderr, /not retried/);
    assert.equal(result.stdout, '');
    assert.equal(f.hostCalls.length, 1);
    assert.equal(f.generationSpawns.length, 1, 'failure reader must not re-execute the accepted operation');
  }), f.cutoff);
});
