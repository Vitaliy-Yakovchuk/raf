import assert from 'node:assert/strict';
import type { AbsoluteQuotaCredits, QuotaCreditsSettings } from '../src/quota-credits.ts';
import type { QuotaProtocol, ScreenQuotaSnapshot } from '../src/quota-screens.ts';
import type { CurrentQuota, ProbeCapture, ProbeHandle, QuotaDependencies } from '../src/quota-collection.ts';
import type { RunnerId } from '../src/runner-protocols.ts';
import { agyReady, agyUsageMenu, agyUsagePanel } from './quota-frames.ts';

export const observedAt = '2030-01-01T00:00:00.000Z';
export const creditSettings: QuotaCreditsSettings = {
  source: 'statusline',
  pattern: '^FIXTURE AI Credits: ([^\\s|]+) \\| END-FIXTURE$',
};

export type CreditsProtocol = QuotaProtocol & {
  quota: QuotaProtocol['quota'] & { credits?: QuotaCreditsSettings };
};
export type CreditsSnapshot = Omit<ScreenQuotaSnapshot, 'credits'> & {
  credits: AbsoluteQuotaCredits | null;
};

export function creditLine(token: string | number): string {
  return `FIXTURE AI Credits: ${token} | END-FIXTURE`;
}

export function quotaPanel(token: string | number | null = 42): string {
  return agyUsagePanel + (token === null ? '' : `\n${creditLine(token)}`);
}

export function protocol(): CreditsProtocol {
  return {
    runner: 'agy', executable: 'agy', version: '1.4.5', baseArgs: [],
    modelFlag: '--model', effortFlag: '--effort', effortFormat: 'literal', modelAliases: {},
    promptTransport: 'prompt_interactive', sessionIdFlag: null, quotaCommand: '/usage', navigation: [],
    markers: { ready: ['? for shortcuts'] }, quotaParser: 'agy_usage',
    modelPools: { 'fixture-gemini': 'gemini', 'fixture-claude': 'claude_gpt' },
    quotaReliable: true, liveTaskVerified: false,
    timeouts: { startupMs: 20, transitionMs: 20, overallMs: 60, pollMs: 5 },
    collection: { intervalMs: 1000, failureBackoffMs: 100, staleAfterMs: 1000 },
    quota: {
      args: ['--model', 'fixture-gemini', '--effort', 'high'], env: { TZ: 'UTC' },
      submitWhen: '^> /usage\\s+View model quota usage$', panel: ['Models & Quota'],
      loading: ['FIXTURE quota loading'], dismissKeys: ['Escape'], credits: { ...creditSettings },
    },
  };
}

export function measuredSnapshot(remaining = 42): CreditsSnapshot {
  return {
    runner: 'agy', observedAt, version: '1.4.5', reliable: true, completeness: 'complete', issues: [],
    pools: ['gemini', 'claude_gpt'].map(id => ({
      id, label: id, windows: [{
        name: 'weekly', label: 'Weekly', state: 'measured', used: 0.25, remaining: 0.75,
        resetAt: '2030-01-02T00:00:00.000Z', resetUncertaintyMs: 0, explanation: null,
      }],
    })),
    credits: {
      label: creditLine(remaining), usedFraction: null, remaining, unit: 'credits',
      source: 'statusline', observedAt, reliable: true,
    },
  };
}

export function previousQuota(remaining = 42): CurrentQuota {
  return { runner: 'agy', snapshot: measuredSnapshot(remaining), lastAttemptAt: observedAt, error: null, nextAttemptAt: null };
}

export const enabled: Record<RunnerId, boolean> = { agy: true, claude: false, codex: false, grok: false };
export const defaultFrames = [agyReady, agyUsageMenu, quotaPanel()];

export type ProbeCall = {
  operation: string;
  key?: string;
  deadline?: string;
  handle?: ProbeHandle;
  text?: string;
  keys?: string[];
  at: string;
};

export function harness(sequence: (string | Partial<ProbeCapture>)[] = defaultFrames) {
  let milliseconds = Date.parse(observedAt);
  let index = 0;
  let busy = false;
  let cleanupFailure = false;
  let captureFailure = false;
  const calls: ProbeCall[] = [];
  const rows = new Map<RunnerId, CurrentQuota>();
  const owned = new Set<ProbeHandle>();
  const now = () => new Date(milliseconds).toISOString();
  const record = (call: Omit<ProbeCall, 'at'>) => { calls.push({ ...call, at: now() }); };
  const dependencies: QuotaDependencies = {
    now,
    wait: async amount => { milliseconds += amount; },
    store: {
      read: async runner => structuredClone(rows.get(runner) ?? null),
      replaceCurrent: async value => { rows.set(value.runner, structuredClone(value)); },
    },
    lock: {
      acquire: async key => {
        record({ operation: 'acquire', key });
        if (busy) return null;
        busy = true;
        return { release: async () => { busy = false; record({ operation: 'release', key }); } };
      },
    },
    transport: {
      openOwned: async (_settings, deadline) => {
        const handle = { socket: '/fixture-owned/quota.sock', session: 'fixture-agy', ownershipToken: 'fixture-owned-token' };
        owned.add(handle);
        record({ operation: 'open', handle, deadline });
        return handle;
      },
      captureOwned: async handle => {
        assert.ok(owned.has(handle), 'capture must target the same owned probe');
        record({ operation: 'capture', handle });
        if (captureFailure) throw new Error('fixture capture failed');
        const frame = sequence[Math.min(index++, sequence.length - 1)];
        return {
          text: '', version: '1.4.5', observedAt: now(), truncated: false, exited: false,
          ...(typeof frame === 'string' ? { text: frame } : frame),
        };
      },
      sendTextOwned: async (handle, text) => {
        assert.ok(owned.has(handle));
        record({ operation: 'text', handle, text });
      },
      sendKeysOwned: async (handle, keys) => {
        assert.ok(owned.has(handle));
        record({ operation: 'keys', handle, keys: [...keys] });
      },
      cleanupOwned: async handle => {
        assert.ok(owned.has(handle), 'cleanup must target the same owned probe');
        owned.delete(handle);
        record({ operation: 'cleanup', handle });
        if (cleanupFailure) throw new Error('fixture cleanup failed');
      },
    },
  };
  return {
    dependencies, calls, rows, owned,
    advance: (amount: number) => { milliseconds += amount; },
    contend: () => { busy = true; },
    failCleanup: () => { cleanupFailure = true; },
    failCapture: () => { captureFailure = true; },
  };
}
