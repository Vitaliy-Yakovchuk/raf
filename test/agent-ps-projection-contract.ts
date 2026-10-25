import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { SessionLaunchContext } from '../src/session-state.ts';

export const sentinel = 'Z398_HOOK_SENTINEL_"λ/\\\n:end';
export const syntheticSource = `const syntheticRuntimeHook = () => ${JSON.stringify(sentinel)};`;
export const sourceForms = [...new Set([sentinel, syntheticSource].flatMap(value => [
  value, JSON.stringify(value).slice(1, -1), JSON.stringify(JSON.stringify(value)).slice(1, -1),
  encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
  Buffer.from(value).toString('hex'), [...value].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join(''),
]))];

export function assertNoSource(stdout: string, stderr = ''): void {
  const serializedForms = [...sourceForms, 'Z398_HOOK_SENTINEL_', ...sourceForms.flatMap(value => [
    JSON.stringify(value).slice(1, -1), JSON.stringify(JSON.stringify(value)).slice(1, -1),
  ])];
  for (const [index, form] of serializedForms.entries()) {
    assert.equal(stdout.includes(form), false, `stdout must omit synthetic source form ${index}`);
    assert.equal(stderr.includes(form), false, `stderr must omit synthetic source form ${index}`);
  }
}

export const expectedOwnContext = {
  selection: { runner: 'codex', model: 'fixture-model', effort: 'fixture-effort' },
  assignment: { changes: [
    { id: 'complete-raf-flow-contracts', items: [{ id: 'Z.398.1' }, { id: 'Z.398.3' }] },
    { id: 'fixture-change', items: [{ id: '1.1' }] },
  ] },
};

export function fullLaunchContext(directory: string): SessionLaunchContext {
  return {
    selection: { ...expectedOwnContext.selection, reason: syntheticSource, futureSelection: syntheticSource },
    assignment: { root: directory, baselineArchives: [syntheticSource], snapshot: syntheticSource, changes: [
      { id: 'complete-raf-flow-contracts', reason: syntheticSource, items: [
        { id: 'Z.398.1', description: syntheticSource, sources: [syntheticSource] },
        { id: 'Z.398.3', description: syntheticSource },
      ] },
      { id: 'fixture-change', items: [{ id: '1.1', description: syntheticSource }] },
    ] },
    contextReview: { contextReviewId: 'review-id', runIds: ['own-run'], brief: syntheticSource },
    modelRouting: { parameters: { source: syntheticSource } }, flowPlan: [{ source: syntheticSource }],
    flowQa: { source: syntheticSource }, testAssignment: { source: syntheticSource }, reportSchema: { source: syntheticSource },
    briefPath: join(directory, 'private-brief.md'), reportPath: join(directory, 'missing-report.json'),
    writeBoundaries: [directory], wrapperCommands: sourceForms, futureContainer: { source: syntheticSource },
  } as unknown as SessionLaunchContext;
}
