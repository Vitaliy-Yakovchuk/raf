import { parseCommandArguments, validateCommandConstraints } from './cli-arguments.ts';

export interface CatalogValue {
  id: string;
  event?: string;
  description?: string;
  launchableByRaf?: boolean;
}

export interface CompiledParameter {
  name: string;
  type?: string;
  option: string;
  required?: boolean;
  multiple?: boolean;
  description?: string;
  default?: unknown;
  values?: readonly CatalogValue[];
}

export interface CompiledCommand {
  path: readonly string[];
  handlerName: string;
  description?: string;
  parameters: readonly CompiledParameter[];
  valueSources: Readonly<Record<string, readonly CatalogValue[]>>;
  metadata: Readonly<Record<string, unknown>>;
}

export interface CompiledCatalog {
  constants?: Readonly<Record<string, unknown>>;
  models?: Readonly<Record<string, unknown>>;
  projects?: Readonly<Record<string, unknown>>;
  errorCodes?: readonly (CatalogValue & { exitCode: number })[];
  commands: readonly CompiledCommand[];
  reportStatuses: readonly CatalogValue[];
}

export function compileCatalog(
  constants: unknown,
  models: unknown,
  handlerNames: readonly string[],
  projects?: unknown,
): CompiledCatalog {
  const object = (value: unknown, source: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: expected object`);
    return value as Record<string, unknown>;
  };
  const values = (value: unknown, source: string): CatalogValue[] => {
    if (!Array.isArray(value)) throw new Error(`${source}: expected array`);
    if (!value.length) throw new Error(`${source}: empty value source`);
    const shape = typeof value[0] === 'string' ? 'string' : 'object';
    const ids = new Map<string, number>();
    return value.map((item, index) => {
      if ((typeof item === 'string' ? 'string' : 'object') !== shape) throw new Error(`${source}/${index}: heterogeneous value source`);
      const entry = typeof item === 'string' ? { id: item } : object(item, `${source}/${index}`);
      if (typeof entry.id !== 'string' || !entry.id.trim()) throw new Error(`${source}/${index}/id: invalid id`);
      if (ids.has(entry.id)) throw new Error(`${source}/${index}/id: duplicate id ${entry.id}; first at ${source}/${ids.get(entry.id)}/id`);
      if (entry.description !== undefined && typeof entry.description !== 'string') throw new Error(`${source}/${index}: invalid description`);
      if (entry.launchableByRaf !== undefined && typeof entry.launchableByRaf !== 'boolean') throw new Error(`${source}/${index}: invalid launchableByRaf`);
      ids.set(entry.id, index);
      return { ...entry } as unknown as CatalogValue;
    });
  };
  const roots: Record<string, Record<string, unknown>> = { 'raf-constants.json': object(constants, 'raf-constants.json'), 'models.json': object(models, 'models.json') };
  if (projects !== undefined) roots['projects.json'] = object(projects, 'projects.json');
  const resolve = (reference: unknown, source: string): CatalogValue[] => {
    if (typeof reference !== 'string') throw new Error(`${source}: expected reference string`);
    const match = /^(raf-constants\.json|models\.json|projects\.json)#(\/.*)$/.exec(reference);
    if (!match || !Object.hasOwn(roots, match[1])) throw new Error(`${source}: unresolved reference ${reference}`);
    let node: unknown = roots[match[1]];
    for (const token of match[2].slice(1).split('/')) {
      if (/~(?![01])/.test(token)) throw new Error(`${source}: invalid reference ${reference}`);
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) throw new Error(`${source}: unresolved reference ${reference}`);
      node = (node as Record<string, unknown>)[key];
    }
    if (match[1] === 'projects.json' && match[2] === '/projects' && node && typeof node === 'object' && !Array.isArray(node)) node = Object.keys(node);
    return values(node, `${source} -> ${reference}`);
  };
  const raw = roots['raf-constants.json'];
  if (!Array.isArray(raw.commands)) throw new Error('raf-constants.json#/commands: expected array');
  for (const [name, entries] of Object.entries(raw)) if (Array.isArray(entries) && name !== 'commands') values(entries, `raf-constants.json#/${name}`);
  const events = Array.isArray(raw.events) ? values(raw.events, 'raf-constants.json#/events') : [];
  if (raw.eventIdKinds !== undefined) {
    const kinds = object(raw.eventIdKinds, 'raf-constants.json#/eventIdKinds');
    events.forEach((event, index) => {
      if (typeof (event as any).idKind !== 'string' || !Object.hasOwn(kinds, (event as any).idKind)) throw new Error(`raf-constants.json#/events/${index}/idKind: unknown reference ${(event as any).idKind}`);
    });
  }
  const statuses = values(raw.reportStatuses, 'raf-constants.json#/reportStatuses');
  if (raw.events !== undefined) statuses.forEach((status, index) => {
    if (!events.some(event => event.id === status.event)) throw new Error(`raf-constants.json#/reportStatuses/${index}/event: unknown reference ${status.event}`);
  });
  const errors = raw.errorCodes === undefined ? undefined : values(raw.errorCodes, 'raf-constants.json#/errorCodes');
  const paths = new Map<string, number>();
  const commands = raw.commands.map((item, index): CompiledCommand => {
    const source = `raf-constants.json#/commands/${index}`;
    const entry = object(item, source);
    if (!Array.isArray(entry.path) || !entry.path.length || entry.path.some(p => typeof p !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(p))) throw new Error(`${source}/path: invalid command path`);
    const path = [...entry.path] as string[];
    const handlerName = path.join(' ');
    if (paths.has(handlerName)) throw new Error(`${source}/path: duplicate command ${handlerName}; first at raf-constants.json#/commands/${paths.get(handlerName)}/path`);
    paths.set(handlerName, index);
    if (handlerName !== 'help' && !handlerNames.includes(handlerName)) throw new Error(`${source}: missing handler ${handlerName}`);
    if (entry.description !== undefined && typeof entry.description !== 'string') throw new Error(`${source}/description: expected string`);
    const valueSources: Record<string, CatalogValue[]> = Object.create(null);
    for (const [name, reference] of Object.entries(object(entry.valueSources ?? {}, `${source}/valueSources`))) valueSources[name] = resolve(reference, `${source}/valueSources/${name}`);
    if (entry.parameters !== undefined && !Array.isArray(entry.parameters)) throw new Error(`${source}/parameters: expected array`);
    const names = new Map<string, number>();
    const options = new Map<string, number>();
    const parameters = ((entry.parameters ?? []) as unknown[]).map((value, i): CompiledParameter => {
      const where = `${source}/parameters/${i}`;
      const p = object(value, where);
      if (typeof p.name !== 'string' || !p.name || typeof p.option !== 'string' || !/^--[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(p.option) || p.option === '--help') throw new Error(`${where}: invalid parameter name or option`);
      if (names.has(p.name)) throw new Error(`${where}/name: duplicate parameter ${p.name}; first at ${source}/parameters/${names.get(p.name)}/name`);
      if (options.has(p.option)) throw new Error(`${where}/option: duplicate option ${p.option}; first at ${source}/parameters/${options.get(p.option)}/option`);
      names.set(p.name, i); options.set(p.option, i);
      for (const key of ['required', 'multiple']) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error(`${where}/${key}: expected boolean`);
      if (p.description !== undefined && typeof p.description !== 'string') throw new Error(`${where}/description: expected string`);
      if (p.type !== undefined && p.type !== 'string' && p.type !== 'boolean') throw new Error(`${where}/type (${p.name}): unsupported parameter type`);
      for (const key of ['values', 'enum', 'valueSource']) if (p[key] !== undefined) throw new Error(`${where}/${key} (${p.name}): enum values must use command valueSources`);
      const allowed = valueSources[p.name];
      if (p.type === 'boolean' && (p.multiple === true || allowed !== undefined)) throw new Error(`${where} (${p.name}): boolean flags cannot be multiple or use valueSources`);
      if (p.type === 'boolean' && p.default !== undefined && typeof p.default !== 'boolean') throw new Error(`${where}/default: expected boolean`);
      if (p.type !== 'boolean' && p.default !== undefined) {
        const defaults = p.multiple ? p.default : [p.default];
        if (!Array.isArray(defaults) || !defaults.length || defaults.some(v => typeof v !== 'string' || !v.trim() || (allowed && !allowed.some(a => a.id === v)))) throw new Error(`${where}/default: invalid default`);
      }
      return { ...p, type: p.type ?? 'string', required: p.required ?? false, multiple: p.multiple ?? false, values: allowed } as unknown as CompiledParameter;
    });
    for (const name of Object.keys(valueSources)) {
      if (!names.has(name) && !(handlerName === 'runner list' && name === 'runner')) throw new Error(`${source}/valueSources/${name}: unknown parameter or display source`);
    }
    if (entry.errorCodes !== undefined) {
      if (!Array.isArray(entry.errorCodes)) throw new Error(`${source}/errorCodes: expected array`);
      entry.errorCodes.forEach((code, i) => { if (!errors?.some(error => error.id === code)) throw new Error(`${source}/errorCodes/${i}: unknown error code ${code}`); });
    }
    return { path, handlerName, description: entry.description as string | undefined, parameters, valueSources, metadata: { ...entry } };
  });
  const catalog = { commands, reportStatuses: statuses, constants: raw, models: roots['models.json'], projects: roots['projects.json'], errorCodes: errors as (CatalogValue & { exitCode: number })[] | undefined };
  for (const [index, command] of commands.entries()) {
    const examples = command.metadata.examples;
    if (examples === undefined) continue;
    if (!Array.isArray(examples)) throw new Error(`raf-constants.json#/commands/${index}/examples: expected array`);
    examples.forEach((example, i) => {
      const source = `raf-constants.json#/commands/${index}/examples/${i}`;
      const tokens = tokenizeExample(example, source);
      if (tokens.shift() !== 'raf' || !command.path.every(token => token === tokens.shift())) throw new Error(`${source}: example does not match command path`);
      if (command.handlerName === 'help') {
        if (!commands.some(candidate => tokens.every((token, j) => candidate.path[j] === token))) throw new Error(`${source}: unknown help path`);
      } else {
        const parsed = parseCommandArguments(tokens, command);
        if ('error' in parsed) throw new Error(`${source}: ${parsed.error.code}: ${parsed.error.message}`);
        const constraint = validateCommandConstraints(parsed.params, command);
        if (constraint) throw new Error(`${source}: ${constraint.code}: ${constraint.message}`);
      }
    });
  }
  for (const name of ['runners', 'models']) if (roots['models.json'][name] !== undefined) values(roots['models.json'][name], `models.json#/${name}`);
  return structuredClone(catalog);
}

function tokenizeExample(example: unknown, source: string): string[] {
  if (typeof example !== 'string' || !example.trim()) throw new Error(`${source}: expected nonempty example`);
  const tokens: string[] = [];
  let word = '', quote = '', started = false;
  for (let index = 0; index < example.length; index++) {
    const character = example[index];
    if (quote) {
      if (character === quote) quote = '';
      else if (character === '\\' && quote === '"') {
        if (++index >= example.length) throw new Error(`${source}: incomplete escape`);
        word += example[index];
      } else word += character;
    } else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (/\s/.test(character)) { if (started) { tokens.push(word); word = ''; started = false; } }
    else if (/[;&|<>`$]/.test(character)) throw new Error(`${source}: example must be a literal command`);
    else if (character === '\\') {
      if (++index >= example.length) throw new Error(`${source}: incomplete escape`);
      word += example[index]; started = true;
    } else { word += character; started = true; }
  }
  if (quote) throw new Error(`${source}: unterminated quote`);
  if (started) tokens.push(word);
  return tokens;
}
