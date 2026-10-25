import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(process.argv[2] ?? join(repository, 'evidence/z412/native'));
await mkdir(output, { recursive: true });
const base = await mkdtemp(join(repository, '.z412-native-'));
const home = join(base, 'qa-home');
const temporary = join(base, 'tmp');
await Promise.all([home, temporary].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
process.env.HOME = home;
process.env.TMPDIR = temporary;
for (const key of ['TMUX', 'TMUX_PANE', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) delete process.env[key];
const { deriveTaskContext } = await import('../../src/task-context.ts');
const { verifyAssignmentCompletion } = await import('../../src/assignment.ts');
const { readPendingAgentReport } = await import('../../src/agent-report.ts');
const configuration = {
  projects: { profiles: { raf: { development: 'develop' } }, projects: { raf: {
    path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' },
  } } },
  reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }], resources: {},
};
const captures = [];
function execute(label, executable, args, cwd, environment = process.env) {
  const result = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  captures.push({ label, executable, args, cwd, code: result.status, signal: result.signal, error: result.error?.message ?? null });
  return Promise.all([
    writeFile(join(output, `${label}.stdout`), result.stdout ?? ''),
    writeFile(join(output, `${label}.stderr`), result.stderr ?? ''),
    writeFile(join(output, `${label}.result.json`), JSON.stringify(captures.at(-1), null, 2) + '\n'),
  ]).then(() => result);
}
const put = async (path, content) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
const requirement = name => `### Requirement: ${name}\nThe application SHALL finish the demo operation.\n\n#### Scenario: Successful operation\n- **WHEN** the operation is requested\n- **THEN** it completes successfully\n`;
const summary = {
  kind: 'integration',
  sandbox: 'Nested /usr/bin/bwrap: read-only root and only the derived directory write binds; the outer sandbox and network restrictions remain in force. This is not a full Codex launch.',
  command: [process.execPath, 'evidence/z412/archive-stand.mjs', process.argv[2]],
  sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim(),
  sourceWorkspace: spawnSync('git', ['status', '--short'], { cwd: repository, encoding: 'utf8' }).stdout,
  base, home, output, captures, cases: [], cleanup: null,
};
try {
  assert.equal((await execute('openspec-version', 'openspec', ['--version'], repository)).status, 0);
  for (const mode of ['sync', 'skip', 'nonfinal']) {
    const root = join(base, mode);
    const cwd = join(root, 'raf-develop');
    const change = `archive-demo-${mode}`;
    const active = join(root, 'openspec/changes', change);
    const run = join(base, `run-${mode}`);
    await Promise.all([cwd, active, run, join(root, 'openspec/changes/archive')].map(path => mkdir(path, { recursive: true })));
    await put(join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
    await put(join(active, '.openspec.yaml'), `schema: spec-driven\ncreated: 2026-10-25\n${mode === 'skip' ? 'skip_specs: true\n' : ''}`);
    await put(join(active, 'proposal.md'), `## Why\nFinish a demo operation reliably.\n\n## What Changes\nComplete the operation.\n\n## Capabilities\n### Added Capabilities\n- demo/new\n\n## Impact\nDemo application only.\n`);
    await put(join(active, 'tasks.md'), `- [x] 1.1 Earlier work\n- [ ] 7.2 Finish change\n${mode === 'nonfinal' ? '- [ ] 8.1 Other work\n' : ''}`);
    const questions = join(root, 'questions/projects/raf/questions.md');
    await put(questions, '# Questions\n');
    const unrelated = join(root, 'openspec/specs/demo/unrelated/spec.md');
    await put(unrelated, '# Unrelated\n');
    await put(join(root, 'conf/foreign.json'), '{}\n');
    if (mode !== 'skip') {
      await put(join(active, 'specs/demo/new/spec.md'), `## ADDED Requirements\n\n${requirement('New operation')}`);
      await put(join(active, 'specs/demo/existing/spec.md'), `## MODIFIED Requirements\n\n${requirement('Existing operation')}`);
      await put(join(root, 'openspec/specs/demo/existing/spec.md'), `# demo/existing Specification\n\n## Purpose\nExisting operation.\n\n## Requirements\n\n${requirement('Existing operation').replace('finish', 'start')}`);
    }
    const assignment = { root, baselineArchives: [], changes: [{ id: change, items: [{ id: '7.2', description: 'Finish change' }] }] };
    const parameters = { id: 'last-executor', type: 'spec', phase: 'spec', project: 'raf', complexity: 'low', features: [change], tasks: [`${change}:7.2`] };
    const context = await deriveTaskContext({ root, parameters, assignment, configuration });
    const boundaries = context.writeBoundaries.map(path => resolve(path));
    for (const path of context.writeBoundaries) if (path.endsWith('/')) await mkdir(path, { recursive: true });
    const permissions = { ':root': 'read', [run]: 'write', [home]: 'write', [temporary]: 'write' };
    for (const path of boundaries) if (path !== questions) permissions[path] = 'write';
    permissions[cwd] = 'read';
    const policy = ['--ro-bind', '/', '/', ...Object.entries(permissions).filter(([, access]) => access === 'write').flatMap(([path]) => ['--bind', path, path]), '--chdir', root, '--'];
    await writeFile(join(output, `${mode}.scope.json`), JSON.stringify({ context, boundaries, permissions, assignment }, null, 2) + '\n');
    await put(join(active, 'tasks.md'), `- [x] 1.1 Earlier work\n- [x] 7.2 Finish change\n${mode === 'nonfinal' ? '- [ ] 8.1 Other work\n' : ''}`);
    const args = ['archive', change, '--yes', '--json', ...(mode === 'skip' ? ['--skip-specs'] : [])];
    const probe = await execute(`${mode}-denied`, '/usr/bin/bwrap', [...policy, process.execPath, '--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; const denied = ${JSON.stringify([unrelated, join(root, 'conf/foreign.json'), join(cwd, 'foreign.txt')])}; for (const path of denied) { try { writeFileSync(path, 'forbidden'); throw new Error('write permitted: ' + path); } catch (error) { if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error; } }`], cwd);
    assert.equal(probe.status, 0, `${mode}: denied paths probe failed: ${probe.stderr}`);
    const archived = await execute(`${mode}-archive`, '/usr/bin/bwrap', [...policy, 'openspec', ...args], cwd);
    assert.equal(await readFile(unrelated, 'utf8'), '# Unrelated\n');
    if (mode === 'nonfinal') {
      assert.notEqual(archived.status, 0, 'a nonfinal executor cannot archive');
      assert.match(archived.stdout + archived.stderr, /EACCES|EPERM|EROFS|Permission denied|Read-only file system/i);
      assert.ok((await readFile(join(active, 'tasks.md'), 'utf8')).includes('8.1 Other work'));
      summary.cases.push({ mode, boundaries, archiveCode: archived.status, accepted: false, expectedDenial: true });
      continue;
    }
    assert.equal(archived.status, 0, `${mode}: actual archive failed: ${archived.stdout}\n${archived.stderr}`);
    const archiveNames = await readdir(join(root, 'openspec/changes/archive'));
    const archive = archiveNames.find(name => name.endsWith(`-${change}`));
    assert.ok(archive, 'actual archive path is required');
    await assert.rejects(readFile(join(active, 'tasks.md')), { code: 'ENOENT' });
    if (mode === 'sync') {
      assert.match(await readFile(join(root, 'openspec/specs/demo/new/spec.md'), 'utf8'), /New operation/);
      assert.match(await readFile(join(root, 'openspec/specs/demo/existing/spec.md'), 'utf8'), /finish the demo/);
    }
    const report = { status: 'succeeded', answer: 'Archived', commits: [], changes: [{ id: change, archive, items: [{ id: '7.2', status: 'succeeded' }] }] };
    const reportPath = join(run, 'z412/last-executor.json');
    await put(reportPath, JSON.stringify(report));
    const diagnostics = [];
    const result = await readPendingAgentReport({ tmpRoot: run, runId: 'z412', address: 'last-executor', assignment }, {
      fs: { readText: path => readFile(path, 'utf8') }, now: () => new Date().toISOString(),
      diagnostic: async reason => { diagnostics.push(reason); },
      verifyAssignmentCompletion: (snapshot, claims) => verifyAssignmentCompletion(snapshot, {
        cli: { exec: async cliArgs => { const r = await execute(`${mode}-verify-${cliArgs.includes('--archived') ? 'archived' : 'active'}`, 'openspec', cliArgs, root); return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }; } },
        fs: { readText: path => readFile(path, 'utf8') },
      }, claims),
    });
    await writeFile(join(output, `${mode}.report-acceptance.json`), JSON.stringify({ report, result, diagnostics }, null, 2) + '\n');
    assert.equal(result?.event, 'agent.succeeded', diagnostics.join('\n'));
    summary.cases.push({ mode, boundaries, archive, archiveCode: archived.status, accepted: true });
  }
  summary.outcome = 'passed';
} catch (error) {
  summary.outcome = 'failed';
  summary.error = error.stack;
  process.exitCode = 1;
} finally {
  await rm(base, { recursive: true, force: true });
  summary.cleanup = { removed: base, completed: true };
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ outcome: summary.outcome, output, cases: summary.cases, error: summary.error ?? null }) + '\n');
}
