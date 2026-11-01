import { randomUUID } from 'node:crypto';
import type { StateStore } from './state-store.ts';
import type { PendingIntent } from './session-state.ts';
import type { StartupContextDueEvent } from './startup-context.ts';

export async function deliverStartupContextEvents(store: StateStore, now: () => string, deliver?: (intent: PendingIntent) => Promise<boolean>): Promise<void> {
  const database = store.startupContextDatabase;
  const pending = store.sessionRepository.transaction(tx => tx.listPending(), 'read');
  for (const intent of pending.filter(row => row.event === 'context-review.due')) {
    const attemptId = randomUUID();
    const claimed = store.sessionRepository.transaction(tx => {
      const row = database.prepare('SELECT payload, review_run_id, closed_at FROM startup_context_reviews WHERE id=?').get(intent.id);
      if (!row) throw new Error(`Context review package ${intent.id} is missing; delivery requires investigation`);
      const event: StartupContextDueEvent = JSON.parse(row.payload as string);
      const markDelivered = () => {
        const current = tx.listPending().find(item => item.id === intent.id);
        if (current) database.prepare('UPDATE pending_intents SET payload=? WHERE id=?').run(JSON.stringify({ ...current, payload: { ...(current.payload as object), kind: intent.event, id: intent.id, mainDelivered: true } }), intent.id);
      };
      if (event.mainDelivery?.state === 'delivered' || row.review_run_id !== null || row.closed_at !== null || (intent.payload as any).mainDelivered) {
        if (event.mainDelivery?.state !== 'delivered') {
          database.prepare('UPDATE startup_context_reviews SET payload=? WHERE id=?').run(JSON.stringify({ ...event, mainDelivery: { ...event.mainDelivery, state: 'delivered', deliveredAt: now() } }), intent.id);
        }
        markDelivered();
        return false;
      }
      if (event.mainDelivery || !deliver || !(tx.listActiveSessions?.() ?? tx.listSessions()).some(session => session.addressId === event.to && session.state === 'running')) return false;
      database.prepare('UPDATE startup_context_reviews SET payload=? WHERE id=?').run(JSON.stringify({ ...event, mainDelivery: { state: 'uncertain', attemptId, attemptedAt: now(), reason: 'Delivery attempt started; acceptance is not confirmed' } }), intent.id);
      return true;
    });
    if (!claimed) continue;
    let accepted = false;
    let reason = 'Delivery receipt is unconfirmed';
    try { accepted = await deliver!(intent); }
    catch (error) { reason = error instanceof Error ? error.message : String(error); }
    store.sessionRepository.transaction(tx => {
      const row = database.prepare('SELECT payload FROM startup_context_reviews WHERE id=?').get(intent.id);
      if (!row) throw new Error(`Context review package ${intent.id} disappeared during delivery`);
      const event: StartupContextDueEvent = JSON.parse(row.payload as string);
      if (event.mainDelivery?.attemptId !== attemptId || event.mainDelivery.state === 'delivered') return;
      const mainDelivery = accepted ? { ...event.mainDelivery, state: 'delivered', deliveredAt: now(), reason: undefined } : { ...event.mainDelivery, reason };
      database.prepare('UPDATE startup_context_reviews SET payload=? WHERE id=?').run(JSON.stringify({ ...event, mainDelivery }), intent.id);
      const current = tx.listPending().find(item => item.id === intent.id);
      if (accepted && current) database.prepare('UPDATE pending_intents SET payload=? WHERE id=?').run(JSON.stringify({ ...current, payload: { ...(current.payload as object), kind: intent.event, id: intent.id, mainDelivered: true } }), intent.id);
    });
    if (!accepted) process.stderr.write(`context-review.due ${intent.id}: delivery uncertain; automatic retry blocked: ${reason}\n`);
  }
}
