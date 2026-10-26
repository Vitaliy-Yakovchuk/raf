import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Server } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';


for (const workspaceWritable of [false, true]) {
  test(`[codex-directory-permissions] permission profile alone grants directories with ${workspaceWritable ? 'writable' : 'read-only'} workspace`, async t => {
    t.mock.method(Server.prototype, 'listen', function (_port, _host, ready) { ready(); return this; });
    t.mock.method(Server.prototype, 'address', () => ({ port: 0 }));
    t.mock.method(Server.prototype, 'close', function (closed) { closed(); return this; });
    const root = await mkdtemp(join(tmpdir(), 'raf-codex-directory-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, 'workspace');
    const runDirectory = join(root, 'run');
    const change = join(root, 'change');
    const bin = join(root, 'bin');
    const confRoot = join(root, 'conf');
    const questions = join(root, 'questions.md');
    await Promise.all([cwd, runDirectory, change, bin, confRoot].map(path => mkdir(path)));
    await copyFile(new URL('../../conf/raf-constants.json', import.meta.url), join(confRoot, 'raf-constants.json'));
    await writeFile(questions, '');
    await mkdir(join(change, '.codex'));
    const foreign = join(root, 'foreign');
    await mkdir(foreign);
    await Promise.all(['codex', 'bwrap'].map(name => writeFile(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })));
    const preserved = ['--model', 'selected-model', '-c', 'model_reasoning_effort="high"', '--ask-for-approval', 'never'];
    const tail = ['--', 'literal prompt with --add-dir=unchanged'];
    const prepared = await prepareCodexSandbox({
      runId: 'directory-arguments', cwd, runDirectory,
      invocation: { executable: join(bin, 'codex'), args: [
        ...preserved, '--sandbox', 'workspace-write', '--add-dir', change,
        `--add-dir=${runDirectory}`, '--add-dir', questions, ...tail,
      ], liveTaskVerified: true },
      writableDirectories: workspaceWritable ? [cwd] : [],
      environment: { PATH: bin },
      scope: { hidden: [], readable: [], tmuxDirectory: runDirectory, excludedCommands: [] },
    });
    t.after(() => prepared.cleanup());
    const args = prepared.invocation.args;
    const options = args.slice(0, args.indexOf('--'));
    assert.equal(options.some(arg => arg === '--add-dir' || arg.startsWith('--add-dir=')), false,
      'Codex 0.163.0 rejects directory flags alongside a read-only permission profile');
    assert.deepEqual(args.slice(0, preserved.length), preserved);
    assert.deepEqual(args.slice(-tail.length), tail);
    assert.equal(options.filter(arg => arg === 'default_permissions="linux"').length, 1);
    const policy = JSON.parse(await readFile(join(prepared.policyPaths[0], 'policy.json'), 'utf8'));
    const config = options.find(arg => arg.startsWith('permissions.linux.filesystem='));
    for (const [path, access] of [[cwd, workspaceWritable ? 'write' : 'read'], [change, 'write'], [runDirectory, 'write']] as const) {
      assert.equal(policy.filesystem[path], access);
      assert.ok(config?.includes(`${JSON.stringify(path)}=${JSON.stringify(access)}`));
    }
    assert.deepEqual(policy.writableFiles, [questions]);
    assert.equal(policy.filesystem[questions], undefined);
    assert.equal(policy.filesystem[root], undefined, 'the questions parent never becomes writable');
    assert.ok((await readFile(join(prepared.policyPaths[0], 'bwrap'), 'utf8')).includes(`--bind '${questions}' '${questions}'`));
    await mkdir(join(change, '.git'));
    await mkdir(join(change, '.aws'));
    await writeFile(join(change, '.aws', 'own.txt'), 'retained');
    await symlink(foreign, join(change, '.agents'));
    await prepared.cleanup();
    await assert.rejects(lstat(join(change, '.git')), { code: 'ENOENT' }, 'remove empty mountpoints created during this session');
    assert.ok((await lstat(join(change, '.codex'))).isDirectory(), 'preserve preexisting empty directories');
    assert.equal(await readFile(join(change, '.aws', 'own.txt'), 'utf8'), 'retained', 'preserve nonempty directories');
    assert.ok((await lstat(join(change, '.agents'))).isSymbolicLink(), 'preserve replacement symlinks');
    assert.ok((await lstat(foreign)).isDirectory());
    await mkdir(join(change, '.git'));
    await prepared.cleanup();
    assert.ok((await lstat(join(change, '.git'))).isDirectory(), 'repeat cleanup must preserve later directories');
  });
}
