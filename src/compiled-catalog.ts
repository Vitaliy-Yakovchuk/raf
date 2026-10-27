import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogGenerator } from './catalog-generator.ts';
import { productionBindings } from './production-bindings.ts';
import type { GeneratedCatalog } from './catalog-generator.ts';

export function readCatalogArtifact(artifactPath: string | URL): GeneratedCatalog {
  let contents: string;
  try { contents = readFileSync(artifactPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const outputPath = artifactPath instanceof URL ? fileURLToPath(artifactPath) : resolve(artifactPath);
    return new CatalogGenerator().build({ confDirectory: resolve(dirname(outputPath), '../../conf'), outputPath, bindings: productionBindings() });
  }
  return JSON.parse(contents);
}

export function loadCompiledCatalog(artifactPath: string | URL = new URL('../dist/catalog.json', import.meta.url)): GeneratedCatalog {
  let catalog: GeneratedCatalog;
  try { catalog = readCatalogArtifact(artifactPath); }
  catch (error) { throw new Error(`Compiled catalog ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!catalog || !Array.isArray(catalog.commands) || !Array.isArray(catalog.reportStatuses) || !catalog.reportStatuses.length || !catalog.constants || !catalog.models || !catalog.projects || !Array.isArray(catalog.errorCodes)) throw new Error(`Invalid compiled catalog ${artifactPath}; rebuild the selected generation`);
  return catalog;
}
