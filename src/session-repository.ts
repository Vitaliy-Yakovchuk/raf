import type { SessionRepository } from './session-state.ts';
import { openStateStore } from './state-store.ts';

export type SessionRepositoryHandle = {
  repository: SessionRepository;
  close(): void;
};

export function openSessionRepository(path: string): SessionRepositoryHandle {
  const store = openStateStore(path);
  return { repository: store.sessionRepository, close: () => store.close() };
}
