import { measureRafCost } from './raf-cost-runtime.ts';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { homedir } from 'node:os';
import { createResourceWaitProtocol, type ResourceWaitProtocolOptions, type ResourceWaitPending } from './resource-wait-protocol.ts';
import { createResourceWaitSocketHost } from './resource-wait-transport.ts';
import { observeWaitIdentity, observeWaitIdentities } from './resource-wait-identity.ts';
import { createResourceSnapshotReader, observeProcesses, readMachineBootIdentity } from './os-runtime.ts';
import { evaluateLaunchAdmissionInTransaction } from './launch-state.ts';
import { evaluateResourceAdmission } from './resource-admission.ts';
import { deriveResourceAdmissionVolumes } from './home-disk-admission.ts';
import type { StateStore } from './state-store.ts';
import type { ServiceEntryContext } from './service-entry.ts';
import type { ResourceSnapshotReader } from './os-runtime.ts';

export async function productionResourceWait(context: ServiceEntryContext, options: ResourceWaitProtocolOptions, getStore: () => StateStore, resourceReader?: ResourceSnapshotReader, now: () => number = Date.now) {
  const boot = await readMachineBootIdentity();
  let epoch = '';
  const sockets = createResourceWaitSocketHost(() => protocol, () => epoch, options.deliveryTimeoutMs);
  const finalDeliveries = new Set<Promise<void>>();
  const sendFinal = (id: string, frame: unknown) => {
    const connection = sockets.connections.get(id);
    if (!connection) return Promise.reject(new Error('Resource wait connection closed before final result'));
    const { socket } = connection;
    const delivery = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.removeListener('error', finish);
        socket.removeListener('close', closed);
        if (error) reject(error); else resolve();
      };
      const closed = () => finish(new Error('Resource wait connection closed before final result'));
      const timer = setTimeout(() => process.stderr.write(`Warning: resource wait final result delivery to ${id} still pending after ${options.deliveryTimeoutMs} ms; waiting\n`), options.deliveryTimeoutMs);
      socket.once('error', finish);
      socket.once('close', closed);
      void connection.send(frame).then(() => socket.end(() => finish()), finish);
    }).finally(() => { finalDeliveries.delete(delivery); socket.destroy(); });
    finalDeliveries.add(delivery);
    return delivery;
  };
  const protocol = createResourceWaitProtocol(options, {
    monotonicNow: () => performance.now(), wallNow: now, bootIdentity: () => `${boot.machineId}/${boot.bootId}`, nextId: randomUUID,
    schedule: (at, wake) => { const timer = setTimeout(() => { void wake().catch(error => process.emitWarning(error)); }, Math.max(0, at - performance.now())); timer.unref(); return () => clearTimeout(timer); },
    readSnapshot: async requests => measureRafCost('resource-queue', async () => {
      const observedAt = performance.now();
      const paths = [...new Set([context.orchestratorRoot, homedir(), ...requests.map(request => request.developmentDirectory)])];
      const sessions = getStore().sessionRepository.transaction(tx => tx.listSessions().filter(session => session.state === 'running' && session.process), 'read');
      const [snapshot, observations] = await Promise.all([
        (resourceReader ?? createResourceSnapshotReader({ machineId: boot.machineId, paths })).read(),
        observeProcesses(sessions.map(session => session.process!)),
      ]);
      const unknown = observations.find(row => row.state === 'unknown');
      if (unknown?.state === 'unknown') snapshot.reasons.push(unknown.error);
      const observedProcesses = observations.flatMap((row, index) => row.state === 'alive' ? [{ runId: sessions[index].runId, identity: row.identity }] : []);
      return { observedAt, data: { ...snapshot, observedProcesses } };
    }),
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
    observeClients: observeWaitIdentities,
    isConnectionOpen: id => { const socket = sockets.connections.get(id)?.socket; return !!socket && !socket.destroyed && !socket.readableEnded; },
    sendOffer: async (id, offer) => {
      const connection = sockets.connections.get(id);
      if (!connection) throw new Error('Resource wait connection closed before offer');
      await connection.send({ kind: 'offer', offer });
    },
    sendWaiting: async (id, frame) => {
      const connection = sockets.connections.get(id);
      if (!connection) return;
      await connection.send({ kind: 'result', result: { requestId: frame.requestId, serviceEpoch: frame.serviceEpoch, offerId: '', deadline: 0, kind: 'waiting', admission: frame.admission } });
    },
    sendResult: async (id, result) => { await sendFinal(id, { kind: 'result', result }); },
    sendError: async (id, ticket, diagnostic) => { await sendFinal(id, { kind: 'result', result: { ...ticket, offerId: '', deadline: 0, kind: 'error', diagnostic } }); },
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
    stop: async () => {
      await protocol.stop('Service stopped');
      await Promise.allSettled([...finalDeliveries]);
      for (const { socket } of sockets.connections.values()) socket.destroy();
    },
  };
}
