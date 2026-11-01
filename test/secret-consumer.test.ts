import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { SecretsStoreError, type SecretsSelection } from '../src/secrets-store.ts';
import {
  runSecretConsumer,
  type SecretConsumerChild,
  type SecretConsumerFileTarget,
  type SecretConsumerOutcome,
  type SecretConsumerOutput,
  type SecretConsumerRefusalCode,
  type SecretConsumerRequest,
  type SecretConsumerSpawn,
  type SecretConsumerSpawnRequest,
} from '../src/secret-consumer.ts';

const envMarker = 'SYNTHETIC_ONLY_RCE225_ENV';
const fileMarker = 'SYNTHETIC_ONLY_RCE225_FILE';
const otherMarker = 'SYNTHETIC_ONLY_RCE225_OTHER';
const otherFileMarker = 'SYNTHETIC_ONLY_RCE225_OTHER_FILE';
const parentKey = 'RAF_SECRET_CONSUMER_PARENT_TOKEN';
const parentMarker = 'SYNTHETIC_ONLY_RCE225_PARENT';
const fileBytes = Buffer.from(fileMarker);
const otherFileBytes = Buffer.from(otherFileMarker);
const fileBase64 = fileBytes.toString('base64');
const otherFileBase64 = otherFileBytes.toString('base64');
const markers = [envMarker, fileMarker, otherMarker, otherFileMarker, parentMarker, fileBase64, otherFileBase64];
const refusalMessage: Record<SecretConsumerRefusalCode, string> = {
  missing: 'A requested secret is missing.',
  empty: 'A requested secret is empty.',
  expired: 'A requested secret has expired.',
  invalid: 'The secret consumer request is invalid.',
  'env-collision': 'Secret environment targets collide.',
  'unsafe-file-binding': 'The file binding is unsafe.',
  'missing-output-adapter': 'A safe output adapter is required.',
};
const previousParent = process.env[parentKey];
process.env[parentKey] = parentMarker;
test.after(() => {
  if (previousParent === undefined) delete process.env[parentKey];
  else process.env[parentKey] = previousParent;
});

interface Layout {
  root: string;
  privateDirectory: string;
  cwd: string;
  checkout: string;
  outside: string;
  sibling: string;
}

interface Seen {
  spawns: SecretConsumerSpawnRequest[];
  names: string[][];
  removed: string[];
  published: { text: string; stream: 'stdout' | 'stderr' }[];
  kills: { pid: number; signal: NodeJS.Signals }[];
}

interface LaunchOptions {
  names?: readonly string[];
  fileTargets?: readonly SecretConsumerFileTarget[];
  selection?: SecretsSelection;
  baseEnv?: Readonly<Record<string, string>>;
  argv?: readonly string[];
  executable?: string;
  signal?: AbortSignal;
  output?: SecretConsumerOutput | null;
  spawn?: SecretConsumerSpawn;
  removeOwned?: (directory: string) => Promise<void>;
  select?: (names: readonly string[]) => Promise<SecretsSelection>;
}

function layout(t: TestContext): Layout {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'raf-secret-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateDirectory = join(root, 'private');
  const cwd = join(root, 'cwd');
  const checkout = join(root, 'checkout');
  const outside = join(root, 'outside');
  for (const directory of [privateDirectory, cwd, checkout, outside]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const sibling = join(root, 'sibling.txt');
  writeFileSync(sibling, 'sibling', { mode: 0o600 });
  writeFileSync(join(cwd, 'project.txt'), 'project', { mode: 0o600 });
  return { root, privateDirectory, cwd, checkout, outside, sibling };
}

function selectionFor(env: Record<string, string>, files: { name: string; bytes: Buffer; bindings?: SecretsSelection['files'][number]['bindings'] }[]): SecretsSelection {
  return {
    env,
    files: files.map(file => ({
      name: file.name,
      contentBase64: file.bytes.toString('base64'),
      ...(file.bindings === undefined ? {} : { bindings: file.bindings }),
    })),
  };
}

function defaultSelection(): SecretsSelection {
  return selectionFor({ ALPHA: envMarker }, [{
    name: 'FILE_A',
    bytes: fileBytes,
    bindings: [{ projectPath: 'projects/raf', relativePath: '.local/token.bin', dotenvKey: 'ORIGINAL_TOKEN_PATH' }],
  }]);
}

function childOf(pid: number, seen: Seen): SecretConsumerChild & { finish(value: { exitCode: number | null; signal: NodeJS.Signals | null }): void } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let settled = false;
  let finish: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => { finish = resolve; });
  const child = {
    pid,
    stdout,
    stderr,
    exited,
    finish(value: { exitCode: number | null; signal: NodeJS.Signals | null }) {
      if (settled) return;
      settled = true;
      if (!stdout.readableEnded) stdout.end();
      if (!stderr.readableEnded) stderr.end();
      finish(value);
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      seen.kills.push({ pid, signal });
      child.finish({ exitCode: null, signal });
    },
  };
  return child;
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('secret consumer hung')), 10000);
    operation.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function inside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function discloses(value: unknown): boolean {
  const text = JSON.stringify(value);
  return markers.some(marker => text.includes(marker));
}

function forbiddenField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, inner]) => ['value', 'contentBase64', 'length', 'valueLength', 'payload', 'stdout', 'stderr', 'env', 'file'].includes(key) || forbiddenField(inner));
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

function assertSafe(value: unknown): void {
  assert.equal(discloses(value), false);
  assert.equal(forbiddenField(value), false);
}

async function launch(t: TestContext, options: LaunchOptions = {}) {
  const place = layout(t);
  const seen: Seen = { spawns: [], names: [], removed: [], published: [], kills: [] };
  const selection = options.selection ?? defaultSelection();
  const snapshot = structuredClone(selection);
  const baseEnv = Object.freeze({ ...(options.baseEnv ?? { LANG: 'C' }) });
  const argv = Object.freeze([...(options.argv ?? ['--mode', 'check'])]);
  const signal = options.signal ?? new AbortController().signal;
  const output = options.output === undefined ? {
    mode: 'redact' as const,
    publish: (text: string, stream: 'stdout' | 'stderr') => { seen.published.push({ text, stream }); },
  } : options.output;
  const request: SecretConsumerRequest = {
    executable: options.executable ?? '/usr/bin/node',
    argv,
    cwd: place.cwd,
    baseEnv,
    names: options.names ?? ['ALPHA', 'FILE_A'],
    fileTargets: options.fileTargets ?? [{ name: 'FILE_A', envName: 'FILE_A_PATH' }],
    signal,
  };
  const dependencies = {
    select: options.select ?? (async (names: readonly string[]) => {
      seen.names.push([...names]);
      return structuredClone(selection);
    }),
    spawn: options.spawn ?? ((spawnRequest: SecretConsumerSpawnRequest) => {
      seen.spawns.push(spawnRequest);
      const secretPath = spawnRequest.env.FILE_A_PATH;
      if (typeof secretPath === 'string') {
        const file = lstatSync(secretPath);
        assert.equal(file.isFile(), true);
        assert.equal(file.isSymbolicLink(), false);
        assert.equal(file.mode & 0o777, 0o600);
        assert.equal(lstatSync(join(secretPath, '..')).mode & 0o777, 0o700);
        assert.equal(inside(place.privateDirectory, secretPath), true);
        assert.equal(readFileSync(secretPath).equals(fileBytes), true);
      }
      const child = childOf(100 + seen.spawns.length, seen);
      queueMicrotask(() => child.finish({ exitCode: 0, signal: null }));
      return child;
    }),
    privateDirectory: place.privateDirectory,
    output,
    removeOwned: options.removeOwned ?? (async (directory: string) => {
      seen.removed.push(directory);
      assert.equal(inside(place.privateDirectory, directory), true);
      rmSync(directory, { recursive: true, force: true });
    }),
  };
  const outcome = await bounded(runSecretConsumer(request, dependencies));
  assert.deepEqual(selection, snapshot);
  assert.deepEqual(baseEnv, options.baseEnv ?? { LANG: 'C' });
  assert.equal(process.env[parentKey], parentMarker);
  assert.equal(readFileSync(place.sibling, 'utf8'), 'sibling');
  assert.equal(readFileSync(join(place.cwd, 'project.txt'), 'utf8'), 'project');
  assertSafe(outcome);
  return { place, seen, outcome, request, baseEnv, argv };
}

function assertNotSpawned(seen: Seen): void {
  assert.equal(seen.spawns.length, 0);
  assert.equal(seen.kills.length, 0);
}

function assertRefused(outcome: SecretConsumerOutcome, code: SecretConsumerRefusalCode): void {
  if (outcome.status !== 'refused' || outcome.code !== code) assert.fail('expected refusal');
  assert.equal(outcome.message, refusalMessage[code]);
  assertSafe(outcome);
}

test('two isolated children receive only their own env and file secrets', async t => {
  const firstPlace = layout(t);
  const secondPlace = layout(t);
  const firstSeen: Seen = { spawns: [], names: [], removed: [], published: [], kills: [] };
  const secondSeen: Seen = { spawns: [], names: [], removed: [], published: [], kills: [] };
  const firstSelection = defaultSelection();
  const secondSelection = selectionFor({ BETA: otherMarker }, [{ name: 'FILE_B', bytes: otherFileBytes }]);
  const firstSnapshot = structuredClone(firstSelection);
  const secondSnapshot = structuredClone(secondSelection);
  const firstBase = Object.freeze({ LANG: 'C' });
  const secondBase = Object.freeze({ LANG: 'C', COLOR: 'no' });
  const firstArgv = Object.freeze(['--mode', 'check']);
  const secondArgv = Object.freeze(['--mode', 'other']);
  const firstSignal = new AbortController().signal;
  const secondSignal = new AbortController().signal;
  const observe = (seen: Seen, directory: string, expected: Buffer, pathEnv: string) => (spawnRequest: SecretConsumerSpawnRequest) => {
    seen.spawns.push(spawnRequest);
    const secretPath = spawnRequest.env[pathEnv];
    assert.equal(typeof secretPath, 'string');
    assert.equal(inside(directory, secretPath!), true);
    const file = lstatSync(secretPath!);
    assert.equal(file.isSymbolicLink(), false);
    assert.equal(file.isFile(), true);
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(lstatSync(join(secretPath!, '..')).mode & 0o777, 0o700);
    assert.equal(readFileSync(secretPath!).equals(expected), true);
    const child = childOf(seen === firstSeen ? 11 : 22, seen);
    queueMicrotask(() => child.finish({ exitCode: seen === firstSeen ? 0 : 4, signal: null }));
    return child;
  };
  const run = (
    place: Layout,
    seen: Seen,
    selection: SecretsSelection,
    names: string[],
    fileTargets: SecretConsumerFileTarget[],
    baseEnv: Readonly<Record<string, string>>,
    argv: readonly string[],
    signal: AbortSignal,
    executable: string,
    pathEnv: string,
    expected: Buffer,
  ) => bounded(runSecretConsumer({
    executable,
    argv,
    cwd: place.cwd,
    baseEnv,
    names,
    fileTargets,
    signal,
  }, {
    select: async selected => { seen.names.push([...selected]); return structuredClone(selection); },
    spawn: observe(seen, place.privateDirectory, expected, pathEnv),
    privateDirectory: place.privateDirectory,
    output: { mode: 'discard' },
    removeOwned: async directory => {
      seen.removed.push(directory);
      assert.equal(inside(place.privateDirectory, directory), true);
      assert.notEqual(directory, place.sibling);
      rmSync(directory, { recursive: true, force: true });
    },
  }));
  const [first, second] = await Promise.all([
    run(firstPlace, firstSeen, firstSelection, ['ALPHA', 'FILE_A'], [{ name: 'FILE_A', envName: 'FILE_A_PATH' }], firstBase, firstArgv, firstSignal, '/usr/bin/node', 'FILE_A_PATH', fileBytes),
    run(secondPlace, secondSeen, secondSelection, ['BETA', 'FILE_B'], [{ name: 'FILE_B', envName: 'FILE_B_PATH' }], secondBase, secondArgv, secondSignal, '/usr/bin/raf-child', 'FILE_B_PATH', otherFileBytes),
  ]);
  assert.deepEqual(first, { status: 'exited', exitCode: 0, signal: null });
  assert.deepEqual(second, { status: 'exited', exitCode: 4, signal: null });
  assert.deepEqual(firstSelection, firstSnapshot);
  assert.deepEqual(secondSelection, secondSnapshot);
  assert.deepEqual(firstBase, { LANG: 'C' });
  assert.deepEqual(secondBase, { LANG: 'C', COLOR: 'no' });
  assert.equal(firstSeen.spawns.length, 1);
  assert.equal(secondSeen.spawns.length, 1);
  const firstEnv = firstSeen.spawns[0].env;
  const secondEnv = secondSeen.spawns[0].env;
  assert.deepEqual(Object.keys(firstEnv).sort(), ['ALPHA', 'FILE_A_PATH', 'LANG']);
  assert.deepEqual(Object.keys(secondEnv).sort(), ['BETA', 'COLOR', 'FILE_B_PATH', 'LANG']);
  assert.equal(firstEnv.ALPHA === envMarker, true);
  assert.equal(secondEnv.BETA === otherMarker, true);
  assert.equal(firstEnv.LANG, 'C');
  assert.equal(secondEnv.COLOR, 'no');
  assert.equal(Object.hasOwn(firstEnv, 'BETA'), false);
  assert.equal(Object.hasOwn(firstEnv, 'FILE_B_PATH'), false);
  assert.equal(Object.hasOwn(firstEnv, parentKey), false);
  assert.equal(Object.hasOwn(firstEnv, 'PATH'), false);
  assert.equal(Object.hasOwn(firstEnv, 'ORIGINAL_TOKEN_PATH'), false);
  assert.equal(Object.hasOwn(secondEnv, 'ALPHA'), false);
  assert.equal(Object.hasOwn(secondEnv, 'FILE_A_PATH'), false);
  assert.equal(Object.hasOwn(secondEnv, parentKey), false);
  assert.equal(Object.values(firstEnv).some(value => value.includes(fileMarker) || value.includes(otherMarker) || value.includes(parentMarker)), false);
  assert.equal(Object.values(secondEnv).some(value => value.includes(envMarker) || value.includes(fileMarker) || value.includes(parentMarker)), false);
  assert.equal(firstSeen.spawns[0].shell, false);
  assert.equal(secondSeen.spawns[0].shell, false);
  assert.equal(firstSeen.spawns[0].stdout, 'pipe');
  assert.equal(firstSeen.spawns[0].stderr, 'pipe');
  assert.equal(firstSeen.spawns[0].executable, '/usr/bin/node');
  assert.equal(secondSeen.spawns[0].executable, '/usr/bin/raf-child');
  assert.deepEqual(firstSeen.spawns[0].argv, ['--mode', 'check']);
  assert.deepEqual(secondSeen.spawns[0].argv, ['--mode', 'other']);
  assert.equal(firstSeen.spawns[0].cwd, firstPlace.cwd);
  assert.equal(secondSeen.spawns[0].cwd, secondPlace.cwd);
  assert.equal(firstSeen.spawns[0].signal, firstSignal);
  assert.equal(secondSeen.spawns[0].signal, secondSignal);
  assert.equal(inside(firstPlace.privateDirectory, firstEnv.FILE_A_PATH), true);
  assert.equal(inside(secondPlace.privateDirectory, secondEnv.FILE_B_PATH), true);
  assert.equal(existsSync(firstEnv.FILE_A_PATH), false);
  assert.equal(existsSync(secondEnv.FILE_B_PATH), false);
  assert.equal(filesUnder(firstPlace.checkout).length, 0);
  assert.equal(filesUnder(secondPlace.checkout).length, 0);
  assert.equal(filesUnder(firstPlace.cwd).some(path => path.endsWith('token.bin')), false);
  assert.equal(readFileSync(firstPlace.sibling, 'utf8'), 'sibling');
  assert.equal(process.env[parentKey], parentMarker);
  assert.equal(discloses(firstSeen.spawns[0].argv), false);
  assert.equal(discloses(secondSeen.spawns[0].argv), false);
  assertSafe(first);
  assertSafe(second);
  assert.deepEqual(firstSeen.names[0], ['ALPHA', 'FILE_A']);
  assert.deepEqual(secondSeen.names[0], ['BETA', 'FILE_B']);
});

test('no requested secret still excludes the parent environment', async t => {
  const recorded: SecretConsumerSpawnRequest[] = [];
  const { outcome } = await launch(t, {
    names: [],
    fileTargets: [],
    selection: selectionFor({}, []),
    spawn: request => {
      recorded.push(request);
      const child = childOf(31, { spawns: [], names: [], removed: [], published: [], kills: [] });
      queueMicrotask(() => child.finish({ exitCode: 0, signal: null }));
      return child;
    },
  });
  assert.equal(outcome.status, 'exited');
  if (outcome.status !== 'exited') return;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.signal, null);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].env, { LANG: 'C' });
  assert.equal(recorded[0].shell, false);
  assert.equal(Object.hasOwn(recorded[0].env, parentKey), false);
  assert.equal(Object.hasOwn(recorded[0].env, 'PATH'), false);
});

test('missing secret refuses before spawn', async t => {
  const { seen, outcome } = await launch(t, {
    select: async () => { throw new SecretsStoreError('missing-secret', 'A requested secret is missing.', 'Provide all requested records before selecting them.'); },
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'missing');
});

test('expired secret refuses before spawn', async t => {
  const { seen, outcome } = await launch(t, {
    select: async () => { throw new SecretsStoreError('expired-secret', 'A requested secret has expired.', 'Replace expired credentials before selecting them.'); },
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'expired');
});

test('invalid secret refuses before spawn', async t => {
  const { seen, outcome } = await launch(t, {
    select: async () => { throw new SecretsStoreError('invalid-record', 'Invalid secret record.', 'Check record fields, metadata, and encoding.'); },
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'invalid');
});

test('empty env secret refuses before spawn', async t => {
  const { seen, outcome, place } = await launch(t, { selection: selectionFor({ ALPHA: '' }, []) , fileTargets: [], names: ['ALPHA'] });
  assertNotSpawned(seen);
  assertRefused(outcome, 'empty');
  assert.equal(filesUnder(place.privateDirectory).some(path => readFileSync(path).includes(envMarker)), false);
});

test('empty file secret refuses before spawn', async t => {
  const { seen, outcome } = await launch(t, {
    names: ['FILE_A'],
    selection: selectionFor({}, [{ name: 'FILE_A', bytes: Buffer.alloc(0) }]),
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'empty');
});

test('relative cwd refuses before spawn', async t => {
  const place = layout(t);
  const seen: Seen = { spawns: [], names: [], removed: [], published: [], kills: [] };
  const outcome = await bounded(runSecretConsumer({
    executable: '/usr/bin/node',
    argv: ['--mode', 'check'],
    cwd: 'relative',
    baseEnv: { LANG: 'C' },
    names: ['ALPHA'],
    fileTargets: [],
    signal: new AbortController().signal,
  }, {
    select: async () => selectionFor({ ALPHA: envMarker }, []),
    spawn: request => { seen.spawns.push(request); return childOf(41, seen); },
    privateDirectory: place.privateDirectory,
    output: { mode: 'discard' },
    removeOwned: async directory => { seen.removed.push(directory); },
  }));
  assertNotSpawned(seen);
  assertRefused(outcome, 'invalid');
});

test('env target collision refuses before spawn', async t => {
  const { seen, outcome, place } = await launch(t, {
    names: ['ALPHA'],
    fileTargets: [],
    selection: selectionFor({ ALPHA: envMarker }, []),
    baseEnv: { ALPHA: 'explicit-non-secret', LANG: 'C' },
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'env-collision');
  assert.equal(existsSync(join(place.outside, 'secret.bin')), false);
});

test('file env name collision refuses before spawn', async t => {
  const { seen, outcome } = await launch(t, {
    fileTargets: [{ name: 'FILE_A', envName: 'ALPHA' }],
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'env-collision');
});

test('duplicate file paths refuse before spawn', async t => {
  const place = layout(t);
  const shared = join(place.privateDirectory, 'shared.bin');
  const { seen, outcome } = await launch(t, {
    names: ['FILE_A', 'FILE_B'],
    fileTargets: [
      { name: 'FILE_A', envName: 'FILE_A_PATH', path: shared },
      { name: 'FILE_B', envName: 'FILE_B_PATH', path: shared },
    ],
    selection: selectionFor({}, [
      { name: 'FILE_A', bytes: fileBytes },
      { name: 'FILE_B', bytes: otherFileBytes },
    ]),
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'unsafe-file-binding');
  assert.equal(existsSync(shared), false);
});

test('file path outside the private directory refuses before spawn', async t => {
  const place = layout(t);
  const outside = join(place.outside, 'direct.bin');
  const { seen, outcome } = await launch(t, {
    fileTargets: [{ name: 'FILE_A', envName: 'FILE_A_PATH', path: outside }],
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'unsafe-file-binding');
  assert.equal(existsSync(outside), false);
  assert.equal(filesUnder(place.checkout).length, 0);
});

test('parent traversal file path refuses before spawn', async t => {
  const place = layout(t);
  const escaped = join(place.root, 'escaped.bin');
  const { seen, outcome } = await launch(t, {
    fileTargets: [{ name: 'FILE_A', envName: 'FILE_A_PATH', path: join(place.privateDirectory, '..', 'escaped.bin') }],
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'unsafe-file-binding');
  assert.equal(existsSync(escaped), false);
});

test('symlink file path refuses before spawn', async t => {
  const place = layout(t);
  const outside = join(place.outside, 'secret.bin');
  writeFileSync(outside, 'existing', { mode: 0o600 });
  symlinkSync(outside, join(place.privateDirectory, 'link'));
  const { seen, outcome } = await launch(t, {
    fileTargets: [{ name: 'FILE_A', envName: 'FILE_A_PATH', path: join(place.privateDirectory, 'link') }],
  });
  assertNotSpawned(seen);
  assertRefused(outcome, 'unsafe-file-binding');
  assert.equal(readFileSync(outside, 'utf8'), 'existing');
});

test('store binding metadata does not copy the secret into the checkout', async t => {
  const { place, seen, outcome } = await launch(t, {});
  assert.equal(outcome.status, 'exited');
  assert.equal(filesUnder(place.checkout).length, 0);
  assert.equal(filesUnder(join(place.root, 'projects')).length, 0);
  assert.equal(seen.spawns.length, 1);
  assert.equal(typeof seen.spawns[0].env.FILE_A_PATH, 'string');
  assert.equal(Object.hasOwn(seen.spawns[0].env, 'ORIGINAL_TOKEN_PATH'), false);
  assert.equal(existsSync(seen.spawns[0].env.FILE_A_PATH), false);
});

test('missing output adapter refuses before spawn', async t => {
  const { seen, outcome } = await launch(t, { output: null });
  assertNotSpawned(seen);
  assertRefused(outcome, 'missing-output-adapter');
});

test('raw output adapter refuses before spawn', async t => {
  const published: string[] = [];
  const { seen, outcome } = await launch(t, {
    output: { mode: 'raw', publish: (text: string) => published.push(text) } as SecretConsumerOutput,
  });
  assertNotSpawned(seen);
  assert.equal(published.length, 0);
  assertRefused(outcome, 'missing-output-adapter');
});

test('spawn exception is cleaned up without secret diagnostics', async t => {
  let calls = 0;
  const { seen, outcome, place } = await launch(t, {
    spawn: () => {
      calls += 1;
      throw new Error(envMarker);
    },
  });
  assert.equal(calls, 1);
  assert.equal(seen.removed.length > 0, true);
  if (outcome.status !== 'spawn-failed') assert.fail('expected spawn-failed');
  assert.equal(outcome.code, 'spawn-exception');
  assert.equal(outcome.message, 'The child process failed to start.');
  assertSafe(outcome);
  assert.equal(filesUnder(place.privateDirectory).some(path => readFileSync(path).equals(fileBytes)), false);
});

test('nonzero exit and signal are preserved after cleanup', async t => {
  const nonzero = await launch(t, {
    spawn: request => {
      const child = childOf(51, { spawns: [], names: [], removed: [], published: [], kills: [] });
      assert.equal(request.shell, false);
      queueMicrotask(() => child.finish({ exitCode: 9, signal: null }));
      return child;
    },
  });
  assert.deepEqual(nonzero.outcome, { status: 'exited', exitCode: 9, signal: null });
  const signalled = await launch(t, {
    spawn: () => {
      const child = childOf(52, { spawns: [], names: [], removed: [], published: [], kills: [] });
      queueMicrotask(() => child.finish({ exitCode: null, signal: 'SIGTERM' }));
      return child;
    },
  });
  assert.deepEqual(signalled.outcome, { status: 'exited', exitCode: null, signal: 'SIGTERM' });
  assert.equal(existsSync(nonzero.place.sibling), true);
  assert.equal(existsSync(signalled.place.sibling), true);
});

test('cleanup failure keeps the primary outcome and is not success', async t => {
  const { outcome } = await launch(t, {
    removeOwned: async () => { throw new Error(fileMarker); },
    spawn: () => {
      const child = childOf(61, { spawns: [], names: [], removed: [], published: [], kills: [] });
      queueMicrotask(() => child.finish({ exitCode: 0, signal: null }));
      return child;
    },
  });
  if (outcome.status !== 'cleanup-failed') assert.fail('expected cleanup-failed');
  assert.equal(outcome.code, 'cleanup-error');
  assert.equal(outcome.message, 'Cleaning up private secret files failed.');
  assert.deepEqual(outcome.primary, { status: 'exited', exitCode: 0, signal: null });
  assert.notEqual(outcome.status, 'exited');
  assertSafe(outcome);
});

test('abort before spawn does not start the child', async t => {
  const controller = new AbortController();
  controller.abort();
  const { seen, outcome } = await launch(t, { signal: controller.signal });
  assertNotSpawned(seen);
  if (outcome.status !== 'cancelled') assert.fail('expected cancelled');
  assert.equal(outcome.code, 'aborted');
  assert.equal(outcome.message, 'The secret consumer was cancelled.');
  assert.equal(seen.removed.length > 0, true);
  assertSafe(outcome);
});

test('abort during preparation does not start the child', async t => {
  const controller = new AbortController();
  const { seen, outcome } = await launch(t, {
    signal: controller.signal,
    select: async () => {
      controller.abort();
      return defaultSelection();
    },
  });
  assertNotSpawned(seen);
  if (outcome.status !== 'cancelled') assert.fail('expected cancelled');
  assert.equal(outcome.message, 'The secret consumer was cancelled.');
  assert.equal(seen.removed.length > 0, true);
});

test('abort after spawn stops only the owned child', async t => {
  const ownController = new AbortController();
  const foreignSeen: Seen = { spawns: [], names: [], removed: [], published: [], kills: [] };
  const ownSeen: Seen = { spawns: [], names: [], removed: [], published: [], kills: [] };
  const ownPlace = layout(t);
  const foreignPlace = layout(t);
  const own = bounded(runSecretConsumer({
    executable: '/usr/bin/node', argv: ['--mode', 'check'], cwd: ownPlace.cwd, baseEnv: { LANG: 'C' },
    names: ['ALPHA', 'FILE_A'], fileTargets: [{ name: 'FILE_A', envName: 'FILE_A_PATH' }], signal: ownController.signal,
  }, {
    select: async () => defaultSelection(),
    spawn: () => {
      ownController.abort();
      return childOf(71, ownSeen);
    },
    privateDirectory: ownPlace.privateDirectory,
    output: { mode: 'discard' },
    removeOwned: async directory => { ownSeen.removed.push(directory); rmSync(directory, { recursive: true, force: true }); },
  }));
  const foreign = bounded(runSecretConsumer({
    executable: '/usr/bin/node', argv: ['--mode', 'other'], cwd: foreignPlace.cwd, baseEnv: { LANG: 'C' },
    names: ['BETA'], fileTargets: [], signal: new AbortController().signal,
  }, {
    select: async () => selectionFor({ BETA: otherMarker }, []),
    spawn: () => {
      const child = childOf(72, foreignSeen);
      queueMicrotask(() => child.finish({ exitCode: 0, signal: null }));
      return child;
    },
    privateDirectory: foreignPlace.privateDirectory,
    output: { mode: 'discard' },
    removeOwned: async directory => { foreignSeen.removed.push(directory); rmSync(directory, { recursive: true, force: true }); },
  }));
  const [ownOutcome, foreignOutcome] = await Promise.all([own, foreign]);
  if (ownOutcome.status !== 'cancelled') assert.fail('expected owned cancellation');
  assert.deepEqual(foreignOutcome, { status: 'exited', exitCode: 0, signal: null });
  assert.deepEqual(ownSeen.kills, [{ pid: 71, signal: 'SIGTERM' }]);
  assert.deepEqual(foreignSeen.kills, []);
  assertSafe(ownOutcome);
  assertSafe(foreignOutcome);
});

test('stdout secret split across chunks is absent from the outcome and published output', async t => {
  const published: string[] = [];
  const { outcome } = await launch(t, {
    output: { mode: 'redact', publish: (text, stream) => { published.push(`${stream}:${text}`); } },
    spawn: request => {
      const child = childOf(81, { spawns: [], names: [], removed: [], published: [], kills: [] });
      assert.equal(request.env.ALPHA === envMarker, true);
      const secretPath = request.env.FILE_A_PATH;
      assert.equal(readFileSync(secretPath).equals(fileBytes), true);
      for (const marker of [envMarker, fileMarker, fileBase64]) {
        for (const char of marker) child.stdout.write(Buffer.from(char));
      }
      queueMicrotask(() => child.finish({ exitCode: 0, signal: null }));
      return child;
    },
  });
  assert.equal(outcome.status, 'exited');
  const visible = published.join('');
  for (const marker of [envMarker, fileMarker, fileBase64, otherMarker, parentMarker]) assert.equal(visible.includes(marker), false);
  const midpoint = Math.ceil(envMarker.length / 2);
  assert.equal(visible.includes(envMarker.slice(0, midpoint)), false);
  assert.equal(visible.includes(fileMarker.slice(0, midpoint)), false);
  assertSafe(outcome);
});
