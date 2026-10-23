import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { fixture } from './production-fixture.ts';

export async function productionCodexQaFixture(t: TestContext) {
  const f = await fixture(t, { productionQa: true });
  const codeRoot = f.cwd;
  const runtimeUrl = pathToFileURL(join(codeRoot, 'src', 'production-runtime.ts')).href;
  const { createProductionServices } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
  return {
    ...f,
    runtimeUrl,
    appRuntimeUrl: pathToFileURL(join(codeRoot, 'src', 'app-runtime.ts')).href,
    storeUrl: pathToFileURL(join(codeRoot, 'src', 'state-store.ts')).href,
    createProductionServices,
  };
}
