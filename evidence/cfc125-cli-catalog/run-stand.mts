import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProductionQaFixture } from '../../test/production-qa-fixture.ts';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const evidence = fileURLToPath(new URL('./', import.meta.url));
const finish = process.argv.includes('--finish');
const prefix = finish ? 'finish-' : '';
const directory = mkdtempSync('/tmp/cfc125-');
const root = join(directory, 'orchestrator');
const home = join(directory, 'home');
const conf = join(root, 'conf');
const callbacks: Array<() => void> = [];
const records: unknown[] = [];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const save = (name: string, value: unknown) => writeFileSync(join(evidence, prefix + name), JSON.stringify(value, null, 2) + '\n');
const git = (...args: string[]) => {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const snapshot = () => ({ sha: git('rev-parse', 'HEAD').trim(), status: git('status', '--porcelain=v1', '--untracked-files=normal'), trackedDiffSha256: hash(git('diff', 'HEAD')), trackedFiles: git('diff', '--name-only', 'HEAD').trim().split('\n').filter(Boolean).map(path => ({ path, sha256: hash(readFileSync(join(workspace, path))) })) });
save('workspace-before.json', snapshot());
mkdirSync(conf, { recursive: true });
mkdirSync(home);
for (const name of ['raf-constants.json', 'models.json', 'projects.json', 'raf.json']) cpSync(resolve(workspace, '../conf', name), join(conf, name));
const constants = JSON.parse(readFileSync(join(conf, 'raf-constants.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(conf, 'projects.json'), 'utf8'));
const codeRoot = join(root, projects.projects.raf.branchPaths.develop);
let sequence = 0;
let passed = false;
const counts = { help: 0, allowed: 0, rejected: 0, runtime: 0, rebuild: 0 };
try {
  await prepareProductionQaFixture({ after: action => callbacks.push(action) }, { root, home });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const run = (argv: string[], options: { build?: boolean; noRuntime?: boolean } = {}) => {
    const command = options.build ? [process.execPath, 'scripts/build.ts'] : [process.execPath, 'bin/raf.ts', ...argv];
    const result = spawnSync(command[0], command.slice(1), { cwd: codeRoot, env: { ...env, ...(options.noRuntime ? { PATH: '/cfc125-no-executables' } : {}) }, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const id = prefix + String(++sequence).padStart(3, '0');
    writeFileSync(join(evidence, `${id}.stdout`), result.stdout ?? '');
    writeFileSync(join(evidence, `${id}.stderr`), result.stderr ?? '');
    records.push({ id, command, cwd: codeRoot, isolatedHome: home, noRuntime: options.noRuntime ?? false, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, stdoutSha256: hash(result.stdout ?? ''), stderrSha256: hash(result.stderr ?? '') });
    assert.ifError(result.error);
    return { ...result, json: () => JSON.parse(result.stdout), errorJson: () => JSON.parse(result.stderr) };
  };
  const build = () => assert.equal(run([], { build: true }).status, 0);
  const artifact = join(codeRoot, 'dist/catalog.json');
  if (finish) {
    mkdirSync(join(codeRoot, 'dist'), { recursive: true });
    cpSync(join(evidence, 'catalog-before.json'), artifact);
  } else {
  build();
  cpSync(artifact, join(evidence, 'catalog-before.json'));
  renameSync(conf, conf + '-hidden');
  for (const command of constants.commands) {
    const ordinary = run(['help', ...command.path], { noRuntime: true });
    const option = run([...command.path, '--help'], { noRuntime: true });
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(option.status, 0, option.stderr);
    assert.equal(ordinary.stdout, option.stdout);
    assert.deepEqual(ordinary.json().commands.map((entry: any) => entry.path), [command.path]);
    counts.help++;
  }
  for (const prefix of [[], ['agent'], ['runner'], ['service'], ['reminder'], ['bug'], ['bug', 'comment'], ['bug', 'status'], ['bug', 'attachment'], ['resource'], ['command'], ['test'], ['main']]) {
    const result = run(['help', ...prefix], { noRuntime: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json().commands.map((entry: any) => entry.path), constants.commands.filter((command: any) => prefix.every((part, index) => command.path[index] === part)).map((command: any) => command.path));
  }
  const compiled = JSON.parse(readFileSync(artifact, 'utf8'));
  for (const command of compiled.commands) {
    for (const parameter of command.parameters.filter((entry: any) => entry.values)) {
      for (const value of parameter.values) {
        const result = run([...command.path, parameter.option, value.id, '--cfc125-parser-guard'], { noRuntime: true });
        assert.notEqual(result.status, 0);
        const blocked = command.handlerName === 'agent run' && parameter.name === 'type' && value.launchableByRaf === false;
        assert.equal(result.errorJson().code, blocked ? 'TYPE_NOT_LAUNCHABLE' : 'UNKNOWN_ARGUMENT', result.stderr);
        if (!blocked) assert.equal(result.errorJson().details.parameter, '--cfc125-parser-guard');
        counts.allowed++;
      }
      const invalid = run([...command.path, parameter.option, 'cfc125-unknown-value'], { noRuntime: true });
      assert.notEqual(invalid.status, 0);
      assert.equal(invalid.errorJson().code, 'INVALID_VALUE', invalid.stderr);
      assert.deepEqual(invalid.errorJson().details.expected, parameter.values.map((entry: any) => entry.id));
      counts.rejected++;
    }
  }
  for (const argv of [['unknown-command'], ['help', 'unknown-command'], ['runner', 'unknown-command'], ['check', 'run'], ['release', 'run'], ['runner', 'list', '--runner', 'codex']]) {
    const result = run(argv, { noRuntime: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.errorJson().code, argv.includes('--runner') ? 'UNKNOWN_ARGUMENT' : 'UNKNOWN_COMMAND');
    counts.rejected++;
  }
  assert.deepEqual(readdirSync(home), []);
  renameSync(conf + '-hidden', conf);
  }
  const listed = run(['runner', 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.json().length > 0);
  counts.runtime++;
  const oldLevel = constants.resourceWaitLevels[0].id;
  const newLevel = 'CFC125_QA_ONLY';
  const replace = (value: any): any => typeof value === 'string' ? value.replaceAll(oldLevel, newLevel) : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)])) : value;
  writeFileSync(join(conf, 'raf-constants.json'), JSON.stringify(replace(constants), null, 2));
  const checkLevel = (level: string, expected: string) => {
    const result = run(['resource', 'wait', '--level', level, '--cfc125-parser-guard'], { noRuntime: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.errorJson().code, expected, result.stderr);
    counts.rebuild++;
  };
  const helpBefore = run(['help', 'resource', 'wait'], { noRuntime: true });
  assert.equal(helpBefore.status, 0);
  assert.ok(!helpBefore.stdout.includes(newLevel));
  checkLevel(oldLevel, 'UNKNOWN_ARGUMENT');
  checkLevel(newLevel, 'INVALID_VALUE');
  assert.equal(hash(readFileSync(artifact)), hash(readFileSync(join(evidence, 'catalog-before.json'))));
  build();
  const rebuiltBytes = readFileSync(artifact);
  cpSync(artifact, join(evidence, 'catalog-rebuilt.json'));
  const helpAfter = run(['help', 'resource', 'wait'], { noRuntime: true });
  assert.equal(helpAfter.status, 0);
  assert.ok(helpAfter.stdout.includes(newLevel));
  assert.ok(!helpAfter.json().commands[0].parameters.find((parameter: any) => parameter.name === 'level').values.some((value: any) => value.id === oldLevel));
  checkLevel(oldLevel, 'INVALID_VALUE');
  checkLevel(newLevel, 'UNKNOWN_ARGUMENT');
  const duplicate = replace(constants);
  duplicate.commands.push(structuredClone(duplicate.commands[0]));
  writeFileSync(join(conf, 'raf-constants.json'), JSON.stringify(duplicate));
  const failedBuild = run([], { build: true });
  assert.notEqual(failedBuild.status, 0);
  assert.equal(failedBuild.errorJson().code, 'BUILD_FAILED');
  assert.match(failedBuild.errorJson().message, /commands/);
  assert.deepEqual(readFileSync(artifact), rebuiltBytes);
  assert.equal(run(['help', 'resource', 'wait'], { noRuntime: true }).status, 0);
  assert.ok(!readdirSync(join(codeRoot, 'dist')).some(name => name.endsWith('.tmp')));
  counts.rebuild++;
  passed = true;
} finally {
  for (const callback of callbacks.reverse()) callback();
  rmSync(directory, { recursive: true, force: true });
  save('commands.json', records);
  save('workspace-after.json', snapshot());
  save('stand-result.json', { outcome: passed ? 'passed' : 'failed', runId: directory.split('/').at(-1), platform: process.platform, arch: process.arch, node: process.version, counts, childProcesses: 'synchronous children all exited before cleanup', cleanup: { complete: !existsSync(directory), directory }, fixtureOnlyCatalogMutation: 'CFC125_QA_ONLY replaces hotfix occurrences throughout the copied constants, including the resource level, phase and prose; working catalog unchanged', parserAcceptance: 'Each configured enum is accepted up to a trailing unknown-option guard; runner list also executes against real isolated SQLite', scope: 'CLI catalog/help/parser/build only; availability of each business operation is not claimed' });
}
