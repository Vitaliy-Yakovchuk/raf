import { readFileSync } from 'node:fs';
import type { GeneratedCatalog } from './catalog-generator.ts';

export function readCatalogArtifact(artifactPath: string | URL): GeneratedCatalog {
  return JSON.parse(readFileSync(artifactPath, 'utf8'));
}

export function loadCompiledCatalog(artifactPath: string | URL = new URL('../dist/catalog.json', import.meta.url)): GeneratedCatalog {
  let catalog: GeneratedCatalog;
  try { catalog = readCatalogArtifact(artifactPath); }
  catch (error) { throw new Error(`Compiled catalog ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!catalog || !Array.isArray(catalog.commands) || !Array.isArray(catalog.reportStatuses) || !catalog.reportStatuses.length || !catalog.constants || !catalog.models || !catalog.projects || !Array.isArray(catalog.errorCodes)) throw new Error(`Invalid compiled catalog ${artifactPath}; rebuild the selected generation`);
  return catalog;
}
