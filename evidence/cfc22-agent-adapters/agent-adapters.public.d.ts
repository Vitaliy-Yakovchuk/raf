import type { NativeIdentity } from './agy-session-start.ts';
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
export type RunnerObservation = {
    status: 'starting';
} | {
    status: 'ready';
    cliSessionId?: string | null;
    nativeIdentity?: NativeIdentity;
} | {
    status: 'limited';
    reason: string;
    retryAt?: string;
} | {
    status: 'failed';
    reason: string;
};
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
}
export interface AdapterSession {
    tmuxSession: string;
    selection: AdapterSelection;
    warnings?: readonly string[];
}
export type AdapterObservation = RunnerObservation | {
    status: 'exited';
    exitCode: number | null;
};
export interface AgentAdapterDependencies {
    execute: AdapterCommandExecutor;
    protocols: Readonly<Record<AgentRunner, RunnerProtocol>>;
}
export interface AdapterLaunchTransportOptions {
    reportWrapper: ReportWrapper;
    inspectOwnership(session: AdapterSession): Promise<LaunchOwnership>;
    pollIntervalMs: number;
    waitForExit?(session: AdapterSession): Promise<{
        code: number | null;
        signal: string | null;
    }>;
    now?: () => number;
    delay?: (milliseconds: number) => Promise<void>;
}
export declare class TmuxAgentAdapter {
    createLaunchTransport(options: AdapterLaunchTransportOptions): LaunchWrapperPorts['transport'];
    private readonly dependencies;
    constructor(dependencies: AgentAdapterDependencies);
    private target;
    private tmux;
    startWithoutInput(request: Omit<AdapterStartRequest, 'brief'>): Promise<AdapterSession>;
    start(request: AdapterStartRequest): Promise<AdapterSession>;
    inspect(session: AdapterSession): Promise<AdapterObservation>;
    private inspectRunner;
    waitForExit(session: AdapterSession): Promise<{
        code: number | null;
        signal: string | null;
    }>;
    capture(session: AdapterSession): Promise<{
        exited: boolean;
        exitCode: number | null;
        text: string;
    }>;
    typeText(session: AdapterSession, text: string): Promise<void>;
    sendKeys(session: AdapterSession, keys: readonly string[]): Promise<void>;
    deliver(session: AdapterSession, message: string): Promise<void>;
    deliverToPane(pane: string, message: string): Promise<void>;
    private paste;
    stop(session: AdapterSession): Promise<void>;
}
