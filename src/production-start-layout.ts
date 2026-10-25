import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { configuredMainLayoutPaths } from './main-layout-paths.ts';
import { ensureMainLayoutForStart, type MainLayoutStartOptions } from './main-layout.ts';
import { ensureProductionMainStore, type ProductionStoreOptions } from './main-production-store.ts';

export interface ProductionStartLayoutOptions {
  orchestratorRoot: string;
  publicationProvider?: MainLayoutStartOptions['publicationProvider'];
  onLayoutCheckpoint?: MainLayoutStartOptions['onCheckpoint'];
  onStoreCheckpoint?: ProductionStoreOptions['onCheckpoint'];
}

export async function prepareMainLayoutForProductionStart(
  options: ProductionStartLayoutOptions,
): Promise<void> {
  const { projects } = JSON.parse(await fs.readFile(join(options.orchestratorRoot, 'conf/projects.json'), 'utf8'));
  if (!projects || typeof projects !== 'object' || !projects.raf) throw new Error('Production start requires registered raf projects configuration');
  if (projects.raf.mainCopies !== undefined) configuredMainLayoutPaths(options.orchestratorRoot, projects);
  await ensureProductionMainStore({ root: options.orchestratorRoot, onCheckpoint: options.onStoreCheckpoint });
  if (projects.raf.mainCopies !== undefined) {
    await ensureMainLayoutForStart({
      root: options.orchestratorRoot,
      projects,
      publicationProvider: options.publicationProvider,
      onCheckpoint: options.onLayoutCheckpoint,
    });
  }
}
