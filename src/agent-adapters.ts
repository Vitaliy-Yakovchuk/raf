import { measureRafCost } from './raf-cost-runtime.ts';
import type { NativeIdentity } from './agy-session-start.ts';
import { hasValidNativeIdentity, sameProcessOwnership } from './process-identity.ts';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { startupContextRunnerEnvironment } from './startup-context-journal.ts';
import type { ProcessIdentity } from './session-state.ts';
import type { LaunchOwnership, LaunchWrapperPorts } from './launch-wrapper.ts';

export type AgentRunner = 'codex' | 'grok' | 'agy' | 'claude';
export interface AdapterCommand {
  executable: string;
  args: readonly string[];
  cwd?: string;
  stdin?: string;
  environment?: Readonly<Record<string, string | undefined>>;
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
  | { status: 'ready'; cliSessionId?: string | null; nativeIdentity?: NativeIdentity }
  | { status: 'limited'; reason: string; retryAt?: string }
  | { status: 'failed'; reason: string };
export interface RunnerProtocol {
  readonly nativeIdentitySource?: 'status' | 'assigned' | 'session_start';
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
  signal?: AbortSignal;
}
export interface AdapterSession {
  tmuxSession: string;
  selection: AdapterSelection;
  warnings?: readonly string[];
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
  waitForExit?(session: AdapterSession): Promise<{ code: number | null; signal: string | null }>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}
export class TmuxAgentAdapter {
  createLaunchTransport(options: AdapterLaunchTransportOptions): LaunchWrapperPorts['transport'] {
    if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) throw new Error('Poll interval must be positive');
    const now = options.now ?? Date.now;
    const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    let session: AdapterSession | undefined;
    let readyId: string | null | undefined;
    let delivered = false;
    let ownershipAnchor: ProcessIdentity | undefined;
    let stopped = false;
    let exit: { code: number | null; signal: string | null } | undefined;
    let exitWait: Promise<{ code: number | null; signal: string | null }> | undefined;
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
        let warned = false;
        for (;;) {
          if (!warned && now() >= deadline) { warned = true; process.stderr.write(`Warning: runner readiness still pending after ${timeoutMs} ms; waiting\n`); }
          let observation = await this.inspect(current());
          if (observation.status === 'exited' && observation.exitCode === null && current().selection.runner === 'agy' && this.dependencies.protocols.agy.nativeIdentitySource === 'session_start') {
            const owner = await options.inspectOwnership(current());
            if (owner.state === 'owned' && hasValidNativeIdentity(owner.identity) && owner.identity.nativeIdentity !== undefined && owner.identity.runner === 'agy' && owner.identity.tmuxSession === current().tmuxSession && Number.isSafeInteger(owner.identity.pid) && owner.identity.pid > 0 && !!owner.identity.startedAt && !!owner.identity.evidence.machineId && !!owner.identity.evidence.bootId && !!owner.identity.evidence.command && !!owner.identity.evidence.tmuxSocket && !!owner.identity.evidence.tmuxPane) {
              ownershipAnchor ??= structuredClone(owner.identity);
              const pane = await this.dependencies.execute({ executable: 'tmux', args: ['capture-pane', '-p', '-t', this.target(current())] });
              if (pane.exitCode === 0) observation = this.dependencies.protocols.agy.observe(pane.stdout);
            }
          }
          if (observation.status === 'exited') {
            exit = { code: observation.exitCode, signal: null };
            return { state: 'exited', reason: 'Runner exited before readiness' };
          }
          if (observation.status === 'ready') {
            const deferred = current().selection.runner === 'agy' && this.dependencies.protocols.agy.nativeIdentitySource === 'session_start';
            if (!observation.cliSessionId?.trim()) {
              if (!deferred || observation.cliSessionId !== null && observation.cliSessionId !== undefined) return { state: 'unknown_screen', reason: 'Ready screen has no native session identity' };
              readyId = null;
              return { state: 'ready', runnerSessionId: null, nativeIdentity: { state: 'pending', id: null, reason: 'Awaiting owned SessionStart conversationId' } };
            }
            readyId = observation.cliSessionId;
            return { state: 'ready', runnerSessionId: readyId };
          }
          if (observation.status !== 'starting') return { state: 'unknown_screen', reason: observation.reason };
          await delay(options.pollIntervalMs);
        }
      },
      ownership: async () => {
        const owned = await options.inspectOwnership(current());
        if (owned.state === 'owned') ownershipAnchor ??= structuredClone(owned.identity);
        return owned;
      },
      deliver: async brief => {
        if (readyId === undefined || exit || stopped || delivered) throw new Error('Runner readiness and a single initial delivery are required');
        const owned = await options.inspectOwnership(current());
        if (owned.state !== 'owned' || !['agent', 'runner-owned'].includes(owned.processKind) || !hasValidNativeIdentity(owned.identity) || ownershipAnchor !== undefined && !sameProcessOwnership(ownershipAnchor, owned.identity) || owned.identity.nativeIdentity !== undefined && (!Number.isSafeInteger(owned.identity.pid) || owned.identity.pid <= 0 || !Number.isFinite(Date.parse(owned.identity.startedAt)) || !owned.identity.evidence.machineId || !owned.identity.evidence.bootId || !owned.identity.evidence.command || !owned.identity.evidence.tmuxSocket || !owned.identity.evidence.tmuxPane) || owned.identity.runner !== current().selection.runner || owned.identity.tmuxSession !== current().tmuxSession || (readyId === null ? owned.identity.nativeIdentity === undefined : owned.identity.runnerSessionId !== readyId)) throw new Error('Verified runner ownership is required before input');
        delivered = true;
        await this.deliver(current(), brief);
      },
      waitExit: async () => {
        if (!exit && options.waitForExit) {
          exitWait ??= options.waitForExit(current()).then(value => exit = value);
          return exitWait;
        }
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
        if (!sameProcessOwnership(actual, identity)) throw new Error('Runner ownership identity mismatch');
        if (actual.tmuxSession !== current().tmuxSession || actual.runner !== current().selection.runner) throw new Error('Runner identity belongs to another launch');
        if (exit) return;
        await this.stop(current());
        stopped = true;
      },
      lastScreen: async () => {
        const pane = await this.dependencies.execute({ executable: 'tmux', args: ['capture-pane', '-p', '-t', this.target(current())] });
        if (pane.exitCode !== 0) return undefined;
        return pane.stdout;
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
    const environment = startupContextRunnerEnvironment(request.selection.runner, {});
    if (environment.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE) invocation = ['env', 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1', ...invocation];
    const session: AdapterSession = { tmuxSession: request.tmuxSession, selection: { ...request.selection } };
    const hostHome = userInfo().homedir;
    const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin' ? join(hostHome, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(hostHome, 'AppData', 'Local'), 'ms-playwright')
        : join(process.env.XDG_CACHE_HOME || join(hostHome, '.cache'), 'ms-playwright'));
    const bootstrap = [
      'new-session', '-e', `PLAYWRIGHT_BROWSERS_PATH=${browserCache}`, '-d', '-s', request.tmuxSession, '-c', command.cwd ?? request.cwd, 'sh', '-c', 'read -r _',
      ';', 'set-option', '-p', '-t', this.target(session), 'remain-on-exit', 'on',
    ];
    const respawn = ['respawn-pane', '-k', '-t', this.target(session), ...invocation];
    if ([...bootstrap, ...respawn].reduce((bytes, value) => bytes + Buffer.byteLength(value) + 1, 0) > 12 * 1024) {
      await this.tmux(bootstrap);
      const tmuxQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      try {
        await this.tmux(['source-file', '-'], respawn.map(tmuxQuote).join(' ') + '\n');
      } catch (error) {
        await this.stop(session).catch(() => undefined);
        throw error;
      }
      return session;
    }
    await this.tmux([
      ...bootstrap, ';', 'respawn-pane', '-k', '-t', this.target(session),
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
    return measureRafCost('runner-observation', () => this.inspectRunner(session));
  }

  private async inspectRunner(session: AdapterSession): Promise<AdapterObservation> {
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

  async waitForExit(session: AdapterSession): Promise<{ code: number | null; signal: string | null }> {
    const target = this.target(session);
    const channel = `raf-exit-${randomUUID()}`;
    const index = Number.parseInt(randomUUID().slice(0, 8), 16) >>> 1;
    const hooks = ['pane-died', 'pane-exited', 'session-closed'].map(name => ({
      name: `${name}[${index}]`, scope: name === 'session-closed' ? ['-g'] : ['-t', target],
    }));
    const status = async () => {
      const result = await this.dependencies.execute({ executable: 'tmux', args: ['display-message', '-p', '-t', target, '#{pane_dead}|#{pane_dead_status}'] });
      if (result.exitCode !== 0) return { code: null, signal: null };
      const [dead, code] = result.stdout.trim().split(/[|\t]/);
      if (dead === '0') return undefined;
      return { code: dead === '1' && code !== undefined && /^\d+$/.test(code) ? Number(code) : null, signal: null };
    };
    try {
      const notify = `if-shell -F '#{==:#{hook_session_name},${session.tmuxSession}}' 'wait-for -S ${channel}'`;
      const installed = await this.dependencies.execute({ executable: 'tmux', args: hooks.flatMap((hook, i) => [...(i ? [';'] : []), 'set-hook', ...hook.scope, hook.name, hook.scope.includes('-g') ? notify : `wait-for -S ${channel}`]) });
      const initial = await status();
      if (initial) return initial;
      if (installed.exitCode !== 0) throw new Error(`tmux exit subscription failed: ${installed.stderr}`);
      for (;;) {
        const notified = await this.dependencies.execute({ executable: 'tmux', args: ['wait-for', channel] });
        const exited = await status();
        if (exited) return exited;
        if (notified.exitCode !== 0) throw new Error(`tmux exit notification failed: ${notified.stderr}`);
      }
    } finally {
      for (const hook of hooks) await this.dependencies.execute({ executable: 'tmux', args: ['set-hook', '-u', ...hook.scope, hook.name] }).catch(() => undefined);
      await this.dependencies.execute({ executable: 'tmux', args: ['wait-for', '-S', channel, ';', 'wait-for', channel] }).catch(() => undefined);
    }
  }

  async capture(session: AdapterSession): Promise<{ exited: boolean; exitCode: number | null; text: string }> {
    const target = this.target(session);
    const state = await this.dependencies.execute({ executable: 'tmux', args: ['display-message', '-p', '-t', target, '#{pane_dead}|#{pane_dead_status}'] });
    if (state.exitCode !== 0) return { exited: true, exitCode: null, text: '' };
    const [dead, status] = state.stdout.trim().split(/[|\t]/);
    const pane = await this.dependencies.execute({ executable: 'tmux', args: ['capture-pane', '-p', '-J', '-S', '-', '-t', target] });
    const exitCode = dead === '1' && status !== undefined && /^\d+$/.test(status) ? Number(status) : null;
    if (pane.exitCode !== 0) return { exited: true, exitCode, text: '' };
    return { exited: dead !== '0', exitCode, text: pane.stdout };
  }

  async typeText(session: AdapterSession, text: string): Promise<void> {
    await this.tmux(['send-keys', '-t', this.target(session), '-l', text]);
  }

  async sendKeys(session: AdapterSession, keys: readonly string[]): Promise<void> {
    if (keys.length) await this.tmux(['send-keys', '-t', this.target(session), ...keys]);
  }

  async deliver(session: AdapterSession, message: string): Promise<void> {
    await this.paste(this.target(session), message, ['-p']);
  }

  async deliverToPane(pane: string, message: string): Promise<void> {
    if (!/^%\d+$/.test(pane)) throw new Error('Invalid tmux pane identity');
    await this.paste(pane, message, ['-p']);
  }

  private async paste(target: string, message: string, pasteOptions: readonly string[]): Promise<void> {
    const buffer = `raf-${randomUUID()}`;
    let loaded = false;
    try {
      await this.tmux(['load-buffer', '-b', buffer, '-'], message);
      loaded = true;
      await this.tmux(['paste-buffer', '-d', ...pasteOptions, '-b', buffer, '-t', target]);
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
