import type { DeliveryReceipt } from './agent-control.ts';
import { withProductionRuntime } from './production-entry.ts';
import { rafSystemCaller } from './production-runtime.ts';

export type MainSessionContext = {
  orchestratorRoot: string;
  homeDirectory: string;
  artifactPath: string;
};

export class NotImplementedError extends Error {
  constructor(name: string) {
    super(`NotImplemented: ${name}`);
    this.name = 'NotImplementedError';
  }
}

export async function sendSystemMessageToMain(context: MainSessionContext, text: string): Promise<DeliveryReceipt> {
  const options = { orchestratorRoot: context.orchestratorRoot, homeDirectory: context.homeDirectory, artifactPath: context.artifactPath };
  return withProductionRuntime(options, async () => rafSystemCaller, async runtime => await runtime.handlers['agent message']({ to: 'main', text }) as DeliveryReceipt);
}
