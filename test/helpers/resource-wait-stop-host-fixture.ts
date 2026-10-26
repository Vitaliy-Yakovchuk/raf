import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBackgroundRuntime, runServiceHost } from '../../src/background-runtime.ts';
import { productionResourceWait } from '../../src/production-resource-wait.ts';
import {
  readResourceWaitProtocolOptions, runResourceWaitCommand,
  type ResourceWaitCommandPorts,
} from '../../src/resource-wait-protocol.ts';
import { connectResourceWait } from '../../src/resource-wait-transport.ts';
import { readWaitIdentity } from '../../src/resource-wait-identity.ts';
import { openStateStore } from '../../src/state-store.ts';

const configuration = JSON.parse(process.env.RAF_STOP_HOST_FIXTURE!);
const { root, workspace, home, state, socket, level } = configuration;
const constants = JSON.parse(await readFile(join(root, 'conf/raf-constants.json'), 'utf8'));
const raf = JSON.parse(await readFile(join(root, 'conf/raf.json'), 'utf8'));
const options = readResourceWaitProtocolOptions({ constants, raf });
const runtime = createBackgroundRuntime({
  stateDirectory: state, socketPath: socket,
  entryRelativePath: 'test/helpers/resource-wait-stop-host-fixture.ts',
  readinessTimeoutMs: options.readinessTimeoutMs,
}, { resolveMainPath: async () => workspace });

if (process.argv[2] === 'client') {
  const identity = await readWaitIdentity();
  const received: unknown[] = [];
  const ports: ResourceWaitCommandPorts = {
    ensureReady: async () => {
      const status = await runtime.status();
      if (status.exitCode !== 0 || status.state !== 'ready' || !status.serviceEpoch) {
        throw new Error(`Fixture host is not ready: ${JSON.stringify(status)}`);
      }
      return { endpoint: socket, serviceEpoch: status.serviceEpoch };
    },
    connect: async endpoint => {
      const connection = await connectResourceWait(endpoint);
      return {
        sendReady: offer => connection.sendReady(offer),
        cancel: ticket => connection.cancel(ticket),
        close: () => connection.close(),
        enqueue: async request => {
          const ticket = await connection.enqueue(request);
          await writeFile(join(state, 'client-enqueued.json'), JSON.stringify(ticket));
          return ticket;
        },
        receive: async () => {
          const message = await connection.receive();
          received.push(message);
          return message;
        },
      };
    },
    recordDuration: () => { throw new Error('Resource wait must not record command duration'); },
  };
  const result = await runResourceWaitCommand({
    level, clientIdentity: identity, connectionId: `stop-host-${process.pid}`,
    developmentDirectory: workspace,
  }, options, ports);
  process.stdout.write(JSON.stringify({ result, received }) + '\n');
  process.exitCode = result.exitCode;
} else {
  const store = openStateStore(join(state, 'state.sqlite'));
  const queue = await productionResourceWait({
    orchestratorRoot: root, homeDirectory: home, stateDirectory: state, socketPath: socket,
  }, options, () => store, {
    read: async () => {
      const snapshot = {
        measurement: {
          machineId: (await readWaitIdentity()).machineId,
          loadAverage1m: 0, availableCores: 1,
          totalRamBytes: 8 * 1024 ** 3, availableRamBytes: 0,
          memoryPressure: 'critical' as const,
          fileSystems: [{ id: 'fixture-fs', totalBytes: 1024 ** 4, availableBytes: 512 * 1024 ** 3 }],
        },
        reasons: [],
        fileSystemByPath: Object.fromEntries([root, workspace, home, state].map(path => [path, 'fixture-fs'])),
      };
      await writeFile(join(state, 'no-resources.json'), JSON.stringify(snapshot));
      return snapshot;
    },
  });
  const host = await runServiceHost({
    stateDirectory: state, socketPath: socket,
    handlers: {
      recover: async bootstrap => {
        if (!bootstrap?.serviceEpoch) throw new Error('Fixture requires a real service epoch');
        await queue.start(bootstrap.serviceEpoch);
      },
      resourceWait: queue.attach,
      handle: async request => { throw new Error(`Unexpected fixture operation: ${request.operation}`); },
      shutdown: async () => { await queue.stop(); store.close(); },
    },
  });
  await host.closed;
}
