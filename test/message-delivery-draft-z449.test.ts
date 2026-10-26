import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import fs, { promises as files } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireHotfixReader, retainHotfixGeneration } from '../src/hotfix-activation.ts';
import { mainRoute } from '../src/hotfix-host.ts';
import { createHotfixRuntimeInventory } from '../src/hotfix-runtime-inventory.ts';
import type { HotfixHost } from '../src/hotfix-worktree.ts';

const settings = {
  runner: 'claude', version: 'fixture', navigation: [], markers: { ready: ['agent ready'], permission_required: ['Permission required'] },
  native: { composer: '^(?:\\$|❯)(?:\\s|$)', pendingPaste: { pattern: '^\\[Pasted text #\\d+ \\+(\\d+) lines\\]$', unit: 'newlines' }, working: '^Working', identity: { source: 'session_start' } },
  timeouts: { transitionMs: 20, pollMs: 5 },
} as unknown as ProtocolSettings;

function harness(frames: string[], waitForComposer = true) {
  let clock = 0;
  let checks = 0;
  let captures = 0;
  const pasted: string[] = [];
  let enters = 0;
  const ports: MessageDeliveryPorts & { waitForComposer: boolean } = {
    settings, waitForComposer,
    verify: async () => { checks++; return true; },
    capture: async () => { captures++; return frames.length > 1 ? frames.shift()! : frames[0]; },
    paste: async text => { pasted.push(text); },
    enter: async () => { enters++; },
    now: () => clock,
    delay: async ms => { clock += ms; },
  };
  return { ports, pasted, enters: () => enters, captures: () => captures, checks: () => checks, time: () => clock };
}

const frame = (input: string, history = 'agent ready') => `${history}\n❯ ${input}\nfooter`;

test('Z449 main waits for an existing draft without submitting or replacing it, beyond delivery verification budget', async () => {
  const draft = frame('owner unfinished draft');
  const h = harness([...Array(7).fill(draft), frame(''), frame(''), frame('', 'agent ready\n[sender] hello accepted')]);
  h.ports.paste = async text => {
    assert.ok(h.captures() >= 8, 'Do not paste before the owner releases their draft');
    assert.equal(h.enters(), 0, 'Do not submit the owner draft');
    h.pasted.push(text);
  };
  assert.deepEqual(await deliverCheckedMessage(h.ports, '[sender] hello'), { accepted: true });
  assert.deepEqual(h.pasted, ['[sender] hello']);
  assert.ok(h.time() > settings.timeouts.transitionMs);
});

test('Z449 native acceptance retries the complete wrapped pending message, including multiline input', async () => {
  for (const message of ['[sender] message with a long wrapped line', '[sender] first line\nsecond line']) {
    const wrapped = message.replace('with a long wrapped line', 'with a\n  long wrapped line').replace('\nsecond', '\n  second');
    const pending = frame(wrapped);
    const h = harness([frame(''), pending, pending, pending, frame('', 'agent ready\naccepted message')]);
    assert.deepEqual(await deliverCheckedMessage(h.ports, message), { accepted: true }, message);
    assert.deepEqual(h.pasted, [message]);
    assert.equal(h.enters(), 1);
  }
});

test('Z449 queued main delivery aborts on identity loss without touching the draft', async () => {
  const h = harness([frame('owner unfinished draft')]);
  h.ports.verify = async () => h.captures() < 2;
  assert.equal((await deliverCheckedMessage(h.ports, 'hello')).accepted, false);
  assert.ok(h.captures() >= 2, 'Wait while the verified recipient owns its draft');
  assert.deepEqual(h.pasted, []);
  assert.equal(h.enters(), 0);
});

test('Z449 a queued draft does not authorize shell or permission input', async () => {
  for (const screen of ['$ owner draft', 'Permission required\nagent ready\n❯ owner draft']) {
    const h = harness([screen]);
    assert.equal((await deliverCheckedMessage(h.ports, '$(touch forbidden)')).accepted, false);
    assert.deepEqual(h.pasted, []);
    assert.equal(h.enters(), 0);
  }
});

test('Z449 receipt does not accept or submit a wrapped foreign draft after insertion', async () => {
  const h = harness([frame(''), frame('[sender] first line\n  foreign draft')]);
  assert.equal((await deliverCheckedMessage(h.ports, '[sender] first line\nsecond line')).accepted, false);
  assert.equal(h.enters(), 0);
});

test('Z449 existing non-main callers retain refusal before inserting into a draft', async () => {
  const h = harness([frame('owner draft')], false);
  assert.equal((await deliverCheckedMessage(h.ports, 'hello')).accepted, false);
  assert.deepEqual(h.pasted, []);
  assert.equal(h.enters(), 0);
});

test('Z449 main waits for a competing delivery lease and releases it only after acceptance', async () => {
  const h = harness([frame(''), frame('', 'agent ready\naccepted hello')]);
  let attempts = 0;
  let releases = 0;
  Object.assign(h.ports, { acquire: async () => {
    assert.deepEqual(h.pasted, [], 'No message may be inserted before owning delivery');
    return ++attempts < 7 ? null : { release: async () => { releases++; } };
  } });
  h.ports.paste = async text => {
    assert.equal(attempts, 7);
    assert.equal(releases, 0, 'Keep ownership through verification');
    h.pasted.push(text);
  };
  assert.deepEqual(await deliverCheckedMessage(h.ports, 'hello'), { accepted: true });
  assert.equal(releases, 1);
  assert.ok(h.time() > settings.timeouts.transitionMs);
});

test('Z449 queued lock acquisition rechecks identity and does not paste after recipient replacement', async () => {
  const h = harness([frame('')]);
  let attempts = 0;
  Object.assign(h.ports, { acquire: async () => { attempts++; return null; } });
  h.ports.verify = async () => attempts < 3;
  assert.equal((await deliverCheckedMessage(h.ports, 'hello')).accepted, false);
  assert.equal(attempts, 3);
  assert.deepEqual(h.pasted, []);
  assert.equal(h.enters(), 0);
});

test('Z449 receipt failure and transport exceptions both release the owned delivery lease', async () => {
  for (const exceptional of [false, true]) {
    const h = harness([frame(''), frame('foreign input')]);
    let releases = 0;
    Object.assign(h.ports, { acquire: async () => ({ release: async () => { releases++; } }) });
    if (exceptional) h.ports.paste = async () => { throw new Error('transport unavailable'); };
    if (exceptional) await assert.rejects(deliverCheckedMessage(h.ports, 'hello'), /transport unavailable/);
    else assert.equal((await deliverCheckedMessage(h.ports, 'hello')).accepted, false);
    assert.equal(releases, 1);
  }
});

for (const mode of ['acquire', 'retain'] as const) {
  test(`Z449 ${mode} verifies the pinned generation outside the activation lock`, async t => {
    const root = await files.realpath(await files.mkdtemp(join(tmpdir(), 'z449-')));
    t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await files.rm(root, { recursive: true, force: true }); });
    const main = join(root, 'raf-main');
    const qaHome = join(root, 'home');
    for (const path of [main, qaHome, join(root, 'conf')]) await files.mkdir(path);
    const env = { ...process.env, HOME: qaHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (...args: string[]) => execFileSync('git', ['-C', main, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Z449', '-c', 'user.email=z449@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    await files.writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-main' } } } }));
    await files.writeFile(join(root, 'conf/raf.json'), JSON.stringify({ runnerProtocols: { claude: settings } }));
    const host: HotfixHost = { orchestratorRoot: root, qaHome, environment: env, sandboxExecutable: 'unused-unit-fixture' };
    const route = await mainRoute(host);
    const generation = join(route.control, 'generations/z449/raf-main');
    await files.mkdir(join(generation, 'src'), { recursive: true });
    const entry = join(generation, 'entry.mjs');
    await files.writeFile(entry, 'export const fixture = true;\n');
    const inventory = createHotfixRuntimeInventory(generation, commit, { rootFiles: ['entry.mjs'], scopes: ['src'], excludedTrees: [], entrypoints: ['entry.mjs'] });
    await files.writeFile(join(route.control, 'registry.json'), JSON.stringify({ current: generation, generations: { [generation]: { root: generation, commit, fingerprint: 'fixture', files: inventory.files, runtimeInventory: inventory } } }));
    const read = fs.readFileSync.bind(fs);
    let verified = false;
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === entry) {
        assert.equal(fs.existsSync(join(route.control, 'activation.lock')), false, 'Full generation scans must not serialize unrelated messages behind activation.lock');
        const readers = fs.readdirSync(join(route.control, 'readers'));
        assert.equal(readers.length, 1, 'Pin generation before releasing the activation lock');
        assert.equal(JSON.parse(read(join(route.control, 'readers', readers[0]), 'utf8')).root, generation);
        verified = true;
      }
      return read(...args);
    });
    syncBuiltinESMExports();
    const acquire = () => mode === 'acquire' ? acquireHotfixReader(host, 'cli') : retainHotfixGeneration(host, generation);
    let lease: Awaited<ReturnType<typeof acquire>>;
    await assert.doesNotReject(async () => { lease = await acquire(); });
    assert.equal(verified, true, 'Preserve full immutable inventory validation');
    assert.ok(lease!);
    await lease!.release();
    assert.deepEqual(await files.readdir(join(route.control, 'readers')), []);
    await files.writeFile(entry, 'export const fixture = false;\n');
    await assert.rejects(acquire(), /runtime inputs changed|fingerprint|content/);
    assert.deepEqual(await files.readdir(join(route.control, 'readers')), [], 'Failed inventory validation must release its generation pin');
    assert.equal(fs.existsSync(join(route.control, 'activation.lock')), false);
  });
}
