import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentReportWatcher, readPendingAgentReport, type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult } from '../src/agent-report.ts';
import type { AssignmentSnapshot, AssignmentVerification } from '../src/assignment.ts';
import { reconcileReportedCommitIndex, type ReportCommitIndexRequest } from '../src/report-commit-index.ts';
import type { ReportedCommit, ReportedCommitAcceptancePorts, ReportedCommitLaunchContext, ReportedCommitRepository, ReportedCommitRequestContext } from '../src/reported-commits-contract.ts';
import { openSessionRepository } from '../src/session-repository.ts';
import type { SessionLaunchContext } from '../src/session-state.ts';
import { configuration, fixture } from './production-fixture.ts';
import { agentRunFixture, alive, exists, until, type AgentRunFixture } from './agent-run-fixture.ts';
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
type Report = AgentReport & { commits?: unknown };
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
  let sourceValid = true;
  let checkboxShas: string[] = [];
  let current = true;
  let openspecValid = true;
  let awaitingArchive = false;
  let failureRoot: string | null = null;
  let beforeRepair: ((request: ReportCommitIndexRequest) => Promise<void>) | undefined;
  let duringConfirmation: (() => Promise<void>) | undefined;
  let listener: ((event: 'create' | 'modify' | 'rename', filename: string) => Promise<void>) | undefined;
  let exitListener: ((exit: { code: number | null; signal: string | null }) => Promise<void>) | undefined;
  const trace: string[] = [];
  const repairs: ReportCommitIndexRequest[] = [];
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
    readTaskCheckboxCommits: async () => checkboxShas.map(sha => ({ change: 'reported-fixture', item: '1.1', sha })),
    verifyAssignmentSourceIdentity: async () => sourceValid ? good : { ok: false, issues: [{ change: 'reported-fixture', requestedItems: ['1.1'], reason: 'source identity changed', foundItems: [], archives: [], remedy: 'main audit' }] },
    reconcileReportedCommitIndex: async request => {
      trace.push(`repair:${request.repositoryRoot}`);
      repairs.push(structuredClone(request));
      if (beforeRepair) await beforeRepair(request);
      if (failureRoot === request.repositoryRoot) throw new Error(`injected Git I/O ${request.repositoryRoot}`);
      await reconcileReportedCommitIndex(request);
    },
    confirmTaskCheckboxes: async (_request, report) => {
      trace.push('checkbox');
      confirmations.push(report);
      if (duringConfirmation) await duringConfirmation();
      return { ...good, commits: [], awaitingArchive };
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
    base, a, b, runId, reportPath, request, metadata, assignment, ports, trace, repairs, results, diagnostics, confirmations, publish,
    report: () => snapshot,
    pending: () => readPendingAgentReport(request, ports),
    watcher: () => createAgentReportWatcher(request, ports),
    notify: async () => { assert.ok(listener, 'watch callback is registered'); await listener('rename', basename(reportPath)); },
    exit: async () => { assert.ok(exitListener); await exitListener({ code: 23, signal: null }); },
    setCheckboxShas: (value: string[]) => { checkboxShas = value; },
    setSource: (value: boolean) => { sourceValid = value; },
    setCurrent: (value: boolean) => { current = value; },
    setOpenSpec: (value: boolean) => { openspecValid = value; },
    setAwaitingArchive: (value: boolean) => { awaitingArchive = value; },
    failRepository: (value: string | null) => { failureRoot = value; },
    beforeRepair: (hook: typeof beforeRepair) => { beforeRepair = hook; },
    duringConfirmation: (hook: typeof duringConfirmation) => { duringConfirmation = hook; },
  };
}

type Acceptance = ReturnType<typeof acceptance>;

function assertNoWrite(f: Acceptance, before: Map<string, string>[]) {
  assert.equal(f.repairs.length, 0, 'reject the complete set before invoking index repair');
  assert.equal(f.confirmations.length, 0, 'invalid input cannot confirm checkboxes');
  assert.equal(f.results.length, 0, 'invalid input cannot publish a result');
  assert.deepEqual(indexEntries(f.a.root), before[0]);
  assert.deepEqual(indexEntries(f.b.root), before[1]);
}

function assertRepaired(repo: Repo) {
  for (const path of ['tasks.md', 'added.txt', 'repeat.txt', 'second.txt', 'mode.sh']) {
    assert.equal(git(repo.root, ['show', `:${path}`]), git(repo.root, ['show', `HEAD:${path}`]), `${path} index must match current HEAD`);
    const expected = git(repo.root, ['ls-tree', 'HEAD', '--', path]).split(/\s+/)[0];
    assert.equal(indexEntries(repo.root).get(`${path}:0`)?.split(' ')[0], expected, `${path} keeps HEAD mode`);
  }
  assert.equal(indexEntries(repo.root).has('delete.txt:0'), false, 'reported deletion must remain deleted');
}

for (const format of ['sha1', 'sha256'] as const) {
  test(`${prefix} real Git ${format}: only reported diffs repair stale entries, foreign staged/worktree/refs survive`, async t => {
    const f = acceptance(t, { format });
    const a = f.a;
    put(a.root, 'foreign-blob.txt', 'foreign staged blob\n');
    git(a.root, ['add', '--', 'foreign-blob.txt']);
    git(a.root, ['update-index', '--force-remove', '--', 'foreign-delete.txt']);
    git(a.root, ['update-index', '--force-remove', '--', 'foreign-conflict.txt']);
    const oid = git(a.root, ['hash-object', '-w', '--stdin'], { input: 'conflict\n' });
    git(a.root, ['update-index', '--index-info'], { input: [1, 2, 3].map(stage => `100644 ${oid} ${stage}\tforeign-conflict.txt\n`).join('') });
    put(a.root, 'foreign-blob.txt', 'foreign unstaged bytes\n');
    put(a.root, 'untracked.txt', 'keep untracked\n');
    const before = indexEntries(a.root);
    const bytes = workingBytes(a.root);
    const refs = git(a.root, ['show-ref']);
    const result = await f.pending();
    assert.ok(result, 'a valid current report remains acceptable');
    assert.equal(f.repairs.length, 1, 'acceptance must invoke the existing repair API');
    assertRepaired(a);
    for (const [key, value] of before) if (key.startsWith('foreign-') || key.startsWith('outside.txt:')) assert.equal(indexEntries(a.root).get(key), value, key);
    assert.equal(indexEntries(a.root).has('foreign-delete.txt:0'), false);
    assert.deepEqual(workingBytes(a.root), bytes);
    assert.equal(git(a.root, ['show-ref']), refs, 'repair never moves refs');
    assert.ok(f.trace.indexOf(`repair:${a.root}`) < f.trace.indexOf('checkbox'), 'repair must precede checkbox confirmation');
    assert.equal(git(a.root, ['show', ':outside.txt']), 'base outside.txt', 'unreported middle commit is outside repair targets');
    git(a.root, ['reset', '--quiet', 'HEAD', '--', 'foreign-conflict.txt']);
    put(a.root, 'next.txt', 'ordinary next commit\n');
    git(a.root, ['add', '--', 'next.txt']);
    git(a.root, ['commit', '--quiet', '-m', 'ordinary next commit']);
    assert.match(git(a.root, ['show', 'HEAD:tasks.md']), /\[x\] 1\.1/);
    assert.equal(git(a.root, ['show', 'HEAD:added.txt']), 'added');
    assert.equal(git(a.root, ['show', 'HEAD:second.txt']), 'second added');
  });
}

test(`${prefix} interleaved repositories preserve per-repository ancestry and first appearance`, async t => {
  const f = acceptance(t);
  f.publish({ ...f.report(), commits: [f.b, f.a].flatMap(repo => [{ repository: repo.root, sha: repo.first }]).concat([f.b, f.a].map(repo => ({ repository: repo.root, sha: repo.second }))) });
  assert.ok(await f.pending());
  assert.deepEqual(f.repairs, [
    { repositoryRoot: f.b.root, commits: [f.b.first, f.b.second] },
    { repositoryRoot: f.a.root, commits: [f.a.first, f.a.second] },
  ]);
  assertRepaired(f.a);
  assertRepaired(f.b);
});

test(`${prefix} identical OIDs in separate repositories remain separate repair groups`, async t => {
  const f = acceptance(t);
  rmSync(f.b.root, { recursive: true, force: true });
  git(f.base, ['clone', '--quiet', f.a.root, f.b.root]);
  git(f.b.root, ['read-tree', f.a.baseline]);
  Object.assign(f.request, { reportedCommits: { ...f.metadata, repositories: [f.a.metadata, { ...f.b.metadata, launchHead: f.a.baseline }] } });
  f.publish({ ...f.report(), commits: [{ repository: f.a.root, sha: f.a.first }, { repository: f.b.root, sha: f.a.first }] });
  assert.ok(await f.pending());
  assert.equal(f.repairs.length, 2);
  assert.deepEqual(f.repairs.map(value => value.repositoryRoot), [f.a.root, f.b.root]);
});

for (const legacy of [false, true]) {
  for (const [label, value] of [['empty', []], ['strings', ['HEAD']], ['unknown object', { from: 'answer' }], ['extra key', [{ repository: '/tmp/untrusted', sha: 'a'.repeat(40), command: 'repair' }]], ['null', null]] as const) {
    test(`${prefix} ${legacy ? 'legacy' : 'new'} contract: ${label}`, async t => {
      const f = acceptance(t, { legacy });
      f.publish({ ...f.report(), commits: value, version: 99, runId: f.runId, repository: f.b.root, evidence: { commits: [f.a.first] } });
      const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
      const result = await f.pending();
      if (legacy || label === 'empty') {
        assert.ok(result, 'legacy unknown extra remains inert; [] preserves ordinary acceptance');
        assert.equal(f.repairs.length, 0);
        assert.deepEqual(indexEntries(f.a.root), before[0]);
      } else {
        assert.equal(result, null, 'the new contract rejects malformed commits');
        assertNoWrite(f, before);
      }
    });
  }
  test(`${prefix} ${legacy ? 'legacy' : 'new'} contract: omitted commits`, async t => {
    const f = acceptance(t, { legacy });
    const { commits: _commits, ...without } = f.report();
    f.publish(without);
    const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
    assert.equal((await f.pending()) !== null, legacy, 'launch contract controls requiredness');
    assert.equal(f.repairs.length, 0);
    if (!legacy) assertNoWrite(f, before);
  });
}

type InvalidSet = { label: string; commits(f: Acceptance): unknown };
const invalidSets: InvalidSet[] = [
  { label: 'short SHA', commits: f => [{ repository: f.a.root, sha: f.a.first.slice(0, 12) }] },
  { label: 'uppercase SHA', commits: f => [{ repository: f.a.root, sha: f.a.first.toUpperCase() }] },
  { label: 'unknown SHA', commits: f => [{ repository: f.a.root, sha: 'f'.repeat(f.a.first.length) }] },
  { label: 'HEAD ref', commits: f => [{ repository: f.a.root, sha: 'HEAD' }] },
  { label: 'revision expression', commits: f => [{ repository: f.a.root, sha: `${f.a.second}^` }] },
  { label: 'option value', commits: f => [{ repository: f.a.root, sha: '--all' }] },
  { label: 'whitespace', commits: f => [{ repository: f.a.root, sha: f.a.first + '\n' }] },
  { label: 'blob', commits: f => [{ repository: f.a.root, sha: git(f.a.root, ['rev-parse', 'HEAD:repeat.txt']) }] },
  { label: 'tree', commits: f => [{ repository: f.a.root, sha: git(f.a.root, ['rev-parse', 'HEAD^{tree}']) }] },
  { label: 'annotated tag', commits: f => { git(f.a.root, ['tag', '-a', 'reported-tag', f.a.first, '-m', 'tag is not commit']); return [{ repository: f.a.root, sha: git(f.a.root, ['rev-parse', 'reported-tag']) }]; } },
  { label: 'baseline', commits: f => [{ repository: f.a.root, sha: f.a.baseline }] },
  { label: 'older commit', commits: f => [{ repository: f.a.root, sha: f.a.older }] },
  { label: 'duplicate', commits: f => [{ repository: f.a.root, sha: f.a.first }, { repository: f.a.root, sha: f.a.first }] },
  { label: 'reverse ancestry', commits: f => [{ repository: f.a.root, sha: f.a.second }, { repository: f.a.root, sha: f.a.first }] },
  { label: 'sibling not ancestor of HEAD', commits: f => { const tree = git(f.a.root, ['rev-parse', `${f.a.baseline}^{tree}`]); const sibling = git(f.a.root, ['commit-tree', tree, '-p', f.a.baseline, '-m', 'sibling']); return [{ repository: f.a.root, sha: sibling }]; } },
  { label: 'incomparable siblings both reachable from merge HEAD', commits: f => { const tree = git(f.a.root, ['rev-parse', `${f.a.baseline}^{tree}`]); const left = git(f.a.root, ['commit-tree', tree, '-p', f.a.baseline, '-m', 'left sibling']); const right = git(f.a.root, ['commit-tree', tree, '-p', f.a.baseline, '-m', 'right sibling']); const merge = git(f.a.root, ['commit-tree', tree, '-p', left, '-p', right, '-m', 'merge siblings']); git(f.a.root, ['update-ref', 'HEAD', merge, f.a.head]); return [{ repository: f.a.root, sha: left }, { repository: f.a.root, sha: right }]; } },
  { label: 'relative repository', commits: f => [{ repository: relative(f.base, f.a.root), sha: f.a.first }] },
  { label: 'subdirectory repository', commits: f => { mkdirSync(join(f.a.root, 'subdir')); return [{ repository: join(f.a.root, 'subdir'), sha: f.a.first }]; } },
  { label: 'symlink alias', commits: f => { const alias = join(f.base, 'alias'); symlinkSync(f.a.root, alias); return [{ repository: alias, sha: f.a.first }]; } },
  { label: 'unlisted repository', commits: f => [{ repository: repository(join(f.base, 'unlisted')).root, sha: f.a.first }] },
  { label: 'other worktree sharing common dir', commits: f => { const path = join(f.base, 'other-worktree'); git(f.a.root, ['worktree', 'add', '--quiet', '--detach', path, f.a.head]); return [{ repository: path, sha: f.a.first }]; } },
  { label: 'commit absent from named repository', commits: f => [{ repository: f.b.root, sha: isolatedCommit(f.a.root, f.a.index, { 'only-a.txt': 'only here' }, 'unique to repository A') }] },
  { label: 'missing sha field', commits: f => [{ repository: f.a.root }] },
];

for (const entry of invalidSets) {
  test(`${prefix} rejects ${entry.label} in second group before any index write`, async t => {
    const f = acceptance(t);
    const invalid = entry.commits(f) as ReportedCommit[];
    f.publish({ ...f.report(), commits: [{ repository: f.b.root, sha: f.b.first }, ...invalid] });
    const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
    assert.equal(await f.pending(), null, entry.label);
    assertNoWrite(f, before);
    assert.ok(f.diagnostics.length > 0, 'rejection must explain the invalid set');
  });
}

for (const mutation of ['wrong runId', 'wrong reportPath', 'lost metadata', 'source changed', 'reused address', 'git-dir replaced', 'common-dir replaced', 'baseline missing', 'rewritten HEAD'] as const) {
  test(`${prefix} launch identity rejects ${mutation} without fallback`, async t => {
    const f = acceptance(t);
    switch (mutation) {
      case 'wrong runId': Object.assign(f.request, { reportedCommits: { ...f.metadata, runId: 'old-run' } }); break;
      case 'wrong reportPath': Object.assign(f.request, { reportedCommits: { ...f.metadata, reportPath: join(f.base, 'old-run.json') } }); break;
      case 'lost metadata': Object.assign(f.request, { reportedCommits: { ...f.metadata, repositories: [] } }); break;
      case 'source changed': f.setSource(false); break;
      case 'reused address': f.setCurrent(false); break;
      case 'git-dir replaced': Object.assign(f.request, { reportedCommits: { ...f.metadata, repositories: [{ ...f.a.metadata, gitDirectory: f.b.metadata.gitDirectory }, f.b.metadata] } }); break;
      case 'common-dir replaced': Object.assign(f.request, { reportedCommits: { ...f.metadata, repositories: [{ ...f.a.metadata, commonDirectory: f.b.metadata.commonDirectory }, f.b.metadata] } }); break;
      case 'baseline missing': Object.assign(f.request, { reportedCommits: { ...f.metadata, repositories: [{ ...f.a.metadata, launchHead: 'f'.repeat(40) }, f.b.metadata] } }); break;
      case 'rewritten HEAD': git(f.a.root, ['update-ref', 'HEAD', f.a.baseline, f.a.head]); break;
    }
    f.publish({ ...f.report(), runId: f.runId, launchContext: f.metadata, repository: f.a.root });
    const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
    assert.equal(await f.pending(), null, 'JSON identity cannot repair missing or stale trusted metadata');
    assertNoWrite(f, before);
  });
}

test(`${prefix} durable launch metadata survives repository reopen with the original baseline`, async t => {
  const f = acceptance(t);
  const path = join(f.base, 'sessions.sqlite');
  const launchContext = {
    assignment: f.assignment, selection: { runner: 'codex', model: 'fixture', effort: 'high', reason: 'synthetic only' },
    briefPath: join(f.base, 'brief.md'), reportPath: f.reportPath, writeBoundaries: f.metadata.writeBoundaries, reportedCommits: f.metadata,
  } satisfies SessionLaunchContext & ReportedCommitRequestContext;
  const first = openSessionRepository(path);
  first.repository.transaction(tx => tx.putSession({ runId: f.runId, addressId: f.request.address, revision: 1, state: 'running', launchContext }));
  first.close();
  const second = openSessionRepository(path);
  t.after(() => second.close());
  const loaded = second.repository.transaction(tx => tx.getSession(f.runId));
  const persisted = loaded?.launchContext as (SessionLaunchContext & ReportedCommitRequestContext) | undefined;
  assert.deepEqual(persisted?.reportedCommits, f.metadata);
  assert.notEqual(f.a.metadata.launchHead, git(f.a.root, ['rev-parse', 'HEAD']));
  Object.assign(f.request, { reportedCommits: persisted?.reportedCommits });
  assert.ok(await f.pending());
  assertRepaired(f.a);
});

test(`${prefix} failed with succeeded subset repairs commits but never confirms checkboxes`, async t => {
  const f = acceptance(t);
  f.publish({ ...f.report(), status: 'failed', answer: 'Partial result, second item blocked.', changes: [{ id: 'reported-fixture', items: [{ id: '1.1', status: 'succeeded' }] }] });
  const bytes = readFileSync(f.reportPath, 'utf8');
  const result = await f.pending();
  assert.equal(result?.status, 'failed');
  assert.equal(f.repairs.length, 1, 'failed is not permission to leave its own committed paths stale');
  assertRepaired(f.a);
  assert.deepEqual(f.confirmations, []);
  assert.equal(readFileSync(f.reportPath, 'utf8'), bytes, 'acceptance never rewrites executor JSON');
});

for (const input of ['absent', 'partial JSON', 'wrong assignment', 'empty answer with commits in evidence'] as const) {
  test(`${prefix} ${input} cannot infer commits or start repair`, async t => {
    const f = acceptance(t);
    if (input === 'absent') rmSync(f.reportPath);
    if (input === 'partial JSON') writeFileSync(f.reportPath, '{"status":');
    if (input === 'wrong assignment') f.publish({ ...f.report(), changes: [{ id: 'another-change', items: [{ id: '1.1', status: 'succeeded' }] }] });
    if (input === 'empty answer with commits in evidence') f.publish({ ...f.report(), answer: '', commits: undefined, evidence: [f.a.first, f.a.second] });
    const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
    assert.equal(await f.pending(), null);
    assertNoWrite(f, before);
  });
}

test(`${prefix} foreign staged content on a reported path remains staged`, async t => {
  const f = acceptance(t);
  put(f.a.root, 'repeat.txt', 'foreign staged edit on reported path\n');
  git(f.a.root, ['add', '--', 'repeat.txt']);
  put(f.a.root, 'repeat.txt', 'foreign unstaged edit on same path\n');
  const staged = indexEntries(f.a.root).get('repeat.txt:0');
  const bytes = workingBytes(f.a.root);
  assert.ok(await f.pending());
  assert.equal(f.repairs.length, 1);
  assert.equal(indexEntries(f.a.root).get('repeat.txt:0'), staged);
  assert.deepEqual(workingBytes(f.a.root), bytes);
});

test(`${prefix} first reported parent, rather than launch baseline, controls stale index repair`, async t => {
  const f = acceptance(t);
  git(f.a.root, ['read-tree', f.a.foreign]);
  f.publish({ ...f.report(), commits: [{ repository: f.a.root, sha: f.a.second }] });
  assert.ok(await f.pending());
  assert.equal(git(f.a.root, ['show', ':repeat.txt']), 'later HEAD');
  assert.deepEqual(f.repairs, [{ repositoryRoot: f.a.root, commits: [f.a.second] }]);
});

test(`${prefix} OpenSpec failure never publishes succeeded and does not undo successful repair`, async t => {
  const f = acceptance(t);
  f.setOpenSpec(false);
  const watcher = await f.watcher();
  t.after(() => watcher.dispose());
  await f.notify();
  assert.equal(f.repairs.length > 0, true);
  assertRepaired(f.a);
  assert.equal(f.results.some(result => result.status === 'succeeded'), false);
});

test(`${prefix} second repository I/O failure preserves first repair and retries the complete snapshot`, async t => {
  const f = acceptance(t);
  f.publish({ ...f.report(), commits: [{ repository: f.a.root, sha: f.a.first }, { repository: f.a.root, sha: f.a.second }, { repository: f.b.root, sha: f.b.first }, { repository: f.b.root, sha: f.b.second }] });
  f.failRepository(f.b.root);
  const beforeB = indexEntries(f.b.root);
  assert.equal(await f.pending(), null, 'repair failure leaves the report unaccepted');
  assertRepaired(f.a);
  assert.deepEqual(indexEntries(f.b.root), beforeB);
  assert.equal(f.confirmations.length, 0);
  assert.ok(f.diagnostics.some(reason => reason.includes(f.runId) && reason.includes(f.b.root)), 'diagnostic identifies run and repository');
  f.failRepository(null);
  assert.ok(await f.pending());
  assertRepaired(f.a);
  assertRepaired(f.b);
  assert.equal(git(f.a.root, ['rev-parse', 'HEAD']), f.a.head);
  assert.equal(git(f.b.root, ['rev-parse', 'HEAD']), f.b.head);
});

test(`${prefix} moved HEAD is rechecked at repair and becomes the current target`, async t => {
  const f = acceptance(t);
  let next = '';
  f.beforeRepair(async request => {
    if (next || request.repositoryRoot !== f.a.root) return;
    next = isolatedCommit(f.a.root, f.a.index, { 'repeat.txt': 'HEAD advanced at acceptance\n' }, 'concurrent HEAD');
  });
  assert.ok(await f.pending());
  assert.equal(f.repairs.length, 1);
  assert.equal(git(f.a.root, ['show', ':repeat.txt']), 'HEAD advanced at acceptance');
  assert.equal(git(f.a.root, ['rev-parse', 'HEAD']), next);
});

test(`${prefix} index.lock is preserved until its owner releases it`, async t => {
  const f = acceptance(t);
  const lock = join(f.a.metadata.gitDirectory, 'index.lock');
  writeFileSync(lock, 'owned by another writer\n');
  let observed = false;
  let lockError: unknown;
  const release = setTimeout(() => {
    try {
      assert.equal(readFileSync(lock, 'utf8'), 'owned by another writer\n', 'repair must not delete or replace a foreign lock');
      observed = true;
    } catch (error) { lockError = error; } finally { rmSync(lock, { force: true }); }
  }, 0);
  t.after(() => { clearTimeout(release); rmSync(lock, { force: true }); });
  const result = await f.pending();
  if (lockError) throw lockError;
  assert.equal(observed, true, 'test observed the lock before release');
  assert.ok(result, 'acceptance waits according to the existing index policy');
  assert.equal(f.repairs.length, 1);
  assertRepaired(f.a);
});

test(`${prefix} hostile inherited Git environment cannot select a different index or repository`, async t => {
  const f = acceptance(t);
  const index = join(f.base, 'hostile-index');
  writeFileSync(index, 'foreign index sentinel');
  const names = ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { GIT_INDEX_FILE: index, GIT_DIR: f.b.metadata.gitDirectory, GIT_WORK_TREE: f.b.root, GIT_COMMON_DIR: f.b.metadata.commonDirectory });
  try {
    assert.ok(await f.pending());
    assert.equal(f.repairs.length, 1);
    assertRepaired(f.a);
    assert.equal(readFileSync(index, 'utf8'), 'foreign index sentinel');
    assert.equal(git(f.b.root, ['show', ':repeat.txt']), 'base repeat.txt');
  } finally {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});

test(`${prefix} changed JSON during checkbox is reread without combining snapshots`, async t => {
  const f = acceptance(t);
  const initial = f.report();
  f.duringConfirmation(async () => { f.duringConfirmation(undefined); f.publish({ ...initial, commits: [{ repository: f.a.root, sha: 'HEAD' }] }); });
  const watcher = await f.watcher();
  t.after(() => watcher.dispose());
  await f.notify();
  assert.equal(f.results.some(value => value.status === 'succeeded'), false, 'a previously verified set cannot authorize a replacement JSON');
  assert.ok(f.repairs.length > 0, 'the original valid snapshot reached repair');
});

test(`${prefix} final archive reread repairs appended executor commits and emits once`, async t => {
  const f = acceptance(t);
  const initial = f.report();
  f.setAwaitingArchive(true);
  const watcher = await f.watcher();
  t.after(() => watcher.dispose());
  await f.notify();
  assert.equal(f.results.length, 0, 'last task awaits the exact archive');
  assertRepaired(f.a);
  const archive = '2026-10-23-reported-fixture';
  const final = isolatedCommit(f.a.root, f.a.index, { [`openspec/changes/archive/${archive}/tasks.md`]: '- [x] 1.1 assigned\n', 'final-evidence.txt': 'archive complete\n' }, 'executor final archive');
  const previous = initial.commits as ReportedCommit[];
  f.setAwaitingArchive(false);
  f.publish({ ...initial, changes: [{ id: 'reported-fixture', archive, items: [{ id: '1.1', status: 'succeeded' }] }], commits: [...previous, { repository: f.a.root, sha: final }] });
  const exactBytes = readFileSync(f.reportPath, 'utf8');
  await f.notify();
  await f.notify();
  assert.equal(git(f.a.root, ['show', ':final-evidence.txt']), 'archive complete');
  assert.ok(f.repairs.some(request => request.commits.includes(final)), 'the final reread must repair final executor SHA');
  assert.equal(f.results.length, 1, 'one watcher result after final acceptance');
  assert.equal(f.results[0].report?.changes[0].archive, archive);
  assert.equal(readFileSync(f.reportPath, 'utf8'), exactBytes);
  const acceptedHead = git(f.a.root, ['rev-parse', 'HEAD']);
  f.publish({ ...f.report(), commits: [] });
  await f.notify();
  assert.equal(f.results.length, 1, 'accepted result cannot be reopened by late JSON');
  assert.equal(git(f.a.root, ['rev-parse', 'HEAD']), acceptedHead);
});

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
  git(f.root, ['init', '--quiet', '--initial-branch=main']);
  git(f.root, ['add', '--', 'openspec', 'questions']);
  git(f.root, ['commit', '--quiet', '-m', 'orchestrator baseline']);
  put(f.cwd, 'code-seed.txt', 'code baseline\n');
  git(f.cwd, ['add', '--', 'code-seed.txt']);
  git(f.cwd, ['commit', '--quiet', '-m', 'code baseline']);
  const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const task = await services.resolveTask(f.params, f.assignment);
  assertCommitSchema(task.reportSchema);
  const realBriefs = resolve(import.meta.dirname, '../../conf/briefs');
  for (const runner of ['codex', 'claude', 'grok', 'agy']) {
    const brief = await services.assignment.compose(f.assignment, {
      cwd: f.cwd, briefsRoot: realBriefs, runner, stage: 'implement', project: 'raf', agentId: f.params.id, sessionName: f.params.id,
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
    git(root, ['add', '--', `openspec/changes/${change}/.openspec.yaml`]);
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
  put(root, 'foreign.txt', 'foreign staged bytes\n');
  git(root, ['add', '--', 'foreign.txt']);
  put(root, 'foreign.txt', 'foreign unstaged bytes\n');
  put(code, 'untracked.txt', 'untracked code bytes\n');
  const foreignEntry = indexEntries(root).get('foreign.txt:0');
  const commits: ReportedCommit[] = [{ repository: root, sha: r1 }, { repository: code, sha: c1 }, { repository: root, sha: r2 }, { repository: code, sha: c2 }];
  const report = { status: 'succeeded', answer: 'Verified fixture only.', changes: [{ id: change, items: [{ id: '1.1', status: 'succeeded' }] }], commits };
  const publish = (value: unknown = report) => { writeFileSync(reportPath + '.next', JSON.stringify(value)); renameSync(reportPath + '.next', reportPath); };
  const ps = async () => {
    const listed = await f.command(['agent', 'ps']);
    assert.equal(listed.exitCode, 0, JSON.stringify(listed));
    return (JSON.parse(listed.result.stdout) as SessionRecord[]).find(row => row.runId === runId);
  };
  const statePath = join(f.directory, 'home/.raf/state.sqlite');
  const mutate = (operation: (record: SessionRecord) => SessionRecord) => {
    const store = openStateStore(statePath);
    try { store.sessionRepository.transaction(tx => { const record = tx.getSession(runId); assert.ok(record); tx.putSession(operation(record)); }); }
    finally { store.close(); }
  };
  return { ...f, root, code, taskPath, rootBaseline, codeBaseline, address, runId, session, wrapper, reportPath, commits, report, publish, ps, mutate, indexRoot, foreignEntry };
}

for (const path of ['worker', 'reconciliation'] as const) {
  test(`${prefix} production ${path}: two repositories repair before checkbox, durable result and event are idempotent`, async t => {
    const f = await production(t, path);
    const succeededReminder = `succeeded-${path}`;
    f.seedReminder({ id: succeededReminder, createdFor: 'main', assignedTo: 'main', text: 'accept once', at: '2099-01-01T00:00:00.000Z', binding: { kind: 'agent.succeeded', id: f.address, action: 'activate' }, state: 'pending', closedAt: null, closeReason: null });
    const durable = f.session()?.launchContext as (SessionLaunchContext & ReportedCommitRequestContext) | undefined;
    assert.equal(durable?.reportedCommits?.contract, 'reported-commits-v1', 'new launches persist their trusted commit contract before the runner starts');
    const repos = durable.reportedCommits.repositories;
    assert.equal(repos.find(row => row.repositoryRoot === f.root)?.launchHead, f.rootBaseline);
    assert.equal(repos.find(row => row.repositoryRoot === f.code)?.launchHead, f.codeBaseline);
    f.publish();
    const accepted = path === 'worker'
      ? await until(f.session, row => row?.result?.status === 'succeeded', 'worker accepted verified commits')
      : await f.ps();
    assert.equal(accepted?.result?.status, 'succeeded');
    assert.equal(accepted?.reportAcceptance?.runId, f.runId);
    for (const name of ['code-first.txt', 'code-second.txt']) assert.equal(git(f.code, ['show', `:${name}`]), git(f.code, ['show', `HEAD:${name}`]));
    for (const name of ['own-first.txt', 'own-second.txt', f.taskPath]) assert.equal(git(f.root, ['show', `:${name}`]), git(f.root, ['show', `HEAD:${name}`]));
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

for (const path of ['worker', 'reconciliation'] as const) {
  test(`${prefix} production ${path}: failed repairs owned commits with no checkbox or succeeded event`, async t => {
    const f = await production(t, path);
    const head = git(f.root, ['rev-parse', 'HEAD']);
    f.publish({ ...f.report, status: 'failed', answer: 'Partial fixture result.', changes: [{ id: change, items: [{ id: '1.1', status: 'succeeded' }] }] });
    const accepted = path === 'worker' ? await until(f.session, row => row?.result?.status === 'failed', 'worker accepts failed report') : await f.ps();
    assert.equal(accepted?.result?.status, 'failed');
    assert.equal(git(f.root, ['show', ':own-first.txt']), 'first root result');
    assert.equal(git(f.code, ['show', ':code-second.txt']), 'second code result');
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), head, 'failed cannot make a checkbox commit');
    assert.match(git(f.root, ['show', `HEAD:${f.taskPath}`]), /\[ \] 1\.1/);
    assert.equal(accepted?.reportAcceptance?.event, 'agent.failed');
  });
}

for (const skipSpecs of [false, true]) {
  test(`${prefix} production final archive skip_specs=${skipSpecs}: final reread repairs appended archive commit`, async t => {
    const f = await production(t, 'reconciliation', { last: true, skipSpecs });
    f.publish();
    const provisional = await f.ps();
    assert.equal(provisional?.result, undefined, 'last item remains provisional without archive');
    assert.match(git(f.root, ['show', `HEAD:${f.taskPath}`]), /\[x\] 1\.1/);
    assert.equal(git(f.code, ['show', ':code-first.txt']), 'first code result', 'provisional acceptance already repaired executor commits');
    const archiveResult = spawnSync('openspec', ['archive', change, '--yes', ...(skipSpecs ? ['--skip-specs'] : [])], { cwd: f.root, env: { ...gitEnv(), HOME: join(f.directory, 'home') }, encoding: 'utf8' });
    assert.equal(archiveResult.status, 0, `archive fixture setup: ${archiveResult.stderr}\n${archiveResult.stdout}`);
    const archivesRoot = join(f.root, 'openspec/changes/archive');
    const archives = readdirSync(archivesRoot).filter(name => name.endsWith(`-${change}`));
    assert.equal(archives.length, 1);
    const archive = archives[0];
    rmSync(f.indexRoot, { force: true });
    git(f.root, ['read-tree', 'HEAD'], { index: f.indexRoot });
    git(f.root, ['add', '-A', '--', 'openspec'], { index: f.indexRoot });
    git(f.root, ['commit', '--quiet', '-m', 'executor sync and archive'], { index: f.indexRoot });
    const final = git(f.root, ['rev-parse', 'HEAD']);
    f.publish({ ...f.report, changes: [{ id: change, archive, items: [{ id: '1.1', status: 'succeeded' }] }], commits: [...f.commits, { repository: f.root, sha: final }] });
    const accepted = await f.ps();
    assert.equal(accepted?.result?.status, 'succeeded');
    const archiveTask = `openspec/changes/archive/${archive}/tasks.md`;
    assert.equal(git(f.root, ['show', `:${archiveTask}`]), git(f.root, ['show', `HEAD:${archiveTask}`]));
    assert.equal(indexEntries(f.root).has(`${f.taskPath}:0`), false, 'stale active tasks entry is removed');
    const head = git(f.root, ['rev-parse', 'HEAD']);
    await f.ps();
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), head);
    const metadata = f.session()?.launchContext as (SessionLaunchContext & ReportedCommitRequestContext) | undefined;
    assert.equal(metadata?.reportedCommits?.repositories.find(row => row.repositoryRoot === f.root)?.launchHead, f.rootBaseline);
  });
}

test(`${prefix} known checkbox SHA cannot be claimed as executor work`, async t => {
  const f = acceptance(t);
  f.setCheckboxShas([f.a.second]);
  const before = [indexEntries(f.a.root), indexEntries(f.b.root)];
  assert.equal(await f.pending(), null);
  assertNoWrite(f, before);
});

test(`${prefix} checkbox proof and answer never supply missing executor commits`, async t => {
  const f = acceptance(t);
  f.setCheckboxShas([f.a.second]);
  f.publish({ ...f.report(), commits: [], answer: `SHA ${f.a.first}`, checkboxCommits: [{ change: 'reported-fixture', item: '1.1', sha: f.a.second }], executorCommits: [f.a.first] });
  const before = indexEntries(f.a.root);
  assert.ok(await f.pending());
  assert.equal(f.repairs.length, 0);
  assert.deepEqual(indexEntries(f.a.root), before);
});

test(`${prefix} HEAD rewritten between validation and repair refuses acceptance`, async t => {
  const f = acceptance(t);
  f.beforeRepair(async () => { git(f.a.root, ['update-ref', 'HEAD', f.a.baseline]); });
  assert.equal(await f.pending(), null, 'ancestry must still hold at application time');
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.results.length, 0);
  assert.equal(git(f.a.root, ['rev-parse', 'HEAD']), f.a.baseline, 'repair cannot restore an old ref over a concurrent writer');
});

for (const phase of ['after repair', 'after checkbox'] as const) {
  test(`${prefix} watcher restart ${phase} keeps repair and emits one result without new Git commits`, async t => {
    const f = acceptance(t);
    f.setAwaitingArchive(true);
    const first = await f.watcher();
    await f.notify();
    assertRepaired(f.a);
    assert.equal(f.results.length, 0);
    const repaired = indexEntries(f.a.root);
    if (phase === 'after checkbox') f.setCheckboxShas([f.a.foreign]);
    await first.dispose();
    const head = git(f.a.root, ['rev-parse', 'HEAD']);
    f.setAwaitingArchive(false);
    const recovered = await f.watcher();
    t.after(() => recovered.dispose());
    await f.notify();
    await f.notify();
    assert.equal(f.results.length, 1);
    assert.deepEqual(indexEntries(f.a.root), repaired);
    assert.equal(git(f.a.root, ['rev-parse', 'HEAD']), head);
    assert.equal(f.request.reportedCommits?.repositories[0].launchHead, f.a.baseline);
  });
}

for (const mutation of ['lost launch metadata', 'stale reportPath', 'changed assignment source', 'read-only code scope'] as const) {
  test(`${prefix} production reconciliation refuses ${mutation} before repair`, async t => {
    const f = await production(t, 'reconciliation', { stage: mutation === 'read-only code scope' ? 'spec' : undefined });
    if (mutation === 'lost launch metadata') f.mutate(record => { const context = { ...record.launchContext } as SessionLaunchContext & ReportedCommitRequestContext; delete (context as { reportedCommits?: unknown }).reportedCommits; return { ...record, launchContext: context }; });
    if (mutation === 'stale reportPath') {
      f.publish();
      f.mutate(record => ({ ...record, launchContext: { ...record.launchContext!, reportPath: join(f.tmpRoot, 'stale-run', `${f.address}.json`) } }));
    }
    if (mutation === 'changed assignment source') put(f.root, f.taskPath, readFileSync(join(f.root, f.taskPath), 'utf8').replace('Write launch failure fixture', 'Changed assignment meaning'));
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
