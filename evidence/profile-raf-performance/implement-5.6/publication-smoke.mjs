import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHotfixRuntimeInventory, defaultHotfixRuntimePolicy, verifyHotfixRuntimeInventory } from '../../../src/hotfix-runtime-inventory.ts';

const workspace = resolve('.');
const root = mkdtempSync(join(tmpdir(), 'prp56-publication-'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
try {
  for (const path of ['src', 'bin', 'scripts', 'dist', 'test', 'package.json', 'package-lock.json', 'node_modules']) cpSync(join(workspace, path), join(root, path), { recursive: true, dereference: true });
  const inventory = createHotfixRuntimeInventory(root, commit, defaultHotfixRuntimePolicy(root));
  verifyHotfixRuntimeInventory(root, commit, inventory, join(root, 'src/state-store.ts'));
  const evidenceRoot = join(root, 'evidence');
  const typescript = createRequire(join(root, 'src/hotfix-runtime-inventory.ts'))('typescript');
  const retained = { files: inventory.files.length, imports: inventory.loading.imports.length, executables: inventory.loading.executables.length, packageConfigurations: inventory.loading.packageConfigurations.length, typescript: typescript.version };
  const target = join(root, 'src/state-store.ts');
  writeFileSync(target, readFileSync(target, 'utf8') + '\n');
  let mutationRefused = false;
  try { verifyHotfixRuntimeInventory(root, commit, inventory); }
  catch (error) { mutationRefused = error.message.includes('runtime inputs changed'); }
  if (!mutationRefused) throw new Error('Copied generation mutation was accepted');
  console.log(JSON.stringify({ commit, temporaryRoot: root, protectedInputs: retained, mutationRefused, excludedEvidenceNotCopied: evidenceRoot, cleanup: 'finally removes temporary tree' }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
