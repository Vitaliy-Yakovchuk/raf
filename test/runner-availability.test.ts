import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import { probeRunnerAvailability, resolveRunnerExecutable } from '../src/runner-availability.ts';

const confUrl = new URL('../../conf/', import.meta.url);
const readConf = async (name: string) => JSON.parse(await readFile(new URL(name, confUrl), 'utf8'));
const fixtureVersion = 'raf-fixture-1.2.3';
const fixtureSettings = { runner: 'codex' as const, executable: 'codex', version: fixtureVersion };

async function sandbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-runner-availability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = async (name: string) => { const path = join(root, name); await mkdir(path, { recursive: true }); return path; };
  const file = async (directory: string, name: string, mode: number, content = '#!/bin/sh\nexit 0\n') => { const path = join(directory, name); await writeFile(path, content); await chmod(path, mode); return path; };
  return { root, dir, file };
}

function recordingExecutor(result: (command: AdapterCommand) => { exitCode: number; stdout: string; stderr: string }) {
  const calls: AdapterCommand[] = [];
  const execute: AdapterCommandExecutor = async command => { calls.push(structuredClone(command)); return result(command); };
  return { calls, execute };
}

function withProcessPath(t: TestContext, path: string) {
  const previous = process.env.PATH;
  process.env.PATH = path;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
}

test('[runner-availability] 12. назва знаходиться в підміненому PATH: перший виконуваний збіг', async t => {
  const s = await sandbox(t);
  const empty = await s.dir('empty');
  const plain = await s.dir('plain');
  await s.file(plain, 'codex', 0o644);
  const asDirectory = await s.dir('as-directory');
  await mkdir(join(asDirectory, 'codex'));
  const first = await s.dir('first');
  const expected = await s.file(first, 'codex', 0o755);
  const second = await s.dir('second');
  await s.file(second, 'codex', 0o755);
  const resolved = await resolveRunnerExecutable('codex', 'codex', { PATH: [empty, plain, asDirectory, first, second].join(':') });
  assert.deepEqual(resolved, { status: 'resolved', path: expected });
  const reversed = await resolveRunnerExecutable('codex', 'codex', { PATH: [second, first].join(':') });
  assert.deepEqual(reversed, { status: 'resolved', path: join(second, 'codex') });
});

test('[runner-availability] 12. симлінк на виконуваний файл приймається за шляхом у PATH', async t => {
  const s = await sandbox(t);
  const target = await s.file(await s.dir('install'), 'codex-real', 0o755);
  const linked = await s.dir('linked');
  await symlink(target, join(linked, 'codex'));
  assert.deepEqual(await resolveRunnerExecutable('codex', 'codex', { PATH: linked }), { status: 'resolved', path: join(linked, 'codex') });
});

test('[runner-availability] 12. порожній і відносні елементи PATH пропускаються, cwd не підміняє runner', async t => {
  const s = await sandbox(t);
  const cwd = await s.dir('cwd');
  await s.file(cwd, 'codex', 0o755);
  await s.file(await s.dir('cwd/rel'), 'codex', 0o755);
  const previous = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(previous));
  const resolved = await resolveRunnerExecutable('codex', 'codex', { PATH: ['', '.', 'rel', './rel'].join(':') });
  assert.equal(resolved.status, 'missing');
  const real = await s.dir('real');
  const expected = await s.file(real, 'codex', 0o755);
  assert.deepEqual(await resolveRunnerExecutable('codex', 'codex', { PATH: ['', '.', 'rel', real].join(':') }), { status: 'resolved', path: expected });
});

test('[runner-availability] 13. відсутній у PATH runner недоступний з причиною без виклику --version', async t => {
  const s = await sandbox(t);
  const empty = await s.dir('empty');
  for (const env of [{ PATH: empty }, { PATH: '' }, {}]) {
    const resolved = await resolveRunnerExecutable('codex', 'codex', env);
    assert.equal(resolved.status, 'missing');
    assert.ok(resolved.status === 'missing' && /codex/.test(resolved.reason) && /PATH/.test(resolved.reason), JSON.stringify(resolved));
    const recorder = recordingExecutor(() => ({ exitCode: 0, stdout: `codex-cli ${fixtureVersion}\n`, stderr: '' }));
    const availability = await probeRunnerAvailability(fixtureSettings, { env, execute: recorder.execute });
    assert.equal(availability.available, false);
    assert.ok(!availability.available && /codex/.test(availability.reason) && /PATH/.test(availability.reason), JSON.stringify(availability));
    assert.deepEqual(recorder.calls, []);
  }
});

test('[runner-availability] 14. знайдений runner з точною версією доступний за абсолютним шляхом', async t => {
  const s = await sandbox(t);
  const bin = await s.dir('bin');
  const expected = await s.file(bin, 'codex', 0o755);
  const recorder = recordingExecutor(() => ({ exitCode: 0, stdout: `codex-cli ${fixtureVersion}\n`, stderr: '' }));
  const availability = await probeRunnerAvailability(fixtureSettings, { env: { PATH: bin }, execute: recorder.execute });
  assert.deepEqual(availability, { runner: 'codex', available: true, path: expected, version: fixtureVersion });
  assert.deepEqual(recorder.calls.map(call => ({ executable: call.executable, args: [...call.args] })), [{ executable: expected, args: ['--version'] }]);
});

for (const [name, result] of [
  ['інша версія', { exitCode: 0, stdout: 'codex-cli raf-fixture-9.9.9\n', stderr: '' }],
  ['версія лише як префікс', { exitCode: 0, stdout: `codex-cli ${fixtureVersion}-beta\n`, stderr: '' }],
  ['ненульовий код', { exitCode: 2, stdout: `codex-cli ${fixtureVersion}\n`, stderr: 'broken install' }],
] as const) {
  test(`[runner-availability] 14. ${name} дає недоступність з причиною версії`, async t => {
    const s = await sandbox(t);
    const bin = await s.dir('bin');
    await s.file(bin, 'codex', 0o755);
    const recorder = recordingExecutor(() => ({ ...result }));
    const availability = await probeRunnerAvailability(fixtureSettings, { env: { PATH: bin }, execute: recorder.execute });
    assert.equal(availability.available, false);
    assert.ok(!availability.available && availability.reason.includes(fixtureVersion) && /codex/.test(availability.reason), JSON.stringify(availability));
    assert.equal(recorder.calls.length, 1);
  });
}

test('[runner-availability] 14. явний абсолютний шлях не шукається в PATH, відносний шлях зі слешем відхиляється', async t => {
  const s = await sandbox(t);
  const explicit = await s.file(await s.dir('explicit'), 'codex', 0o755);
  const recorder = recordingExecutor(() => ({ exitCode: 0, stdout: `codex-cli ${fixtureVersion}\n`, stderr: '' }));
  const absolute = await probeRunnerAvailability({ ...fixtureSettings, executable: explicit }, { env: { PATH: '' }, execute: recorder.execute });
  assert.deepEqual(absolute, { runner: 'codex', available: true, path: explicit, version: fixtureVersion });
  const relative = await probeRunnerAvailability({ ...fixtureSettings, executable: 'explicit/codex' }, { env: { PATH: s.root }, execute: recorder.execute });
  assert.equal(relative.available, false);
  assert.equal(recorder.calls.length, 1);
});

test('[runner-availability] 15. спільний conf/raf.json задає runner назвою без машинозалежного шляху', async () => {
  const settings = await readConf('raf.json');
  assert.ok(settings.runnerProtocols.length > 0);
  for (const protocol of settings.runnerProtocols) assert.match(protocol.executable, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, protocol.runner);
  assert.equal(settings.runnerProtocols.find((protocol: { runner: string }) => protocol.runner === 'codex')?.executable, 'codex');
});

async function productionFixture(t: TestContext) {
  const [constants, models, settings] = await Promise.all([readConf('raf-constants.json'), readConf('models.json'), readConf('raf.json')]);
  const s = await sandbox(t);
  const root = await s.dir('orchestrator');
  const conf = await s.dir('orchestrator/conf');
  const home = await s.dir('home');
  await Promise.all([['raf.json', settings], ['models.json', models], ['raf-constants.json', constants]].map(([name, data]) => writeFile(join(conf, name as string), JSON.stringify(data))));
  const artifactPath = join(s.root, 'catalog.json');
  await writeFile(artifactPath, JSON.stringify(compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), await readConf('projects.json'))));
  await writeFile(join(conf, 'projects.json'), JSON.stringify(await readConf('projects.json')));
  const runProductionCli = await prepareProductionQaFixture(t, { root, home });
  let clock = 0;
  const list = async () => {
    const result = await runProductionCli(['runner', 'list'], { orchestratorRoot: root, homeDirectory: home, artifactPath, now: () => { clock += 10; return clock; } });
    assert.equal(result.exitCode, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as { runner: string; model: string; enabled: boolean; available: boolean; reasons: string[] }[];
    return rows.filter(row => row.runner === 'codex');
  };
  const codex = settings.runnerProtocols.find((protocol: { runner: string }) => protocol.runner === 'codex');
  return { s, list, codex };
}

test('[runner-availability] 15. runner list знаходить codex за назвою через підмінений PATH', async t => {
  const f = await productionFixture(t);
  const bin = await f.s.dir('bin');
  await f.s.file(bin, f.codex.executable, 0o755, `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${f.codex.version}'\n`);
  withProcessPath(t, bin);
  const rows = await f.list();
  assert.ok(rows.some(row => row.enabled));
  for (const row of rows.filter(row => row.enabled)) {
    assert.equal(row.available, true, JSON.stringify(row));
    assert.equal(row.reasons.some(reason => /PATH|CLI unavailable/.test(reason)), false, JSON.stringify(row));
  }
});

test('[runner-availability] 15. runner list без codex у PATH показує недоступність з причиною PATH', async t => {
  const f = await productionFixture(t);
  withProcessPath(t, await f.s.dir('empty-bin'));
  const rows = await f.list();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.available, false, JSON.stringify(row));
    assert.ok(row.reasons.some(reason => /codex/.test(reason) && /PATH/.test(reason)), JSON.stringify(row.reasons));
  }
});
