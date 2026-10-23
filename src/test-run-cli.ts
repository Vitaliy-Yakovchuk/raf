import type { TestRunContext, TestRunPorts, UnitTestPolicy } from './test-runs.ts';

export interface TestRunCliPorts {
  config: unknown;
  policy: UnitTestPolicy;
  context: TestRunContext;
  runtime: TestRunPorts;
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runTestRunCli(argv: readonly string[], ports: TestRunCliPorts): Promise<number> {
  throw new Error('NotImplemented');
}
