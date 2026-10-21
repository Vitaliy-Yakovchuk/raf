import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { loadFlowPolicy, type FlowPolicy } from '../src/flow-policy.ts';

function customPolicy(): FlowPolicy {
  return {
    version: 1,
    unitTests: { timeoutMs: 900001, optimizeAfterTimeouts: 2, maxGroupTimeouts: 4 },
    resources: {
      normal: { maxNormalizedLoad: 1.1, minRamFraction: 0.3, minRamBytes: 3000000000, minDiskFraction: 0.2, minDiskBytes: 12000000000 },
      hotfix: { maxNormalizedLoad: 1.8, minRamFraction: 0.15, minRamBytes: 1500000000, minDiskFraction: 0.08, minDiskBytes: 6000000000 },
    },
    retention: { closedRemindersMs: 180000001, finishedSessionsMs: 90000001 },
    documents: { architectureMaxLines: 240, statusMaxLines: 70, minArchitectureDiagrams: 2 },
  };
}

function fixture(t: TestContext, content?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-flow-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'flow.json');
  if (content !== undefined) writeFileSync(path, JSON.stringify(content));
  return path;
}

function changed(path: string, value: unknown, remove = false) {
  const policy = structuredClone(customPolicy()) as unknown as Record<string, unknown>;
  const segments = path.split('.');
  let owner = policy;
  for (const segment of segments.slice(0, -1)) owner = owner[segment] as Record<string, unknown>;
  const key = segments.at(-1)!;
  if (remove) delete owner[key];
  else owner[key] = value;
  return policy;
}

function rejectsConfig(path: string) {
  assert.throws(() => loadFlowPolicy(path), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /flow|config|policy|version|unitTests|resources|retention|documents/i);
    assert.doesNotMatch(error.message, /NotImplemented/);
    return true;
  });
}

const numericFields = [
  'unitTests.timeoutMs', 'unitTests.optimizeAfterTimeouts', 'unitTests.maxGroupTimeouts',
  'resources.normal.maxNormalizedLoad', 'resources.normal.minRamFraction', 'resources.normal.minRamBytes',
  'resources.normal.minDiskFraction', 'resources.normal.minDiskBytes',
  'resources.hotfix.maxNormalizedLoad', 'resources.hotfix.minRamFraction', 'resources.hotfix.minRamBytes',
  'resources.hotfix.minDiskFraction', 'resources.hotfix.minDiskBytes',
  'retention.closedRemindersMs', 'retention.finishedSessionsMs',
  'documents.architectureMaxLines', 'documents.statusMaxLines', 'documents.minArchitectureDiagrams',
];

const integerFields = numericFields.filter(field => !field.startsWith('resources.'));
const fractionFields = numericFields.filter(field => field.endsWith('Fraction'));

test('default path loads the canonical repository configuration independent of working directory', t => {
  const canonical = fileURLToPath(new URL('../../conf/flow.json', import.meta.url));
  const expected = JSON.parse(readFileSync(canonical, 'utf8'));
  const original = process.cwd();
  const foreignDirectory = mkdtempSync(join(tmpdir(), 'raf-flow-policy-cwd-'));
  t.after(() => rmSync(foreignDirectory, { recursive: true, force: true }));
  writeFileSync(join(foreignDirectory, 'flow.json'), JSON.stringify(customPolicy()));
  try {
    process.chdir(foreignDirectory);
    assert.deepEqual(loadFlowPolicy(), expected);
  } finally {
    process.chdir(original);
  }
});

test('explicit custom configuration returns all values unchanged', t => {
  const expected = customPolicy();
  assert.deepEqual(loadFlowPolicy(fixture(t, expected)), expected);
});

test('each explicit path is honored without reusing an earlier configuration', t => {
  const first = customPolicy();
  const second = changed('documents.statusMaxLines', 99);
  assert.deepEqual(loadFlowPolicy(fixture(t, first)), first);
  assert.deepEqual(loadFlowPolicy(fixture(t, second)), second);
});

test('missing file fails clearly instead of falling back to canonical values', t => {
  rejectsConfig(fixture(t));
});

for (const malformed of ['', '{', '{"version":1,}', 'not JSON']) {
  test(`malformed JSON ${JSON.stringify(malformed)} fails clearly`, t => {
    const path = fixture(t);
    writeFileSync(path, malformed);
    rejectsConfig(path);
  });
}

for (const root of [null, [], 'policy', 1, true]) {
  test(`invalid root ${JSON.stringify(root)} fails clearly`, t => {
    rejectsConfig(fixture(t, root));
  });
}

for (const version of [0, 2, 1.5, '1', null]) {
  test(`unsupported version ${JSON.stringify(version)} fails clearly`, t => {
    rejectsConfig(fixture(t, changed('version', version)));
  });
}

for (const field of ['version', 'unitTests', 'resources', 'resources.normal', 'resources.hotfix', 'retention', 'documents', ...numericFields]) {
  test(`missing ${field} fails without a field default`, t => {
    rejectsConfig(fixture(t, changed(field, undefined, true)));
  });
}

for (const field of ['unitTests', 'resources', 'resources.normal', 'resources.hotfix', 'retention', 'documents']) {
  for (const invalid of [null, [], 'invalid', 1]) {
    test(`${field} rejects non-object ${JSON.stringify(invalid)}`, t => {
      rejectsConfig(fixture(t, changed(field, invalid)));
    });
  }
}

for (const field of numericFields) {
  for (const invalid of [0, -1, null, '2', true]) {
    test(`${field} rejects non-positive or non-number ${JSON.stringify(invalid)}`, t => {
      rejectsConfig(fixture(t, changed(field, invalid)));
    });
  }
  test(`${field} rejects a JSON number overflowing to infinity`, t => {
    const path = fixture(t);
    const json = JSON.stringify(changed(field, 'NONFINITE_NUMBER')).replace('"NONFINITE_NUMBER"', '1e400');
    writeFileSync(path, json);
    rejectsConfig(path);
  });
}

for (const field of integerFields) {
  test(`${field} rejects fractional counts or milliseconds`, t => {
    rejectsConfig(fixture(t, changed(field, 1.5)));
  });
}

for (const field of fractionFields) {
  test(`${field} rejects a fraction greater than one`, t => {
    rejectsConfig(fixture(t, changed(field, 1.01)));
  });
}

test('fractions equal to one and identical normal and hotfix thresholds are valid', t => {
  const base = customPolicy();
  const thresholds = { ...base.resources.normal, minRamFraction: 1, minDiskFraction: 1 };
  const expected = { ...base, resources: { normal: thresholds, hotfix: { ...thresholds } } };
  assert.deepEqual(loadFlowPolicy(fixture(t, expected)), expected);
});

for (const optimizeAfterTimeouts of [4, 5]) {
  test(`optimization count ${optimizeAfterTimeouts} must precede the group timeout limit`, t => {
    rejectsConfig(fixture(t, changed('unitTests.optimizeAfterTimeouts', optimizeAfterTimeouts)));
  });
}

const stricterHotfixValues: Record<string, number> = {
  maxNormalizedLoad: 1,
  minRamFraction: 0.4,
  minRamBytes: 3000000001,
  minDiskFraction: 0.3,
  minDiskBytes: 12000000001,
};

for (const [field, value] of Object.entries(stricterHotfixValues)) {
  test(`hotfix ${field} cannot be stricter than normal`, t => {
    rejectsConfig(fixture(t, changed(`resources.hotfix.${field}`, value)));
  });
}
