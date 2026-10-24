import type { AssignmentSnapshot } from './assignment.ts';
import { flowQaRequirement } from './flow-qa-report.ts';
import type { FlowCheckResult, FlowScenarioAddress, FlowIssue } from './flow-qa-report.ts';

export interface FlowPlanDocument { change: string; path: string; text: string; }
export interface FlowPlanEvidence {
  path: string;
  digest: string;
  acceptedDigest: string | null;
  agentRunId: string;
  scenarios: readonly (FlowScenarioAddress & { status: 'succeeded' | 'failed'; executed: boolean })[];
  findings: readonly (FlowScenarioAddress & { fixed: boolean })[];
  workingMainHotfix?: { verified: boolean; project: string; workspace: string; branch: string };
}
export interface FlowTaskPlanInput {
  assignment: AssignmentSnapshot;
  phase: 'launch' | 'report';
  initial: readonly FlowPlanDocument[];
  current: readonly FlowPlanDocument[];
  evidence: readonly FlowPlanEvidence[];
  workingMain: { project: string; workspace: string; branch: string };
}
const references = (text: string, address: string) => new RegExp('(?:^|[^\\p{L}\\p{N}_.:-])' + address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_.:-])', 'u').test(text);
export async function validateFlowTaskPlan(input: FlowTaskPlanInput): Promise<FlowCheckResult> {
  const issues: FlowIssue[] = [], warnings: FlowIssue[] = [];
  for (const document of input.current) {
    const change = input.assignment.changes.find(change => change.id === document.change);
    if (!change) continue;
    const initial = input.initial.find(row => row.change === document.change)?.text ?? '';
    const rows = document.text.split('\n');
    for (const [index, line] of rows.entries()) {
      const task = line.match(/^\s*-\s+\[([ xX])\]\s+(\S+)\s+(.+)$/);
      if (!task || task[1].toLowerCase() === 'x') continue;
      const [, , item, description] = task;
      const unchanged = input.phase === 'report' && initial.split('\n').some(row => row.trim() === line.trim());
      const explicit = /(?:повтор|repeat|retest|не QA|not QA|defect.fix|QA.fix|іншим агентом|передач[аіу].*fix|QA після викладки)/iu.test(description);
      const failedQa = input.evidence.some(evidence => evidence.scenarios.some(scenario => scenario.change === document.change && scenario.status === 'failed'));
      const afterQa = failedQa && /\[(?:test-scaffold|implement|qa)\]/u.test(description);
      if (!explicit && !afterQa) continue;
      const permitted = /(?:first.execution|перш(?:ий|ого|е)|вперше|перевір(?:ка|ити) (?:результат|факт).*виклад|deployment result)/iu.test(description) && !/(?:repeat.qa|повторити.*QA)/iu.test(description);
      const candidates = input.evidence.filter(evidence => description.includes(evidence.path));
      const proven = candidates.find(evidence => evidence.acceptedDigest !== null && evidence.digest === evidence.acceptedDigest && !!evidence.agentRunId && (
        evidence.scenarios.some(scenario => scenario.executed && description.includes(scenario.scenario) && (references(description, `${scenario.change}:${scenario.item}`) || scenario.change === document.change && references(description, scenario.item))) ||
        evidence.findings.some(finding => description.includes(finding.scenario) && (references(description, `${finding.change}:${finding.item}`) || finding.change === document.change && references(description, finding.item)))
      ));
      const transfer = /(?:repeat.qa|повторити|повторний прохід|repeat|retest|defect.fix|QA.fix|іншим агентом|передач[аіу].*fix)/iu.test(description);
      if (permitted && !(proven && transfer)) continue;
      if (unchanged && !proven) continue;
      if (proven?.workingMainHotfix?.verified && /(?:hotfix|хотфікс)/iu.test(description) && Object.entries(input.workingMain).every(([key, value]) => (proven.workingMainHotfix as any)[key] === value)) continue;
      const issue: FlowIssue = { change: document.change, item, field: 'tasks.md', path: document.path, line: index + 1, requirement: flowQaRequirement, received: description, expected: proven ? 'no transfer of QA fix or repeat of an executed scenario' : 'verified provenance before concluding QA repetition', remediation: proven ? 'Залиште виправлення тому самому QA у тому самому запуску; збережіть тільки дозволені подальші дії.' : 'Main має звірити адресований QA-доказ і відрізнити перший прохід/викладку від повтору.' };
      (proven ? issues : warnings).push(issue);
    }
  }
  return { ok: issues.length === 0, issues, warnings, manualEvidence: false, unverifiedRemainder: [] };
}
