import { enableCompileCache } from 'node:module';

export function nodeHelperEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (environment.NODE_COMPILE_CACHE || environment.NODE_DISABLE_COMPILE_CACHE) return environment;
  const cache = enableCompileCache();
  if (!cache.directory) return environment;
  return { ...environment, NODE_COMPILE_CACHE: cache.directory };
}
