import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { confirmationTransient, confirmationStateTransient } from './report-confirmation-retry.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import type { TestId, TestRunResult, UnitTestPolicy } from './test-runs.ts';

export interface FlowScenarioAddress { change: string; item: string; scenario: string; }
export interface FlowIssue {
  change: string;
  item: string;
  field: string;
  requirement: string;
  received: unknown;
  expected: string;
  remediation: string;
  path?: string;
  line?: number;
}
export interface FlowQaLaunchContext {
  stage: string;
  runId: string;
  agentId: string;
  project: string;
  workspace: string;
  branch: string;
  assignment: AssignmentSnapshot;
  reportSchema: Readonly<Record<string, unknown>>;
  scenarios: readonly FlowScenarioAddress[];
  allowedEvidenceRoots: readonly string[];
  workingMain: { project: string; workspace: string; branch: string };
}
export interface FlowTestRunFact {
  testRunId: string;
  agentRunId: string;
  agentId: string;
  project: string;
  workspace: string;
  group: string;
  phase: string;
  selection: TestRunResult['selection'];
  resultDigest: string;
  stderrDigest: string;
  cliCode: number;
}
export interface FlowTestRunStore {
  put(fact: FlowTestRunFact): Promise<void>;
  get(testRunId: string): Promise<FlowTestRunFact | null>;
  removeForAgentRun(agentRunId: string): Promise<void>;
}
export interface FlowQaEvidencePorts {
  readText(path: string): Promise<string | null>;
  realpath(path: string): Promise<string>;
  lookupTestRun(testRunId: string): Promise<FlowTestRunFact | null>;
  unitPolicy: UnitTestPolicy;
  integrationProfiles?: readonly { profileId: string; group: string; files: readonly string[]; timeoutMs: number }[];
  readOpenItems(change: string): Promise<readonly string[]>;
}
export interface FlowVerifiedSnapshot {
  reportDigest: string;
  files: readonly { path: string; realpath: string; digest: string }[];
  testRuns: readonly FlowTestRunFact[];
}
export interface FlowCheckResult {
  ok: boolean;
  issues: readonly FlowIssue[];
  warnings: readonly FlowIssue[];
  manualEvidence: boolean;
  unverifiedRemainder: readonly TestId[];
  snapshot?: FlowVerifiedSnapshot;
}
export interface FlowQaReportInput {
  report: unknown;
  reportPath: string;
  trusted: FlowQaLaunchContext;
}
export const flowQaRequirement = 'openspec/changes/enforce-flow-approaches/specs/core/process/user-qa/spec.md#Один прохід QA з виправленням';
export const flowDigest = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: any) => typeof value === 'string' && !!value.trim();
const addressKey = (value: FlowScenarioAddress) => JSON.stringify([value.change, value.item, value.scenario]);
const inside = (path: string, root: string) => { const suffix = relative(root, path); return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep); };
const strings = (value: any) => Array.isArray(value) && value.length > 0 && value.every(nonempty);
const textSchema = { type: 'string', minLength: 1 };
const evidenceSchema = { type: 'array', minItems: 1, items: textSchema };
const commitSchema = { type: 'object', additionalProperties: false, required: ['repository', 'sha'], properties: { repository: textSchema, sha: { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' } } };
const machineReferenceSchema = { type: 'object', additionalProperties: false, required: ['resultPath', 'stderrPath', 'cliCode'], properties: { resultPath: textSchema, stderrPath: textSchema, cliCode: { type: 'integer' } } };
const addressProperties = { change: textSchema, item: textSchema, scenario: textSchema };
export const flowQaSchema = {
  type: 'object', additionalProperties: false, required: ['scenarios', 'findings', 'followUps'], properties: {
    scenarios: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['change', 'item', 'scenario', 'status', 'evidence'], properties: { ...addressProperties, status: { enum: ['succeeded', 'failed'] }, evidence: evidenceSchema, reason: textSchema }, allOf: [{ if: { properties: { status: { const: 'failed' } } }, then: { required: ['reason'] } }] } },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['change', 'item', 'scenario', 'requirement', 'fixed', 'evidence'], properties: {
      ...addressProperties, requirement: textSchema, fixed: { type: 'boolean' }, evidence: evidenceSchema, reason: textSchema,
      commits: { type: 'array', minItems: 1, items: commitSchema },
      mainHotfix: { type: 'object', additionalProperties: false, required: ['workspace', 'branch', 'requirement', 'evidence'], properties: { workspace: textSchema, branch: textSchema, requirement: textSchema, evidence: evidenceSchema } },
      regression: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'group', 'red', 'green'], properties: { kind: { enum: ['unit', 'integration'] }, group: textSchema, red: machineReferenceSchema, green: machineReferenceSchema } },
        { type: 'object', additionalProperties: false, required: ['kind', 'redEvidence', 'greenEvidence'], properties: { kind: { const: 'manual' }, redEvidence: evidenceSchema, greenEvidence: evidenceSchema } },
      ] },
    }, allOf: [{ if: { properties: { fixed: { const: true } } }, then: { required: ['regression', 'commits'], not: { required: ['mainHotfix'] } }, else: { required: ['reason'] } }] } },
    followUps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['change', 'item', 'sourceItem', 'scenario', 'purpose', 'reason', 'evidence'], properties: { ...addressProperties, sourceItem: textSchema, purpose: { enum: ['deployment', 'first-execution', 'working-main-hotfix', 'defect-fix', 'repeat-qa'] }, reason: textSchema, evidence: evidenceSchema } } },
  },
};
function schemaIssues(value: any, schema: any, path: string): { field: string; expected: string; received: unknown }[] {
  const problems: { field: string; expected: string; received: unknown }[] = [];
  const fail = (expected: string) => problems.push({ field: path, received: value, expected });
  if (schema.oneOf && schema.oneOf.filter((branch: any) => schemaIssues(value, branch, path).length === 0).length !== 1) fail('exactly one regression schema');
  if (schema.const !== undefined && value !== schema.const) fail(JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.includes(value)) fail(JSON.stringify(schema.enum));
  if (schema.type === 'object') {
    if (!object(value)) { fail('object'); return problems; }
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) problems.push({ field: path + '.' + key, received: undefined, expected: 'required field' });
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, key)) problems.push({ field: path + '.' + key, received: value[key], expected: 'no unknown fields' });
      if (schema.properties?.[key]) problems.push(...schemaIssues(value[key], schema.properties[key], path + '.' + key));
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) { fail('array'); return problems; }
    if (value.length < (schema.minItems ?? 0)) fail('nonempty array');
    if (schema.items) value.forEach((item, index) => problems.push(...schemaIssues(item, schema.items, `${path}[${index}]`)));
  }
  if (schema.type === 'string' && (!nonempty(value) || schema.pattern && !new RegExp(schema.pattern).test(value))) fail('nonempty matching string');
  if (schema.type === 'boolean' && typeof value !== 'boolean') fail('boolean');
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) fail('integer');
  for (const branch of schema.allOf ?? []) {
    const matches = branch.if && schemaIssues(value, branch.if, path).length === 0;
    if (matches && branch.then) problems.push(...schemaIssues(value, branch.then, path));
    if (!matches && branch.else) problems.push(...schemaIssues(value, branch.else, path));
  }
  if (schema.required && !schema.type && object(value)) for (const key of schema.required) if (!Object.hasOwn(value, key)) problems.push({ field: path + '.' + key, received: undefined, expected: 'required field' });
  if (schema.properties && !schema.type && object(value)) for (const key of Object.keys(schema.properties)) if (Object.hasOwn(value, key)) problems.push(...schemaIssues(value[key], schema.properties[key], path + '.' + key));
  if (schema.not && schemaIssues(value, schema.not, path).length === 0) fail('forbidden field combination');
  return problems;
}
export function flowContractEnabled(trusted: FlowQaLaunchContext): boolean {
  return trusted.stage === 'qa' && Array.isArray(trusted.reportSchema.required) && trusted.reportSchema.required.includes('qa');
}
export async function validateFlowQaReport(input: FlowQaReportInput, ports: FlowQaEvidencePorts): Promise<FlowCheckResult> {
  const { trusted } = input;
  const issues: FlowIssue[] = [], warnings: FlowIssue[] = [], files: FlowVerifiedSnapshot['files'][number][] = [], testRuns: FlowTestRunFact[] = [], unverifiedRemainder: TestId[] = [];
  let manualEvidence = false;
  const issue = (field: string, received: unknown, expected: string, address?: Partial<FlowScenarioAddress> & { sourceItem?: string }) => {
    const change = trusted.assignment.changes.find(change => change.id === address?.change) ?? trusted.assignment.changes[0];
    const item = change?.items.find(item => item.id === address?.sourceItem) ?? change?.items.find(item => item.id === address?.item) ?? change?.items[0];
    issues.push({ change: change?.id ?? '', item: item?.id ?? '', field, requirement: flowQaRequirement, received, expected, remediation: 'Виправте звіт і докази власного QA у цьому самому запуску; не передавайте виправлення іншому агенту.', path: input.reportPath });
  };
  const result = (): FlowCheckResult => ({ ok: issues.length === 0, issues, warnings, manualEvidence, unverifiedRemainder, ...(issues.length ? {} : { snapshot: { reportDigest: flowDigest(JSON.stringify(input.report)), files, testRuns } }) });
  if (!flowContractEnabled(trusted)) return result();
  const report = input.report as any;
  if (!object(report)) { issue('report', report, 'object'); return result(); }
  if (report.proposedTasks != null && (!Array.isArray(report.proposedTasks) || report.proposedTasks.length)) issue('proposedTasks', report.proposedTasks, 'absent, null or []');
  const qa = report.qa;
  const malformed = schemaIssues(qa, flowQaSchema, 'qa');
  for (const problem of malformed) issue(problem.field, problem.received, problem.expected);
  if (malformed.length) return result();
  const shape = (value: any, field: string, allowed: string[], required: string[], address?: any) => {
    if (!object(value)) { issue(field, value, 'object', address); return false; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(field + '.' + key, value[key], 'no unknown fields', address);
    for (const key of required) if (value[key] === undefined) issue(field + '.' + key, undefined, 'required field', address);
    return true;
  };
  if (!shape(qa, 'qa', ['scenarios', 'findings', 'followUps'], ['scenarios', 'findings', 'followUps'])) return result();
  for (const key of ['scenarios', 'findings', 'followUps']) if (!Array.isArray(qa[key])) issue('qa.' + key, qa[key], 'array');
  if (issues.some(row => /^qa(?:\.(?:scenarios|findings|followUps))?$/.test(row.field))) return result();
  const assigned = (row: any, item = row?.item) => trusted.assignment.changes.some(change => change.id === row?.change && change.items.some(value => value.id === item));
  const address = (row: any, field: string, source = false) => {
    for (const key of ['change', 'item', 'scenario']) if (!nonempty(row[key])) issue(field + '.' + key, row[key], 'nonempty address', row);
    if (!assigned(row, source ? row.sourceItem : row.item)) issue(field, row, 'original assigned change:item', row);
    if (!strings(row.evidence)) issue(field + '.evidence', row.evidence, 'nonempty evidence addresses', row);
  };
  const seen = new Set<string>();
  for (const [index, row] of qa.scenarios.entries()) {
    const field = `qa.scenarios[${index}]`;
    if (!shape(row, field, ['change', 'item', 'scenario', 'status', 'evidence', 'reason'], ['change', 'item', 'scenario', 'status', 'evidence'])) continue;
    address(row, field);
    const key = addressKey(row);
    if (seen.has(key)) issue(field, row, 'unique scenario', row);
    seen.add(key);
    if (!['succeeded', 'failed'].includes(row.status)) issue(field + '.status', row.status, 'succeeded or failed', row);
    if (row.status === 'failed' && !nonempty(row.reason)) issue(field + '.reason', row.reason, 'nonempty failed reason', row);
  }
  for (const row of trusted.scenarios) if (!seen.has(addressKey(row))) issue('qa.scenarios', row, 'required launch scenario', row);
  const read = async (path: any, field: string): Promise<string | null> => {
    if (!nonempty(path) || !isAbsolute(path) || !trusted.allowedEvidenceRoots.some(root => inside(resolve(path), resolve(root)))) { issue(field, path, 'evidence within allowed roots'); return null; }
    try {
      const canonical = await ports.realpath(path);
      let permitted = false;
      for (const root of trusted.allowedEvidenceRoots) if (inside(resolve(path), resolve(root)) && inside(canonical, await ports.realpath(root))) permitted = true;
      if (!permitted) { issue(field, path, 'realpath within allowed evidence roots'); return null; }
      const text = await ports.readText(canonical);
      if (text === null) { issue(field, path, 'available evidence'); return null; }
      if (await ports.realpath(path) !== canonical) { issue(field, path, 'stable realpath'); return null; }
      files.push({ path, realpath: canonical, digest: flowDigest(text) });
      return text;
    } catch (error) {
      if (confirmationTransient(error)) throw error;
      const transient = confirmationStateTransient(error);
      if (transient) throw transient;
      issue(field, path, `readable evidence: ${String(error)}`); return null;
    }
  };
  const machine = async (reference: any, field: string, phase: string, group: string): Promise<TestRunResult | null> => {
    if (!shape(reference, field, ['resultPath', 'stderrPath', 'cliCode'], ['resultPath', 'stderrPath', 'cliCode'])) return null;
    const text = await read(reference.resultPath, field + '.resultPath');
    const stderr = await read(reference.stderrPath, field + '.stderrPath');
    if (text === null || stderr === null) return null;
    let run: TestRunResult;
    try { run = JSON.parse(text); } catch { issue(field, text, 'complete TestRunResult JSON'); return null; }
    if (!object(run) || !nonempty(run.runId) || !object(run.selection) || !Array.isArray(run.selection.files) || !Array.isArray(run.selection.testIds) || !Array.isArray(run.knownRed) || !Array.isArray(run.unexecuted) || !Array.isArray(run.unknown) || !Array.isArray(run.passed) || !Array.isArray(run.failureKinds) || !object(run.cleanup)) { issue(field, run, 'complete TestRunResult'); return null; }
    const fact = await ports.lookupTestRun(run.runId);
    if (!fact || fact.agentRunId !== trusted.runId || fact.agentId !== trusted.agentId || fact.project !== trusted.project || fact.workspace !== trusted.workspace || fact.group !== group || fact.phase !== phase || fact.testRunId !== run.runId || fact.resultDigest !== flowDigest(JSON.stringify(run)) || fact.stderrDigest !== flowDigest(stderr) || fact.cliCode !== reference.cliCode || JSON.stringify(fact.selection) !== JSON.stringify(run.selection)) { issue(field, fact, 'broker evidence for the same agent runId, result digest, stderr, CLI code and selection'); return null; }
    testRuns.push(fact);
    if (run.project !== trusted.project || run.workspace !== trusted.workspace || run.group !== group || run.phase !== phase || !run.cleanup.complete || run.cleanup.remainingPids?.length || run.stateAccess || run.failureKinds.some(kind => ['setup', 'refusal', 'interruption'].includes(kind)) || run.unknown.length) issue(field, run, 'matching completed regression without setup/import errors or unknown results');
    return run;
  };
  const ownCommits = (commits: any) => Array.isArray(commits) && commits.length > 0 && commits.every(commit => object(commit) && Object.keys(commit).length === 2 && nonempty(commit.repository) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit.sha) && report.commits?.some((own: any) => own.repository === commit.repository && own.sha === commit.sha));
  const findingKeys = new Set<string>();
  for (const [index, row] of qa.findings.entries()) {
    const field = `qa.findings[${index}]`;
    if (!shape(row, field, ['change', 'item', 'scenario', 'requirement', 'fixed', 'evidence', 'reason', 'regression', 'commits', 'mainHotfix'], ['change', 'item', 'scenario', 'requirement', 'fixed', 'evidence'])) continue;
    address(row, field);
    const findingKey = addressKey(row) + JSON.stringify(row.requirement);
    if (findingKeys.has(findingKey)) issue(field, row, 'unique finding', row);
    findingKeys.add(findingKey);
    if (!seen.has(addressKey(row))) issue(field, row, 'finding references a reported scenario', row);
    if (!nonempty(row.requirement) || typeof row.fixed !== 'boolean') issue(field, row, 'requirement and boolean fixed', row);
    const itemStatus = report.changes?.find((change: any) => change.id === row.change)?.items?.find((item: any) => item.id === row.item)?.status;
    if (row.fixed === false) {
      if (!nonempty(row.reason)) issue(field + '.reason', row.reason, 'nonempty unfinished fix reason', row);
      if (report.status === 'succeeded' || itemStatus === 'succeeded') issue(field + '.fixed', false, 'unfinished finding requires failed item/report', row);
      if (row.mainHotfix !== undefined) {
        const hotfix = row.mainHotfix;
        if (shape(hotfix, field + '.mainHotfix', ['workspace', 'branch', 'requirement', 'evidence'], ['workspace', 'branch', 'requirement', 'evidence'], row)) {
          if (trusted.project !== 'raf' || trusted.project !== trusted.workingMain.project || trusted.workspace !== trusted.workingMain.workspace || trusted.branch !== trusted.workingMain.branch || hotfix.workspace !== trusted.workingMain.workspace || hotfix.branch !== trusted.workingMain.branch || !nonempty(hotfix.requirement) || !hotfix.requirement.includes('flow-approval') || !strings(hotfix.evidence)) issue(field + '.mainHotfix', hotfix, 'addressed bug of configured working raf main, never develop/fixture', row);
          else { manualEvidence = true; warnings.push({ ...issues[0], change: row.change, item: row.item, field: field + '.mainHotfix', requirement: flowQaRequirement, received: hotfix, expected: 'main verifies evidence of working main bug', remediation: 'Main звіряє доказ за projects/orchestrator/flow-approval.' }); }
        }
      }
      continue;
    }
    if (!ownCommits(row.commits)) issue(field + '.commits', row.commits, 'nonempty references to own typed top-level commits', row);
    if (row.mainHotfix !== undefined) issue(field + '.mainHotfix', row.mainHotfix, 'only fixed=false findings may request hotfix', row);
    const regression = row.regression;
    if (!object(regression)) { issue(field + '.regression', regression, 'own red and green regression', row); continue; }
    if (regression.kind === 'manual') {
      shape(regression, field + '.regression', ['kind', 'redEvidence', 'greenEvidence'], ['kind', 'redEvidence', 'greenEvidence'], row);
      if (!strings(regression.redEvidence) || !strings(regression.greenEvidence)) issue(field + '.regression', regression, 'manual red and green evidence addresses', row);
      manualEvidence = true;
      warnings.push({ change: row.change, item: row.item, field: field + '.regression', requirement: flowQaRequirement, received: 'manual', expected: 'main reviews manual evidence; authorship is not machine verified', remediation: 'Перевірити описові докази у чинному проході.' });
      continue;
    }
    shape(regression, field + '.regression', ['kind', 'group', 'red', 'green'], ['kind', 'group', 'red', 'green'], row);
    if (!['unit', 'integration'].includes(regression.kind) || !nonempty(regression.group)) { issue(field + '.regression', regression, 'unit or configured integration regression', row); continue; }
    const red = await machine(regression.red, field + '.regression.red', regression.kind === 'integration' ? 'integration' : 'red', regression.group);
    const green = await machine(regression.green, field + '.regression.green', regression.kind === 'integration' ? 'integration' : 'qa', regression.group);
    if (!red || !green) continue;
    if (red.runId === green.runId || !Number.isFinite(Date.parse(red.startedAt)) || !Number.isFinite(red.durationMs) || red.durationMs < 0 || Date.parse(red.startedAt) + red.durationMs > Date.parse(green.startedAt) || !Number.isFinite(Date.parse(green.startedAt))) issue(field + '.regression', regression, 'red completes before green starts', row);
    const ids = (values: readonly TestId[]) => values.map(value => JSON.stringify([value.file, value.name])).sort();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const redIds = red.selection.testIds.length ? red.selection.testIds : red.knownRed;
    const greenIds = green.selection.testIds;
    if (red.profileId !== green.profileId || !same([...red.selection.files].sort(), [...green.selection.files].sort()) || (greenIds.length ? !same(ids(redIds), ids(greenIds)) : red.selection.testIds.length > 0)) issue(field + '.regression', { red: red.selection, green: green.selection }, 'same profile and targeted regression, no wider green selection', row);
    if (regression.kind === 'integration') {
      const profile = ports.integrationProfiles?.find(profile => profile.profileId === red.profileId && profile.profileId === green.profileId && profile.group === regression.group);
      if (!profile || red.testKind !== 'integration' || green.testKind !== 'integration' || !same([...profile.files].sort(), [...red.selection.files].sort()) || red.timeoutPolicy?.timeoutMs !== profile.timeoutMs || green.timeoutPolicy?.timeoutMs !== profile.timeoutMs) issue(field + '.regression', regression, 'configured integration profile and timeout', row);
    } else if (red.testKind !== 'unit' || green.testKind !== 'unit') issue(field + '.regression', regression, 'unit TestRunResult', row);
    const redValid = red.outcome === 'assertions-failed' && red.knownRed.length > 0 || regression.kind === 'unit' && red.outcome === 'timed-out' && red.timedOut;
    if (!redValid || regression.red.cliCode === 0) issue(field + '.regression.red', red.outcome, 'target assertion red or initial unit timeout', row);
    const remainder = regression.kind === 'unit' && (green.timeoutCount ?? 0) >= ports.unitPolicy.maxGroupTimeouts && green.knownRed.length === 0 && green.unknown.length === 0 && ['complete', 'unverified-remainder'].includes(green.groupState ?? '') && ['complete', 'review-remainder'].includes(green.nextAction) && ['passed', 'unverified-remainder', 'timed-out'].includes(green.outcome);
    if (!(green.outcome === 'passed' && green.knownRed.length === 0 && green.unexecuted.length === 0 && regression.green.cliCode === 0) && !remainder) issue(field + '.regression.green', green, 'own green or explicitly permitted unit remainder', row);
    if (remainder) unverifiedRemainder.push(...green.unexecuted);
    if (red.knownRed.some(test => !green.passed.some(passed => passed.file === test.file && passed.name === test.name))) issue(field + '.regression.green', green.passed, 'all known red regression tests confirmed', row);
  }
  const followUpKeys = new Set<string>();
  for (const [index, row] of qa.followUps.entries()) {
    const field = `qa.followUps[${index}]`;
    if (!shape(row, field, ['change', 'item', 'sourceItem', 'scenario', 'purpose', 'reason', 'evidence'], ['change', 'item', 'sourceItem', 'scenario', 'purpose', 'reason', 'evidence'])) continue;
    address(row, field, true);
    const followUpKey = JSON.stringify([row.change, row.item, row.sourceItem, row.scenario]);
    if (followUpKeys.has(followUpKey)) issue(field, row, 'unique follow-up', row);
    followUpKeys.add(followUpKey);
    if (!seen.has(addressKey({ ...row, item: row.sourceItem }))) issue(field, row, 'source scenario from this QA', row);
    if (!nonempty(row.reason)) issue(field + '.reason', row.reason, 'nonempty reason', row);
    if (!['deployment', 'first-execution', 'working-main-hotfix'].includes(row.purpose)) issue(field + '.purpose', row.purpose, 'deployment, first-execution or proven working-main-hotfix; no defect-fix/repeat-qa', row);
    if (assigned(row, row.sourceItem) && !(await ports.readOpenItems(row.change)).includes(row.item)) issue(field + '.item', row.item, 'existing open follow-up in the same change', row);
    if (row.purpose === 'first-execution') warnings.push({ change: row.change, item: row.item, field, requirement: flowQaRequirement, received: row, expected: 'main verifies the unavailable prerequisite and first execution boundary', remediation: 'Звірте невиконаний сценарій та точну передумову; не зараховуйте подальшу дію як виконану.' });
    if (row.purpose === 'working-main-hotfix' && !qa.findings.some((finding: any) => finding.change === row.change && finding.item === row.sourceItem && finding.scenario === row.scenario && finding.fixed === false && finding.mainHotfix)) issue(field, row, 'matching working main bug finding', row);
  }
  for (const row of qa.scenarios) {
    if (!object(row)) continue;
    const itemStatus = report.changes?.find((change: any) => change.id === row.change)?.items?.find((item: any) => item.id === row.item)?.status;
    if (row.status === 'failed' && (report.status === 'succeeded' || itemStatus === 'succeeded') && !qa.findings.some((finding: any) => addressKey(finding) === addressKey(row) && finding.fixed === true)) issue('qa.scenarios', row, 'failed scenario requires matching fixed finding or failed item', row);
  }
  return result();
}
export async function verifyFlowQaSnapshot(snapshot: FlowVerifiedSnapshot, input: FlowQaReportInput, ports: FlowQaEvidencePorts): Promise<FlowCheckResult> {
  const checked = await validateFlowQaReport(input, ports);
  if (checked.ok && JSON.stringify(checked.snapshot) !== JSON.stringify(snapshot)) return { ...checked, ok: false, issues: [{ change: input.trusted.assignment.changes[0]?.id ?? '', item: input.trusted.assignment.changes[0]?.items[0]?.id ?? '', field: 'qa.snapshot', requirement: flowQaRequirement, received: checked.snapshot, expected: 'unchanged verified evidence snapshot', remediation: 'Повторно звірте поточний звіт та докази.', path: input.reportPath }] };
  return checked;
}
export async function recordFlowTestRun(caller: Pick<FlowQaLaunchContext, 'runId' | 'agentId' | 'project' | 'workspace'>, result: TestRunResult, stderr: string, cliCode: number, store: FlowTestRunStore): Promise<void> {
  await store.put({ testRunId: result.runId, agentRunId: caller.runId, agentId: caller.agentId, project: caller.project, workspace: caller.workspace, group: result.group, phase: result.phase, selection: structuredClone(result.selection), resultDigest: flowDigest(JSON.stringify(result)), stderrDigest: flowDigest(stderr), cliCode });
}
export async function cleanupFlowTestRuns(agentRunId: string, closed: boolean, store: FlowTestRunStore): Promise<void> {
  if (closed) await store.removeForAgentRun(agentRunId);
}
