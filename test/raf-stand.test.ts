import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../scripts/raf-stand.sh', import.meta.url));
const identity = '[user]\n name = Stand Fixture\n email = stand@example.invalid\n';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'raf stand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'caller');
  const stand = join(root, 'stand');
  const bin = join(root, 'bin');
  const repository = join(root, 'repository');
  await Promise.all([home, stand, bin, repository].map(path => mkdir(path)));
  const program = join(root, 'child.mjs');
  await writeFile(program, `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const run = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
run('init', '-q');
const hash = () => createHash('sha256').update(readFileSync('.git/config')).digest('hex');
const before = hash();
writeFileSync('own.txt', 'stand commit\\n');
run('add', '--', 'own.txt');
run('commit', '-q', '-m', 'stand fixture', '--', 'own.txt');
process.stdout.write(JSON.stringify({ before, after: hash(), author: run('show', '-s', '--format=%an <%ae>|%cn <%ce>'), environment: { HOME: process.env.HOME, RAF_QA_HOME: process.env.RAF_QA_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, ALLOW_MIGRATIONS: process.env.ALLOW_MIGRATIONS }, args: process.argv.slice(3) }));
`);
  await writeFile(join(bin, 'node'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`, { mode: 0o755 });
  const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const log = join(root, 'git-calls');
  await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${quote(gitPath)} "$@"\n`, { mode: 0o755 });
  const environment = { PATH: `${bin}:${process.env.PATH}`, HOME: home, RAF_QA_HOME: stand, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8', TMUX: '/foreign/socket,1,0', TMUX_PANE: '%99', ALLOW_MIGRATIONS: '1' };
  const run = (extra: Record<string, string> = {}) => spawnSync('/bin/sh', [wrapper, 'fixture-argument', 'with spaces'], { cwd: repository, env: { ...environment, ...extra }, encoding: 'utf8' });
  return { root, home, stand, log, run };
}

for (const source of ['home', 'explicit', 'xdg', 'default-xdg']) {
  test(`stand commits with ${source} global identity without changing git configuration`, async t => {
    const f = await fixture(t);
    const extra: Record<string, string> = {};
    let config = join(f.home, '.gitconfig');
    if (source === 'explicit') {
      config = join(f.root, 'selected config');
      extra.GIT_CONFIG_GLOBAL = config;
      await writeFile(join(f.home, '.gitconfig'), '[user]\n name = Wrong identity\n');
    } else if (source === 'xdg' || source === 'default-xdg') {
      const xdg = source === 'xdg' ? join(f.root, 'xdg config') : join(f.home, '.config');
      if (source === 'xdg') extra.XDG_CONFIG_HOME = xdg;
      config = join(xdg, 'git', 'config');
      await mkdir(join(xdg, 'git'), { recursive: true });
    }
    await writeFile(config, identity);
    const result = f.run(extra);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.author, 'Stand Fixture <stand@example.invalid>|Stand Fixture <stand@example.invalid>');
    assert.equal(output.before, output.after, 'repository config SHA-256 stays unchanged');
    t.diagnostic(`repository config SHA-256 before=${output.before} after=${output.after}`);
    assert.deepEqual(output.environment, { HOME: f.stand, RAF_QA_HOME: f.stand, GIT_CONFIG_GLOBAL: config });
    assert.deepEqual(output.args, ['fixture-argument', 'with spaces']);
    assert.equal(await readFile(config, 'utf8'), identity);
    await assert.rejects(readFile(join(f.stand, '.gitconfig')), { code: 'ENOENT' });
    assert.doesNotMatch(await readFile(f.log, 'utf8'), /^config(?: |$)/m, 'no git config commands');
  });
}

for (const source of ['missing', 'explicit-missing', 'relative', 'directory']) {
  test(`stand refuses ${source} global configuration before starting raf`, async t => {
    const f = await fixture(t);
    const extra = source === 'missing' ? {} : { GIT_CONFIG_GLOBAL: source === 'relative' ? 'relative.gitconfig' : source === 'explicit-missing' ? join(f.root, 'absent') : f.home };
    if (source === 'explicit-missing') await writeFile(join(f.home, '.gitconfig'), identity);
    const result = f.run(extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GIT_CONFIG_GLOBAL/);
    assert.equal(result.stdout, '');
    await assert.rejects(readFile(f.log), { code: 'ENOENT' });
  });
}

const standLifecycle = await import('../scripts/etchly-stand-lifecycle.mjs');

for (const fail of [false, true]) {
  test(`Etchly stand restores fixture inventory and files after ${fail ? 'failure' : 'success'}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'etchly-stand-lifecycle-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = join(root, 'test-runs.json');
    const fixtures = join(root, 'qa544-fixtures');
    const original = '{ "projects": {} }\n';
    await writeFile(config, original);
    for (let pass = 0; pass < 2; pass++) {
      const operation = standLifecycle.withFixtureWorkspace(config, fixtures, async () => {
        await mkdir(fixtures);
        await writeFile(join(fixtures, 'fixture.test.ts'), 'controlled fixture');
        await writeFile(config, '{"projects":{"etchly":{"groups":{"qa544":{}}}}}');
        if (fail) throw new Error('controlled fixture failure');
        return 'complete';
      });
      if (fail) await assert.rejects(operation, /controlled fixture failure/);
      else assert.equal(await operation, 'complete');
      assert.equal(await readFile(config, 'utf8'), original, 'byte-exact inventory restoration');
      await assert.rejects(readFile(join(fixtures, 'fixture.test.ts')), { code: 'ENOENT' });
    }
  });
}

test('Etchly stand resolves raf next to its own conf for code-relative reporters', () => {
  assert.equal(standLifecycle.standCodeRoot('/tmp/etchly-isolated-stand'), '/tmp/etchly-isolated-stand/raf-develop');
});
