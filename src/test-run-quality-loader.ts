import ts from 'typescript';
import { registerHooks } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const settings = JSON.parse(readFileSync(process.env.RAF_TEST_RUN_QUALITY_SETTINGS!, 'utf8'));
const emit = (value: unknown) => appendFileSync(settings.evidencePath, JSON.stringify({ runId: settings.runId, ...value as object }) + '\n');
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith('file:')) {
      const path = fileURLToPath(resolved.url);
      const projectParent = context.parentURL?.startsWith('file:') && within(fileURLToPath(context.parentURL), settings.executionRoot);
      const trustedPreload = path === fileURLToPath(import.meta.url);
      if (!trustedPreload && (within(path, settings.canonicalWorkspace) || projectParent && !within(path, settings.executionRoot))) {
        emit({ kind: 'failure', failure: { origin: 'import', path, message: 'Resolution escaped execution copy into canonical workspace' } });
        throw new Error('Quality import escaped execution copy');
      }
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || result.source === null || result.source === undefined) return result;
    const resolvedPath = fileURLToPath(url);
    const path = relative(settings.executionRoot, resolvedPath);
    if (!settings.targets.includes(path)) return result;
    const bytes = typeof result.source === 'string' ? Buffer.from(result.source) : Buffer.from(result.source);
    const inputSha256 = createHash('sha256').update(bytes).digest('hex');
    emit({ kind: 'load', source: { path, resolvedPath, inputSha256, transformedSha256: null, mapping: 'node-native-source', loaded: false, stage: 'transform', runId: settings.runId } });
    const parsed = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    if ((parsed as any).parseDiagnostics.length) {
      emit({ kind: 'failure', failure: { origin: 'transform', path, inputSha256, message: 'Structured TypeScript parser failure' } });
      throw new SyntaxError('Quality source parse failed');
    }
    const observation = JSON.stringify({ runId: settings.runId, kind: 'load', source: { path, resolvedPath, inputSha256, transformedSha256: null, mapping: 'node-native-source', loaded: true, stage: 'load', runId: settings.runId } });
    const suffix = `\n;import { appendFileSync as __rafQualityAppend } from 'node:fs'; __rafQualityAppend(${JSON.stringify(settings.evidencePath)},${JSON.stringify(observation + '\n')});\n`;
    if (!['module', 'module-typescript'].includes(result.format ?? '')) throw new Error('Quality source adapter supports ES modules only');
    return { ...result, source: bytes.toString('utf8') + suffix };
  },
});
