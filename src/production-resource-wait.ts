import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { homedir } from 'node:os';
import { createResourceWaitProtocol, type ResourceWaitProtocolOptions, type ResourceWaitPending } from './resource-wait-protocol.ts';
import { createResourceWaitSocketHost } from './resource-wait-transport.ts';
import { observeWaitIdentity } from './resource-wait-identity.ts';
import { createResourceSnapshotReader, observeProcesses, readMachineBootIdentity } from './os-runtime.ts';
import { evaluateLaunchAdmissionInTransaction } from './launch-state.ts';
import { evaluateResourceAdmission } from './resource-admission.ts';
import { deriveResourceAdmissionVolumes } from './home-disk-admission.ts';
import type { StateStore } from './state-store.ts';
import type { ServiceEntryContext } from './service-entry.ts';

export async function productionResourceWait(context: ServiceEntryContext, options: ResourceWaitProtocolOptions, getStore: () => StateStore) {
  const boot = await readMachineBootIdentity();
  let epoch = '';
  const sockets = createResourceWaitSocketHost(() => protocol, () => epoch, options.deliveryTimeoutMs);
  const protocol = createResourceWaitProtocol(options, {
    monotonicNow: () => performance.now(), wallNow: Date.now, bootIdentity: () => `${boot.machineId}/${boot.bootId}`, nextId: randomUUID,
    schedule: (at, wake) => { const timer = setTimeout(() => { void wake().catch(error => process.emitWarning(error)); }, Math.max(0, at - performance.now())); timer.unref(); return () => clearTimeout(timer); },
    readSnapshot: async requests => {
      const observedAt = performance.now();
      const paths = [...new Set([context.orchestratorRoot, homedir(), ...requests.map(request => request.developmentDirectory)])];
      const sessions = getStore().sessionRepository.transaction(tx => tx.listSessions().filter(session => session.state === 'running' && session.process), 'read');
      const [snapshot, observations] = await Promise.all([
        createResourceSnapshotReader({ machineId: boot.machineId, paths }).read(),
        observeProcesses(sessions.map(session => session.process!)),
      ]);
      const unknown = observations.find(row => row.state === 'unknown');
      if (unknown?.state === 'unknown') snapshot.reasons.push(unknown.error);
      const observedProcesses = observations.flatMap((row, index) => row.state === 'alive' ? [{ runId: sessions[index].runId, identity: row.identity }] : []);
      return { observedAt, data: { ...snapshot, observedProcesses } };
    },
    evaluateSnapshot: (probe, request: ResourceWaitPending) => {
      const snapshot = probe.data as Awaited<ReturnType<ReturnType<typeof createResourceSnapshotReader>['read']>> & { observedProcesses: import('./launch-state.ts').LaunchMeasurement['observedProcesses'] };
      const volumes = deriveResourceAdmissionVolumes({ orchestratorRoot: context.orchestratorRoot, workspace: request.developmentDirectory, home: homedir() }, snapshot.fileSystemByPath);
      const reasons = [...snapshot.reasons, ...volumes.reasons];
      if (reasons.length) return { status: 'UNKNOWN', reason: reasons.join('; ') };
      const store = getStore();
      const admission = store.sessionRepository.transaction(tx => evaluateLaunchAdmissionInTransaction(tx, {
        requested: { ramBytes: 0, diskBytes: Object.fromEntries(volumes.requiredFileSystemIds.map(id => [id, 0])) },
        requiredFileSystemIds: volumes.requiredFileSystemIds, homeFileSystemId: volumes.homeFileSystemId,
      }, { measurement: snapshot.measurement, observedProcesses: snapshot.observedProcesses }, evaluateResourceAdmission), 'read');
      return { status: admission.level, reason: admission.reasons.join('; ') };
    },
    observeClient: observeWaitIdentity,
    isConnectionOpen: id => { const socket = sockets.connections.get(id)?.socket; return !!socket && !socket.destroyed && !socket.readableEnded; },
    sendOffer: async (id, offer) => { await sockets.connections.get(id)?.send({ kind: 'offer', offer }); },
    sendResult: async (id, result) => { await sockets.connections.get(id)?.send({ kind: 'result', result }); },
    sendError: async (id, ticket, diagnostic) => { await sockets.connections.get(id)?.send({ kind: 'result', result: { ...ticket, offerId: '', deadline: 0, kind: 'error', diagnostic } }); },
    loadLastGrant: async () => getStore().readResourceWaitGrant(),
    commitLastGrant: async change => {
      try { return getStore().commitResourceWaitGrant(change); }
      catch {
        try {
          const saved = getStore().readResourceWaitGrant();
          if (JSON.stringify(saved) === JSON.stringify(change.next)) return 'committed';
          if (JSON.stringify(saved) === JSON.stringify(change.previous)) return 'not-committed';
        } catch {}
        return 'unknown';
      }
    },
  });
  return {
    start: async (serviceEpoch: string) => { epoch = serviceEpoch; getStore().claimResourceWaitEpoch(epoch); await protocol.start(epoch); },
    attach: sockets.attach,
    stop: async () => { await protocol.stop('Service stopped'); for (const { socket } of sockets.connections.values()) socket.destroy(); },
  };
}
