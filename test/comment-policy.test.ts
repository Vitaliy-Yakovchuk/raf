import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkRepositoryComments, findSourceComments } from '../src/comment-policy.ts';

test('source comments report exact exclusive ranges and one-based locations', () => {
  const source = 'const answer = 42; // reason\r\n/* first\nsecond */\nexport { answer };';
  const first = source.indexOf('//');
  const second = source.indexOf('/*');
  assert.deepEqual(findSourceComments('src/answer.ts', source), [
    { filePath: 'src/answer.ts', start: first, end: source.indexOf('\r'), line: 1, column: first + 1 },
    { filePath: 'src/answer.ts', start: second, end: source.indexOf('*/') + 2, line: 2, column: 1 },
  ]);
});

test('URLs, strings, regular expressions and template text are data', () => {
  const source = [
    'const url = "https://example.test/path";',
    "const block = '/* literal */';",
    'const escaped = "quoted \\" // literal";',
    'const pattern = /https?:\\/\\/[^/]+\\/\\*value\\*\\//g;',
    'const template = `// literal /* literal */ ${"https://example.test"}`;',
    'if (url) /\\/\\//.test(url);',
    'const ratio = 12 / 3 / 2;',
  ].join('\n');
  assert.deepEqual(findSourceComments('src/literals.ts', source), []);
});

test('template expressions and nested templates still expose comments exactly once', () => {
  const source = 'const value = `/* text */ ${1 /* actual */ + `nested ${2 // nested\n}`} end`;';
  const comments = findSourceComments('src/template.ts', source);
  assert.deepEqual(comments.map(({ start, end }) => source.slice(start, end)), ['/* actual */', '// nested']);
  assert.deepEqual(comments.map(({ line }) => line), [1, 1]);
});

test('JSX text is data while JSX expression comments violate the policy', () => {
  const source = 'export const element = <div>https://example.test /* text */{/* actual */}<span title="// data" /></div>;';
  const comments = findSourceComments('src/view.tsx', source);
  assert.deepEqual(comments.map(({ start, end }) => source.slice(start, end)), ['/* actual */']);
});

test('JSON config detects comments without matching URLs inside values', () => {
  const source = '{"url":"https://example.test", /* setting */ "enabled":true}\n// end';
  const comments = findSourceComments('tsconfig.json', source);
  assert.deepEqual(comments.map(({ start, end }) => source.slice(start, end)), ['/* setting */', '// end']);
});

test('hashbang is executable syntax and a trailing comment is reported', () => {
  const source = '#!/usr/bin/env node\nexport {}; // trailing';
  assert.deepEqual(findSourceComments('bin/tool.mjs', source), [
    { filePath: 'bin/tool.mjs', start: source.indexOf('//'), end: source.length, line: 2, column: 12 },
  ]);
});

test('repository check covers owned source roots and root configuration files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'raf-comment-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [
    'src/a.ts', 'src/b.tsx', 'src/c.js', 'src/d.jsx',
    'bin/tool.mjs', 'scripts/build.cjs', 'test/a.mts', 'test/b.cts',
    'src/nested/settings.jsonc', 'package.json', 'tsconfig.jsonc', 'build.config.ts',
  ];
  for (const filePath of paths) {
    await mkdir(dirname(join(root, filePath)), { recursive: true });
    await writeFile(join(root, filePath), filePath.endsWith('.json') || filePath.endsWith('.jsonc') ? '{} // forbidden\n' : 'export {}; // forbidden\n');
  }
  const comments = await checkRepositoryComments(root);
  assert.deepEqual(comments.map(({ filePath }) => filePath).sort(), [...paths].sort());
  assert.ok(comments.every(({ line }) => line === 1));
  assert.deepEqual(await checkRepositoryComments(root), comments);
});

test('repository check excludes generated dependencies, documentation and human fill-in templates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'raf-comment-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [
    'dist/generated.js', 'node_modules/pkg/index.js', '.git/config.json',
    'src/vendor/copied.ts', 'src/generated/output.ts', 'src/node_modules/pkg/index.js',
    'docs/example.ts', 'README.md', '.env.example', 'src/.env.example',
  ];
  for (const filePath of paths) {
    await mkdir(dirname(join(root, filePath)), { recursive: true });
    await writeFile(join(root, filePath), '// data outside owned code\n');
  }
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin/raf.ts'), '#!/usr/bin/env node\nexport {};\n');
  assert.deepEqual(await checkRepositoryComments(root), []);
});
