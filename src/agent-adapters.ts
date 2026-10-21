import { randomUUID } from 'node:crypto';

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
export class TmuxAgentAdapter {
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

  async start(request: AdapterStartRequest): Promise<AdapterSession> {
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
    const state = await this.dependencies.execute({ executable: 'tmux', args: ['display-message', '-p', '-t', target, '#{pane_dead}\t#{pane_dead_status}'] });
    if (state.exitCode !== 0) return { status: 'exited', exitCode: null };
    const [dead, status] = state.stdout.trim().split('\t');
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
