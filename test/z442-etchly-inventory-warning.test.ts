import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import { runTestRun, type TestRunProfile } from '../src/test-runs.ts';
import { RunHarness, policy } from './helpers/test-run-fixture.ts';

for (const classification of ['reclassified', 'unsupported'] as const) {
  test(`Z442 ${classification} static inventory warns and still starts the selected runner`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'z442-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, 'etchly-hotfix');
    const write = (file: string, source: string) => {
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      writeFileSync(join(workspace, file), source);
    };
    const reviewed = JSON.parse(readFileSync(new URL('../src/test-run-etchly-audit.json', import.meta.url), 'utf8'));
    for (const file of Object.keys(reviewed.sourceHashes)) write(file, '');
    write('package.json', '{}');
    for (const name of ['app', 'worker']) write(`${name}/vitest.config.ts`,
      classification === 'unsupported' ? 'export default {};' : 'const files = testProjectFiles(root, [], {}, selectedTestFiles(root));');
    for (const name of ['assessment', 'domain', 'i18n', 'markdown', 'ui-core']) write(`shared/${name}/vitest.config.ts`, 'export default { include: ["src/**/*.test.ts"] };');
    write('test-support/vitest-project-files.ts', 'export const testProjectFiles = root => ({ integration: root.endsWith("/app") ? ["selected.test.ts"] : [] });');
    write('node_modules/vitest/package.json', '{"version":"4.0.0"}');
    write('node_modules/vitest/vitest.mjs', '');
    const file = 'app/selected.test.ts';
    write(file, 'export {};');
    mkdirSync(join(workspace, 'shared-libs'));
    mkdirSync(join(root, 'conf'));
    writeFileSync(join(root, 'conf/projects.json'), JSON.stringify({ projects: {
      etchly: { branchPaths: { hotfix: workspace } },
      'shared-libs': { branchPaths: { hotfix: join(workspace, 'shared-libs') } },
    } }));
    const home = join(root, 'qa');
    const stateContext = { mode: 'qa' as const, orchestratorRoot: root, codeRoot: workspace,
      homeDirectory: home, statePath: join(home, '.raf/state.sqlite'), tmpRoot: join(home, '.raf/tmp'), tmuxSocketPath: join(home, 'tmux.sock') };
    const h = new RunHarness();
    h.context = { ...h.context, cwd: workspace, workspace, projectWorkspaces: { etchly: [workspace] },
      home, statePath: stateContext.statePath, tmpPath: stateContext.tmpRoot, operationalHome: join(root, 'operational') };
    const group = 'complete-raf-flow-contracts/z442';
    const profile: TestRunProfile = { cwd: 'app', executable: process.execPath,
      argv: ['../node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner'], unitFiles: [file],
      exactIds: 'vitest-test-name', resultAdapter: 'vitest-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [] };
    h.config.projects = { etchly: { profiles: { 'vitest-app': profile }, groups: { [group]: { profileId: 'vitest-app', files: [file] } } } };
    const before = structuredClone(h.config);
    const request = { project: 'etchly', phase: 'hotfix', group };
    const ports = createTestRunPorts(h.config, stateContext, () => { throw new Error('Fixture must not open runtime state'); }, {},
      { flow: Buffer.alloc(0), testRuns: Buffer.alloc(0), projects: Buffer.alloc(0) }, request);
    h.ports.preflight = ports.preflight;
    h.events = [{ kind: 'passed', test: { file, name: 'selected behavior' } }, { kind: 'complete', expected: [{ file, name: 'selected behavior' }] }];
    const warnings: string[] = [];
    t.mock.method(process.stderr, 'write', (chunk: any) => { warnings.push(String(chunk)); return true; });
    const result = await runTestRun(request, h.config, policy, h.context, h.ports);
    assert.equal(result.outcome, 'passed', JSON.stringify(result.diagnostics));
    assert.equal(h.spawns.length, 1);
    assert.deepEqual(result.selection.files, [file]);
    assert.deepEqual(result.knownRed, []);
    assert.deepEqual(result.unexecuted, []);
    assert.deepEqual(result.unknown, []);
    assert.equal(result.cleanup.complete, true);
    assert.match(warnings.join(''), /Warning:.*changed source test-support\/file-budget-runner\.ts/);
    assert.match(warnings.join(''), classification === 'unsupported' ? /unsupported app\/vitest.config.ts/ : /reclassified app\/selected.test.ts/);
    assert.deepEqual(h.config, before);
    assert.equal(readFileSync(join(workspace, 'test-support/file-budget-runner.ts'), 'utf8'), '');
  });
}
