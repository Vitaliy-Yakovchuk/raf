import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import type { QualityCoverage, QualityFunction, QualityInput, QualityLoadedSource } from './test-run-quality.ts';
import type { TestRunProfile } from './test-runs.ts';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function supportsVitestQuality(profile: TestRunProfile): boolean {
  const quality = profile.quality;
  return profile.resultAdapter === 'vitest-events' && quality?.sourceAdapter.id === 'vitest-source'
    && quality.sourceAdapter.version === '4.1.12' && quality.coverage.producer === '@vitest/coverage-v8'
    && quality.coverage.version === quality.sourceAdapter.version && quality.coverage.adapter === 'istanbul'
    && quality.coverage.format === 'lcov';
}

export function verifiedVitestLoads(sources: QualityLoadedSource[], inputs: QualityInput[], runId: string): QualityLoadedSource[] {
  return sources.filter(source => {
    const input = inputs.find(input => input.path === source.path);
    return input && source.runId === runId && source.resolvedPath === input.realpath
      && source.inputSha256 === hash(input.bytes) && /^[a-f0-9]{64}$/.test(source.transformedSha256 ?? '')
      && Boolean(source.mapping) && source.mapping !== 'node-native-source';
  });
}

interface LcovFunction { startLine: number; endLine?: number; name: string; hits: number | null }
interface LcovFile { path: string; functions: LcovFunction[] }

function parseLcov(contents: string): LcovFile[] {
  const files: LcovFile[] = [];
  for (const record of contents.split('end_of_record')) {
    const lines = record.trim().split(/\r?\n/);
    const path = lines.find(line => line.startsWith('SF:'))?.slice(3);
    if (!path) continue;
    const functions: LcovFunction[] = [];
    const counts = new Map<string, number>();
    for (const line of lines) {
      if (line.startsWith('FN:')) {
        const match = /^FN:(\d+),(?:(\d+),)?(.+)$/.exec(line);
        if (match) functions.push({ startLine: Number(match[1]), endLine: match[2] ? Number(match[2]) : undefined, name: match[3], hits: null });
      }
      if (line.startsWith('FNDA:')) {
        const match = /^FNDA:(\d+),(.+)$/.exec(line);
        if (match && !counts.has(match[2])) counts.set(match[2], Number(match[1]));
        else if (match) counts.set(match[2], NaN);
      }
    }
    for (const fn of functions) fn.hits = counts.get(fn.name) ?? null;
    files.push({ path, functions });
  }
  return files;
}

export function mapVitestFunctionCoverage(contents: string, cwd: string, functions: QualityFunction[], inputs: QualityInput[], loaded: QualityLoadedSource[]): Pick<QualityCoverage, 'functions' | 'omissions'> {
  const files = parseLcov(contents);
  const mapped: QualityCoverage['functions'] = [];
  const omissions: string[] = [];
  for (const fn of functions) {
    const input = inputs.find(input => input.path === fn.path)!;
    const source = Buffer.from(input.bytes).toString('utf8');
    const ast = ts.createSourceFile(fn.path, source, ts.ScriptTarget.Latest, true);
    const startOffset = Buffer.from(input.bytes).subarray(0, fn.startByte).toString('utf8').length;
    const endOffset = Buffer.from(input.bytes).subarray(0, fn.endByte).toString('utf8').length;
    const startLine = ast.getLineAndCharacterOfPosition(startOffset).line + 1;
    const endLine = ast.getLineAndCharacterOfPosition(endOffset - 1).line + 1;
    const records = files.filter(file => resolve(cwd, file.path) === input.realpath);
    const rows = records.flatMap(file => file.functions).filter(row => row.startLine === startLine && (row.endLine === undefined || row.endLine === endLine));
    const observed = loaded.some(row => row.path === fn.path && row.loaded && row.stage === 'load');
    if (rows.length !== 1 || rows[0].hits === null || !Number.isFinite(rows[0].hits) || !observed) {
      omissions.push(`Function mapping unavailable: ${fn.id}`);
      continue;
    }
    mapped.push({ id: fn.id, unit: 'function', hits: rows[0].hits! > 0 ? 1 : 0, denominator: 1, sourceSha256: hash(input.bytes), mapped: true });
  }
  return { functions: mapped, omissions };
}

export function createVitestQualityPlugin(settingsPath: string) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const emit = (value: object) => appendFileSync(settings.evidencePath, JSON.stringify({ runId: settings.runId, ...value }) + '\n');
  const targetPath = (id: string): string | null => {
    const absolute = id.split('?')[0];
    const canonicalPath = relative(settings.canonicalWorkspace, absolute);
    if (canonicalPath && !canonicalPath.startsWith('..') && !canonicalPath.startsWith('/')) {
      emit({ kind: 'failure', failure: { origin: 'import', path: absolute, message: 'Resolution escaped execution copy into canonical workspace' } });
      throw new Error('Quality import escaped execution copy');
    }
    const path = relative(settings.executionRoot, absolute);
    return settings.targets.includes(path) ? path : null;
  };
  const loadedInputs = new Map<string, string>();
  return [
    {
      name: 'raf-quality-source', enforce: 'pre' as const,
      load(id: string) {
        const path = targetPath(id);
        if (!path) return;
        const absolute = resolve(settings.executionRoot, path);
        if (realpathSync(absolute) !== absolute) throw new Error('Quality source escaped execution copy');
        const bytes = readFileSync(absolute);
        const inputSha256 = hash(bytes);
        loadedInputs.set(path, inputSha256);
        const source = bytes.toString('utf8');
        const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        if ((ast as any).parseDiagnostics.length) {
          emit({ kind: 'failure', failure: { origin: 'transform', path, inputSha256, message: 'Structured TypeScript parser failure' } });
          throw new SyntaxError('Quality source parse failed');
        }
        return source;
      },
    },
    {
      name: 'raf-quality-transformed-source', enforce: 'post' as const,
      transform(this: { getCombinedSourcemap(): unknown }, code: string, id: string) {
        const path = targetPath(id);
        if (!path) return;
        const inputSha256 = loadedInputs.get(path);
        if (!inputSha256) throw new Error('Quality transform has no observed source input');
        const map = this.getCombinedSourcemap();
        if (!map) throw new Error('Quality transform has no source mapping');
        const source = { runId: settings.runId, path, resolvedPath: resolve(settings.executionRoot, path), inputSha256, transformedSha256: hash(code), mapping: `vite-sourcemap-sha256:${hash(JSON.stringify(map))}` };
        emit({ kind: 'load', source: { ...source, loaded: false, stage: 'transform' } });
        const observation = JSON.stringify({ runId: settings.runId, kind: 'load', source: { ...source, loaded: true, stage: 'load' } }) + '\n';
        const suffix = `\n;import { appendFileSync as __rafQualityAppend } from 'node:fs'; __rafQualityAppend(${JSON.stringify(settings.evidencePath)}, ${JSON.stringify(observation)});\n`;
        return { code: code + suffix, map };
      },
    },
  ];
}

export function vitestQualityOptions(settingsPath: string, workspace: string) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  for (const name of ['vitest', '@vitest/coverage-v8']) {
    const packagePath = resolve(workspace, 'node_modules', name, 'package.json');
    if (!existsSync(packagePath) || JSON.parse(readFileSync(packagePath, 'utf8')).version !== '4.1.12') throw new Error(`Quality requires pinned ${name}@4.1.12`);
  }
  return {
    coverage: { enabled: true, provider: 'v8', reporter: ['lcovonly'], reportsDirectory: settings.coverageRoot, clean: true, cleanOnRerun: true, reportOnFailure: false, thresholds: undefined },
    plugins: createVitestQualityPlugin(settingsPath),
  };
}
