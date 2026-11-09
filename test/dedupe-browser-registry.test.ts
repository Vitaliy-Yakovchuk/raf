import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateProfileInventories } from '../src/test-run-integration-profiles.ts';

const configuration = JSON.parse(readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8'));
const etchly = configuration.projects.etchly;
const browserFiles = [
  'app/src/answer-code-scroll-agent-tests/fb6d082c.test.ts',
  'app/src/browser-reader-1580-agent-tests/reader.test.ts',
];
const browserGroup = 'dedupe-product-code/etchly-d4-browser-integration';

test('D4 browser files belong exclusively to the registered integration preset', () => {
  const preset = etchly.groups[browserGroup];
  assert.ok(preset, 'D4 browser integration preset must be registered');
  assert.deepEqual(preset.files, browserFiles);
  const profile = etchly.profiles[preset.profileId];
  assert.equal(profile.testKind, 'integration');
  assert.deepEqual(profile.integrationFiles, browserFiles);
  assert.equal(profile.unitFiles, undefined);
  for (const file of browserFiles) {
    const memberships = Object.entries(etchly.profiles).filter(([, candidate]: [string, any]) =>
      [...(candidate.unitFiles ?? []), ...(candidate.integrationFiles ?? [])].includes(file));
    assert.deepEqual(memberships.map(([id]) => id), [preset.profileId]);
  }
  const validated = validateProfileInventories({ projects: { etchly: {
    profiles: { 'vitest-app': etchly.profiles['vitest-app'], [preset.profileId]: profile },
    groups: { [browserGroup]: preset },
  } } }, {});
  assert.deepEqual(validated.projects.etchly.groups[browserGroup], preset);
});

test('D4 browser migration preserves the two ET unit groups', () => {
  assert.deepEqual(etchly.groups['dedupe-product-code/etchly-vitest-worker'], {
    profileId: 'vitest-worker', files: ['worker/src/platform/sha256.test.ts'],
  });
  assert.deepEqual(etchly.groups['dedupe-product-code/etchly-vitest-app'], {
    profileId: 'vitest-app', files: ['app/src/markdown/code-scroll.test.ts', 'app/src/markdown/code-scroll-lifecycle.test.ts'],
  });
});
