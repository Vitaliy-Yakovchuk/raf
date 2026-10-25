import type { CatalogHandlerBinding } from './catalog-generator.ts';
import type { Handler } from './cli.ts';

export function productionBindings(dispatch: (name: string, params: Record<string, unknown>) => unknown | Promise<unknown> = async () => {
  throw new Error('Production dispatch requires an execution context');
}): readonly CatalogHandlerBinding[] {
  const bind = (...path: string[]): CatalogHandlerBinding => ({ path, load: async (): Promise<Handler> => params => dispatch(path.join(' '), params) });
  return [
    bind('agent', 'run'), bind('agent', 'ps'), bind('agent', 'update'), bind('agent', 'message'), bind('agent', 'close'), bind('agent', 'interrupt'),
    bind('main', 'attach'), bind('runner', 'enable'), bind('runner', 'disable'), bind('runner', 'list'), bind('runner', 'limits'),
    bind('command', 'stats'), bind('resource', 'wait'), bind('service', 'start'), bind('service', 'status'), bind('service', 'stop'), bind('test', 'run'),
    bind('reminder', 'add'), bind('reminder', 'list'), bind('reminder', 'update'), bind('reminder', 'activate'), bind('reminder', 'close'), bind('reminder', 'reassign'), bind('reminder', 'close-all'),
    bind('bug', 'list'), bind('bug', 'show'), bind('bug', 'comment', 'add'), bind('bug', 'status', 'set'), bind('bug', 'attachment', 'get'),
  ];
}
