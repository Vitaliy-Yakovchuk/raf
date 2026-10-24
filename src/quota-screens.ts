import { isAbsolute } from 'node:path';
import type { ProtocolSettings, RunnerId } from './runner-protocols.ts';
import type { QuotaView } from './quota-collection.ts';
import { parseQuotaCredits, validateQuotaCredits, type AbsoluteQuotaCredits, type QuotaCreditsSettings } from './quota-credits.ts';

export type QuotaScreenParser = 'codex_status' | 'claude_usage' | 'grok_usage' | 'agy_usage';
export type QuotaWindowName = 'session' | 'weekly' | 'five_hour';
export type QuotaProbeSettings = {
  args: string[];
  env: Record<string, string>;
  submitWhen: string;
  panel: string[];
  loading: string[];
  dismissKeys: string[];
  credits?: QuotaCreditsSettings;
};
export type QuotaProtocol = Omit<ProtocolSettings, 'quotaParser' | 'native'> & { quotaParser: QuotaScreenParser | 'unknown'; quota: QuotaProbeSettings };
export type ScreenQuotaWindow = {
  name: QuotaWindowName;
  label: string;
  state: 'measured' | 'disabled' | 'unknown';
  used: number | null;
  remaining: number | null;
  resetAt: string | null;
  resetUncertaintyMs: number | null;
  explanation: string | null;
};
export type ScreenQuotaPool = { id: string; label: string; windows: ScreenQuotaWindow[] };
export type ScreenQuotaSnapshot = {
  runner: RunnerId;
  observedAt: string;
  version: string;
  pools: ScreenQuotaPool[];
  credits: { usedFraction: number | null; label: string } | AbsoluteQuotaCredits | null;
  reliable: boolean;
  completeness: 'complete' | 'partial' | 'unknown';
  issues: string[];
};
export type QuotaProbeObservation = { text: string; typed: string | null; typedAtMs: number | null; submitted: boolean; reissuedAtMs: number | null; elapsedMs: number; trustWorkspace?: boolean; trustAnsweredAtMs?: number | null };
export type QuotaProbeAction =
  | { kind: 'wait' }
  | { kind: 'trust'; keys: string[] }
  | { kind: 'type'; text: string }
  | { kind: 'submit' }
  | { kind: 'reissue'; text: string }
  | { kind: 'parse' }
  | { kind: 'stop'; reason: 'auth_required' | 'workspace_trust_required' | 'permission_required' | 'unknown_screen' | 'command_mismatch' | 'exited' };
export type ScreenQuotaView = Omit<QuotaView, 'snapshot'> & { snapshot: ScreenQuotaSnapshot | null };
export type PoolQuotaStatus = 'available' | 'exhausted' | 'unknown';
export type RoutingQuotaEntry = { runner: string; pool: string; status: PoolQuotaStatus };

const runners: readonly RunnerId[] = ['codex', 'grok', 'agy', 'claude'];
const parsers: readonly (QuotaScreenParser | 'unknown')[] = ['codex_status', 'claude_usage', 'grok_usage', 'agy_usage', 'unknown'];
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isTexts = (value: unknown, nonEmpty: boolean): value is string[] => Array.isArray(value) && (!nonEmpty || value.length > 0) && value.every(isText);
const isPattern = (value: unknown): value is string => { if (!isText(value)) return false; try { new RegExp(value, 'u'); return true; } catch { return false; } };
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const normalize = (line: string) => line.replaceAll('\u00a0', ' ').replace(/[\u2500-\u257f]/gu, ' ').trim();
const lines = (text: string) => text.split('\n').map(normalize);
const fraction = (percent: number) => Number((percent / 100).toFixed(6));
const complement = (percent: number) => Number(((100 - percent) / 100).toFixed(6));

export function validateQuotaProtocol(row: unknown): QuotaProtocol {
  const runner = isObject(row) && isText(row.runner) ? row.runner : 'unknown';
  const invalid = (field: string): never => { throw new Error(`Runner ${runner} quota protocol has invalid ${field} in conf/raf.json#runnerProtocols`); };
  if (!isObject(row)) return invalid('row');
  if (!runners.includes(row.runner)) invalid('runner');
  if (!isText(row.executable) || row.executable.includes('/') && !isAbsolute(row.executable)) invalid('executable');
  if (!isText(row.version)) invalid('version');
  if (!isText(row.quotaCommand) || !row.quotaCommand.startsWith('/')) invalid('quotaCommand');
  if (!parsers.includes(row.quotaParser)) invalid('quotaParser');
  const quota = row.quota;
  if (!isObject(quota)) return invalid('quota');
  if (!isTexts(quota.args, false)) invalid('quota.args');
  if (!isObject(quota.env) || !Object.entries(quota.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string')) invalid('quota.env');
  if (!isPattern(quota.submitWhen)) invalid('quota.submitWhen');
  if (!isTexts(quota.panel, true)) invalid('quota.panel');
  if (!isTexts(quota.loading, false)) invalid('quota.loading');
  if (!isTexts(quota.dismissKeys, false)) invalid('quota.dismissKeys');
  if (Object.hasOwn(quota, 'credits')) {
    if (row.runner !== 'agy') invalid('quota.credits runner');
    validateQuotaCredits(quota.credits);
  }
  if (!isObject(row.modelPools) || !Object.values(row.modelPools).every(isText)) invalid('modelPools');
  if (typeof row.quotaReliable !== 'boolean') invalid('quotaReliable');
  if (!isObject(row.markers) || !isTexts(row.markers.ready, true) || !Object.values(row.markers).every(value => isTexts(value, false))) invalid('markers');
  if (!isObject(row.timeouts) || !['startupMs', 'transitionMs', 'overallMs', 'pollMs'].every(key => positive(row.timeouts[key]))) invalid('timeouts');
  if (!isObject(row.collection) || !['intervalMs', 'failureBackoffMs', 'staleAfterMs'].every(key => positive(row.collection[key]))) invalid('collection');
  if (!Array.isArray(row.navigation ?? [])) invalid('navigation');
  const { native: _native, ...protocol } = structuredClone(row);
  return { ...protocol, navigation: protocol.navigation ?? [] } as QuotaProtocol;
}

export function quotaProbeInvocation(settings: QuotaProtocol, probeDirectory: string): { executable: string; args: string[]; env: Record<string, string> } {
  if (!isAbsolute(probeDirectory)) throw new Error('Quota probe directory must be absolute');
  return { executable: settings.executable, args: settings.quota.args.map(value => value.replaceAll('{probeDirectory}', probeDirectory)), env: { ...settings.quota.env } };
}

function stopState(settings: QuotaProtocol, text: string): 'auth_required' | 'workspace_trust_required' | 'permission_required' | null {
  for (const state of ['workspace_trust_required', 'auth_required', 'permission_required'] as const) {
    if (settings.markers[state]?.some(marker => text.includes(marker))) return state;
  }
  return null;
}

function commandShown(settings: QuotaProtocol, text: string): boolean {
  const pattern = new RegExp(settings.quota.submitWhen, 'u');
  return lines(text).some(line => pattern.test(line));
}

function screenAfterAnsweredTrust(settings: QuotaProtocol, text: string, answeredAt: number | null): string {
  if (answeredAt === null) return text;
  const end = Math.max(-1, ...(settings.markers.workspace_trust_required ?? []).map(marker => { const index = text.lastIndexOf(marker); return index < 0 ? -1 : index + marker.length; }));
  if (end < 0) return text;
  const after = text.slice(end);
  return settings.markers.ready?.some(marker => after.includes(marker)) ? after : text;
}

export function nextQuotaProbeAction(settings: QuotaProtocol, observation: QuotaProbeObservation): QuotaProbeAction {
  const text = screenAfterAnsweredTrust(settings, observation.text.replaceAll('\u00a0', ' '), observation.trustAnsweredAtMs ?? null);
  const stop = stopState(settings, text);
  if (stop === 'workspace_trust_required' && observation.trustWorkspace) {
    const answeredAt = observation.trustAnsweredAtMs ?? null;
    if (answeredAt !== null) return observation.elapsedMs - answeredAt < settings.timeouts.transitionMs ? { kind: 'wait' } : { kind: 'stop', reason: stop };
    const trust = settings.navigation.find(entry => entry.state === 'workspace_trust_required' && entry.keys.length > 0 && text.includes(entry.match.replaceAll('\u00a0', ' ')));
    return trust ? { kind: 'trust', keys: [...trust.keys] } : { kind: 'stop', reason: stop };
  }
  if (stop) return { kind: 'stop', reason: stop };
  const lastInput = Math.max(observation.typedAtMs ?? 0, observation.reissuedAtMs ?? 0);
  const sinceInput = observation.elapsedMs - lastInput;
  if (observation.typed === null) {
    if (!text.trim()) return { kind: 'wait' };
    if (settings.markers.ready?.some(marker => text.includes(marker))) return { kind: 'type', text: settings.quotaCommand! };
    return observation.elapsedMs >= settings.timeouts.startupMs ? { kind: 'stop', reason: 'unknown_screen' } : { kind: 'wait' };
  }
  if (!observation.submitted) {
    if (commandShown(settings, text)) return { kind: 'submit' };
    return sinceInput >= settings.timeouts.transitionMs ? { kind: 'stop', reason: 'command_mismatch' } : { kind: 'wait' };
  }
  const block = latestQuotaBlock(settings, observation.text);
  if (block === null) return { kind: 'wait' };
  if (settings.quota.loading.some(marker => block.includes(marker))) {
    return sinceInput >= settings.timeouts.transitionMs ? { kind: 'reissue', text: settings.quotaCommand! } : { kind: 'wait' };
  }
  if (settings.quota.panel.every(marker => block.includes(marker))) return { kind: 'parse' };
  return { kind: 'wait' };
}

export function latestQuotaBlock(settings: QuotaProtocol, text: string): string | null {
  const pattern = new RegExp(settings.quota.submitWhen, 'u');
  const command = settings.quotaCommand ?? '';
  const raw = text.split('\n');
  let echo = -1;
  raw.forEach((line, index) => {
    const value = normalize(line);
    const bare = value.replace(/^\p{L}+:\s*/u, '').replace(/^[^\p{L}\p{N}/]+/u, '');
    if (pattern.test(value) || command && (bare === command || bare.startsWith(`${command} `) && !bare.slice(command.length).trim().startsWith('/'))) echo = index;
  });
  const response = raw.slice(echo + 1);
  const panels = response.flatMap((line, index) => line.includes(settings.quota.panel[0]) ? [index] : []);
  const block = response.slice(panels.length > 1 ? panels.at(-1) : 0).join('\n').replaceAll('\u00a0', ' ');
  return block.trim() ? block : null;
}

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIndex = (name: string) => {
  const key = name.toLowerCase().replace(/\.$/, '');
  const index = months.indexOf(key.slice(0, 3));
  if (index < 0) return -1;
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][index];
  return key.length === 3 || key === full || key === 'sept' ? index : -1;
};

export function parseQuotaReset(parser: QuotaScreenParser, text: string, observedAt: string, zone: string | undefined): { resetAt: string; resetUncertaintyMs: number } | null {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return null;
  let value = normalize(text).replace(/^(?:resets?|refreshes)\s*:?\s*/i, '').trim();
  const relative = value.match(/^(?:in\s+)?(?:(\d+)\s*d\s*)?(?:(\d+)\s*h\s*)?(?:(\d+)\s*m(?:in)?)?\s*$/i);
  if (relative && relative.slice(1).some(Boolean)) {
    const [days, hours, minutes] = relative.slice(1).map(part => Number(part ?? 0));
    const uncertainty = relative[3] !== undefined ? 60000 : relative[2] !== undefined ? 3600000 : 86400000;
    return { resetAt: new Date(observed + ((days * 24 + hours) * 60 + minutes) * 60000).toISOString(), resetUncertaintyMs: uncertainty };
  }
  const label = value.match(/\(([^)]*)\)\s*$/);
  if (label) {
    if (label[1].trim().toUpperCase() !== 'UTC') return null;
    value = value.slice(0, label.index).trim();
  } else if (zone !== 'UTC') return null;
  value = value.replace(/\s+on\s+/i, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let rest = value;
  let date: { month: number; day: number; year: number | null } | null = null;
  const year = rest.match(/\b(\d{4})\b/);
  if (year) rest = rest.replace(year[0], ' ');
  for (const [pattern, monthGroup, dayGroup] of [[/\b(\d{1,2})\s+([A-Za-z]{3,}\.?)(?=\s|$)/, 2, 1], [/\b([A-Za-z]{3,}\.?)\s+(\d{1,2})\b(?!\s*(?::|[ap]\.?m))/i, 1, 2]] as const) {
    const match = rest.match(pattern);
    if (!match) continue;
    const month = monthIndex(match[monthGroup]);
    if (month < 0) continue;
    date = { month, day: Number(match[dayGroup]), year: year ? Number(year[1]) : null };
    rest = rest.replace(match[0], ' ');
    break;
  }
  let time: { hour: number; minute: number; uncertainty: number } | null = null;
  const meridiem = rest.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?=\s|$)/i);
  const clock = rest.match(/\b(\d{1,2}):(\d{2})\b/);
  if (meridiem) {
    const hour = Number(meridiem[1]);
    if (hour < 1 || hour > 12) return null;
    time = { hour: hour % 12 + (meridiem[3].toLowerCase() === 'p' ? 12 : 0), minute: Number(meridiem[2] ?? 0), uncertainty: meridiem[2] === undefined ? 3600000 : 60000 };
    rest = rest.replace(meridiem[0], ' ');
  } else if (clock) {
    time = { hour: Number(clock[1]), minute: Number(clock[2]), uncertainty: 60000 };
    rest = rest.replace(clock[0], ' ');
  }
  if (rest.trim() || !date && !time || time && (time.hour > 23 || time.minute > 59)) return null;
  const at = (y: number, m: number, d: number) => {
    const result = Date.UTC(y, m, d, time?.hour ?? 0, time?.minute ?? 0);
    const check = new Date(result);
    return check.getUTCMonth() === m && check.getUTCDate() === d ? result : NaN;
  };
  const start = new Date(observed);
  let reset: number;
  if (date) {
    reset = at(date.year ?? start.getUTCFullYear(), date.month, date.day);
    if (date.year === null && reset < observed) reset = at(start.getUTCFullYear() + 1, date.month, date.day);
  } else {
    reset = at(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    if (reset < observed) reset += 86400000;
  }
  if (!Number.isFinite(reset)) return null;
  return { resetAt: new Date(reset).toISOString(), resetUncertaintyMs: time?.uncertainty ?? 86400000 };
}

function emptyWindow(name: QuotaWindowName, label: string): ScreenQuotaWindow {
  return { name, label, state: 'unknown', used: null, remaining: null, resetAt: null, resetUncertaintyMs: null, explanation: null };
}

export function parseQuotaScreen(settings: QuotaProtocol, input: { text: string; observedAt: string; version: string; truncated: boolean }): ScreenQuotaSnapshot {
  const snapshot: ScreenQuotaSnapshot = { runner: settings.runner, observedAt: input.observedAt, version: input.version, pools: [], credits: null, reliable: settings.quotaReliable, completeness: 'unknown', issues: [] };
  const supported = input.version === settings.version || input.version.trim().split(/\s+/).includes(settings.version);
  const block = latestQuotaBlock(settings, input.text) ?? '';
  if (settings.runner === 'agy') snapshot.credits = parseQuotaCredits(settings.quota.credits ?? null, { ...input, text: block, reliable: settings.quotaReliable && supported });
  if (input.version !== settings.version && !input.version.trim().split(/\s+/).includes(settings.version)) {
    snapshot.reliable = false;
    snapshot.issues.push(`Unsupported ${settings.runner} version ${JSON.stringify(input.version)}; expected ${settings.version}`);
    return snapshot;
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    snapshot.reliable = false;
    snapshot.issues.push('Invalid observation time');
    return snapshot;
  }
  const zone = settings.quota.env.TZ;
  const reset = (window: ScreenQuotaWindow, text: string) => {
    if (settings.quotaParser === 'unknown') return;
    const parsed = parseQuotaReset(settings.quotaParser, text, input.observedAt, zone);
    if (parsed) Object.assign(window, parsed);
    else snapshot.issues.push(`${window.label}: reset time ${JSON.stringify(normalize(text))} has unknown time zone or format`);
  };
  if (settings.quota.loading.some(marker => block.includes(marker))) snapshot.issues.push('Quota panel is still loading');
  else if (!settings.quota.panel.every(marker => block.includes(marker))) snapshot.issues.push('Quota panel markers are missing');
  else if (settings.quotaParser === 'codex_status') parseCodex(block, snapshot, reset);
  else if (settings.quotaParser === 'claude_usage') parseClaude(block, snapshot, reset);
  else if (settings.quotaParser === 'grok_usage') parseGrok(block, input.text, snapshot, reset);
  else if (settings.quotaParser === 'agy_usage') parseAgy(block, snapshot, reset);
  else {
    snapshot.reliable = false;
    snapshot.issues.push('Quota parser is not configured');
  }
  if (!settings.quotaReliable) {
    snapshot.reliable = false;
    snapshot.issues.push('Quota reliability is not live-verified');
  }
  if (input.truncated) {
    if (snapshot.completeness === 'complete') snapshot.completeness = 'partial';
    snapshot.issues.push('Truncated quota screen');
  }
  if (snapshot.completeness !== 'complete') snapshot.issues.push('Missing or unknown quota windows');
  return snapshot;
}

type ResetParser = (window: ScreenQuotaWindow, text: string) => void;

function parseCodex(block: string, snapshot: ScreenQuotaSnapshot, reset: ResetParser) {
  const windows: ScreenQuotaWindow[] = [];
  for (const line of lines(block)) {
    const header = line.match(/\b(Weekly limit|5h limit|Five[- ]hour limit)\s*:(.*)$/i);
    if (!header) continue;
    const window = emptyWindow(/weekly/i.test(header[1]) ? 'weekly' : 'five_hour', header[1]);
    const percent = header[2].match(/(\d+(?:\.\d+)?)\s*%\s*(left|used)\b/i);
    if (percent && Number(percent[1]) <= 100) {
      const value = Number(percent[1]);
      const left = percent[2].toLowerCase() === 'left';
      Object.assign(window, { state: 'measured', remaining: left ? fraction(value) : complement(value), used: left ? complement(value) : fraction(value) });
    }
    const resets = header[2].match(/\(resets\s+([^)]*)\)/i);
    if (resets) reset(window, resets[1]);
    windows.push(window);
  }
  if (windows.length) snapshot.pools.push({ id: 'shared', label: windows.map(window => window.label).join(', '), windows });
  const weekly = windows.filter(window => window.name === 'weekly');
  snapshot.completeness = !windows.length ? 'unknown' : weekly.length === 1 && windows.every(window => window.state === 'measured') ? 'complete' : 'partial';
}

function parseClaude(block: string, snapshot: ScreenQuotaSnapshot, reset: ResetParser) {
  const rows = lines(block);
  const sections: { header: string; body: string[] }[] = [];
  for (const line of rows) {
    if (/^(Current session|Current week \([^)]*\)|Usage credits)(?=\s|$)/.test(line)) sections.push({ header: line, body: [] });
    else sections.at(-1)?.body.push(line);
  }
  const pools = new Map<string, ScreenQuotaPool>();
  for (const section of sections.filter((entry, index) => !sections.slice(index + 1).some(later => later.header === entry.header))) {
    const used = section.body.map(line => line.match(/(\d+(?:\.\d+)?)\s*%\s*used\b/i)).find(Boolean);
    const resetLine = section.body.find(line => /^Resets\b/i.test(line));
    if (section.header.startsWith('Usage credits')) {
      snapshot.credits = { usedFraction: used && Number(used[1]) <= 100 ? fraction(Number(used[1])) : null, label: 'Usage credits' };
      continue;
    }
    const scope = section.header.match(/^Current week \(([^)]*)\)/)?.[1];
    const id = scope === undefined || scope.toLowerCase() === 'all models' ? 'all_models' : scope.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const window = emptyWindow(scope === undefined ? 'session' : 'weekly', section.header.match(/^(Current session|Current week \([^)]*\))/)![1]);
    if (used && Number(used[1]) <= 100) Object.assign(window, { state: 'measured', used: fraction(Number(used[1])), remaining: complement(Number(used[1])) });
    if (resetLine) reset(window, resetLine);
    const pool = pools.get(id) ?? { id, label: id === 'all_models' ? 'All models' : scope!, windows: [] };
    pool.windows.push(window);
    pools.set(id, pool);
  }
  snapshot.pools = [...pools.values()];
  const all = pools.get('all_models');
  const names = new Set(all?.windows.filter(window => window.state === 'measured').map(window => window.name));
  snapshot.completeness = !snapshot.pools.length ? 'unknown' : all && all.windows.length === 2 && names.has('session') && names.has('weekly') ? 'complete' : 'partial';
}

function parseGrok(block: string, text: string, snapshot: ScreenQuotaSnapshot, reset: ResetParser) {
  const rows = lines(block);
  const headerIndex = rows.findLastIndex(line => /Weekly limit \([^)]*\)/.test(line) && !/limit left/i.test(line));
  if (headerIndex < 0) return;
  const label = rows[headerIndex].match(/Weekly limit \([^)]*\)/)![0];
  const window = emptyWindow('weekly', label);
  const after = [rows[headerIndex].slice(rows[headerIndex].indexOf(label) + label.length), ...rows.slice(headerIndex + 1)];
  const bar = after.filter(line => !/limit left/i.test(line)).map(line => line.match(/(\d+(?:\.\d+)?)\s*%/)).find(Boolean);
  const left = lines(text).map(line => line.match(/Weekly limit left:\s*(\d+(?:\.\d+)?)\s*%/i)).findLast(Boolean);
  if (bar && left && Math.abs(Number(bar[1]) + Number(left[1]) - 100) < 1e-9) {
    Object.assign(window, { state: 'measured', used: fraction(Number(bar[1])), remaining: fraction(Number(left[1])) });
  } else snapshot.issues.push(`${label}: used ${bar?.[1] ?? 'missing'}% and left ${left?.[1] ?? 'missing'}% do not add up to 100%`);
  const resets = after.map(line => line.match(/Resets:\s*(.+)$/i)).find(Boolean);
  if (resets) reset(window, resets[1]);
  snapshot.pools.push({ id: 'shared', label, windows: [window] });
  snapshot.completeness = window.state === 'measured' ? 'complete' : 'partial';
}

function parseAgy(block: string, snapshot: ScreenQuotaSnapshot, reset: ResetParser) {
  const all = [...block.matchAll(/GEMINI MODELS|CLAUDE AND GPT MODELS/g)];
  const headings = all.filter((heading, index) => !all.slice(index + 1).some(later => later[0] === heading[0]));
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const section = block.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? block.length);
    const id = heading[0] === 'GEMINI MODELS' ? 'gemini' : 'claude_gpt';
    const labels = [...section.matchAll(/Weekly Limit Remaining|Five Hour Limit Remaining/g)];
    const windows = labels.map((label, position) => {
      const text = section.slice(label.index! + label[0].length, labels[position + 1]?.index ?? section.length);
      const window = emptyWindow(label[0].startsWith('Weekly') ? 'weekly' : 'five_hour', label[0]);
      const disabled = text.match(/Disabled:\s*([^\n]*)/i);
      if (disabled) return Object.assign(window, { state: 'disabled' as const, explanation: normalize(disabled[1]) });
      const percent = text.match(/(\d+(?:\.\d+)?)\s*%/);
      if (percent && Number(percent[1]) <= 100) Object.assign(window, { state: 'measured', remaining: fraction(Number(percent[1])), used: complement(Number(percent[1])) });
      const refresh = text.match(/Refreshes in\s*([^\n]*)/i);
      if (refresh) reset(window, `in ${normalize(refresh[1])}`);
      return window;
    });
    snapshot.pools.push({ id, label: heading[0], windows });
  }
  const complete = snapshot.pools.length === 2 && new Set(snapshot.pools.map(pool => pool.id)).size === 2
    && snapshot.pools.every(pool => pool.windows.length === 2 && new Set(pool.windows.map(window => window.name)).size === 2 && pool.windows.every(window => window.state !== 'unknown'));
  snapshot.completeness = !snapshot.pools.length ? 'unknown' : complete ? 'complete' : 'partial';
}

export function poolQuotaStatus(pool: ScreenQuotaPool | null, view: Pick<ScreenQuotaView, 'current' | 'reason'>, now: string): PoolQuotaStatus {
  if (!pool || !view.current || view.reason !== 'fresh') return 'unknown';
  const at = Date.parse(now);
  const measured = pool.windows.filter(window => window.state === 'measured' && window.remaining !== null);
  if (measured.some(window => window.remaining === 0 && (window.resetAt === null || Date.parse(window.resetAt) > at))) return 'exhausted';
  if (measured.some(window => window.resetAt !== null && Date.parse(window.resetAt) <= at)) return 'unknown';
  if (pool.windows.some(window => window.state === 'unknown')) return 'unknown';
  return measured.length > 0 && measured.every(window => window.remaining! > 0) ? 'available' : 'unknown';
}

export function routingQuotaEntries(protocols: readonly QuotaProtocol[], views: readonly ScreenQuotaView[], models: readonly { id: string; runner: string }[], now: string): RoutingQuotaEntry[] {
  const entries: RoutingQuotaEntry[] = [];
  for (const model of models) {
    const protocol = protocols.find(row => row.runner === model.runner);
    const poolId = protocol && Object.hasOwn(protocol.modelPools, model.id) ? protocol.modelPools[model.id] : undefined;
    const view = views.find(row => row.runner === model.runner);
    if (!poolId || !view?.snapshot) continue;
    entries.push({ runner: model.runner, pool: model.id, status: poolQuotaStatus(view.snapshot.pools.find(pool => pool.id === poolId) ?? null, view, now) });
  }
  return entries;
}
