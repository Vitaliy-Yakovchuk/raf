import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.RAF_TEST_RUN_WORKSPACE!;
const base = process.env.RAF_TEST_RUN_BASE_RUNNER;
const Base = base ? (await import(pathToFileURL(base).href)).default
  : (await import(pathToFileURL(resolve(root, 'node_modules/vitest/dist/index.js')).href)).TestRunner;

function tagged(error: any, origin: string): any {
  if (Array.isArray(error)) return error.map(value => tagged(value, origin));
  if (error?.rafTestOrigin) return error;
  if (origin === 'test-body' && /\b(?:resolveFixtureFunction|resolveTestFixtureValue|resolveScopeFixtureValue)\b/.test(String(error?.stack ?? ''))) origin = 'fixture-setup';
  if (!error || typeof error !== 'object') error = new Error(String(error));
  try { Object.defineProperty(error, 'rafTestOrigin', { value: origin, enumerable: true, configurable: true }); return error; }
  catch { return Object.assign(new Error(String(error.message ?? error)), { name: error.name ?? 'Error', stack: error.stack, code: error.code, rafTestOrigin: origin }); }
}

function tagResultErrors(task: any, origin: string, previous: Set<unknown> = new Set()): void {
  if (task?.type !== 'test' || !task.result?.errors) return;
  task.result.errors = task.result.errors.map((error: unknown) => previous.has(error) ? error : tagged(error, origin));
}

export default class StructuredVitestRunner extends Base {
  constructor(...args: any[]) {
    super(...args);
    const trace = this.trace.bind(this);
    this.trace = (name: string, attributes: any, callback?: () => any) => {
      const invoke = typeof attributes === 'function' ? attributes : callback!;
      const origin = name === 'test.callback' ? 'test-body'
        : /^(?:test|suite)\.(?:before|after|cleanup|onFinished|onFailed)/.test(name) ? 'hook' : 'unknown';
      const wrapped = () => {
        const task = this.constructor.getCurrentTest?.() ?? this.workerState?.current;
        const previous = new Set(task?.result?.errors ?? []);
        const collected = () => { if (origin !== 'unknown') tagResultErrors(task, origin, previous); };
        try {
          const result = invoke();
          if (result && typeof result.then === 'function') return Promise.resolve(result).catch((error: unknown) => { throw tagged(error, origin); }).finally(collected);
          collected();
          return result;
        } catch (error) { collected(); throw tagged(error, origin); }
      };
      return typeof attributes === 'function' ? trace(name, wrapped) : trace(name, attributes, wrapped);
    };
  }

  async onAfterTryTask(...args: any[]): Promise<void> {
    try { await super.onAfterTryTask?.(...args); }
    catch (error) { throw tagged(error, 'test-body'); }
    finally { tagResultErrors(args[0], 'test-body'); }
  }

  async importFile(filepath: string, source: string): Promise<unknown> {
    try { return await super.importFile(filepath, source); }
    catch (error) { throw tagged(error, source === 'setup' ? 'fixture-setup' : 'import'); }
  }
}
