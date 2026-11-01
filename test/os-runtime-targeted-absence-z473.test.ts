import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCommand, AdapterCommandResult } from '../src/agent-adapters.ts';
import { observeKnownProcesses } from '../src/os-runtime.ts';
import type { ProcessScanDependencies } from '../src/os-runtime.ts';
import type { ProcessIdentity } from '../src/session-state.ts';

const observedAt = '2026-10-26T19:35:00.000Z';
const startedAt = 'Wed Oct 21 11:30:00 2026';
const command = '/usr/local/bin/codex exec task';
const identity = (pid = 2417): ProcessIdentity => ({
  pid, startedAt, runner: 'codex', runnerSessionId: 'session-1', tmuxSession: 'agent-a',
  evidence: { command },
});
const emptyPs = (): AdapterCommandResult => ({ exitCode: 1, stdout: '', stderr: '' });
const row = (pid = 2417, start = startedAt, text = command) => `${pid} ${start} ${text}\n`;
const statLine = (pid: number, startTime = '38621422') => {
  const fields = ['S', '0', '1', '1', '0', '-1', '4194304', '1', '0', '0', '0', '1', '1', '0', '0', '20', '0', '1', '0', startTime];
  return `${pid} (node) ${fields.join(' ')}\n`;
};
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

function scan(platform: 'linux' | 'darwin', result: AdapterCommandResult, readProcessStat?: ProcessScanDependencies['readProcessStat']) {
  const commands: AdapterCommand[] = [];
  const dependencies: ProcessScanDependencies = {
    platform: () => platform,
    now: () => observedAt,
    readProcessStat,
    execute: async command => {
      commands.push(command);
      assert.equal(command.executable, 'ps');
      assert.equal(command.args[0], '-ww');
      assert.equal(command.args[1], '-p');
      return result;
    },
  };
  return { commands, dependencies };
}

function detail(result: { state: string; error?: string }) {
  return result.state === 'unknown' ? result.error : result.state;
}

for (const host of ['darwin', 'linux'] as const) {
  test(`${host}: empty targeted ps exit 1 reports a PID that is already gone as exited`, async () => {
    let reads = 0;
    const probed = scan(host, emptyPs(), async pid => {
      reads += 1;
      if (host !== 'linux') throw new Error('process stat is not existence proof off Linux');
      if (reads === 1) return statLine(pid);
      throw enoent();
    });
    const [result] = await observeKnownProcesses([identity()], probed.dependencies);
    assert.equal(result.state, 'exited', detail(result));
    assert.equal(probed.commands.length, 1);
    assert.equal(probed.commands[0].args[2], '2417');
    assert.equal(reads, host === 'linux' ? 2 : 0);
  });
}

test('linux: ENOENT before targeted ps is exited and does not ask ps', async () => {
  const probed = scan('linux', emptyPs(), async () => { throw enoent(); });
  const [result] = await observeKnownProcesses([identity()], probed.dependencies);
  assert.equal(result.state, 'exited', detail(result));
  assert.equal(probed.commands.length, 0);
});

for (const host of ['darwin', 'linux'] as const) {
  test(`${host}: targeted ps failure and a matching live row keep unknown and alive`, async () => {
    const failed = scan(host, { exitCode: 1, stdout: '', stderr: 'ps failed' }, async pid => statLine(pid));
    const [failure] = await observeKnownProcesses([identity()], failed.dependencies);
    assert.equal(failure.state, 'unknown');
    const live = scan(host, { exitCode: 0, stdout: row(), stderr: '' }, async pid => statLine(pid));
    const [alive] = await observeKnownProcesses([identity()], live.dependencies);
    assert.equal(alive.state, 'alive');
    const malformed = scan(host, { exitCode: 0, stdout: 'not a process row\n', stderr: '' }, async pid => statLine(pid));
    const [broken] = await observeKnownProcesses([identity()], malformed.dependencies);
    assert.equal(broken.state, 'unknown');
  });
}

test('linux: matching targeted stat stays unknown when empty ps omits that PID', async () => {
  const probed = scan('linux', emptyPs(), async pid => statLine(pid));
  const [result] = await observeKnownProcesses([identity()], probed.dependencies);
  assert.equal(result.state, 'unknown');
  assert.match(result.state === 'unknown' ? result.error : '', /present in targeted stat/);
});

test('linux: unreadable targeted stat during observation stays unknown', async () => {
  let reads = 0;
  const probed = scan('linux', emptyPs(), async pid => {
    reads += 1;
    if (reads === 1) return statLine(pid);
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  });
  const [result] = await observeKnownProcesses([identity()], probed.dependencies);
  assert.equal(result.state, 'unknown');
});

test('darwin: reused command in a targeted row is exited', async () => {
  const probed = scan('darwin', { exitCode: 0, stdout: row(2417, startedAt, '/bin/sleep 600'), stderr: '' });
  const [result] = await observeKnownProcesses([identity()], probed.dependencies);
  assert.equal(result.state, 'exited');
});
