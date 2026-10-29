import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gitOutput, readGitHead, readGitMetadata } from './git.ts';
import { alive, durable, exists, git, hash, inventory, json, locked, readLease, mainRoute, processStart } from './hotfix-host.ts';
import { configuredMainLayoutPaths } from './main-layout-paths.ts';
import type { HotfixHost, HotfixWorkspace } from './hotfix-worktree.ts';
import type { VerifiedHotfix } from './hotfix-activation.ts';
import type { MainReleaseIntent, MainReleaseSnapshot, MainSlot, MainSymlinkStorage } from './main-symlink-release.ts';

type Published = { root: string; commit: string; fingerprint: string; candidate?: VerifiedHotfix };
const fail = (message: string): never => { throw new Error('Main symlink publication: ' + message); };
const other = (slot: MainSlot): MainSlot => slot === 'a' ? 'b' : 'a';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function syncDirectory(path: string) {
  const handle = await fs.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function removeDurable(path: string) {
  await fs.rm(path, { force: true });
  await syncDirectory(dirname(path));
}
async function indexGit(cwd: string, index: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return gitOutput(['--no-optional-locks', '-C', cwd, ...args], { env: { ...env, GIT_INDEX_FILE: index } });
}

export class ProductionMainSymlinkStorage implements MainSymlinkStorage {
  readonly logicalPath: string;
  private readonly host: HotfixHost;

  constructor(host: HotfixHost) {
    this.host = host;
    this.logicalPath = join(host.orchestratorRoot, 'raf-main');
  }

  private async context() {
    const { projects } = await json(join(this.host.orchestratorRoot, 'conf/projects.json'));
    const layout = configuredMainLayoutPaths(this.host.orchestratorRoot, projects);
    if (!(await fs.lstat(this.logicalPath)).isSymbolicLink()) fail('expected registered logical main symlink');
    const route = await mainRoute(this.host);
    const roots = { a: layout.physical[0], b: layout.physical[1] };
    const active = Object.entries(roots).find(([, root]) => root === route.cwd)?.[0] as MainSlot | undefined;
    if (!active) fail('unregistered logical target');
    return { ...route, roots, active, intent: join(route.control, 'main-symlink-intent.json'), published: join(route.control, 'main-symlink-published.json') };
  }

  private async slot(root: string) {
    const commit = readGitHead(root).commit ?? '';
    const files = await inventory(root);
    const tree = hash(JSON.stringify(files));
    const configuration = (await inventory(join(this.host.orchestratorRoot, 'conf'), new Set())).map(file => ({ ...file, path: join('conf', file.path) }));
    return { root, commit, fingerprint: hash(JSON.stringify({ tree, files, configuration })) };
  }

  async inspect(): Promise<MainReleaseSnapshot> {
    const context = await this.context();
    const slots = { a: await this.slot(context.roots.a), b: await this.slot(context.roots.b) };
    const readers: Record<MainSlot, string[]> = { a: [], b: [] };
    const directory = join(context.control, 'readers');
    for (const name of await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!name.endsWith('.json')) continue;
      const reader = await readLease(join(directory, name));
      if (!reader || !await alive(reader.pid, reader.start)) continue;
      for (const slot of ['a', 'b'] as const) if (reader.root === context.roots[slot]) readers[slot].push(name);
    }
    return {
      active: context.active, slots,
      head: slots[context.active].commit,
      activationComplete: !await exists(context.intent),
      handoverComplete: readers[other(context.active)].length === 0,
      readers,
    };
  }

  withPublicationLock<T>(operation: () => Promise<T>): Promise<T> {
    return locked(this.host, async () => operation());
  }

  private async module(roots: Record<MainSlot, string>, path = join(this.host.orchestratorRoot, '.gitmodules')) {
    const values = (await git(this.host.orchestratorRoot, 'config', '-f', path, '--get-regexp', '^submodule\\..*\\.path$')).split('\n');
    const matches = values.map(value => /^submodule\.(.+)\.path (.+)$/.exec(value)).filter(value => value && Object.values(roots).includes(resolve(this.host.orchestratorRoot, value[2])));
    return { name: matches[0]?.[1] ?? 'raf', path: matches[0]?.[2] ?? relative(this.host.orchestratorRoot, roots.a) };
  }

  async prepareVerified(candidate: VerifiedHotfix, destination: MainSlot): Promise<VerifiedHotfix> {
    if (!candidate.snapshot) fail('verified hotfix manifest required');
    if (!same(candidate.files, await inventory(candidate.snapshot.root))) fail('verified hotfix changed');
    const workspace = await this.prepareTree(candidate.workspace, candidate.snapshot.root, candidate.commit, destination);
    const prepared = { ...candidate, workspace };
    await this.assertSnapshot(prepared);
    return prepared;
  }

  private async prepareTree(source: HotfixWorkspace, snapshot: string, commit: string, destination: MainSlot) {
    const context = await this.context();
    const state = await this.inspect();
    if (await this.readIntent() || destination === state.active || !state.activationComplete || !state.handoverComplete || state.readers[destination].length) fail('inactive main slot busy');
    const cwd = context.roots[destination];
    await git(cwd, 'fetch', '--no-tags', '--no-write-fetch-head', source.cwd, commit);
    await git(cwd, 'update-ref', '--no-deref', 'HEAD', commit);
    await git(cwd, 'read-tree', commit);
    for (const name of await fs.readdir(cwd)) if (name !== '.git') await fs.rm(join(cwd, name), { recursive: true, force: true });
    for (const name of await fs.readdir(snapshot)) {
      if (name !== '.git') await fs.cp(join(snapshot, name), join(cwd, name), { recursive: true, dereference: name === 'node_modules', errorOnExist: true, force: false });
    }
    const metadata = readGitMetadata(cwd)!;
    return { ...source, cwd, gitDirectory: await fs.realpath(metadata.gitDirectory), commonDirectory: context.productionDirectory };
  }

  async assertSnapshot(candidate: VerifiedHotfix, checkSource = true): Promise<void> {
    const context = await this.context();
    if (!Object.values(context.roots).includes(candidate.workspace.cwd)) fail('candidate is outside the registered main slots');
    const actual = await this.slot(candidate.workspace.cwd);
    if (actual.fingerprint !== candidate.fingerprint || !same(await inventory(candidate.workspace.cwd), candidate.files)) fail('verified main snapshot changed');
    if (!candidate.snapshot || checkSource && !same(await inventory(candidate.snapshot.root), candidate.files)) fail('verified source changed');
    const proof = await json(candidate.evidencePath);
    for (const key of ['snapshot', 'commit', 'tree', 'fingerprint', 'files', 'configuration', 'gates'] as const) if (!same(proof[key], candidate[key])) fail('verification evidence mismatch: ' + key);
  }

  async readIntent(): Promise<MainReleaseIntent | undefined> {
    const context = await this.context();
    if (!await exists(context.intent)) return undefined;
    const intent = await json(context.intent) as MainReleaseIntent;
    if (!/^[a-zA-Z0-9-]+$/.test(intent.id) || !['a', 'b'].includes(intent.destination) || !['a', 'b'].includes(intent.previous.active) || !same(Object.fromEntries(Object.entries(intent.previous.slots).map(([slot, value]) => [slot, value.root])), context.roots) || intent.candidate.workspace.cwd !== context.roots[intent.destination]) fail('unrecognized publication intent');
    return intent;
  }

  async writeIntent(intent: MainReleaseIntent): Promise<void> {
    const context = await this.context();
    if (await exists(context.intent)) fail('publication recovery required');
    const published: Partial<Record<MainSlot, Published>> = await fs.readFile(context.published, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return {}; throw error; });
    const previous = intent.previous.active;
    const old = intent.previous.slots[previous];
    published[previous] = { ...old, ...(published[previous]?.fingerprint === old.fingerprint ? published[previous] : {}) };
    published[intent.destination] = { ...intent.previous.slots[intent.destination], candidate: intent.candidate };
    await durable(context.published, published);
    await durable(context.intent, intent);
  }

  async probeRename() {
    const parent = dirname(this.logicalPath);
    const left = join(parent, '.raf-rename-' + randomUUID()), right = left + '-next';
    try {
      await fs.symlink('.', left); await fs.symlink('.', right);
      const sameDevice = (await fs.lstat(left)).dev === (await fs.lstat(this.logicalPath)).dev;
      await fs.rename(left, right);
      await syncDirectory(parent);
      return { supported: true, sameDevice };
    } catch (error: any) {
      if (error.code === 'EXDEV') return { supported: false, sameDevice: false };
      return { supported: false, sameDevice: true };
    } finally {
      await fs.rm(left, { force: true }); await fs.rm(right, { force: true });
    }
  }

  async createTemporarySymlink(target: string) {
    const temporary = this.logicalPath + '.' + randomUUID();
    await fs.symlink(relative(dirname(this.logicalPath), target), temporary);
    await syncDirectory(dirname(temporary));
    return temporary;
  }

  async renameSymlink(temporary: string, logical: string) {
    if (logical !== this.logicalPath || dirname(temporary) !== dirname(logical) || temporary === logical || !(await fs.lstat(logical)).isSymbolicLink() || !(await fs.lstat(temporary)).isSymbolicLink()) fail('unregistered symlink rename');
    await fs.rename(temporary, logical);
    await syncDirectory(dirname(logical));
  }

  async removeTemporarySymlink(temporary: string) {
    if (dirname(temporary) !== dirname(this.logicalPath) || !temporary.startsWith(this.logicalPath + '.')) fail('unowned publication temporary');
    await fs.rm(temporary, { force: true });
  }

  async reconcileGit(intent: MainReleaseIntent, active: MainSlot) {
    const context = await this.context();
    const persisted = await this.readIntent();
    if (!persisted || !same(persisted, intent) || context.active !== active) fail('publication intent or logical target changed');
    const expected = active === intent.destination ? intent.candidate : intent.previous.slots[active];
    const actual = await this.slot(context.roots[active]);
    if (actual.fingerprint !== expected.fingerprint) fail('recovery snapshot changed');
    const previous = context.roots[other(active)];
    await git(previous, 'update-ref', '--no-deref', 'HEAD', intent.previous.slots[other(active)].commit);
    await git(context.cwd, 'update-ref', 'refs/heads/main', expected.commit);
    await git(context.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    await git(context.cwd, 'read-tree', expected.commit);
    await this.reconcileIndex(context, expected.commit, intent.id);
  }

  private async reconcileIndex(context: Awaited<ReturnType<ProductionMainSymlinkStorage['context']>>, commit: string, intentId: string) {
    const root = this.host.orchestratorRoot;
    const index = await git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const lock = index + '.lock';
    const journalPath = join(context.control, 'main-index-owner.json');
    if (await exists(journalPath)) {
      const owner = await json(journalPath);
      if (owner.intentId !== intentId || owner.index !== index || dirname(owner.prepared) !== context.control || !owner.prepared.startsWith(join(context.control, 'main-index-')) || await alive(owner.pid, owner.start)) fail('index publication owner still active or unrecognized');
      if (await exists(lock)) {
        const actual = await fs.lstat(lock), prepared = await fs.lstat(owner.prepared);
        if (actual.dev !== prepared.dev || actual.ino !== prepared.ino) fail('foreign index lock retained');
        await fs.unlink(lock);
      }
      await fs.rm(owner.prepared, { force: true });
      await removeDurable(journalPath);
    }
    const temporary = join(context.control, 'main-index-' + randomUUID());
    const prepared = temporary + '.owner';
    await fs.copyFile(index, prepared);
    await durable(journalPath, { intentId, index, prepared, pid: process.pid, start: await processStart(process.pid) });
    let ownsLock = false;
    const working = join(root, '.gitmodules');
    const moduleBefore = await fs.readFile(working);
    let moduleTemporary = '';
    try {
      await fs.link(prepared, lock); ownsLock = true;
      await fs.copyFile(index, temporary);
      const staged = await indexGit(root, temporary, 'show', ':.gitmodules');
      const activePath = relative(root, context.roots[context.active]);
      const rewrite = async (bytes: string | Buffer, path: string) => {
        await fs.writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        const module = await this.module(context.roots, path);
        await git(root, 'config', '-f', path, `submodule.${module.name}.path`, activePath);
      };
      await rewrite(staged, temporary + '.staged');
      moduleTemporary = working + '.' + randomUUID();
      await rewrite(moduleBefore, moduleTemporary);
      await fs.writeFile(temporary + '.link', relative(dirname(this.logicalPath), context.roots[context.active]), { flag: 'wx' });
      const moduleHash = await git(root, 'hash-object', '-w', temporary + '.staged');
      const linkHash = await git(root, 'hash-object', '-w', temporary + '.link');
      for (const path of Object.values(context.roots)) await indexGit(root, temporary, 'update-index', '--force-remove', '--', relative(root, path));
      await indexGit(root, temporary, 'update-index', '--add', '--cacheinfo', `160000,${commit},${activePath}`);
      await indexGit(root, temporary, 'update-index', '--add', '--cacheinfo', `120000,${linkHash},raf-main`);
      await indexGit(root, temporary, 'update-index', '--cacheinfo', `100644,${moduleHash},.gitmodules`);
      if (!(await fs.readFile(working)).equals(moduleBefore)) fail('concurrent .gitmodules writer');
      const moduleHandle = await fs.open(moduleTemporary, 'r'); try { await moduleHandle.sync(); } finally { await moduleHandle.close(); }
      await fs.chmod(moduleTemporary, (await fs.stat(working)).mode & 0o777);
      await fs.rename(moduleTemporary, working);
      await syncDirectory(root);
      const indexHandle = await fs.open(temporary, 'r'); try { await indexHandle.sync(); } finally { await indexHandle.close(); }
      await fs.rename(temporary, index);
      await syncDirectory(dirname(index));
    } finally {
      if (ownsLock) {
        const actual = await fs.lstat(lock), owner = await fs.lstat(prepared);
        if (actual.dev !== owner.dev || actual.ino !== owner.ino) fail('index lock ownership changed');
        await fs.unlink(lock);
      }
      for (const path of [temporary, temporary + '.lock', temporary + '.staged', temporary + '.link', prepared, moduleTemporary].filter(Boolean)) await fs.rm(path, { force: true });
      await removeDurable(journalPath);
    }
  }

  async clearIntent(id: string) {
    const context = await this.context();
    if ((await this.readIntent())?.id !== id) fail('publication intent ID changed');
    await removeDurable(context.intent);
  }

  async resolvePublished(root: string, fingerprint: string) {
    const context = await this.context();
    const slot = Object.entries(context.roots).find(([, value]) => value === root)?.[0] as MainSlot | undefined;
    if (!slot || !await exists(context.published)) return false;
    const record: Published = (await json(context.published))[slot];
    return !!record && record.root === root && record.fingerprint === fingerprint && (await this.slot(root)).fingerprint === fingerprint;
  }

  async loadPublished(slot: MainSlot): Promise<VerifiedHotfix> {
    const context = await this.context();
    const record: Published = (await json(context.published))[slot];
    if (!record?.candidate || !await this.resolvePublished(record.root, record.fingerprint)) fail('retained slot has no unchanged verification evidence');
    return record.candidate;
  }
}

export function createProductionMainSymlinkStorage(host: HotfixHost): ProductionMainSymlinkStorage {
  return new ProductionMainSymlinkStorage(host);
}
