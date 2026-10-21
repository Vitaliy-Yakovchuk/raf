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
