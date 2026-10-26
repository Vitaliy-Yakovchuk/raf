import type { AssignmentBriefContext } from './assignment.ts';

export interface FlowBriefInput {
  context: AssignmentBriefContext;
  source: { userQa: string; agentReport: string; agentRun: string; featureTestAuthoring: string; featureImplementation: string; unitTestRuns: string; testRuns: string; flowApproval: string };
}
export interface FlowBriefPreparation {
  context: AssignmentBriefContext;
}
export function prepareFlowBrief(input: FlowBriefInput): FlowBriefPreparation {
  const { context, source } = input;
  const stage = context.stage;
  const relevant = stage === 'qa' ? [source.userQa, source.agentReport, source.agentRun, source.unitTestRuns, source.testRuns, source.flowApproval]
    : stage === 'main' ? [source.userQa, source.agentReport, source.flowApproval]
    : stage === 'test-scaffold' ? [source.featureTestAuthoring, source.unitTestRuns, source.testRuns]
    : stage === 'implement' ? [source.featureImplementation, source.unitTestRuns, source.testRuns] : [];
  const guidance = stage === 'qa'
    ? 'QA сам у тому самому запуску: власний red → одразу fix коду, тестів чи фікстур (fixture) → green власної регресії без послаблення критеріїв. Без повторного проходу вже виконаних QA-сценаріїв, іншого тестувальника або нового QA-пункту. proposedTasks не замінює fix; передача через defect-fix/repeat-qa заборонена. qa містить scenarios/findings/followUps; первісний failed сценарій зберігається після fixed=true. Unit не замінює користувацький прохід. Manual redEvidence/greenEvidence має явну межу автоматичного доказу. Виняток mainHotfix — лише доведений баг робочої raf у main за flow-approval, не develop чи fixture. Deployment і first-execution залишаються відкритими діями тієї самої зміни. Збережи сценарії, середовище, збірку та точні відсутні передумови. Коміть докази до звіту й адресуй їх із результату tasks.md; галочку доручення ставить raf. Не обходь sandbox або відсутній канал test run.'
    : stage === 'main' ? 'Знайдений QA дефект виправляє той самий qa у тому самому запуску red → fix → green. Не передавай QA-fix новим test-scaffold/implement/qa, не забороняй потрібні правки тестів/fixture. Приймай штатний unit-доказ без ручного дублювання; недоступний сценарій лишається відкритим до першого проходу. Виняток — лише доведений баг робочої raf main за flow-approval.'
    : stage === 'test-scaffold' ? 'Можна читати код проєкту для авторства тестів і каркаса; сам підтвердь власний первинний red через дозволений raf test run --phase red. Setup/import не red. Передай повний TestRunResult, stderr, CLI code та незмінну unit-групу.'
    : stage === 'implement' ? 'Заверши незалежну початкову реалізацію за контрактом і каркасом до читання підготовлених тестів. Потім отримай цільовий unit-результат через дозволений raf test run, збережи TestRunResult, stderr і CLI code та чесний залишок.' : '';
  const additions = [guidance].filter(text => text && !context.outcome.includes(text));
  const prepared = { ...context, sources: [...new Set([...context.sources, ...relevant])], outcome: [context.outcome, ...additions].join('\n') };
  return { context: prepared };
}
