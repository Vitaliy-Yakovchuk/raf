import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  bugSectionId,
  BugSyncConfigError,
  ClaimsError,
  conflictNoticeKey,
  createClaimsIssuer,
  describeBugSection,
  loadBugSyncConfig,
  nextAttemptDelayMs,
  type BugSyncConfig,
} from '../src/bug-sync.ts';
import type { SecretsSelection } from '../src/secrets-store.ts';
import { ACTOR, ETCHLY, ManualClock, RAMUS, START, testBugsConf, testConfig } from './bug-sync-fixture.ts';

const SECRET = 's'.repeat(40);

const secretsWith = (env: Record<string, string>) => {
  const selected: string[][] = [];
  const select = async (names: readonly string[]): Promise<SecretsSelection> => {
    selected.push([...names]);
    return { env: Object.fromEntries(names.filter((name) => name in env).map((name) => [name, env[name]!])), files: [] };
  };
  return { selected, select };
};

const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

const configError = (field: string) => (error: unknown): boolean => error instanceof BugSyncConfigError && error.field === field;

test('the bugs configuration is read from the conf shape without defaults', () => {
  const config = loadBugSyncConfig(testBugsConf());

  assert.deepEqual(config, testConfig());
  const production = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8')).bugs;
  const loaded = loadBugSyncConfig(production);
  assert.equal(loaded.origin, production.origin);
  assert.equal(loaded.actor, production.actor);
  assert.equal(loaded.sections.length, production.sections.length);
  assert.equal(loaded.tokenLifetimeSeconds, production.tokenLifetimeSeconds);
});

test('invalid or missing bugs configuration values are rejected by field', () => {
  const without = (field: string) => {
    const raw = testBugsConf();
    delete raw[field];
    return raw;
  };
  for (const field of ['origin', 'actor', 'tokenLifetimeSeconds', 'pollIntervalMs', 'pageLimit', 'requestTimeoutMs', 'retry', 'sections']) {
    assert.throws(() => loadBugSyncConfig(without(field)), configError(field), field);
  }
  assert.throws(() => loadBugSyncConfig({ ...testBugsConf(), tokenLifetimeSeconds: 901 }), configError('tokenLifetimeSeconds'));
  assert.throws(() => loadBugSyncConfig({ ...testBugsConf(), pageLimit: 0 }), configError('pageLimit'));
  assert.throws(() => loadBugSyncConfig({ ...testBugsConf(), pageLimit: 51 }), configError('pageLimit'));
  const duplicate = testBugsConf();
  duplicate.sections = [...(duplicate.sections as unknown[]), (duplicate.sections as unknown[])[0]];
  assert.throws(() => loadBugSyncConfig(duplicate), configError('sections'));
});

test('sections come from conf with distinct ids and canonical projects', () => {
  const config = testConfig();
  const ids = config.sections.map((section) => bugSectionId(section));

  assert.equal(new Set(ids).size, ids.length);
  const etchly = describeBugSection(config, config.sections[0]!, 'fp');
  assert.equal(etchly.project, 'etchly');
  assert.equal(etchly.env, 'prod');
  assert.equal(etchly.stand, 'prod');
  assert.equal(etchly.canonicalProject, 'projects/etchly');
  assert.equal(etchly.origin, config.origin);
  assert.equal(etchly.actor, config.actor);
  assert.equal(etchly.claimsFingerprint, 'fp');
  assert.equal(etchly.sectionId, bugSectionId(config.sections[0]!));
  assert.notEqual(etchly.sectionId, bugSectionId(config.sections[1]!));
});

test('write claims are an HS256 v2 service token signed with the section secret from conf', async () => {
  const clock = new ManualClock();
  const config = testConfig();
  const secrets = secretsWith({ DASH_BUGS_PROD_ETCHLY: SECRET });
  const issuer = createClaimsIssuer({ secrets, config, clock });

  const issued = await issuer.issue(ETCHLY, 'write');

  assert.deepEqual(secrets.selected, [['DASH_BUGS_PROD_ETCHLY']]);
  const [header, payload, signature] = issued.token.split('.');
  assert.equal(decode(header!).alg, 'HS256');
  const key = createHash('sha256').update(`dashboard-bugs:${SECRET}`).digest();
  assert.equal(createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url'), signature);
  const claims = decode(payload!);
  const iat = Math.floor(Date.parse(START) / 1000);
  assert.equal(claims.iss, config.origin);
  assert.equal(claims.aud, 'dashboard-bugs');
  assert.equal(claims.purpose, 'bugs-api');
  assert.equal(claims.contract_version, 2);
  assert.equal(claims.project, 'etchly');
  assert.equal(claims.env, 'prod');
  assert.equal(claims.actor, ACTOR);
  assert.equal(claims.owner, ACTOR);
  assert.equal(claims.level, 'agent');
  assert.equal(claims.scope, 'write');
  assert.deepEqual([...(claims.grants as string[])].sort(), ['bugs:agent', 'bugs:read', 'bugs:write']);
  assert.equal(claims.iat, iat);
  assert.equal(claims.exp, iat + config.tokenLifetimeSeconds);
  assert.equal(issued.expiresAt, new Date((iat + config.tokenLifetimeSeconds) * 1000).toISOString());
  assert.equal(issued.fingerprint, issuer.fingerprint(ETCHLY, 'write'));
});

test('read claims carry only read grants and fingerprints exclude the secret', async () => {
  const clock = new ManualClock();
  const config = testConfig();
  const first = createClaimsIssuer({ secrets: secretsWith({ DASH_BUGS_PROD_ETCHLY: SECRET }), config, clock });
  const rotated = createClaimsIssuer({ secrets: secretsWith({ DASH_BUGS_PROD_ETCHLY: 'r'.repeat(40) }), config, clock });

  const read = await first.issue(ETCHLY, 'read');
  const claims = decode(read.token.split('.')[1]!);

  assert.equal(claims.scope, 'read');
  assert.deepEqual([...(claims.grants as string[])].sort(), ['bugs:agent', 'bugs:read']);
  assert.equal(first.fingerprint(ETCHLY, 'read'), rotated.fingerprint(ETCHLY, 'read'));
  assert.notEqual(first.fingerprint(ETCHLY, 'read'), first.fingerprint(ETCHLY, 'write'));
  assert.notEqual(first.fingerprint(ETCHLY, 'write'), first.fingerprint(RAMUS, 'write'));
  assert.ok(!first.fingerprint(ETCHLY, 'write').includes(SECRET));
  const otherActor: BugSyncConfig = { ...config, actor: 'raf:other' };
  const other = createClaimsIssuer({ secrets: secretsWith({ DASH_BUGS_PROD_ETCHLY: SECRET }), config: otherActor, clock });
  assert.notEqual(other.fingerprint({ ...ETCHLY, actor: 'raf:other' }, 'write'), first.fingerprint(ETCHLY, 'write'));
});

test('a missing or short section secret is a section error without a fallback key', async () => {
  const clock = new ManualClock();
  const config = testConfig();
  const missing = createClaimsIssuer({ secrets: secretsWith({ DASH_BUGS_PROD_RAMUS_CLOUD: SECRET }), config, clock });
  const short = createClaimsIssuer({ secrets: secretsWith({ DASH_BUGS_PROD_ETCHLY: 'short' }), config, clock });

  await assert.rejects(missing.issue(ETCHLY, 'read'), (error: unknown) => {
    assert.ok(error instanceof ClaimsError);
    assert.equal(error.code, 'secret-missing');
    assert.equal(error.sectionId, ETCHLY.sectionId);
    return true;
  });
  await assert.rejects(short.issue(ETCHLY, 'read'), (error: unknown) => {
    assert.ok(error instanceof ClaimsError);
    assert.equal(error.code, 'secret-invalid');
    assert.ok(!error.message.includes('short'));
    return true;
  });
  const ok = await missing.issue(RAMUS, 'read');
  assert.equal(decode(ok.token.split('.')[1]!).project, 'ramus-cloud');
});

test('retry delay grows from conf, is capped, and a larger retry-after wins', () => {
  const retry = testConfig().retry;

  assert.equal(nextAttemptDelayMs(retry, 1, null), 1000);
  assert.equal(nextAttemptDelayMs(retry, 2, null), 2000);
  assert.equal(nextAttemptDelayMs(retry, 3, null), 4000);
  assert.equal(nextAttemptDelayMs(retry, 10, null), retry.maxDelayMs);
  assert.equal(nextAttemptDelayMs(retry, 1, 5000), 5000);
  assert.equal(nextAttemptDelayMs(retry, 1, 100), 1000);
});

test('conflict notice keys are stable per operation and kind', () => {
  assert.equal(conflictNoticeKey('op-1', 'bug-deleted'), 'bug-conflict:op-1:bug-deleted');
  assert.notEqual(conflictNoticeKey('op-1', 'bug-deleted'), conflictNoticeKey('op-1', 'bug-missing'));
});
