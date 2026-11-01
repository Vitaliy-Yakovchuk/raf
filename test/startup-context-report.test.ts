import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { readPendingAgentReport } from '../src/agent-report.ts';
import type { AgentReport, AgentReportRequest } from '../src/agent-report.ts';
import { composeAssignmentBrief } from '../src/assignment.ts';
import { captureStartupContext, readStartupContextTrace, saveStartupContextTrace } from '../src/startup-context.ts';
import type { StartupContextAssessment } from '../src/startup-context.ts';
import { deriveTaskContext } from '../src/task-context.ts';
import type { TaskReportSchema } from '../src/task-context.ts';
import { captureInput, contextDatabase, estimateTokens, flowConfiguration } from './startup-context-fixture.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const snapshot = {
  root,
  changes: [{ id: 'context-fixture', items: [{ id: '2.1', description: 'Synthetic selected task' }] }],
  baselineArchives: [],
};
const baseSchema = {
  type: 'object',
  required: ['status', 'answer', 'changes', 'commits'],
  additionalProperties: true,
  properties: { status: { enum: ['succeeded', 'failed'] }, answer: { type: 'string' }, changes: { type: 'array' } },
};
const assessment: StartupContextAssessment = {
  unnecessary: [{ source: 'conf/briefs/tasks/test-scaffold.md', reason: 'Unneeded release instructions for test authoring' }],
  missing: [{ description: 'Address of the test authoring requirement', foundAt: 'openspec/specs/core/process/feature-test-authoring/spec.md' }],
};

async function reportSchemaFor(t: TestContext): Promise<TaskReportSchema> {
  const fixture = contextDatabase(t);
  const change = join(fixture.directory, 'openspec/changes/context-fixture');
  await mkdir(change, { recursive: true });
  await writeFile(join(change, 'proposal.md'), '## Why\nSynthetic context schema contract.\n');
  await writeFile(join(change, 'design.md'), '## Contract\nOptional report assessment.\n');
  await writeFile(join(change, 'tasks.md'), '## Tests\n- [ ] 2.1 Synthetic selected task\n');
  const product = fileURLToPath(new URL('../', import.meta.url));
  const derived = await deriveTaskContext({
    root: fixture.directory,
    parameters: { id: 'context-author', type: 'test-scaffold', project: 'raf', features: ['context-fixture'], phase: 'test-scaffold', complexity: 'medium', tasks: ['context-fixture:2.1'] },
    assignment: { ...snapshot, root: fixture.directory },
    configuration: {
      projects: { projects: { raf: { path: product, profile: 'raf', branchPaths: { main: product, develop: product } } } },
      reportStatuses: baseSchema.properties.status.enum.map(id => ({ id })),
      resources: flowConfiguration.resources,
    },
  });
  return derived.reportSchema;
}

async function readReport(context?: unknown): Promise<AgentReport | undefined> {
  const request: AgentReportRequest = { tmpRoot: '/tmp/raf-startup-context-report-fixture', runId: 'report-run', address: 'context-author', assignment: snapshot };
  const report = {
    status: 'succeeded', answer: 'Synthetic task complete',
    changes: [{ id: 'context-fixture', items: [{ id: '2.1', status: 'succeeded' }] }],
    ...(context === undefined ? {} : { context }),
  };
  const result = await readPendingAgentReport(request, {
    fs: { readText: async () => JSON.stringify(report) },
    now: () => '2026-10-22T00:00:00.000Z',
    verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }),
    diagnostic: async reason => { assert.fail(reason); },
  });
  assert.equal(result?.status, 'succeeded');
  return result?.report;
}

test('startup context report: task-context schema advertises assessment arrays and foundAt while keeping context optional', async t => {
  const schema = await reportSchemaFor(t) as unknown as {
    required: string[];
    properties: Record<string, { type?: string; required?: string[]; properties?: Record<string, { type: string; items: { properties: Record<string, { type: string }>; required: string[] } }> }>;
  };
  assert.deepEqual(schema.required, baseSchema.required);
  assert.deepEqual(schema.properties.status, baseSchema.properties.status);
  assert.deepEqual(schema.properties.answer, baseSchema.properties.answer);
  assert.equal(schema.properties.changes.type, 'array');
  assert.ok(!schema.required.includes('context'));
  const context = schema.properties.context;
  assert.ok(context, 'Report schema must advertise the optional context field');
  assert.equal(context.type, 'object');
  assert.ok(context.properties?.unnecessary, 'Context schema must advertise unnecessary sources');
  assert.ok(context.properties?.missing, 'Context schema must advertise missing sources');
  assert.equal(context.properties?.unnecessary.type, 'array');
  assert.equal(context.properties?.missing.type, 'array');
  assert.equal(context.properties?.unnecessary.items.properties.source.type, 'string');
  assert.equal(context.properties?.unnecessary.items.properties.reason.type, 'string');
  assert.equal(context.properties?.missing.items.properties.foundAt.type, 'string');
  assert.equal(context.properties?.missing.items.properties.description.type, 'string');
  assert.ok(context.properties?.missing.items.required.includes('foundAt'));
  assert.deepEqual(context.required, ['unnecessary', 'missing']);
  assert.deepEqual(context.properties?.unnecessary.items.required, ['source', 'reason']);
  assert.ok(!('context' in baseSchema.properties));
});

test('startup context report: a legacy report with no assessment remains valid', async () => {
  const report = await readReport();
  assert.ok(report);
  assert.equal(report.context, undefined);
});

test('startup context report: an invalid context assessment such as sessionId and notes is discarded without rejecting the report', async t => {
  const report = await readReport({ sessionId: 'agy-session-1', notes: 'completed hotfix' });
  assert.ok(report);
  assert.equal(report.context, undefined);
  assert.equal('context' in report, false);
  const fixture = contextDatabase(t);
  const trace = captureStartupContext(captureInput({ report }), { estimateTokens });
  assert.equal(trace.context, null);
  saveStartupContextTrace(fixture.database, trace);
  const stored = readStartupContextTrace(fixture.database, trace.runId);
  assert.equal(stored?.context, null);
});

test('startup context report: empty assessment lists are valid and remain distinct from an absent assessment', async () => {
  const empty = { unnecessary: [], missing: [] };
  const report = await readReport(empty);
  assert.deepEqual(report?.context, empty);
  const trace = captureStartupContext(captureInput({ report: { context: empty } }), { estimateTokens });
  assert.deepEqual(trace.context, empty);
  const absent = captureStartupContext(captureInput(), { estimateTokens });
  assert.equal(absent.context, null);
});

test('startup context report: the report reader preserves self-assessment and SQLite preserves the discovered address', async t => {
  const report = await readReport(assessment);
  assert.deepEqual(report?.context, assessment);
  const fixture = contextDatabase(t);
  const trace = captureStartupContext(captureInput({ report: report as { context: StartupContextAssessment } }), { estimateTokens });
  saveStartupContextTrace(fixture.database, trace);
  const stored = readStartupContextTrace(fixture.database, trace.runId);
  assert.deepEqual(stored?.context, assessment);
  assert.equal(stored?.context?.missing[0].foundAt, 'openspec/specs/core/process/feature-test-authoring/spec.md');
});

for (const runner of ['claude', 'codex']) {
  test(`startup context report: ${runner} brief includes optional context schema and requests a short assessment`, async t => {
    const brief = await composeAssignmentBrief(snapshot, {
      briefsRoot: fileURLToPath(new URL('../../conf/briefs', import.meta.url)),
      runner, stage: 'test-scaffold', project: 'raf', agentId: 'context-author', sessionName: 'context-author',
      cwd: root, rafCommand: 'raf',
      features: ['context-fixture'], phase: 'test-scaffold', outcome: 'Synthetic context contract',
      writeBoundaries: ['/tmp/raf-startup-context-report-fixture'],
      sources: ['openspec/specs/core/process/feature-test-authoring/spec.md'],
      reportPath: '/tmp/raf-startup-context-report-fixture/context-author.json',
      reportSchema: { ...await reportSchemaFor(t) },
    }, { readText: path => readFile(path, 'utf8') });
    assert.match(brief, /"context"\s*:/u);
    assert.match(brief, /"foundAt"\s*:/u);
    assert.match(brief, /(?:коротк[^\n]*context|context[^\n]*коротк|brief[^\n]*assessment|short[^\n]*context)/iu);
  });
}
