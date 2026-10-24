import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { buildRunnerInvocation, observeRunnerScreen, readNativeComposer, readNativeSessionId } from './runner-protocols.ts';
import { hasValidNativeIdentity, nativeUuid, sameProcessOwnership } from './process-identity.ts';
import type { AdapterCommand, RunnerProtocol } from './agent-adapters.ts';
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
  const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
  const regex = (value: unknown) => { try { return nonempty(value) && !!new RegExp(value, 'u'); } catch { return false; } };
  const native = settings.native;
  if (!native) throw new Error(`Runner ${settings.runner} has no native dialect`);
  const identity = native.identity;
  if (!identity || !['status', 'assigned', 'session_start'].includes(identity.source)) throw new Error('Invalid native identity source');
  if (identity.source === 'session_start') {
    if (settings.runner !== 'agy') throw new Error('SessionStart identity is only supported for agy');
    if (!regex(native.finished)) throw new Error('SessionStart native dialect requires a finished marker');
  } else if (!nonempty(identity.command) || !regex(identity.pattern) || !Array.isArray(identity.dismissKeys) || !identity.dismissKeys.every(nonempty) || identity.source === 'assigned' && !nonempty(settings.sessionIdFlag)) throw new Error('Invalid pre-brief native identity dialect');
  if (!regex(native.composer) || !native.pendingPaste || !regex(native.pendingPaste.pattern) || !['characters', 'newlines'].includes(native.pendingPaste.unit) || !regex(native.working) || !nonempty(native.exitCommand) || !native.writeScope || !nonempty(native.writeScope.directoryFlag) || (native.writeScope.ruleFlag === null ? native.writeScope.rule !== null : !nonempty(native.writeScope.ruleFlag) || !nonempty(native.writeScope.rule) || !native.writeScope.rule.includes('{directory}')) || native.startup !== undefined && (!Array.isArray(native.startup) || !native.startup.every(nonempty))) throw new Error('Incomplete native dialect');
  if (!settings.timeouts || !['startupMs', 'transitionMs', 'overallMs', 'pollMs'].every(key => Number.isFinite(settings.timeouts[key]) && settings.timeouts[key] > 0) || !nonempty(settings.executable) || !nonempty(settings.version) || !Array.isArray(settings.baseArgs) || !settings.baseArgs.every(nonempty) || !nonempty(settings.modelFlag) || !nonempty(settings.effortFlag) || !['literal', 'codex_config'].includes(settings.effortFormat) || !settings.modelAliases || typeof settings.modelAliases !== 'object' || !Array.isArray(settings.navigation) || !settings.markers || !Array.isArray(settings.markers.ready) || !settings.markers.ready.length || !settings.markers.ready.every(nonempty) || typeof settings.liveTaskVerified !== 'boolean') throw new Error('Invalid native invocation/readiness protocol or deadlines');
  const configured = settings as ProtocolSettings;
  const assignedId = identity.source === 'assigned' ? randomUUID() : undefined;
  return {
    nativeIdentitySource: identity.source,
    invocation: selection => {
      if (selection.runner !== settings.runner) throw new Error('Native protocol belongs to another runner');
      return buildRunnerInvocation(configured, { ...selection, ...(assignedId ? { sessionId: assignedId } : {}) });
    },
    observe: screen => {
      const observation = observeRunnerScreen(configured, { text: screen, version: settings.version, requestedCommand: null });
      if (observation.state === 'ready') {
        if (identity.source === 'session_start') {
          const composer = readNativeComposer(configured, screen);
          if (!composer || composer.input !== '' && !settings.markers.ready?.includes(composer.input)) return { status: 'failed', reason: 'Native composer unavailable' };
          return { status: 'ready', cliSessionId: null, nativeIdentity: { state: 'pending', id: null, reason: 'Awaiting owned SessionStart conversationId' } };
        }
        const id = readNativeSessionId(configured, screen);
        if (id && (!assignedId || id === assignedId)) return { status: 'ready', cliSessionId: id };
        return { status: 'starting' };
      }
      if (observation.state === 'starting') return { status: 'starting' };
      return { status: 'failed', reason: observation.state };
    },
  };
}

export async function confirmAgySessionStart(
  request: SessionStartBindingRequest,
  ports: SessionStartBindingPorts,
): Promise<SessionStartBindingResult> {
  const reject = (reason: string): SessionStartBindingResult => { ports.diagnostic(reason); return { status: 'rejected', reason }; };
  if (!request || !request.runId || !isAbsolute(request.workspace ?? '') || !request.writerGeneration || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || !request.process || request.process.runner !== 'agy' || !hasValidNativeIdentity(request.process)) return reject('Invalid SessionStart launch binding');
  const payload = request.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !nativeUuid((payload as Record<string, unknown>).conversationId)) return reject('Malformed SessionStart conversationId');
  const id = (payload as { conversationId: string }).conversationId;
  const workspacePaths = (payload as { workspacePaths?: unknown }).workspacePaths;
  if (workspacePaths !== undefined && (!Array.isArray(workspacePaths) || !workspacePaths.includes(request.workspace))) return reject('SessionStart workspace mismatch');
  let origin: SessionStartOrigin | null;
  try { origin = await ports.verifyOrigin(payload); } catch { return reject('SessionStart origin could not be verified'); }
  if (!origin || origin.runId !== request.runId || origin.workspace !== request.workspace || origin.writerGeneration !== request.writerGeneration || !sameProcessOwnership(origin.process, request.process)) return reject('Untrusted, foreign or stale SessionStart writer');
  let observation: ProcessObservation;
  try { observation = await ports.inspectProcess(request.process); } catch { return reject('SessionStart process ownership unavailable'); }
  if (observation.state !== 'alive' || !sameProcessOwnership(request.process, observation.identity)) return reject('SessionStart process is not the owned live runner');
  const observedAt = ports.now();
  if (!Number.isFinite(Date.parse(observedAt))) return reject('Invalid SessionStart observation time');
  return ports.repository.transaction(tx => {
    const session = tx.getSession(request.runId);
    if (!session || session.state !== 'running' || !session.process || session.process.runner !== 'agy' || !sameProcessOwnership(session.process, request.process) || session.activity?.cwd !== request.workspace || session.observation?.state === 'exited') return reject('SessionStart launch is no longer current and alive');
    const binding = session.launchContext?.sessionStart;
    if (binding && (binding.workspace !== request.workspace || binding.writerGeneration !== request.writerGeneration)) return reject('SessionStart writer generation no longer owns the launch');
    const native = session.process.nativeIdentity;
    if (!native) return reject('SessionStart launch has no deferred native identity');
    if (native.state === 'confirmed') return native.id === id ? { status: 'duplicate' } : reject('Conflicting SessionStart identity');
    if (session.revision !== request.expectedRevision) return reject('Stale SessionStart revision');
    const process: ProcessIdentity = { ...session.process, runnerSessionId: id, nativeIdentity: { state: 'confirmed', id, source: 'session_start', observedAt } };
    tx.putSession({ ...session, revision: session.revision + 1, process,
      ...(session.observation?.state === 'alive' ? { observation: { ...session.observation, identity: process } } : {}) });
    return { status: 'confirmed' };
  });
}

export interface OwnedSessionStartChannel {
  readonly invocation: AdapterCommand;
  readonly writerGeneration: string;
  verifyOrigin(payload: unknown): Promise<SessionStartOrigin | null>;
  subscribe(listener: (payload: unknown) => Promise<void>): () => void;
  close(): Promise<void>;
}

export type PrepareSessionStartChannel = (input: {
  runId: string;
  workspace: string;
  runDirectory: string;
  invocation: AdapterCommand;
}) => Promise<OwnedSessionStartChannel>;
