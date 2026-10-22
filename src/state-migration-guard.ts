export type StateEntryPoint = 'cli' | 'runner-limits' | 'worker' | 'service-store' | 'notice' | 'hook';

export interface StateContextRequest {
  orchestratorRoot: string;
  modulePath: string;
  homeDirectory: string;
  operatingSystemHome: string;
  environment: Readonly<Record<string, string | undefined>>;
  entryPoint: StateEntryPoint;
}

export interface StateContext {
  mode: 'production' | 'qa';
  orchestratorRoot: string;
  codeRoot: string;
  homeDirectory: string;
  statePath: string;
  tmpRoot: string;
  tmuxSocketPath: string;
}

export interface StateTransferPermit {
  statePath: string;
  fromVersion: number;
  toVersion: number;
}

export interface StateStoreOpenOptions {
  context?: StateContext;
  transfer?: StateTransferPermit;
  afterMigrationStep?: (version: number) => void;
}

export function resolveStateContext(request: StateContextRequest): StateContext {
  throw new Error('NotImplemented');
}

export function verifyStateContext(context: StateContext): void {
  throw new Error('NotImplemented');
}

export function stateContextEnvironment(context: StateContext, inherited: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  throw new Error('NotImplemented');
}
