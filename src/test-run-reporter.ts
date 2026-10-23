import type { RunnerEvent, TestId } from './test-runs.ts';
import { relative } from 'node:path';

export default async function* report(source: AsyncIterable<any>): AsyncGenerator<string> {
  const expected: TestId[] = [];
  let protocolFailed = false;
  for await (const event of source) {
    const data = event.data;
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (data.details?.type === 'suite' || data.details?.error?.failureType === 'subtestsFailed') continue;
      const test = { file: relative(process.cwd(), data.file ?? data.details?.error?.file ?? ''), name: data.name };
      if (!test.file || !test.name) { protocolFailed = true; continue; }
      expected.push(test);
      const err = data.details?.error;
      const assertion = err?.code === 'ERR_ASSERTION' || err?.cause?.code === 'ERR_ASSERTION' || err?.failureType === 'testCodeFailure' && err?.cause?.name === 'AssertionError';
      const kind: RunnerEvent['kind'] = event.type === 'test:pass' ? 'passed' : assertion ? 'assertion-failed' : 'setup-failed';
      yield JSON.stringify({ kind, test, ...(err ? { diagnostic: String(err.message) } : {}) }) + '\n';
    }
  }
  if (protocolFailed) yield JSON.stringify({ kind: 'protocol-error', diagnostic: 'Missing structured test identity' }) + '\n';
  yield JSON.stringify({ kind: 'complete', expected }) + '\n';
}
