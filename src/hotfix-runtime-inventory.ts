import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type ts from 'typescript';
import { runtimeLibraryProofs, runtimeLoaderProofs } from './hotfix-runtime-loaders.ts';

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
  directories?: readonly { path: string; mode: number }[];
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

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const below = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');
function refused(reason: string): never { throw new Error('Runtime inventory completeness refused: ' + reason); }
function canonical(path: string): string {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) refused('noncanonical relative path ' + path);
  return path;
}
function paths(values: readonly string[], name: string): string[] {
  if (!Array.isArray(values) || new Set(values).size !== values.length) refused('invalid ' + name);
  return values.map(canonical).sort();
}
function policyPaths(policy: HotfixRuntimePolicy) {
  const scopes = paths(policy.scopes, 'scopes');
  const rootFiles = paths(policy.rootFiles, 'rootFiles');
  const excludedTrees = paths(policy.excludedTrees, 'excludedTrees');
  const entrypoints = paths(policy.entrypoints, 'entrypoints');
  const regions = [...scopes, ...rootFiles, ...excludedTrees];
  if (!entrypoints.length || !scopes.length || regions.some((path, index) => regions.some((other, otherIndex) => index !== otherIndex && below(path, other)))) refused('missing or overlapping search/loading areas');
  if (regions.some(path => path.includes('/'))) refused('search areas must cover complete root entries');
  return { scopes, rootFiles, excludedTrees, entrypoints };
}
function checkedInfo(root: string, path: string) {
  const full = join(root, path);
  const info = lstatSync(full);
  if (info.isSymbolicLink() || realpathSync(full) !== full || info.isFile() && info.nlink !== 1 || !info.isFile() && !info.isDirectory()) refused('alias or unsupported input ' + path);
  return info;
}
function currentFiles(root: string, policy: Pick<HotfixRuntimePolicy, 'scopes' | 'rootFiles' | 'excludedTrees'>, directories?: { path: string; mode: number }[]): HotfixRuntimeFile[] {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || !lstatSync(root).isDirectory()) refused('noncanonical generation root');
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const declared = new Set([...policy.scopes, ...policy.rootFiles, ...policy.excludedTrees]);
  for (const item of entries) {
    const entry = item.name;
    if (entry === '.git') continue;
    if (policy.excludedTrees.includes(entry)) {
      if (!item.isDirectory()) refused('excluded area alias/type changed ' + entry);
      continue;
    }
    if (!declared.has(entry)) refused('unknown root input ' + entry);
    const info = checkedInfo(root, entry);
    if (policy.rootFiles.includes(entry) ? !info.isFile() : !info.isDirectory()) refused('search area type changed ' + entry);
  }
  const files: HotfixRuntimeFile[] = [];
  function walk(path: string): void {
    const info = checkedInfo(root, path);
    if (info.isDirectory()) {
      directories?.push({ path, mode: info.mode & 0o777 });
      for (const name of readdirSync(join(root, path)).sort()) walk(path + '/' + name);
    }
    else files.push({ path, sha256: digest(readFileSync(join(root, path))), mode: info.mode & 0o777 });
  }
  for (const path of [...policy.scopes, ...policy.rootFiles].sort()) walk(path);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function proveLoading(root: string, files: readonly HotfixRuntimeFile[], entrypoints: readonly string[]) {
  const parser = createRequire(import.meta.url)('typescript') as typeof ts;
  const protectedFiles = new Set(files.map(file => file.path));
  const imports = new Set<string>();
  const executables = new Set<string>();
  const packageConfigurations = files.filter(file => /(^|\/)package(?:-lock)?\.json$/.test(file.path)).map(file => file.path);
  const visited = new Set<string>();
  function protectedPath(path: string): string {
    const rel = relative(root, path);
    if (!protectedFiles.has(rel)) refused('loadable input outside protected inventory ' + rel);
    return rel;
  }
  function loadSpecifier(specifier: string, importer: string): void {
    if (specifier.startsWith('node:') || builtinModules.includes(specifier)) return;
    let target: string;
    try { target = createRequire(join(root, importer)).resolve(specifier); }
    catch { return refused('unresolved loading input ' + specifier + ' from ' + importer); }
    const path = protectedPath(target);
    imports.add(path);
    const library = runtimeLibraryProofs[path];
    if (library) {
      if (files.find(file => file.path === path)?.sha256 !== library.sha256 || files.find(file => file.path === importer)?.sha256 !== library.consumers[importer]) refused('unproved library API boundary ' + importer + ' -> ' + path);
      return;
    }
    visit(path);
  }
  function literal(node: ts.Node | undefined): string | undefined {
    return node && parser.isStringLiteralLike(node) ? node.text : undefined;
  }
  function visit(path: string): void {
    if (visited.has(path)) return;
    visited.add(path);
    if (path.endsWith('.json')) return;
    const source = readFileSync(join(root, path), 'utf8');
    const tree = parser.createSourceFile(path, source, parser.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      if ((parser.isImportDeclaration(node) || parser.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!(parser.isImportDeclaration(node) && node.importClause?.isTypeOnly) && !(parser.isExportDeclaration(node) && node.isTypeOnly)) loadSpecifier(literal(node.moduleSpecifier) ?? refused('nonliteral import ' + path), path);
      }
      if (parser.isCallExpression(node)) {
        const expression = node.expression.getText(tree);
        const immediateRequire = parser.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'createRequire';
        if (node.expression.kind === parser.SyntaxKind.ImportKeyword || expression === 'require' || immediateRequire) {
          const specifier = literal(node.arguments[0]);
          if (specifier !== undefined) loadSpecifier(specifier, path);
          else {
            const proof = runtimeLoaderProofs[path];
            if (!proof || files.find(file => file.path === path)?.sha256 !== proof.sha256) refused('unproved dynamic loading in ' + path);
            for (const target of proof.targets) {
              protectedPath(join(root, target));
              imports.add(target);
              visit(target);
            }
          }
        }
        if (/^(?:\w+\.)?(?:spawn|spawnSync|execFile|execFileSync|fork)$/.test(expression)) {
          for (const argument of node.arguments) {
            const candidates = parser.isArrayLiteralExpression(argument) ? argument.elements : [argument];
            for (const candidate of candidates) {
              const value = literal(candidate);
              if (value && !value.startsWith('-') && (value.includes('/') && !/[\s'"`]/.test(value) && !/^[a-z]+:/.test(value) || isAbsolute(value))) {
                const child = protectedPath(resolve(root, value));
                executables.add(child);
                visit(child);
              }
            }
          }
        }
      }
      if (parser.isNewExpression(node) && node.expression.getText(tree) === 'URL' && node.arguments?.[1]?.getText(tree) === 'import.meta.url') {
        const value = literal(node.arguments[0]);
        if (value && !value.endsWith('/')) {
          const target = fileURLToPath(new URL(value, 'file://' + join(root, path)));
          if (below(target, root)) protectedPath(target);
        }
      }
      parser.forEachChild(node, inspect);
    }
    inspect(tree);
  }
  for (const path of entrypoints) { protectedPath(join(root, path)); visit(path); }
  for (const path of packageConfigurations) {
    const metadata = JSON.parse(readFileSync(join(root, path), 'utf8'));
    function validateTargets(value: unknown): void {
      if (typeof value === 'string' && value.startsWith('./')) {
        if (value.includes('*')) {
          const prefix = relative(root, resolve(root, dirname(path), value.split('*')[0]));
          if (!files.some(file => file.path.startsWith(prefix))) refused('unproved package wildcard ' + path);
          const prefixPath = value.split('*')[0].replace(/\/$/, '');
          if (prefixPath && !files.some(file => below(file.path, relative(root, resolve(root, dirname(path), prefixPath))))) refused('package target outside protected areas ' + path);
        } else protectedPath(resolve(root, dirname(path), value));
      }
      else if (Array.isArray(value)) value.forEach(validateTargets);
      else if (value && typeof value === 'object') Object.values(value).forEach(validateTargets);
    }
    for (const script of Object.values(path === 'package.json' ? metadata.scripts ?? {} : {})) {
      if (typeof script !== 'string') refused('invalid package script ' + path);
      const tokens = script.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
      for (const token of tokens) {
        const target = token.replace(/^['"]|['"]$/g, '');
        if (target.includes('/') && !target.startsWith('-') && !/^[a-z]+:/.test(target)) {
          const child = protectedPath(resolve(root, dirname(path), target));
          executables.add(child);
        }
      }
    }
    if (metadata.bin !== undefined) {
      const targets = typeof metadata.bin === 'string' ? [metadata.bin] :
        metadata.bin && typeof metadata.bin === 'object' && !Array.isArray(metadata.bin) ? Object.values(metadata.bin) : refused('invalid package bin ' + path);
      for (const target of targets) {
        if (typeof target !== 'string' || !target || isAbsolute(target)) refused('invalid package bin target ' + path);
        const child = protectedPath(resolve(root, dirname(path), target));
        executables.add(child);
      }
    }
    for (const key of ['main', 'module', 'exports', 'imports']) {
      const value = metadata[key];
      if (typeof value === 'string' && !value.startsWith('.') && !value.includes('*')) {
        if (key !== 'imports') protectedPath(resolve(root, dirname(path), value));
      } else validateTargets(value);
    }
  }
  return { entrypoints: [...entrypoints], imports: [...imports].sort(), executables: [...executables].sort(), packageConfigurations: packageConfigurations.sort() };
}

export function createHotfixRuntimeInventory(root: string, commit: string, policy: HotfixRuntimePolicy): HotfixRuntimeInventory {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) refused('invalid generation commit');
  const normalized = policyPaths(policy);
  const directories: { path: string; mode: number }[] = [];
  const files = currentFiles(root, normalized, directories);
  const loading = proveLoading(root, files, normalized.entrypoints);
  return { version: 1, root, commit, files, directories, scopes: normalized.scopes, rootFiles: normalized.rootFiles, excludedTrees: normalized.excludedTrees, loading };
}

export function verifyHotfixRuntimeInventory(root: string, commit: string, inventory: HotfixRuntimeInventory, modulePath?: string): void {
  if (!inventory || inventory.version !== 1 || inventory.root !== root || inventory.commit !== commit || !Array.isArray(inventory.files) || !inventory.files.length || !inventory.loading) refused('missing or stale trusted inventory');
  const policy = policyPaths({ ...inventory, entrypoints: inventory.loading.entrypoints });
  const protectedFiles = new Set(inventory.files.map(file => canonical(file.path)));
  for (const key of ['imports', 'executables', 'packageConfigurations'] as const) {
    for (const path of paths(inventory.loading[key], key)) if (!protectedFiles.has(path)) refused('loading proof outside inventory ' + path);
  }
  for (const path of policy.entrypoints) if (!protectedFiles.has(path)) refused('entrypoint outside inventory ' + path);
  if (modulePath && (!protectedFiles.has(relative(root, modulePath)) || ![...policy.entrypoints, ...inventory.loading.imports, ...inventory.loading.executables].includes(relative(root, modulePath)) || realpathSync(modulePath) !== modulePath)) refused('actual module outside proved loading inventory');
  const directories: { path: string; mode: number }[] = [];
  if (JSON.stringify(currentFiles(root, policy, directories)) !== JSON.stringify(inventory.files) || inventory.directories && JSON.stringify(directories) !== JSON.stringify(inventory.directories)) refused('runtime inputs changed (content/mode/addition/deletion)');
}

export function defaultHotfixRuntimePolicy(root: string): HotfixRuntimePolicy {
  const scopes: string[] = [];
  const rootFiles: string[] = [];
  const excludedTrees: string[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name === '.git') continue;
    const info = checkedInfo(root, name);
    if (info.isDirectory()) (['evidence', 'docs'].includes(name) ? excludedTrees : scopes).push(name);
    else rootFiles.push(name);
  }
  return { scopes, rootFiles, excludedTrees, entrypoints: ['bin/raf.ts', 'bin/service.ts', 'src/production-entry.ts', 'src/production-runtime.ts', 'src/state-store.ts'] };
}
