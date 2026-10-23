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
    const ids = new Set<string>();
    return value.map((item, index) => {
      const entry = typeof item === 'string' ? { id: item } : object(item, `${source}/${index}`);
      if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new Error(`${source}/${index}: invalid or duplicate id`);
      if (entry.description !== undefined && typeof entry.description !== 'string') throw new Error(`${source}/${index}: invalid description`);
      if (entry.launchableByRaf !== undefined && typeof entry.launchableByRaf !== 'boolean') throw new Error(`${source}/${index}: invalid launchableByRaf`);
      ids.add(entry.id);
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
    if (match[1] === 'projects.json' && node && typeof node === 'object' && !Array.isArray(node)) node = Object.keys(node);
    return values(node, `${source} -> ${reference}`);
  };
  const raw = roots['raf-constants.json'];
  if (!Array.isArray(raw.commands)) throw new Error('raf-constants.json#/commands: expected array');
  const paths = new Set<string>();
  const commands = raw.commands.map((item, index): CompiledCommand => {
    const source = `raf-constants.json#/commands/${index}`;
    const entry = object(item, source);
    if (!Array.isArray(entry.path) || !entry.path.length || entry.path.some(p => typeof p !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(p))) throw new Error(`${source}/path: invalid command path`);
    const path = [...entry.path] as string[];
    const handlerName = path.join(' ');
    if (paths.has(handlerName)) throw new Error(`${source}/path: duplicate command ${handlerName}`);
    paths.add(handlerName);
    if (handlerName !== 'help' && !handlerNames.includes(handlerName)) throw new Error(`${source}: missing handler ${handlerName}`);
    if (entry.description !== undefined && typeof entry.description !== 'string') throw new Error(`${source}/description: expected string`);
    const valueSources: Record<string, CatalogValue[]> = Object.create(null);
    for (const [name, reference] of Object.entries(object(entry.valueSources ?? {}, `${source}/valueSources`))) valueSources[name] = resolve(reference, `${source}/valueSources/${name}`);
    if (entry.parameters !== undefined && !Array.isArray(entry.parameters)) throw new Error(`${source}/parameters: expected array`);
    const names = new Set<string>();
    const options = new Set<string>();
    const parameters = ((entry.parameters ?? []) as unknown[]).map((value, i): CompiledParameter => {
      const where = `${source}/parameters/${i}`;
      const p = object(value, where);
      if (typeof p.name !== 'string' || !p.name || typeof p.option !== 'string' || !/^--[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(p.option) || p.option === '--help') throw new Error(`${where}: invalid parameter name or option`);
      if (names.has(p.name) || options.has(p.option)) throw new Error(`${where}: duplicate parameter ${p.name} or option ${p.option}`);
      names.add(p.name); options.add(p.option);
      for (const key of ['required', 'multiple']) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error(`${where}/${key}: expected boolean`);
      if (p.description !== undefined && typeof p.description !== 'string') throw new Error(`${where}/description: expected string`);
      if (p.type !== undefined && p.type !== 'string' && p.type !== 'boolean') throw new Error(`${where}/type (${p.name}): unsupported parameter type`);
      for (const key of ['values', 'enum', 'valueSource']) if (p[key] !== undefined) throw new Error(`${where}/${key} (${p.name}): enum values must use command valueSources`);
      const allowed = valueSources[p.name];
      if (p.type === 'boolean' && (p.multiple === true || allowed !== undefined)) throw new Error(`${where} (${p.name}): boolean flags cannot be multiple or use valueSources`);
      if (p.type === 'boolean' && p.default !== undefined && typeof p.default !== 'boolean') throw new Error(`${where}/default: expected boolean`);
      if (p.type !== 'boolean' && p.default !== undefined) {
        const defaults = p.multiple ? p.default : [p.default];
        if (!Array.isArray(defaults) || defaults.some(v => typeof v !== 'string' || (allowed && !allowed.some(a => a.id === v)))) throw new Error(`${where}/default: invalid default`);
      }
      return { ...p, values: allowed } as unknown as CompiledParameter;
    });
    return { path, handlerName, description: entry.description as string | undefined, parameters, valueSources, metadata: { ...entry } };
  });
  return { commands, reportStatuses: values(raw.reportStatuses ?? [], 'raf-constants.json#/reportStatuses') };
}
