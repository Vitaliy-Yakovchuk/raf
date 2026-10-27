import type { ProcessIdentity, SessionRecord } from './session-state.ts';

function processView(identity: ProcessIdentity): ProcessIdentity {
  const { command, ...evidence } = identity.evidence;
  return { ...identity, evidence };
}

export function agentPsView(session: SessionRecord) {
  const { launchContext, modelHandoff, ...view } = session;
  return {
    ...view,
    ...(view.process ? { process: processView(view.process) } : {}),
    ...(view.worker ? { worker: processView(view.worker) } : {}),
    ...(view.observation?.state === 'alive' ? {
      observation: { ...view.observation, identity: processView(view.observation.identity) },
    } : {}),
  };
}
