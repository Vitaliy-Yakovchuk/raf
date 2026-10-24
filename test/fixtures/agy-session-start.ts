import type { SessionStartProtocolSettings, NativeIdentity, SessionStartBindingRequest } from '../../src/agy-session-start.ts';
import type { ProcessIdentity, SessionRecord } from '../../src/session-state.ts';
import type { LaunchWrapperRequest } from '../../src/launch-wrapper.ts';

export const runId = '7a9d0577-cfcf-4cef-8917-8c66e13c281d';
export const nativeId = 'd53a6bb0-7fb3-4d06-9103-b8e7899b4534';
export const otherNativeId = 'a046467c-cc0c-46cf-ac15-e5dd96313211';
export const now = '2026-10-24T08:01:00.000Z';
export const workspace = '/isolated/raf-workspace';
export const pending: NativeIdentity = { state: 'pending', id: null, reason: 'Awaiting owned SessionStart' };

export function processIdentity(id: string | null = null): ProcessIdentity {
  return {
    pid: 42001,
    startedAt: '2026-10-24T08:00:00.000Z',
    runner: 'agy',
    runnerSessionId: id,
    nativeIdentity: id === null ? structuredClone(pending) : {
      state: 'confirmed', id, source: 'session_start', observedAt: now,
    },
    tmuxSession: 'q411-owned',
    evidence: {
      machineId: 'q411-machine', bootId: 'q411-boot', command: 'agy --model fixture-model',
      executable: '/isolated/bin/agy', cwd: workspace,
      tmuxSocket: '/isolated/tmux.sock', tmuxPane: '%41',
    },
  } as unknown as ProcessIdentity;
}

export function sessionRecord(id: string | null = null): SessionRecord {
  const identity = processIdentity(id);
  return {
    runId, addressId: 'q411-agent', revision: 5, state: 'running',
    activity: { type: 'implement', phase: 'implement', project: 'raf', features: ['fixture'], cwd: workspace },
    process: identity,
    observation: { state: 'alive', observedAt: now, identity: structuredClone(identity) },
    launchContext: {
      assignment: { root: workspace, changes: [], baselineArchives: [] },
      selection: { runner: 'agy', model: 'fixture-model', effort: 'fixture-effort', reason: 'test fixture' },
      briefPath: '/isolated/run/brief.md', reportPath: '/isolated/run/report.json',
      writeBoundaries: [workspace],
    },
  };
}

export function bindingRequest(): SessionStartBindingRequest {
  return {
    runId, expectedRevision: 5, workspace, process: processIdentity(), writerGeneration: 'private-channel-1',
    payload: { hook_event_name: 'SessionStart', conversationId: nativeId },
  };
}

export function protocolSettings(runner: SessionStartProtocolSettings['runner'] = 'agy'): SessionStartProtocolSettings {
  return {
    runner, executable: runner, version: 'fixture', baseArgs: [], modelFlag: '--model', effortFlag: '--effort',
    effortFormat: 'literal', modelAliases: {}, promptTransport: 'prompt_interactive', sessionIdFlag: null,
    quotaCommand: null, navigation: [], markers: { ready: ['READY'] }, quotaParser: 'unknown', modelPools: {},
    quotaReliable: false, liveTaskVerified: false,
    timeouts: { startupMs: 1000, transitionMs: 100, overallMs: 2000, pollMs: 1 },
    collection: { intervalMs: 1000, failureBackoffMs: 1000, staleAfterMs: 1000 },
    native: {
      identity: { source: 'session_start' }, composer: '^> (.*)$',
      pendingPaste: { pattern: '^\\[Pasted (\\d+) characters\\]$', unit: 'characters' },
      working: '^WORKING$', finished: '^FINISHED$',
      writeScope: { directoryFlag: '--add-dir', ruleFlag: null, rule: null }, exitCommand: '/quit',
    },
  };
}

export function wrapperRequest(root: string): LaunchWrapperRequest {
  return {
    tmpRoot: root, runId, address: 'q411-agent', statePath: root + '/state.json', cwd: workspace,
    tmuxSession: 'q411-owned', selection: { runner: 'agy', model: 'fixture-model', effort: 'fixture-effort' },
    brief: 'Perform the isolated assignment exactly once.', readinessTimeoutMs: 1000,
    assignment: {
      root: workspace, baselineArchives: [],
      changes: [{ id: 'fixture', items: [{ id: '1.1', description: 'Fixture assignment' }] }],
    },
  };
}
