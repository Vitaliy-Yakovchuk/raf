import { randomUUID } from 'node:crypto';
import { parseTestRunArgs, testRunFailureResult } from './test-runs.ts';
import type { TestId } from './test-runs.ts';
import type { ExecutionResult } from './cli.ts';

export function testRunBootstrapFailure(argv: readonly string[], stderr: string): ExecutionResult {
  const args = parseTestRunArgs(argv);
  const only = args.only?.map(value => {
    if (value.startsWith('{')) return JSON.parse(value) as TestId;
    const split = value.indexOf('::');
    return { file: value.slice(0, split), name: value.slice(split + 2) };
  });
  const message = 'Production bootstrap could not establish the trusted test-run channel. Reconcile the original request with main and restore the host command channel before retrying.';
  const error = Object.assign(new Error(message), { code: 'STATE_CONTEXT_REFUSED' });
  const result = testRunFailureResult({ ...args, phase: args.phase ?? '', only }, {
    cwd: process.cwd(), workspace: process.cwd(), projectWorkspaces: {}, agentPhases: [], activeChanges: [],
    agentId: '', sha: '', home: '', statePath: '', tmpPath: '', operationalHome: '',
  }, randomUUID(), Date.now(), null, error);
  result.diagnostics[0].message = message;
  result.nextAction = 'reconcile';
  result.hints = [message];
  return { exitCode: 1, stdout: JSON.stringify(result) + '\n', stderr };
}
