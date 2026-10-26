import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { configureLiveCodexTrust } from '../test/helpers/z4044-live-trust.mjs';

export async function configureLiveAdapter(cfg: any, configRoot: string, runner: string, raf: any) {
  const models = JSON.parse(await fs.readFile(join(configRoot, 'models.json'), 'utf8'));
  models.models = models.models.filter((m: any) => m.runner === runner);
  models.runners = models.runners.filter((r: any) => r.id === runner).map((r: any) => ({ ...r, initialEnabled: true }));
  assert.ok(models.models.length, 'No configured model for this runner');
  await fs.writeFile(join(cfg.root, 'conf/models.json'), JSON.stringify(models));
  const settings = { ...raf, runnerProtocols: raf.runnerProtocols.filter((p: any) => p.runner === runner) };
  const trust = runner === 'codex' ? configureLiveCodexTrust(settings, cfg.root) : undefined;
  await fs.writeFile(join(cfg.root, 'conf/raf.json'), JSON.stringify(settings));
  await fs.copyFile(join(configRoot, 'flow.json'), join(cfg.root, 'conf/flow.json'));
  await fs.mkdir(join(cfg.root, 'conf/briefs/runners'), { recursive: true });
  await fs.copyFile(join(configRoot, 'briefs/runners', runner + '.md'), join(cfg.root, 'conf/briefs/runners', runner + '.md'));
  return { trust };
}
