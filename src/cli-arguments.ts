import type { CompiledCommand } from './catalog.ts';

export interface ArgumentFailure {
  code: string;
  message: string;
  details: Record<string, unknown>;
  remediation: readonly string[];
}

export type ParsedArguments = { params: Record<string, unknown> } | { error: ArgumentFailure };

export function parseCommandArguments(rest: readonly string[], command: Pick<CompiledCommand, 'path' | 'handlerName' | 'parameters'>): ParsedArguments {
  const context = { command: command.path.join(' ') };
  const fail = (code: string, message: string, details: Record<string, unknown>, remediation: readonly string[] = []): ParsedArguments => ({ error: { code, message, details, remediation } });
  const params: Record<string, unknown> = Object.create(null);
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const separator = token.indexOf('=');
    const option = separator < 0 ? token : token.slice(0, separator);
    const parameter = command.parameters.find(p => p.option === option);
    if (!parameter) return fail('UNKNOWN_ARGUMENT', 'Невідомий аргумент або зайве позиційне значення.', { ...context, parameter: /^--[a-zA-Z0-9-]+$/.test(option) ? option : '[redacted]' });
    if (seen.has(parameter.name) && (!parameter.multiple || command.handlerName === 'test run' && parameter.name === 'files')) {
      const syntax = command.parameters.map(p => `${p.option} <${p.name}>${p.multiple ? ` [<${p.name}> ...] або ${p.option} <${p.name}> ${p.option} <${p.name}>` : ' (лише раз)'}`).join('; ');
      return fail('DUPLICATE_ARGUMENT', `${parameter.option}: параметр можна задати лише раз. Допустимий синтаксис: ${syntax}`, { ...context, parameter: parameter.option }, [`Використайте ${parameter.option} лише раз. ${syntax}`]);
    }
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
    else if (!seen.has(parameter.name) && parameter.type === 'boolean') params[parameter.name] = false;
    if (command.handlerName === 'agent run' && parameter.name === 'type' && [params[parameter.name]].flat().some(value => parameter.values?.find(v => v.id === value)?.launchableByRaf === false)) return fail('TYPE_NOT_LAUNCHABLE', 'Цей тип агента обліковується, але не запускається raf.', { ...context, parameter: parameter.option, received: params[parameter.name] });
    if (parameter.required && (params[parameter.name] === undefined || (Array.isArray(params[parameter.name]) && !(params[parameter.name] as unknown[]).length))) return fail('MISSING_REQUIRED', 'Не задано обов’язковий параметр.', { ...context, parameter: parameter.option });
  }
  return { params };
}

export function validateCommandConstraints(params: Record<string, unknown>, command: Pick<CompiledCommand, 'path' | 'handlerName' | 'parameters'>): ArgumentFailure | undefined {
  const context = { command: command.path.join(' ') };
  const fail = (code: string, message: string, details: Record<string, unknown>, remediation: readonly string[] = []): ArgumentFailure => ({ code, message, details, remediation });
  if (command.handlerName === 'agent run' && typeof params.phase === 'string') {
    const types = command.parameters.find(parameter => parameter.name === 'type')?.values;
    const phases = command.parameters.find(parameter => parameter.name === 'phase')?.values;
    if (types && phases) {
      const expected = phases.filter(phase => types.some(type => type.id === phase.id) || phase.id === 'context-review' && params.type === 'spec').map(phase => phase.id);
      if (!expected.includes(params.phase)) return fail('INVALID_VALUE', 'Фаза не підтримує запуск цього типу агента.', { ...context, parameter: '--phase', received: params.phase, expected }, ['Використайте фазу запуску агента; початковий unit-red виконуйте командою raf test run.']);
    }
  }
  if (command.handlerName === 'agent close' && params.force === true && (typeof params.reason !== 'string' || !params.reason.trim())) return fail('INVALID_VALUE', 'Примусове закриття потребує непорожню --reason.', { ...context, example: 'raf agent close --id worker --force --reason "Власник скасував запуск"' });
  if (command.handlerName === 'reminder add' || command.handlerName === 'reminder update') {
    const present = ['event', 'event-id', 'event-action'].filter(name => params[name] !== undefined);
    if (present.length && present.length !== 3) return fail('INVALID_VALUE', 'Задайте --event, --event-id та --event-action разом.', { ...context, received: present });
  }
  return undefined;
}
