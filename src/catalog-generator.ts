import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileCatalog, type CompiledCatalog } from './catalog.ts';
import { validateCatalogSchema } from './catalog-schema.ts';
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
    validateCatalogSchema(sources.constants);
    const keys = new Map<string, number>();
    bindings.forEach((binding, index) => {
      if (!Array.isArray(binding.path) || !binding.path.length || binding.path.some(token => typeof token !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(token)) || typeof binding.load !== 'function') throw new Error(`bindings/${index}: invalid path or lazy loader`);
      const key = binding.path.join(' ');
      if (keys.has(key)) throw new Error(`bindings/${index}: duplicate binding ${key}; first at bindings/${keys.get(key)}`);
      keys.set(key, index);
    });
    return compileCatalog(sources.constants, sources.models, [...keys.keys()], sources.projects) as GeneratedCatalog;
  }

  build(request: CatalogBuildRequest): GeneratedCatalog {
    const read = (name: string) => {
      const path = join(request.confDirectory, name);
      try { return JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    const catalog = this.compile({ constants: read('raf-constants.json'), models: read('models.json'), projects: read('projects.json') }, request.bindings);
    const contents = JSON.stringify(catalog, null, 2) + '\n';
    mkdirSync(dirname(request.outputPath), { recursive: true });
    const temporary = `${request.outputPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, contents, { flag: 'wx' });
      renameSync(temporary, request.outputPath);
    } finally { rmSync(temporary, { force: true }); }
    return catalog;
  }
}
