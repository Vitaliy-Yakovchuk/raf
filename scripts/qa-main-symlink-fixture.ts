import assert from 'node:assert/strict';
import path from 'node:path';
import { probeRunnerAvailability, type RunnerAvailabilityDependencies } from '../src/runner-availability.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

export async function prepareLiveMainAvailability(protocol: Pick<ProtocolSettings, 'runner' | 'executable' | 'version'>, dependencies: RunnerAvailabilityDependencies) {
  const availability = await probeRunnerAvailability(protocol, dependencies);
  assert.ok(availability.available, availability.available ? '' : availability.reason);
  return availability;
}

export function prepareLiveProjects(configuration: { projects: Record<string, any> }) {
  const projects = structuredClone(configuration);
  Object.assign(projects.projects.raf, {
    path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' },
    mainCopies: ['raf-main-a', 'raf-main-b'],
  });
  return projects;
}

export function prepareLegacyLiveProjects(configuration: { projects: Record<string, any> }) {
  const projects = prepareLiveProjects(configuration);
  delete projects.projects.raf.mainCopies;
  return projects;
}

export function prepareLiveMainInvocation(protocol: { executable: string; baseArgs: string[]; sessionIdFlag: string | null }, selectors: Record<string, string | undefined>, sessionId: string) {
  const env: Record<string, string> = {};
  for (const key of ['CODEX_HOME']) {
    const value = selectors[key];
    assert.ok(value && path.isAbsolute(value), key + ' must be an absolute existing host selector');
    env[key] = value;
  }
  if (selectors.CLAUDE_CONFIG_DIR !== undefined) {
    assert.ok(path.isAbsolute(selectors.CLAUDE_CONFIG_DIR), 'CLAUDE_CONFIG_DIR must be an absolute existing host selector');
    env.CLAUDE_CONFIG_DIR = selectors.CLAUDE_CONFIG_DIR;
  } else {
    assert.ok(selectors.HOME && path.isAbsolute(selectors.HOME), 'HOME must be an absolute host selector when CLAUDE_CONFIG_DIR is unset');
    env.HOME = selectors.HOME;
  }
  assert.ok(protocol.executable && protocol.sessionIdFlag, 'Native Claude protocol must support an assigned session');
  assert.match(sessionId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  return { executable: protocol.executable,
    args: [...protocol.baseArgs, protocol.sessionIdFlag, sessionId, 'Ти — main-приймач ізольованого QA-стенда. На кожне повідомлення відповідай лише ACK і чекай наступного. Не використовуй інструментів, не запускай команд, не змінюй файлів або налаштувань.'], env };
}
