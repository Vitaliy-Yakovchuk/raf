import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHotfixRuntimeInventory, verifyHotfixRuntimeInventory } from '../src/hotfix-runtime-inventory.ts';

for (const source of [
  'export const load = name => import(name);',
  "export const load = () => import('optional-uninstalled-dependency');",
  "export const load = () => import('../docs/runtime.mjs');",
]) {
  test(`Z.444 loading completeness is advisory: ${source}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'inventory-warning-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'src/entry.ts'), source);
    writeFileSync(join(root, 'src/new-consumer.ts'), 'export const ready = true;');
    writeFileSync(join(root, 'docs/runtime.mjs'), 'export const ready = true;');
    const warnings: string[] = [];
    t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { warnings.push(String(chunk)); return true; });
    const commit = '1'.repeat(40);
    let inventory: ReturnType<typeof createHotfixRuntimeInventory>;
    assert.doesNotThrow(() => {
      inventory = createHotfixRuntimeInventory(root, commit, {
        scopes: ['src'], rootFiles: [], excludedTrees: ['docs'], entrypoints: ['src/entry.ts'],
      });
    }, 'an incomplete static loading proof must not stop publication or service start');
    assert.match(warnings.join(''), /Runtime inventory warning:/);
    assert.doesNotThrow(() => verifyHotfixRuntimeInventory(root, commit, inventory!, join(root, 'src/new-consumer.ts')));
    writeFileSync(join(root, 'src/new-consumer.ts'), 'export const replaced = true;');
    assert.throws(() => verifyHotfixRuntimeInventory(root, commit, inventory!), /runtime inputs changed/,
      'advisory loading analysis must preserve the frozen executable bytes');
  });
}

for (const defect of ['missing-loading', 'outside-loading', 'missing-module', 'missing-entrypoints'] as const) {
  test(`Z.444 frozen files remain usable with ${defect} loading proof`, t => {
    const root = mkdtempSync(join(tmpdir(), 'inventory-proof-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/entry.ts'), 'export const ready = true;');
    writeFileSync(join(root, 'src/lazy.ts'), 'export const ready = true;');
    const commit = '1'.repeat(40);
    const inventory = createHotfixRuntimeInventory(root, commit, {
      scopes: ['src'], rootFiles: [], excludedTrees: [], entrypoints: ['src/entry.ts'],
    });
    const incomplete = inventory as any;
    if (defect === 'missing-loading') delete incomplete.loading;
    if (defect === 'outside-loading') incomplete.loading.imports.push('src/unknown.ts');
    if (defect === 'missing-entrypoints') incomplete.loading.entrypoints = [];
    const warnings: string[] = [];
    t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { warnings.push(String(chunk)); return true; });
    assert.doesNotThrow(() => verifyHotfixRuntimeInventory(root, commit, inventory, join(root, 'src/lazy.ts')),
      'loading metadata must not block a module whose canonical bytes are in the frozen inventory');
    assert.match(warnings.join(''), /Runtime inventory warning:/);
    assert.throws(() => verifyHotfixRuntimeInventory(root, commit, inventory, join(root, 'src/outside.ts')),
      /actual module outside/, 'an unprotected module must not inherit access to production secrets');
    assert.throws(() => verifyHotfixRuntimeInventory(root, '2'.repeat(40), inventory), /stale trusted inventory/);
    writeFileSync(join(root, 'src/lazy.ts'), 'export const injected = true;');
    assert.throws(() => verifyHotfixRuntimeInventory(root, commit, inventory), /runtime inputs changed/);
  });
}
