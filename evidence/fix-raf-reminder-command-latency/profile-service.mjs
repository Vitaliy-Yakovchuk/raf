// Controlled resource-queue load; never connects to production agents or service.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [codeRoot, root, home] = process.argv.slice(2);
process.env.HOME = process.env.RAF_QA_HOME = home;
const { createServicePorts } = await import(pathToFileURL(join(codeRoot, 'src/service-host.ts')));
let polls = 0;
const clients = Array.from({ length: 30 }, () => new AbortController());
const schedule = (at, wake) => { const timer = setTimeout(() => void wake(), Math.max(0, at - Date.now())); return () => clearTimeout(timer); };
const ports = await createServicePorts({ orchestratorRoot: root, homeDirectory: home, stateDirectory: join(home, '.raf'), socketPath: join(home, '.raf/service.sock') }, {
  now: Date.now, schedule,
  resourceWait: {
    readSnapshot: async () => { polls++; return { status: 'NO_RESOURCES', reason: 'Controlled profile queue' }; },
    isClientAlive: () => true, watchResources: () => () => {}, schedule,
    loadLastGrant: () => null, saveLastGrant: () => {},
  },
});
await ports.recover();
const pending = clients.map((controller, i) => ports.handle({ operation: 'resource.wait', payload: { level: 'normal' } }, { clientId: `profile-${i}`, signal: controller.signal }).catch(() => {}));
// Use the configured host cadence; the 30 resource requests keep the queue loaded.
process.send({ ready: true, queuedClients: clients.length });
process.once('message', async () => {
  for (const client of clients) client.abort();
  await Promise.all(pending);
  await ports.shutdown();
  process.send({ stopped: true, resourcePolls: polls });
  process.disconnect();
});
