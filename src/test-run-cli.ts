import { acknowledgeTestRunDelivery } from './test-run-state-recovery.ts';
import { runResourceReservedTestRun } from './test-run-reservations.ts';
import type { ResourceReservedTestRunPorts } from './test-run-reservations.ts';
import { parseTestRunArgs, runTestRun, testRunFailureResult } from './test-runs.ts';
import type { TestId, TestRunContext, TestRunPorts, UnitTestPolicy } from './test-runs.ts';

export interface TestRunCliPorts {
  config: unknown;
  policy: UnitTestPolicy;
  context: TestRunContext;
  runtime: TestRunPorts;
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runTestRunCli(argv: readonly string[], ports: TestRunCliPorts): Promise<number> {
  try {
    const args = parseTestRunArgs(argv);
    const only = args.only?.map(value => {
      let id: TestId;
      if (value.startsWith('{')) id = JSON.parse(value);
      else {
        const split = value.indexOf('::');
        if (split < 1) throw new Error('Use file::test name for an exact test-id');
        id = { file: value.slice(0, split), name: value.slice(split + 2) };
      }
      if (!id || typeof id.file !== 'string' || typeof id.name !== 'string' || !id.name.length) throw new Error('Invalid exact test-id');
      return id;
    });
    const run = 'resources' in ports.runtime ? runResourceReservedTestRun : runTestRun;
    const result = await run({ ...args, only }, ports.config, ports.policy, ports.context, ports.runtime as ResourceReservedTestRunPorts);
    ports.stdout(JSON.stringify(result) + '\n');
    if (!ports.runtime.deferDelivery && result.groupSnapshot === 'loaded') await acknowledgeTestRunDelivery(result, ports.runtime.state);
    return result.outcome === 'passed' ? 0 : 1;
  } catch (error) {
    const value = (option: string) => { const index = argv.indexOf(option); return index >= 0 ? argv[index + 1] ?? '' : ''; };
    ports.stdout(JSON.stringify(testRunFailureResult({ project: value('--project'), phase: value('--phase'), group: value('--group') }, ports.context, ports.runtime.newRunId(), ports.runtime.clock.now(), ports.config, error)) + '\n');
    return 1;
  }
}
