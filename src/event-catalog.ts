import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { EventCatalog } from './event-registry.ts';

export function loadEventCatalog(orchestratorRoot: string): EventCatalog {
  if (typeof orchestratorRoot !== 'string' || !isAbsolute(orchestratorRoot)) throw new Error('Absolute orchestratorRoot required for the event catalog');
  const path = join(orchestratorRoot, 'conf', 'raf-constants.json');
  let constants: unknown;
  try { constants = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read event catalog ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!object(constants) || !Array.isArray(constants.events) || !constants.events.length || !object(constants.eventIdKinds)) throw new Error(`Invalid event catalog in ${path}`);
  const idKinds = constants.eventIdKinds;
  if (!Object.values(idKinds).every(text)) throw new Error(`Invalid eventIdKinds in ${path}`);
  const events = constants.events.map((event: unknown) => {
    if (!object(event) || !text(event.id) || !text(event.idKind) || !Object.hasOwn(idKinds, event.idKind) || typeof event.description !== 'string') throw new Error(`Invalid event entry in ${path}`);
    return Object.freeze({ id: event.id, idKind: event.idKind, description: event.description });
  });
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error(`Duplicate event IDs in ${path}`);
  return Object.freeze({ events: Object.freeze(events), eventIdKinds: Object.freeze({ ...idKinds }) as Readonly<Record<string, string>> });
}

export function validateEventObjectId(idKind: string, id: string): boolean {
  if (typeof id !== 'string' || !id.trim() || id !== id.trim() || /[\s/\\\0]/.test(id)) return false;
  if (idKind === 'agentAddress' || idKind === 'reminderId' || idKind === 'contextReviewId') return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
  if (idKind === 'changeId') return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
  return idKind === 'deploymentId';
}

export function validateEventId(catalog: EventCatalog, kind: string, id: string): boolean {
  if (!catalog || typeof kind !== 'string') return false;
  const idKind = catalog.events.find(event => event.id === kind)?.idKind ?? (Object.hasOwn(catalog.eventIdKinds, kind) ? kind : undefined);
  if (!idKind || !Object.hasOwn(catalog.eventIdKinds, idKind)) return false;
  return validateEventObjectId(idKind, id);
}
