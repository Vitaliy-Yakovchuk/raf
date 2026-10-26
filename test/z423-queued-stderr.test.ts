import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRunCli } from '../src/test-run-cli.ts';
import type { TestRunResult } from '../src/test-runs.ts';
import { fixture, config, context, policy, file, selected } from './helpers/test-run-reservations-fixture.ts';

const change = 'enforce-flow-approaches';
const workspace = '/flow-unit/raf-develop';
const group = `${change}/flow-checks`;

async function queuedRuns() {
  const runContext = { ...context, cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] }, activeChanges: [change], agentId: 'qa-worker', callerPhase: 'qa' };
  const configuration = structuredClone(config);
  configuration.projects.raf.groups = { [group]: { profileId: 'node', files: [file] } };
  const f = fixture(undefined, runContext);
  const spawn = f.ports.spawn;
  let phase: 'red' | 'qa' = 'red';
  f.ports.spawn = async (command, onEvent) => {
    const child = await spawn(command, event => onEvent(phase === 'red' && event.kind === 'passed' ? { kind: 'assertion-failed', test: selected } : event));
    return { ...child, wait: async () => ({ ...await child.wait(), exitCode: phase === 'red' ? 23 : 0 }) };
  };
  const executions: { result: TestRunResult; stderr: string; brokerStderr: string; code: number }[] = [];
  for (const next of ['red', 'qa'] as const) {
    phase = next;
    let stdout = '', brokerStderr = '';
    const directBefore = f.testQueue.stderr.length;
    f.shared.setRefusal('unavailable');
    const running = runTestRunCli(['--project', 'raf', '--phase', phase, '--group', group], {
      config: configuration, policy, context: runContext, runtime: f.ports,
      stdout: value => { stdout += value; }, stderr: value => { brokerStderr += value; },
    });
    try {
      await f.testQueue.entered;
      if (phase === 'qa') {
        while (f.testQueue.waits.length < 2) await new Promise<void>(resolve => setImmediate(resolve));
      }
      f.shared.setRefusal(null);
      f.testQueue.grant(phase === 'red' ? 0 : 1);
      const code = await running;
      const result = JSON.parse(stdout) as TestRunResult;
      const returnedStderr = brokerStderr.trimEnd() ? brokerStderr.trimEnd() + '\n' : '';
      const stderr = f.testQueue.stderr.slice(directBefore).join('') + returnedStderr;
      executions.push({ result, stderr, brokerStderr, code });
    } finally {
      f.shared.setRefusal(null);
      f.testQueue.waits.forEach((_, index) => f.testQueue.grant(index));
      await running;
    }
    f.advance(100);
  }
  return { executions, f };
}

test('Z.423 queued test CLI returns stdout and captured queue stderr', async () => {
  const { executions, f } = await queuedRuns();
  assert.deepEqual(executions.map(run => run.result.outcome), ['assertions-failed', 'passed']);
  assert.deepEqual(executions.map(run => run.code), [1, 0]);
  assert.equal(executions[0].result.exitCode, 23);
  for (const run of executions) {
    assert.deepEqual((run.result as TestRunResult & { queue: unknown }).queue, { queueId: f.testQueue.records[0].queueId, waited: true });
    assert.equal(JSON.parse(run.stderr).kind, 'launch-queue.waiting');
    assert.equal(run.result.cleanup.complete, true);
  }
  assert.deepEqual(f.testQueue.stderr, [], 'queue diagnostics must use the captured CLI stderr port');
});
