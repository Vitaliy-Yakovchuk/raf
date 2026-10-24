import type { RunnerProtocol } from './agent-adapters.ts';
import type { NativeDialect, ProtocolSettings } from './runner-protocols.ts';
import type { ProcessIdentity, ProcessObservation, SessionRepository } from './session-state.ts';

export type NativeIdentity =
  | { state: 'pending'; id: null; reason: string }
  | { state: 'confirmed'; id: string; source: 'session_start'; observedAt: string };

export type SessionStartProtocolSettings = Omit<ProtocolSettings, 'native'> & {
  native?: Omit<NativeDialect, 'identity'> & {
    identity: NativeDialect['identity'] | { source: 'session_start' };
  };
};

export interface NativeLaunchProtocol extends RunnerProtocol {
  readonly nativeIdentitySource: 'status' | 'assigned' | 'session_start';
}

export type SessionStartOrigin = {
  runId: string;
  workspace: string;
  process: ProcessIdentity;
  writerGeneration: string;
};

export type SessionStartBindingRequest = SessionStartOrigin & {
  expectedRevision: number;
  payload: unknown;
};

export type SessionStartBindingPorts = {
  repository: SessionRepository;
  verifyOrigin(payload: unknown): Promise<SessionStartOrigin | null>;
  inspectProcess(identity: ProcessIdentity): Promise<ProcessObservation>;
  now(): string;
  diagnostic(reason: string): void;
};

export type SessionStartBindingResult =
  | { status: 'confirmed' | 'duplicate' }
  | { status: 'rejected'; reason: string };

export function selectNativeLaunchProtocol(settings: SessionStartProtocolSettings): NativeLaunchProtocol {
  throw new Error('NotImplemented');
}

export async function confirmAgySessionStart(
  request: SessionStartBindingRequest,
  ports: SessionStartBindingPorts,
): Promise<SessionStartBindingResult> {
  throw new Error('NotImplemented');
}
