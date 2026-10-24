import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createAgentReportWatcher, type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult, type AgentReportWatcher } from '../src/agent-report.ts';
import { createAssignmentIdentityAdapter } from '../src/assignment-identity.ts';
import { validateAssignment, verifyAssignmentCompletion, type AssignmentPorts, type AssignmentVerification } from '../src/assignment.ts';
import { reconcileReportedCommitIndex } from '../src/report-commit-index.ts';
import { captureReportedCommitLaunchContext } from '../src/reported-commits.ts';
import { prepareReportedTaskCheckboxes, type TaskCheckboxOperation } from '../src/task-checkbox-report.ts';
import { type ConfirmationBudget, type PendingConfirmation } from '../src/report-confirmation-retry.ts';
import { type ProtocolSettings } from '../src/runner-protocols.ts';

const realSetTimeout = globalThis.setTimeout;
const openSpecSubprocessMs = 310;
const change = 'confirmation-progress-fixture';
const description = 'Confirm the immutable report';
const originalTasks = `- [ ] 1.1 ${description}\n- [ ] 1.2 Another executor remains open\n`;
const waitForIo = () => new Promise<void>(resolve => realSetTimeout(resolve, 5));

type Harness = Awaited<ReturnType<typeof setup>>;
let setupRoot: string | undefined;

async function setup() {
    const configurationPath = new URL('../../conf/raf.json', import.meta.url);
    const configurationBytes = await readFile(configurationPath, 'utf8');
    const protocol = JSON.parse(configurationBytes).runnerProtocols.find((entry: ProtocolSettings) => entry.runner === 'codex') as ProtocolSettings;
    assert.ok(protocol);
    assert.ok(Number.isFinite(protocol.timeouts.transitionMs) && protocol.timeouts.transitionMs > 0);
    assert.ok(Number.isFinite(protocol.timeouts.pollMs) && protocol.timeouts.pollMs > 0);
    const root = await mkdtemp(join(tmpdir(), 'raf-z393-progress-'));
    setupRoot = root;
    const tasksPath = join(root, 'openspec', 'changes', change, 'tasks.md');
    const packageSchema = JSON.parse(execFileSync('openspec', ['schema', 'which', 'spec-driven', '--json'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const runId = randomUUID();
    const address = 'z393-progress';
    const tmpRoot = join(root, 'runs', runId);
    let reportPath = join(tmpRoot, `${address}.json`);
    const git = (args: readonly string[], environment: Readonly<Record<string, string>> = {}) => execFileSync('git', [...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    try {
        await mkdir(dirname(tasksPath), { recursive: true });
        await mkdir(tmpRoot, { recursive: true });
        await writeFile(tasksPath, originalTasks);
        await writeFile(join(dirname(tasksPath), 'proposal.md'), '## Why\nIsolated confirmation fixture.\n');
        await writeFile(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
        git(['init', '-q', '-b', 'main']);
        git(['config', 'user.name', 'Confirmation fixture']);
        git(['config', 'user.email', 'confirmation@example.invalid']);
        git(['config', 'commit.gpgsign', 'false']);
        git(['config', 'core.hooksPath', '/dev/null']);
        git(['add', 'openspec']);
        git(['commit', '-qm', 'Launch assignment']);
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
    let chargeCost = false;
    const openSpecCalls: { args: readonly string[]; at: number; cost: number }[] = [];
    const openSpec = async (args: readonly string[]) => {
        const cost = chargeCost ? openSpecSubprocessMs : 0;
        openSpecCalls.push({ args: [...args], at: chargeCost ? performance.now() : 0, cost });
        if (cost) mock.timers.tick(cost);
        if (args.length === 1 && args[0] === '--version') return { exitCode: 0, stdout: '1.14.3\n', stderr: '' };
        if (args[0] === 'schema' && args[1] === 'which' && args[2] === 'spec-driven' && args.includes('--json')) return {
            exitCode: 0,
            stdout: JSON.stringify({ name: 'spec-driven', source: 'package', path: packageSchema.path, shadows: [] }),
            stderr: '',
        };
        if (args.includes('list') && args.includes('--archived')) return { exitCode: 0, stdout: JSON.stringify({ changes: [], root }), stderr: '' };
        const text = await readFile(tasksPath, 'utf8');
        const tasks = [...text.matchAll(/^- \[([ x])\] (.+)$/gm)].map((match, index) => ({
            id: String(index + 1),
            description: match[2],
            done: match[1] === 'x',
            sourcePath: tasksPath,
            line: index + 1,
        }));
        if (args.includes('list')) return {
            exitCode: 0,
            stdout: JSON.stringify({
                root,
                changes: [{
                    name: change,
                    completedTasks: tasks.filter(task => task.done).length,
                    totalTasks: tasks.length,
                    lastModified: (await stat(tasksPath)).mtime.toISOString(),
                    status: tasks.every(task => task.done) ? 'complete' : 'in-progress',
                }],
            }),
            stderr: '',
        };
        assert.ok(args.includes('instructions') && args.includes('apply'), 'Unexpected OpenSpec fixture request');
        return {
            exitCode: 0,
            stdout: JSON.stringify({
                changeName: change,
                changeDir: dirname(tasksPath),
                schemaName: 'spec-driven',
                tasks,
                progress: { total: tasks.length, complete: tasks.filter(task => task.done).length, remaining: tasks.filter(task => !task.done).length },
                state: 'ready',
                taskTrackingConfigured: true,
            }),
            stderr: '',
        };
    };
    const assignmentPorts: AssignmentPorts = { cli: { exec: args => openSpec(args) }, fs: { readText: path => readFile(path, 'utf8') } };
    const validation = await validateAssignment({ root, selections: [{ change, items: [{ id: '1.1' }] }] }, assignmentPorts);
    assert.equal(validation.ok, true, 'Fixture must have a valid launch assignment before exercising confirmation');
    if (!validation.ok) throw new Error('Invalid fixture assignment');
    const assignment = validation.snapshot;
    const identity = createAssignmentIdentityAdapter({ raf: root }, {
        execute: async command => {
            if (command.executable === 'git') return { exitCode: 0, stdout: git(command.args, command.environment as Record<string, string>), stderr: '' };
            return openSpec(command.args);
        },
    });
    const launchTasks = await identity.capture('raf', assignment);
    assert.equal(launchTasks.length, 1, 'Fixture must capture one immutable task identity');
    const reportedCommits = { ...await captureReportedCommitLaunchContext(runId, reportPath, [root], [root]) };
    await writeFile(join(root, 'executor-result.txt'), 'Completed fixture work\n');
    git(['add', 'executor-result.txt']);
    git(['commit', '-qm', 'Executor result']);
    const executorHead = git(['rev-parse', 'HEAD']);
    const request: AgentReportRequest = { runId, address, tmpRoot, assignment, reportedCommits };
    const report: AgentReport = { status: 'succeeded', answer: 'Fixture work complete', commits: [{ repository: root, sha: executorHead }], changes: [{ id: change, items: [{ id: '1.1', status: 'succeeded' }] }] };
    const reportBytes = JSON.stringify(report);
    let operations: readonly TaskCheckboxOperation[] = [];
    const journals: (readonly TaskCheckboxOperation[])[] = [];
    const pending: PendingConfirmation[] = [];
    const results: AgentReportResult[] = [];
    const accepted: AgentReportResult[] = [];
    const rejections: string[] = [];
    const checkpoints: { phase: string; at: number; deadline: number }[] = [];
    const sourceChecks: number[] = [];
    const checkboxBudgets: ConfirmationBudget[] = [];
    const repairChecks: number[] = [];
    let listener: Parameters<AgentReportPorts['watch']>[1] | undefined;
    let fileEvents = 0;
    let busy = true;
    let busyResponses = 0;
    let mode: 'release-on-busy' | 'release-on-exhaustion' | 'mismatch-on-exhaustion' = 'release-on-busy';
    let watcher: AgentReportWatcher | undefined;
    let initialEvent: Promise<void> | undefined;
    let initialEventError: unknown;
    const verifySource = async (): Promise<AssignmentVerification> => {
        sourceChecks.push(performance.now());
        const resolutions = await identity.resolveTasks(launchTasks);
        return {
            ok: resolutions.every(resolution => resolution.state === 'open' || resolution.state === 'completed'),
            issues: resolutions.flatMap(resolution => resolution.state === 'mismatch' || resolution.state === 'unknown' ? [{
                change,
                requestedItems: ['1.1'],
                reason: resolution.reason,
                foundItems: [],
                archives: [],
                remedy: 'Restore the original immutable assignment',
            }] : []),
        };
    };
    const ports: AgentReportPorts = {
        fs: {
            mkdir: path => mkdir(path, { recursive: true }).then(() => undefined),
            readText: path => readFile(path, 'utf8').catch((error: { code?: string }) => { if (error.code === 'ENOENT') return null; throw error; }),
            readBytes: path => readFile(path).catch((error: { code?: string }) => { if (error.code === 'ENOENT') return null; throw error; }),
            removeTree: path => rm(path, { recursive: true, force: true }),
        },
        watch: (_directory, callback) => { listener = callback; return () => { listener = undefined; }; },
        process: { onExit: () => () => undefined },
        now: () => new Date().toISOString(),
        confirmationRetry: {
            runner: 'codex',
            protocol: async () => structuredClone(protocol),
            retainPending: async diagnostic => {
                if (!diagnostic) return;
                pending.push(structuredClone(diagnostic));
                if (mode !== 'release-on-busy') {
                    busy = false;
                    chargeCost = true;
                    if (mode === 'mismatch-on-exhaustion') await writeFile(tasksPath, originalTasks.replace(description, 'A different assignment'));
                }
            },
        },
        isCurrentReport: async currentRunId => currentRunId === runId && accepted.length === 0,
        verifyAssignmentSourceIdentity: verifySource,
        verifyAssignmentCompletion: (snapshot, claims) => verifyAssignmentCompletion(snapshot, assignmentPorts, claims),
        reconcileReportedCommitIndex: async (repair, budget, beforeWrite) => {
            repairChecks.push(performance.now());
            await reconcileReportedCommitIndex(repair, budget ? { deadline: budget.deadline, pollMs: protocol.timeouts.pollMs, beforeWrite } : undefined);
        },
        readTaskCheckboxCommits: async () => operations.flatMap(operation => operation.sha ? [{ change: operation.change, item: operation.item, sha: operation.sha }] : []),
        confirmTaskCheckboxes: async (currentRequest, currentReport, _verified, budget, beforeWrite) => {
            if (!budget) throw new Error('Checkbox writer must receive the shared cycle deadline');
            checkboxBudgets.push({ ...budget });
            if (busy) {
                busyResponses += 1;
                if (mode === 'release-on-busy') {
                    busy = false;
                    chargeCost = true;
                }
                return { ok: false, issues: [], commits: [], awaitingArchive: false, transient: 'writer-busy' };
            }
            return prepareReportedTaskCheckboxes(currentRequest, currentReport, {
                budget,
                beforeWrite,
                verifySourceIdentity: verifySource,
                verifyAssignmentCompletion: (snapshot, claims) => verifyAssignmentCompletion(snapshot, assignmentPorts, claims),
                operations: {
                    read: async id => { assert.equal(id, runId); return structuredClone(operations); },
                    write: async (id, next) => { assert.equal(id, runId); operations = structuredClone(next); journals.push(structuredClone(next)); },
                },
                checkpoint: async phase => { checkpoints.push({ phase, at: performance.now(), deadline: budget.deadline }); },
            });
        },
        acceptResult: async result => { accepted.push(result); },
        result: async result => { results.push(result); },
        diagnostic: async (_reason, rejection) => { if (rejection) rejections.push(rejection.reason); },
    };
    mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    mock.method(performance, 'now', () => Date.now());
    openSpecCalls.length = 0;
    const advanceUntil = async (condition: () => boolean, deadline: number) => {
        while (!condition() && performance.now() < deadline) {
            await waitForIo();
            if (condition()) break;
            mock.timers.tick(Math.min(protocol.timeouts.pollMs, deadline - performance.now()));
        }
        await waitForIo();
        if (initialEventError) throw initialEventError;
    };
    return {
        root, protocol, get reportPath() { return reportPath; }, tasksPath, reportBytes, runId, executorHead,
        pending, results, accepted, rejections, journals, checkpoints, sourceChecks, checkboxBudgets, repairChecks, openSpecCalls,
        busyCount: () => busyResponses,
        journal: () => operations,
        fileEvents: () => fileEvents,
        git,
        async start(selectedMode: typeof mode) {
            mode = selectedMode;
            if (mode !== 'release-on-busy') operations = [{ runId, change, item: '1.1', originalLine: originalTasks.split('\n')[0], parent: executorHead, phase: 'prepared' }];
            watcher = await createAgentReportWatcher(request, ports);
            reportPath = watcher.path;
            reportedCommits.reportPath = reportPath;
            await writeFile(reportPath, reportBytes);
            const initial = await stat(reportPath, { bigint: true });
            if (!listener) throw new Error('Fixture must have exactly one initial file event available');
            fileEvents += 1;
            initialEvent = listener('rename', `${address}.json`).catch(error => { initialEventError = error; });
            return initial;
        },
        advanceUntil,
        async assertReportUnchanged(initial: BigIntStats) {
            const current = await stat(reportPath, { bigint: true });
            assert.equal(createHash('sha256').update(await readFile(reportPath)).digest('hex'), createHash('sha256').update(reportBytes).digest('hex'));
            assert.equal(current.ino, initial.ino);
            assert.equal(current.mtimeNs, initial.mtimeNs);
            assert.equal(fileEvents, 1, 'Automatic confirmation must not require another fs event');
            assert.equal(await readFile(configurationPath, 'utf8'), configurationBytes, 'Production budgets must remain unchanged');
        },
        async assertAccepted() {
            assert.equal(accepted.length, 1, 'Released writer must allow durable acceptance within the unchanged budget');
            assert.equal(results.length, 1, 'Watcher must finish the same report automatically');
            assert.equal(results[0].event, 'agent.succeeded');
            assert.equal(results[0].runId, runId);
            assert.equal(rejections.length, 0, 'Transient contention must not emit report-rejected');
            assert.ok(operations.length > 0 && operations.every(operation => operation.phase === 'verified'), 'Journal must advance beyond prepared');
            assert.equal(git(['rev-list', '--count', `${executorHead}..HEAD`]), '1', 'Exactly one checkbox commit is permitted');
            const relativeTasks = `openspec/changes/${change}/tasks.md`;
            assert.equal(git(['diff', '--name-only', `${executorHead}..HEAD`]), relativeTasks, 'Checkbox commit must contain only the assigned task file');
            assert.equal(git(['show', `HEAD:${relativeTasks}`]), originalTasks.replace('- [ ] 1.1', '- [x] 1.1').trim(), 'Only the assigned checkbox marker may change');
            assert.equal(git(['status', '--porcelain', '--', relativeTasks]), '', 'Checkbox commit must leave no reverse staged marker');
            assert.ok(openSpecCalls.some(call => call.cost === openSpecSubprocessMs), 'The successful cycle must include measured OpenSpec subprocess cost');
            assert.ok(repairChecks.length > 0 && sourceChecks.length > 0, 'Commit repair and source identity checks must remain enabled');
            for (const checkpoint of checkpoints.filter(entry => entry.phase === 'before-write' || entry.phase === 'before-ref-update')) assert.ok(checkpoint.at < checkpoint.deadline, 'A completed cycle cannot write after its deadline');
        },
        async dispose() {
            let disposed = watcher === undefined;
            const stopped = watcher?.dispose().finally(() => { disposed = true; });
            await advanceUntil(() => disposed, performance.now() + protocol.timeouts.transitionMs + protocol.timeouts.pollMs);
            if (stopped) await stopped;
            if (initialEvent) await initialEvent;
            mock.timers.reset();
            mock.restoreAll();
            await rm(root, { recursive: true, force: true });
        },
    };
}

describe('Z393-QA-1 confirmation progress with measured OpenSpec cost', { concurrency: false }, () => {
    let harness: Harness | undefined;
    beforeEach(async () => { harness = await setup(); });
    afterEach(async () => {
        try { await harness?.dispose(); }
        finally {
            mock.timers.reset();
            mock.restoreAll();
            if (setupRoot) await rm(setupRoot, { recursive: true, force: true });
            setupRoot = undefined;
        }
        harness = undefined;
    });

    it('automatically accepts unchanged JSON after writer release inside the configured transition budget', async () => {
        const h = harness!;
        const initial = await h.start('release-on-busy');
        await h.advanceUntil(() => h.accepted.length > 0, h.protocol.timeouts.transitionMs);
        assert.ok(h.busyCount() > 0, 'The initial known writer contention must actually be exercised');
        await h.assertAccepted();
        assert.equal(h.pending.length, 0, 'Release early in the cycle must permit progress without exhaustion');
        await h.assertReportUnchanged(initial);
    });

    it('the next automatic cycle completes a prepared journal after the first budget is exhausted', async () => {
        const h = harness!;
        const initial = await h.start('release-on-exhaustion');
        await h.advanceUntil(() => h.accepted.length > 0, h.protocol.timeouts.transitionMs * 2 + h.protocol.timeouts.pollMs);
        assert.ok(h.pending.length > 0, 'The first cycle must exhaust its shared transition budget');
        assert.equal(h.pending[0].runId, h.runId);
        assert.equal(h.pending[0].candidateBytes, h.reportBytes);
        assert.equal(h.pending[0].exhausted, true);
        assert.equal(h.pending[0].cause, 'writer-busy');
        assert.ok(h.checkboxBudgets.some(budget => budget.deadline > h.pending[0].deadline), 'The next automatic pass must have a fresh cycle budget');
        await h.assertAccepted();
        await h.assertReportUnchanged(initial);
    });

    it('a stable assignment mismatch after exhaustion cannot be accepted using an earlier source check', async () => {
        const h = harness!;
        const initial = await h.start('mismatch-on-exhaustion');
        await h.advanceUntil(() => h.rejections.length > 0, h.protocol.timeouts.transitionMs * 2 + h.protocol.timeouts.pollMs);
        assert.ok(h.pending.length > 0, 'Mismatch control follows an exhausted pending cycle');
        assert.equal(h.accepted.length, 0, 'A fresh source mismatch must prevent durable acceptance');
        assert.equal(h.results.length, 0);
        assert.ok(h.rejections.some(reason => reason.includes(change) && reason.includes('1.1')), 'The stable mismatch must retain the ordinary addressable rejection');
        assert.equal(h.git(['rev-parse', 'HEAD']), h.executorHead, 'Mismatch must not produce a checkbox commit');
        assert.ok(h.journal().every(operation => operation.phase === 'prepared'), 'Prior prepared provenance must not be promoted after mismatch');
        await h.assertReportUnchanged(initial);
    });
});
