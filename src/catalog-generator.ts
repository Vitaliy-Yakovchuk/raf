import type { CompiledCatalog } from './catalog.ts';
import type { Handler } from './cli.ts';

export interface CatalogSources {
  constants: unknown;
  models: unknown;
  projects: unknown;
}

export interface CatalogHandlerBinding {
  path: readonly string[];
  load: () => Promise<Handler>;
}

export interface GeneratedCatalog extends CompiledCatalog {
  constants: Readonly<Record<string, unknown>>;
  models: Readonly<Record<string, unknown>>;
  projects: Readonly<Record<string, unknown>>;
}

export interface CatalogBuildRequest {
  confDirectory: string;
  outputPath: string;
  bindings: readonly CatalogHandlerBinding[];
}

export class CatalogGenerator {
  compile(sources: CatalogSources, bindings: readonly CatalogHandlerBinding[]): GeneratedCatalog {
    throw new Error('NotImplemented: CatalogGenerator.compile');
  }

  build(request: CatalogBuildRequest): GeneratedCatalog {
    throw new Error('NotImplemented: CatalogGenerator.build');
  }
}
