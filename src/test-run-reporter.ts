import { completeRunnerProtocol } from './test-run-protocol.ts';
import { readFileSync } from 'node:fs';
import { TestRunDiagnostics, diagnosticFailureFromNodeEvent, validateDiagnosticLimits } from './test-run-diagnostics.ts';
import type { RunnerEvent, TestId } from './test-runs.ts';
import { isAbsolute, relative, resolve } from 'node:path';

export default async function* report(source: AsyncIterable<any>, selected?: TestId[]): AsyncGenerator<string> {
  const limits = validateDiagnosticLimits(JSON.parse(readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8')).diagnostics);
  const expected: TestId[] = [];
  const parents = new Map<number, string>();
  const declared = new Map<string, { test: TestId; type: string }>();
  const stderr = new Map<string, TestRunDiagnostics>();
  let stderrBytes = 0;
  let protocolFailed = false;
  for await (const event of source) {
    const data = event.data;
    if (event.type === 'test:diagnostic' && typeof data.message === 'string') {
      if (!['1', '2'].includes(process.env.RAF_TEST_RUN_DIAGNOSTICS_PROTOCOL ?? '')) continue;
      let details: any;
      try { details = JSON.parse(data.message); } catch { continue; }
      if (!details || typeof details !== 'object') continue;
      const evidence = Array.isArray(details.evidence) ? details.evidence.filter((path: unknown) => typeof path === 'string' && isAbsolute(path) && !path.includes('\0')) : [];
      const entries = Array.isArray(details.diagnostics) ? details.diagnostics : [];
      const diagnostics = new TestRunDiagnostics(limits, { workspace: process.cwd(), qaHome: process.env.HOME ?? '', fixtureRoots: process.env.TMPDIR ? [process.env.TMPDIR] : [] });
      if (details.schema === 'raf-test-evidence-v1' && typeof details.test?.file === 'string' && typeof details.test?.name === 'string' && typeof details.phase === 'string') {
        diagnostics.inline({ kind: 'runner', test: details.test, message: `Case ${typeof details.caseRunId === 'string' ? details.caseRunId : 'unknown'}: ${details.phase}`, location: null, stack: [], redacted: false, truncated: false });
      }
      for (const entry of entries) {
        if (entry && typeof entry.kind === 'string' && typeof entry.message === 'string' && Array.isArray(entry.stack) && entry.stack.every((line: unknown) => typeof line === 'string')) diagnostics.inline(entry);
      }
      const summary = details.diagnosticSummary;
      if (summary && Number.isSafeInteger(summary.omittedEntries) && summary.omittedEntries >= 0) diagnostics.omitted(summary.omittedEntries, summary.redacted === true, summary.truncated === true);
      const attachment = diagnostics.attach({ runId: '', outcome: '', failureKinds: [], knownRed: [], unexecuted: [], unknown: [], timeoutCount: 0, timedOut: false, cleanup: '', evidence: [] }, {} as any);
      const output: Extract<RunnerEvent, { kind: 'diagnostic' }> = { kind: 'diagnostic', diagnostics: attachment.diagnostics, diagnosticSummary: attachment.diagnosticSummary, evidence: [] };
      if (output.diagnosticSummary!.totalEntries) yield JSON.stringify(output) + '\n';
      if (evidence.length) yield JSON.stringify({ kind: 'diagnostic', diagnostics: [], evidence }) + '\n';
      continue;
    }
    if (event.type === 'test:stderr' && data.file && typeof data.message === 'string' && stderrBytes < limits.maxStderrBytes) {
      const file = resolve(process.cwd(), data.file);
      let collector = stderr.get(file);
      if (!collector) { collector = new TestRunDiagnostics(limits, { workspace: process.cwd(), qaHome: process.env.HOME ?? '', fixtureRoots: [] }); stderr.set(file, collector); }
      const chunk = Buffer.from(data.message);
      const retained = chunk.subarray(0, limits.maxStderrBytes - stderrBytes);
      collector.stderrChunk(retained); stderrBytes += retained.length;
    }
    if (event.type === 'test:enqueue' && data.entryFile) {
      const file = relative(process.cwd(), data.file);
      const parent = declared.get(`${file}:${data.parentId}`);
      const test = { file, name: parent ? `${parent.test.name} ${data.name}` : data.name };
      declared.set(`${file}:${data.testId}`, { test, type: data.type });
      if (data.type !== 'suite' && (!selected || selected.some(id => id.file === test.file && id.name === test.name))) {
        yield JSON.stringify({ kind: 'discovered', test, ...(parent?.type === 'test' ? { parent: parent.test } : {}) }) + '\n';
      }
    }
    if (event.type === 'test:start') {
      for (const depth of parents.keys()) if (depth >= data.nesting) parents.delete(depth);
      parents.set(data.nesting, data.name);
    }
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (data.details?.type === 'suite') continue;
      const file = data.file ?? (isAbsolute(data.name ?? '') ? data.name : '');
      const test = { file: relative(process.cwd(), file), name: [...Array.from({ length: data.nesting ?? 0 }, (_, depth) => parents.get(depth)).filter(Boolean), data.name].join(' ') };
      if (!test.file || !test.name) { protocolFailed = true; continue; }
      if (selected && !selected.some(id => id.file === test.file && id.name === test.name) && !data.details?.error) continue;
      if (data.details?.error?.failureType === 'subtestsFailed') {
        yield JSON.stringify({ kind: 'container-complete', test }) + '\n';
        continue;
      }
      expected.push(test);
      if (data.skip || data.todo) continue;
      const failure = event.type === 'test:fail' ? diagnosticFailureFromNodeEvent(event) : null;
      if (failure) {
        failure.test = test;
        if (failure.origin === 'collection' && failure.unavailableReason && stderr.get(resolve(process.cwd(), file))?.stderrText()) {
          const text = stderr.get(resolve(process.cwd(), file))!.stderrText();
          const header = text.match(/^([\w.]*Error)(?: \[([\w]+)\])?: ([^\r\n]*)/m);
          failure.error = Object.assign(new Error(header?.[3] ?? 'File runner failed; no structured error header was available'), {
            name: header?.[1] ?? 'Error', ...(header?.[2] ? { code: header[2] } : {}), stack: text,
          });
          if (header) delete failure.unavailableReason;
        }
      }
      const current = new TestRunDiagnostics(limits, { workspace: process.cwd(), qaHome: process.env.HOME ?? '', fixtureRoots: process.env.TMPDIR ? [process.env.TMPDIR] : [] });
      const disposition = failure ? current.failure(failure) : null;
      const kind: RunnerEvent['kind'] = event.type === 'test:pass' ? 'passed' : disposition?.failureKind === 'assertions' ? 'assertion-failed' : 'setup-failed';
      const attachment = current.attach({ runId: '', outcome: '', failureKinds: [], knownRed: [], unexecuted: [], unknown: [], timeoutCount: 0, timedOut: false, cleanup: '', evidence: [] }, {} as any);
      const inlineDiagnostic = attachment.diagnostics.at(-1);
      yield JSON.stringify({ kind, test, ...(failure && inlineDiagnostic ? { inlineDiagnostic } : {}) }) + '\n';
    }
  }
  if (protocolFailed) yield JSON.stringify({ kind: 'protocol-error', diagnostic: 'Missing structured test identity' }) + '\n';
  for (const event of completeRunnerProtocol(selected ?? expected)) yield JSON.stringify(event) + '\n';
}
