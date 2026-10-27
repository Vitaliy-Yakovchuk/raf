import type { ExecutionResult, Handler } from './cli.ts';
import { execute } from './cli.ts';
import { readCatalogArtifact } from './compiled-catalog.ts';
import { compileCatalog } from './catalog.ts';
import type { CompiledCatalog } from './catalog.ts';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';





export function buildCatalog(
  confDir: string,
  outputPath: string,
  handlerNames: readonly string[],
): void {
  const constants = JSON.parse(readFileSync(join(confDir, 'raf-constants.json'), 'utf8'));
  const models = JSON.parse(readFileSync(join(confDir, 'models.json'), 'utf8'));
  const projectsPath = join(confDir, 'projects.json');
  const projects = existsSync(projectsPath) ? JSON.parse(readFileSync(projectsPath, 'utf8')) : undefined;
  const catalog = compileCatalog(constants, models, handlerNames, projects);
  const contents = JSON.stringify(catalog, null, 2) + '\n';
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx' });
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}




export async function runCli(
  argv: readonly string[],
  artifactPath: string,
  handlers: Record<string, Handler>,
): Promise<ExecutionResult> {
  let catalog: CompiledCatalog;
  try {
    catalog = readCatalogArtifact(artifactPath);
    if (!catalog || !Array.isArray(catalog.commands) || !Array.isArray(catalog.reportStatuses)) throw new Error('Invalid catalog');
  } catch {
    return {
      exitCode: 1,
      stdout: '',
      stderr: JSON.stringify({
        code: 'CATALOG_UNAVAILABLE',
        message: 'Скомпільований каталог відсутній або його неможливо прочитати.',
        details: { artifactPath, stage: 'startup', sideEffects: [] },
        remediation: 'Виконайте npm run build у raf-develop, потім повторіть виклик.',
      }),
    };
  }
  return execute(argv, catalog, handlers);
}
