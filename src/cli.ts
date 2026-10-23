import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import type { CompiledCatalog } from './catalog.ts';

export interface CommandFailureContext {
  code: string;
  message: string;
  stage: string;
  source: string;
  sourceCode: string | number | null;
  reason: string | null;
  received: unknown;
  expected: unknown;
  found: unknown;
  completed: readonly string[];
  pending: readonly string[];
  retrySafe: boolean | null;
  remediation: readonly string[];
  secrets?: readonly string[];
}

const failures = new WeakMap<Error, CommandFailureContext>();

export function commandFailure(context: CommandFailureContext): Error {
  const error = new Error(context.message);
  failures.set(error, structuredClone(context));
  return error;
}

export function failureContext(error: unknown): CommandFailureContext | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}

export function redactDiagnostic(value: unknown, secrets: readonly string[] = []): unknown {
  const scrub = (text: string): string => secrets.filter(Boolean).sort((a, b) => b.length - a.length).reduce((result, secret) => result.split(secret).join('[redacted]'), text)
    .replace(/((?:password|passwd|secret|token|authorization|api[_-]?key|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return scrub(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [scrub(key), /password|passwd|secret|token|authorization|api[_-]?key|credential/i.test(key) ? '[redacted]' : visit(entry)]));
    return item;
  };
  return visit(value);
}

export type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function execute(
  argv: readonly string[],
  catalog: CompiledCatalog,
  handlers: Record<string, Handler>,
): Promise<ExecutionResult> {
  const ok = (value: unknown): ExecutionResult => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value ?? null), stderr: '' });
  const fail = (code: string, message: string, details: Record<string, unknown> = {}, remediation: readonly string[] = [], secrets: readonly string[] = []): ExecutionResult => ({
    exitCode: 1, stdout: '', stderr: JSON.stringify(redactDiagnostic({ code, message, details: {
      command: null, stage: 'arguments', source: 'cli', sourceCode: null,
      reason: message, received: null, expected: null, found: null,
      completed: [], pending: [], retrySafe: true, ...details,
    }, remediation: [...(remediation.length ? remediation : [typeof details.example === 'string' ? `Виправте виклик: ${details.example}` : details.stage === 'handler' ? 'Перевірте фактичний стан операції перед повторним викликом.' : 'Перевірте параметри та доступність команди за довідкою.']), `raf help${typeof details.command === 'string' && details.command ? ` ${details.command}` : ''}`] }, secrets)),
  });
  const helpRequested = argv[0] === 'help' || argv.includes('--help') || argv.length === 0;
  const tokens = argv[0] === 'help'
    ? (argv.length === 2 && argv[1] === '--help' ? ['help'] : argv.slice(1).filter(t => t !== '--help'))
    : argv.filter(t => t !== '--help');
  if (helpRequested) {
    const matches = catalog.commands.filter(c => tokens.every((t, i) => c.path[i] === t));
    if (!matches.length) return fail('UNKNOWN_COMMAND', 'Невідомий шлях довідки.', { command: tokens.join(' '), received: tokens, found: catalog.commands.map(c => c.path.join(' ')), expected: catalog.commands.map(c => c.path.join(' ')) });
    return ok(JSON.stringify({ program: 'raf', commands: matches.map(c => ({ ...c, parameters: c.parameters.map(p => ({ ...p, required: p.required ?? false, multiple: p.multiple ?? false, requirement: p.required ? 'required' : 'optional' })) })), reportStatuses: catalog.reportStatuses }, null, 2));
  }
  const command = [...catalog.commands].sort((a, b) => b.path.length - a.path.length).find(c => c.path.every((t, i) => argv[i] === t));
  if (!command) return fail('UNKNOWN_COMMAND', 'Невідома команда.', { command: tokens.join(' '), received: tokens, found: catalog.commands.map(c => c.path.join(' ')), expected: catalog.commands.map(c => c.path.join(' ')) });
  const context = { command: command.path.join(' ') };
  const params: Record<string, unknown> = Object.create(null);
  const seen = new Set<string>();
  const rest = argv.slice(command.path.length);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const separator = token.indexOf('=');
    const option = separator < 0 ? token : token.slice(0, separator);
    const parameter = command.parameters.find(p => p.option === option);
    if (!parameter) return fail('UNKNOWN_ARGUMENT', 'Невідомий аргумент або зайве позиційне значення.', { ...context, parameter: /^--[a-zA-Z0-9-]+$/.test(option) ? option : '[redacted]' });
    if (seen.has(parameter.name) && !parameter.multiple) return fail('DUPLICATE_ARGUMENT', 'Параметр можна задати лише раз.', { ...context, parameter: parameter.option });
    if (parameter.type === 'boolean') {
      if (separator >= 0 || (i + 1 < rest.length && !rest[i + 1].startsWith('--'))) return fail('INVALID_VALUE', 'Boolean прапорець не приймає значення.', { ...context, parameter: parameter.option });
      params[parameter.name] = true;
      seen.add(parameter.name);
      continue;
    }
    const incoming: string[] = [];
    if (separator >= 0) incoming.push(token.slice(separator + 1));
    else {
      while (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
        incoming.push(rest[++i]);
        if (!parameter.multiple) break;
      }
    }
    if (!incoming.length || incoming.some(v => !v.length)) return fail('MISSING_VALUE', 'Потрібне значення параметра.', { ...context, parameter: parameter.option });
    for (const value of incoming) {
      if (parameter.values && !parameter.values.some(v => v.id === value)) {
        const applicable = parameter.values.filter(v => !(command.handlerName === 'agent run' && parameter.name === 'type' && v.launchableByRaf === false));
        const replacement = applicable[0]?.id;
        const quoted = replacement === undefined ? undefined : /^[a-zA-Z0-9_-]+$/.test(replacement) ? replacement : "'" + replacement.replaceAll("'", "'\"'\"'") + "'";
        return fail('INVALID_VALUE', 'Значення параметра не підтримується.', { ...context, parameter: parameter.option, received: value, expected: parameter.values.map(v => v.id), ...(quoted === undefined ? {} : { example: `raf ${context.command} ${parameter.option} ${quoted}` }) });
      }
      if (command.handlerName === 'agent run' && parameter.name === 'type' && parameter.values?.find(v => v.id === value)?.launchableByRaf === false) return fail('TYPE_NOT_LAUNCHABLE', 'Цей тип агента обліковується, але не запускається raf.', { ...context, parameter: parameter.option, received: value });
    }
    params[parameter.name] = parameter.multiple ? [...(params[parameter.name] as string[] ?? []), ...incoming] : incoming[0];
    seen.add(parameter.name);
  }
  for (const parameter of command.parameters) {
    if (!seen.has(parameter.name) && parameter.default !== undefined) params[parameter.name] = structuredClone(parameter.default);
    if (command.handlerName === 'agent run' && parameter.name === 'type' && [params[parameter.name]].flat().some(value => parameter.values?.find(v => v.id === value)?.launchableByRaf === false)) return fail('TYPE_NOT_LAUNCHABLE', 'Цей тип агента обліковується, але не запускається raf.', { ...context, parameter: parameter.option, received: params[parameter.name] });
    if (parameter.required && (params[parameter.name] === undefined || (Array.isArray(params[parameter.name]) && !(params[parameter.name] as unknown[]).length))) return fail('MISSING_REQUIRED', 'Не задано обов’язковий параметр.', { ...context, parameter: parameter.option });
  }
  if (command.handlerName === 'agent close') {
    if ((params.force === true && (typeof params.reason !== 'string' || !params.reason.trim())) || (params.force !== true && params.reason !== undefined)) return fail('INVALID_VALUE', 'Примусове закриття потребує --force та непорожню --reason разом.', { ...context, example: 'raf agent close --id worker --force --reason "Власник скасував запуск"' });
    if (typeof params.reason === 'string') params.reason = params.reason.trim();
  }
  const handler = handlers[command.handlerName];
  if (typeof handler !== 'function') return fail('HANDLER_UNAVAILABLE', 'Обробник команди недоступний.', { ...context, stage: 'dispatch' });
  try {
    return ok(await handler({ ...params }));
  } catch (error) {
    const supplied = failureContext(error);
    if (supplied) {
      const { code, message, remediation, secrets, ...facts } = supplied;
      return fail(code, message, { ...facts, ...context }, remediation, secrets);
    }
    if (error instanceof UnavailableCommandError) return fail('COMMAND_UNAVAILABLE', 'Команда ще не реалізована в цьому інкременті raf.', { ...context, stage: 'dispatch', sideEffects: [] });
    return fail('HANDLER_FAILED', 'Обробник завершився помилкою; причина невідома.', { ...context, stage: 'handler', source: null, reason: null, completed: null, pending: null, retrySafe: null });
  }
}

export class UnavailableCommandError extends Error {}

const diagnostic = (code: string, error: unknown): ExecutionResult => ({ exitCode: 1, stdout: '', stderr: JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) }) });

export async function runPublicCli(entryUrl: string, argv: readonly string[]): Promise<ExecutionResult> {
  const codeRoot = fileURLToPath(new URL('../', entryUrl)).replace(/\/$/, '');
  const artifactPath = join(codeRoot, 'dist/catalog.json');
  const bootstrapIdentity = statSync(codeRoot, { bigint: true });
  const verifyBootstrap = () => {
    const current = statSync(codeRoot, { bigint: true });
    if (current.dev !== bootstrapIdentity.dev || current.ino !== bootstrapIdentity.ino || current.ctimeNs !== bootstrapIdentity.ctimeNs) throw new Error('Bootstrap directory changed before reader pinning');
  };
  let catalog: CompiledCatalog;
  try {
    catalog = JSON.parse(readFileSync(artifactPath, 'utf8'));
    if (!Array.isArray(catalog?.commands) || !Array.isArray(catalog?.reportStatuses)) throw new Error('Compiled CLI catalog unavailable; run npm run build');
    let runtime = false;
    const result = await execute(argv, catalog, new Proxy(Object.create(null), { get: () => async () => { runtime = true; } }));
    if (!runtime) return result;
  } catch (error) { return diagnostic('CATALOG_UNAVAILABLE', error); }

  let lease: { generationRoot: string; release(): Promise<void> } | undefined;
  let result: ExecutionResult | undefined;
  try {
    if (statSync(fileURLToPath(entryUrl)).nlink !== 1) return diagnostic('STATE_CONTEXT_REFUSED', new Error('Hardlinked raf entry has ambiguous code provenance'));
    let owner: any;
    try { owner = JSON.parse(readFileSync(fileURLToPath(new URL('../../ownership.json', entryUrl)), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const orchestratorRoot = process.env.RAF_ORCHESTRATOR_ROOT ?? owner?.orchestratorRoot ?? fileURLToPath(new URL('../../', entryUrl));
    let configuration: any;
    try { configuration = JSON.parse(readFileSync(join(orchestratorRoot, 'conf/projects.json'), 'utf8')); }
    catch (error) { return diagnostic('CONFIGURATION_INVALID', error); }
    const main = configuration.projects?.raf?.branchPaths?.main;
    if (typeof main !== 'string' || !main.trim()) return diagnostic('STATE_CONTEXT_REFUSED', new Error('Registered raf main route required'));
    if (resolve(orchestratorRoot, main) === codeRoot || owner?.root === codeRoot) {
      if (resolve(orchestratorRoot, main) === codeRoot && execFileSync('git', ['-C', codeRoot, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== 'main') throw new Error('Registered raf main Git branch required');
      verifyBootstrap();
      const { acquireHotfixReader } = await import(pathToFileURL(join(codeRoot, 'src/hotfix-activation.ts')).href);
      verifyBootstrap();
      lease = await acquireHotfixReader({ orchestratorRoot, qaHome: homedir(), environment: {}, sandboxExecutable: 'codex' }, 'cli');
    }
    const root = lease?.generationRoot ?? codeRoot;
    const { runProductionCli } = await import(pathToFileURL(join(root, 'src/production-entry.ts')).href);
    result = await runProductionCli(argv, { orchestratorRoot, homeDirectory: homedir(), artifactPath: join(root, 'dist/catalog.json') });
  } catch (error) { result = diagnostic('PRODUCTION_ENTRY_FAILED', error); }
  finally {
    try { await lease?.release(); }
    catch (error) { if (!result || result.exitCode === 0) result = diagnostic('PRODUCTION_ENTRY_FAILED', error); }
  }
  return result!;
}
