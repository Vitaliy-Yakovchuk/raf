import { run } from 'node:test';
import report from '../src/test-run-reporter.ts';
import type { TestId } from '../src/test-runs.ts';

const ids: TestId[] = JSON.parse(process.env.RAF_TEST_RUN_IDS ?? '[]');
const files = process.argv.slice(2).filter(value => !value.startsWith('--test-name-pattern='));
if (!files.length || files.some(file => file.startsWith('-'))) throw new Error('Exact test files required');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const batches = ids.length ? files.map(file => ({ files: [file], ids: ids.filter(id => id.file === file) })) : [{ files, ids: undefined }];
for (const batch of batches) {
  if (batch.ids && !batch.ids.length) throw new Error('Exact test IDs required for each file');
  const testNamePatterns = batch.ids?.map(id => new RegExp(`^${escape(id.name)}$`));
  const stream = run({ files: batch.files, isolation: 'process', ...(testNamePatterns ? { testNamePatterns } : {}) });
  for await (const line of report(stream, batch.ids)) {
    const event = JSON.parse(line);
    if (event.kind === 'assertion-failed' || event.kind === 'setup-failed' || event.kind === 'protocol-error') process.exitCode = 1;
    if (!process.stdout.write(line)) await new Promise<void>(done => process.stdout.once('drain', done));
  }
}
