import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { collectRunnerQuotas, quotaCurrentView, readQuotaViews, validateQuotaRunners } from '../src/quota-collection.ts';
import type { CurrentQuota, ProbeHandle, QuotaDependencies } from '../src/quota-collection.ts';
import type { ProtocolSettings, QuotaSnapshot, RunnerId } from '../src/runner-protocols.ts';
import { validateQuotaProtocol } from '../src/quota-screens.ts';
import * as frames from './quota-frames.ts';

const now = '2030-01-01T00:00:00.000Z';
const enabled = { codex: true, grok: true, agy: true, claude: false };
function config(runner: RunnerId): ProtocolSettings {
  return {
    runner, executable: runner, version: 'synthetic-test-version', baseArgs: [], modelFlag: '--model', effortFlag: '--effort', effortFormat: 'literal', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null,
    quotaCommand: runner === 'agy' ? '/usage' : runner === 'codex' ? '/status' : null,
    navigation: [{ state: 'known_navigation', match: '/usage', keys: ['Enter'] }],
    markers: { ready: ['READY'], quota_panel: ['Models & Quota'], auth_required: ['AUTH REQUIRED'], permission_required: ['PERMISSION REQUIRED'], known_navigation: ['COMMAND MENU'] },
    quotaParser: runner === 'agy' ? 'agy_usage' : runner === 'codex' ? 'codex_status' : 'unknown', modelPools: {}, quotaReliable: runner === 'agy', liveTaskVerified: false,
    timeouts: { startupMs: 20, transitionMs: 20, overallMs: 100, pollMs: 5 }, collection: { intervalMs: 1000, failureBackoffMs: 2000, staleAfterMs: 10000 },
  };
}
const panel = `Models & Quota
GEMINI MODELS
Gemini Flash / Gemini Pro
Weekly Limit Remaining 75%
Refreshes in 1h 0m
Five Hour Limit Remaining 40%
Refreshes in 0h 30m
CLAUDE AND GPT MODELS
Claude Opus / Claude Sonnet / GPT-OSS
Weekly Limit Remaining 60%
Refreshes in 2h 0m
Five Hour Limit Remaining 50%
Refreshes in 0h 30m`;
function snapshot(runner: RunnerId = 'agy'): QuotaSnapshot {
  return { runner, observedAt: now, pools: [{ id: 'gemini', windows: [{ name: 'weekly', state: 'measured', used: 0.25, remaining: 0.75, resetAt: '2030-01-02T00:00:00.000Z', resetUncertaintyMs: 60000, explanation: null }] }], credits: null, reliable: true, completeness: 'complete', issues: [] };
}
function current(runner: RunnerId = 'agy'): CurrentQuota {
  return { runner, snapshot: snapshot(runner), lastAttemptAt: now, error: null, nextAttemptAt: null };
}
function harness(screens: Partial<Record<RunnerId, string[]>> = {}) {
  let time = Date.parse(now);
  const rows = new Map<RunnerId, CurrentQuota>();
  const calls: { operation: string; runner?: RunnerId; handle?: ProbeHandle; text?: string; keys?: string[] }[] = [];
  const owned = new Map<ProbeHandle, RunnerId>();
  const held = new Set<string>();
  const offsets = new Map<RunnerId, number>();
  const dependencies: QuotaDependencies = {
    now: () => new Date(time).toISOString(),
    wait: async milliseconds => { time += milliseconds; },
    store: { read: async runner => rows.get(runner) ?? null, replaceCurrent: async value => { rows.set(value.runner, structuredClone(value)); } },
    lock: { acquire: async key => {
      calls.push({ operation: 'lock' });
      if (held.has(key)) return null;
      held.add(key);
      return { release: async () => { calls.push({ operation: 'release' }); held.delete(key); } };
    } },
    transport: {
      openOwned: async settings => {
        const handle = { socket: '/synthetic-owned/probe.sock', session: `quota-${settings.runner}`, ownershipToken: `owned-${settings.runner}` };
        owned.set(handle, settings.runner);
        calls.push({ operation: 'open', runner: settings.runner, handle });
        return handle;
      },
      captureOwned: async handle => {
        assert.ok(owned.has(handle));
        const runner = owned.get(handle)!;
        calls.push({ operation: 'capture', runner, handle });
        const index = offsets.get(runner) ?? 0;
        offsets.set(runner, index + 1);
        const sequence = screens[runner] ?? ['READY', '/usage\nCOMMAND MENU', panel];
        return { text: sequence[Math.min(index, sequence.length - 1)], version: 'synthetic-test-version', observedAt: dependencies.now(), truncated: false, exited: false };
      },
      sendTextOwned: async (handle, text) => { assert.ok(owned.has(handle)); calls.push({ operation: 'text', handle, text }); },
      sendKeysOwned: async (handle, keys) => { assert.ok(owned.has(handle)); calls.push({ operation: 'keys', handle, keys }); },
      cleanupOwned: async handle => { assert.ok(owned.has(handle)); calls.push({ operation: 'cleanup', handle }); owned.delete(handle); },
    },
  };
  return { dependencies, rows, calls, held, owned };
}
function collect(h: ReturnType<typeof harness>, requested: string[]) {
  return collectRunnerQuotas({ requested, mode: 'explicit', settings: ['codex', 'grok', 'agy', 'claude'].map(value => config(value as RunnerId)), enabled }, h.dependencies);
}

test('runner validation rejects empty and unknown lists with supplied and available values', () => {
  assert.throws(() => validateQuotaRunners([], ['agy', 'codex']), /runners.*agy.*codex|agy.*codex.*runners/i);
  assert.throws(() => validateQuotaRunners(['invalid'], ['agy', 'codex']), /invalid/);
  assert.deepEqual(validateQuotaRunners(['agy', 'codex'], ['agy', 'codex']), ['agy', 'codex']);
});
test('invalid selection causes zero probe side effects', async () => {
  const h = harness();
  await assert.rejects(collect(h, ['agy', 'invalid']));
  assert.deepEqual(h.calls, []);
});
test('successful collection uses only owned handles, observed command navigation, cleanup and current replacement', async () => {
  const h = harness();
  const result = await collect(h, ['agy']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.results[0].collected, true);
  assert.equal(h.rows.get('agy')?.snapshot?.completeness, 'complete');
  assert.deepEqual(h.calls.filter(call => call.operation === 'text').map(call => call.text), ['/usage']);
  const textIndex = h.calls.findIndex(call => call.operation === 'text');
  const keyIndex = h.calls.findIndex(call => call.operation === 'keys');
  assert.ok(keyIndex > textIndex);
  assert.ok(h.calls.slice(textIndex + 1, keyIndex).some(call => call.operation === 'capture'));
  assert.equal(h.calls.filter(call => call.operation === 'cleanup').length, 1);
  assert.equal(h.owned.size, 0);
  assert.equal(h.held.size, 0);
  assert.deepEqual(Object.keys(h.rows.get('agy')!).sort(), ['error', 'lastAttemptAt', 'nextAttemptAt', 'runner', 'snapshot']);
});
test('partial failure preserves previous good snapshot, records error, reports age and returns nonzero', async () => {
  const h = harness({ grok: ['AUTH REQUIRED'] });
  const previous = current('grok');
  h.rows.set('grok', previous);
  const result = await collect(h, ['agy', 'grok']);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results.find(value => value.runner === 'agy')?.collected, true);
  const failure = result.results.find(value => value.runner === 'grok')!;
  assert.equal(failure.collected, false);
  assert.equal(failure.view.current, false);
  assert.equal(typeof failure.view.ageMs, 'number');
  assert.equal(failure.view.error?.code, 'auth_required');
  assert.ok(failure.view.error?.remedy);
  assert.deepEqual(h.rows.get('grok')?.snapshot, previous.snapshot);
  assert.equal(h.owned.size, 0);
  assert.equal(h.held.size, 0);
});
test('unknown and permission screens stop without text or confirmation and clean up', async () => {
  for (const screen of ['UNKNOWN SCREEN', 'PERMISSION REQUIRED']) {
    const h = harness({ agy: [screen] });
    const result = await collect(h, ['agy']);
    assert.notEqual(result.exitCode, 0);
    assert.equal(h.calls.filter(call => call.operation === 'text' || call.operation === 'keys').length, 0);
    assert.equal(h.owned.size, 0);
    assert.equal(h.held.size, 0);
  }
});
test('transport failure retains snapshot and still releases owned resources', async () => {
  const h = harness();
  const previous = current();
  h.rows.set('agy', previous);
  h.dependencies.transport.captureOwned = async () => { throw new Error('synthetic capture failed'); };
  const result = await collect(h, ['agy']);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(h.rows.get('agy')?.snapshot, previous.snapshot);
  assert.equal(h.rows.get('agy')?.error?.code, 'probe_failed');
  assert.equal(h.owned.size, 0);
  assert.equal(h.held.size, 0);
});
test('finite configured deadline terminates repeated readiness without quota and cleans up', async () => {
  const h = harness({ agy: ['READY'] });
  const result = await collect(h, ['agy']);
  assert.notEqual(result.exitCode, 0);
  assert.equal(h.rows.get('agy')?.error?.code, 'timeout');
  assert.equal(h.owned.size, 0);
  assert.equal(h.held.size, 0);
});
test('explicit selection attempts disabled Claude without changing enablement', async () => {
  const explicit = harness({ claude: ['UNKNOWN SCREEN'] });
  const result = await collect(explicit, ['claude']);
  assert.equal(explicit.calls.filter(call => call.operation === 'open').length, 1);
  assert.equal(result.results[0].collected, false);
  assert.equal(enabled.claude, false);
});
test('contended lock cannot create duplicate probe or claim cache as fresh collection', async () => {
  const h = harness();
  h.rows.set('agy', current());
  h.dependencies.lock.acquire = async () => null;
  const result = await collect(h, ['agy']);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results[0].collected, false);
  assert.equal(result.results[0].view.error?.code, 'busy');
  assert.equal(h.calls.filter(call => call.operation === 'open').length, 0);
});
test('S.5 explicit runner limits can retry a failed probe immediately without background backoff', async () => {
  const h = harness({ agy: ['UNKNOWN SCREEN'] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await collect(h, ['agy']);
    assert.equal(result.results[0].view.error?.code, 'unknown_screen');
  }
  assert.equal(h.calls.filter(call => call.operation === 'open').length, 2);
  assert.equal(h.calls.filter(call => call.operation === 'cleanup').length, 2);
  assert.equal(h.held.size, 0);
});
test('S.5 successful explicit collection does not schedule or throttle the next runner limits', async () => {
  const h = harness();
  assert.equal((await collect(h, ['agy'])).exitCode, 0);
  assert.equal(h.rows.get('agy')?.nextAttemptAt ?? null, null);
  assert.equal((await collect(h, ['agy'])).exitCode, 0);
  assert.equal(h.calls.filter(call => call.operation === 'open').length, 2);
});
test('S.5 collection and production quota store expose no background mode', () => {
  for (const [file, name] of [['quota-collection.ts', 'collectRunnerQuotas'], ['production-runtime.ts', 'quotaStore']]) {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration && ts.isFunctionDeclaration(declaration), `${file}: ${name} declaration`);
    const modes: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node)) modes.push(node.text);
      ts.forEachChild(node, visit);
    };
    for (const parameter of declaration.parameters) visit(parameter);
    assert.equal(modes.includes('background'), false, `${name} must not offer a background quota collection entry point`);
  }
});
test('list reads current state only and starts no probe', async () => {
  const h = harness();
  h.rows.set('agy', current());
  const result = await readQuotaViews([config('agy'), config('claude')], enabled, h.dependencies);
  assert.equal(result.length, 2);
  assert.equal(result.find(value => value.runner === 'claude')?.reason, 'disabled');
  assert.deepEqual(h.calls, []);
});
test('S.5 concurrent readers keep missing, stale and failed quotas unknown without probes or writes', async () => {
  for (const state of ['missing', 'stale', 'failed'] as const) {
    const h = harness();
    if (state !== 'missing') {
      const row = current();
      if (state === 'stale') row.snapshot!.observedAt = '2029-12-31T23:00:00.000Z';
      else row.error = { code: 'probe_failed', message: 'Last explicit collection failed', remedy: 'Run runner limits' };
      h.rows.set('agy', row);
    }
    const before = structuredClone([...h.rows]);
    const views = await Promise.all(Array.from({ length: 3 }, () => readQuotaViews([config('agy')], enabled, h.dependencies)));
    for (const [view] of views) {
      assert.equal(view.current, false);
      assert.equal(view.reason, state === 'failed' ? 'failed' : state);
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual([...h.rows], before);
  }
});
test('staleness, reset, error and untrusted quota never present current capacity', () => {
  assert.equal(quotaCurrentView(current(), config('agy'), now, true).current, true);
  assert.equal(quotaCurrentView(current(), config('agy'), '2030-01-01T00:00:11.000Z', true).reason, 'stale');
  const reset = current();
  reset.snapshot!.pools[0].windows[0].resetAt = now;
  assert.equal(quotaCurrentView(reset, config('agy'), now, true).reason, 'reset');
  const untrusted = current('codex');
  untrusted.snapshot!.reliable = false;
  assert.equal(quotaCurrentView(untrusted, config('codex'), now, true).reason, 'untrusted');
  const failed = current();
  failed.error = { code: 'probe_failed', message: 'synthetic', remedy: 'Retry after runner repair' };
  assert.equal(quotaCurrentView(failed, config('agy'), now, true).current, false);
});
test('open failure releases coordination and preserves previous snapshot without cleanup of unrelated sessions', async () => {
  const h = harness();
  const previous = current();
  h.rows.set('agy', previous);
  h.dependencies.transport.openOwned = async () => { throw new Error('synthetic startup failure'); };
  const result = await collect(h, ['agy']);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(h.rows.get('agy')?.snapshot, previous.snapshot);
  assert.equal(h.rows.get('agy')?.error?.code, 'probe_failed');
  assert.equal(h.calls.filter(call => call.operation === 'cleanup').length, 0);
  assert.equal(h.held.size, 0);
});
test('exited probe is an explicit failure and receives owned cleanup', async () => {
  const h = harness();
  h.dependencies.transport.captureOwned = async () => ({ text: '', version: 'synthetic-test-version', observedAt: now, truncated: false, exited: true });
  const result = await collect(h, ['agy']);
  assert.notEqual(result.exitCode, 0);
  assert.equal(h.rows.get('agy')?.error?.code, 'exited');
  assert.equal(h.owned.size, 0);
  assert.equal(h.held.size, 0);
});
test('cleanup failure remains visible and releases collection lock', async () => {
  const h = harness();
  h.dependencies.transport.cleanupOwned = async handle => {
    assert.ok(h.owned.has(handle));
    throw new Error('synthetic cleanup failure');
  };
  const result = await collect(h, ['agy']);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.results[0].view.error?.code, 'cleanup_failed');
  assert.equal(h.held.size, 0);
});

test('claude screen probe answers the trust prompt only through a handle marked as a registered workspace', async () => {
  const conf = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const settings = validateQuotaProtocol(conf.runnerProtocols.find((row: { runner: string }) => row.runner === 'claude'));
  const trust = ['[Screen Reader Mode: on via flag]', 'Permission Required: Accessing workspace:', '/synthetic/raf-main', 'y. Yes, I trust this folder', 'n. No, exit', 'Enter y/n:'].join('\n');
  const head = frames.claudeReady.slice(0, frames.claudeReady.lastIndexOf('\n'));
  const run = async (trustWorkspace: boolean) => {
    let time = Date.parse('2026-10-22T12:44:00.000Z');
    let trusted = false;
    let buffer = '';
    let panel = false;
    const sent: string[][] = [];
    const typed: string[] = [];
    const dependencies: QuotaDependencies = {
      now: () => new Date(time).toISOString(),
      wait: async milliseconds => { time += milliseconds; },
      store: { read: async () => null, replaceCurrent: async () => {} },
      lock: { acquire: async () => ({ release: async () => {} }) },
      transport: {
        openOwned: async () => ({ socket: '/synthetic-owned/probe.sock', session: 'quota-claude', ownershipToken: 'owned-claude', trustWorkspace }),
        captureOwned: async () => ({ text: !trusted ? trust : panel ? frames.claudeUsagePanel : `${head}\n$ ${buffer}`, version: '2.1.308 (Claude Code)', observedAt: new Date(time).toISOString(), truncated: false, exited: false }),
        sendTextOwned: async (_handle, text) => { typed.push(text); buffer += text; },
        sendKeysOwned: async (_handle, keys) => {
          sent.push(keys);
          if (!trusted && keys.join(' ') === 'y Enter') trusted = true;
          else if (keys.join(' ') === 'Enter' && buffer === '/usage') { panel = true; buffer = ''; }
        },
        cleanupOwned: async () => {},
      },
    };
    const result = await collectRunnerQuotas({ requested: ['claude'], mode: 'explicit', settings: [settings], enabled: { codex: true, grok: true, agy: true, claude: true } }, dependencies);
    return { result, sent, typed };
  };
  const refused = await run(false);
  assert.equal(refused.result.exitCode, 1);
  assert.equal(refused.result.results[0].view.error?.code, 'workspace_trust_required');
  assert.deepEqual(refused.sent, []);
  assert.deepEqual(refused.typed, []);
  const accepted = await run(true);
  assert.equal(accepted.result.exitCode, 0, JSON.stringify(accepted.result));
  assert.deepEqual(accepted.sent, [['y', 'Enter'], ['Enter'], ['Escape']]);
  assert.deepEqual(accepted.typed, ['/usage']);
  assert.ok(accepted.result.results[0].view.snapshot?.pools.some(pool => pool.id === 'all_models'));
});
