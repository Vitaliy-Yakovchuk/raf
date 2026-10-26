import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { composeAssignmentBrief } from '../src/assignment.ts';
import { runSandboxTestCommand, sandboxRafCommandAccess } from '../src/sandbox-test-run.ts';
import type { SandboxCommandReply, SandboxTestAssignment, SandboxTestControlSnapshot, SandboxTestRunPorts } from '../src/sandbox-test-run.ts';
import type { SandboxCallerSnapshot } from '../src/sandbox-test-caller.ts';
import { rafSubcommandsFor } from '../src/task-context.ts';
import { runTestRunCli } from '../src/test-run-cli.ts';
import { validateTestRunConfig } from '../src/test-runs.ts';
import type { TestRunGroupKey, TestRunResult } from '../src/test-runs.ts';
import { alpha, beta, files, key, policy, RunHarness } from './helpers/test-run-fixture.ts';

const group = 'add-raf-test-run/author-red';
const entrypoint = ['node', '/trusted/raf-main/bin/raf.ts'];
const caller = { pid: 301, startedAt: '2026-10-24T00:00:01.000Z' };
const worker = { pid: 303, startedAt: '2026-10-24T00:00:03.000Z' };
const machine = { machineId: 'fixture-machine', bootId: 'fixture-boot' };

function fixture(phase: string, type = phase) {
  const h = new RunHarness();
  h.config.projects.raf.groups[group] = h.config.projects.raf.groups[key.group];
  const assignment: SandboxTestAssignment = Object.freeze({
    runId: 'live-author-run', agentId: 'author', type, phase, project: 'raf',
    workspace: key.workspace, branch: 'develop', changes: Object.freeze(['add-raf-test-run']),
  });
  const evidence: SandboxCallerSnapshot = {
    caller, ...machine,
    ancestors: [
      { ...caller, ...machine, parentPid: 302, originVerified: true },
      { pid: 302, startedAt: '2026-10-24T00:00:02.000Z', ...machine, parentPid: worker.pid, originVerified: true },
      { ...worker, ...machine, parentPid: 1, originVerified: true },
    ],
    claims: [{ process: { ...worker, ...machine }, state: 'running', runId: assignment.runId, assignment }],
  };
  const snapshot: SandboxTestControlSnapshot = {
    callerEvidence: evidence, ancestors: evidence.ancestors,
    sessions: [{ process: worker, state: 'running', assignment }],
    workspaces: [{ project: 'raf', workspace: key.workspace, branch: 'develop' }],
    activeChanges: ['add-raf-test-run'], groups: [{ ...key, group }], config: h.config,
  };
  const selectedKeys: TestRunGroupKey[] = [];
  const ports: SandboxTestRunPorts = {
    caller, entrypoint, control: async () => snapshot,
    unitContext: async (selectedKey, trustedAssignment) => {
      selectedKeys.push(structuredClone(selectedKey));
      assert.equal(trustedAssignment.runId, assignment.runId);
      return { config: h.config, policy, context: h.context, runtime: h.ports };
    },
    wrapper: async (request, context) => {
      let stdout = '', stderr = '';
      const argv = ['--project', request.project, '--phase', request.phase, '--group', request.group];
      if (request.files) argv.push('--files', ...request.files);
      const code = await runTestRunCli(argv, { ...context, stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
      return { code, stdout, stderr };
    },
    communicate: async () => { throw new Error('Test execution must not be replaced by agent communication'); },
  };
  const command = (requestedPhase: string, selection = `--files ${files[0]} ${files[1]}`, requestedGroup = group) =>
    `${entrypoint.join(' ')} test run --project raf --phase ${requestedPhase} --group ${requestedGroup}${selection ? ` ${selection}` : ''}`;
  const run = (requestedPhase: string, selection?: string, requestedGroup?: string) =>
    runSandboxTestCommand({ command: command(requestedPhase, selection, requestedGroup), cwd: key.workspace }, ports);
  return { h, assignment, evidence, snapshot, selectedKeys, command, run };
}

function result(reply: SandboxCommandReply, callerPhase: string, phase: string): TestRunResult {
  assert.ok(reply.stdout.trim(), `Host channel must return full TestRunResult: ${reply.stderr}`);
  const value: TestRunResult = JSON.parse(reply.stdout);
  for (const field of [
    'runId', 'project', 'workspace', 'phase', 'callerPhase', 'group', 'profileId', 'testKind', 'timeoutPolicy',
    'selection', 'command', 'startedAt', 'durationMs', 'exitCode', 'signal', 'timedOut', 'cleanup',
    'outcome', 'failureKinds', 'passed', 'knownRed', 'unexecuted', 'unknown', 'removed',
    'diagnostics', 'diagnosticSummary', 'environmentSummary', 'stateAccess', 'groupSnapshot',
    'timeoutCount', 'groupState', 'nextAction', 'hintIds', 'hints',
  ]) assert.ok(Object.hasOwn(value, field), `Missing TestRunResult.${field}`);
  assert.equal(value.callerPhase, callerPhase);
  assert.equal(value.phase, phase);
  assert.equal(value.project, 'raf');
  assert.equal(value.workspace, key.workspace);
  assert.equal(value.group, group);
  assert.equal(value.testKind, 'unit');
  assert.deepEqual(value.timeoutPolicy, { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: policy.timeoutMs });
  assert.deepEqual(value.selection.files, files.slice(0, 2));
  assert.deepEqual(value.cleanup, { complete: true, remainingPids: [] });
  assert.equal(value.timedOut, false);
  assert.equal(value.stateAccess, null);
  assert.equal(value.groupSnapshot, 'loaded');
  assert.deepEqual(value.unknown, []);
  return value;
}

async function denied(f: ReturnType<typeof fixture>, phase: string, selection?: string, requestedGroup?: string): Promise<void> {
  const before = structuredClone([...f.h.state.records]);
  const reply = await f.run(phase, selection, requestedGroup);
  assert.notEqual(reply.code, 0);
  assert.match(reply.stderr, /CALLER_UNAUTHORIZED/);
  assert.deepEqual(f.selectedKeys, [], 'Authorization must precede opening QA context');
  assert.equal(f.h.preflightCalls, 0);
  assert.equal(f.h.state.transactionCount, 0);
  assert.equal(f.h.reconcileCalls, 0);
  assert.deepEqual(f.h.spawns, []);
  assert.deepEqual([...f.h.state.records], before);
}

test('AR01 disabled test-scaffold phase and initial-red policy remain a valid configuration', () => {
  const { h } = fixture('test-scaffold');
  assert.equal(h.config.phases['test-scaffold'].allowed, false);
  assert.equal(h.config.phases.red.purpose, 'initial-red');
  assert.doesNotThrow(() => validateTestRunConfig(h.config, h.context.agentPhases, policy));
});

for (const phase of ['test-scaffold', 'qa', 'hotfix']) {
  for (const type of [phase, 'agent']) {
    for (const selection of ['', `--files ${files[0]} ${files[1]}`]) {
      test(`AR02 live ${type}/${phase} runs its own red through ${selection ? 'files' : 'preset'} channel`, async () => {
        const f = fixture(phase, type);
        f.h.events = [{ kind: 'assertion-failed', test: alpha }, { kind: 'passed', test: beta }, { kind: 'complete', expected: [alpha, beta] }];
        f.h.exit = { exitCode: 1, signal: null, stderr: '' };
        const redReply = await f.run('red', selection);
        const red = result(redReply, phase, 'red');
        assert.notEqual(redReply.code, 0, 'An assertion failure keeps its nonzero CLI code');
        assert.equal(red.outcome, 'assertions-failed');
        assert.deepEqual(red.knownRed, [alpha]);
        assert.deepEqual(red.failureKinds, ['assertions']);
        assert.deepEqual(red.unexecuted, []);
        assert.equal(f.h.spawns.length, 1);
        assert.equal(f.h.spawns[0].environment.HOME, f.h.context.home);
        assert.equal(f.h.spawns[0].environment.statePath, f.h.context.statePath);
        assert.notEqual(f.h.spawns[0].environment.HOME, f.h.context.operationalHome);
        assert.equal(f.h.spawns[0].shell, false);
        assert.equal(f.h.config.phases['test-scaffold'].allowed, false);
        if (phase === 'test-scaffold') return;
        f.h.events = [{ kind: 'passed', test: alpha }, { kind: 'passed', test: beta }, { kind: 'complete', expected: [alpha, beta] }];
        f.h.exit = { exitCode: 0, signal: null, stderr: '' };
        const verifyReply = await f.run(phase, selection);
        const verified = result(verifyReply, phase, phase);
        assert.equal(verifyReply.code, 0);
        assert.equal(verified.outcome, 'passed');
        assert.deepEqual(verified.knownRed, []);
        assert.equal(verified.timeoutCount, red.timeoutCount);
        assert.equal(f.h.state.records.size, 1, 'Red and verification retain the same group aggregate');
        assert.deepEqual(f.selectedKeys, [{ ...key, group }, { ...key, group }]);
        assert.equal(f.h.spawns.length, 2);
        assert.deepEqual(f.h.spawns[1].environment, f.h.spawns[0].environment);
      });
    }
  }
}

for (const phase of ['test-scaffold', 'implement', 'qa', 'hotfix']) {
  const forbidden = phase === 'test-scaffold'
    ? ['test-scaffold', 'implement', 'qa', 'hotfix', 'integration', 'main']
    : ['test-scaffold', ...['implement', 'qa', 'hotfix'].filter(value => value !== phase), ...(phase === 'implement' ? ['red'] : [])];
  for (const requested of forbidden) {
    test(`AR03 ${phase} cannot substitute ${requested} before state access or spawn`, async () => {
      await denied(fixture(phase), requested);
    });
  }
}

for (const phase of ['test-scaffold', 'qa', 'hotfix']) {
  test(`AR04 closed ${phase} cannot use red`, async () => {
    const f = fixture(phase);
    Object.assign(f.evidence.claims[0], { state: 'finished' });
    await denied(f, 'red');
  });
  test(`AR04 ${phase} red does not acquire a foreign change without a grant`, async () => {
    const f = fixture(phase);
    Object.assign(f.snapshot, { activeChanges: ['add-raf-test-run', 'foreign-change'] });
    f.h.config.projects.raf.groups['foreign-change/unit'] = { profileId: 'node', files: files.slice(0, 2) };
    await denied(f, 'red', '', 'foreign-change/unit');
  });
}

for (const runner of ['codex', 'claude'] as const) {
  for (const type of ['test-scaffold', 'agent']) {
    test(`AR05 ${runner}/${type} advertises the red channel while test-scaffold itself is disabled`, () => {
      const f = fixture('test-scaffold', type);
      const access = sandboxRafCommandAccess(f.assignment, runner, entrypoint, f.h.config.phases);
      assert.ok(access.raf_subcommands.includes('test run'));
      assert.ok(access.hostCommands.includes(`${access.raf_command} test run`));
      assert.deepEqual(access.raf_subcommands, ['agent message', 'agent ps', 'test run']);
    });
  }
}

test('AR06 composed test-scaffold assignment includes test run in raf_subcommands', async () => {
  const { h } = fixture('test-scaffold');
  const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const subcommands = rafSubcommandsFor('test-scaffold', 'test-scaffold', h.config.phases)!;
  const brief = await composeAssignmentBrief({ root, changes: [{ id: 'add-raf-test-run', items: [{ id: '6.3', description: '[test-scaffold] Author red' }] }], baselineArchives: [] }, {
    cwd: key.workspace, briefsRoot: `${root}/conf/briefs`, runner: 'codex', stage: 'test-scaffold',
    project: 'raf', agentId: 'author', sessionName: 'author', features: ['add-raf-test-run'], phase: 'test-scaffold',
    outcome: 'Prepare author red tests', writeBoundaries: [fileURLToPath(new URL('../', import.meta.url))], sources: [], reportPath: '/tmp/author.json', reportSchema: {},
    rafCommand: entrypoint.join(' '), rafSubcommands: subcommands,
  }, { readText: path => readFile(path, 'utf8') });
  const payload = JSON.parse(brief.slice(brief.lastIndexOf('\n{') + 1));
  assert.deepEqual(payload.raf_subcommands, ['agent message', 'agent ps', 'test run']);
});
