import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStateStore } from '../src/state-store.ts';
import type { TestRunResult } from '../src/test-runs.ts';

const code = fileURLToPath(new URL('..', import.meta.url));
const confSource = resolve(code, '../conf');
const group = 'add-raf-test-run/unit-path';
const branch = 'qa-unit-path';
const probe = 'environment.test.ts';
const sentinel = 'unselected.test.ts';
const preserved = {
  LANG: 'C.UTF-8',
  TZ: 'Etc/UTC',
  SYSTEMROOT: '/unit-path/system-root',
  LC_CTYPE: 'C.UTF-8',
  LC_MESSAGES: 'C',
};

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function fixture() {
  const stand = mkdtempSync('/tmp/raf-unit-path-');
  let temporary: string | undefined;
  try {
    const root = join(stand, 'orchestrator');
    const workspace = join(stand, 'workspace');
    const home = join(stand, 'control-home');
    temporary = mkdtempSync('/tmp/p-');
    const observation = join(workspace, 'child-environment.json');
    for (const path of [join(root, 'conf'), join(root, 'openspec/changes/add-raf-test-run'), workspace, home, temporary]) {
      mkdirSync(path, { recursive: true });
    }
    for (const name of ['projects.json', 'raf.json', 'raf-constants.json', 'flow.json', 'test-runs.json']) {
      cpSync(join(confSource, name), join(root, 'conf', name));
    }
    const projects = readJson(join(root, 'conf/projects.json'));
    const raf = projects.projects.raf;
    const productionBranch = projects.profiles[raf.profile].production;
    const productionCode = resolve(confSource, '..', raf.path);
    projects.projects = {
      raf: { ...raf, path: productionCode, branchPaths: { [productionBranch]: productionCode, develop: code, [branch]: workspace } },
    };
    writeJson(join(root, 'conf/projects.json'), projects);
    execFileSync('git', ['init', '-q', '-b', branch, workspace]);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--allow-empty', '-qm', 'Unit PATH fixture']);

    const config = readJson(join(root, 'conf/test-runs.json'));
    config.projects = {
      raf: {
        profiles: {
          node: {
            cwd: '.', executable: process.execPath, argv: [join(code, 'scripts/test-run-node.ts')],
            unitFiles: [probe, sentinel], exactIds: 'node-test-name', resultAdapter: 'node-test-events',
            environment: { isolatedHome: true, stateOrigin: true }, checks: [],
            resourceEstimate: { ramBytes: 2147483648, diskBytesPerFileSystem: 10737418240 },
          },
        },
        groups: { [group]: { profileId: 'node', files: [probe] } },
      },
    };
    config.temporaryArtifacts.root = temporary;
    writeJson(join(root, 'conf/test-runs.json'), config);
    writeFileSync(join(workspace, probe), [
      "import { test } from 'node:test';",
      "import { writeFileSync } from 'node:fs';",
      "test('records the unit child environment', () => {",
      `  const keys = ${JSON.stringify(['PATH', ...Object.keys(preserved)])};`,
      `  writeFileSync(${JSON.stringify(observation)}, JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));`,
      '});',
      '',
    ].join('\n'));
    writeFileSync(join(workspace, sentinel), "import { test } from 'node:test'; test('unselected', () => {});\n");

    const processRow = execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='], { encoding: 'utf8' })
      .trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    assert.ok(processRow, 'fixture needs a verified parent process identity');
    const statePath = join(home, '.raf', readJson(join(root, 'conf/raf.json')).state.fileName);
    const store = openStateStore(statePath);
    try {
      const runId = randomUUID();
      store.sessionRepository.transaction(tx => tx.putSession({
        runId, addressId: `unit-path-fixture-${runId}`, revision: 0, state: 'running',
        process: {
          pid: process.pid, startedAt: new Date(processRow[1]).toISOString(), runner: 'qa',
          runnerSessionId: runId, tmuxSession: '', evidence: {
            command: processRow[2],
            machineId: readFileSync('/etc/machine-id', 'utf8').trim(),
            bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
          },
        },
        launchContext: {
          assignment: {
            root, changes: [{ id: 'add-raf-test-run', items: [{ id: '5.9', description: 'Unit PATH fixture' }] }], baselineArchives: [],
          },
          selection: { runner: 'qa', model: 'fixture', effort: 'fixture', reason: 'Controlled unit child' },
          briefPath: join(stand, 'brief.md'), reportPath: join(stand, 'report.json'),
          testAssignment: { runId, agentId: 'unit-path-fixture', type: 'qa', phase: 'qa', project: 'raf', workspace, branch, changes: ['add-raf-test-run'] },
        },
      }));
    } finally {
      store.close();
    }
    return {
      stand, root, workspace, home, observation,
      close: () => {
        rmSync(stand, { recursive: true, force: true });
        rmSync(temporary!, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(stand, { recursive: true, force: true });
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function childEnvironment(f: ReturnType<typeof fixture>, entries: string[]): Promise<Record<string, string>> {
  const argv = [join(code, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', 'qa', '--group', group, '--files', probe];
  const child = spawn(process.execPath, argv, {
    cwd: f.workspace,
    env: { ...preserved, PATH: entries.join(delimiter), HOME: f.home, RAF_QA_HOME: f.home, RAF_ORCHESTRATOR_ROOT: f.root, TMUX: '', TMUX_PANE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
    child.once('error', fail);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  const exit = await completed;
  assert.equal(exit.signal, null, stderr);
  const result = JSON.parse(stdout) as TestRunResult;
  assert.equal(exit.code, 0, JSON.stringify({ result, stderr }));
  assert.equal(result.outcome, 'passed', JSON.stringify(result));
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.cleanup, { complete: true, remainingPids: [] });
  assert.deepEqual(result.selection.files, [probe]);
  assert.ok(existsSync(f.observation), 'the configured unit child must actually execute');
  return readJson(f.observation);
}

const scenarios = [
  { name: 'removes the leading raf sandbox helper directory', layout: 'leading' },
  { name: 'removes raf sandbox directories at every PATH position', layout: 'mixed' },
  { name: 'preserves a clean host PATH exactly', layout: 'clean' },
] as const;

for (const scenario of scenarios) {
  test(`test run PATH: ${scenario.name}`, { concurrency: false }, async () => {
    const f = fixture();
    try {
      const host = [join(f.stand, 'host bin'), dirname(process.execPath), '/usr/bin', '/bin', join(f.stand, 'host-tools-codex-sandbox-docs'), '/usr/bin'];
      const sandbox = ['parent', 'nested', 'last'].map(id => join(f.stand, `codex-sandbox-${id}`));
      for (const path of [host[0], host[4], ...sandbox]) mkdirSync(path, { recursive: true });
      const entries = scenario.layout === 'leading' ? [sandbox[0], ...host]
        : scenario.layout === 'mixed' ? [sandbox[0], ...host.slice(0, 2), sandbox[1] + '/', ...host.slice(2), sandbox[2]]
        : host;
      const observed = await childEnvironment(f, entries);
      assert.equal(observed.PATH, host.join(delimiter), 'unit child PATH must exclude raf sandbox helpers and retain host order, duplicates and spaces');
      assert.deepEqual(Object.fromEntries(Object.keys(preserved).map(key => [key, observed[key]])), preserved, 'PATH cleanup must preserve the other inherited environment variables');
    } finally {
      f.close();
    }
  });
}
