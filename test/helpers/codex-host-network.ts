import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { prepareCodexSandbox } from '../../src/codex-sandbox.ts';

export async function networkSandbox(t: TestContext, executable: string) {
  const root = await mkdtemp(join(tmpdir(), 'raf-host-net-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  const runDirectory = join(root, 'run');
  await Promise.all([cwd, runDirectory].map(path => mkdir(path)));
  const prepared = await prepareCodexSandbox({
    runId: randomUUID(), cwd, runDirectory,
    invocation: { executable, args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'], liveTaskVerified: false },
    writableDirectories: [cwd, runDirectory],
    scope: { hidden: [], readable: [runDirectory], tmuxDirectory: runDirectory, excludedCommands: [] },
    environment: { ...process.env },
  });
  t.after(() => prepared.cleanup());
  return { root, cwd, prepared };
}
