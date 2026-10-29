import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const key = Symbol.for('raf.z461.store');
const url = new URL('../src/main-production-store.ts?z461-store-unit', import.meta.url).href;
const bridge = 'const f = () => globalThis[Symbol.for("raf.z461.store")];';
const doubles = {
  'node:fs': `${bridge} import { promises as real } from 'node:fs'; export const promises = { ...real, copyFile: (...args) => f().copyFile(...args) };`,
  './git.ts': `${bridge} export const gitOutput = (...args) => f().git(...args); export const readGitHead = () => ({commit:'abcdef'}); export const readGitMetadata = cwd => f().metadata(cwd);`,
  './hotfix-host.ts': `${bridge} import { promises as fs } from 'node:fs'; export const alive = async () => false; export const processStart = async () => 'unit'; export const durable = (...args) => f().durable(...args); export const readLease = path => fs.readFile(path, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return undefined; throw error; });`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === url && doubles[specifier]) return { url: 'z461-store:' + specifier, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('z461-store:')) return { format: 'module', source: doubles[url.slice('z461-store:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { ensureProductionMainStore } = await import(url) as typeof import('../src/main-production-store.ts');
test.after(() => hooks.deregister());

async function fixture(t, fault: 'prune-incomplete' | 'automatic-maintenance') {
  const root = await fs.mkdtemp(join(tmpdir(), 'z461-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.git'), active = join(root, 'raf-main-a'), inactive = join(root, 'raf-main-b');
  await fs.mkdir(join(root, 'conf'));
  await fs.writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { branchPaths: { develop: 'raf-develop', main: 'raf-main' }, mainCopies: ['raf-main-a', 'raf-main-b'] } } }));
  await fs.mkdir(source);
  for (const [name, cwd] of [['active', active], ['inactive', inactive], ['develop', join(root, 'raf-develop')]]) {
    const metadata = join(source, 'worktrees', name);
    await fs.mkdir(metadata, { recursive: true }); await fs.mkdir(cwd);
    await fs.writeFile(join(cwd, '.git'), 'gitdir: ' + metadata + '\n');
    await fs.writeFile(join(metadata, 'commondir'), '../..\n');
    for (const file of ['HEAD', 'index', 'ORIG_HEAD']) await fs.writeFile(join(metadata, file), file + '-' + name);
  }
  await fs.symlink(active, join(root, 'raf-main'));
  const settings = new Map<string, string>();
  const events: string[] = [];
  const f = {
    metadata(cwd) {
      const name = cwd === active ? 'active' : cwd === inactive ? 'inactive' : 'develop';
      return { commonDirectory: source, gitDirectory: join(source, 'worktrees', name) };
    },
    async durable(path, value) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, JSON.stringify(value)); },
    async copyFile(from, to) {
      if (String(to).includes('/worktrees/main-inactive/')) {
        const directory = dirname(to);
        if (fault === 'prune-incomplete' && !await fs.readFile(join(directory, 'gitdir'), 'utf8').catch(() => '')) {
          await fs.copyFile(from, to);
          await fs.rm(directory, { recursive: true });
          events.push('pruned-incomplete');
          return;
        }
      }
      return fs.copyFile(from, to);
    },
    async git(args) {
      if (args.includes('clone')) { await fs.mkdir(args.at(-1), { recursive: true }); return ''; }
      const config = args.indexOf('config');
      if (config >= 0 && !args[config + 1].startsWith('--')) settings.set(args[config + 1], args[config + 2]);
      if (args.includes('fetch')) {
        events.push('fetch');
        if (fault === 'automatic-maintenance') {
          const configured = settings.get('gc.auto') === '0' && settings.get('maintenance.auto') === 'false';
          const overridden = args.includes('gc.auto=0') && args.includes('maintenance.auto=false');
          assert.ok(configured || overridden, 'staging fetch may run automatic maintenance against incomplete worktrees');
        }
      }
      if (args.includes('get-url')) return source;
      return '';
    },
  };
  const previous = globalThis[key]; globalThis[key] = f;
  t.after(() => { globalThis[key] = previous; });
  return { root, events };
}

for (const fault of ['prune-incomplete', 'automatic-maintenance'] as const) {
  test('Z.461 protected staging survives ' + fault, async t => {
    const f = await fixture(t, fault);
    await assert.doesNotReject(ensureProductionMainStore({ root: f.root, onCheckpoint(phase) {
      if (phase === 'store-prepared') throw new Error('unit-staging-complete');
    } }).catch(error => { if (error.message !== 'unit-staging-complete') throw error; }));
    assert.ok(f.events.includes('fetch'));
    assert.ok(!f.events.includes('pruned-incomplete'));
  });
}
