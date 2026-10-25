import { readFileSync } from 'node:fs';

export function validateCatalogSchema(value: unknown): void {
  const root = JSON.parse(readFileSync(new URL('./catalog.schema.json', import.meta.url), 'utf8'));
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
  const validate = (node: any, data: any, path: string): void => {
    if (node.$ref) {
      let target = root;
      for (const key of node.$ref.slice(2).split('/')) target = target[key.replaceAll('~1', '/').replaceAll('~0', '~')];
      validate(target, data, path);
    }
    const reject = (reason: string): never => { throw new Error(`raf-constants.json#${path}: ${reason}`); };
    const matches = (schema: any) => { try { validate(schema, data, path); return true; } catch { return false; } };
    if (node.type) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      const valid = types.some((type: string) => type === 'null' ? data === null : type === 'array' ? Array.isArray(data) : type === 'object' ? data !== null && typeof data === 'object' && !Array.isArray(data) : type === 'integer' ? Number.isInteger(data) : typeof data === type);
      if (!valid) reject(`expected ${types.join(' or ')}`);
    }
    if (Object.hasOwn(node, 'const') && !equal(data, node.const)) reject('unexpected constant');
    if (node.enum && !node.enum.some((entry: unknown) => equal(data, entry))) reject('unsupported value');
    if (node.not && matches(node.not)) reject('forbidden value');
    if (node.anyOf && !node.anyOf.some(matches)) reject('no matching schema');
    for (const schema of node.allOf ?? []) validate(schema, data, path);
    if (node.if) {
      const branch = matches(node.if) ? node.then : node.else;
      if (branch) validate(branch, data, path);
    }
    if (typeof data === 'string') {
      if (node.minLength !== undefined && [...data].length < node.minLength) reject('string is too short');
      if (node.pattern && !new RegExp(node.pattern, 'u').test(data)) reject(`string does not match pattern: ${data}`);
    }
    if (typeof data === 'number' && node.minimum !== undefined && data < node.minimum) reject(`expected minimum ${node.minimum}`);
    if (Array.isArray(data)) {
      if (node.minItems !== undefined && data.length < node.minItems) reject('array is empty');
      if (node.uniqueItems && new Set(data.map((entry: unknown) => JSON.stringify(entry))).size !== data.length) reject('duplicate array entry');
      if (node.items) data.forEach((entry, index) => validate(node.items, entry, `${path}/${index}`));
    } else if (data && typeof data === 'object') {
      if (node.minProperties !== undefined && Object.keys(data).length < node.minProperties) reject('object is empty');
      for (const key of node.required ?? []) if (!Object.hasOwn(data, key)) throw new Error(`raf-constants.json#${path}/${pointer(key)}: required property missing`);
      for (const [key, entry] of Object.entries(data)) {
        if (node.propertyNames) validate(node.propertyNames, key, `${path}/${pointer(key)}`);
        if (Object.hasOwn(node.properties ?? {}, key)) validate(node.properties[key], entry, `${path}/${pointer(key)}`);
        else if (node.additionalProperties === false) throw new Error(`raf-constants.json#${path}/${pointer(key)}: unknown property`);
        else if (typeof node.additionalProperties === 'object') validate(node.additionalProperties, entry, `${path}/${pointer(key)}`);
      }
    }
  };
  validate(root, value, '');
}
