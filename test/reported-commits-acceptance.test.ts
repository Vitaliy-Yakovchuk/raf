import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentReportWatcher, readPendingAgentReport, type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import type { AssignmentSnapshot, AssignmentVerification } from '../src/assignment.ts';
import type { ReportedCommit, ReportedCommitAcceptancePorts, ReportedCommitLaunchContext, ReportedCommitRepository, ReportedCommitRequestContext } from '../src/reported-commits-contract.ts';
import type { SessionLaunchContext } from '../src/session-state.ts';
import { configuration, fixture } from './production-fixture.ts';
import { agentRunFixture, alive, exists, until } from './agent-run-fixture.ts';
import { openStateStore } from '../src/state-store.ts';
import type { SessionRecord } from '../src/session-state.ts';

const prefix = '[reported-commits Z.370.1]';
const good: AssignmentVerification = { ok: true, issues: [] };
const instant = '2026-10-23T12:00:00.000Z';

function gitEnv(extra: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, ...extra, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

function git(root: string, args: readonly string[], options: { index?: string; input?: string } = {}): string {
  const result = spawnSync('git', ['-c', 'user.name=Reported commits fixture', '-c', 'user.email=reported@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    cwd: root, env: gitEnv(options.index ? { GIT_INDEX_FILE: options.index } : {}), encoding: 'utf8', input: options.input,
  });
  assert.equal(result.status, 0, `Git fixture ${JSON.stringify(args)}: ${result.error ?? ''} ${result.stderr}`);
  return result.stdout.trimEnd();
}

function put(root: string, path: string, body: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function isolatedCommit(root: string, index: string, files: Record<string, string | null>, message: string): string {
  rmSync(index, { force: true });
  git(root, ['read-tree', 'HEAD'], { index });
  for (const [path, body] of Object.entries(files)) {
    if (body === null) rmSync(join(root, path), { force: true });
    else put(root, path, body);
    git(root, ['add', '-A', '--', path], { index });
  }
  git(root, ['commit', '--quiet', '-m', message], { index });
  return git(root, ['rev-parse', 'HEAD']);
}

function indexEntries(root: string): Map<string, string> {
  const result = git(root, ['ls-files', '--stage', '-z']);
  return new Map(result.split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    return [row.slice(tab + 1) + ':' + row.slice(0, tab).split(' ')[2], row.slice(0, tab)];
  }));
}

function workingBytes(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      if (name === '.git') continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) entries[relative(root, path)] = `${stat.mode & 0o777}:${readFileSync(path).toString('base64')}`;
    }
  };
  visit(root);
  return entries;
}

function repository(root: string, format: 'sha1' | 'sha256' = 'sha1') {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet', '--initial-branch=main', `--object-format=${format}`]);
  put(root, 'old.txt', 'old\n');
  git(root, ['add', '--', 'old.txt']);
  git(root, ['commit', '--quiet', '-m', 'older than launch']);
  const older = git(root, ['rev-parse', 'HEAD']);
  for (const path of ['repeat.txt', 'delete.txt', 'foreign-blob.txt', 'foreign-delete.txt', 'foreign-conflict.txt', 'outside.txt']) put(root, path, `base ${path}\n`);
  put(root, 'tasks.md', '- [ ] 1.1 assigned\n- [ ] 1.2 sentinel\n');
  put(root, 'mode.sh', '#!/bin/sh\nexit 0\n');
  git(root, ['add', '--', '.']);
  git(root, ['commit', '--quiet', '-m', 'launch baseline']);
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const index = join(dirname(root), `${basename(root)}-private-index`);
  const first = isolatedCommit(root, index, { 'tasks.md': '- [x] 1.1 assigned\n- [ ] 1.2 sentinel\n', 'added.txt': 'added\n', 'delete.txt': null, 'repeat.txt': 'first\n', 'mode.sh': '#!/bin/sh\nexit 1\n' }, 'executor first');
  const foreign = isolatedCommit(root, index, { 'outside.txt': 'foreign between reports\n' }, 'foreign unreported');
  const second = isolatedCommit(root, index, { 'repeat.txt': 'second\n', 'second.txt': 'second added\n' }, 'executor second');
  chmodSync(join(root, 'mode.sh'), 0o755);
  const head = isolatedCommit(root, index, { 'repeat.txt': 'later HEAD\n', 'mode.sh': '#!/bin/sh\nexit 2\n' }, 'later foreign HEAD');
  const metadata: ReportedCommitRepository = {
    repositoryRoot: realpathSync(root), gitDirectory: realpathSync(git(root, ['rev-parse', '--absolute-git-dir'])),
    commonDirectory: realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir']))), objectFormat: format, launchHead: baseline,
  };
  return { root: realpathSync(root), baseline, older, first, second, foreign, head, metadata, index };
}

type Repo = ReturnType<typeof repository>;
type Report = Omit<AgentReport, 'commits'> & { commits?: unknown };
type Request = AgentReportRequest & ReportedCommitRequestContext;
type Ports = AgentReportPorts & ReportedCommitAcceptancePorts;

function acceptance(t: TestContext, options: { legacy?: boolean; format?: 'sha1' | 'sha256' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'raf-reported-')));
  mkdirSync(join(base, 'home'));
  mkdirSync(join(base, 'tmp'));
  const a = repository(join(base, 'orchestrator'), options.format);
  const b = repository(join(base, 'code'), options.format);
  const runId = 'reported-current-run';
  const address = 'reported-worker';
  const tmpRoot = join(base, 'tmp');
  const reportPath = join(tmpRoot, runId, `${address}.json`);
  const assignment: AssignmentSnapshot = { root: a.root, baselineArchives: [], changes: [{ id: 'reported-fixture', items: [{ id: '1.1', description: 'assigned' }] }] };
  const metadata: ReportedCommitLaunchContext = { contract: 'reported-commits-v1', runId, reportPath, repositories: [a.metadata, b.metadata], writeBoundaries: [a.root, b.root] };
  const request: Request = { tmpRoot, runId, address, assignment, ...(options.legacy ? {} : { reportedCommits: metadata }) };
  let snapshot: Report = { status: 'succeeded', answer: 'Committed fixture results.', changes: [{ id: 'reported-fixture', items: [{ id: '1.1', status: 'succeeded' }] }], commits: [{ repository: a.root, sha: a.first }, { repository: a.root, sha: a.second }] };
  let current = true;
  let openspecValid = true;
  let duringConfirmation: (() => Promise<void>) | undefined;
  let listener: ((event: 'create' | 'modify' | 'rename', filename: string) => Promise<void>) | undefined;
  let exitListener: ((exit: { code: number | null; signal: string | null }) => Promise<void>) | undefined;
  const trace: string[] = [];
  const results: AgentReportResult[] = [];
  const diagnostics: string[] = [];
  const confirmations: AgentReport[] = [];
  const ports: Ports = {
    fs: {
      mkdir: async path => { mkdirSync(path, { recursive: true }); },
      readText: async path => existsSync(path) ? readFileSync(path, 'utf8') : null,
      removeTree: async () => { trace.push('cleanup'); },
    },
    now: () => instant,
    watch: (_directory, next) => { listener = next; return () => { listener = undefined; }; },
    process: { onExit: next => { exitListener = next; return () => { exitListener = undefined; }; } },
    isCurrentReport: async (id, path) => current && id === metadata.runId && path === metadata.reportPath,
    confirmTaskCheckboxes: async (_request, report) => {
      trace.push('checkbox');
      confirmations.push(report);
      if (duringConfirmation) await duringConfirmation();
      return { ...good, commits: [] };
    },
    verifyAssignmentCompletion: async () => { trace.push('openspec'); return { ok: openspecValid, issues: [] }; },
    result: async result => { trace.push('result'); results.push(result); },
    diagnostic: async reason => { diagnostics.push(reason); },
  };
  const publish = (next: Report = snapshot) => {
    snapshot = next;
    mkdirSync(dirname(reportPath), { recursive: true });
    const temporary = reportPath + '.next';
    writeFileSync(temporary, JSON.stringify(next));
    renameSync(temporary, reportPath);
  };
  publish();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return {
    base, a, b, runId, reportPath, request, metadata, assignment, ports, trace, results, diagnostics, confirmations, publish,
    report: () => snapshot,
    pending: () => readPendingAgentReport(request, ports),
    watcher: () => createAgentReportWatcher(request, ports),
    notify: async () => { assert.ok(listener, 'watch callback is registered'); await listener('rename', basename(reportPath)); },
    exit: async () => { assert.ok(exitListener); await exitListener({ code: 23, signal: null }); },
    setCurrent: (value: boolean) => { current = value; },
    setOpenSpec: (value: boolean) => { openspecValid = value; },
    duringConfirmation: (hook: typeof duringConfirmation) => { duringConfirmation = hook; },
  };
}

type Acceptance = ReturnType<typeof acceptance>;

function assertNoWrite(f: Acceptance, before: Map<string, string>[]) {
  assert.equal(f.confirmations.length, 0, 'invalid input cannot confirm checkboxes');
  assert.equal(f.results.length, 0, 'invalid input cannot publish a result');
  assert.deepEqual(indexEntries(f.a.root), before[0]);
  assert.deepEqual(indexEntries(f.b.root), before[1]);
}

for (const legacy of [false, true]) {
  for (const [label, value] of [['empty', []], ['strings', ['HEAD']], ['unknown object', { from: 'answer' }], ['extra key', [{ repository: '/tmp/untrusted', sha: 'a'.repeat(40), command: 'repair' }]], ['null', null]] as const) {
    test(`${prefix} ${legacy ? 'legacy' : 'new'} contract: ${label}`, async t => {
      const f = acceptance(t, { legacy });
      f.publish({ ...f.report(), commits: value, version: 99, runId: f.runId, repository: f.b.root, evidence: { commits: [f.a.first] } });
      const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
      const result = await f.pending();
      assert.ok(result, 'commit evidence does not gate acceptance');
      assert.deepEqual(indexEntries(f.a.root), before[0]);
      assert.deepEqual(indexEntries(f.b.root), before[1]);
    });
  }
  test(`${prefix} ${legacy ? 'legacy' : 'new'} contract: omitted commits`, async t => {
    const f = acceptance(t, { legacy });
    const { commits: _commits, ...without } = f.report();
    f.publish(without);
    const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
    assert.ok(await f.pending());
    assert.deepEqual(indexEntries(f.a.root), before[0]);
    assert.deepEqual(indexEntries(f.b.root), before[1]);
  });
}

for (const input of ['absent', 'partial JSON', 'wrong assignment'] as const) {
  test(`${prefix} ${input} cannot infer commits`, async t => {
    const f = acceptance(t);
    if (input === 'absent') rmSync(f.reportPath);
    if (input === 'partial JSON') writeFileSync(f.reportPath, '{"status":');
    if (input === 'wrong assignment') f.publish({ ...f.report(), changes: [{ id: 'another-change', items: [{ id: '1.1', status: 'succeeded' }] }] });
    const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
    assert.equal(await f.pending(), null);
    assertNoWrite(f, before);
  });
}

function assertCommitSchema(schema: Readonly<Record<string, unknown>>) {
  assert.ok(Array.isArray(schema.required) && schema.required.includes('commits'), 'new launch schema must require commits');
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.commits?.type, 'array');
  const item = properties.commits.items as Record<string, unknown>;
  assert.equal(item.type, 'object');
  assert.equal(item.additionalProperties, false);
  assert.deepEqual([...(item.required as string[])].sort(), ['repository', 'sha']);
  const fields = item.properties as Record<string, Record<string, unknown>>;
  assert.equal(fields.repository.type, 'string');
  assert.equal(fields.sha.type, 'string');
  assert.deepEqual(Object.keys(fields).sort(), ['repository', 'sha']);
}

test(`${prefix} new production task schema and every runner brief describe the same typed commits`, async t => {
  const f = await fixture(t, { productionQa: true });
  const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const task = await services.resolveTask(f.params, f.assignment);
  assertCommitSchema(task.reportSchema);
  const realBriefs = resolve(import.meta.dirname, '../../conf/briefs');
  const runners = configuration.models.runners;
  for (const runner of runners.map((row: { id: string }) => row.id)) {
    const brief = await services.assignment.compose(f.assignment, {
      cwd: f.cwd, rafCommand: `node ${join(f.cwd, 'bin', 'raf.ts')}`, briefsRoot: realBriefs, runner, stage: 'implement', project: 'raf', agentId: f.params.id, sessionName: f.params.id,
      features: f.params.features, phase: 'implement', outcome: task.outcome, writeBoundaries: [...task.writeBoundaries, f.cwd], sources: task.sources,
      reportSchema: task.reportSchema, reportPath: join(f.tmpRoot, 'brief-run', `${f.params.id}.json`),
      commitOwnWork: true, commitRepositories: [f.root, f.cwd], workspaceWritable: true,
    });
    assert.ok(brief.includes('commits') && brief.includes('repository') && brief.includes('sha'), `${runner} exposes the typed commit record`);
    assert.ok(brief.includes(f.root) && brief.includes(f.cwd), `${runner} names the authorized repositories`);
    assert.ok(brief.includes(JSON.stringify(task.reportSchema, null, 2)) || /"commits"\s*:/.test(brief), `${runner} carries the composed schema`);
  }
});

const change = 'launch-failure-fixture';
const protocolConfiguration = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const protocolTimeouts = protocolConfiguration.runnerProtocols.find((row: { runner: string }) => row.runner === 'codex').timeouts;

async function production(t: TestContext, path: 'worker' | 'reconciliation', options: { last?: boolean; skipSpecs?: boolean; stage?: string } = {}) {
  const f = await agentRunFixture(t, 'reported-commits', protocolTimeouts, 'codex', { productionQa: true, tasks: options.last ? 1 : 2, commands: ['agent ps'], stages: options.stage ? [options.stage] : [] });
  const root = realpathSync(join(f.directory, 'orchestrator'));
  const code = realpathSync(join(root, 'raf-develop'));
  const taskPath = `openspec/changes/${change}/tasks.md`;
  put(code, 'seed.txt', 'code launch baseline\n');
  git(code, ['add', '--', 'seed.txt']);
  git(code, ['commit', '--quiet', '-m', 'launch code baseline']);
  put(root, 'foreign.txt', 'foreign baseline\n');
  git(root, ['add', '--', 'foreign.txt']);
  git(root, ['commit', '--quiet', '-m', 'launch root baseline']);
  if (options.skipSpecs) {
    put(root, `openspec/changes/${change}/.openspec.yaml`, 'schema: spec-driven\ncreated: 2026-10-23\nskip_specs: true\n');
    rmSync(join(root, 'openspec', 'changes', change, 'specs'), { recursive: true });
    git(root, ['add', '--', `openspec/changes/${change}/.openspec.yaml`, `openspec/changes/${change}/specs`]);
    git(root, ['commit', '--quiet', '-m', 'skip specs fixture']);
  }
  const rootBaseline = git(root, ['rev-parse', 'HEAD']);
  const codeBaseline = git(code, ['rev-parse', 'HEAD']);
  const address = `reported-${path}`;
  const launched = await f.run(address, options.stage);
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const runId = JSON.parse(launched.result.stdout).runId as string;
  await until(() => exists(join(f.control, `${address}.brief`)), Boolean, 'synthetic runner received production brief');
  const session = () => f.inspect().sessions.find(row => row.runId === runId);
  const record = session();
  assert.ok(record?.launchContext, 'the real launch has durable metadata');
  const reportPath = record.launchContext.reportPath;
  const wrapper = record.launchContext.wrapper ?? f.inspect().claims.find(row => row.lease.owner.runId === runId)?.wrapper;
  if (path === 'reconciliation') {
    assert.ok(wrapper && alive(wrapper.pid), 'a real worker exists before the restart boundary');
    process.kill(wrapper.pid, 'SIGKILL');
    await until(() => alive(wrapper.pid), value => !value, 'worker stopped, interactive runner still alive');
    assert.ok(record.process && alive(record.process.pid));
  }
  const sourceTasks = readFileSync(join(root, taskPath), 'utf8');
  const indexRoot = join(f.directory, 'root-private-index');
  const indexCode = join(f.directory, 'code-private-index');
  const r1 = isolatedCommit(root, indexRoot, { [taskPath]: sourceTasks + '\nEvidence: executor first commit\n', 'own-first.txt': 'first root result\n' }, 'executor root first');
  const c1 = isolatedCommit(code, indexCode, { 'code-first.txt': 'first code result\n' }, 'executor code first');
  const r2 = isolatedCommit(root, indexRoot, { [taskPath]: sourceTasks + '\nEvidence: executor two commits\n', 'own-second.txt': 'second root result\n' }, 'executor root second');
  const c2 = isolatedCommit(code, indexCode, { 'code-second.txt': 'second code result\n' }, 'executor code second');
  git(root, ['read-tree', 'HEAD']);
  git(code, ['read-tree', 'HEAD']);
  put(root, 'foreign.txt', 'foreign staged bytes\n');
  git(root, ['add', '--', 'foreign.txt']);
  put(root, 'foreign.txt', 'foreign unstaged bytes\n');
  put(code, 'untracked.txt', 'untracked code bytes\n');
  const foreignEntry = indexEntries(root).get('foreign.txt:0');
  const commits: ReportedCommit[] = [{ repository: root, sha: r1 }, { repository: code, sha: c1 }, { repository: root, sha: r2 }, { repository: code, sha: c2 }];
  const report = { status: 'succeeded', answer: 'Verified fixture only.', changes: [{ id: change, items: [{ id: '1.1', status: 'succeeded' }] }], commits };
  const publish = (value: unknown = report) => { writeFileSync(reportPath + '.next', JSON.stringify(value)); renameSync(reportPath + '.next', reportPath); };
  let psStderr = '';
  const ps = async () => {
    const listed = await f.command(['agent', 'ps']);
    psStderr = listed.result.stderr;
    assert.equal(listed.exitCode, 0, JSON.stringify(listed));
    return (JSON.parse(listed.result.stdout) as SessionRecord[]).find(row => row.runId === runId);
  };
  const statePath = join(f.directory, 'home/.raf/state.sqlite');
  const mutate = (operation: (record: SessionRecord) => SessionRecord) => {
    const store = openStateStore(statePath);
    try { store.sessionRepository.transaction(tx => { const record = tx.getSession(runId); assert.ok(record); tx.putSession(operation(record)); }); }
    finally { store.close(); }
  };
  return { ...f, root, code, taskPath, rootBaseline, codeBaseline, address, runId, session, wrapper, reportPath, commits, report, publish, ps, psStderr: () => psStderr, mutate, indexRoot, foreignEntry };
}

test(`${prefix} production reconciliation: agent ps returns the current state without waiting for the checkbox commit`, async t => {
  const f = await production(t, 'reconciliation');
  const head = git(f.root, ['rev-parse', 'HEAD']);
  f.publish();
  const started = Date.now();
  const listed = await f.ps();
  assert.ok(Date.now() - started < protocolTimeouts.transitionMs, 'agent ps does not retry until the worker or service commits the checkbox');
  assert.equal(listed?.result, undefined);
  assert.doesNotMatch(f.psStderr(), /Checkbox commit is left to the worker/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), head, 'agent ps runs no git and creates no checkbox commit');
  assert.match(git(f.root, ['show', `HEAD:${f.taskPath}`]), /\[ \] 1\.1/);
});

for (const path of ['worker'] as const) {
  test(`${prefix} production ${path}: two repositories: durable result and event are idempotent`, async t => {
    const f = await production(t, path);
    const succeededReminder = `succeeded-${path}`;
    f.seedReminder({ id: succeededReminder, createdFor: 'main', assignedTo: 'main', text: 'accept once', at: '2099-01-01T00:00:00.000Z', binding: { kind: 'agent.succeeded', id: f.address, action: 'activate' }, state: 'pending', closedAt: null, closeReason: null });
    const durable = f.session()?.launchContext as (SessionLaunchContext & ReportedCommitRequestContext) | undefined;
    assert.equal(durable?.reportedCommits?.contract, 'reported-commits-v1', 'new launches persist their trusted commit contract before the runner starts');
    const repos = durable.reportedCommits.repositories;
    assert.equal(repos.find(row => row.repositoryRoot === f.root)?.launchHead, '');
    assert.equal(repos.find(row => row.repositoryRoot === f.code)?.launchHead, '');
    f.publish();
    const accepted = await until(f.session, row => row?.result?.status === 'succeeded', 'worker accepted verified commits');
    assert.equal(accepted?.result?.status, 'succeeded');
    assert.equal(accepted?.reportAcceptance?.runId, f.runId);
    assert.match(git(f.root, ['show', `HEAD:${f.taskPath}`]), /\[x\] 1\.1/);
    assert.match(git(f.root, ['show', `HEAD:${f.taskPath}`]), /\[ \] 1\.2/);
    assert.equal(indexEntries(f.root).get('foreign.txt:0'), f.foreignEntry);
    assert.equal(readFileSync(join(f.root, 'foreign.txt'), 'utf8'), 'foreign unstaged bytes\n');
    assert.equal(readFileSync(join(f.code, 'untracked.txt'), 'utf8'), 'untracked code bytes\n');
    const json = readFileSync(f.reportPath, 'utf8');
    const rootHead = git(f.root, ['rev-parse', 'HEAD']);
    const codeHead = git(f.code, ['rev-parse', 'HEAD']);
    await f.ps();
    await f.ps();
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), rootHead, 'reconciliation after durable acceptance creates no second checkbox commit');
    assert.equal(git(f.code, ['rev-parse', 'HEAD']), codeHead);
    assert.equal(readFileSync(f.reportPath, 'utf8'), json);
    assert.equal(f.inspect().reminders.find(row => row.id === succeededReminder)?.state, 'active', 'production event reached its existing consumer');
    assert.equal(f.inspect().pending.filter(row => row.runId === f.runId && row.event === 'agent.succeeded').length, 0, 'event is processed');
    const proof = JSON.stringify(f.session()?.result?.proof);
    assert.ok(proof.includes(f.commits[0].sha), 'proof retains executor commits separately from checkbox commits');
    put(f.root, 'next.txt', 'normal next commit\n');
    git(f.root, ['add', '--', 'next.txt']);
    git(f.root, ['commit', '--quiet', '-m', 'ordinary subsequent commit']);
    assert.match(git(f.root, ['show', `HEAD:${f.taskPath}`]), /\[x\] 1\.1/);
    assert.equal(git(f.root, ['show', 'HEAD:own-first.txt']), 'first root result');
  });
}

test(`${prefix} checkbox proof and answer never supply missing executor commits`, async t => {
  const f = acceptance(t);
  f.publish({ ...f.report(), commits: [], answer: `SHA ${f.a.first}`, checkboxCommits: [{ change: 'reported-fixture', item: '1.1', sha: f.a.second }], executorCommits: [f.a.first] });
  const before = indexEntries(f.a.root);
  assert.ok(await f.pending());
  assert.deepEqual(indexEntries(f.a.root), before);
});

for (const mutation of ['stale reportPath', 'read-only code scope'] as const) {
  test(`${prefix} production reconciliation refuses ${mutation}`, async t => {
    const f = await production(t, 'reconciliation', { stage: mutation === 'read-only code scope' ? 'spec' : undefined });
    if (mutation === 'stale reportPath') {
      f.publish();
      f.mutate(record => ({ ...record, launchContext: { ...record.launchContext!, reportPath: join(f.tmpRoot, 'stale-run', `${f.address}.json`) } }));
    }
    const before = [indexEntries(f.root), indexEntries(f.code)];
    const head = git(f.root, ['rev-parse', 'HEAD']);
    if (mutation !== 'stale reportPath') f.publish();
    const listed = await f.ps();
    assert.equal(listed?.result, undefined, 'untrusted/missing launch identity cannot fall back to legacy interpretation');
    assert.deepEqual(indexEntries(f.root), before[0]);
    assert.deepEqual(indexEntries(f.code), before[1]);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), head);
  });
}

test(`${prefix} production no-report exit leaves executor commits uninferred`, async t => {
  const f = await production(t, 'reconciliation');
  const before = [indexEntries(f.root), indexEntries(f.code)];
  const record = f.session();
  assert.ok(record?.process);
  process.kill(record.process.pid, 'SIGKILL');
  await until(() => alive(record.process!.pid), value => !value, 'synthetic runner exits without JSON');
  await f.ps();
  assert.equal(f.session()?.result?.status, 'failed');
  assert.deepEqual(indexEntries(f.root), before[0], 'no-report never derives commits from root Git log');
  assert.deepEqual(indexEntries(f.code), before[1], 'no-report never derives commits from code Git log');
});
