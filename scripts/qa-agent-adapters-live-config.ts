import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { configureLiveCodexTrust } from '../test/helpers/z4044-live-trust.mjs';

export function verifyNativeDocumentSession(session: any, runner: string, phase: string) {
  assert.equal(session.process.runner, runner);
  assert.ok(session.process.runnerSessionId, 'Actual native identity required');
  const assignment = session.launchContext?.testAssignment;
  assert.ok(assignment, 'Persisted launch assignment required');
  assert.equal(assignment.runId, session.runId);
  assert.equal(assignment.project, 'raf');
  assert.equal(assignment.type, phase);
  assert.equal(assignment.phase, phase);
}

export async function prepareLiveNativeEnvironment(directory: string, runner: string, selectors: Record<string, string | undefined>, executable: string) {
  if (runner === 'codex') assert.ok(selectors.CODEX_HOME, 'Set the existing CODEX_HOME auth selector on the host');
  if (runner === 'claude' && selectors.CLAUDE_CONFIG_DIR !== undefined) assert.ok(selectors.CLAUDE_CONFIG_DIR, 'An explicit CLAUDE_CONFIG_DIR must not be empty');
  if (runner !== 'claude' || selectors.CLAUDE_CONFIG_DIR !== undefined) return { runner, executable, selector: runner === 'claude' ? 'CLAUDE_CONFIG_DIR' : runner === 'codex' ? 'CODEX_HOME' : null };
  const ownerHome = selectors.HOME;
  assert.ok(ownerHome && isAbsolute(ownerHome), 'Default Claude configuration requires the existing absolute host HOME');
  assert.ok((await fs.stat(ownerHome)).isDirectory(), 'Default Claude host HOME must already exist');
  assert.ok(isAbsolute(executable) && (await fs.stat(executable)).isFile(), 'Use the resolved actual native executable');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const wrapper = join(directory, 'bin/claude');
  await fs.writeFile(wrapper, '#!/bin/sh\nHOME=' + quote(ownerHome) + '\nexport HOME\nexec ' + quote(executable) + ' "$@"\n', { mode: 0o700 });
  return { runner, executable, selector: 'HOME', wrapper, hostHome: ownerHome, boundary: 'Only the native Claude process retains the existing owner HOME; raf state remains selected by isolated RAF_QA_HOME. No credentials or config are copied.' };
}

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
