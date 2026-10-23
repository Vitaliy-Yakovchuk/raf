import { readFile } from 'node:fs/promises';
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
    return await runResourceWaitCommand({ level: input.level, developmentDirectory: directory, clientIdentity: await readWaitIdentity(), connectionId: '', signal: controller.signal }, options, {
      ensureReady: service.ensureResourceReady,
      connect: connectResourceWait,
      recordDuration: () => {},
    });
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    input.signal?.removeEventListener('abort', abort);
  }
}
