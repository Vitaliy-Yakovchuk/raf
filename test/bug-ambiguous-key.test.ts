import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import { createBugHandlers, type BugCommandPorts } from '../src/bug-cli.ts';
import { canonical, createBugHarness, ETCHLY, ETCHLY_DEV } from './bug-sync-fixture.ts';

const confRoot = new URL('../../conf/', import.meta.url);
const constants = JSON.parse(readFileSync(new URL('raf-constants.json', confRoot), 'utf8'));
const models = JSON.parse(readFileSync(new URL('models.json', confRoot), 'utf8'));
const projects = JSON.parse(readFileSync(new URL('projects.json', confRoot), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects);

test('list keys select only their own bug for show, comment and status when owners share a raw id', async (t) => {
  const h = createBugHarness(t, { config: { pageLimit: 20 } });
  await h.syncer.runCycle();
  const rawId = 'osnovy-python/1/1';
  const records = [
    h.server.seedBug(ETCHLY, { rawId, owner: 'owner/one#% українська' }),
    h.server.seedBug(ETCHLY, { rawId, owner: 'owner-two' }),
    h.server.seedBug(ETCHLY, { rawId: '344' }),
  ];
  h.notifier.failNext(10);
  assert.equal((await h.syncer.pullSection(ETCHLY.sectionId)).errorCode, null);
  const ports: BugCommandPorts = {
    loadConfig: () => h.config,
    openRepository: () => ({ ...h.repo, close() {} }),
    claims: async () => h.claims,
    openCache: () => { throw new Error('cache is not used'); },
    writer: () => h.writer,
    readText: async (file) => Buffer.from(`comment for ${file}`),
    now: () => h.clock.now(),
  };
  const handlers = createBugHandlers(ports);
  const run = async (argv: string[]) => {
    const result = await execute(argv, catalog, handlers);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  const page = await run(['bug', 'list', '--project', ETCHLY.canonicalProject]);
  const keys = page.bugs.map((bug: { key: string }) => bug.key) as string[];
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3, 'bug list must expose a different usable key for each owner');
  assert.ok(keys.includes(canonical(ETCHLY, '344')));
  assert.deepEqual(new Set(h.repo.pendingNotices().map((notice) => notice.bugKey)), new Set(keys));

  const selectedRecords = [];
  for (const [index, key] of keys.entries()) {
    const before = records.map((record) => structuredClone(h.server.state(record)));
    const shown = await run(['bug', 'show', '--bug', key]);
    const target = records.findIndex((record) => JSON.stringify(record) === JSON.stringify(shown.bug.serverKey));
    assert.notEqual(target, -1);
    selectedRecords.push(shown.bug.serverKey);
    assert.equal(shown.bug.key, key);
    const comment = await run(['bug', 'comment', 'add', '--bug', key, '--text-file', String(index)]);
    assert.deepEqual(comment.bug.serverKey, records[target]);
    assert.equal(comment.bug.comments.at(-1).text, `comment for ${index}`);
    const status = await run(['bug', 'status', 'set', '--bug', key, '--status', 'closed']);
    assert.deepEqual(status.bug.serverKey, records[target]);
    assert.equal(status.bug.status, 'closed');
    assert.equal(h.repo.findBug(key).status, 'closed');
    assert.equal(h.server.state(records[target]!).status, 'closed');
    for (const [other, record] of records.entries()) {
      if (other !== target) assert.deepEqual(h.server.state(record), before[other], 'other owners must remain untouched');
    }
  }
  assert.deepEqual(new Set(selectedRecords.map((record) => JSON.stringify(record))), new Set(records.map((record) => JSON.stringify(record))));
  h.reopen();
  assert.deepEqual(h.repo.listBugs({ limit: 20 }).bugs.map((bug) => bug.key), keys);
  for (const [index, key] of keys.entries()) assert.deepEqual(h.repo.findBug(key).serverKey, selectedRecords[index]);
});

test('colliding keys also distinguish environments and sources across filtered pages', async (t) => {
  const h = createBugHarness(t, { sections: [ETCHLY, ETCHLY_DEV] });
  const rawId = 'hash#inside/with space';
  const records = [
    h.server.seedBug(ETCHLY, { rawId, source: 'qa' }),
    h.server.seedBug(ETCHLY, { rawId, source: 'course' }),
    h.server.seedBug(ETCHLY_DEV, { rawId, source: 'qa' }),
  ];
  for (const section of [ETCHLY, ETCHLY_DEV]) assert.equal((await h.syncer.pullSection(section.sectionId)).errorCode, null);
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page = h.repo.listBugs({ canonicalProject: ETCHLY.canonicalProject, status: 'open', limit: 1, cursor });
    for (const bug of page.bugs) {
      keys.push(bug.key);
      assert.deepEqual(h.repo.findBug(bug.key).serverKey, records[keys.length - 1]);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(new Set(keys).size, 3);
});
