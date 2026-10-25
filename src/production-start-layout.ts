import type { MainLayoutStartOptions } from './main-layout.ts';
import type { ProductionStoreOptions } from './main-production-store.ts';

export interface ProductionStartLayoutOptions {
  orchestratorRoot: string;
  publicationProvider?: MainLayoutStartOptions['publicationProvider'];
  onLayoutCheckpoint?: MainLayoutStartOptions['onCheckpoint'];
  onStoreCheckpoint?: ProductionStoreOptions['onCheckpoint'];
}

export async function prepareMainLayoutForProductionStart(
  options: ProductionStartLayoutOptions,
): Promise<void> {
  throw new Error('NotImplemented');
}
