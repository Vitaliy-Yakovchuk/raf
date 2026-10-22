import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCatalog } from '../src/catalog.ts';
import { openStateStore } from '../src/state-store.ts';

const readConfig = async (name: string) => JSON.parse(await readFile(new URL(`../../conf/${name}.json`, import.meta.url), 'utf8'));

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-bin-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const app = join(root, 'raf-develop');
  const conf = join(root, 'conf');
  await mkdir(home);
  await mkdir(conf);
  await mkdir(join(app, 'dist'), { recursive: true });
  await cp(new URL('../src', import.meta.url), join(app, 'src'), { recursive: true });
  await cp(new URL('../bin', import.meta.url), join(app, 'bin'), { recursive: true });
  await writeFile(join(app, 'package.json'), '{"type":"module"}');
  const settings = await readConfig('raf');
  const models = await readConfig('models');
  const constants = await readConfig('raf-constants');
  for (const [name, value] of [['raf', settings], ['models', models], ['flow', await readConfig('flow')]]) await writeFile(join(conf, `${name}.json`), JSON.stringify(value));
  const catalog = compileCatalog(constants, models, constants.commands.map(command => command.path.join(' ')));
  await writeFile(join(app, 'dist', 'catalog.json'), JSON.stringify(catalog));
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(app, 'bin', 'raf.ts'), ...args], { cwd: root, env: { HOME: home, PATH: '', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value);
    child.stderr.on('data', value => stderr += value);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { root, home, app, conf, settings, models, run };
}

test('QA real bin: lazy help and invalid args bypass config while wired ps rejects malformed root before DB', async t => {
  const f = await fixture(t);
  await rm(f.conf, { recursive: true });
  const help = await f.run(['help', 'runner', 'list']);
  assert.equal(help.code, 0, help.stderr);
  const flag = await f.run(['runner', 'list', '--help']);
  assert.equal(flag.stdout, help.stdout);
  for (const [args, expected] of [[['runner', 'list', '--invalid'], 'UNKNOWN_ARGUMENT'], [['agent', 'ps'], 'CONFIGURATION_INVALID']] as const) {
    const result = await f.run([...args]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).code, expected);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(f.home), []);
});

test('QA real bin: persisted runner switches and configured EMA survive separate CLI processes', async t => {
  const f = await fixture(t);
  f.settings.state.fileName = 'qa-custom.sqlite';
  f.settings.commandTiming.emaAlpha = 0.25;
  await writeFile(join(f.conf, 'raf.json'), JSON.stringify(f.settings));
  const first = await f.run(['runner', 'list']);
  assert.equal(first.code, 0, first.stderr);
  const path = join(f.home, '.raf', 'qa-custom.sqlite');
  const store = openStateStore(path);
  try {
    store.setRunnerEnabled(f.models.runners[0].id, false);
    store.recordCommandDuration('runner list', 1000000, 1);
  } finally { store.close(); }
  const second = await f.run(['runner', 'list']);
  assert.equal(second.code, 0, second.stderr);
  const rows = JSON.parse(second.stdout);
  const disabled = rows.filter(row => row.runner === f.models.runners[0].id);
  assert.ok(disabled.length > 0);
  assert.ok(disabled.every(row => row.enabled === false && row.available === false));
  const reader = openStateStore(path);
  try {
    assert.equal(reader.getRunnerEnabled(f.models.runners[0].id), false);
    const average = reader.getCommandTiming('runner list')!.averageMs;
    assert.ok(average >= 750000 && average < 760000, `EMA ${average} must use configured alpha`);
  } finally { reader.close(); }
  const stats = await f.run(['command', 'stats']);
  assert.equal(stats.code, 0, stats.stderr);
  assert.match(stats.stdout, /runner list/);
  assert.deepEqual((await readdir(join(f.home, '.raf'))).filter(name => !name.endsWith('-wal') && !name.endsWith('-shm')), ['qa-custom.sqlite']);
});

test('QA real bin: malformed configuration and blocked state path fail without fallback files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.conf, 'raf.json'), '{');
  const malformed = await f.run(['runner', 'list']);
  assert.equal(malformed.code, 1);
  assert.equal(JSON.parse(malformed.stderr).code, 'CONFIGURATION_INVALID');
  assert.deepEqual(await readdir(f.home), []);
  await writeFile(join(f.conf, 'raf.json'), JSON.stringify(f.settings));
  await writeFile(join(f.home, '.raf'), 'blocked fixture');
  const blocked = await f.run(['command', 'stats']);
  assert.equal(blocked.code, 1);
  assert.equal(JSON.parse(blocked.stderr).code, 'HANDLER_FAILED');
  assert.equal(await readFile(join(f.home, '.raf'), 'utf8'), 'blocked fixture');
  assert.deepEqual(await readdir(f.home), ['.raf']);
  assert.deepEqual((await readdir(f.root)).sort(), ['conf', 'home', 'raf-develop']);
});
