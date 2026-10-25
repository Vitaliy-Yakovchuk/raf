import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { inventory as activationInventory } from '../src/hotfix-host.ts';
import { hotfixModuleOrigin } from '../src/hotfix-origin.ts';
import { createHotfixRuntimeInventory, type HotfixRuntimeInventory } from '../src/hotfix-runtime-inventory.ts';
import { resolveStateContext, verifyStateContext, type StateEntryPoint } from '../src/state-migration-guard.ts';

const commit = '1'.repeat(40);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const runtimeInputs = {
  'bin/raf.ts': "import '../src/state-store.ts';\n",
  'src/state-store.ts': "import './lazy.mjs'; import 'origin-dep'; import {spawn} from 'node:child_process'; export const load=()=>import('./dynamic.loader'); export const child=()=>spawn(process.execPath,['scripts/helper']);\n",
  'src/lazy.mjs': 'export const lazy = true;\n',
  'src/dynamic.loader': 'export const dynamic = true;\n',
  'src/nested/package.json': '{"type":"module"}\n',
  'scripts/helper': 'process.stdout.write("helper");\n',
  'dist/catalog.json': '{"commands":[]}\n',
  'dist/runtime.js': 'export const built = true;\n',
  'package.json': '{"name":"origin-fixture","type":"module","bin":"bin/raf.ts","scripts":{"helper":"node scripts/helper"},"dependencies":{"origin-dep":"1.0.0"}}\n',
  'package-lock.json': '{"lockfileVersion":3,"packages":{"node_modules/origin-dep":{"version":"1.0.0"}}}\n',
  'node_modules/origin-dep/package.json': '{"name":"origin-dep","version":"1.0.0","type":"module","exports":"./index.js"}\n',
  'node_modules/origin-dep/index.js': "import {readFileSync} from 'node:fs'; export const table=readFileSync(new URL('./table.payload',import.meta.url));\n",
  'node_modules/origin-dep/table.payload': 'runtime data with an unconventional extension\n',
  'node_modules/origin-dep/nested/package.json': '{"type":"commonjs"}\n',
};

async function fixture(t: TestContext, evidenceCount = 0) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'origin-cost-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const common = join(root, 'git-common');
  const control = join(common, 'raf-hotfix');
  const generation = join(control, 'generations', 'first', 'raf-main');
  const main = join(root, 'raf-main');
  const home = join(root, 'account');
  for (const path of [common, main, home, join(root, 'raf-develop')]) fs.mkdirSync(path, { recursive: true });
  function write(path: string, value: string) {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, value);
  }
  write(join(root, 'conf/projects.json'), JSON.stringify({ version: 1,
    projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' } } },
    profiles: { raf: { production: 'main', environments: { runtime: 'main' } } },
  }));
  write(join(root, 'conf/raf.json'), JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
  for (const [path, content] of Object.entries(runtimeInputs)) write(join(generation, path), content);
  fs.chmodSync(join(generation, 'scripts/helper'), 0o755);
  write(join(generation, 'evidence/base.json'), '{"nonRuntime":true}\n');
  write(join(generation, 'docs/base.md'), '# Non-runtime documentation\n');
  for (let i = 0; i < evidenceCount; i++) {
    write(join(generation, `evidence/run-${i}/result.json`), '{}\n');
    write(join(generation, `evidence/run-${i}/stdout.log`), 'completed\n');
    write(join(generation, `docs/chapter-${i}/notes.md`), '# Notes\n');
  }
  const files = Object.keys(runtimeInputs).sort().map(path => ({ path,
    sha256: digest(fs.readFileSync(join(generation, path))), mode: fs.lstatSync(join(generation, path)).mode & 0o777,
  }));
  const runtimeInventory: HotfixRuntimeInventory = {
    version: 1, root: generation, commit, files,
    scopes: ['bin', 'dist', 'node_modules', 'scripts', 'src'],
    rootFiles: ['package-lock.json', 'package.json'], excludedTrees: ['docs', 'evidence'],
    loading: { entrypoints: ['bin/raf.ts', 'src/state-store.ts'],
      imports: ['src/lazy.mjs', 'src/dynamic.loader', 'node_modules/origin-dep/index.js'],
      executables: ['scripts/helper'],
      packageConfigurations: files.filter(file => file.path.endsWith('package.json') || file.path === 'package-lock.json').map(file => file.path),
    },
  };
  const fullFiles = await activationInventory(generation);
  const record = { root: generation, commit, files: fullFiles, fingerprint: digest(JSON.stringify(fullFiles)), runtimeInventory };
  const registry = { current: generation, generations: { [generation]: record } };
  const registryPath = join(control, 'registry.json');
  const save = () => write(registryPath, JSON.stringify(registry));
  save();
  const previousGit = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (executable: string, args: string[]) => {
    assert.equal(executable, 'git', 'unit fixture never executes a real process');
    const cwd = args[args.indexOf('-C') + 1];
    if (cwd !== root && !cwd?.startsWith(root + '/')) return previousGit(executable, args);
    if (args.includes('--git-common-dir')) return common;
    if (args.includes('--show-toplevel')) return args[args.indexOf('-C') + 1];
    if (args.includes('rev-parse') && args.includes('HEAD')) return commit;
    throw new Error(`Unexpected fixture git operation: ${args.join(' ')}`);
  });
  syncBuiltinESMExports();
  const origin = (module = 'src/state-store.ts', tree = generation) => hotfixModuleOrigin(root, main, join(tree, module), false);
  const context = (entryPoint: StateEntryPoint = 'cli') => resolveStateContext({ orchestratorRoot: root,
    modulePath: join(generation, 'src/state-store.ts'), homeDirectory: home, operatingSystemHome: home,
    environment: { HOME: home }, entryPoint,
  });
  const policy = { scopes: runtimeInventory.scopes, rootFiles: runtimeInventory.rootFiles,
    excludedTrees: runtimeInventory.excludedTrees, entrypoints: runtimeInventory.loading.entrypoints };
  return { root, common, control, generation, main, home, write, record, registry, save, origin, context, policy };
}

function operationCounter(t: TestContext) {
  const operations: { operation: string; path: string }[] = [];
  for (const [target, suffix] of [[fs, 'Sync'], [fs.promises, '']] as const) {
    for (const name of ['readFile', 'readdir', 'lstat', 'stat', 'realpath', 'readlink', 'access', 'open', 'opendir']) {
      const operation = name + suffix;
      const object = target as unknown as Record<string, (...args: any[]) => any>;
      const original = object[operation];
      t.mock.method(object, operation, function (...args: any[]) {
        operations.push({ operation, path: args[0] instanceof URL ? args[0].pathname : String(args[0]) });
        return Reflect.apply(original, target, args);
      });
    }
  }
  syncBuiltinESMExports();
  return { operations, measure<T>(observe: () => T) {
    operations.length = 0;
    const result = observe();
    return { result, operations: [...operations] };
  } };
}

test('[module-origin-cost] extra published evidence and docs add zero guard file operations', async t => {
  const small = await fixture(t, 0);
  const large = await fixture(t, 24);
  const counter = operationCounter(t);
  const before = counter.measure(small.origin);
  const after = counter.measure(large.origin);
  assert.equal(before.result, small.generation);
  assert.equal(after.result, large.generation);
  assert.equal(after.operations.length, before.operations.length, 'one guard must not grow with excluded files or directory depth');
  for (const name of ['readFileSync', 'readdirSync', 'lstatSync']) {
    assert.equal(after.operations.filter(op => op.operation === name).length,
      before.operations.filter(op => op.operation === name).length, `${name} must be independent of evidence volume`);
  }
});

test('[module-origin-cost] one guard never traverses or reads proven non-runtime trees', async t => {
  const f = await fixture(t, 3);
  const counter = operationCounter(t);
  const observed = counter.measure(f.origin);
  assert.equal(observed.result, f.generation);
  const excluded = observed.operations.filter(op => ['evidence', 'docs'].some(tree =>
    op.path === join(f.generation, tree) || op.path.startsWith(join(f.generation, tree) + '/')));
  assert.deepEqual(excluded, [], 'even metadata/traversal of excluded descendants is forbidden');
});

test('[module-origin-cost] every successful guard rereads runtime bytes without a success cache', async t => {
  const f = await fixture(t);
  const counter = operationCounter(t);
  for (let i = 0; i < 2; i++) {
    const observed = counter.measure(f.origin);
    assert.equal(observed.result, f.generation);
    for (const path of Object.keys(runtimeInputs)) assert.ok(observed.operations.some(op =>
      op.path === join(f.generation, path) && op.operation.startsWith('readFile')), `guard ${i} must reread ${path}`);
  }
});

for (const path of Object.keys(runtimeInputs)) {
  for (const mutation of ['bytes', 'mode', 'delete'] as const) {
    test(`[module-origin-cost] ${mutation} of ${path} refuses immediately after a successful guard`, async t => {
      const f = await fixture(t);
      assert.equal(f.origin(), f.generation);
      const target = join(f.generation, path);
      if (mutation === 'bytes') fs.appendFileSync(target, '\nchanged\n');
      if (mutation === 'mode') fs.chmodSync(target, (fs.lstatSync(target).mode & 0o777) ^ 0o100);
      if (mutation === 'delete') fs.unlinkSync(target);
      assert.equal(f.origin(), undefined, `${mutation} must invalidate ${path}; no timer or cache may defer refusal`);
    });
  }
}

for (const path of ['src/new.unusual', 'src/new-package/package.json', 'scripts/new-child', 'dist/new.js',
  'node_modules/new-package/package.json', 'node_modules/origin-dep/new.payload', 'new-package/package.json']) {
  test(`[module-origin-cost] a new potential input ${path} cannot be trusted automatically`, async t => {
    const f = await fixture(t);
    assert.equal(f.origin(), f.generation);
    f.write(join(f.generation, path), '{}\n');
    assert.equal(f.origin(), undefined, 'enumerating only manifest files misses new resolution inputs');
  });
}

for (const alias of ['file-symlink', 'file-hardlink', 'directory-symlink'] as const) {
  for (const tree of ['src', 'node_modules/origin-dep']) {
    test(`[module-origin-cost] ${alias} in ${tree} refuses despite identical bytes`, async t => {
      const f = await fixture(t);
      assert.equal(f.origin(), f.generation);
      const target = join(f.generation, tree, tree === 'src' ? 'lazy.mjs' : 'index.js');
      const outside = join(f.root, 'outside-copy');
      if (alias === 'directory-symlink') {
        const directory = join(f.generation, tree);
        fs.renameSync(directory, outside);
        fs.symlinkSync(outside, directory, 'dir');
      } else {
        fs.copyFileSync(target, outside);
        fs.unlinkSync(target);
        if (alias === 'file-symlink') fs.symlinkSync(outside, target);
        else fs.linkSync(outside, target);
      }
      assert.equal(f.origin(), undefined, 'canonical paths and unique files are part of runtime provenance');
    });
  }
}

for (const defect of ['missing', 'wrong-root', 'wrong-commit', 'missing-file', 'missing-scopes', 'unsupported-version'] as const) {
  test(`[module-origin-cost] ${defect} runtime inventory fails closed with an intact full fingerprint`, async t => {
    const f = await fixture(t);
    assert.equal(f.origin(), f.generation);
    const manifest = f.record as any;
    if (defect === 'missing') delete manifest.runtimeInventory;
    if (defect === 'wrong-root') manifest.runtimeInventory.root = f.main;
    if (defect === 'wrong-commit') manifest.runtimeInventory.commit = '2'.repeat(40);
    if (defect === 'missing-file') manifest.runtimeInventory.files = manifest.runtimeInventory.files.slice(1);
    if (defect === 'missing-scopes') manifest.runtimeInventory.scopes = [];
    if (defect === 'unsupported-version') manifest.runtimeInventory.version = 999;
    f.save();
    assert.equal(f.origin(), undefined, 'a valid activation digest cannot replace a complete generation-bound runtime inventory');
  });
}

test('[module-origin-cost] changing the canonical root rejects a pathname alias', async t => {
  const f = await fixture(t);
  assert.equal(f.origin(), f.generation);
  const moved = f.generation + '-moved';
  fs.renameSync(f.generation, moved);
  fs.symlinkSync(moved, f.generation, 'dir');
  assert.equal(f.origin(), undefined);
});

test('[module-origin-cost] a retained reader uses its own inventory after the main route advances', async t => {
  const f = await fixture(t);
  const next = join(f.control, 'generations/next/raf-main');
  fs.cpSync(f.generation, next, { recursive: true });
  f.write(join(next, 'src/lazy.mjs'), 'export const lazy = "next";\n');
  const nextFiles = await activationInventory(next);
  const nextRuntime = structuredClone(f.record.runtimeInventory);
  nextRuntime.root = next;
  nextRuntime.commit = '2'.repeat(40);
  nextRuntime.files = nextRuntime.files.map(file => ({ ...file, sha256: digest(fs.readFileSync(join(next, file.path))) }));
  (f.registry.generations as any)[next] = { root: next, commit: nextRuntime.commit,
    files: nextFiles, fingerprint: digest(JSON.stringify(nextFiles)), runtimeInventory: nextRuntime };
  f.registry.current = next;
  f.save();
  assert.equal(f.origin(), f.generation, 'old physical generation remains valid for its reader');
  assert.equal(f.origin('src/state-store.ts', next), next);
  fs.appendFileSync(join(f.generation, 'node_modules/origin-dep/table.payload'), 'changed');
  assert.equal(f.origin(), undefined, 'new inventory must never bless the old dependency');
  assert.equal(f.origin('src/state-store.ts', next), next);
});

for (const entryPoint of ['cli', 'worker', 'service-store', 'hook', 'notice', 'runner-limits'] as const) {
  test(`[module-origin-cost] ${entryPoint} refuses changed dependencies before touching state`, async t => {
    const f = await fixture(t);
    const context = f.context(entryPoint);
    const state = join(f.home, '.raf');
    assert.equal(fs.existsSync(state), false);
    fs.appendFileSync(join(f.generation, 'node_modules/origin-dep/index.js'), '\nchanged');
    assert.throws(() => verifyStateContext(context), { code: 'STATE_CONTEXT_REFUSED' });
    assert.equal(fs.existsSync(state), false, 'refusal must not create SQLite, WAL, SHM or the state directory');
  });
}

test('[module-origin-cost] the publication inventory builder includes runtime dependencies and unconventional inputs', async t => {
  const f = await fixture(t);
  let manifest: HotfixRuntimeInventory | undefined;
  assert.doesNotThrow(() => { manifest = createHotfixRuntimeInventory(f.generation, commit, f.policy); }, 'trusted publication must build a complete runtime proof');
  assert.equal(manifest!.root, f.generation);
  assert.equal(manifest!.commit, commit);
  for (const expected of f.record.runtimeInventory.files) assert.deepEqual(manifest!.files.find(file => file.path === expected.path), expected);
  assert.ok(manifest!.scopes.length > 0);
  assert.ok(!manifest!.files.some(file => /^(evidence|docs)\//.test(file.path)));
});

for (const source of ["export const load=()=>import(process.env.UNKNOWN_MODULE);\n",
  "import '../evidence/executable.payload';\n", "import {spawn} from 'node:child_process'; spawn(process.execPath,['docs/child.payload']);\n",
  "import {readFileSync} from 'node:fs'; readFileSync(new URL('../docs/package.json', import.meta.url));\n"]) {
  test(`[module-origin-cost] excluded or unbounded loading is refused by publication: ${source.trim()}`, async t => {
    const f = await fixture(t);
    f.write(join(f.generation, 'src/state-store.ts'), source);
    f.write(join(f.generation, 'evidence/executable.payload'), 'export const loaded = true;\n');
    f.write(join(f.generation, 'docs/child.payload'), 'process.exit(0);\n');
    f.write(join(f.generation, 'docs/package.json'), '{}\n');
    assert.throws(() => createHotfixRuntimeInventory(f.generation, commit, f.policy), error => {
      assert.match(String(error), /inventory|load|scope|resolution|unproven|unsupported|excluded/i);
      assert.doesNotMatch(String(error), /NotImplemented/);
      return true;
    }, 'a directory name or filename extension is not a completeness proof');
  });
}

for (const tree of ['evidence', 'docs']) {
  for (const mutation of ['bytes', 'add', 'delete', 'mode', 'symlink', 'hardlink'] as const) {
    test(`[module-origin-cost] full activation fingerprint still detects ${mutation} in excluded ${tree}`, async t => {
      const f = await fixture(t);
      const before = await activationInventory(f.generation);
      const target = join(f.generation, tree, tree === 'docs' ? 'base.md' : 'base.json');
      assert.ok(before.some(file => file.path === relative(f.generation, target)), 'activation snapshot includes excluded non-runtime files');
      if (mutation === 'bytes') fs.appendFileSync(target, 'changed');
      if (mutation === 'add') f.write(join(f.generation, tree, 'new.file'), 'new');
      if (mutation === 'delete') fs.unlinkSync(target);
      if (mutation === 'mode') fs.chmodSync(target, (fs.lstatSync(target).mode & 0o777) ^ 0o100);
      if (mutation === 'symlink' || mutation === 'hardlink') {
        const outside = join(f.root, 'alias');
        fs.copyFileSync(target, outside);
        fs.unlinkSync(target);
        if (mutation === 'symlink') fs.symlinkSync(outside, target);
        else fs.linkSync(outside, target);
        await assert.rejects(activationInventory(f.generation), /symlink|alias/);
      } else assert.notEqual(digest(JSON.stringify(await activationInventory(f.generation))), digest(JSON.stringify(before)),
        'runtime exclusions must not narrow the full activation fingerprint');
    });
  }
}
