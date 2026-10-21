import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkRepositoryComments } from '../src/comment-policy.ts';

test('raf source and configuration contain no comments', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const comments = await checkRepositoryComments(root);
  const diagnostics = comments
    .map(({ filePath, line, column }) => `${filePath}:${line}:${column}`)
    .join('\n');
  assert.deepEqual(comments, [], `Comments found in raf:\n${diagnostics}`);
});
