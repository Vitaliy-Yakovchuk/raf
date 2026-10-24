export type QuotaCreditsSettings = {
  source: 'statusline' | 'credits_panel';
  pattern: string;
};

export type AbsoluteQuotaCredits = {
  label: string;
  usedFraction: null;
  remaining: number | null;
  unit: 'credits';
  source: QuotaCreditsSettings['source'];
  observedAt: string;
  reliable: boolean;
  issue?: string;
};

export type QuotaCreditsObservation = {
  text: string;
  observedAt: string;
  truncated: boolean;
  reliable: boolean;
};

export function parseQuotaCredits(settings: QuotaCreditsSettings | null, input: QuotaCreditsObservation): AbsoluteQuotaCredits | null {
  if (!settings) return null;
  validateQuotaCredits(settings);
  const text = input.text.replaceAll('\u00a0', ' ').replace(/[\u2500-\u257f]/gu, ' ');
  const matches = [...text.matchAll(new RegExp(settings.pattern, 'dgmu'))];
  if (!matches.length && !/AI Credits\s*:/iu.test(text)) return null;
  const result: AbsoluteQuotaCredits = { label: matches.length === 1 ? matches[0][0].trim() : 'AI Credits', usedFraction: null, remaining: null, unit: 'credits', source: settings.source, observedAt: input.observedAt, reliable: false };
  let issue: string | undefined;
  if (input.truncated) issue = 'Truncated credits screen';
  else if (!input.reliable || !Number.isFinite(Date.parse(input.observedAt))) issue = 'Untrusted credits observation';
  else if (matches.length !== 1) issue = matches.length ? 'Ambiguous credits balance' : 'Invalid credits balance';
  else {
    const match = matches[0];
    const token = match[1];
    const bounds = match.indices?.[1];
    const before = bounds ? text.slice(0, bounds[0]).at(-1) ?? '' : '';
    const after = bounds ? text.slice(bounds[1]) : '';
    const numeric = typeof token === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(token);
    const value = numeric ? Number(token.replaceAll(',', '')) : NaN;
    if (!Number.isFinite(value) || value < 0 || /[\p{L}\p{N}.,+\-−]/u.test(before) || /^[\p{L}\p{N}.,%+\-−]/u.test(after) || /^\s*%/u.test(after)) issue = 'Invalid or incomplete credits numeric token';
    else { result.remaining = value; result.reliable = true; }
  }
  if (issue) result.issue = issue;
  return result;
}

export function validateQuotaCredits(value: unknown): asserts value is QuotaCreditsSettings {
  const invalid = () => { throw new Error('Invalid quota.credits: expected source and a pattern with exactly one numeric capture'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const settings = value as Record<string, unknown>;
  if (!['statusline', 'credits_panel'].includes(settings.source as string) || typeof settings.pattern !== 'string' || !settings.pattern.trim()) return invalid();
  let captures = 0;
  let inClass = false;
  for (let index = 0; index < settings.pattern.length; index++) {
    const char = settings.pattern[index];
    if (char === '\\') { index++; continue; }
    if (char === '[') inClass = true;
    if (char === ']') inClass = false;
    if (char === '(' && !inClass && (settings.pattern[index + 1] !== '?' || settings.pattern[index + 2] === '<' && !['=', '!'].includes(settings.pattern[index + 3]))) captures++;
  }
  try { new RegExp(settings.pattern, 'u'); } catch { return invalid(); }
  if (captures !== 1) return invalid();
}
