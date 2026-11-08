import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CompiledCatalog } from './catalog.ts';

export function catalogWithBriefPhases<T extends CompiledCatalog>(catalog: T, confDirectory: string): T {
  if (!catalog.commands.some(command => command.handlerName === 'agent run')) return catalog;
  const directory = join(confDirectory, 'briefs', 'tasks');
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  const phases = new Set(entries.filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name.slice(0, -3)));
  const commands = catalog.commands.map(command => {
    if (command.handlerName !== 'agent run') return command;
    const values = (command.valueSources.phase ?? []).filter(value => phases.has(value.id));
    return { ...command, valueSources: { ...command.valueSources, phase: values },
      parameters: command.parameters.map(parameter => parameter.name === 'phase' ? { ...parameter, values } : parameter) };
  });
  return { ...catalog, commands };
}
