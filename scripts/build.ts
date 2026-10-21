import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkRepositoryComments } from '../src/comment-policy.ts';
import { buildCatalog } from '../src/bootstrap.ts';

const confDir = fileURLToPath(new URL('../../conf/', import.meta.url));
const outputPath = fileURLToPath(new URL('../dist/catalog.json', import.meta.url));

try {
  const comments = await checkRepositoryComments(fileURLToPath(new URL('../', import.meta.url)));
  if (comments.length > 0) {
    throw new Error(comments.map(({ filePath, line, column }) => `${filePath}:${line}:${column}: коментар у власному коді.`).join('\n'));
  }
  const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  const names = constants.commands.map((command: { path: string[] }) => command.path.join(' '));
  buildCatalog(confDir, outputPath, names);
  console.log('Каталог зібрано. Операційні команди ще не реалізовані.');
} catch (error) {
  console.error(JSON.stringify({ code: 'BUILD_FAILED', message: error instanceof Error ? error.message : 'Невідома помилка збірки.', details: { stage: 'build', outputPath }, remediation: 'Виправте джерело каталогу та повторіть npm run build.' }));
  process.exitCode = 1;
}
