import type { ProcessIdentity } from './session-state.ts';

export const nativeUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function hasValidNativeIdentity(identity: Pick<ProcessIdentity, 'runner' | 'runnerSessionId' | 'nativeIdentity'>): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const native = identity.nativeIdentity;
  if (native === undefined) return typeof identity.runnerSessionId === 'string' && identity.runnerSessionId.trim().length > 0;
  if (!native || typeof native !== 'object' || identity.runner !== 'agy') return false;
  if (native.state === 'pending') return identity.runnerSessionId === null && native.id === null && typeof native.reason === 'string' && !!native.reason.trim();
  return native.state === 'confirmed' && native.source === 'session_start' && nativeUuid(native.id) && identity.runnerSessionId === native.id && typeof native.observedAt === 'string' && Number.isFinite(Date.parse(native.observedAt));
}

export function sameProcessOwnership(left: ProcessIdentity, right: ProcessIdentity): boolean {
  if (!left || !right || !hasValidNativeIdentity(left) || !hasValidNativeIdentity(right)) return false;
  const deferred = left.runner === 'agy' && left.nativeIdentity !== undefined && right.nativeIdentity !== undefined;
  if (deferred && left.nativeIdentity?.state === 'confirmed' && right.nativeIdentity?.state === 'confirmed' && left.runnerSessionId !== right.runnerSessionId) return false;
  return left.pid === right.pid && left.startedAt === right.startedAt && left.runner === right.runner &&
    (deferred || left.runnerSessionId === right.runnerSessionId) && left.tmuxSession === right.tmuxSession &&
    !!left.evidence && !!right.evidence && Object.keys(left.evidence).length === Object.keys(right.evidence).length &&
    Object.entries(left.evidence).every(([key, value]) => right.evidence[key] === value);
}
