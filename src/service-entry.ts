import { prepareMainLayoutForProductionStart } from './production-start-layout.ts';
import { acquireHotfixReader } from './hotfix-activation.ts';
import { productionStateContext, stateContextEnvironment, stateFailure } from './state-migration-guard.ts';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspacePorts } from './os-runtime.ts';
import { createBackgroundRuntime, runServiceHost } from './background-runtime.ts';
import { resolveWorkspaceRoute, type WorkspaceProjectsConfig } from './workspace-routing.ts';
import { commandFailure } from './cli-contract.ts';
import type { Handler } from './cli.ts';
import type { ServiceHostOptions, ServiceRequest, ServiceResponse } from './background-runtime.ts';

export type ServiceEntryContext = {
  orchestratorRoot: string;
  homeDirectory: string;
  stateDirectory: string;
  socketPath: string;
};

export type ServicePorts = ServiceHostOptions['handlers'];

export type ServiceHandlerOptions = {
  orchestratorRoot: string;
  homeDirectory: string;
  service: { entryRelativePath: string; readinessTimeoutMs: number };
  hostModulePath?: string;
};

export type ServiceHandlers = {
  handlers: Record<'service start' | 'service status' | 'service stop', Handler>;
  request: (request: ServiceRequest, options?: { signal?: AbortSignal }) => Promise<ServiceResponse>;
  ensureResourceReady: (signal?: AbortSignal) => Promise<import('./resource-wait-protocol.ts').ResourceWaitEndpoint>;
};

export function createServiceHandlers(
  options: ServiceHandlerOptions,
  dependencies?: { spawn?: typeof spawn; nodeExecutable?: string },
): ServiceHandlers {
  for (const [name, path] of Object.entries({ orchestratorRoot: options.orchestratorRoot, homeDirectory: options.homeDirectory })) {
    if (!isAbsolute(path)) throw new Error(`Absolute ${name} required for service`);
  }
  if (!options.service || !Number.isFinite(options.service.readinessTimeoutMs) || options.service.readinessTimeoutMs <= 0 || typeof options.service.entryRelativePath !== 'string' || !options.service.entryRelativePath || isAbsolute(options.service.entryRelativePath)) throw new Error('Invalid configured service entryRelativePath or readinessTimeoutMs');
  if (options.hostModulePath !== undefined && !isAbsolute(options.hostModulePath)) throw new Error('Absolute service hostModulePath required');
  const stateContext = productionStateContext(options.orchestratorRoot, fileURLToPath(import.meta.url), options.homeDirectory, 'service-store');
  const stateDirectory = join(options.homeDirectory, '.raf');
  const socketPath = join(stateDirectory, 'service.sock');
  let bootstrapLease: { release(): Promise<void> } | undefined;
  const releaseBootstrap = async () => { const lease = bootstrapLease; bootstrapLease = undefined; await lease?.release(); };
  const runtime = createBackgroundRuntime({ ...options.service, stateDirectory, socketPath }, {
    resolveMainPath: async signal => {
      const config = JSON.parse(await fs.readFile(join(options.orchestratorRoot, 'conf', 'projects.json'), 'utf8')) as WorkspaceProjectsConfig;
      if (!config || typeof config.projects !== 'object' || config.projects === null) throw new Error('Invalid projects.json configuration for raf main');
      const route = await resolveWorkspaceRoute({ root: options.orchestratorRoot, project: 'raf', branch: 'main' }, config, createWorkspacePorts());
      if (!route.ok) {
        if (stateContext.mode === 'qa' && config.projects.raf.branchPaths?.main && stateContext.codeRoot === await fs.realpath(join(options.orchestratorRoot, config.projects.raf.branchPaths.main))) return stateContext.codeRoot;
        throw new Error(`${route.error.code}: ${route.error.message}`);
      }
      const lease = await acquireHotfixReader({ orchestratorRoot: options.orchestratorRoot, qaHome: options.homeDirectory, environment: {}, sandboxExecutable: 'codex' }, 'service');
      if (signal?.aborted) { await lease.release(); throw new Error('Resource wait service startup cancelled'); }
      await releaseBootstrap();
      bootstrapLease = lease;
      return lease.generationRoot;
    },
    nodeExecutable: dependencies?.nodeExecutable,
    spawn: ((command, args, settings) => {
      const environment = stateContextEnvironment(stateContext, { ...process.env, ...settings?.env }) as NodeJS.ProcessEnv;
      delete environment.RAF_SERVICE_HOST_MODULE_PATH;
      if (options.hostModulePath) environment.RAF_SERVICE_HOST_MODULE_PATH = options.hostModulePath;
      return (dependencies?.spawn ?? spawn)(command, args, { ...settings, env: environment });
    }) as typeof spawn,
  });
  const invoke = (operation: 'start' | 'status' | 'stop'): Handler => async () => {
    const result = await runtime[operation]().finally(releaseBootstrap);
    if (result.exitCode !== 0) throw commandFailure({
      code: 'SERVICE_OPERATION_FAILED', message: result.reason, stage: operation, source: 'background-runtime', sourceCode: result.exitCode,
      reason: result.details, received: null, expected: null, found: null, completed: [], pending: [`service ${operation}`], retrySafe: false,
      remediation: [result.remediation],
    });
    return result;
  };
  const ensureResourceReady = async (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('Resource wait service startup cancelled');
    const result = await runtime.ensureReady({ signal }).finally(releaseBootstrap);
    if (result.exitCode !== 0 || result.state !== 'ready' || !result.serviceEpoch || !result.resourceWaitReady) throw new Error(`Resource wait service readiness failed: ${JSON.stringify(result)}`);
    return { endpoint: socketPath, serviceEpoch: result.serviceEpoch };
  };
  const request: ServiceHandlers['request'] = async (request, requestOptions) => {
    if (requestOptions?.signal?.aborted) throw new Error('Service request cancelled');
    return runtime.request(request, requestOptions).finally(releaseBootstrap);
  };
  return { ensureResourceReady, handlers: { 'service start': invoke('start'), 'service status': invoke('status'), 'service stop': invoke('stop') }, request };
}

export async function runServiceEntry(options?: {
  environment?: NodeJS.ProcessEnv;
  loadPorts?: (modulePath: string, context: ServiceEntryContext) => Promise<ServicePorts>;
}): Promise<{ close: () => Promise<void>; closed: Promise<void> }> {
  const environment = options?.environment ?? process.env;
  const required = (name: string): string => {
    const value = environment[name];
    if (!value || !isAbsolute(value)) throw new Error(`Service bootstrap requires absolute ${name}`);
    return value;
  };
  const context: ServiceEntryContext = {
    orchestratorRoot: await fs.realpath(required('RAF_ORCHESTRATOR_ROOT')).catch((error: NodeJS.ErrnoException) => { throw error.code === 'ENOENT' ? new Error(`Service bootstrap RAF_ORCHESTRATOR_ROOT does not exist: ${environment.RAF_ORCHESTRATOR_ROOT}`) : error; }), homeDirectory: required('RAF_HOME_DIRECTORY'),
    stateDirectory: required('RAF_STATE_DIRECTORY'), socketPath: required('RAF_SOCKET_PATH'),
  };
  const stateContext = productionStateContext(context.orchestratorRoot, fileURLToPath(import.meta.url), context.homeDirectory, 'service-store', environment);
  if (context.stateDirectory !== join(stateContext.homeDirectory, '.raf') || context.socketPath !== join(context.stateDirectory, 'service.sock')) throw stateFailure('STATE_CONTEXT_REFUSED', 'Service bootstrap paths differ from selected state context');
  required('RAF_MAIN_PATH');
  const modulePath = required('RAF_SERVICE_HOST_MODULE_PATH');
  await prepareMainLayoutForProductionStart({ orchestratorRoot: context.orchestratorRoot });
  const loadPorts = options?.loadPorts ?? (async (path: string, value: ServiceEntryContext): Promise<ServicePorts> => {
    const module = await import(pathToFileURL(path).href);
    if (typeof module.createServicePorts !== 'function') throw new Error(`Service host module ${path} must export createServicePorts`);
    return await module.createServicePorts(value);
  });
  const ports = await loadPorts(modulePath, context);
  if (!ports || ['recover', 'handle', 'shutdown'].some(name => typeof ports[name as keyof ServicePorts] !== 'function')) throw new Error('Service host createServicePorts must provide recover, handle and shutdown callbacks');
  return runServiceHost({ stateDirectory: context.stateDirectory, socketPath: context.socketPath, handlers: ports });
}
