import { observeRunnerScreen, nextRunnerAction, parseRunnerQuota } from './runner-protocols.ts';
import type { ProtocolSettings, QuotaSnapshot, RunnerId, ScreenState } from './runner-protocols.ts';
import { nextQuotaProbeAction, parseQuotaScreen, type QuotaProtocol, type ScreenQuotaSnapshot } from './quota-screens.ts';
import type { AbsoluteQuotaCredits } from './quota-credits.ts';
export type CollectionSettings = ProtocolSettings | QuotaProtocol;
type AnySnapshot = QuotaSnapshot | ScreenQuotaSnapshot;
export type ProbeHandle = { socket: string; session: string; ownershipToken: string; trustWorkspace?: boolean };
export type ProbeCapture = { text: string; version: string; observedAt: string; truncated: boolean; exited: boolean };
export type ProbeTransport = {
  openOwned: (settings: CollectionSettings, deadline: string) => Promise<ProbeHandle>;
  captureOwned: (handle: ProbeHandle) => Promise<ProbeCapture>;
  sendTextOwned: (handle: ProbeHandle, text: string) => Promise<void>;
  sendKeysOwned: (handle: ProbeHandle, keys: string[]) => Promise<void>;
  cleanupOwned: (handle: ProbeHandle) => Promise<void>;
};
export type CollectionError = { code: ScreenState | 'command_mismatch' | 'probe_failed' | 'busy' | 'backoff' | 'disabled' | 'incomplete' | 'cleanup_failed'; message: string; remedy: string };
export type CurrentQuota = { runner: RunnerId; snapshot: AnySnapshot | null; lastAttemptAt: string | null; error: CollectionError | null; nextAttemptAt: string | null };
export type QuotaCurrentStore = { read: (runner: RunnerId) => Promise<CurrentQuota | null>; replaceCurrent: (value: CurrentQuota) => Promise<void> };
export type CollectionLock = { acquire: (key: string) => Promise<{ release: () => Promise<void> } | null> };
export type QuotaDependencies = {
  transport: ProbeTransport;
  store: QuotaCurrentStore;
  lock: CollectionLock;
  now: () => string;
  wait: (milliseconds: number) => Promise<void>;
};
export type QuotaView = { runner: RunnerId; snapshot: AnySnapshot | null; ageMs: number | null; current: boolean; reason: 'fresh' | 'missing' | 'stale' | 'reset' | 'untrusted' | 'failed' | 'disabled'; error: CollectionError | null };
export type CollectionResult = { exitCode: number; results: { runner: RunnerId; collected: boolean; view: QuotaView }[] };
export function validateQuotaRunners(requested: string[], available: RunnerId[]): RunnerId[] {
  if (requested.length === 0 || requested.some(runner => !available.includes(runner as RunnerId))) throw new Error(`Invalid runners: ${requested.join(', ') || '(empty)'}. Available: ${available.join(', ')}. Provide a nonempty --runners list from the available values.`);
  return [...new Set(requested)] as RunnerId[];
}
export function quotaCurrentView(current: CurrentQuota | null, settings: CollectionSettings, now: string, enabled: boolean): QuotaView {
  const snapshot = current?.snapshot ? structuredClone(current.snapshot) : null;
  if (snapshot && absoluteCredits(snapshot.credits)) {
    const credits = snapshot.credits;
    const creditAge = Date.parse(now) - Date.parse(credits.observedAt);
    const failedBalance = current?.error && (current.error.code !== 'incomplete' || !current.lastAttemptAt || Date.parse(credits.observedAt) < Date.parse(current.lastAttemptAt));
    const issue = !enabled ? 'Runner disabled' : failedBalance ? current!.error!.message : !Number.isFinite(creditAge) || creditAge < 0 || creditAge >= settings.collection.staleAfterMs ? 'Stale credits observation' : null;
    if (issue) { credits.reliable = false; credits.issue = [credits.issue, issue].filter(Boolean).join('; '); }
  }
  const ageMs = snapshot ? Math.max(0, Date.parse(now) - Date.parse(snapshot.observedAt)) : null;
  let reason: QuotaView['reason'] = 'fresh';
  if (!enabled) reason = 'disabled';
  else if (current?.error) reason = 'failed';
  else if (!snapshot) reason = 'missing';
  else if (!snapshot.reliable || !settings.quotaReliable || snapshot.completeness !== 'complete') reason = 'untrusted';
  else if (ageMs === null || !Number.isFinite(ageMs) || ageMs >= settings.collection.staleAfterMs) reason = 'stale';
  else if (snapshot.pools.some(pool => pool.windows.some(window => window.resetAt !== null && Date.parse(window.resetAt) <= Date.parse(now)))) reason = 'reset';
  return { runner: settings.runner, snapshot, ageMs, current: reason === 'fresh', reason, error: current?.error ?? null };
}
export async function readQuotaViews(settings: readonly CollectionSettings[], enabled: Record<RunnerId, boolean>, dependencies: Pick<QuotaDependencies, 'store' | 'now'>): Promise<QuotaView[]> {
  const now = dependencies.now();
  return Promise.all(settings.map(async setting => quotaCurrentView(await dependencies.store.read(setting.runner), setting, now, enabled[setting.runner])));
}
export async function collectRunnerQuotas(input: { requested: string[]; mode: 'background' | 'explicit'; settings: readonly CollectionSettings[]; enabled: Record<RunnerId, boolean> }, dependencies: QuotaDependencies): Promise<CollectionResult> {
  const requested = validateQuotaRunners(input.requested, input.settings.map(setting => setting.runner));
  const results: CollectionResult['results'] = [];
  const error = (code: CollectionError['code'], message: string): CollectionError => ({ code, message, remedy: 'Check runner authentication, supported version and protocol settings, then retry collection.' });
  for (const runner of requested) {
    const settings = input.settings.find(setting => setting.runner === runner)!;
    let previous = await dependencies.store.read(runner);
    const unavailable = (failure: CollectionError) => {
      const view = quotaCurrentView(previous, settings, dependencies.now(), input.enabled[runner]);
      results.push({ runner, collected: false, view: { ...view, current: false, error: failure, reason: failure.code === 'disabled' ? 'disabled' : 'failed' } });
    };
    if (input.mode === 'background' && !input.enabled[runner]) {
      unavailable(error('disabled', 'Runner disabled for automatic collection'));
      continue;
    }
    const lease = await dependencies.lock.acquire(`quota:${runner}`);
    if (!lease) {
      unavailable(error('busy', 'A coordinated quota probe is already running'));
      continue;
    }
    let handle: ProbeHandle | null = null;
    let snapshot: AnySnapshot | null = null;
    let failure: CollectionError | null = null;
    const attemptedAt = dependencies.now();
    try {
      previous = await dependencies.store.read(runner);
      if (previous?.nextAttemptAt && Date.parse(previous.nextAttemptAt) > Date.parse(attemptedAt)) {
        unavailable(error('backoff', `Next collection is available at ${previous.nextAttemptAt}`));
        continue;
      }
      const { overallMs, startupMs, transitionMs, pollMs } = settings.timeouts;
      if ([overallMs, startupMs, transitionMs, pollMs].some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid finite protocol timing budgets');
      const start = Date.parse(attemptedAt);
      let elapsed = 0;
      let transitionDeadline = startupMs;
      let requestedCommand: string | null = null;
      handle = await dependencies.transport.openOwned(settings, new Date(start + overallMs).toISOString());
      if ('quota' in settings) {
        const outcome = await screenDialog(settings, handle, start, dependencies, error);
        snapshot = outcome.snapshot;
        failure = outcome.failure;
      } else for (;;) {
        elapsed = Math.max(elapsed, Date.parse(dependencies.now()) - start);
        if (elapsed >= overallMs || elapsed >= transitionDeadline) {
          failure = error('timeout', 'Quota probe exceeded its configured deadline');
          break;
        }
        const capture = await dependencies.transport.captureOwned(handle);
        const observation = observeRunnerScreen(settings, { ...capture, requestedCommand });
        const action = nextRunnerAction(settings, observation);
        if (observation.state === 'quota_panel') {
          const parsed = parseRunnerQuota(settings, capture);
          if (!parsed.reliable) failure = error('quota_untrusted', 'Quota reliability has not been verified');
          else if (parsed.completeness !== 'complete') failure = error('incomplete', parsed.issues.join('; '));
          else snapshot = parsed;
          break;
        }
        if (action.kind === 'stop') {
          failure = error(action.reason, `Quota probe stopped at ${action.reason}`);
          break;
        }
        if (action.kind === 'text') {
          await dependencies.transport.sendTextOwned(handle, action.text);
          requestedCommand = action.text;
          transitionDeadline = Math.min(overallMs, elapsed + transitionMs);
        } else if (action.kind === 'keys') {
          await dependencies.transport.sendKeysOwned(handle, action.keys);

        }
        await dependencies.wait(pollMs);
        elapsed += pollMs;
      }
    } catch (cause) {
      failure = error('probe_failed', cause instanceof Error ? cause.message : String(cause));
    } finally {
      try {
        if (handle) {
          try { await dependencies.transport.cleanupOwned(handle); }
          catch (cause) { failure = error('cleanup_failed', String(cause)); snapshot = null; }
        }
        if (snapshot || failure) {
          const current: CurrentQuota = {
            runner, snapshot: mergeQuotaSnapshot(previous?.snapshot ?? null, snapshot, failure), lastAttemptAt: attemptedAt, error: failure,
            nextAttemptAt: new Date(Date.parse(dependencies.now()) + (failure ? settings.collection.failureBackoffMs : settings.collection.intervalMs)).toISOString(),
          };
          await dependencies.store.replaceCurrent(current);
          results.push({ runner, collected: snapshot !== null && failure === null, view: quotaCurrentView(current, settings, dependencies.now(), input.enabled[runner]) });
        }
      } finally { await lease.release(); }
    }
  }
  return { exitCode: results.some(result => !result.collected) ? 1 : 0, results };
}

function absoluteCredits(value: AnySnapshot['credits']): value is AbsoluteQuotaCredits {
  return !!value && typeof value === 'object' && 'unit' in value && value.unit === 'credits';
}

function mergeQuotaSnapshot(previous: AnySnapshot | null, measured: AnySnapshot | null, failure: CollectionError | null): AnySnapshot | null {
  if (!measured) return previous;
  if (!('version' in measured)) return measured;
  const snapshot = structuredClone(failure && previous && 'version' in previous ? previous : measured);
  if (!('version' in snapshot)) return snapshot;
  const credits = measured.credits;
  if (absoluteCredits(credits) && credits.reliable && credits.remaining !== null) snapshot.credits = credits;
  else if (previous && absoluteCredits(previous.credits) && previous.credits.remaining !== null) {
    snapshot.credits = { ...previous.credits, reliable: false, issue: absoluteCredits(credits) ? credits.issue ?? 'Current credits balance unknown' : 'Current credits balance missing' };
  } else snapshot.credits = credits;
  return snapshot;
}

async function screenDialog(settings: QuotaProtocol, handle: ProbeHandle, start: number, dependencies: QuotaDependencies, error: (code: CollectionError['code'], message: string) => CollectionError): Promise<{ snapshot: ScreenQuotaSnapshot | null; failure: CollectionError | null }> {
  const { overallMs, pollMs } = settings.timeouts;
  let elapsed = 0;
  let typed: string | null = null;
  let typedAtMs: number | null = null;
  let reissuedAtMs: number | null = null;
  let trustAnsweredAtMs: number | null = null;
  let submitted = false;
  for (;;) {
    elapsed = Math.max(elapsed, Date.parse(dependencies.now()) - start);
    if (elapsed >= overallMs) return { snapshot: null, failure: error('timeout', `Quota probe exceeded its configured ${overallMs} ms deadline`) };
    const capture = await dependencies.transport.captureOwned(handle);
    if (capture.exited) return { snapshot: null, failure: error('exited', 'Quota probe CLI exited before the quota panel') };
    const action = nextQuotaProbeAction(settings, { text: capture.text, typed, typedAtMs, submitted, reissuedAtMs, elapsedMs: elapsed, trustWorkspace: handle.trustWorkspace === true, trustAnsweredAtMs });
    if (action.kind === 'stop') {
      const trust = !handle.trustWorkspace ? 'raf answers it only in a registered branch directory from conf/projects.json branchPaths' : 'the prompt stayed after the protocol navigation keys';
      const message = action.reason === 'command_mismatch' ? `CLI did not show the configured command ${settings.quotaCommand}; Enter was not sent` : action.reason === 'workspace_trust_required' ? `Quota probe stopped at workspace_trust_required: ${trust}` : `Quota probe stopped at ${action.reason}`;
      return { snapshot: null, failure: error(action.reason, message) };
    }
    if (action.kind === 'parse') {
      const parsed = parseQuotaScreen(settings, capture);
      if (settings.quota.dismissKeys.length) await dependencies.transport.sendKeysOwned(handle, settings.quota.dismissKeys);
      if (!parsed.reliable) return { snapshot: parsed.credits ? parsed : null, failure: error('quota_untrusted', parsed.issues.join('; ') || 'Quota reliability has not been verified') };
      if (parsed.completeness !== 'complete') return { snapshot: parsed.credits ? parsed : null, failure: error('incomplete', parsed.issues.join('; ')) };
      return { snapshot: parsed, failure: null };
    }
    if (action.kind === 'trust') {
      await dependencies.transport.sendKeysOwned(handle, action.keys);
      trustAnsweredAtMs = elapsed;
    } else if (action.kind === 'type' || action.kind === 'reissue') {
      await dependencies.transport.sendTextOwned(handle, action.text);
      typed = action.text;
      typedAtMs = elapsed;
      submitted = false;
      if (action.kind === 'reissue') reissuedAtMs = elapsed;
    } else if (action.kind === 'submit') {
      await dependencies.transport.sendKeysOwned(handle, ['Enter']);
      submitted = true;
    }
    await dependencies.wait(pollMs);
    elapsed += pollMs;
  }
}
