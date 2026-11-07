import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';

const layouts = [
  { name: 'plugins directory linked from the codex home', link: (home: string) => join(home, '.codex', 'plugins'), environment: (_home: string) => ({}) },
  { name: 'CODEX_HOME linked to another volume', link: (home: string) => join(home, 'codex-home'), environment: (home: string) => ({ CODEX_HOME: join(home, 'codex-home') }) },
];

for (const layout of layouts) {
  test(`[codex-plugins-mask] hides the actual plugins directory: ${layout.name}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'raf-codex-plugins-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const volume = join(root, 'volume', '.codex');
    const cwd = join(root, 'workspace');
    const runDirectory = join(root, 'run');
    const bin = join(root, 'bin');
    const plugins = join(volume, 'plugins');
    const skill = join(plugins, 'cache', 'curated', 'cloud-environment', 'skills', 'runtime');
    await Promise.all([join(home, '.codex'), cwd, runDirectory, bin, skill].map(path => mkdir(path, { recursive: true })));
    await writeFile(join(skill, 'SKILL.md'), 'external plugin');
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const linked = layout.link(home);
    await symlink(linked.endsWith('plugins') ? plugins : volume, linked);
    const prepared = await prepareCodexSandbox({
      runId: 'plugins-mask', cwd, runDirectory,
      invocation: { executable: join(bin, 'codex'), args: ['--sandbox', 'workspace-write'], liveTaskVerified: true },
      writableDirectories: [cwd],
      environment: { PATH: bin, HOME: home, ...layout.environment(home) },
      scope: { hidden: [], readable: [], tmuxDirectory: runDirectory, excludedCommands: [] },
    });
    t.after(() => prepared.cleanup());
    const policy = JSON.parse(await readFile(join(prepared.policyPaths[0], 'policy.json'), 'utf8'));
    assert.equal(policy.filesystem[plugins], 'none', 'the plugins directory Codex actually reads must be masked');
    assert.ok(policy.backend.hidden.includes(plugins));
    const config = prepared.invocation.args.find(arg => arg.startsWith('permissions.linux.filesystem='));
    assert.ok(config?.includes(`${JSON.stringify(plugins)}="none"`));
  });
}
