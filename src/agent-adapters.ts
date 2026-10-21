import { randomUUID } from 'node:crypto';
import type { LaunchOwnership, LaunchWrapperPorts } from './launch-wrapper.ts';

export type AgentRunner = 'codex' | 'grok' | 'agy' | 'claude';
export interface AdapterCommand {
  executable: string;
  args: readonly string[];
  cwd?: string;
  stdin?: string;
}
export interface AdapterCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type AdapterCommandExecutor = (command: AdapterCommand) => Promise<AdapterCommandResult>;
export interface AdapterSelection {
  runner: AgentRunner;
  model: string;
  effort: string;
}
export type RunnerObservation =
  | { status: 'starting' }
  | { status: 'ready'; cliSessionId?: string }
  | { status: 'limited'; reason: string; retryAt?: string }
  | { status: 'failed'; reason: string };
export interface RunnerProtocol {
  invocation(selection: AdapterSelection): AdapterCommand;
  observe(paneText: string): RunnerObservation;
}
export interface ReportWrapper {
    wrap(command: AdapterCommand): AdapterCommand;
}
export interface AdapterStartRequest {
  selection: AdapterSelection;
  tmuxSession: string;
  cwd: string;
    brief: string;
  reportWrapper: ReportWrapper;
}
export interface AdapterSession {
  tmuxSession: string;
  selection: AdapterSelection;
}
export type AdapterObservation = RunnerObservation | { status: 'exited'; exitCode: number | null };
export interface AgentAdapterDependencies {
  execute: AdapterCommandExecutor;
  protocols: Readonly<Record<AgentRunner, RunnerProtocol>>;
}
export interface AdapterLaunchTransportOptions {
  reportWrapper: ReportWrapper;
  inspectOwnership(session: AdapterSession): Promise<LaunchOwnership>;
  pollIntervalMs: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}
export class TmuxAgentAdapter {
  createLaunchTransport(options: AdapterLaunchTransportOptions): LaunchWrapperPorts['transport'] {
    if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) throw new Error('Poll interval must be positive');
    const now = options.now ?? Date.now;
    const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    let session: AdapterSession | undefined;
    let readyId: string | undefined;
    let stopped = false;
    let exit: { code: number | null; signal: string | null } | undefined;
    const current = () => { if (!session) throw new Error('Launch has not started'); return session; };
    return {
      startWithoutInput: async request => {
        if (session) throw new Error('Launch already started');
        session = await this.startWithoutInput({ selection: request.selection, tmuxSession: request.tmuxSession, cwd: request.cwd, reportWrapper: options.reportWrapper });
      },
      waitReady: async timeoutMs => {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Readiness timeout must be positive');
        readyId = undefined;
        const deadline = now() + timeoutMs;
        while (now() < deadline) {
          const observation = await this.inspect(current());
          if (observation.status === 'exited') {
            exit = { code: observation.exitCode, signal: null };
            return { state: 'exited', reason: 'Runner exited before readiness' };
          }
          if (observation.status === 'ready') {
            if (!observation.cliSessionId?.trim()) return { state: 'unknown_screen', reason: 'Ready screen has no native session identity' };
            readyId = observation.cliSessionId;
            return { state: 'ready', runnerSessionId: readyId };
          }
          if (observation.status !== 'starting') return { state: 'unknown_screen', reason: observation.reason };
          await delay(Math.min(options.pollIntervalMs, Math.max(0, deadline - now())));
        }
        return { state: 'timeout', reason: 'Runner readiness timed out' };
      },
      ownership: () => options.inspectOwnership(current()),
      deliver: async brief => {
        if (!readyId || exit || stopped) throw new Error('Runner readiness and native session identity are required');
        await this.deliver(current(), brief);
      },
      waitExit: async () => {
        while (!exit) {
          const observation = await this.inspect(current());
          if (observation.status === 'exited') exit = { code: observation.exitCode, signal: null };
          else if (stopped) throw new Error('Stopped runner is still alive');
          else await delay(options.pollIntervalMs);
        }
        return exit;
      },
      stop: async identity => {
        const ownership = await options.inspectOwnership(current());
        if (ownership.state !== 'owned') throw new Error('Runner ownership cannot be verified');
        const actual = ownership.identity;
        if (actual.pid !== identity.pid || actual.startedAt !== identity.startedAt || actual.runner !== identity.runner || actual.runnerSessionId !== identity.runnerSessionId || actual.tmuxSession !== identity.tmuxSession ||
            Object.keys(actual.evidence).length !== Object.keys(identity.evidence).length || Object.entries(identity.evidence).some(([key, value]) => actual.evidence[key] !== value)) throw new Error('Runner ownership identity mismatch');
        if (actual.tmuxSession !== current().tmuxSession || actual.runner !== current().selection.runner) throw new Error('Runner identity belongs to another launch');
        if (exit) return;
        await this.stop(current());
        stopped = true;
      },
    };
  }

  private readonly dependencies: AgentAdapterDependencies;

  constructor(dependencies: AgentAdapterDependencies) {
    this.dependencies = dependencies;
  }

  private target(session: AdapterSession): string {
    if (!/^[A-Za-z0-9_-]+$/.test(session.tmuxSession)) throw new Error('Invalid tmux session name');
    return `=${session.tmuxSession}:0.0`;
  }

  private async tmux(args: string[], stdin?: string): Promise<AdapterCommandResult> {
    const result = await this.dependencies.execute({ executable: 'tmux', args, ...(stdin === undefined ? {} : { stdin }) });
    if (result.exitCode !== 0) throw new Error(`tmux ${args[0]} failed: ${result.stderr}`);
    return result;
  }

  async startWithoutInput(request: Omit<AdapterStartRequest, 'brief'>): Promise<AdapterSession> {
    if (!/^[A-Za-z0-9_-]+$/.test(request.tmuxSession)) throw new Error('Invalid tmux session name');
    const protocol = this.dependencies.protocols[request.selection.runner];
    if (!protocol) throw new Error('Unknown runner');
    const command = request.reportWrapper.wrap(protocol.invocation(request.selection));
    const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
    let invocation = [command.executable, ...command.args];
    if (command.stdin !== undefined) {
      invocation = ['sh', '-c', `printf '%s' ${quote(command.stdin)} | ${invocation.map(quote).join(' ')}`];
    } else if (invocation.length === 1) {
      invocation = ['sh', '-c', 'exec "$@"', 'raf-adapter', ...invocation];
    }
    const session: AdapterSession = { tmuxSession: request.tmuxSession, selection: { ...request.selection } };
    await this.tmux([
      'new-session', '-d', '-s', request.tmuxSession, '-c', command.cwd ?? request.cwd, 'sh', '-c', 'read -r _',
      ';', 'set-option', '-p', '-t', this.target(session), 'remain-on-exit', 'on',
      ';', 'respawn-pane', '-k', '-t', this.target(session),
      ...invocation.map(value => value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value),
    ]);
    return session;
  }

  async start(request: AdapterStartRequest): Promise<AdapterSession> {
    const session = await this.startWithoutInput(request);
    try {
      await this.deliver(session, request.brief);
      return session;
    } catch (error) {
      const observation = await this.inspect(session).catch(() => undefined);
      if (observation?.status === 'exited' && observation.exitCode !== null) return session;
      await this.stop(session).catch(() => undefined);
      throw error;
    }
  }

  async inspect(session: AdapterSession): Promise<AdapterObservation> {
    const target = this.target(session);
    const state = await this.dependencies.execute({ executable: 'tmux', args: ['display-message', '-p', '-t', target, '#{pane_dead}|#{pane_dead_status}'] });
    if (state.exitCode !== 0) return { status: 'exited', exitCode: null };
    const [dead, status] = state.stdout.trim().split(/[|\t]/);
    if (dead === '1') return { status: 'exited', exitCode: status !== undefined && /^\d+$/.test(status) ? Number(status) : null };
    if (dead !== '0') return { status: 'exited', exitCode: null };
    const pane = await this.dependencies.execute({ executable: 'tmux', args: ['capture-pane', '-p', '-t', target] });
    if (pane.exitCode !== 0) return { status: 'exited', exitCode: null };
    return this.dependencies.protocols[session.selection.runner].observe(pane.stdout);
  }

  async deliver(session: AdapterSession, message: string): Promise<void> {
    const target = this.target(session);
    const buffer = `raf-${randomUUID()}`;
    let loaded = false;
    try {
      await this.tmux(['load-buffer', '-b', buffer, '-'], message);
      loaded = true;
      await this.tmux(['paste-buffer', '-d', '-b', buffer, '-t', target]);
      loaded = false;
      await this.tmux(['send-keys', '-t', target, 'Enter']);
    } finally {
      if (loaded) await this.tmux(['delete-buffer', '-b', buffer]);
    }
  }

  async stop(session: AdapterSession): Promise<void> {
    this.target(session);
    await this.tmux(['kill-session', '-t', `=${session.tmuxSession}`]);
  }
}
