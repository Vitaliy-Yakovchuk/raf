import { fileURLToPath } from 'node:url';
import { checkRepositoryComments } from '../src/comment-policy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const comments = await checkRepositoryComments(root);
for (const comment of comments) {
  console.error(`${comment.filePath}:${comment.line}:${comment.column}: коментар у власному коді.`);
}
if (comments.length > 0) process.exitCode = 1;
