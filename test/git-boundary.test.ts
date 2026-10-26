import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fixture, timeoutMs } from './hotfix-fixture.ts';

const gitModule = new URL('../src/git.ts', import.meta.url);

test('[git-boundary] git inside a raf command is a programming error and does not count', async () => {
  const { GitInCommandError, gitAllowed, gitCallCount, gitOutput, runGitFreeCommand } = await import(gitModule.href);
  const before = gitCallCount();
  await runGitFreeCommand('agent ps', async () => {
    assert.equal(gitAllowed(), false);
    await assert.rejects(gitOutput(['status']), (error: Error & { code?: string }) => error instanceof GitInCommandError && error.code === 'GIT_IN_COMMAND' && /agent ps/.test(error.message));
  });
  assert.equal(gitAllowed(), true);
  assert.equal(gitCallCount(), before);
});

test('[git-boundary] executeCommand refuses git inside a raf command', async () => {
  const { runGitFreeCommand } = await import(gitModule.href);
  const { executeCommand } = await import(new URL('../src/os-runtime.ts', import.meta.url).href);
  await runGitFreeCommand('task report', async () => {
    await assert.rejects(executeCommand({ executable: '/usr/bin/git', args: ['status'], cwd: process.cwd(), environment: {} }), { code: 'GIT_IN_COMMAND' });
  });
});

test('[git-boundary] service and worker git calls are counted and warn above the configured threshold without refusing', async () => {
  const script = `
const { admitGit, gitCallCount } = await import(${JSON.stringify(gitModule.href)});
const warnings = [];
process.on('warning', warning => { if (warning.code === 'RAF_GIT_CALLS') warnings.push(warning.message); });
for (let index = 0; index < 8; index += 1) admitGit(['status']);
await new Promise(resolve => setImmediate(resolve));
process.stdout.write(JSON.stringify({ calls: gitCallCount(), warnings: warnings.length }));`;
  const root = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  execFileSync('mkdir', ['-p', join(root, 'conf')]);
  writeFileSync(join(root, 'conf', 'raf.json'), JSON.stringify({ git: { warnCallsPerProcess: 3 } }));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, RAF_ORCHESTRATOR_ROOT: root }, stdio: ['ignore', 'pipe', 'ignore'] });
  execFileSync('rm', ['-rf', root]);
  assert.deepEqual(JSON.parse(output), { calls: 8, warnings: 2 });
});

test('[git-boundary] simple raf commands run without git', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const log = join(f.root, 'git-calls.log');
  const wrapper = join(f.root, 'git-wrapper');
  const real = execFileSync('which', ['git'], { encoding: 'utf8', env: f.environment }).trim();
  execFileSync('mkdir', ['-p', wrapper]);
  writeFileSync(join(wrapper, 'git'), `#!/bin/sh\nprintf '%s :: %s\\n' "$(ps -o args= -p $PPID)" "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(wrapper, 'git'), 0o755);
  const counts: Record<string, number> = {};
  for (const args of [['help'], ['agent', 'ps']]) {
    writeFileSync(log, '');
    const result = f.cli(f.main, args, false, { PATH: wrapper + ':' + f.environment.PATH });
    counts[args.join(' ')] = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => line.split(' :: ')[0].includes('bin/raf.ts')).length : 0;
    t.diagnostic(`raf ${args.join(' ')} exit ${result.code} cli git calls ${counts[args.join(' ')]} all processes ${readFileSync(log, 'utf8').split('\n').filter(Boolean).length}`);
  }
  assert.deepEqual(counts, { help: 0, 'agent ps': 0 });
});
