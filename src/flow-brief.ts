import { join } from 'node:path';
import { flowQaSchema } from './flow-qa-report.ts';
import type { AssignmentBriefContext, AssignmentSnapshot } from './assignment.ts';
import type { FlowQaLaunchContext } from './flow-qa-report.ts';

export interface FlowBriefInput {
  assignment: AssignmentSnapshot;
  context: AssignmentBriefContext;
  runId: string;
  branch: string;
  workingMain: { project: string; workspace: string; branch: string };
  source: { userQa: string; agentReport: string; agentRun: string; featureTestAuthoring: string; featureImplementation: string; unitTestRuns: string; testRuns: string; flowApproval: string };
}
export interface FlowBriefPreparation {
  context: AssignmentBriefContext;
  qa: FlowQaLaunchContext | null;
  prerequisites: readonly string[];
}
export function prepareFlowBrief(input: FlowBriefInput): FlowBriefPreparation {
  const { context, assignment, source } = input;
  const stage = context.stage;
  const prerequisites: string[] = [];
  const relevant = stage === 'qa' ? [source.userQa, source.agentReport, source.agentRun, source.unitTestRuns, source.testRuns, source.flowApproval]
    : stage === 'main' ? [source.userQa, source.agentReport, source.flowApproval]
    : stage === 'test-scaffold' ? [source.featureTestAuthoring, source.unitTestRuns, source.testRuns]
    : stage === 'implement' ? [source.featureImplementation, source.unitTestRuns, source.testRuns] : [];
  const schema = stage === 'qa' ? { ...context.reportSchema, required: [...new Set([...(context.reportSchema.required as string[] ?? []), 'qa'])], properties: { ...(context.reportSchema.properties as object ?? {}), qa: flowQaSchema } } : context.reportSchema;
  const scenarios = assignment.changes.flatMap(change => change.items.map(item => ({ change: change.id, item: item.id, scenario: item.description })));
  const guidance = stage === 'qa'
    ? 'QA сам у тому самому запуску: власний red → одразу fix коду, тестів чи фікстур (fixture) → green власної регресії без послаблення критеріїв. Без повторного проходу вже виконаних QA-сценаріїв, іншого тестувальника або нового QA-пункту. proposedTasks не замінює fix; передача через defect-fix/repeat-qa заборонена. qa містить scenarios/findings/followUps; первісний failed сценарій зберігається після fixed=true. Unit не замінює користувацький прохід. Manual redEvidence/greenEvidence має явну межу автоматичного доказу. Виняток mainHotfix — лише доведений баг робочої raf у main за flow-approval, не develop чи fixture. Deployment і first-execution залишаються відкритими діями тієї самої зміни. Збережи сценарії, середовище, збірку та точні відсутні передумови. Коміть докази до звіту й адресуй їх із результату tasks.md; галочку доручення ставить raf. Не обходь sandbox або відсутній канал test run.'
    : stage === 'main' ? 'Знайдений QA дефект виправляє той самий qa у тому самому запуску red → fix → green. Не передавай QA-fix новим test-scaffold/implement/qa, не забороняй потрібні правки тестів/fixture. Приймай штатний unit-доказ без ручного дублювання; недоступний сценарій лишається відкритим до першого проходу. Виняток — лише доведений баг робочої raf main за flow-approval.'
    : stage === 'test-scaffold' ? 'Можна читати код проєкту для авторства тестів і каркаса; сам підтвердь власний первинний red через дозволений raf test run --phase red. Setup/import не red. Передай повний TestRunResult, stderr, CLI code та незмінну unit-групу.'
    : stage === 'implement' ? 'Заверши незалежну початкову реалізацію за контрактом і каркасом до читання підготовлених тестів. Потім отримай цільовий unit-результат через дозволений raf test run, збережи TestRunResult, stderr і CLI code та чесний залишок.' : '';
  if (stage === 'qa' && (!context.cwd || !context.writeBoundaries.includes(context.cwd))) prerequisites.push('Потрібні write-boundaries для власного виправлення коду, тестів і fixture.');
  if (stage === 'qa' && !context.rafSubcommands?.includes('test run')) prerequisites.push('Потрібний авторизований канал raf test run для red/qa; відсутність не дозволяє обходити sandbox.');
  const additions = [guidance, stage === 'qa' ? 'Обов’язкові QA-сценарії: ' + JSON.stringify(scenarios) : '', prerequisites.length ? 'Передумови: ' + prerequisites.join(' ') : ''].filter(text => text && !context.outcome.includes(text));
  const prepared = { ...context, sources: [...new Set([...context.sources, ...relevant])], reportSchema: schema, outcome: [context.outcome, ...additions].join('\n') };
  const qa: FlowQaLaunchContext | null = stage === 'qa' ? { stage, runId: input.runId, agentId: context.agentId, project: context.project, workspace: context.cwd ?? '', branch: input.branch, assignment, reportSchema: schema, scenarios, allowedEvidenceRoots: [...new Set([context.cwd, ...assignment.changes.map(change => join(assignment.root, 'openspec/changes', change.id))].filter((path): path is string => !!path))], workingMain: input.workingMain } : null;
  return { context: prepared, qa, prerequisites };
}
