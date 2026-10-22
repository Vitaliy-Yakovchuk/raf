import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';

export type SourceComment = {
  filePath: string;
  start: number;
  end: number;
  line: number;
  column: number;
};

export function findSourceComments(filePath: string, source: string): SourceComment[] {
  const extension = extname(filePath).toLowerCase();
  const scriptKind = extension === '.json' || extension === '.jsonc' ? ts.ScriptKind.JSON
    : extension === '.tsx' ? ts.ScriptKind.TSX
    : extension === '.jsx' ? ts.ScriptKind.JSX
    : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const tokens: Array<{ start: number; end: number }> = [];
  function visit(node: ts.Node): void {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.kind < ts.SyntaxKind.FirstNode) {
      tokens.push({ start: node.getStart(tree, false), end: node.end });
      return;
    }
    for (const child of node.getChildren(tree)) visit(child);
  }
  visit(tree);
  tokens.sort((a, b) => a.start - b.start);
  const comments: SourceComment[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  function scanGap(start: number, end: number): void {
    scanner.setTextPos(start);
    while (scanner.getTextPos() < end) {
      const kind = scanner.scan();
      if (kind === ts.SyntaxKind.EndOfFileToken) break;
      if (kind !== ts.SyntaxKind.SingleLineCommentTrivia && kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
      const position = scanner.getTokenPos();
      const location = tree.getLineAndCharacterOfPosition(position);
      comments.push({ filePath, start: position, end: scanner.getTextPos(), line: location.line + 1, column: location.character + 1 });
    }
  }
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) scanGap(cursor, token.start);
    cursor = Math.max(cursor, token.end);
  }
  scanGap(cursor, source.length);
  return comments;
}

export async function checkRepositoryComments(root: string): Promise<SourceComment[]> {
  const extensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc']);
  const excluded = new Set(['node_modules', 'dist', '.git', 'vendor', 'generated']);
  const roots = new Set(['src', 'bin', 'scripts', 'test']);
  const comments: SourceComment[] = [];
  async function walk(directory: string, topLevel: boolean): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || excluded.has(entry.name) || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!topLevel || roots.has(entry.name)) await walk(path, false);
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        if (/(?:^|\.)(?:example|sample|template)(?:\.|$)/i.test(entry.name)) continue;
        comments.push(...findSourceComments(relative(root, path), await readFile(path, 'utf8')));
      }
    }
  }
  await walk(root, true);
  return comments;
}
