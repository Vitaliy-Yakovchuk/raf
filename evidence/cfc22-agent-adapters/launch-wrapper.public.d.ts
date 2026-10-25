import type { NativeIdentity } from './agy-session-start.ts';
import type { AdapterCommand, AdapterSelection } from './agent-adapters.ts';
import type { AgentReportExit, AgentReportPorts, AgentReportRequest, AgentReportResult } from './agent-report.ts';
import type { ProcessIdentity } from './session-state.ts';
export interface LaunchWrapperRequest extends AgentReportRequest {
    readonly statePath: string;
    readonly cwd: string;
    readonly tmuxSession: string;
    readonly selection: AdapterSelection;
    readonly brief: string;
    readonly readinessTimeoutMs: number;
}
export type LaunchReadiness = {
    state: 'starting';
} | {
    state: 'ready';
    runnerSessionId: string | null;
    nativeIdentity?: NativeIdentity;
} | {
    state: 'auth_required' | 'permission_required' | 'unknown_screen' | 'timeout' | 'exited';
    reason: string;
};
export type LaunchOwnership = {
    state: 'owned';
    identity: ProcessIdentity;
    processKind: 'agent' | 'runner-owned';
} | {
    state: 'mismatch' | 'unknown' | 'exited';
    reason: string;
};
export interface LaunchHandshake {
    readonly runId: string;
    readonly address: string;
    readonly reportPath: string;
    readonly identity: ProcessIdentity;
    readonly warnings?: readonly string[];
}
export interface LaunchWrapperPorts {
    readonly transport: {
        startWithoutInput(request: LaunchWrapperRequest, reportPath: string): Promise<void>;
        waitReady(timeoutMs: number): Promise<LaunchReadiness>;
        ownership(): Promise<LaunchOwnership>;
        deliver(brief: string): Promise<void>;
        waitExit(): Promise<AgentReportExit>;
        stop(identity: ProcessIdentity): Promise<void>;
    };
    readonly report: Omit<AgentReportPorts, 'process' | 'result'>;
    readonly lifecycle: {
        started(handshake: LaunchHandshake): Promise<void>;
        acceptReport(result: AgentReportResult): Promise<void>;
        finish(handshake: LaunchHandshake, exit: AgentReportExit): Promise<void>;
        failed(runId: string, reason: string, recoverable: boolean): Promise<void>;
    };
    handshake(handshake: LaunchHandshake): Promise<void>;
}
export interface PersistentWrapperOptions {
    readonly workerCommand: AdapterCommand;
    readonly timeoutMs: number;
}
export interface PersistentWrapperLaunch extends LaunchHandshake {
    readonly wrapperPid: number;
}
export type PersistentWrapperFailure = Error & {
    readonly wrapper: {
        terminate(): Promise<void>;
    };
};
export declare function runLaunchWrapper(request: LaunchWrapperRequest, ports: LaunchWrapperPorts): Promise<void>;
export declare function launchPersistentWrapper(request: LaunchWrapperRequest, options: PersistentWrapperOptions): Promise<PersistentWrapperLaunch>;
export declare function consumeWrapperRequest(): Promise<{
    request: LaunchWrapperRequest;
    handshake(handshake: LaunchHandshake): Promise<void>;
}>;
