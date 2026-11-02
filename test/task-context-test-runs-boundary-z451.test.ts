import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Server } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { deriveTaskContext, bindWorkspaceBoundaries } from '../src/task-context.ts';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';
import type { RuntimeRunParameters } from '../src/app-runtime.ts';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'raf-z451-boundaries-'));
after(() => rm(fixtureRoot, { recursive: true, force: true }));

const executorTypes = ['test-scaffold', 'implement', 'qa', 'hotfix'];

async function context(root: string, type: string, project = 'raf', archive = false) {
  return deriveTaskContext({
    root,
    parameters: { id: 'z451', type, phase: type, project, features: ['complete-raf-flow-contracts'], tasks: ['complete-raf-flow-contracts:Z.451'], complexity: 'ordinary' } as RuntimeRunParameters,
    assignment: { root, changes: [{ id: 'complete-raf-flow-contracts', items: [{ id: 'Z.451', description: 'Allow executors to register their test files and groups' }] }], baselineArchives: [] },
    configuration: {
      projects: { profiles: { fixture: { development: 'develop' } }, projects: Object.fromEntries(['raf', 'demo'].map(name => [name, { path: `${name}-main`, profile: 'fixture', branchPaths: { main: `${name}-main`, develop: `${name}-develop`, hotfix: `${name}-hotfix` } }])) },
      reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }], resources: {},
    },
  }, { deriveSources: async () => [], archiveWriteBoundaries: async () => archive ? [join(root, 'openspec', 'changes') + '/'] : [] });
}

for (const type of executorTypes) for (const project of ['raf', 'demo']) {
  test(`Z451 ${project} ${type} can register tests in the Orchestrator config`, async () => {
    const root = fixtureRoot;
    for (const archive of [false, true]) {
      const derived = await context(root, type, project, archive);
      const boundaries = bindWorkspaceBoundaries(derived, join(root, `${project}-${derived.branch}`));
      assert.ok(boundaries.includes(join(root, 'conf', 'test-runs.json')), 'the exact root test config must be writable');
      assert.equal(boundaries.includes(join(root, 'conf')), false, 'do not grant the entire conf directory');
      assert.equal(boundaries.includes(root), false, 'do not grant the entire Orchestrator root');
      assert.ok(boundaries.includes(join(root, 'questions', 'projects', project)));
    }
  });
}

for (const type of ['spec', 'design']) {
  test(`Z451 ${type} retains its existing document scope`, async () => {
    const derived = await context(fixtureRoot, type);
    assert.equal(derived.workspaceWritable, false);
    assert.equal(derived.writeBoundaries.includes(join(fixtureRoot, 'conf/test-runs.json')), false);
  });
}

test('Z451 derived config permission reaches Codex as an exact file while secrets stay denied', async t => {
  t.mock.method(Server.prototype, 'listen', function (_port, _host, ready) { ready(); return this; });
  t.mock.method(Server.prototype, 'address', () => ({ port: 0 }));
  t.mock.method(Server.prototype, 'close', function (closed) { closed(); return this; });
  const root = await mkdtemp(join(tmpdir(), 'raf-z451-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, 'run');
  const cwd = join(root, 'raf-hotfix');
  const bin = join(root, 'bin');
  const home = join(root, 'account');
  const account = os.userInfo();
  const passwdHome = t.mock.method(os, 'userInfo', () => ({ ...account, homedir: home }));
  syncBuiltinESMExports();
  t.after(() => { passwdHome.mock.restore(); syncBuiltinESMExports(); });
  const derived = await context(root, 'hotfix');
  const questionsDirectory = join(root, 'questions', 'projects', 'raf');
  assert.ok((await stat(questionsDirectory)).isDirectory());
  await assert.rejects(stat(join(questionsDirectory, 'questions.md')), { code: 'ENOENT' });
  const boundaries = bindWorkspaceBoundaries(derived, cwd);
  await Promise.all([cwd, runDirectory, bin, join(home, '.raf'), join(root, 'conf')].map(path => mkdir(path, { recursive: true })));
  for (const boundary of boundaries) {
    if (boundary === cwd) continue;
    if (boundary.endsWith('.json') || boundary.endsWith('.md')) {
      await mkdir(dirname(boundary), { recursive: true });
      await writeFile(boundary, '{}');
    } else await mkdir(boundary, { recursive: true });
  }
  await writeFile(join(root, 'conf', 'test-runs.json'), '{}');
  await writeFile(join(home, '.raf', 'secrets.json'), '{}', { mode: 0o600 });
  await Promise.all(['codex', 'bwrap'].map(name => writeFile(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })));
  const prepared = await prepareCodexSandbox({
    runId: 'z451', cwd, runDirectory,
    invocation: { executable: join(bin, 'codex'), args: ['--sandbox', 'workspace-write'], liveTaskVerified: true },
    writableDirectories: boundaries,
    environment: { PATH: bin, HOME: home },
    scope: { hidden: [], readable: [], tmuxDirectory: runDirectory, excludedCommands: [] },
  });
  t.after(() => prepared.cleanup());
  const policy = JSON.parse(await readFile(join(prepared.policyPaths[0], 'policy.json'), 'utf8'));
  assert.ok(policy.writableFiles.includes(join(root, 'conf', 'test-runs.json')));
  assert.equal(policy.filesystem[questionsDirectory], 'write');
  assert.equal(policy.writableFiles.includes(join(questionsDirectory, 'questions.md')), false);
  assert.equal(policy.filesystem[join(root, 'conf')], undefined);
  assert.equal(policy.filesystem[join(home, '.raf', 'secrets.json')], 'none');
  const wrapper = await readFile(join(prepared.policyPaths[0], 'bwrap'), 'utf8');
  assert.ok(wrapper.includes(`--bind '${join(root, 'conf', 'test-runs.json')}' '${join(root, 'conf', 'test-runs.json')}'`));
  assert.equal(wrapper.includes(join(questionsDirectory, 'questions.md')), false);
  const filesystem = prepared.invocation.args.find(arg => arg.startsWith('permissions.linux.filesystem='));
  assert.ok(filesystem?.includes(`${JSON.stringify(questionsDirectory)}="write"`));
});
