import type { DatabaseSync } from 'node:sqlite';

export type MessageDeliveryObservation = {
  accepted: boolean;
  reason: string | null;
  paneBeforeHash: string | null;
  paneAfterHash: string | null;
};

export type ReminderDeliveryAttempt = {
  id: string;
  reminderId: string;
  pid: number;
  startedAt: string;
  completedAt: string | null;
  accepted: boolean | null;
  reason: string | null;
  receiptId: string | null;
  markWritten: boolean;
  transport: MessageDeliveryObservation | null;
};

export function recordReminderDeliveryAttempt(database: DatabaseSync, attempt: ReminderDeliveryAttempt): void {
  database.exec('CREATE TABLE IF NOT EXISTS reminder_delivery_attempts (id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT');
  database.prepare(`INSERT INTO reminder_delivery_attempts(id, reminder_id, payload) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(attempt.id, attempt.reminderId, JSON.stringify(attempt));
}
