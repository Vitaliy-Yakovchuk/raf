import { openStateStore } from './state-store.ts';
import type { ReminderRepository, SessionEnd } from './reminders.ts';

export type ReminderRepositoryHandle = {
  repository: ReminderRepository;
  close(): void;
};

export type ReminderSessionEffect = {
  id: string;
  domain: 'reminders';
  payload: {
    operation: 'session-ended';
    runId: string;
    end: SessionEnd;
    at: string;
  };
};

export function openReminderRepository(path: string): ReminderRepositoryHandle {
  const store = openStateStore(path);
  return { repository: store.reminderRepository, close: () => store.close() };
}
