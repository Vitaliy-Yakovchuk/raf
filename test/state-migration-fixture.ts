import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { StateContextRequest } from '../src/state-migration-guard.ts';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const orchestratorRoot = resolve(sourceRoot, '..');
const schema7ClientCommit = '084ff760f7690670d30dd4d5aa9cce23da1ba7ac';
const fixtureConnections = new Map<string, Set<DatabaseSync>>();

export interface MigrationFixture {
  root: string;
  mainTree: string;
  developTree: string;
  schema7Tree: string;
  workingHome: string;
  qaHome: string;
  statePath: string;
  qaStatePath: string;
  preloadPath: string;
  env: Record<string, string>;
  request(overrides?: Partial<StateContextRequest>): StateContextRequest;
}

export function fixture(t: TestContext): MigrationFixture {
  const root = mkdtempSync(join(tmpdir(), 'raf-state-migration-'));
  fixtureConnections.set(root, new Set());
  t.after(() => {
    try {
      for (const db of fixtureConnections.get(root)!) db.close();
    } finally {
      fixtureConnections.delete(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  const mainTree = join(root, 'raf-main');
  const developTree = join(root, 'raf-develop');
  const schema7Tree = join(root, 'schema-7-client');
  const workingHome = join(root, 'working-home');
  const qaHome = join(root, 'qa-home');
  mkdirSync(workingHome);
  mkdirSync(qaHome);
  cpSync(join(orchestratorRoot, 'conf'), join(root, 'conf'), { recursive: true });
  const projectsPath = join(root, 'conf', 'projects.json');
  const projects = JSON.parse(readFileSync(projectsPath, 'utf8'));
  projects.projects.raf.path = 'raf-main';
  projects.projects.raf.branchPaths = { main: 'raf-main', develop: 'raf-develop' };
  writeFileSync(projectsPath, JSON.stringify(projects));
  for (const [source, target] of [[join(orchestratorRoot, 'raf-main'), mainTree], [sourceRoot, developTree]]) {
    mkdirSync(target);
    for (const relative of ['src', 'bin', 'scripts', 'dist', 'package.json']) {
      cpSync(join(source, relative), join(target, relative), { recursive: true });
    }
  }
  const preloadPath = join(root, 'fixture-account.mjs');
  writeFileSync(preloadPath, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const original = os.userInfo;
os.userInfo = (...args) => ({ ...original(...args), homedir: ${JSON.stringify(workingHome)} });
syncBuiltinESMExports();
`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: workingHome,
    TMPDIR: join(root, 'tmp'),
    LANG: 'C.UTF-8',
    NODE_OPTIONS: `--import=${preloadPath}`,
  };
  mkdirSync(env.TMPDIR);
  mkdirSync(schema7Tree);
  const archivePath = join(root, 'schema-7-client.tar');
  const archived = spawnSync('git', ['-C', sourceRoot, 'archive', '--format=tar', '--output', archivePath, schema7ClientCommit, 'src', 'package.json'], { env, encoding: 'utf8' });
  assert.equal(archived.error, undefined);
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync('tar', ['-xf', archivePath, '-C', schema7Tree], { env, encoding: 'utf8' });
  assert.equal(extracted.error, undefined);
  assert.equal(extracted.status, 0, extracted.stderr);
  rmSync(archivePath);
  for (const [tree, branch] of [[root, 'main'], [mainTree, 'main'], [developTree, 'develop']]) {
    const initialized = spawnSync('git', ['init', '--quiet', '--initial-branch', branch, tree], { env, encoding: 'utf8' });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.status, 0, initialized.stderr);
  }
  const config = JSON.parse(readFileSync(join(root, 'conf', 'raf.json'), 'utf8'));
  const statePath = join(workingHome, '.raf', config.state.fileName);
  const qaStatePath = join(qaHome, '.raf', config.state.fileName);
  return {
    root, mainTree, developTree, schema7Tree, workingHome, qaHome, statePath, qaStatePath, preloadPath, env,
    request(overrides = {}) {
      return {
        orchestratorRoot: root,
        modulePath: join(developTree, 'bin', 'raf.ts'),
        homeDirectory: qaHome,
        operatingSystemHome: workingHome,
        environment: { HOME: qaHome, RAF_QA_HOME: qaHome },
        entryPoint: 'cli',
        ...overrides,
      };
    },
  };
}

export function command(f: MigrationFixture, argv: readonly string[], options: { tree?: string; cwd?: string; env?: Record<string, string | undefined>; executable?: string } = {}) {
  return spawnSync(process.execPath, [options.executable ?? join(options.tree ?? f.developTree, 'bin', 'raf.ts'), ...argv], {
    cwd: options.cwd ?? f.developTree,
    env: { ...f.env, ...options.env },
    encoding: 'utf8',
  });
}

export function seedMain7(f: MigrationFixture, path = f.statePath): void {
  assert.ok(path.startsWith(f.root + '/'));
  mkdirSync(dirname(path), { recursive: true });
  const program = `import { openStateStore } from ${JSON.stringify(new URL('src/state-store.ts', 'file://' + f.schema7Tree + '/').href)};
const store = openStateStore(process.argv[1]); store.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, path], { env: f.env, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const db = new DatabaseSync(path);
  assert.equal(Number(db.prepare('PRAGMA user_version').get()!.user_version), 7, `fixture must come from the pinned schema-7 client ${schema7ClientCommit}`);
  db.exec("CREATE TABLE migration_sentinel(id TEXT PRIMARY KEY, payload TEXT NOT NULL); INSERT INTO migration_sentinel VALUES ('main', 'preserve-fixture-payload'); PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

export function seedVersion(f: MigrationFixture, version: number, path = f.statePath): void {
  seedMain7(f, path);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

export async function copyMain7(f: MigrationFixture): Promise<void> {
  mkdirSync(dirname(f.qaStatePath), { recursive: true });
  const db = new DatabaseSync(f.statePath);
  try {
    await backup(db, f.qaStatePath);
  } finally {
    db.close();
  }
  assert.equal(logical(f.qaStatePath).version, 7);
}

export function files(path: string): Record<string, Buffer | null> {
  return Object.fromEntries(['', '-wal', '-shm'].map(suffix => [suffix || 'db', existsSync(path + suffix) ? readFileSync(path + suffix) : null]));
}

export function logical(path: string) {
  assert.ok([...fixtureConnections.keys()].some(root => path.startsWith(root + '/')), 'inspect only a temporary fixture');
  const db = new DatabaseSync(path);
  try {
    return {
      version: Number(db.prepare('PRAGMA user_version').get()!.user_version),
      schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      rows: db.prepare('SELECT * FROM migration_sentinel ORDER BY id').all(),
      integrity: db.prepare('PRAGMA integrity_check').get()!.integrity_check,
    };
  } finally {
    db.close();
  }
}

export function compatibleMainCanOpen(f: MigrationFixture): void {
  const program = `import { openStateStore } from ${JSON.stringify(new URL('src/state-store.ts', 'file://' + f.schema7Tree + '/').href)};
const store = openStateStore(process.argv[1]); store.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.statePath], { env: f.env, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(logical(f.statePath).version, 7);
}

export function quietWal(_t: TestContext, path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const owner = [...fixtureConnections.keys()].find(root => path.startsWith(root + '/'));
  assert.ok(owner, 'WAL keeper must belong to a temporary fixture');
  fixtureConnections.get(owner)!.add(db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO migration_sentinel VALUES ('wal', 'committed-wal-payload')");
  assert.ok(statSync(path + '-wal').size > 0);
  assert.ok(statSync(path + '-shm').size > 0);
  return db;
}

export function directoryFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true }).map(String).sort();
}

export async function nodeProcess(f: MigrationFixture, program: string | { file: string }, args: string[] = [], env: Record<string, string | undefined> = {}) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const argv = typeof program === 'string' ? ['--input-type=module', '-e', program, ...args] : [program.file, ...args];
    const child = spawn(process.execPath, argv, { cwd: f.root, env: { ...f.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, stdout, stderr }));
  });
}
