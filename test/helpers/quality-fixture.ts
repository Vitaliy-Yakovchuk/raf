import { createHash } from 'node:crypto';
import type { QualityBaseline, QualityContext, QualityCoverage, QualityRequest, QualityRunFacts, QualitySnapshot, QualityTransportPorts } from '../../src/test-run-quality.ts';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const source = 'export const answer = () => 42; export const neighbor = () => 7;\n';
export const targetPath = 'src/answer.ts';
export const selected = { id: 'answer', path: targetPath, startByte: 0, endByte: source.indexOf(';') + 1 };
export const mutation = { siteId: 'answer/return/42', functionId: selected.id, path: targetPath, startByte: source.indexOf('42'), endByte: source.indexOf('42') + 2, beforeBase64: Buffer.from('42').toString('base64'), afterBase64: Buffer.from('41').toString('base64') };
export const testId = { file: 'test/answer.test.ts', name: 'required answer' };
export const group = 'adopt-ub-mode-quality-gates/quality-transport';
export const workspace = '/fixture/project';
export const mutated = source.replace('42', '41');

export function request(mode: 'baseline' | 'mutant' = 'mutant'): QualityRequest {
  return { version: 1, mode, source: { baseRevision: 'a'.repeat(40), revision: 'b'.repeat(40), files: [{ path: targetPath, sha256: hash(source) }] }, changedFunctions: [{ ...selected }], ...(mode === 'mutant' ? { baselineRunId: 'baseline-1', mutant: { ...mutation } } : {}) };
}

export function context(): QualityContext {
  return { runId: 'mutant-1', owner: 'trusted-wrapper', canonicalWorkspace: workspace, profileId: 'node', profileCwd: '.', selection: { files: [testId.file], testIds: [] }, selectionDigest: hash('selection'), configDigest: hash('config'), dependencyDigest: hash('dependencies'), sourceAdapter: { id: 'node-source', version: 'fixture-reviewed' }, siteSelector: { id: 'typescript-function', version: 'fixture-reviewed' } };
}

export function baseline(): QualityBaseline {
  return { runId: 'baseline-1', owner: context().owner, sourceSnapshotDigest: hash('snapshot'), selectionDigest: context().selectionDigest, configDigest: context().configDigest, dependencyDigest: context().dependencyDigest, producer: { id: 'v8', version: 'fixture-pinned' }, result: { outcome: 'passed', exitCode: 0, timedOut: false, cleanup: { complete: true, remainingPids: [] }, unknown: [], unexecuted: [] } };
}

export function transport() {
  const snapshot: QualitySnapshot = { digest: hash('snapshot'), inputs: [
    { path: targetPath, bytes: Buffer.from(source), realpath: `${workspace}/${targetPath}`, role: 'source' },
    { path: testId.file, bytes: Buffer.from('assert.equal(answer(), 42)'), realpath: `${workspace}/${testId.file}`, role: 'test' },
    { path: 'runner.config.ts', bytes: Buffer.from('trusted config'), realpath: `${workspace}/runner.config.ts`, role: 'config' },
  ] };
  const saved = baseline();
  const calls = { copies: 0, removed: [] as string[], selected: [] as string[] };
  const ports: QualityTransportPorts = {
    snapshot: async () => structuredClone(snapshot),
    readCurrent: async path => structuredClone(snapshot.inputs.find(input => input.path === path)!.bytes),
    loadBaseline: async id => id === saved.runId ? structuredClone(saved) : null,
    selectSites: async (_snapshot, functions) => { calls.selected.push(...functions.map(fn => fn.id)); return { supported: true, sites: [{ ...mutation }] }; },
    createPrivateCopy: async snap => { calls.copies++; return { root: '/fixture/private/run-1', inputs: structuredClone(snap.inputs) }; },
    removePrivateCopy: async root => { calls.removed.push(root); },
  };
  return { snapshot, saved, calls, ports };
}

export function coverage(): QualityCoverage {
  return { runId: 'baseline-1', sourceSnapshotDigest: baseline().sourceSnapshotDigest, selectionDigest: context().selectionDigest, configDigest: context().configDigest, dependencyDigest: context().dependencyDigest,
    producer: { ...baseline().producer, complete: true, exitCode: 0 }, artifact: { path: '/fixture/private/baseline-1/coverage/lcov.info', sha256: hash('coverage'), actualSha256: hash('coverage'), format: 'lcov', createdByRunId: 'baseline-1' },
    functions: [{ id: selected.id, unit: 'function', hits: 1, denominator: 1, sourceSha256: hash(source), mapped: true }], omissions: [] };
}

export function facts(overrides: Partial<QualityRunFacts> = {}): QualityRunFacts {
  return { mode: 'mutant', runId: 'mutant-1', target: { path: targetPath, sha256: hash(mutated) }, baselineGreen: true, siteCount: 1,
    loadedSources: [{ path: targetPath, resolvedPath: '/fixture/private/run-1/src/answer.ts', inputSha256: hash(mutated), transformedSha256: hash('compiled mutant'), mapping: 'source-map-sha', loaded: true, stage: 'load', runId: 'mutant-1' }],
    events: [], protocolComplete: true, cleanup: { complete: true, remainingPids: [] }, exitCode: 0, timedOut: false, interrupted: false, ...overrides };
}
