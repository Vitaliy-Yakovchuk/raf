import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, realpathSync, statSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { copyQualityInput, generatedWorkspaceOutput, qualityFileDigest, qualityFileError, qualityFileInput, runtimeEvidenceSelection } from './test-run-quality-files.ts';
import { materializeQualityCommit } from './test-run-quality-commit.ts';
import { mapVitestFunctionCoverage, supportsVitestQuality, verifiedVitestLoads } from './test-run-quality-vitest.ts';
import { classifyQualityRun, parseQualityRequest, prepareQualityExecution, qualityInputDigest, qualitySnapshotDigest, verifyQualityCoverage } from './test-run-quality.ts';
import type { QualityBaseline, QualityContext, QualityCoverage, QualityFunction, QualityInput, QualityLoadedSource, QualityMutation, QualityRequest, QualitySnapshot } from './test-run-quality.ts';
import type { TestRunConfig, TestRunPorts } from './test-runs.ts';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'QUALITY_UNSUPPORTED' }); };
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const readPrivateJson = (path: string) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.uid !== process.getuid!() || stat.mode & 0o077) fail('Quality artifact is not private/owned'); return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
};

export function selectTypeScriptQualitySites(snapshot: QualitySnapshot, functions: QualityFunction[], mutant?: QualityMutation): { supported: boolean; reason?: string; sites: QualityMutation[] } {
  const sites: QualityMutation[] = [];
  for (const fn of functions) {
    const input = snapshot.inputs.find(input => input.path === fn.path);
    if (!input || !/\.[cm]?[jt]sx?$/.test(fn.path)) return { supported: false, reason: 'TypeScript selector requires a JavaScript/TypeScript production source', sites: [] };
    const source = Buffer.from(input.bytes).toString('utf8');
    const ast = ts.createSourceFile(fn.path, source, ts.ScriptTarget.Latest, true);
    const byte = (offset: number) => Buffer.byteLength(source.slice(0, offset));
    const matches: ts.Node[] = [];
    const isFunction = (node: ts.Node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);
    const find = (node: ts.Node) => { if (isFunction(node) && byte(node.getStart(ast)) === fn.startByte && byte(node.end) <= fn.endByte && !source.slice(node.end, Buffer.from(input.bytes).subarray(0, fn.endByte).toString('utf8').length).trim()) matches.push(node); ts.forEachChild(node, find); };
    find(ast);
    if (matches.length !== 1) return { supported: false, reason: `Ambiguous/unsupported function span: ${fn.id}`, sites: [] };
    const replacements: Record<string, string[]> = { 'true': ['false'], 'false': ['true'], '===': ['!=='], '!==': ['==='], '==': ['!='], '!=': ['=='], '>': ['>=', '<='], '<': ['<=', '>='], '>=': ['>', '<'], '<=': ['<', '>'], '+': ['-'], '-': ['+'], '*': ['/'], '/': ['*'], '&&': ['||'], '||': ['&&'] };
    const visit = (node: ts.Node) => {
      if (node !== matches[0] && isFunction(node)) return;
      if (node.getChildCount(ast) === 0) {
        const before = node.getText(ast), startByte = byte(node.getStart(ast)), endByte = byte(node.end);
        const fnName = (matches[0] as any).name?.getText(ast);
        const siteId = `${fnName}/${before}`;
        if (mutant && mutant.path === fn.path && mutant.startByte === startByte && mutant.endByte === endByte && mutant.siteId === siteId && (ts.isNumericLiteral(node) || Object.hasOwn(replacements, before))) sites.push({ ...mutant, functionId: fn.id, beforeBase64: Buffer.from(before).toString('base64') });
        const afters = replacements[before] ?? (ts.isNumericLiteral(node) ? [before === '0' ? '1' : '0'] : []);
        for (const after of afters) sites.push({ siteId: `${fn.path}:${startByte}:${endByte}:${after}`, functionId: fn.id, path: fn.path, startByte, endByte, beforeBase64: Buffer.from(before).toString('base64'), afterBase64: Buffer.from(after).toString('base64') });
      } else for (const child of node.getChildren(ast)) visit(child);
    };
    visit(matches[0]);
  }
  return { supported: true, sites };
}

interface SharedLibrariesRoute { root: string; link: string; branch: string; productDirectory: string; libraryDirectory: string; target: string }

function configuredSharedLibraries(workspace: string, project: string): SharedLibrariesRoute | undefined {
  const orchestratorRoot = dirname(workspace);
  const configurationPath = join(orchestratorRoot, 'conf/projects.json');
  if (!existsSync(configurationPath)) return;
  const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  const entry = configuration.projects[project];
  if (!entry?.usesSharedLibs) return;
  const branch = Object.entries(entry.branchPaths).find(([, path]) => resolve(orchestratorRoot, String(path)) === workspace)?.[0];
  const libraryPath = configuration.projects['shared-libs']?.branchPaths?.[branch ?? ''];
  if (!libraryPath) return;
  return { root: realpathSync(resolve(orchestratorRoot, libraryPath)), link: configuration.layout.sharedLibrariesLink, branch: branch!,
    productDirectory: (configuration.layout.directoryPattern ?? '{project}-{branch}').replace('{project}', project).replace('{branch}', branch),
    libraryDirectory: (configuration.layout.directoryPattern ?? '{project}-{branch}').replace('{project}', 'shared-libs').replace('{branch}', branch),
    target: configuration.layout.sharedLibrariesTarget.replace('{branch}', branch) };
}

interface SealedQualitySnapshot {
  source: QualityRequest['source'];
  sharedLibraries?: SharedLibrariesRoute;
  inputs: Pick<QualityInput, 'path' | 'role' | 'mode' | 'sha256'>[];
}

function saveQualitySnapshot(root: string, inputs: QualityInput[], request: QualityRequest, sharedLibraries?: SharedLibrariesRoute): void {
  const sealedInputs = inputs.map(input => copyQualityInput(input, join(root, 'inputs')));
  const sealed: SealedQualitySnapshot = { source: request.source, sharedLibraries,
    inputs: sealedInputs.map(input => ({ path: input.path, role: input.role, mode: input.mode, sha256: input.sha256 })) };
  writeFileSync(join(root, 'snapshot.json'), JSON.stringify(sealed), { mode: 0o600, flag: 'wx' });
}

function loadQualitySnapshot(root: string, request: QualityRequest): { snapshot: QualitySnapshot; sharedLibraries?: SharedLibrariesRoute } {
  const sealed = readPrivateJson(join(root, 'snapshot.json')) as SealedQualitySnapshot;
  if (sealed.source.revision !== request.source.revision || sealed.source.baseRevision !== request.source.baseRevision) {
    throw Object.assign(new Error('Baseline provenance mismatch: source/test/config/dependency/selection'), { code: 'QUALITY_REQUEST_INVALID' });
  }
  const inputRoot = join(root, 'inputs');
  const inputs = sealed.inputs.map(input => {
    const file = realpathSync(resolve(inputRoot, input.path));
    if (!within(file, inputRoot)) fail('Baseline snapshot path escapes storage');
    const captured = qualityFileInput(input.path, file, input.role, input.mode);
    if (captured.sha256 !== input.sha256) fail('Baseline snapshot input changed');
    return captured;
  });
  return { snapshot: { digest: qualitySnapshotDigest(inputs), inputs }, sharedLibraries: sealed.sharedLibraries };
}

function writeBranchMetadata(root: string, branch: string): void {
  const git = join(root, '.git');
  mkdirSync(join(git, 'objects'), { recursive: true, mode: 0o700 });
  mkdirSync(join(git, 'refs', 'heads'), { recursive: true, mode: 0o700 });
  writeFileSync(join(git, 'HEAD'), `ref: refs/heads/${branch}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(git, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n', { mode: 0o600, flag: 'wx' });
}

function snapshotWorkspace(workspace: string, dependencyWorkspace: string, paths: string[], required: string[], profileCwd: string, sharedLibraries?: SharedLibrariesRoute): QualitySnapshot {
  const selected = runtimeEvidenceSelection(workspace, paths.filter(path => {
    try { return within(realpathSync(resolve(workspace, path)), workspace) && statSync(resolve(workspace, path)).isFile(); }
    catch { return false; }
  }), required, profileCwd);
  const inputs: QualityInput[] = [];
  const committedPaths = new Set(paths);
  const dependencyRoots = new Set([join(dependencyWorkspace, 'node_modules')]);
  if (sharedLibraries) {
    const link = resolve(dependencyWorkspace, sharedLibraries.link);
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) dependencyRoots.add(link);
  }
  const walk = (path: string, ancestors: Set<string>) => {
    const actual = realpathSync(path);
    const sharedDependency = sharedLibraries !== undefined && within(actual, sharedLibraries.root);
    if (!within(actual, dependencyWorkspace) && !sharedDependency) fail(`Dependency route escapes canonical workspace: ${relative(workspace, path)}`);
    if (generatedWorkspaceOutput(dependencyWorkspace, actual)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (ancestors.has(actual)) fail('Cyclic dependency route');
      const nested = new Set([...ancestors, actual]);
      for (const name of readdirSync(path)) {
        if (sharedDependency && actual === sharedLibraries!.root && name === '.git') continue;
        walk(join(path, name), nested);
      }
    } else if (stat.isFile()) {
      const workspacePath = relative(dependencyWorkspace, actual);
      let snapshotPath = actual;
      if (within(actual, dependencyWorkspace) && committedPaths.has(workspacePath)) {
        snapshotPath = realpathSync(resolve(workspace, workspacePath));
        if (!within(snapshotPath, workspace)) fail('Committed dependency route escapes snapshot');
      }
      inputs.push(qualityFileInput(relative(dependencyWorkspace, path), snapshotPath, 'dependency'));
    } else fail('Unsupported non-file dependency input');
  };
  const capture = (path: string, ancestors: Set<string>) => {
    if (!selected(path)) return;
    const absolute = resolve(workspace, path);
    if (!within(absolute, workspace)) fail('Snapshot path escapes workspace');
    const entry = lstatSync(absolute, { throwIfNoEntry: false });
    if (!entry) return;
    if (sharedLibraries && path === sharedLibraries.link && entry.isSymbolicLink()) return;
    let actual: string;
    try { actual = realpathSync(absolute); }
    catch { return fail(`Unresolvable snapshot route: ${path}`); }
    if (!within(actual, workspace)) fail(`Snapshot route escapes canonical workspace: ${path}`);
    if (generatedWorkspaceOutput(workspace, actual)) return;
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (!entry.isSymbolicLink() && ancestors.size === 0) fail(`Unsupported snapshot route: ${path}`);
      if (ancestors.has(actual)) fail(`Cyclic snapshot route: ${path}`);
      const nested = new Set([...ancestors, actual]);
      for (const name of readdirSync(absolute)) capture(join(path, name), nested);
      return;
    }
    if (!stat.isFile()) fail(`Unsupported snapshot route: ${path}`);
    let role: QualityInput['role'] = 'config';
    if (/(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/.test(path)) role = 'test';
    else if (/(^|\/)(?:src|lib)\//.test(path) && /\.[cm]?[jt]sx?$/.test(path)) role = 'source';
    inputs.push(qualityFileInput(path, actual, role, stat.mode & 0o777));
  };
  for (const path of paths) capture(path, new Set());
  for (const root of dependencyRoots) if (existsSync(root)) walk(root, new Set());
  return { digest: qualitySnapshotDigest(inputs), inputs };
}

export function createQualityRuntime(config: TestRunConfig): NonNullable<TestRunPorts['prepareQuality']> {
  return async (requestPath, plan, context, runId) => {
    const path = resolve(context.workspace, requestPath);
    if (!within(path, context.workspace) && !within(path, context.tmpPath)) {
      const parent = lstatSync(dirname(path));
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid!() || parent.mode & 0o077) fail('Quality descriptor must be caller-owned data in a private directory');
    }
    if (realpathSync(path) !== path) fail('Quality descriptor symlink is unsupported');
    const request = parseQualityRequest(JSON.parse(readFileSync(path, 'utf8')));
    const profile = config.projects[plan.request.project].profiles[plan.profileId];
    const quality = profile.quality;
    const vitest = supportsVitestQuality(profile);
    const node = quality?.sourceAdapter.id === 'node-source' && quality.sourceAdapter.version === process.version
      && quality.coverage.producer === 'node-v8' && quality.coverage.adapter === 'v8'
      && quality.coverage.version === process.version && quality.coverage.format === 'v8'
      && profile.resultAdapter === 'node-test-events';
    if (!quality || quality.siteSelector.id !== 'typescript-function' || quality.siteSelector.version !== '1' || !node && !vitest) fail('Profile has no compatible pinned quality source/selector/coverage adapters');
    if (!plan.command.environment.TMPDIR) fail('Quality execution requires a reserved private run tmp');
    const temporary = plan.command.environment.TMPDIR;
    const baselineDirectory = join(context.tmpPath, 'quality-baselines', hash(JSON.stringify([plan.request.project, context.workspace, plan.request.group])));
    mkdirSync(baselineDirectory, { mode: 0o700, recursive: true });
    const git = (...args: string[]) => spawnSync('git', args, { cwd: context.workspace, encoding: 'utf8' });
    const canonicalHead = git('rev-parse', 'HEAD');
    const sourceBelongsToBranch = canonicalHead.status === 0 && git('merge-base', '--is-ancestor', request.source.revision, canonicalHead.stdout.trim()).status === 0;
    const baseExists = git('cat-file', '-e', `${request.source.baseRevision}^{commit}`).status === 0;
    if (!sourceBelongsToBranch || !baseExists) fail('Source/base revision does not match canonical Git workspace');
    const qualityContext: QualityContext = { runId, owner: context.home, canonicalWorkspace: context.workspace, profileId: plan.profileId, profileCwd: profile.cwd, selection: plan.selection, selectionDigest: hash(JSON.stringify(plan.selection)), configDigest: hash(JSON.stringify(profile)), dependencyDigest: '', sourceAdapter: quality.sourceAdapter, siteSelector: quality.siteSelector };
    let original: QualitySnapshot | undefined;
    let snapshotInputs = new Map<string, QualityInput>();
    let sharedLibraries: SharedLibrariesRoute | undefined;
    const containers = new Map<string, string>();
    const storage = dirname(context.workspace);
    const rootOwner = JSON.stringify({ owner: qualityContext.owner, runId });
    const remove = async (root: string, owner: string) => {
      const container = containers.get(root) ?? root;
      if (owner !== qualityContext.owner || dirname(container) !== storage) fail('Quality execution copy ownership mismatch');
      if (!existsSync(container)) return;
      if (readFileSync(join(container, '.raf-quality-owner'), 'utf8') !== rootOwner) fail('Quality execution copy ownership mismatch');
      rmSync(container, { recursive: true });
    };
    const snapshotId = request.baselineRunId ?? runId;
    if (!/^[a-zA-Z0-9_-]+$/.test(snapshotId)) fail('Invalid quality snapshot runId');
    const snapshotDirectory = join(storage, '.raf-baselines', hash(JSON.stringify([qualityContext.owner, plan.request.project, context.workspace, plan.request.group])));
    const sealedRoot = join(snapshotDirectory, snapshotId);
    let snapshotCreated = false;
    let baselineAccepted = false;
    const committed = materializeQualityCommit(context.workspace, request.source.revision, storage);
    qualityContext.sourceSnapshotRoot = committed.root;
    const execution = await prepareQualityExecution(request, qualityContext, {
      snapshot: async () => {
        if (request.mode === 'mutant') {
          const sealed = loadQualitySnapshot(sealedRoot, request);
          sharedLibraries = sealed.sharedLibraries;
          qualityContext.sourceSnapshotRoot = sealedRoot;
          original = sealed.snapshot;
        } else {
          sharedLibraries = configuredSharedLibraries(context.workspace, plan.request.project);
          original = snapshotWorkspace(committed.root, context.workspace, committed.paths, [...plan.selection.files, ...request.source.files.map(file => file.path)], profile.cwd, sharedLibraries);
        }
        qualityContext.sharedLibrariesRoot = sharedLibraries?.root;
        qualityContext.configDigest = hash(JSON.stringify([profile, sharedLibraries ?? null]));
        snapshotInputs = new Map(original.inputs.map(input => [input.path, input]));
        qualityContext.dependencyDigest = qualitySnapshotDigest(original.inputs.filter(input => input.role === 'dependency' || /(^|\/)(?:package(?:-lock)?\.json|[^/]*lock[^/]*)$/.test(input.path)));
        return original;
      },
      readCurrent: async path => snapshotInputs.get(path)!.bytes,
      currentDigest: async path => qualityFileDigest(snapshotInputs.get(path)!.realpath),
      loadBaseline: async id => {
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
        try { return readPrivateJson(join(baselineDirectory, id + '.json')) as QualityBaseline; } catch { return null; }
      },
      selectSites: async (snapshot, functions) => selectTypeScriptQualitySites(snapshot, functions, request.mutant),
      createPrivateCopy: async snapshot => {
        const root = mkdtempSync(join(storage, '.raf-quality-'));
        writeFileSync(join(root, '.raf-quality-owner'), rootOwner, { mode: 0o600, flag: 'wx' });
        try {
          const productRoot = sharedLibraries ? join(root, sharedLibraries.productDirectory) : root;
          mkdirSync(productRoot, { recursive: true, mode: 0o700 });
          containers.set(productRoot, root);
          if (sharedLibraries) {
            const libraryRoot = join(root, sharedLibraries.libraryDirectory);
            mkdirSync(libraryRoot, { recursive: true, mode: 0o700 });
            symlinkSync(sharedLibraries.target, join(productRoot, sharedLibraries.link));
            writeBranchMetadata(productRoot, sharedLibraries.branch);
            writeBranchMetadata(libraryRoot, sharedLibraries.branch);
          }
          const inputs = snapshot.inputs.map(input => copyQualityInput(input, productRoot));
          if (request.mode === 'baseline') {
            mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
            mkdirSync(sealedRoot, { mode: 0o700 });
            snapshotCreated = true;
            saveQualitySnapshot(sealedRoot, inputs, request, sharedLibraries);
          }
          return { root: productRoot, inputs };
        } catch (error) {
          if (snapshotCreated) rmSync(sealedRoot, { recursive: true, force: true });
          await remove(root, qualityContext.owner);
          throw error;
        }
      },
      removePrivateCopy: remove,
    }).finally(committed.cleanup);
    if (request.mutant) {
      const input = execution.inputs.find(input => input.path === request.mutant!.path)!;
      try { writeFileSync(input.realpath, input.bytes); }
      catch (cause) { await remove(execution.executionRoot, qualityContext.owner); throw qualityFileError('overlay', input.path, input.realpath, cause); }
    }
    const evidencePath = join(temporary, 'quality-loads.ndjson');
    writeFileSync(evidencePath, '', { flag: 'wx', mode: 0o600 });
    const coverageRoot = join(temporary, 'quality-coverage'); mkdirSync(coverageRoot, { mode: 0o700 });
    const settingsPath = join(temporary, 'quality-settings.json');
    writeFileSync(settingsPath, JSON.stringify({ runId, executionRoot: execution.executionRoot, canonicalWorkspace: context.workspace, dependencyRoots: sharedLibraries ? [join(dirname(execution.executionRoot), sharedLibraries.libraryDirectory)] : [], targets: request.source.files.map(file => file.path), evidencePath, coverageRoot }), { flag: 'wx', mode: 0o600 });
    const hook = fileURLToPath(new URL('./test-run-quality-loader.ts', import.meta.url));
    const command = structuredClone(plan.command);
    command.cwd = execution.cwd;
    if (node) {
      if (command.argv[0] && !command.argv[0].startsWith('-')) command.argv[0] = resolve(plan.command.cwd, command.argv[0]);
      command.argv.unshift('--import', hook);
    }
    Object.assign(command.environment, { qualitySettings: settingsPath, qualityCoverage: coverageRoot });
    return {
      request, command,
      finish: async (result, events) => {
        let loadedSources: QualityLoadedSource[] = [];
        const origins: Parameters<typeof classifyQualityRun>[0]['events'] = [];
        for (const line of readFileSync(evidencePath, 'utf8').split('\n').filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.runId !== runId) fail('Runtime quality observation runId mismatch');
          if (event.kind === 'load') loadedSources.push(event.source);
          else if (event.kind === 'failure') origins.push(event.failure);
          else fail('Unknown runtime quality observation');
        }
        if (vitest) loadedSources = verifiedVitestLoads(loadedSources, execution.inputs, runId);
        const compileObserved = origins.some(event => event.origin === 'transform');
        for (const event of events) {
          if (event.kind === 'assertion-failed') origins.push({ origin: 'test-body', test: event.test, message: '' });
          if (event.kind === 'setup-failed' && !compileObserved || event.kind === 'file-setup-failed' && !compileObserved || event.kind === 'protocol-error') origins.push({ origin: 'unknown', message: '' });
          if (event.kind === 'compile-failed') origins.push({ origin: 'transform', path: event.path, inputSha256: event.inputSha256, message: event.diagnostic ?? '' });
        }
        const target = request.mutant?.path ?? request.source.files[0].path;
        const targetHash = hash(execution.inputs.find(input => input.path === target)!.bytes);
        const classification = classifyQualityRun({ mode: request.mode, runId, target: { path: target, sha256: targetHash }, baselineGreen: request.mode === 'mutant', siteCount: execution.selectedSites.length, loadedSources, events: origins, protocolComplete: events.some(event => event.kind === 'complete' && 'expected' in event && event.expected.length > 0) && !events.some(event => event.kind === 'protocol-error'), cleanup: result.cleanup, exitCode: result.exitCode, timedOut: result.timedOut, interrupted: result.outcome === 'interrupted' });
        Object.assign(result, { outcome: classification.outcome, failureKinds: classification.failureKinds, nextAction: classification.nextAction });
        let coverage: QualityCoverage | { unavailableReason: string } = { unavailableReason: 'Mutant coverage is not canonical baseline coverage' };
        const baseline: QualityBaseline = { runId, owner: qualityContext.owner, sourceSnapshotDigest: execution.sourceSnapshotDigest, selectionDigest: qualityContext.selectionDigest, configDigest: qualityContext.configDigest, dependencyDigest: qualityContext.dependencyDigest, producer: { id: quality.coverage.producer, version: quality.coverage.version }, result: { outcome: result.outcome, exitCode: result.exitCode, timedOut: result.timedOut, cleanup: result.cleanup, unknown: result.unknown, unexecuted: result.unexecuted } };
        const manifestPath = join(baselineDirectory, runId + '.manifest.json');
        const manifestBytes = JSON.stringify(original!.inputs.map(input => ({ path: input.path, realpath: input.realpath, sha256: qualityInputDigest(input), role: input.role, mode: input.mode ?? null })));
        writeFileSync(manifestPath, manifestBytes, { mode: 0o600, flag: 'wx' });
        if (request.mode === 'baseline') {
          const reports = node ? readdirSync(coverageRoot).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(join(coverageRoot, file), 'utf8'))) : [];
          const lcovPath = join(coverageRoot, 'lcov.info');
          const lcov = vitest && existsSync(lcovPath) ? readFileSync(lcovPath, 'utf8') : '';
          const artifact = join(baselineDirectory, runId + (vitest ? '.coverage.lcov' : '.coverage.json'));
          const artifactBytes = vitest ? lcov : JSON.stringify(reports); writeFileSync(artifact, artifactBytes, { mode: 0o600, flag: 'wx' });
          const functions: QualityCoverage['functions'] = [];
          const omissions: string[] = [];
          for (const fn of node ? request.changedFunctions : []) {
            const input = execution.inputs.find(input => input.path === fn.path)!;
            const source = Buffer.from(input.bytes).toString('utf8');
            const byte = (offset: number) => Buffer.byteLength(source.slice(0, offset));
            const records = reports.flatMap(report => report.result ?? []).filter(record => record.url === new URL('file://' + input.realpath).href).flatMap(record => record.functions ?? []).filter(record => record.ranges?.[0] && byte(record.ranges[0].startOffset) === fn.startByte && byte(record.ranges[0].endOffset) <= fn.endByte && !source.slice(record.ranges[0].endOffset, Buffer.from(input.bytes).subarray(0, fn.endByte).toString('utf8').length).trim());
            if (!records.length) { omissions.push(`Function mapping unavailable: ${fn.id}`); continue; }
            const ranges = new Map<string, boolean>();
            for (const record of records) for (const range of record.ranges) { const key = `${range.startOffset}:${range.endOffset}`; ranges.set(key, (ranges.get(key) ?? false) || range.count > 0); }
            functions.push({ id: fn.id, unit: 'function', hits: [...ranges.values()].filter(Boolean).length, denominator: ranges.size, sourceSha256: hash(input.bytes), mapped: true });
          }
          if (vitest) {
            const mapped = mapVitestFunctionCoverage(lcov, execution.cwd, request.changedFunctions, execution.inputs, loadedSources);
            functions.push(...mapped.functions);
            omissions.push(...mapped.omissions);
          }
          coverage = { runId, sourceSnapshotDigest: execution.sourceSnapshotDigest, selectionDigest: qualityContext.selectionDigest, configDigest: qualityContext.configDigest, dependencyDigest: qualityContext.dependencyDigest, producer: { ...baseline.producer, complete: vitest ? Boolean(lcov) : reports.length > 0, exitCode: result.exitCode }, artifact: { path: artifact, sha256: hash(artifactBytes), actualSha256: hash(readFileSync(artifact)), format: vitest ? 'lcov' : 'v8-json', createdByRunId: runId }, functions, omissions };
          const decision = verifyQualityCoverage(coverage, baseline, request.changedFunctions, Object.fromEntries(request.source.files.map(file => [file.path, file.sha256])));
          if (decision.accepted) {
            writeFileSync(join(baselineDirectory, runId + '.json'), JSON.stringify(baseline), { mode: 0o600, flag: 'wx' });
            baselineAccepted = true;
            for (const id of readdirSync(snapshotDirectory)) {
              if (id !== runId && /^[a-zA-Z0-9_-]+$/.test(id)) rmSync(join(snapshotDirectory, id), { recursive: true });
            }
            for (const file of readdirSync(baselineDirectory)) if (!file.startsWith(runId + '.') && /^[a-zA-Z0-9_-]+(?:(?:\.coverage|\.manifest)?\.json|\.coverage\.lcov)$/.test(file)) rmSync(join(baselineDirectory, file), { recursive: true });
          } else classification.reason = decision.reason;
        }
        loadedSources.sort((a, b) => Number(b.loaded) - Number(a.loaded));
        result.quality = { mode: request.mode, baselineRunId: request.baselineRunId ?? null, sourceSnapshotDigest: execution.sourceSnapshotDigest, executionSnapshotDigest: execution.executionSnapshotDigest, mutant: request.mutant ? { siteId: request.mutant.siteId, functionId: request.mutant.functionId, path: request.mutant.path, beforeSha256: hash(Buffer.from(request.mutant.beforeBase64, 'base64')), afterSha256: hash(Buffer.from(request.mutant.afterBase64, 'base64')) } : null, loadedSources, coverage, mutationDisposition: classification.mutationDisposition, reason: classification.reason, provenance: { baseRevision: request.source.baseRevision, revision: request.source.revision, profileId: plan.profileId, configDigest: qualityContext.configDigest, dependencyDigest: qualityContext.dependencyDigest, selectionDigest: qualityContext.selectionDigest, sourceAdapter: qualityContext.sourceAdapter, siteSelector: qualityContext.siteSelector, startedAt: result.startedAt, completedAt: new Date().toISOString(), manifest: { path: manifestPath, sha256: hash(manifestBytes) } } };
      },
      cleanup: async terminated => {
        if (!terminated) return;
        await remove(execution.executionRoot, qualityContext.owner);
        if (snapshotCreated && !baselineAccepted) rmSync(sealedRoot, { recursive: true, force: true });
      },
    };
  };
}
