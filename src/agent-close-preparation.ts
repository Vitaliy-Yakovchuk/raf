import type { CompiledCatalog } from './catalog.ts';
import { sameProcessOwnership } from './process-identity.ts';
import { commandFailure } from './cli-contract.ts';
import { forceCloseInTransaction } from './session-state.ts';
import type { SessionRecord, SessionRepository, SessionTransaction } from './session-state.ts';

export type AgentCloseOptions = { force?: boolean; reason?: string };

export type AcceptedCloseReport = {
  runId: string;
  status: 'succeeded' | 'failed';
  eventRecorded: boolean;
};

export interface AgentClosePreparationDependencies {
  compiledCatalog?: CompiledCatalog;
  repository: SessionRepository;
  acceptPendingReport(session: SessionRecord): Promise<SessionRecord>;
  acceptedReport(transaction: SessionTransaction, session: SessionRecord): AcceptedCloseReport | null;
  eventForStatus(status: 'succeeded' | 'failed'): string;
}

export async function prepareAgentClose(
  dependencies: AgentClosePreparationDependencies,
  session: SessionRecord,
  options: AgentCloseOptions = {},
): Promise<SessionRecord> {
  if ((options.force !== undefined && typeof options.force !== 'boolean') || (options.force === true && (typeof options.reason !== 'string' || !options.reason.trim()))) throw new Error('Force requires a nonempty reason');
  if (!options.force) await dependencies.acceptPendingReport(session);
  return dependencies.repository.transaction(tx => {
    const current = tx.getSession(session.runId);
    if (!current || current.addressId !== session.addressId || (current.state !== 'running' && !(options.force && current.state === 'exited')) || !current.process || !session.process || !sameProcessOwnership(current.process, session.process)) throw new Error(`Run ${session.runId} is no longer the selected live session`);
    const fact = dependencies.acceptedReport(tx, current);
    const ready = !!current.result && fact?.runId === current.runId && fact.status === current.result.status && fact.eventRecorded;
    if (!options.force && !ready) {
      const close = dependencies.compiledCatalog?.commands.find(command => command.path.join(' ') === 'agent close');
      const supported = (name: string, type: string) => close?.parameters.some(parameter => parameter.name === name && parameter.option === `--${name}` && (parameter.type ?? 'string') === type && !parameter.multiple);
      const forceSupported = supported('id', 'string') && supported('force', 'boolean') && supported('reason', 'string');
      const remediation = [
        'Дочекайтеся правдивого прийняття звіту початкового доручення; резерв зберігається до підтвердженого виходу та фіналізації.',
        ...(forceSupported ? [`Уповноважений main може виконати raf agent close --id ${current.addressId} --force --reason TEXT, задавши власну непорожню причину; перевірки identity, main і нагадувань збережені.`]
          : ['Примусове закриття недоступне або не підтверджене compiled artifact цього покоління. Main має штатно зібрати, перевірити та активувати узгоджене покоління з підтримкою примусового закриття, потім повторно перевірити запуск.']),
        'raf help agent close',
      ];
      const error = commandFailure({ code: 'AGENT_RESULT_PENDING', message: `Звіт запуску ${current.runId} та подію результату ще не прийнято.\n${remediation.join('\n')}`, stage: 'close', source: 'agent-control', sourceCode: null, reason: 'Current run lacks an atomically accepted report and result event', received: { id: current.addressId, runId: current.runId }, expected: 'Accepted report and corresponding result event for this runId', found: { id: current.addressId, runId: current.runId, report: fact ? 'accepted' : 'pending', eventRecorded: fact?.eventRecorded ?? false }, completed: [], pending: ['report acceptance', 'close'], retrySafe: true, remediation });
      throw Object.assign(error, { code: 'AGENT_RESULT_PENDING' });
    }
    return options.force ? forceCloseInTransaction(tx, current, options.reason!.trim(), dependencies.eventForStatus('failed')) : current;
  });
}
