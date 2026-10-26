export type RunnerId = 'codex' | 'grok' | 'agy' | 'claude';
export type ScreenState = 'starting' | 'ready' | 'known_navigation' | 'auth_required' | 'workspace_trust_required' | 'permission_required' | 'unknown_screen' | 'timeout' | 'exited' | 'quota_untrusted' | 'quota_panel';
export type ProtocolSettings = {
  runner: RunnerId;
  executable: string;
  version: string;
  baseArgs: string[];
  modelFlag: string;
  effortFlag: string;
  effortFormat: 'literal' | 'codex_config';
  modelAliases: Record<string, string>;
  promptTransport: 'positional' | 'prompt_interactive';
  sessionIdFlag: string | null;
  quotaCommand: string | null;
  navigation: { state: ScreenState; match: string; keys: string[] }[];
  markers: Partial<Record<ScreenState, string[]>>;
  quotaParser: 'codex_status' | 'claude_usage' | 'grok_usage' | 'agy_usage' | 'unknown';
  modelPools: Record<string, string>;
  quotaReliable: boolean;
  liveTaskVerified: boolean;
  timeouts: { startupMs: number; transitionMs: number; overallMs: number; pollMs: number };
  collection: { intervalMs: number; failureBackoffMs: number; staleAfterMs: number };
  native?: NativeDialect;
};
export type NativeDialect = {
  identity: { source: 'status' | 'assigned'; command: string; pattern: string; dismissKeys: string[] } | { source: 'session_start' };
  composer: string;
  pendingPaste: { pattern: string; unit: 'characters' | 'newlines' | 'logical-lines' };
  working: string;
  writeScope: { directoryFlag: string | null; ruleFlag: string | null; rule: string | null };
  exitCommand: string;
  startup?: string[];
  modeHints?: string[];
  finished?: string;
};
export type NativeComposer = { line: number; input: string };
export type PendingBrief = 'pending' | 'mismatch' | 'none';
export type Invocation = { executable: string; args: string[]; liveTaskVerified: boolean };
export type ScreenObservation = { state: ScreenState; requestedCommand: string | null; matchedNavigation: number | null };
export type ProtocolAction = { kind: 'wait' } | { kind: 'text'; text: string } | { kind: 'keys'; keys: string[] } | { kind: 'capture' } | { kind: 'stop'; reason: ScreenState };
export type QuotaWindow = {
  name: 'weekly' | 'five_hour';
  state: 'measured' | 'disabled' | 'unknown';
  used: number | null;
  remaining: number | null;
  resetAt: string | null;
  resetUncertaintyMs: number | null;
  explanation: string | null;
};
export type QuotaPool = { id: string; windows: QuotaWindow[] };
export type QuotaSnapshot = {
  runner: RunnerId;
  observedAt: string;
  pools: QuotaPool[];
  credits: number | null;
  reliable: boolean;
  completeness: 'complete' | 'partial' | 'unknown';
  issues: string[];
};
export function buildRunnerInvocation(settings: ProtocolSettings, input: { model: string; effort: string; prompt?: string; sessionId?: string }): Invocation {
  if (settings.runner === 'claude' && input.model.startsWith('claude-') && !Object.hasOwn(settings.modelAliases, input.model)) throw new Error(`Missing Claude model alias for ${input.model}`);
  const model = Object.hasOwn(settings.modelAliases, input.model) ? settings.modelAliases[input.model] : input.model;
  const args = [...settings.baseArgs, settings.modelFlag, model, settings.effortFlag,
    settings.effortFormat === 'codex_config' ? `model_reasoning_effort=${JSON.stringify(input.effort)}` : input.effort];
  if (input.sessionId !== undefined) {
    if (!settings.sessionIdFlag) throw new Error('Session identity is unsupported');
    args.push(settings.sessionIdFlag, input.sessionId);
  }
  if (input.prompt !== undefined) {
    if (settings.promptTransport === 'prompt_interactive') args.push('--prompt-interactive');
    args.push(input.prompt);
  }
  return { executable: settings.executable, args, liveTaskVerified: settings.liveTaskVerified };
}
export function observeRunnerScreen(settings: ProtocolSettings, input: { text: string; version: string; requestedCommand: string | null; exited?: boolean; timedOut?: boolean }): ScreenObservation {
  const result = (state: ScreenState, matchedNavigation: number | null = null): ScreenObservation => ({ state, requestedCommand: input.requestedCommand, matchedNavigation });
  if (input.exited) return result('exited');
  if (input.timedOut) return result('timeout');
  for (const state of ['workspace_trust_required', 'auth_required', 'permission_required', 'quota_untrusted', 'quota_panel'] as ScreenState[]) {
    if (!settings.markers[state]?.some(marker => input.text.includes(marker))) continue;
    if (state !== 'workspace_trust_required') return result(state);
    const trust = settings.navigation.findIndex(item => item.state === state && input.text.includes(item.match));
    return result(state, trust >= 0 ? trust : null);
  }
  const lines = input.text.split('\n').map(line => line.trim()).filter(Boolean);
  const startup = settings.native?.startup ?? [];
  if (lines.length && lines.every(line => startup.includes(line))) return result('starting');
  const navigation = settings.navigation.findIndex(item => {
    if (!settings.markers[item.state]?.some(marker => input.text.includes(marker))) return false;
    if (!item.match.startsWith('/')) return input.text.includes(item.match);
    return item.match === input.requestedCommand && item.match === settings.quotaCommand && input.text.split(/\s+/).includes(item.match);
  });
  if (navigation >= 0) return result('known_navigation', navigation);
  if (settings.markers.ready?.some(marker => input.text.includes(marker))) return result('ready');
  return result('unknown_screen');
}
export function nextRunnerAction(settings: ProtocolSettings, observation: ScreenObservation, options: { trustWorkspace?: boolean } = {}): ProtocolAction {
  if (observation.state === 'starting') return { kind: 'wait' };
  if (observation.state === 'workspace_trust_required' && options.trustWorkspace) {
    const trust = observation.matchedNavigation === null ? undefined : settings.navigation[observation.matchedNavigation];
    if (trust?.state === 'workspace_trust_required' && trust.keys.length) return { kind: 'keys', keys: [...trust.keys] };
  }
  if (observation.state === 'known_navigation') {
    const navigation = observation.matchedNavigation === null ? undefined : settings.navigation[observation.matchedNavigation];
    if (navigation && (!navigation.match.startsWith('/') || navigation.match === observation.requestedCommand && navigation.match === settings.quotaCommand)) return { kind: 'keys', keys: [...navigation.keys] };
  }
  if (observation.state === 'quota_panel') return { kind: 'capture' };
  if (observation.state === 'ready' && settings.quotaCommand && observation.requestedCommand === null) return { kind: 'text', text: settings.quotaCommand };
  if (observation.state === 'ready' && observation.requestedCommand === settings.quotaCommand) return { kind: 'capture' };
  return { kind: 'stop', reason: observation.state === 'known_navigation' || observation.state === 'ready' ? 'unknown_screen' : observation.state };
}
export function parseRunnerQuota(settings: ProtocolSettings, input: { text: string; observedAt: string; version: string; truncated: boolean }): QuotaSnapshot {
  const snapshot: QuotaSnapshot = { runner: settings.runner, observedAt: input.observedAt, pools: [], credits: null, reliable: settings.quotaReliable, completeness: 'unknown', issues: [] };
  if (input.version !== settings.version || !Number.isFinite(Date.parse(input.observedAt))) {
    snapshot.reliable = false;
    snapshot.issues.push('Unsupported version or observation time');
    return snapshot;
  }
  const window = (name: QuotaWindow['name'], text: string): QuotaWindow => {
    const result: QuotaWindow = { name, state: 'unknown', used: null, remaining: null, resetAt: null, resetUncertaintyMs: null, explanation: null };
    const disabled = text.match(/Disabled:\s*([^\n]*)/i);
    if (disabled) {
      result.state = 'disabled';
      result.explanation = disabled[1].trim();
      return result;
    }
    const percent = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (percent && Number(percent[1]) <= 100) {
      result.state = 'measured';
      const value = Number(percent[1]) / 100;
      const used = /%\s*used/i.test(text) || /limit used/i.test(text);
      result.used = used ? value : (100 - Number(percent[1])) / 100;
      result.remaining = used ? (100 - Number(percent[1])) / 100 : value;
    }
    const relative = text.match(/Refreshes in\s*(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/i);
    if (relative && relative.slice(1).some(Boolean)) {
      const minutes = Number(relative[1] ?? 0) * 1440 + Number(relative[2] ?? 0) * 60 + Number(relative[3] ?? 0);
      result.resetAt = new Date(Date.parse(input.observedAt) + minutes * 60000).toISOString();
      result.resetUncertaintyMs = relative[3] ? 60000 : 3600000;
    } else if (/resets/i.test(text)) snapshot.issues.push('Reset year/timezone unknown');
    return result;
  };
  if (settings.quotaParser === 'agy_usage') {
    const headings = [...input.text.matchAll(/GEMINI MODELS|CLAUDE AND GPT MODELS/g)];
    for (let index = 0; index < headings.length; index++) {
      const heading = headings[index];
      const section = input.text.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? input.text.length);
      const id = heading[0] === 'GEMINI MODELS' ? 'gemini' : 'claude_gpt';
      const windows: QuotaWindow[] = [];
      const labels = [...section.matchAll(/Weekly Limit Remaining|Five Hour Limit Remaining/g)];
      for (let j = 0; j < labels.length; j++) {
        windows.push(window(labels[j][0].startsWith('Weekly') ? 'weekly' : 'five_hour', section.slice(labels[j].index!, labels[j + 1]?.index ?? section.length)));
      }
      snapshot.pools.push({ id, windows });
    }
    snapshot.completeness = snapshot.pools.length === 2 && new Set(snapshot.pools.map(pool => pool.id)).size === 2 && snapshot.pools.every(pool => pool.windows.length === 2 && new Set(pool.windows.map(value => value.name)).size === 2 && pool.windows.every(value => value.state !== 'unknown')) ? 'complete' : 'partial';
  } else if (settings.quotaParser === 'codex_status') {
    const windows: QuotaWindow[] = [];
    for (const line of input.text.split('\n')) {
      if (/weekly limit:/i.test(line)) windows.push(window('weekly', line));
      else if (/(?:5h|five hour|5.hour) limit:/i.test(line)) windows.push(window('five_hour', line));
      const credits = line.match(/Credits:\s*([\d,.]+)/i);
      if (credits) snapshot.credits = Number(credits[1].replaceAll(',', ''));
    }
    if (windows.length) snapshot.pools.push({ id: 'shared', windows });
    snapshot.completeness = windows.length === 2 ? 'complete' : 'partial';
  } else {
    snapshot.reliable = false;
    snapshot.issues.push('Quota protocol unverified');
  }
  if (!settings.quotaReliable) snapshot.issues.push('Quota reliability unverified');
  if (input.truncated) {
    snapshot.completeness = 'partial';
    snapshot.issues.push('Truncated quota screen');
  }
  if (snapshot.completeness !== 'complete') snapshot.issues.push('Missing or unknown quota windows');
  return snapshot;
}
export function quotaForModel(settings: ProtocolSettings, snapshot: QuotaSnapshot, model: string): QuotaPool | null {
  if (snapshot.runner !== settings.runner) return null;
  const pool = settings.modelPools[model];
  return pool ? snapshot.pools.find(value => value.id === pool) ?? null : null;
}
function dialect(settings: ProtocolSettings): NativeDialect {
  if (!settings.native) throw new Error(`Runner ${settings.runner} has no native dialect`);
  return settings.native;
}
export function readNativeComposer(settings: ProtocolSettings, screen: string): NativeComposer | null {
  const composer = new RegExp(dialect(settings).composer, 'u');
  const lines = screen.split('\n');
  for (let line = lines.length - 1; line >= 0; line--) {
    const marker = lines[line].match(composer);
    if (marker) return { line, input: (marker[1] ?? lines[line].slice(marker[0].length)).trim() };
  }
  return null;
}
export function matchPendingBrief(settings: ProtocolSettings, input: string, brief: string): PendingBrief {
  const pending = dialect(settings).pendingPaste;
  const paste = input.match(new RegExp(pending.pattern, 'u'));
  if (paste) {
    const count = Number(paste[1]);
    const expected = pending.unit === 'characters' ? [...brief].length : brief.split('\n').length - (pending.unit === 'newlines' ? 1 : 0);
    return count === expected || pending.unit === 'characters' && count === expected + 1 ? 'pending' : 'mismatch';
  }
  if (!brief.includes('\n') && (input === brief || input === brief + '\n')) return 'pending';
  return input === '' ? 'none' : 'mismatch';
}
export function readNativeSessionId(settings: ProtocolSettings, screen: string): string | null {
  const identity = dialect(settings).identity;
  return identity.source === 'session_start' ? null : screen.match(new RegExp(identity.pattern, 'iu'))?.[1] ?? null;
}
export function isNativeWorking(settings: ProtocolSettings, screen: string): boolean {
  return new RegExp(dialect(settings).working, 'mu').test(screen);
}
export function nativeDeliveryContext(settings: ProtocolSettings, lines: readonly string[], composerLine: number): { header: string; footer: string } {
  const hints = dialect(settings).modeHints ?? [];
  const mode = (line: string) => hints.length && (hints.includes(line) || settings.markers.ready?.some(marker => line.includes(marker))) ? '\u0000mode' : line;
  const join = (part: readonly string[]) => part.map(line => mode(line.trim())).filter(Boolean).join('\n');
  return { header: join(lines.slice(0, composerLine)), footer: join(lines.slice(composerLine + 1)) };
}
export function isNativeBriefEcho(brief: string, screen: string): boolean {
  const rendered = screen.replace(/\s+/gu, '');
  return rendered !== '' && brief.replace(/\s+/gu, '').includes(rendered);
}
export function matchesNativeDeliveryContext(settings: ProtocolSettings, before: { header: string; footer: string }, current: { header: string; footer: string }, brief: string): boolean {
  if (before.header === current.header && before.footer === current.footer) return true;
  if (settings.runner !== 'codex') return false;
  const knownHeader = current.header === before.header || isNativeBriefEcho(brief, current.header);
  const knownFooter = current.footer === before.footer || /^tab to queue message\s+\d+% context left$/u.test(current.footer);
  return knownHeader && knownFooter;
}
export function isNativeFinished(settings: ProtocolSettings, screen: string): boolean {
  const finished = dialect(settings).finished;
  return finished !== undefined && new RegExp(finished, 'mu').test(screen);
}
export function nativeWriteScopeArgs(settings: ProtocolSettings, directories: readonly string[], workspaceDirectories: readonly string[] = []): string[] {
  const scope = dialect(settings).writeScope;
  if ((scope.ruleFlag === null) !== (scope.rule === null)) throw new Error(`Runner ${settings.runner} write rule needs both flag and rule`);
  if ([...directories, ...workspaceDirectories].some(directory => !directory.startsWith('/'))) throw new Error('Write scope directories must be absolute');
  const args = scope.directoryFlag === null ? [] : directories.flatMap(directory => [scope.directoryFlag!, directory]);
  const ruled = [...directories, ...workspaceDirectories.filter(directory => !directories.includes(directory))];
  if (scope.ruleFlag && scope.rule && ruled.length) args.push(scope.ruleFlag, ...ruled.map(directory => scope.rule!.replaceAll('{directory}', directory)));
  return args;
}
export type NativeSandboxScope = { hidden: readonly string[]; readable: readonly string[]; tmuxDirectory: string; excludedCommands: readonly string[] };
export function nativeSandboxArgs(settings: ProtocolSettings, args: readonly string[], scope: NativeSandboxScope): string[] {
  if (settings.runner !== 'claude') return [...args];
  if ([...scope.hidden, ...scope.readable, scope.tmuxDirectory].some(path => !path.startsWith('/'))) throw new Error('Sandbox scope paths must be absolute');
  const index = args.indexOf('--settings');
  let value: { sandbox?: Record<string, unknown>; env?: Record<string, string> } | undefined;
  try { value = index < 0 ? undefined : JSON.parse(args[index + 1]); } catch { value = undefined; }
  const sandbox = value?.sandbox;
  if (!sandbox) return [...args];
  const list = (from: unknown, add: readonly string[]) => [...new Set([...(Array.isArray(from) ? from as string[] : []), ...add])];
  const network = { ...(sandbox.network as Record<string, unknown> | undefined), allowAllUnixSockets: true };
  const filesystem = sandbox.filesystem as Record<string, unknown> | undefined;
  const merged = {
    ...value,
    sandbox: {
      ...sandbox, network,
      filesystem: { ...filesystem, denyRead: list(filesystem?.denyRead, scope.hidden), allowRead: list(filesystem?.allowRead, scope.readable) },
      ...(scope.excludedCommands.length ? { excludedCommands: list(sandbox.excludedCommands, scope.excludedCommands) } : {}),
    },
    env: { ...value!.env, TMUX_TMPDIR: scope.tmuxDirectory, TMUX: '' },
  };
  return args.map((arg, position) => position === index + 1 ? JSON.stringify(merged) : arg);
}
