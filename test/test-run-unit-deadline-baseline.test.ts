import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import { runTestRun } from '../src/test-runs.ts';
import { RunHarness, files, policy } from './helpers/test-run-fixture.ts';

test('unit deadline kills a hung Vitest API and detached pool despite per-test timeouts', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'raf-deadline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = new RunHarness();
  h.context.workspace = root;
  h.context.cwd = root;
  h.context.projectWorkspaces.raf.push(root);
  h.context.home = join(root, 'home');
  h.context.statePath = join(root, 'home/state.sqlite');
  h.context.tmpPath = join(root, 'tmp');
  mkdirSync(h.context.tmpPath);
  mkdirSync(h.context.home);
  h.environment.canonicalWorkspace = root;
  h.environment.canonicalCwd = root;
  for (const [file, fact] of Object.entries(h.environment.files)) fact.realpath = join(root, file);
  const profile = h.config.projects.raf.profiles.node;
  profile.executable = process.execPath;
  profile.resultAdapter = 'vitest-events';
  profile.exactIds = 'vitest-test-name';
  profile.argv = ['vitest.mjs', 'run', '--configLoader', 'runner'];
  writeFileSync(join(root, 'vitest.config.ts'), 'export default {}');
  mkdirSync(join(root, 'node_modules/vitest/dist'), { recursive: true });
  writeFileSync(join(root, 'node_modules/vitest/package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'node_modules/vitest/dist/node.js'), `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    export function parseCLI(argv) {
      const option = name => Number(argv[argv.indexOf(name) + 1]);
      return { filter: [], options: { testTimeout: option('--testTimeout'), hookTimeout: option('--hookTimeout') } };
    }
    export async function createVitest(mode, options) {
      return { projects: [], close: async () => {}, start: async () => {
        const pool = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        await new Promise(resolve => pool.once('spawn', resolve));
        writeFileSync('ready.json', JSON.stringify({ api: process.pid, pool: pool.pid, options }));
        await new Promise(() => {});
      } };
    }
  `);
  const runtime = createTestRunPorts(h.config, {
    mode: 'qa', orchestratorRoot: root, codeRoot: root, homeDirectory: h.context.home,
    statePath: h.context.statePath, tmpRoot: h.context.tmpPath, tmuxSocketPath: join(root, 'socket'),
  }, () => { throw new Error('Fixture uses memory state'); }, {}, {
    flow: JSON.stringify({ unitTests: policy }), testRuns: '{}', projects: '{}',
  });
  let managed: Awaited<ReturnType<typeof runtime.spawn>> | undefined;
  h.ports.spawn = async (command, onEvent, planned) => {
    command.environment.TMPDIR = h.context.tmpPath;
    managed = await runtime.spawn(command, onEvent, planned);
    return managed;
  };
  t.after(async () => { if (managed) await managed.cleanup(h.clock.now(), 'interruption'); });
  const pending = runTestRun({ project: 'raf', phase: 'hotfix', group: 'add-raf-test-run/unit', files: [files[0]] }, h.config, policy, h.context, h.ports);
  while (!existsSync(join(root, 'ready.json'))) await delay(10);
  const ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'));
  assert.equal(ready.options.testTimeout, policy.timeoutMs);
  assert.equal(ready.options.hookTimeout, policy.timeoutMs);
  for (const pid of [ready.api, ready.pool]) assert.doesNotThrow(() => process.kill(pid, 0));
  h.clock.advance(policy.timeoutMs);
  const result = await pending;
  assert.equal(result.testKind, 'unit');
  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutCount, 1);
  assert.equal(result.nextAction, 'optimize');
  assert.deepEqual(result.cleanup, { complete: true, remainingPids: [] });
  assert.equal(result.signal, 'SIGKILL');
  for (const pid of [ready.api, ready.pool]) {
    if (existsSync('/proc/' + pid + '/stat')) {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z');
    } else assert.throws(() => process.kill(pid, 0));
  }
});
