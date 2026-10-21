import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRepositoryComments, findSourceComments } from '../src/comment-policy.ts';

test('QA excludes outside symlink files, directories and cycles without rewriting owned files', { timeout: 1200 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'raf-comments-qa-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repository');
  const outside = join(temporary, 'outside');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'external.ts'), '// outside\n');
  await symlink(join(outside, 'external.ts'), join(root, 'src', 'linked.ts'));
  await symlink(outside, join(root, 'src', 'linked-directory'));
  await symlink(root, join(root, 'src', 'cycle'));
  const source = 'export const value = 1;\n  /* owned */\n';
  const owned = join(root, 'src', 'owned.ts');
  await writeFile(owned, source);
  assert.deepEqual((await checkRepositoryComments(root)).map(({ filePath, line, column }) => ({ filePath, line, column })), [
    { filePath: 'src/owned.ts', line: 2, column: 3 },
  ]);
  assert.equal(await readFile(owned, 'utf8'), source);
});

test('QA literal text across JSX TSX stays data but nested substitutions expose comments', { timeout: 1200 }, () => {
  const source = [
    'const endpoint = "https://example.test/a//b";',
    'const text = String.raw`/* visible */ // visible ${`https://${"example.test"}`}`;',
    'const pattern = /[/*]+/g;',
    'export const view = <div title="https://example.test"> // text /* text */ <span>{text}</span></div>;',
  ].join('\n');
  for (const extension of ['tsx', 'jsx']) assert.deepEqual(findSourceComments(`src/view.${extension}`, source), []);
  const expression = 'const text = `outer ${`inner ${\n  /* actual */ 1}`} // text`;';
  assert.deepEqual(findSourceComments('src/nested.ts', expression).map(({ line, column, start, end }) => ({ line, column, text: expression.slice(start, end) })), [
    { line: 2, column: 3, text: '/* actual */' },
  ]);
});
