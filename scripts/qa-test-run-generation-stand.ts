import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [phase, outputArgument] = process.argv.slice(2);
assert.ok(['red', 'hotfix'].includes(phase));
assert.ok(outputArgument);
const source = resolve(import.meta.dirname, '..');
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const fixture = mkdtempSync(join(tmpdir(), 'raf-generation-stand-'));
const workspace = join(fixture, 'etchly');
const home = join(fixture, 'home');
const temporary = join(fixture, 'tmp');
const dependencies = '/srv/dev/work/orchestrator/etchly-develop/node_modules';
const conf = resolve(source, '../conf');
const budget = JSON.parse(readFileSync(join(conf, 'flow.json'), 'utf8')).unitTests.timeoutMs;
const limits = JSON.parse(readFileSync(join(conf, 'test-runs.json'), 'utf8')).diagnostics;
const results: any[] = [];
const groups = new Set<number>();
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, RAF_QA_HOME: home, TMPDIR: temporary,
  TEST: 'true', VITEST: 'true', NODE_ENV: 'test', RAF_TEST_RUN_WORKSPACE: workspace,
  RAF_TEST_RUN_IDS: '[]', RAF_TEST_RUN_DIAGNOSTICS: JSON.stringify(limits) };
const stop = () => { for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as any).code !== 'ESRCH') throw error; } } };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const deadline = Date.now() + budget;
async function run(label: string, argv: string[]): Promise<any> {
  const child = spawn(process.execPath, argv, { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  groups.add(child.pid!);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, deadline - Date.now()));
  const chunks: Buffer[][] = [[], [], []];
  [child.stdout!, child.stderr!, child.stdio[3]!].forEach((stream: any, index) => stream.on('data', (chunk: Buffer) => chunks[index].push(chunk)));
  const [exitCode, signal] = await new Promise<[number | null, string | null]>((done, fail) => {
    child.once('error', fail); child.once('close', (code, signal) => done([code, signal]));
  });
  clearTimeout(timer);
  let cleanup = false;
  try { process.kill(-child.pid!, 0); } catch (error) { if ((error as any).code === 'ESRCH') cleanup = true; else throw error; }
  if (cleanup) groups.delete(child.pid!);
  ['stdout', 'stderr', 'protocol'].forEach((name, index) => writeFileSync(join(output, `${label}.${name}`), Buffer.concat(chunks[index])));
  const result = { label, command: [process.execPath, ...argv], cwd: workspace, exitCode, signal, timedOut, cleanup };
  results.push(result);
  return result;
}
let failure: string | null = null;
try {
  for (const path of [workspace, home, temporary]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, 'package.json'), '{"type":"module"}');
  symlinkSync(dependencies, join(workspace, 'node_modules'));
  const cases = phase === 'red' ? [['slot', 'happy-dom']] : [['slot', 'happy-dom'], ['slot', 'node'], ['ordinary', 'happy-dom'], ['ordinary', 'node']];
  for (const [layout, environment] of cases) {
    const raf = layout === 'slot' ? join(fixture, 'raf-main-a') : join(fixture, 'raf-main');
    if (!existsSync(raf)) {
      mkdirSync(raf, { recursive: true });
      cpSync(join(source, 'src'), join(raf, 'src'), { recursive: true });
      cpSync(join(source, 'scripts'), join(raf, 'scripts'), { recursive: true });
      writeFileSync(join(raf, 'package.json'), '{"type":"module"}');
    }
    writeFileSync(join(workspace, 'vitest.config.ts'), `export default { test: { environment: ${JSON.stringify(environment)}, include: ['probe.test.ts'], pool: 'forks', maxWorkers: 1, fileParallelism: false } };`);
    writeFileSync(join(workspace, 'probe.test.ts'), `import {test, expect} from 'vitest'; test('body executed', () => { expect(${environment === 'node' ? "typeof document" : 'document.nodeType'}).toBe(${environment === 'node' ? "'undefined'" : '9'}); });`);
    const argv = ['run', 'probe.test.ts', '--configLoader', 'runner'];
    const label = `${layout}-${environment}`;
    const direct = await run(`${label}-direct`, [join(workspace, 'node_modules/vitest/vitest.mjs'), ...argv]);
    assert.equal(direct.exitCode, 0, 'Direct Vitest fixture must pass before interpreting wrapped failure');
    assert.ok(direct.cleanup && !direct.timedOut);
    const wrapped = await run(`${label}-wrapped`, [join(raf, 'scripts/test-run-vitest-api.ts'), ...argv, '--reporter', join(raf, 'src/test-run-vitest-reporter.ts')]);
    assert.ok(wrapped.cleanup && !wrapped.timedOut);
    const protocol = readFileSync(join(output, `${label}-wrapped.protocol`), 'utf8');
    if (phase === 'red') {
      assert.notEqual(wrapped.exitCode, 0);
      assert.match(protocol, /ERR_MODULE_NOT_FOUND/);
      assert.match(protocol, /test-run-vitest-runner\.ts/);
    } else {
      assert.equal(wrapped.exitCode, 0);
      const events = protocol.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.kind === 'passed').length, 1);
      assert.ok(events.some(event => event.kind === 'complete' && event.expected?.length === 1));
      assert.ok(!events.some(event => /failed|error/.test(event.kind)));
    }
  }
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  stop();
  rmSync(fixture, { recursive: true, force: true });
  const provenance = (args: string[]) => spawnSync('git', args, { cwd: source, encoding: 'utf8' }).stdout;
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ phase, failure, fixture, isolatedHome: home, temporary,
    timeoutMs: budget, source, sha: provenance(['rev-parse', 'HEAD']).trim(), dirty: provenance(['status', '--porcelain']),
    fixtureRemoved: !existsSync(fixture), results }, null, 2) + '\n');
}
