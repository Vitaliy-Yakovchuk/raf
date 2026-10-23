import type { RunnerEvent, TestId } from './test-runs.ts';
import { isAbsolute, relative } from 'node:path';

export default async function* report(source: AsyncIterable<any>, selected?: TestId[]): AsyncGenerator<string> {
  const expected: TestId[] = [];
  const parents = new Map<number, string>();
  const declared = new Map<string, { test: TestId; type: string }>();
  let protocolFailed = false;
  for await (const event of source) {
    const data = event.data;
    if (event.type === 'test:enqueue' && data.entryFile) {
      const file = relative(process.cwd(), data.file);
      const parent = declared.get(`${file}:${data.parentId}`);
      const test = { file, name: parent ? `${parent.test.name} ${data.name}` : data.name };
      declared.set(`${file}:${data.testId}`, { test, type: data.type });
      if (data.type !== 'suite' && (!selected || selected.some(id => id.file === test.file && id.name === test.name))) {
        yield JSON.stringify({ kind: 'discovered', test, ...(parent?.type === 'test' ? { parent: parent.test } : {}) }) + '\n';
      }
    }
    if (event.type === 'test:start') {
      for (const depth of parents.keys()) if (depth >= data.nesting) parents.delete(depth);
      parents.set(data.nesting, data.name);
    }
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (data.details?.type === 'suite') continue;
      const file = data.file ?? (isAbsolute(data.name ?? '') ? data.name : '');
      const test = { file: relative(process.cwd(), file), name: [...Array.from({ length: data.nesting ?? 0 }, (_, depth) => parents.get(depth)).filter(Boolean), data.name].join(' ') };
      if (!test.file || !test.name) { protocolFailed = true; continue; }
      if (selected && !selected.some(id => id.file === test.file && id.name === test.name) && !data.details?.error) continue;
      if (data.details?.error?.failureType === 'subtestsFailed') {
        yield JSON.stringify({ kind: 'container-complete', test }) + '\n';
        continue;
      }
      expected.push(test);
      if (data.skip || data.todo) continue;
      const err = data.details?.error;
      const assertion = err?.code === 'ERR_ASSERTION' || err?.cause?.code === 'ERR_ASSERTION' || err?.failureType === 'testCodeFailure' && err?.cause?.name === 'AssertionError';
      const kind: RunnerEvent['kind'] = event.type === 'test:pass' ? 'passed' : assertion ? 'assertion-failed' : 'setup-failed';
      yield JSON.stringify({ kind, test, ...(err ? { diagnostic: String(err.message) } : {}) }) + '\n';
    }
  }
  if (protocolFailed) yield JSON.stringify({ kind: 'protocol-error', diagnostic: 'Missing structured test identity' }) + '\n';
  yield JSON.stringify({ kind: 'complete', expected: selected ?? expected }) + '\n';
}
