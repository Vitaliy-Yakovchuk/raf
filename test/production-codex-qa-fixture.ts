import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { fixture } from './production-fixture.ts';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';

export async function productionCodexQaFixture(t: TestContext) {
  const f = await fixture(t, { tmpRootInHome: true });
  const projects = JSON.parse(await readFile(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
  await writeFile(join(f.confRoot, 'projects.json'), JSON.stringify(projects));
  await prepareProductionQaFixture(t, f);
  const codeRoot = join(f.root, projects.projects.raf.branchPaths.develop);
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
