import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import { createBugHandlers, type BugCommandPorts } from '../src/bug-cli.ts';
import { BugStoreError, formatCanonicalBugKey, parseCanonicalBugKey } from '../src/bug-store.ts';
import { canonical, createBugHarness, detailOf, ETCHLY, START } from './bug-sync-fixture.ts';

const confRoot = new URL('../../conf/', import.meta.url);
const constants = JSON.parse(readFileSync(new URL('raf-constants.json', confRoot), 'utf8'));
const models = JSON.parse(readFileSync(new URL('models.json', confRoot), 'utf8'));
const projects = JSON.parse(readFileSync(new URL('projects.json', confRoot), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects);

const COURSE_RAW_ID = 'istoriia-mystetstva/1/0';
const COURSE_KEY = canonical(ETCHLY, COURSE_RAW_ID);

const storedRawIds = [
  COURSE_RAW_ID,
  'python-spysky-slovnyky-ta-funktsii/1/0',
  '03-edge-computing-and-product-stack/1/4',
  '344',
  '0b7fef13-6d8f-42b2-8d58-d2dbcc64f095',
  'id with space',
  'hash#inside',
  'back\\slash',
  'line\nbreak',
  'tab\there',
  'quote"id',
];

const storeError = (code: string) => (error: unknown): boolean => error instanceof BugStoreError && error.code === code;

test('bugs.sqlite raw ids round-trip through the canonical key, including slashes', (t) => {
  const h = createBugHarness(t);
  h.repo.applyPullBatch({
    sectionId: ETCHLY.sectionId,
    details: storedRawIds.map((rawId) => detailOf(ETCHLY, rawId)),
    deleted: [],
    missing: [],
    position: {},
    at: START,
  });
  const stored = (h.repo.database.prepare('SELECT raw_id FROM bugs ORDER BY raw_id').all() as { raw_id: string }[]).map((row) => row.raw_id);
  assert.deepEqual([...stored].sort(), [...storedRawIds].sort());
  for (const rawId of stored) {
    const key = `${ETCHLY.canonicalProject}/bug#${rawId}`;
    assert.deepEqual(parseCanonicalBugKey(key), { canonicalProject: ETCHLY.canonicalProject, rawId });
    assert.equal(formatCanonicalBugKey({ canonicalProject: ETCHLY.canonicalProject, rawId }), key);
    const bug = h.repo.findBug(key);
    assert.equal(bug.key, key);
    assert.equal(bug.serverKey.rawId, rawId);
  }
  for (const bad of ['etchly#344', 'projects/etchly/bug#', 'projects/etchly/344', '']) {
    assert.throws(() => parseCanonicalBugKey(bad), storeError('invalid-bug-key'), bad);
  }
});

test('bug show and bug comment add accept a stored course raw id that contains slashes', async (t) => {
  const h = createBugHarness(t);
  h.server.seedBug(ETCHLY, { rawId: COURSE_RAW_ID });
  const pulled = await h.syncer.pullSection(ETCHLY.sectionId);
  assert.equal(pulled.errorCode, null);
  const row = h.repo.database.prepare('SELECT raw_id FROM bugs WHERE raw_id = ?').get(COURSE_RAW_ID) as { raw_id: string } | undefined;
  assert.equal(row?.raw_id, COURSE_RAW_ID);

  const ports: BugCommandPorts = {
    loadConfig: () => h.config,
    openRepository: () => ({ ...h.repo, close() {} }),
    claims: async () => h.claims,
    openCache: () => { throw new Error('attachment cache is not used by show or comment add'); },
    writer: () => h.writer,
    readText: async () => new TextEncoder().encode('Коментар до кроку курсу'),
    now: () => h.clock.now(),
  };
  const handlers = createBugHandlers(ports);
  const shown = await execute(['bug', 'show', '--bug', COURSE_KEY], catalog, handlers);
  assert.equal(shown.exitCode, 0, shown.stderr);
  const bug = JSON.parse(shown.stdout);
  assert.equal(bug.source, 'local');
  assert.equal(bug.bug.key, COURSE_KEY);
  assert.equal(bug.bug.serverKey.rawId, COURSE_RAW_ID);

  const added = await execute(['bug', 'comment', 'add', '--bug', COURSE_KEY, '--text-file', 'comment.txt'], catalog, handlers);
  assert.equal(added.exitCode, 0, added.stderr);
  const comment = JSON.parse(added.stdout);
  assert.equal(comment.source, 'dash');
  assert.equal(comment.bugKey, COURSE_KEY);
  assert.equal(comment.bug.serverKey.rawId, COURSE_RAW_ID);
  assert.equal(comment.bug.comments.some((item: { text: string }) => item.text === 'Коментар до кроку курсу'), true);
});
