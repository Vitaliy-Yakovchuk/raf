import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { probeRunnerAvailability, type RunnerAvailabilityDependencies } from '../src/runner-availability.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

export async function prepareLiveReleaseCandidate<T>(build: () => void | Promise<void>, prepare: () => Promise<T>): Promise<T> {
  await build();
  return prepare();
}

export function copyLiveReleaseArtifacts(source: string, destination: string) {
  assert.notEqual(path.resolve(source), path.resolve(destination));
  const artifacts = path.join(source, 'dist');
  assert.ok(existsSync(path.join(artifacts, 'catalog.json')), 'Build the current source catalog before preparing the inactive slot');
  rmSync(path.join(destination, 'dist'), { recursive: true, force: true });
  cpSync(artifacts, path.join(destination, 'dist'), { recursive: true, dereference: false });
}

export function prepareFailedNativeClose(session: { addressId: string; runId: string; result?: { status: string } }) {
  assert.equal(session.addressId, 'sym72-native');
  assert.equal(session.runId, '566b52f3-80eb-4193-8140-e38e2bcb64e1');
  assert.equal(session.result?.status, 'failed');
  return ['agent', 'close', '--id', session.addressId, '--force', '--reason',
    'QA 7.2: accepted failed attempt 566b52f3-80eb-4193-8140-e38e2bcb64e1 used an invalid fixture main recipient; retain its original failed evidence before the first two-switch actor.'];
}

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

export async function archiveFailedLiveReport(reportPath: string, archivePath: string, close: () => Promise<void>) {
  const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const sha256 = digest(reportPath);
  cpSync(reportPath, archivePath);
  await close();
  assert.equal(digest(archivePath), sha256);
  return { archivePath, sha256 };
}

export function describeFailedLiveAttempt(session: { runId: string; result?: { status: string }; launchContext?: { reportPath: string } }) {
  assert.equal(session.result?.status, 'failed');
  return { runId: session.runId, ...(session.launchContext ? { report: session.launchContext.reportPath } : {}), status: session.result.status };
}
