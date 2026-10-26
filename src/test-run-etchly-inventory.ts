import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyEtchlyWorkerTestGraph, runtimeImports, validateEtchlyIntegrationInventories } from './test-run-etchly-integration.ts';
import type { WorkerTestClass } from './test-run-etchly-integration.ts';
import { auditEtchlyInventory } from './test-run-etchly.ts';
import type { EtchlyInventoryFact } from './test-run-etchly.ts';
import type { TestRunProfile } from './test-runs.ts';

const reviewed = JSON.parse(readFileSync(new URL('./test-run-etchly-audit.json', import.meta.url), 'utf8')) as { sourceHashes: Record<string, string>; nodeDecisions: { file: string; classification: string }[] };
class StaticInventoryUnavailable extends Error {}
const fail = (message: string): never => { throw new StaticInventoryUnavailable(message); };
const warn = (message: string): void => { process.stderr.write(`Warning: etchly inventory: ${message}; review conf/test-runs.json#/projects/etchly/profiles and groups; configured selection is unchanged\n`); };

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonicalJson(entry)]));
  return value;
}

function hash(path: string, file: string): string {
  let source = readFileSync(path);
  if (file === 'package.json') {
    let manifest: unknown;
    try { manifest = JSON.parse(source.toString('utf8')); }
    catch { fail('invalid JSON in package.json'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return fail('invalid root object in package.json');
    const executionManifest = { ...manifest } as Record<string, unknown>;
    delete executionManifest.scripts;
    source = Buffer.from(JSON.stringify(canonicalJson(executionManifest)));
  }
  return createHash('sha256').update(source).digest('hex');
}

export function etchlyBrowserRequirements(workspace: string, files: readonly string[]): string[] {
  const pending = files.map(file => resolve(workspace, file)), seen = new Set<string>();
  const engines = new Set<string>();
  let usesPlaywright = false;
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8').replace(/\b(?:import|export)\s+type\b[^;]*;/g, '');
    if (/\.(?:launch|launchPersistentContext)\s*\(/.test(source)) {
      const names = ['chromium', 'firefox', 'webkit'].filter(name => new RegExp(`\\b${name}\\b`).test(source));
      for (const name of names.length ? names : ['chromium', 'firefox', 'webkit']) engines.add(name);
    }
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (/^(?:playwright(?:-core)?|@playwright\/test)(?:\/|$)/.test(specifier)) usesPlaywright = true;
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(file), specifier);
      if (!base.startsWith(workspace + sep)) continue;
      const dependency = [base, ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].map(suffix => base + suffix)].find(path => existsSync(path) && statSync(path).isFile() && /\.[cm]?[jt]sx?$/.test(path));
      if (dependency) pending.push(dependency);
    }
  }
  return usesPlaywright ? [...engines] : [];
}
function literal(source: string): any {
  const tokens = source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$-]*|[^\s]/g) ?? [];
  let index = 0;
  const value = (): any => {
    const token = tokens[index++];
    if (token === '[') {
      const out: any[] = [];
      while (tokens[index] !== ']') { out.push(value()); if (tokens[index] !== ',') break; index++; }
      if (tokens[index++] !== ']') fail('Unsupported static array');
      return out;
    }
    if (token === '{') {
      const out: Record<string, any> = {};
      while (tokens[index] !== '}') { const key = tokens[index++]!; if (tokens[index++] !== ':') fail('Unsupported static object'); out[key.startsWith('"') ? JSON.parse(key) : key.replace(/^'|'$/g, '')] = value(); if (tokens[index] !== ',') break; index++; }
      if (tokens[index++] !== '}') fail('Unsupported static object');
      return out;
    }
    if (token?.startsWith('"')) return JSON.parse(token);
    if (token?.startsWith("'")) return token.slice(1, -1);
    return fail('Static configuration contains non-literal expression');
  };
  const out = value();
  if (index !== tokens.length) fail('Unsupported static configuration suffix');
  return out;
}
export async function observeEtchlyInventory(workspace: string, profiles: Record<string, TestRunProfile>): Promise<EtchlyInventoryFact[]> {
  try { return await observeInventory(workspace, profiles); }
  catch (error) {
    if (!(error instanceof StaticInventoryUnavailable)) throw error;
    warn(error.message);
    return [];
  }
}

async function observeInventory(workspace: string, profiles: Record<string, TestRunProfile>): Promise<EtchlyInventoryFact[]> {
  const current: Record<string, string> = {};
  for (const [file, expected] of Object.entries(reviewed.sourceHashes)) {
    try { current[file] = hash(resolve(workspace, file), file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error(`Etchly setup: missing audited source ${file}; restore environment without install or branch changes`), { code: 'ENVIRONMENT_INVALID' });
      throw error;
    }
    if (current[file] !== expected) warn(`changed source ${file}`);
  }
  const helper = resolve(workspace, 'test-support/vitest-project-files.ts');
  if (realpathSync(helper) !== helper) fail('classifier symlink');
  const { testProjectFiles } = await import(pathToFileURL(helper).href);
  const facts: EtchlyInventoryFact[] = [];
  let integrationClasses: Record<string, WorkerTestClass> = {};
  for (const name of ['app', 'worker']) {
    const source = readFileSync(resolve(workspace, name, 'vitest.config.ts'), 'utf8');
    const match = source.match(/const files = testProjectFiles\(root,\s*(\[[\s\S]*?\]),\s*(\{[\s\S]*?\}),\s*selectedTestFiles\(root\)\)/);
    if (!match) fail(`unsupported ${name}/vitest.config.ts classification`);
    const patterns = literal(match![1]) as string[], boundaries = literal(match![2]) as Record<string, WorkerTestClass>;
    const groups = testProjectFiles(resolve(workspace, name), patterns, boundaries) as Record<string, string[]>;
    if (name === 'worker' && Object.values(profiles).some(profile => profile.testKind === 'integration')) integrationClasses = Object.fromEntries(Object.entries(observeWorkerGraph(resolve(workspace, name), patterns, boundaries, source)).flatMap(([kind, files]) => files.map(file => [`worker/${file}`, kind as WorkerTestClass])));
    const consentMatch = source.match(/const consentDomFiles = (\[[^;]+\]);/);
    const consent: string[] = consentMatch ? literal(consentMatch[1]) : [];
    for (const [classification, files] of Object.entries(groups)) for (const file of files) facts.push({ file: `${name}/${file}`, classification, profileId: classification === 'unit' ? consent.includes(file) ? 'vitest-worker-consent-dom' : `vitest-${name}` : name === 'worker' && classification === 'd1' ? 'vitest-worker-d1-integration' : null });
  }
  for (const name of ['assessment', 'domain', 'i18n', 'markdown', 'ui-core']) {
    const cwd = `shared/${name}`;
    const source = readFileSync(resolve(workspace, cwd, 'vitest.config.ts'), 'utf8');
    const include = source.match(/include:\s*(\[[^\]]+\])/);
    if (!include || /\bexclude\s*:/.test(source)) fail(`unsupported include/exclude in ${cwd}`);
    for (const file of globSync(literal(include![1]), { cwd: resolve(workspace, cwd), exclude: ['**/node_modules/**', '**/.git/**'] })) facts.push({ file: `${cwd}/${file}`, profileId: `vitest-${name}`, classification: 'unit' });
  }
  const nodeUnits = new Set(profiles['node-root']?.unitFiles ?? []);
  const excludedNodeFiles = new Set(reviewed.nodeDecisions.filter(item => item.classification === 'excluded').map(item => item.file));
  for (const file of globSync('scripts/*.test.mjs', { cwd: workspace })) {
    if (nodeUnits.has(file)) facts.push({ file, classification: 'unit', profileId: 'node-root' });
    else if (excludedNodeFiles.has(file)) facts.push({ file, classification: 'excluded', profileId: null });
    else warn(`unreviewed Node candidate ${file}`);
  }
  auditEtchlyInventory({ profiles: Object.fromEntries(Object.entries(profiles).map(([id, p]) => [id, p.unitFiles ?? []])), sourceHashes: reviewed.sourceHashes }, facts, current);
  const integrationProfiles = Object.fromEntries(Object.entries(profiles).filter(([, profile]) => profile.testKind === 'integration'));
  const failures = validateEtchlyIntegrationInventories(integrationProfiles, { existingFiles: facts.map(fact => fact.file), classifiedFiles: integrationClasses, sourceHashes: current, expectedSourceHashes: reviewed.sourceHashes });
  if (failures.length) throw Object.assign(new Error(failures.map(issue => `${issue.pointer}: ${issue.files.join(', ')}: ${issue.reason}`).join('; ')), { code: 'CONFIGURATION_INVALID' });
  return facts;
}

function observeWorkerGraph(root: string, patterns: string[], boundaries: Record<string, WorkerTestClass>, config: string): Record<string, string[]> {
  const testFiles = globSync(patterns, { cwd: root, exclude: ['**/node_modules/**', '**/.git/**'] }).sort();
  const sources: Record<string, string> = {};
  const pending = [...testFiles], seen = new Set<string>();
  for (const file of pending) {
    if (seen.has(file)) continue;
    seen.add(file);
    const path = resolve(root, file);
    if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) continue;
    if (realpathSync(path) !== path) fail(`worker import graph symlink ${file}`);
    if (boundaries[file] || /\/(?:bundled-prompt-packages|ui(?:-admin)?\.source)\.ts$/.test(file)) continue;
    const source = readFileSync(path, 'utf8');
    sources[file] = source;
    for (const specifier of runtimeImports(file, source)) {
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(path), specifier);
      if (!base.startsWith(root + sep)) continue;
      const dependency = [base, ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].map(suffix => base + suffix), ...(/\.[cm]?js$/.test(base) ? [base.replace(/\.[cm]?js$/, '.ts')] : [])].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      if (dependency) pending.push(dependency.slice(root.length + 1));
    }
  }
  const plan = config.match(/const planFiles = files\.d1!\.filter\(file => \/(.+)\/([a-z]*)\.test\(file\)\);/);
  if (!plan) fail('unsupported worker planFiles classification');
  const pattern = new RegExp(plan![1], plan![2]);
  const classified = classifyEtchlyWorkerTestGraph({ sources, testFiles, boundaries, planFiles: testFiles.filter(file => pattern.test(file)) });
  const groups: Record<string, string[]> = {};
  for (const [file, group] of Object.entries(classified)) (groups[group] ??= []).push(file);
  return groups;
}
