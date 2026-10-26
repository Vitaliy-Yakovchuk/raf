import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, rmSync, readFileSync, mkdirSync, realpathSync, copyFileSync, constants } from 'node:fs';
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

export function liveControlLabel(prefix: string, label: string) {
  return prefix + label;
}

export function guardLiveNativeWait(label: string, completion: { released: boolean; pending: readonly string[]; actorRunId: string; acceptedRunId?: string; acceptedStatus?: string }, inspect: () => void) {
  if (completion.released && ['cleanup-actor', 'cleanup-service'].includes(label)) {
    assert.deepEqual(completion.pending, []);
    assert.equal(completion.acceptedRunId, completion.actorRunId);
    assert.equal(completion.acceptedStatus, 'succeeded');
    return;
  }
  inspect();
}

export type LiveServiceHandoverPorts = {
  current(): Promise<any>;
  prepare(expected: string): Promise<{ mainPath: string; pid: number; restored: boolean }>;
  stop(): Promise<any>;
  activate(): Promise<any>;
};

export async function handoverLiveService(expected: string, ports: LiveServiceHandoverPorts) {
  const previous = await ports.current();
  assert.equal(previous.state, 'ready');
  assert.equal(previous.resourceWaitReady, true);
  if (previous.mainPath === expected) return previous;
  const prepared = await ports.prepare(expected);
  assert.equal(prepared.mainPath, expected);
  assert.equal(prepared.restored, true);
  assert.ok(Number.isSafeInteger(prepared.pid) && prepared.pid > 0 && prepared.pid !== previous.pid);
  const stopped = await ports.stop();
  assert.equal(stopped.state, 'stopped');
  const current = await ports.activate();
  assert.equal(current.state, 'ready');
  assert.equal(current.mainPath, expected);
  assert.equal(current.pid, prepared.pid);
  assert.equal(current.resourceWaitReady, true);
  assert.notEqual(current.serviceEpoch, previous.serviceEpoch);
  return current;
}

export function parseLiveMainRecord(capture: any) {
  assert.equal(capture.cliExitCode, 0);
  assert.equal(capture.signal, null);
  assert.equal(capture.error, null);
  const record = JSON.parse(capture.stdout);
  assert.equal(record.id, 'main');
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
  assert.ok(typeof record.tmuxSocket === 'string' && path.isAbsolute(record.tmuxSocket));
  assert.ok(typeof record.bootId === 'string' && record.bootId.length > 0);
  return record;
}

export function prepareLiveVerificationHost(liveHost: any, verificationHome: string, mainSession: any, openStore: (host: any) => any) {
  assert.ok(path.isAbsolute(verificationHome));
  const liveHome = realpathSync(liveHost.qaHome);
  const target = path.join(realpathSync(path.dirname(verificationHome)), path.basename(verificationHome));
  assert.equal(target, verificationHome, 'Verification HOME must be canonical');
  assert.notEqual(target, liveHome, 'Verification must never use live HOME');
  assert.ok(!target.startsWith(liveHome + path.sep + '.raf' + path.sep), 'Verification must not use live state');
  assert.equal(mainSession.addressId, 'main');
  assert.equal(mainSession.state, 'running');
  assert.equal(mainSession.result, undefined);
  assert.ok(Number.isSafeInteger(mainSession.process?.pid) && mainSession.process.pid > 0);
  assert.equal(existsSync(target), false, 'Verification HOME must not exist');
  mkdirSync(target, { mode: 0o700 });
  const environment = { ...liveHost.environment, HOME: target, RAF_QA_HOME: target };
  for (const key of ['RAF_HOME_DIRECTORY', 'RAF_STATE_DIRECTORY', 'RAF_SOCKET_PATH', 'RAF_SERVICE_HOST_MODULE_PATH']) delete environment[key];
  const host = { ...liveHost, qaHome: target, environment };
  const store = openStore(host);
  try {
    store.sessionRepository.transaction((tx: any) => tx.putSession(structuredClone(mainSession)));
  } finally { store.close(); }
  return host;
}

export function retainLiveCommandEvidence(source: string, destination: string, labels: string[]) {
  assert.notEqual(realpathSync(source), realpathSync(destination));
  for (const label of labels) {
    assert.match(label, /^[a-z][a-z0-9-]*$/);
    for (const extension of ['json', 'stdout', 'stderr']) copyFileSync(path.join(source, label + '.' + extension), path.join(destination, label + '.' + extension), constants.COPYFILE_EXCL);
  }
}

export async function stopLiveServiceOwner(expected: { pid: number; mainPath: string; serviceEpoch: string }, runtime: { status(): Promise<any>; stop(): Promise<any> }) {
  const before = await runtime.status();
  assert.equal(before.exitCode, 0); assert.equal(before.state, 'ready');
  for (const key of ['pid', 'mainPath', 'serviceEpoch'] as const) assert.equal(before[key], expected[key], 'Cleanup must retain the exact service owner: ' + key);
  const stopped = await runtime.stop();
  assert.equal(stopped.exitCode, 0); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.pid, null);
  assert.equal(stopped.stopReason, 'Service stopped normally'); assert.equal(stopped.mainPath, expected.mainPath);
  const after = await runtime.status();
  assert.equal(after.state, 'stopped'); assert.equal(after.pid, null); assert.equal(after.mainPath, expected.mainPath);
  return stopped;
}
