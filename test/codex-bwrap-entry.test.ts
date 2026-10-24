import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexSandbox, type PreparedCodexSandbox } from '../src/codex-sandbox.ts';

for (const mode of ['bypassed-filter', 'unavailable-backend'] as const) {
  test(`[Z.404 U01 ${mode}] deterministic failed preflight refuses before worker and cleans only own policy`, async t => {
    const root = await mkdtemp('/tmp/z404-unit-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const runDirectory = join(root, 'run'), bin = join(root, 'bin'), cwd = join(root, 'work'), home = join(root, 'home');
    await Promise.all([runDirectory, bin, cwd, home].map(path => mkdir(path)));
    const sentinel = join(runDirectory, 'retained.json'), worker = join(cwd, 'worker-started');
    const observed = join(root, 'preflight.json');
    await writeFile(sentinel, '{"own":"retained"}');
    await writeFile(join(bin, 'codex'), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if(args.includes('sandbox')) {
 fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify({args,PATH:process.env.PATH})+'\\n');
 process.stderr.write(${JSON.stringify(mode === 'bypassed-filter' ? 'host loopback TCP reachable' : 'isolation backend unavailable: capability denied')});
 process.exit(${mode === 'bypassed-filter' ? 7 : 95});
}
fs.writeFileSync(${JSON.stringify(worker)},'unexpected worker'); process.exit(96);
`, { mode: 0o700 });
    await writeFile(join(bin, 'bwrap'), `#!${process.execPath}
if(process.argv.includes('--help')) { console.log('--unshare-user --unshare-pid --unshare-net --seccomp --add-seccomp-fd --ro-bind --ro-bind-data --bind --tmpfs --perms --chmod --dir --dev --proc --die-with-parent --new-session'); process.exit(0); }
if(process.argv.includes('--version')) { console.log('bubblewrap fixture'); process.exit(0); }
process.stderr.write('unit fixture must not execute OS isolation'); process.exit(95);
`, { mode: 0o700 });
    const input = {
      runId: `z404-${mode}`, cwd, runDirectory,
      invocation: { executable: join(bin, 'codex'), args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'], liveTaskVerified: false },
      writableDirectories: [cwd, runDirectory], scope: { hidden: [], readable: [], tmuxDirectory: runDirectory, excludedCommands: [] },
      environment: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HOME: home, CODEX_HOME: join(home, '.codex'), TMPDIR: home },
      timeoutMs: JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8')).unitTests.timeoutMs,
    };
    const original = structuredClone(input);
    let prepared: PreparedCodexSandbox | undefined;
    try {
      await assert.rejects(async () => {
        prepared = await prepareCodexSandbox(input);
        await writeFile(worker, 'brief would have been delivered');
      }, error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /isolation|sandbox|preflight/i);
        assert.match(error.message, mode === 'bypassed-filter' ? /host loopback TCP reachable/ : /backend unavailable|capability denied/);
        assert.doesNotMatch(error.message, /NotImplemented|MODULE_NOT_FOUND|not defined|ENOENT/);
        return true;
      });
    } finally { await prepared?.cleanup(); }
    assert.deepEqual(input, original, 'caller invocation and selectors remain unchanged');
    await assert.rejects(lstat(worker), { code: 'ENOENT' });
    const attempts = (await readFile(observed, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(attempts.length, 1, 'no retry with broader permissions');
    const observation = attempts[0];
    assert.ok(observation.args.includes('sandbox'), 'negative assertion must come from preflight, not setup');
    assert.doesNotMatch(observation.args.join(' '), /danger-full-access|dangerously-bypass|disable-sandbox/);
    assert.deepEqual(await readdir(runDirectory), ['retained.json']);
    assert.equal(await readFile(sentinel, 'utf8'), '{"own":"retained"}');
    const inherited = new Set(input.environment.PATH.split(delimiter));
    for (const path of observation.PATH.split(delimiter).filter((path: string) => /\/raf-tools-[^/]+\//.test(path) && !inherited.has(path))) {
      await assert.rejects(lstat(path), { code: 'ENOENT' }, 'failed preflight releases its observed compact tool path');
    }
  });
}
