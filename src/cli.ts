import { failureContext, redactDiagnostic } from './cli-contract.ts';
import type { CompiledCatalog } from './catalog.ts';

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
    return ok(JSON.stringify({ commands: matches.map(c => ({ ...c, parameters: c.parameters.map(p => ({ ...p, required: p.required ?? false, multiple: p.multiple ?? false, requirement: p.required ? 'required' : 'optional' })) })), reportStatuses: catalog.reportStatuses }, null, 2));
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
