import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceHandlers } from './service-entry.ts';
import { readWaitIdentity } from './resource-wait-identity.ts';
import { readResourceWaitProtocolOptions, runResourceWaitCommand } from './resource-wait-protocol.ts';
import { connectResourceWait } from './resource-wait-transport.ts';

export async function waitForResources(input: {
  orchestratorRoot: string;
  homeDirectory: string;
  developmentDirectory?: string;
  level: string;
  workload?: 'test' | 'agent';
  hostModulePath?: string;
  signal?: AbortSignal;
}) {
  const [constants, raf] = await Promise.all(['raf-constants.json', 'raf.json'].map(async name => JSON.parse(await readFile(join(input.orchestratorRoot, 'conf', name), 'utf8'))));
  const options = readResourceWaitProtocolOptions({ constants, raf });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    const directory = input.developmentDirectory ?? process.cwd();
    if (!isAbsolute(directory)) throw new Error('Absolute resource wait development directory required');
    const service = createServiceHandlers({ ...input, service: raf.service, hostModulePath: input.hostModulePath ?? fileURLToPath(new URL('./production-service-ports.ts', import.meta.url)) });
    const refreshEndpoint = async () => {
      const status = await service.handlers['service status']({}) as import('./background-runtime.ts').ServiceStatus;
      return status.exitCode === 0 && status.state === 'ready' && status.resourceWaitReady && status.serviceEpoch
        ? { endpoint: join(input.homeDirectory, '.raf', 'service.sock'), serviceEpoch: status.serviceEpoch } : null;
    };
    return await runResourceWaitCommand({ level: input.level, workload: input.workload ?? 'agent', developmentDirectory: directory, clientIdentity: await readWaitIdentity(), connectionId: '', signal: controller.signal }, options, {
      ensureReady: service.ensureResourceReady,
      connect: connectResourceWait,
      refreshEndpoint,
      watchService: async (endpoint, signal) => {
        for (;;) {
          await pause(options.hostTickIntervalMs, undefined, { signal });
          const current = await refreshEndpoint();
          if (current && current.serviceEpoch !== endpoint.serviceEpoch) return current;
        }
      },
      recordDuration: () => {},
    });
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    input.signal?.removeEventListener('abort', abort);
  }
}
