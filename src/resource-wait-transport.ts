import { verifyWaitPeer } from './resource-wait-identity.ts';
import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { ResourceWaitClientConnection, ResourceWaitEndpoint, ResourceWaitProtocol, ResourceWaitRequest } from './resource-wait-protocol.ts';

export function jsonChannel(socket: Socket) {
  let buffer = '';
  let ended = false;
  const messages: any[] = [];
  const receivers: ((message: any) => void)[] = [];
  const publish = (message: any) => { const receiver = receivers.shift(); if (receiver) receiver(message); else messages.push(message); };
  const close = () => { if (!ended) { ended = true; publish({ kind: 'closed', reason: 'Service connection lost before confirmed permit' }); } };
  socket.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { publish(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
  });
  socket.on('error', close); socket.on('close', close); socket.on('end', close);
  return {
    receive: () => messages.length ? Promise.resolve(messages.shift()) : ended ? Promise.resolve({ kind: 'closed', reason: 'Service connection closed' }) : new Promise<any>(resolve => receivers.push(resolve)),
    send: (value: unknown) => new Promise<void>((resolve, reject) => { if (socket.destroyed) reject(new Error('Connection closed')); else socket.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()); }),
  };
}

export async function connectResourceWait(endpoint: ResourceWaitEndpoint): Promise<ResourceWaitClientConnection> {
  const socket = createConnection(endpoint.endpoint);
  const channel = jsonChannel(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return {
    enqueue: async request => {
      const { signal, ...payload } = request;
      await channel.send({ kind: 'resource-wait', epoch: endpoint.serviceEpoch, request: payload });
      const reply = await channel.receive();
      if (request.workload === 'test' && reply.workload !== 'test') throw new Error('Resource wait service does not support test workload priority');
      if (reply.kind !== 'ticket') throw new Error(reply.details ?? reply.reason ?? 'Resource wait handshake rejected');
      return reply.ticket;
    },
    receive: channel.receive,
    sendReady: offer => channel.send({ kind: 'ready', offer }),
    cancel: ticket => channel.send({ kind: 'cancel', ticket }),
    close: async () => { socket.destroy(); },
  };
}

export function createResourceWaitSocketHost(getProtocol: () => ResourceWaitProtocol, getEpoch: () => string, deliveryTimeoutMs: number) {
  const connections = new Map<string, ReturnType<typeof jsonChannel> & { socket: Socket }>();
  return {
    connections,
    attach: async (socket: Socket, input: { epoch: string; request: ResourceWaitRequest }, signal: AbortSignal) => {
      const protocol = getProtocol();
      if (input.epoch !== getEpoch()) throw new Error('Stale resource wait service epoch');
      await verifyWaitPeer(socket, input.request.clientIdentity, deliveryTimeoutMs);
      if (signal.aborted) throw new Error('Client disconnected during peer verification');
      const id = randomUUID();
      const channel = jsonChannel(socket);
      connections.set(id, { ...channel, socket });
      const disconnect = () => { connections.delete(id); void protocol.disconnect(id); };
      signal.addEventListener('abort', disconnect, { once: true });
      try {
        const ticket = protocol.enqueue({ ...input.request, connectionId: id, signal });
        await channel.send({ kind: 'ticket', ticket, workload: input.request.workload ?? 'agent' });
        for (;;) {
          const frame = await channel.receive();
          if (frame.kind === 'closed') break;
          if (frame.kind === 'ready') void protocol.ready(frame.offer, input.request.clientIdentity).catch(() => socket.destroy());
          else if (frame.kind === 'cancel') void protocol.cancel(frame.ticket, input.request.clientIdentity, 'Client cancelled').catch(() => socket.destroy());
          else throw new Error('Unknown resource wait frame');
        }
      } finally { signal.removeEventListener('abort', disconnect); disconnect(); }
    },
  };
}
