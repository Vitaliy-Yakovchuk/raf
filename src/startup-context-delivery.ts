import { randomUUID } from 'node:crypto';
import type { StateStore } from './state-store.ts';
import type { PendingIntent } from './session-state.ts';
import { pendingStartupContextReviewEvent, type StartupContextDueEvent } from './startup-context.ts';

function planContextReviewOutbox(store: StateStore, pending: PendingIntent[]) {
  const database = store.startupContextDatabase;
  const due = pendingStartupContextReviewEvent(database);
  if (!due && !database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='startup_context_reviews'").get()) return { pending, obsolete: [], current: undefined, replacement: null };
  const openIds = new Set(database.prepare('SELECT id FROM startup_context_reviews WHERE closed_at IS NULL AND review_run_id IS NULL').all().map(row => row.id));
  const obsolete = pending.filter(intent => intent.event === 'context-review.due' && openIds.has(intent.id) && intent.id !== due?.id && !(intent.payload as any).mainDelivered);
  const current = due && pending.find(intent => intent.id === due.id);
  let replacement: PendingIntent | null = null;
  if (due && current) {
    const updated = { ...current, payload: { ...(current.payload as object), to: due.to, runIds: due.runIds } };
    if (JSON.stringify(updated) !== JSON.stringify(current)) replacement = updated;
  } else if (due && !due.mainDelivery) {
    replacement = { id: due.id, runId: due.runIds[0] ?? null, event: due.event, payload: { to: due.to, runIds: due.runIds } };
  }
  return { pending, obsolete, current, replacement };
}

export async function deliverStartupContextEvents(store: StateStore, now: () => string, deliver?: (intent: PendingIntent) => Promise<boolean>): Promise<void> {
  const database = store.startupContextDatabase;
  const plan = store.sessionRepository.transaction(tx => planContextReviewOutbox(store, tx.listPending()), 'read');
  const pending = plan.obsolete.length === 0 && !plan.replacement ? plan.pending : store.sessionRepository.transaction(tx => {
    const changes = planContextReviewOutbox(store, tx.listPending());
    for (const intent of changes.obsolete) tx.deletePending(intent.id);
    if (changes.replacement) {
      if (changes.current) database.prepare('UPDATE pending_intents SET payload=? WHERE id=?').run(JSON.stringify(changes.replacement), changes.replacement.id);
      else tx.putPending(changes.replacement);
    }
    return tx.listPending();
  });
  for (const intent of pending.filter(row => row.event === 'context-review.due')) {
    const row = database.prepare('SELECT payload, review_run_id, closed_at FROM startup_context_reviews WHERE id=?').get(intent.id);
    if (!row) throw new Error(`Context review package ${intent.id} is missing; delivery requires investigation`);
    const event: StartupContextDueEvent = JSON.parse(row.payload as string);
    if (event.mainDelivery?.state === 'delivered' && (intent.payload as any).mainDelivered) continue;
    if (event.mainDelivery && event.mainDelivery.state !== 'delivered' && row.review_run_id === null && row.closed_at === null && !(intent.payload as any).mainDelivered) continue;
    if (!event.mainDelivery && row.review_run_id === null && row.closed_at === null && !(intent.payload as any).mainDelivered &&
        (!deliver || !store.sessionRepository.transaction(tx => (tx.listActiveSessions?.() ?? tx.listSessions()).some(session => session.addressId === event.to && session.state === 'running'), 'read'))) continue;
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
