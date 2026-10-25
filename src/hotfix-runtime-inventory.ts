export interface HotfixRuntimeFile {
  path: string;
  sha256: string;
  mode: number;
}

export interface HotfixRuntimeInventory {
  version: 1;
  root: string;
  commit: string;
  files: readonly HotfixRuntimeFile[];
  scopes: readonly string[];
  rootFiles: readonly string[];
  excludedTrees: readonly string[];
  loading: {
    entrypoints: readonly string[];
    imports: readonly string[];
    executables: readonly string[];
    packageConfigurations: readonly string[];
  };
}

export interface HotfixRuntimePolicy {
  scopes: readonly string[];
  rootFiles: readonly string[];
  excludedTrees: readonly string[];
  entrypoints: readonly string[];
}

export function createHotfixRuntimeInventory(root: string, commit: string, policy: HotfixRuntimePolicy): HotfixRuntimeInventory {
  throw new Error('NotImplemented');
}
