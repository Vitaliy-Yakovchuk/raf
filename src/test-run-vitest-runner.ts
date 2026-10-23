import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Preserve the reviewed workspace runner (including Etchly's file budget).
// Reporter callbacks receive batched final results, so hook provenance must be
// attached in the worker before Vitest serializes errors.
const root = process.env.RAF_TEST_RUN_WORKSPACE!;
const base = process.env.RAF_TEST_RUN_BASE_RUNNER;
const Base = base ? (await import(pathToFileURL(base).href)).default
  : (await import(pathToFileURL(resolve(root, 'node_modules/vitest/dist/index.js')).href)).TestRunner;

function tagged(error: any, origin: string): any {
  if (Array.isArray(error)) return error.map(value => tagged(value, origin));
  if (error?.rafTestOrigin) return error;
  // Vitest resolves test.extend fixtures inside the callback wrapper. A failure
  // in that resolver is preparation, even when its exception is AssertionError.
  if (origin === 'test-body' && /\b(?:resolveFixtureFunction|resolveTestFixtureValue|resolveScopeFixtureValue)\b/.test(String(error?.stack ?? ''))) origin = 'fixture-setup';
  if (!error || typeof error !== 'object') error = new Error(String(error));
  try { Object.defineProperty(error, 'rafTestOrigin', { value: origin, enumerable: true, configurable: true }); return error; }
  catch { return Object.assign(new Error(String(error.message ?? error)), { name: error.name ?? 'Error', stack: error.stack, code: error.code, rafTestOrigin: origin }); }
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
        try {
          const result = invoke();
          return result && typeof result.then === 'function' ? Promise.resolve(result).catch((error: unknown) => { throw tagged(error, origin); }) : result;
        } catch (error) { throw tagged(error, origin); }
      };
      return typeof attributes === 'function' ? trace(name, wrapped) : trace(name, attributes, wrapped);
    };
  }

  async onAfterTryTask(...args: any[]): Promise<void> {
    try { await super.onAfterTryTask?.(...args); }
    catch (error) { throw tagged(error, 'test-body'); }
  }
}
