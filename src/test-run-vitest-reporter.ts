import { completeRunnerProtocol } from './test-run-protocol.ts';
import { writeSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { TestRunDiagnostics } from './test-run-diagnostics.ts';
import type { DiagnosticOrigin } from './test-run-diagnostics.ts';
import type { RunnerEvent, TestId } from './test-runs.ts';

export default class VitestReporter {
  private selected: TestId[] = JSON.parse(process.env.RAF_TEST_RUN_IDS ?? '[]');
  private root = process.env.RAF_TEST_RUN_WORKSPACE!;
  private expected = new Map<string, TestId>();
  private seenErrors = new Set<unknown>();
  private emit(event: RunnerEvent): void { writeSync(3, JSON.stringify(event) + '\n'); }
  private id(test: any): TestId {
    const names = [test.name];
    for (let parent = test.parent; parent?.type === 'suite'; parent = parent.parent) names.unshift(parent.name);
    const file = relative(this.root, test.module.moduleId);
    if (!file || file.startsWith('..') || isAbsolute(file)) throw new Error('Vitest identity outside workspace');
    return { file, name: names.join(' ') };
  }
  private include(id: TestId): boolean { return !this.selected.length || this.selected.some(test => test.file === id.file && test.name === id.name); }
  private failure(test: TestId | null, origin: DiagnosticOrigin, error: unknown): void {
    this.seenErrors.add(error);
    const current = new TestRunDiagnostics(JSON.parse(process.env.RAF_TEST_RUN_DIAGNOSTICS!), { workspace: process.cwd(), qaHome: process.env.HOME ?? '', fixtureRoots: process.env.TMPDIR ? [process.env.TMPDIR] : [] });
    const disposition = current.failure({ test, origin, error });
    const inlineDiagnostic = { ...current.attach({ runId: '', outcome: '', failureKinds: [], knownRed: [], unexecuted: [], unknown: [], timeoutCount: 0, timedOut: false, cleanup: null, evidence: [] }, {} as any).diagnostics.at(-1)!, origin };
    if (test) this.emit({ kind: disposition.failureKind === 'assertions' ? 'assertion-failed' : 'setup-failed', test, inlineDiagnostic });
    else this.emit({ kind: 'file-setup-failed', inlineDiagnostic });
  }
  onInit(vitest: any): void {
    if (typeof vitest.initializeGlobalSetup !== 'function') throw new Error('Compatible Vitest global setup lifecycle required');
    const initialize = vitest.initializeGlobalSetup.bind(vitest);
    vitest.initializeGlobalSetup = async (...args: any[]) => {
      try { return await initialize(...args); }
      catch (error) { this.failure(null, 'global-setup', error); throw error; }
    };
  }
  onTestModuleCollected(module: any): void {
    for (const test of module.children.allTests()) {
      const id = this.id(test);
      if (this.include(id)) { this.expected.set(JSON.stringify(id), id); this.emit({ kind: 'discovered', test: id }); }
    }
  }
  onHookEnd(hook: any): void {
    const entity = hook.entity;
    if (entity.type !== 'test') for (const error of entity.errors()) this.failure(null, 'hook', error);
  }
  onTestCaseResult(test: any): void {
    const id = this.id(test);
    if (!this.include(id)) return;
    const result = test.result();
    if (result.state === 'passed') this.emit({ kind: 'passed', test: id });
    else if (result.state === 'failed') {
      for (const error of result.errors ?? []) {
        const origin = ['test-body', 'hook', 'fixture-setup'].includes(error.rafTestOrigin) ? error.rafTestOrigin : 'unknown';
        this.failure(id, origin, error);
      }
      if (!result.errors?.length) this.failure(id, 'unknown', new Error('Vitest failure without structured cause'));
    }
  }
  onTestModuleEnd(module: any): void {
    for (const error of module.errors()) if (!this.seenErrors.has(error)) this.failure(null, ['import', 'fixture-setup'].includes(error.rafTestOrigin) ? error.rafTestOrigin : 'collection', error);
  }
  onTestSuiteResult(suite: any): void {
    for (const error of suite.errors()) if (!this.seenErrors.has(error)) this.failure(null, 'hook', error);
  }
  onTestRunEnd(modules: any[], errors: any[], reason: string): void {
    for (const module of modules) this.onTestModuleEnd(module);
    for (const error of errors) if (!this.seenErrors.has(error)) this.failure(null, 'fixture-setup', error);
    if (reason === 'interrupted') this.emit({ kind: 'protocol-error', diagnostic: 'Vitest interrupted' });
    if (!this.expected.size) this.emit({ kind: 'protocol-error', diagnostic: 'Empty Vitest collection or unmatched exact filter' });
    for (const event of completeRunnerProtocol(this.expected.values(), 'vitest-events')) this.emit(event);
  }
}
