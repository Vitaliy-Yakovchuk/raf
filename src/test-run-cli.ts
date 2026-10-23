import { parseTestRunArgs, runTestRun } from './test-runs.ts';
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
    const result = await runTestRun({ ...args, only }, ports.config, ports.policy, ports.context, ports.runtime);
    ports.stdout(JSON.stringify(result) + '\n');
    return result.outcome === 'passed' ? 0 : 1;
  } catch (error) {
    ports.stderr(JSON.stringify({ outcome: 'refused', failureKinds: ['refusal'], errorCode: (error as any)?.code ?? 'INVALID_ARGUMENT', reason: error instanceof Error ? error.message : String(error), exitCode: null }) + '\n');
    return 1;
  }
}
