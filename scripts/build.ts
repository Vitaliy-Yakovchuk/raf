import { fileURLToPath } from 'node:url';
import { checkRepositoryComments } from '../src/comment-policy.ts';
import { CatalogGenerator } from '../src/catalog-generator.ts';
import { productionBindings } from '../src/production-bindings.ts';

const confDir = fileURLToPath(new URL('../../conf/', import.meta.url));
const outputPath = fileURLToPath(new URL('../dist/catalog.json', import.meta.url));

try {
  const comments = await checkRepositoryComments(fileURLToPath(new URL('../', import.meta.url)));
  if (comments.length > 0) {
    throw new Error(comments.map(({ filePath, line, column }) => `${filePath}:${line}:${column}: коментар у власному коді.`).join('\n'));
  }
  new CatalogGenerator().build({ confDirectory: confDir, outputPath, bindings: productionBindings() });
  console.log('Каталог перевірено та зібрано; доступність операцій визначають їхні обробники.');
} catch (error) {
  console.error(JSON.stringify({ code: 'BUILD_FAILED', message: error instanceof Error ? error.message : 'Невідома помилка збірки.', details: { stage: 'build', outputPath }, remediation: 'Виправте джерело каталогу та повторіть npm run build.' }));
  process.exitCode = 1;
}
