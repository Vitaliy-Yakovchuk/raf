import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { QualityInput } from './test-run-quality.ts';

export function qualityFileError(operation: string, source: string, destination: string | undefined, cause: unknown): Error {
  const failure = cause as NodeJS.ErrnoException;
  const detail = `${failure.code ?? 'UNKNOWN'} errno=${failure.errno ?? 'unavailable'} syscall=${failure.syscall ?? operation}: ${failure.message}`;
  return Object.assign(new Error(`Quality ${operation} input=${source}${destination ? ` destination=${destination}` : ''}: ${detail}`, { cause }), {
    code: failure.code ?? 'QUALITY_UNSUPPORTED', errno: failure.errno, syscall: failure.syscall, path: source, dest: destination,
  });
}

export function qualityFileDigest(path: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) digest.update(chunk.subarray(0, count));
    return digest.digest('hex');
  } catch (cause) { throw qualityFileError('hash', path, undefined, cause); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function generatedWorkspaceOutput(workspace: string, realpath: string): boolean {
  const fromWorkspace = relative(workspace, realpath);
  if (!fromWorkspace || fromWorkspace.startsWith('..') || isAbsolute(fromWorkspace)) return false;
  const parts = fromWorkspace.split('/');
  if (parts.includes('.vite') || parts.includes('.wrangler')) return true;
  const dist = parts.indexOf('dist');
  return dist >= 0 && parts[dist + 1] === 'local';
}

export function qualityFileInput(path: string, realpath: string, role: QualityInput['role'], mode = statSync(realpath).mode & 0o777): QualityInput {
  return {
    path, realpath, role, mode, sha256: qualityFileDigest(realpath),
    get bytes() { return readFileSync(realpath); },
  };
}

export function copyQualityInput(input: QualityInput, root: string): QualityInput {
  const destination = resolve(root, input.path);
  try {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(input.realpath, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const copy = qualityFileInput(input.path, destination, input.role, input.mode);
    if (copy.sha256 !== input.sha256) throw Object.assign(new Error('Source changed during snapshot copy'), { code: 'QUALITY_REQUEST_INVALID' });
    return copy;
  } catch (cause) { throw qualityFileError('copy', input.realpath, destination, cause); }
}

function referencedRuntimePaths(source: string): string[] {
  const literals: string[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  let token: ts.SyntaxKind;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if ([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead].includes(token)) literals.push(scanner.getTokenValue());
  }
  if (literals.includes('docs') && literals.includes('qa')) literals.push('docs/qa');
  return literals;
}

export function runtimeEvidenceSelection(workspace: string, paths: string[], required: string[], profileCwd: string): (path: string) => boolean {
  const evidence = (path: string) => /^(?:docs\/qa|evidence)(\/|$)/.test(path);
  const inventory = new Set(paths.map(path => resolve(workspace, path)));
  const configurations = paths.filter(path => [workspace, resolve(workspace, profileCwd)].includes(dirname(resolve(workspace, path)))
    && /(?:config[^/]*\.(?:[cm]?[jt]s|json)|package\.json)$/.test(path));
  const pending = [...required, ...configurations].map(path => resolve(workspace, path));
  const visited = new Set<string>();
  const references = new Set(pending);
  for (const file of pending) {
    if (visited.has(file) || !inventory.has(file) || !/\.(?:[cm]?[jt]sx?|json|ya?ml|toml)$/.test(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const literal of referencedRuntimePaths(source)) {
      for (const base of [workspace, resolve(workspace, profileCwd), dirname(file)]) {
        const referenced = resolve(base, literal);
        if (evidence(relative(workspace, referenced))) references.add(referenced);
        for (const suffix of ['', '.ts', '.tsx', '.js', '/index.ts', '/index.js']) {
          const candidate = referenced + suffix;
          if (inventory.has(candidate) && !visited.has(candidate)) pending.push(candidate);
        }
      }
    }
  }
  return path => {
    if (!evidence(path)) return true;
    const absolute = resolve(workspace, path);
    return [...references].some(reference => absolute === reference || absolute.startsWith(reference + '/') || reference.startsWith(absolute + '/'));
  };
}
